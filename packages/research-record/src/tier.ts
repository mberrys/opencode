export * as Tier from "./tier.js"

import { ContractError } from "./canonical.js"
import type { Graph } from "./graph.js"
import { ResearchRecord } from "./record.js"
import { Ref } from "./ref.js"

export type Tier = "unsupported" | "quoted" | "computed" | "adopted"
export type Flag = "abstract-only" | "secondary" | "ocr" | "agent-metadata" | "contested" | "stale" | "rejected"

/** Facts the record cannot state about itself; the store and replay establish them. */
export interface Facts {
  /** The fragment's quote equals its stored bytes. */
  readonly verified: (fragment: Ref.Exact) => boolean
  /** The fragment was in the evidence's session's shown set before the evidence was written. */
  readonly shown: (evidence: Ref.Exact, fragment: Ref.Exact) => boolean
  /** The script run replayed from its stored inputs to the same output digests. */
  readonly replayed: (run: Ref.Exact) => boolean
}

export interface Derived {
  readonly tier: Tier
  readonly flags: readonly Flag[]
}

type Decision = ResearchRecord.Revision<"decision">

/**
 * A claim revision's tier at a commit fence. Computed each time and never stored, so it cannot drift from the record.
 *
 * Only attested decisions count: an agent can run shell commands, so an unattested decision is never the researcher's,
 * and it cannot displace an attested one either. Rulings bind exact revisions: an adoption or rejection of an older
 * claim revision, or a ruling on an older evidence revision, says nothing about the corrected one.
 */
export function derive(input: {
  readonly graph: Graph.Graph
  readonly claim: Ref.Exact
  readonly asOfSeq: number
  readonly facts: Facts
}): Derived {
  const graph = input.graph
  if (graph.entry(input.claim).seq > input.asOfSeq)
    throw new ContractError("invalid-history", "the claim is later than the fence")
  const heads = graph.heads(input.asOfSeq).map((entry) => entry.revision)
  const rulings = attested(graph, input.asOfSeq)
  const evidence = heads.filter(
    (revision): revision is ResearchRecord.Revision<"evidence"> =>
      revision.kind === "evidence" && Ref.equals(revision.body.claim, input.claim),
  )
  const ruled = (challenge: Ref.Exact) =>
    rulings.some(
      (revision) => revision.body.type === "challenge-ruling" && Ref.equals(revision.body.challenge, challenge),
    )
  // Upheld rulings are found from the rulings themselves, so revising the challenge afterwards cannot erase one.
  const upheld = (target: Ref.Exact) =>
    rulings.some(
      (revision) =>
        revision.body.type === "challenge-ruling" &&
        revision.body.ruling === "upheld" &&
        challenges(graph.get(revision.body.challenge), target),
    )
  const open = (target: Ref.Exact) =>
    [...heads.filter((revision) => revision.kind === "judgment"), ...rulings].some(
      (revision) => challenges(revision, target) && !ruled(ResearchRecord.refOf(revision)),
    )
  const counting = evidence.filter((item) => !upheld(ResearchRecord.refOf(item)))
  const adoption = rulings
    .map((revision) => revision.body)
    .find(
      (body): body is Extract<ResearchRecord.Body<"decision">, { type: "adoption" }> =>
        body.type === "adoption" && Ref.equals(body.claim, input.claim),
    )
  const supports = counting.filter((item) => item.body.role === "supports")
  // A computation's inputs are numbers its author typed, so it counts only when it names the fragments they were read
  // from and each of those passes the same checks a quote's fragments do.
  const readFrom = (item: ResearchRecord.Revision<"evidence">) =>
    item.body.basis.kind === "computation"
      ? graph.get(item.body.basis.output, "artifact").body.inputs.flatMap((ref) => {
          const revision = graph.get(ref)
          return revision.kind === "fragment" ? [revision] : []
        })
      : []
  const computed = supports.some((item) => {
    if (item.body.basis.kind !== "computation" || !input.facts.replayed(item.body.basis.run)) return false
    const fragments = readFrom(item)
    return (
      fragments.length > 0 &&
      fragments.every((fragment) => {
        const ref = ResearchRecord.refOf(fragment)
        return (
          input.facts.verified(ref) &&
          (item.author.voice === "researcher" || input.facts.shown(ResearchRecord.refOf(item), ref))
        )
      })
    )
  })
  const quoted = supports.some(
    (item) =>
      item.body.basis.kind === "quote" &&
      item.body.basis.cited.every(
        (cited) =>
          input.facts.verified(cited.fragment) &&
          (item.author.voice === "researcher" || input.facts.shown(ResearchRecord.refOf(item), cited.fragment)),
      ),
  )
  const tier: Tier =
    adoption?.ruling === "adopt" ? "adopted" : computed ? "computed" : quoted ? "quoted" : "unsupported"

  const cited = counting.flatMap((item) => (item.body.basis.kind === "quote" ? item.body.basis.cited : []))
  const fragments = [...cited.map((item) => graph.get(item.fragment, "fragment")), ...counting.flatMap(readFrom)]
  const representations = fragments.map((fragment) => graph.get(fragment.body.representation, "representation"))
  const copies = representations.map((representation) => graph.get(representation.body.copy, "copy"))
  const read = adoption?.ruling === "adopt" ? adoption.evidence : []
  const flags: Flag[] = [
    ...(copies.some((copy) => copy.body.content === "abstract") ? ["abstract-only" as const] : []),
    ...(cited.some((item) => item.secondary !== "no") ? ["secondary" as const] : []),
    ...(representations.some((representation) => representation.body.ocr) ? ["ocr" as const] : []),
    ...(copies.some((copy) =>
      Object.values(citation(graph, copy.body.source, input.asOfSeq)).some((field) => field.from === "agent"),
    )
      ? ["agent-metadata" as const]
      : []),
    ...(evidence.some((item) => open(ResearchRecord.refOf(item))) || read.some(upheld) ? ["contested" as const] : []),
    ...(fragments.some((fragment) => stale(graph, fragment, input.asOfSeq)) ? ["stale" as const] : []),
    ...(adoption?.ruling === "reject" ? ["rejected" as const] : []),
  ]
  return { tier, flags: flags.toSorted() }
}

export interface Field {
  readonly value: unknown
  readonly from: "program" | "researcher" | "agent"
}

/**
 * A source's effective citation fields at a fence: the program's, overridden by attested researcher decisions, with
 * agent judgments filling only the fields neither has. Each field says whose it is, so an agent's never reads as
 * measured. Among amendments in one voice, the latest commit wins.
 */
export function citation(graph: Graph.Graph, source: Ref.Exact, asOfSeq: number): Readonly<Record<string, Field>> {
  const heads = graph.heads(asOfSeq).map((entry) => entry.revision)
  const head = heads.find((revision) => revision.kind === "source" && revision.objectId === source.objectId)
  const program = head?.kind === "source" ? head.body.fields : graph.get(source, "source").body.fields
  const amendments = (revisions: readonly ResearchRecord.Revision[], from: "researcher" | "agent") =>
    revisions.flatMap((revision) =>
      (revision.kind === "judgment" || revision.kind === "decision") &&
      revision.body.type === "metadata" &&
      revision.body.source.objectId === source.objectId
        ? [[revision.body.field, { value: revision.body.value, from }] as const]
        : [],
    )
  return {
    ...Object.fromEntries(
      amendments(
        heads.filter((revision) => revision.kind === "judgment"),
        "agent",
      ),
    ),
    ...Object.fromEntries(
      Object.entries(program).map(([name, field]) => [name, { value: field.value, from: "program" as const }]),
    ),
    ...Object.fromEntries(amendments(attested(graph, asOfSeq), "researcher")),
  }
}

/** The latest attested revision of each decision object at the fence, in commit order: the researcher's standing rulings. */
export function attested(graph: Graph.Graph, asOfSeq: number): readonly Decision[] {
  const latest = new Map<string, Graph.Entry>()
  graph.entries
    .filter(
      (entry) =>
        entry.seq <= asOfSeq &&
        entry.revision.kind === "decision" &&
        entry.revision.body.attestation.level !== "unattested",
    )
    .forEach((entry) => latest.set(entry.revision.objectId, entry))
  return [...latest.values()]
    .toSorted((a, b) => a.seq - b.seq)
    .map((entry) => entry.revision)
    .filter((revision): revision is Decision => revision.kind === "decision")
}

/** True when a revision is a challenge to exactly this evidence revision. */
function challenges(revision: ResearchRecord.Revision, evidence: Ref.Exact) {
  return (
    (revision.kind === "judgment" || revision.kind === "decision") &&
    revision.body.type === "challenge" &&
    Ref.equals(revision.body.evidence, evidence)
  )
}

/**
 * A re-find against newer text found no match, and the fragment object has not since been placed on that text. An
 * ambiguous re-find is not stale: the researcher places it.
 */
function stale(graph: Graph.Graph, fragment: ResearchRecord.Revision<"fragment">, asOfSeq: number) {
  const placed = graph
    .heads(asOfSeq)
    .map((entry) => entry.revision)
    .find((revision) => revision.kind === "fragment" && revision.objectId === fragment.objectId)
  return graph.entries.some(
    (entry) =>
      entry.seq <= asOfSeq &&
      entry.revision.kind === "receipt" &&
      entry.revision.body.outcome.status === "refused" &&
      entry.revision.body.outcome.refusal.code === "refind-unresolved" &&
      Ref.equals(entry.revision.body.outcome.refusal.fragment, ResearchRecord.refOf(fragment)) &&
      !(
        placed?.kind === "fragment" &&
        Ref.equals(placed.body.representation, entry.revision.body.outcome.refusal.against)
      ),
  )
}
