export * as Evidence from "./evidence.js"

import { Canonical, Fragment, Graph, Ref, ResearchRecord, Tier } from "@opencode/research-record"
import { Receipt, Tree, Workspace } from "@opencode/research-library"
import { Replay, type Store } from "@opencode/research-store"
import { randomBytes } from "node:crypto"

/** One tool call: who acts, in which context, and the call's idempotency key. */
export type Call = Receipt.Actor

export type Role = ResearchRecord.Body<"evidence">["role"]
export type Effort = "fast" | "standard" | "deep"

const stored = (tool: string, input: unknown, output: unknown): Receipt.Tool => ({
  tool,
  version: "1",
  replay: "stored",
  input,
  output,
  schema: { input: `${tool}-input@1`, output: `${tool}-output@1` },
})

export interface Quoted {
  readonly fragment: string
  readonly address: string
  readonly quote: string
  readonly before: string
  readonly after: string
  readonly title: string
  readonly receipt: string
  /** The printed page the quote starts on, for a text extracted from a PDF. */
  readonly page?: number
}

/**
 * Cuts a fragment by address: from the addressed sentence, `sentences` sentences of its paragraph. The program finds
 * the bytes; no model ever locates a span. The quote is checked against the stored text before it is written.
 */
export function quote(
  store: Store.Store,
  call: Call,
  input: { readonly address: string; readonly sentences?: number },
) {
  const started = Receipt.now(call)
  const graph = store.graph()
  const position = Workspace.parseAddress(input.address)
  const entry = Workspace.find(graph, position.short)
  const located = entry === undefined ? undefined : Workspace.locate(store, graph, entry)
  if (located === undefined) throw new Error(`nothing is stored under the address ${input.address}`)
  const paragraph = located.tree.nodes.filter(
    (node) => node.kind === "sentence" && node.section === position.section && node.paragraph === position.paragraph,
  )
  const from = paragraph.findIndex((node) => (node.sentence ?? 0) >= (position.sentence ?? 0))
  if (from === -1) throw new Error(`no sentence at ${input.address}`)
  const chosen = paragraph.slice(from, from + Math.max(1, Math.min(input.sentences ?? 1, 20)))
  const bytes = Workspace.text(store, located)
  const start = chosen[0].start
  const end = chosen[chosen.length - 1].end
  const selector = {
    profile: "utf8-bytes@1" as const,
    start,
    end,
    quote: new TextDecoder().decode(bytes.subarray(start, end)),
  }
  const representationDigest = located.representation.body.blob as Canonical.Digest
  Fragment.verify({ representationDigest, selector, bytes })
  const fragment = Receipt.program(store, call, "fragment", {
    representation: ResearchRecord.refOf(located.representation),
    representationDigest,
    selector,
    before: paragraph[from - 1]?.text ?? "",
    after: paragraph[from + chosen.length]?.text ?? "",
    page: Tree.placement(located.tree, start, end),
  })
  const result = {
    fragment: fragment.objectId,
    address: Workspace.addressOf(located.entry, chosen[0]),
    quote: selector.quote,
    before: fragment.body.before,
    after: fragment.body.after,
    title: located.entry.title,
    ...(fragment.body.page === "none" ? {} : { page: fragment.body.page.number }),
  }
  const written = Receipt.commit(store, call, started, stored("evidence.quote", input, result), [fragment])
  return { ...result, receipt: written.receipt.objectId } satisfies Quoted
}

/**
 * Writes a claim and one evidence link per fragment. An agent may cite only a fragment its own session cut, so a
 * citation is never typed from memory; the refusal says how to fix it.
 */
export function claim(
  store: Store.Store,
  call: Call,
  input: {
    readonly text: string
    readonly evidence: readonly { readonly fragment: string; readonly role: Role }[]
    readonly subquestion?: string
  },
) {
  const started = Receipt.now(call)
  const text = input.text.trim()
  if (text === "") throw new Error("a claim needs words")
  if (input.evidence.length === 0) throw new Error("a claim needs at least one piece of evidence")
  const graph = store.graph()
  const fragments = input.evidence.map((item) => ({
    role: item.role,
    fragment: head(graph, item.fragment, "fragment"),
  }))
  if (call.context.initiator.voice === "agent")
    fragments.forEach((item) => {
      if (!cutIn(graph, call.context.session, ResearchRecord.refOf(item.fragment)))
        throw new Error(
          `${item.fragment.objectId} was never shown to this session. Cut it with evidence_quote first, then claim.`,
        )
    })
  const protocol = input.subquestion === undefined ? undefined : protocolOf(graph, call.context.run)
  if (input.subquestion !== undefined && protocol === undefined)
    throw new Error("a claim addresses a sub-question of the run's protocol; write the protocol first")
  if (protocol !== undefined && !protocol.body.subquestions.some((item) => item.id === input.subquestion))
    throw new Error(`the protocol has no sub-question ${input.subquestion}`)
  const claimed = authored(store, call, "claim", Receipt.objectId("claim"), {
    text,
    scope: "",
    addresses:
      protocol === undefined || input.subquestion === undefined
        ? "none"
        : { protocol: ResearchRecord.refOf(protocol), subquestion: input.subquestion },
  })
  const links = fragments.map((item) =>
    authored(store, call, "evidence", Receipt.objectId("evidence"), {
      claim: ResearchRecord.refOf(claimed),
      role: item.role,
      basis: {
        kind: "quote",
        cited: [
          {
            fragment: ResearchRecord.refOf(item.fragment),
            read: [{ start: 0, end: new TextEncoder().encode(item.fragment.body.selector.quote).length }],
            insertions: [],
            secondary: "no",
          },
        ],
      },
      note: "",
    }),
  )
  const result = { claim: claimed.objectId, evidence: links.map((link) => link.objectId) }
  const written = Receipt.commit(store, call, started, stored("evidence.claim", input, result), [claimed, ...links])
  return { ...result, receipt: written.receipt.objectId }
}

/**
 * Records that a sub-question could not be answered. A gap names the searches it rests on, by their receipts, and how
 * to close it; the contract refuses one without them.
 */
export function gap(
  store: Store.Store,
  call: Call,
  input: {
    readonly subquestion: string
    readonly missing: string
    readonly searched: readonly string[]
    readonly close: string
  },
) {
  const started = Receipt.now(call)
  const graph = store.graph()
  const protocol = protocolOf(graph, call.context.run)
  if (protocol === undefined) throw new Error("a gap belongs to a sub-question of the run's protocol; write it first")
  if (!protocol.body.subquestions.some((item) => item.id === input.subquestion))
    throw new Error(`the protocol has no sub-question ${input.subquestion}`)
  if (input.searched.length === 0) throw new Error("a gap names the searches it rests on, by their receipts")
  const searched = input.searched.map((objectId) => ResearchRecord.refOf(head(graph, objectId, "receipt")))
  const judgment = authored(store, call, "judgment", Receipt.objectId("judgment"), {
    type: "gap",
    reason: input.missing,
    protocol: ResearchRecord.refOf(protocol),
    subquestion: input.subquestion,
    missing: input.missing,
    searched: searched.toSorted(Ref.compare),
    close: input.close,
  })
  const result = { gap: judgment.objectId }
  const written = Receipt.commit(store, call, started, stored("evidence.gap", input, result), [judgment])
  return { ...result, receipt: written.receipt.objectId }
}

/** One setting sets every budget, and it is written into the protocol so two runs can be compared. */
export function budgets(effort: Effort) {
  if (effort === "fast") return { subquestions: 2, sourcesPerSubquestion: 3, readFullText: false, gapRounds: 1 }
  if (effort === "deep") return { subquestions: 8, sourcesPerSubquestion: 20, readFullText: true, gapRounds: 4 }
  return { subquestions: 4, sourcesPerSubquestion: 8, readFullText: true, gapRounds: 2 }
}

/** Starts a run: the protocol is written under a new run id, which every later call in the run carries. */
export function protocol(
  store: Store.Store,
  call: Call,
  input: {
    readonly question: string
    readonly scope: { readonly in: readonly string[]; readonly out: readonly string[] }
    readonly subquestions: readonly { readonly id: string; readonly text: string }[]
    readonly criteria: readonly string[]
    readonly plan: string
    readonly effort: Effort
  },
) {
  const started = Receipt.now(call)
  if (input.subquestions.length === 0) throw new Error("a protocol has at least one sub-question")
  const run = `run-${randomBytes(8).toString("hex")}`
  const inRun = { ...call, context: { ...call.context, run } }
  const written = authored(store, inRun, "protocol", Receipt.objectId("protocol"), {
    question: input.question,
    scope: input.scope,
    subquestions: input.subquestions,
    criteria: input.criteria,
    plan: input.plan,
    effort: input.effort,
    budgets: budgets(input.effort),
  })
  const result = { protocol: written.objectId, run }
  const receipt = Receipt.commit(store, inRun, started, stored("research.protocol", input, result), [written])
  return { ...result, receipt: receipt.receipt.objectId }
}

export interface Open {
  readonly subquestion?: string
  readonly detail: string
  readonly close: string
}

/** What a run still owes: sub-questions with neither a claim nor a gap, and claims with no evidence. */
export function status(graph: Graph.Graph, run: string) {
  const protocol = protocolOf(graph, run)
  const heads = graph.heads(graph.lastSeq).map((entry) => entry.revision)
  const inRun = heads.filter((revision) => revision.context !== "none" && revision.context.run === run)
  const claims = inRun.flatMap((revision) => (revision.kind === "claim" ? [revision] : []))
  const answered = new Set(
    claims.flatMap((item) => (item.body.addresses === "none" ? [] : [item.body.addresses.subquestion])),
  )
  const gaps = new Set(
    inRun.flatMap((revision) =>
      revision.kind === "judgment" && revision.body.type === "gap" ? [revision.body.subquestion] : [],
    ),
  )
  const evidenced = new Set(
    heads.flatMap((revision) => (revision.kind === "evidence" ? [revision.body.claim.objectId] : [])),
  )
  const open: Open[] = [
    ...(protocol?.body.subquestions ?? []).flatMap((item) =>
      answered.has(item.id) || gaps.has(item.id)
        ? []
        : [
            {
              subquestion: item.id,
              detail: `${item.text} has no quoted claim and no recorded gap`,
              close: "search for it again, or record a gap that names the searches",
            },
          ],
    ),
    ...claims.flatMap((item) =>
      evidenced.has(item.objectId)
        ? []
        : [{ detail: `the claim "${item.body.text}" has no evidence`, close: "cite a fragment, or drop the claim" }],
    ),
  ]
  return {
    protocol: protocol?.objectId,
    question: protocol?.body.question,
    claims: claims.length,
    gaps: gaps.size,
    open,
  }
}

/**
 * Rechecks the record and replays the run's receipts. A replay error is a defect and is raised, not counted as an
 * unverifiable step.
 */
export function check(store: Store.Store, run: string | undefined) {
  return { record: store.verify(), replay: Replay.run(store, run === undefined ? {} : { run }) }
}

/** The facts a tier needs that the record cannot state about itself, from the store and the session's own cuts. */
export function facts(store: Store.Reader, graph: Graph.Graph): Tier.Facts {
  return {
    verified: (fragment) => verifies(store, graph.get(fragment, "fragment")),
    shown: (evidence, fragment) => {
      const link = graph.get(evidence)
      return cutIn(graph, link.context === "none" ? "none" : link.context.session, fragment, graph.entry(evidence).seq)
    },
    replayed: () => false,
  }
}

export interface Sentence {
  readonly text: string
  readonly claim?: string
}

/**
 * Writes the answer as an artifact over the claims it rests on, and renders it: each sentence with its claim's tier
 * and numbered sources, then each claim's quotes, then the open items.
 */
export function answer(store: Store.Store, call: Call, input: { readonly sentences: readonly Sentence[] }) {
  const started = Receipt.now(call)
  if (input.sentences.length === 0) throw new Error("an answer has at least one sentence")
  const graph = store.graph()
  const claims = input.sentences.map((sentence) =>
    sentence.claim === undefined ? undefined : head(graph, sentence.claim, "claim"),
  )
  const output = store.admit(
    new TextEncoder().encode(
      Canonical.json({
        sentences: input.sentences.map((sentence, index) => ({
          text: sentence.text,
          claim: claims[index] === undefined ? "none" : ResearchRecord.refOf(claims[index]),
        })),
      }),
    ),
  ).digest
  const inputs = [
    ...new Map(
      claims.flatMap((item) => (item === undefined ? [] : [[Ref.key(ResearchRecord.refOf(item)), item]])),
    ).values(),
  ].map(ResearchRecord.refOf)
  const artifact = Receipt.program(store, call, "artifact", {
    inputs: inputs.toSorted(Ref.compare),
    output: { digest: output, schema: "research-answer@1", mediaType: "application/json" },
    transformation: "research.answer@1",
  })
  const result = { answer: artifact.objectId }
  const written = Receipt.commit(store, call, started, stored("research.answer", input, result), [artifact])
  return {
    ...result,
    receipt: written.receipt.objectId,
    markdown: render(store, input.sentences, claims, call.context.run),
  }
}

function render(
  store: Store.Store,
  sentences: readonly Sentence[],
  claims: readonly (ResearchRecord.Revision<"claim"> | undefined)[],
  run: string,
) {
  const graph = store.graph()
  const known = facts(store, graph)
  const numbers = new Map<string, number>()
  const numberOf = (source: ResearchRecord.Revision<"source">) =>
    numbers.get(source.objectId) ?? numbers.set(source.objectId, numbers.size + 1).get(source.objectId)!
  const lines = claims.map((item) => {
    if (item === undefined) return undefined
    const ref = ResearchRecord.refOf(item)
    const derived = Tier.derive({ graph, claim: ref, asOfSeq: graph.lastSeq, facts: known })
    const cited = evidenceOf(graph, ref).flatMap((link) =>
      link.body.basis.kind === "quote"
        ? link.body.basis.cited.map((cite) => {
            const fragment = graph.get(cite.fragment, "fragment")
            return { role: link.body.role, fragment, number: numberOf(sourceOf(graph, fragment)) }
          })
        : [],
    )
    return { item, derived, cited }
  })
  const marker = (line: (typeof lines)[number]) =>
    line === undefined
      ? " _(unsupported)_"
      : ` [${[...new Set(line.cited.map((cite) => cite.number))].join(", ")}]${line.derived.tier === "quoted" || line.derived.tier === "adopted" ? "" : ` _(${line.derived.tier})_`}`
  const body = sentences.map((sentence, index) => `${sentence.text}${marker(lines[index])}`).join(" ")
  const evidence = lines.flatMap((line) =>
    line === undefined
      ? []
      : [
          `### ${line.item.body.text}`,
          "",
          `Tier: **${line.derived.tier}**${line.derived.flags.length > 0 ? ` (${line.derived.flags.join(", ")})` : ""}`,
          "",
          ...line.cited.flatMap((cite) => [
            `> ${cite.fragment.body.selector.quote}`,
            "",
            `— [${cite.number}]${cite.fragment.body.page === "none" ? "" : ` p. ${cite.fragment.body.page.number},`} ${cite.role}${known.verified(ResearchRecord.refOf(cite.fragment)) ? "" : ", **the quote no longer matches its stored text**"}`,
            "",
          ]),
        ],
  )
  const references = [...numbers].map(([objectId, number]) => {
    const source = graph.heads(graph.lastSeq).find((entry) => entry.revision.objectId === objectId)!.revision
    return `${number}. ${citationOf(graph, ResearchRecord.refOf(source as ResearchRecord.Revision<"source">))}`
  })
  const open = status(graph, run).open.map((item) => `- ${item.detail}. To close: ${item.close}.`)
  return [
    "# Answer",
    "",
    body,
    "",
    "## Evidence",
    "",
    ...evidence,
    "## References",
    "",
    ...references,
    ...(open.length === 0 ? [] : ["", "## Open", "", ...open]),
    "",
  ].join("\n")
}

/** A revision written by the call's initiator, the agent or the researcher, in the call's context. */
function authored<K extends ResearchRecord.Kind>(
  store: Store.Store,
  call: Call,
  kind: K,
  objectId: string,
  body: unknown,
) {
  return ResearchRecord.create({
    projectId: store.projectId,
    kind,
    schema: `${kind}@1`,
    objectId,
    parent: "none",
    author: call.context.initiator,
    context: call.context,
    body,
  }) as ResearchRecord.Revision<K>
}

/** The newest revision of an object the caller named by id, refused unless it is of the expected kind. */
function head<K extends ResearchRecord.Kind>(graph: Graph.Graph, objectId: string, kind: K) {
  const found = graph.heads(graph.lastSeq).find((entry) => entry.revision.objectId === objectId)
  if (found === undefined || found.revision.kind !== kind) throw new Error(`no ${kind} has the id ${objectId}`)
  return found.revision as ResearchRecord.Revision<K>
}

/** The run's protocol: the newest protocol revision written under that run. */
function protocolOf(graph: Graph.Graph, run: string) {
  return graph
    .heads(graph.lastSeq)
    .map((entry) => entry.revision)
    .findLast(
      (revision): revision is ResearchRecord.Revision<"protocol"> =>
        revision.kind === "protocol" && revision.context !== "none" && revision.context.run === run,
    )
}

/** True when the session cut this fragment itself with `evidence.quote`, at or before `asOfSeq`. */
function cutIn(graph: Graph.Graph, session: string, fragment: Ref.Exact, asOfSeq = graph.lastSeq) {
  return graph.entries.some(
    (entry) =>
      entry.seq <= asOfSeq &&
      entry.revision.kind === "receipt" &&
      entry.revision.context !== "none" &&
      entry.revision.context.session === session &&
      entry.revision.body.step.kind === "tool" &&
      entry.revision.body.step.tool === "evidence.quote" &&
      entry.revision.body.written.some((written) => Ref.equals(written, fragment)),
  )
}

function evidenceOf(graph: Graph.Graph, claim: Ref.Exact) {
  return graph
    .heads(graph.lastSeq)
    .flatMap((entry) =>
      entry.revision.kind === "evidence" && Ref.equals(entry.revision.body.claim, claim) ? [entry.revision] : [],
    )
}

function sourceOf(graph: Graph.Graph, fragment: ResearchRecord.Revision<"fragment">) {
  const representation = graph.get(fragment.body.representation, "representation")
  const copy = graph.get(representation.body.copy, "copy")
  return graph.get(copy.body.source, "source")
}

function citationOf(graph: Graph.Graph, source: Ref.Exact) {
  const fields = Tier.citation(graph, source, graph.lastSeq)
  const authors = fields.author?.value
  const first = Array.isArray(authors) && authors.length > 0 ? (authors[0] as { family?: string }).family : undefined
  const issued = fields.issued?.value as { "date-parts"?: number[][] } | undefined
  const year = issued?.["date-parts"]?.[0]?.[0]
  const title = typeof fields.title?.value === "string" ? fields.title.value : source.objectId
  return `${first ?? "Anonymous"} (${year ?? "n.d."}). ${title}.`
}

/** True when the quote equals its stored bytes. A missing or damaged text is a quote that does not verify. */
function verifies(store: Store.Reader, fragment: ResearchRecord.Revision<"fragment">) {
  try {
    Fragment.verify({
      representationDigest: fragment.body.representationDigest as Canonical.Digest,
      selector: fragment.body.selector,
      bytes: store.readBlob(fragment.body.representationDigest as Canonical.Digest),
    })
    return true
  } catch {
    return false
  }
}
