import {
  type EvidenceRole,
  type Json,
  type Ref,
  type TierResult,
  cut,
  digest,
  formatAddress,
  formatRef,
  makeRecord,
  parseAddress,
  refOf,
} from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { replay, verify } from "@opencode/research-store"
import type { ResearchRecord } from "@opencode/research-record"
import { entryOfShort, latest } from "@opencode/research-library"
import { type ClaimRecord, resolveRun, shownToSession, tierOf } from "./tier.js"

export interface Actor {
  readonly voice: "agent" | "researcher"
  readonly id?: string
}

function runOf(ctx: Session): string {
  // Readers and writers run in child sessions; the protocol names the run they all join.
  return resolveRun(ctx.store, ctx.session)
}

export interface Session {
  readonly store: Store
  readonly session: string
  readonly run: string
  /** Absent for the program, which writes records itself and never claims. */
  readonly actor: Actor
}

export interface Card {
  readonly fragment: Ref
  readonly address: string
  readonly quote: string
  readonly before: string
  readonly after: string
  readonly flags: readonly string[]
  readonly source: Ref
  readonly title: string
  readonly citation: string
}

export interface QuoteInput {
  readonly address: string
  readonly sentences?: number
  readonly secondary?: boolean
}

export interface QuoteResult {
  readonly fragment: Ref
  readonly card: Card
}

/** Cuts a fragment by address. The program finds the bytes; no model ever locates a span. */
export function quote(ctx: Session, input: QuoteInput): QuoteResult {
  const parsed = parseAddress(input.address)
  const entry = latestAt(ctx.store, input.address)
  const nodes = entry.tree.nodes.filter(
    (node) =>
      node.kind === "sentence" &&
      node.section === parsed.section &&
      node.paragraph === parsed.paragraph &&
      (parsed.sentence === undefined || (node.sentence ?? 0) >= parsed.sentence),
  )
  const first = nodes[0]
  if (!first) throw new Error(`no sentence at ${input.address}`)
  const count = Math.max(1, Math.min(input.sentences ?? 1, 20))
  const last = nodes[Math.min(count, nodes.length) - 1] ?? first
  const address = formatAddress({
    short: entry.entry.short,
    section: first.section,
    paragraph: first.paragraph,
    sentence: first.sentence,
  })
  const flags = [
    ...(entry.copy.body.abstractOnly ? (["abstract-only"] as const) : []),
    ...(entry.representation.body.flags.includes("ocr") ? (["ocr"] as const) : []),
    ...(input.secondary ? (["secondary"] as const) : []),
  ]
  const body = cut({
    representation: refOf(entry.representation),
    text: ctx.store.blobs.get(entry.representation.body.text),
    start: first.start,
    end: last.end,
    address,
    flags: [...flags],
  })
  const fragment = makeRecord({
    kind: "fragment",
    at: new Date().toISOString(),
    author: { voice: "program" },
    session: ctx.session,
    body,
  })
  const ref = refOf(fragment)
  return record(ctx, "evidence.quote", input as unknown as Json, [fragment], () => ({
    fragment: ref,
    card: cardOf(ctx.store, ref),
  }))
}

export function cardOf(store: Store, fragment: Ref): Card {
  const record = store.find(fragment)
  if (record?.kind !== "fragment") throw new Error(`no fragment ${formatRef(fragment)}`)
  const source = sourceOf(store, fragment)
  return {
    fragment,
    address: record.body.address,
    quote: record.body.quote,
    before: record.body.before,
    after: record.body.after,
    flags: record.body.flags,
    source: source.ref,
    title: source.title,
    citation: source.citation,
  }
}

export interface ClaimEvidenceInput {
  readonly fragment: string
  readonly role: EvidenceRole
}

export interface ClaimInput {
  readonly text: string
  readonly evidence: readonly ClaimEvidenceInput[]
  readonly scope?: { readonly question?: string; readonly subquestion?: string }
}

export interface ClaimResult {
  readonly claim: Ref
  readonly tier: TierResult
}

/** Writes a claim and its evidence. A fragment the session was never shown is refused, and the refusal says why. */
export function claim(ctx: Session, input: ClaimInput): ClaimResult {
  const text = input.text.trim()
  if (!text) throw new Error("a claim needs words")
  if (input.evidence.length === 0) throw new Error("a claim needs at least one piece of evidence")
  const fragments = input.evidence.map((item) => {
    const ref = ctx.store.resolve(item.fragment)
    if (ref.kind !== "fragment") throw new Error(`${formatRef(ref)} is not a fragment`)
    if (ctx.actor.voice === "agent" && !shownToSession(ctx.store, ctx.session, ref, runOf(ctx)))
      throw new Error(
        `${formatRef(ref)} was never shown to this session. Cut it with evidence.quote first, or cite it as the researcher.`,
      )
    return { ref, role: item.role }
  })

  const at = new Date().toISOString()
  const claimRecord = makeRecord({
    kind: "claim",
    at,
    author: ctx.actor,
    session: ctx.session,
    body: { text, ...(input.scope ? { scope: input.scope } : {}), run: runOf(ctx) },
  })
  const evidenceRecords = fragments.map((item) =>
    makeRecord({
      kind: "evidence",
      at,
      author: ctx.actor,
      session: ctx.session,
      body: { claim: refOf(claimRecord), role: item.role, target: { kind: "fragment", fragment: item.ref } },
    }),
  )
  const result = record(ctx, "evidence.claim", input as unknown as Json, [claimRecord, ...evidenceRecords], () => ({
    claim: refOf(claimRecord),
    tier: tierOf(ctx.store, claimRecord),
  }))
  return result
}

export interface GapInput {
  readonly subquestion: string
  readonly searched: readonly string[]
  readonly why: string
  readonly howToClose: string
}

/** A gap without its searches is refused: "no evidence found" always states where, with what, and when. */
export function gap(ctx: Session, input: GapInput): { receipt: Ref } {
  if (input.searched.length === 0) throw new Error("a gap states what was searched, where, and when")
  if (!input.howToClose.trim()) throw new Error("a gap states how to close it")
  const at = new Date().toISOString()
  const run = runOf(ctx)
  const receipt = makeRecord({
    kind: "receipt",
    at,
    author: { voice: "program" },
    session: ctx.session,
    body: {
      run,
      seq: nextSeq(ctx.store, run),
      operation: { kind: "tool", tool: "evidence.gap", input: input as unknown as Json },
      inputs: [],
      output: digest(input as unknown as Json),
      records: [],
      startedAt: at,
      endedAt: at,
      ok: true,
    },
  })
  ctx.store.commit([receipt], { at })
  return { receipt: refOf(receipt) }
}

export function gapsOf(store: Store, run: string): GapInput[] {
  return store.kind("receipt").flatMap((receipt) => {
    if (receipt.body.run !== run) return []
    if (receipt.body.operation.kind !== "tool") return []
    if (receipt.body.operation.tool !== "evidence.gap") return []
    const input = receipt.body.operation.input as unknown as GapInput
    return [{ subquestion: input.subquestion, searched: input.searched, why: input.why, howToClose: input.howToClose }]
  })
}

export interface DecisionResult {
  readonly decision: Ref
  readonly target: Ref
  readonly ruling: "adopt" | "reject"
}

export function decide(ctx: Session, input: { target: string; ruling: "adopt" | "reject"; reason?: string }): DecisionResult {
  if (ctx.actor.voice !== "researcher") throw new Error("adopting and rejecting belong to the researcher")
  const target = ctx.store.resolve(input.target)
  if (target.kind !== "claim") throw new Error(`${formatRef(target)} is not a claim; only a claim is adopted or rejected`)
  const at = new Date().toISOString()
  const decision = makeRecord({
    kind: "decision",
    at,
    author: ctx.actor,
    session: ctx.session,
    body: { target, ruling: input.ruling, ...(input.reason ? { reason: input.reason } : {}) },
  })
  return record(ctx, `research.${input.ruling}`, { target: input.target, ruling: input.ruling } as Json, [decision], () => ({
    decision: refOf(decision),
    target,
    ruling: input.ruling,
  }))
}

export interface VerifyResult {
  readonly record: ReturnType<typeof verify>
  readonly replay: ReturnType<typeof replay>
}

export function check(ctx: Session, run = ctx.run): VerifyResult {
  const record = verify(ctx.store)
  const replayed = replay(ctx.store, run)
  const at = new Date().toISOString()
  const receipt = makeRecord({
    kind: "receipt",
    at,
    author: { voice: "program" },
    session: ctx.session,
    body: {
      run,
      seq: nextSeq(ctx.store, run),
      operation: { kind: "tool", tool: "evidence.verify", input: { run } as Json },
      inputs: [],
      output: digest({
        ok: record.ok,
        issues: record.issues.length,
        replay: { ok: replayed.ok, entries: replayed.entries.length, unverifiable: replayed.unverifiable },
      } as Json),
      records: [],
      startedAt: at,
      endedAt: at,
      // Replay is reported beside the record, not folded into whether the record verifies.
      ok: record.ok,
    },
  })
  ctx.store.commit([receipt], { at })
  return { record, replay: replayed }
}

export function claimsOf(store: Store, run: string): ClaimRecord[] {
  return store.kind("claim").filter((item) => item.body.run === run)
}

/** Counted in the run the receipt is written to, so each run's receipts number 1, 2, 3 with no gap or repeat. */
export function nextSeq(store: Store, run: string): number {
  return store.kind("receipt").filter((receipt) => receipt.body.run === run).length + 1
}

export function record<T>(ctx: Session, tool: string, input: Json, records: readonly ResearchRecord[], build: () => T): T {
  const startedAt = new Date().toISOString()
  // The records are the durable facts, so they land before the result is read back from them.
  if (records.length > 0) ctx.store.commit(records, { at: startedAt })
  const result = build()
  const endedAt = new Date().toISOString()
  // Resolved after the records land: a protocol written just above starts the run this receipt belongs to.
  const run = runOf(ctx)
  const receipt = makeRecord({
    kind: "receipt",
    at: endedAt,
    author: { voice: "program" },
    session: ctx.session,
    body: {
      run,
      seq: nextSeq(ctx.store, run),
      operation: { kind: "tool", tool, input },
      inputs: [],
      output: digest(result as Json),
      records: records.map(refOf),
      startedAt,
      endedAt,
      ok: true,
    },
  })
  ctx.store.commit([receipt], { at: endedAt })
  return result
}

function latestAt(store: Store, address: string) {
  const parsed = parseAddress(address)
  const found = entryOfShort(store, parsed.short)
  const entry = found ? latest(store, refOf(found.source)) : undefined
  if (!entry) throw new Error(`nothing is stored under the address ${address}`)
  return entry
}

function sourceOf(store: Store, fragment: Ref): { ref: Ref; title: string; citation: string } {
  const record = store.find(fragment)
  if (record?.kind !== "fragment") throw new Error(`no fragment ${formatRef(fragment)}`)
  const representation = store.find(record.body.representation)
  if (representation?.kind !== "representation") throw new Error("the fragment's representation is missing")
  const copy = store.find(representation.body.copy)
  if (copy?.kind !== "copy") throw new Error("the fragment's copy is missing")
  const source = store.find(copy.body.source)
  if (source?.kind !== "source") throw new Error("the fragment's source is missing")
  return { ref: refOf(source), title: source.body.csl.title, citation: shortCitation(source.body.csl) }
}

function shortCitation(csl: { author?: readonly { family: string }[]; issued?: { "date-parts": readonly (readonly number[])[] }; title: string; container?: string }): string {
  const author = csl.author?.[0]?.family ?? "Anonymous"
  const year = csl.issued?.["date-parts"]?.[0]?.[0] ?? "n.d."
  return `${author} ${year}`
}
