export * as Basis from "./basis.js"

import { ContractError } from "./canonical.js"
import type { Graph } from "./graph.js"
import { ResearchRecord } from "./record.js"
import { Ref } from "./ref.js"
import { Tier } from "./tier.js"

export interface Membership {
  readonly basis: readonly Ref.Exact[]
  readonly members: readonly Ref.Exact[]
}

/**
 * `claim-basis@1`: what a frozen output rests on, so that a reader holding only the members can recompute every tier
 * and flag the output shows.
 *
 * The basis, at the `asOfSeq` fence: the selected claims; the head evidence for them; the researcher's standing
 * rulings on either (adoptions by claim object, challenges, and the rulings on those challenges); the agents' head
 * support and challenge judgments; lens choices and settings naming any of these; the citation amendments for every
 * source the members reach; and the receipts that wrote any of these.
 *
 * The members are the basis plus everything it reaches by following refs and parents forward. Two things are never
 * followed: a receipt's `written` (provenance, so one receipt cannot pull in everything written beside it) and any
 * ref out of a snapshot (a snapshot used as an input is cited, not re-opened).
 */
export function claim(
  graph: Graph.Graph,
  input: { readonly selected: readonly Ref.Exact[]; readonly asOfSeq: number },
): Membership {
  if (input.selected.length === 0) throw new ContractError("invalid-record", "a snapshot selects at least one claim")
  const heads = graph.heads(input.asOfSeq).map((entry) => entry.revision)
  const rulings = Tier.attested(graph, input.asOfSeq)
  const opinions = [...heads.filter((revision) => revision.kind === "judgment"), ...rulings]
  const selected = input.selected.map((ref) => {
    graph.get(ref, "claim")
    if (graph.entry(ref).seq > input.asOfSeq)
      throw new ContractError("invalid-history", "a selected claim is later than the fence")
    return ref
  })
  const claimObjects = new Set(selected.map((ref) => ref.objectId))
  const evidence = heads
    .filter((revision) => revision.kind === "evidence" && has(selected, revision.body.claim))
    .map(ResearchRecord.refOf)
  const adoptions = rulings.filter(
    (revision) => revision.body.type === "adoption" && claimObjects.has(revision.body.claim.objectId),
  )
  const read = [
    ...evidence,
    ...adoptions.flatMap((revision) => (revision.body.type === "adoption" ? revision.body.evidence : [])),
  ]
  const about = opinions
    .filter(
      (revision) =>
        (revision.kind === "judgment" || revision.kind === "decision") &&
        (revision.body.type === "support" || revision.body.type === "challenge") &&
        has(read, revision.body.evidence),
    )
    .map(ResearchRecord.refOf)
  const ruledChallenges = rulings.flatMap((revision) => {
    if (revision.body.type !== "challenge-ruling") return []
    const challenge = graph.get(revision.body.challenge)
    return (challenge.kind === "judgment" || challenge.kind === "decision") &&
      challenge.body.type === "challenge" &&
      has(read, challenge.body.evidence)
      ? [revision.body.challenge]
      : []
  })
  const challenged = [...about, ...ruledChallenges]
  const verdicts = rulings
    .filter((revision) => revision.body.type === "challenge-ruling" && has(challenged, revision.body.challenge))
    .map(ResearchRecord.refOf)
  const named = [...selected, ...evidence]
  const lenses = opinions
    .filter(
      (revision) =>
        (revision.kind === "judgment" || revision.kind === "decision") &&
        (revision.body.type === "lens-choice" || revision.body.type === "lens-setting") &&
        revision.body.subject.some((ref) => has(named, ref)),
    )
    .map(ResearchRecord.refOf)
  const core = [...named, ...adoptions.map(ResearchRecord.refOf), ...challenged, ...verdicts, ...lenses]
  const sources = new Set(
    closure(graph, core).flatMap((ref) => {
      const revision = graph.get(ref)
      return revision.kind === "source" ? [revision.objectId] : []
    }),
  )
  const amendments = opinions
    .filter(
      (revision) =>
        (revision.kind === "judgment" || revision.kind === "decision") &&
        revision.body.type === "metadata" &&
        sources.has(revision.body.source.objectId),
    )
    .map(ResearchRecord.refOf)
  const written = [...core, ...amendments]
  const receipts = graph.entries
    .filter(
      (entry) =>
        entry.seq <= input.asOfSeq &&
        entry.revision.kind === "receipt" &&
        entry.revision.body.written.some((ref) => has(written, ref)),
    )
    .map((entry) => ResearchRecord.refOf(entry.revision))
  const basis = sorted([...written, ...receipts])
  const members = closure(graph, basis)
  if (members.some((ref) => graph.entry(ref).seq > input.asOfSeq))
    throw new ContractError("invalid-history", "a snapshot's closure reaches past its fence")
  return { basis, members }
}

function closure(graph: Graph.Graph, start: readonly Ref.Exact[]) {
  const found = new Map<string, Ref.Exact>()
  const pending = [...start]
  while (pending.length > 0) {
    const ref = pending.pop()!
    if (found.has(Ref.key(ref))) continue
    found.set(Ref.key(ref), ref)
    const revision = graph.get(ref)
    // An earlier snapshot is cited as a whole, not re-opened: its own refs would drag in an unrelated output.
    if (revision.kind === "snapshot") continue
    const written = revision.kind === "receipt" ? revision.body.written : []
    pending.push(
      ...ResearchRecord.refs(revision)
        .map((dependency) => dependency.ref)
        .filter((next) => !has(written, next)),
      ...(revision.parent === "none" ? [] : [revision.parent]),
    )
  }
  return sorted([...found.values()])
}

function has(refs: readonly Ref.Exact[], ref: Ref.Exact) {
  return refs.some((item) => Ref.equals(item, ref))
}

function sorted(refs: readonly Ref.Exact[]) {
  return [...new Map(refs.map((ref) => [Ref.key(ref), ref])).values()].sort(Ref.compare)
}
