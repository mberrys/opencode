export * as Graph from "./graph.js"

import { Basis } from "./basis.js"
import { Canonical, ContractError } from "./canonical.js"
import { ResearchRecord } from "./record.js"
import { Ref } from "./ref.js"

/** A revision the store accepted, with the commit sequence it was accepted in. Sequences start at 1. */
export interface Entry {
  readonly seq: number
  readonly revision: ResearchRecord.Revision
}

/**
 * A read-only view over accepted, parsed revisions. Building one checks the history: each object's revisions form one
 * line, no object changes kind, every ref resolves to a retained revision of an allowed kind from the same or an
 * earlier commit, and the cross-record rules hold. It is not a second store: the store supplies the sequences.
 */
export interface Graph {
  readonly projectId: string
  readonly entries: readonly Entry[]
  readonly lastSeq: number
  /** Resolves an exact ref, refusing an unknown revision or, when kinds are given, any other kind. */
  get<K extends ResearchRecord.Kind>(ref: Ref.Exact, kind: K): ResearchRecord.Revision<K>
  get(ref: Ref.Exact): ResearchRecord.Revision
  entry(ref: Ref.Exact): Entry
  /** The latest revision of each object at or before `asOfSeq`, in commit order. */
  heads(asOfSeq: number): readonly Entry[]
}

export function make(projectId: string, input: readonly Entry[]): Graph {
  Ref.parse({ projectId, objectId: "project", revisionId: "project" })
  const entries = [...input].sort((a, b) => a.seq - b.seq)
  const byRef = new Map<string, Entry>()
  const heads = new Map<string, Entry>()
  entries.forEach((entry) => {
    if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) history("a commit sequence is a safe integer >= 1")
    const ref = Ref.parse(ResearchRecord.refOf(entry.revision), projectId)
    const key = Ref.key(ref)
    if (byRef.has(key)) history("a revision is accepted only once")
    const head = heads.get(ref.objectId)
    if (head === undefined && entry.revision.parent !== "none") history("an object's first revision has no parent")
    if (head !== undefined) {
      if (head.seq === entry.seq) history("one object has at most one revision in a commit")
      if (head.revision.kind !== entry.revision.kind) history("an object cannot change kind")
      // Otherwise an agent could revise an upheld challenge into praise, or re-point evidence at another claim.
      if (ResearchRecord.about(head.revision) !== ResearchRecord.about(entry.revision))
        history("an object cannot change what it is about")
      if (entry.revision.parent === "none" || !Ref.equals(entry.revision.parent, ResearchRecord.refOf(head.revision)))
        history("a revision's parent is its object's current head")
    }
    byRef.set(key, entry)
    heads.set(ref.objectId, entry)
  })

  const resolve = (ref: Ref.Exact, kinds: readonly ResearchRecord.Kind[] = []) => {
    const found = byRef.get(Ref.key(Ref.parse(ref, projectId)))
    if (found === undefined) throw new ContractError("dangling-ref", `${Ref.key(ref)} is not retained`)
    if (kinds.length > 0 && !kinds.includes(found.revision.kind))
      throw new ContractError("wrong-kind", `expected ${kinds.join(" or ")}, found ${found.revision.kind}`)
    return found
  }

  const graph: Graph = {
    projectId,
    entries,
    lastSeq: entries.at(-1)?.seq ?? 0,
    get: ((ref: Ref.Exact, kind?: ResearchRecord.Kind) => resolve(ref, kind ? [kind] : []).revision) as Graph["get"],
    entry: (ref) => resolve(ref),
    heads: (asOfSeq) => {
      if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0 || asOfSeq > (entries.at(-1)?.seq ?? 0))
        history("asOfSeq is a commit sequence that has happened")
      return [
        ...entries
          .filter((entry) => entry.seq <= asOfSeq)
          .reduce((latest, entry) => latest.set(entry.revision.objectId, entry), new Map<string, Entry>())
          .values(),
      ].toSorted((a, b) => a.seq - b.seq)
    },
  }

  entries.forEach((entry) => {
    ResearchRecord.refs(entry.revision).forEach((dependency) => {
      if (resolve(dependency.ref, dependency.kinds).seq > entry.seq) history("a ref cannot point at a later commit")
    })
    check(graph, entry)
  })
  return graph
}

/** Cross-record rules that need the revisions a body points at. */
function check(graph: Graph, entry: Entry) {
  const revision = entry.revision
  if (
    revision.kind === "fragment" &&
    graph.get(revision.body.representation, "representation").body.blob !== revision.body.representationDigest
  )
    throw new ContractError("digest-mismatch", "a fragment's representation digest is its representation's blob")
  if (revision.kind === "claim" && revision.body.addresses !== "none") subquestion(graph, revision.body.addresses)
  if (revision.kind === "evidence" && revision.body.basis.kind === "quote")
    revision.body.basis.cited.forEach((cited) => {
      const quote = new TextEncoder().encode(graph.get(cited.fragment, "fragment").body.selector.quote)
      const offsets = [
        ...cited.read.flatMap((span) => [span.start, span.end]),
        ...cited.insertions.map((insertion) => insertion.at),
      ]
      if (offsets.some((offset) => offset > quote.length || (offset < quote.length && (quote[offset] & 0xc0) === 0x80)))
        invalid("read spans and insertions sit inside the quote, on code point boundaries")
    })
  if (revision.kind === "evidence" && revision.body.basis.kind === "computation") {
    const basis = revision.body.basis
    const run = graph.get(basis.run, "receipt")
    if (
      run.body.step.kind !== "script" ||
      run.body.outcome.status !== "ok" ||
      !run.body.written.some((ref) => Ref.equals(ref, basis.output))
    )
      invalid("a computation is a successful script run that wrote the cited output")
  }
  if (revision.kind === "judgment") {
    const judgment = revision.body
    if (judgment.type === "gap") {
      subquestion(graph, judgment)
      if (
        judgment.searched.some((ref) => {
          const receipt = graph.get(ref, "receipt").body
          return !["tool", "script"].includes(receipt.step.kind) || receipt.outcome.status !== "ok"
        })
      )
        invalid("a gap names the successful tool or script receipts of its searches")
    }
  }
  if (revision.kind === "decision") {
    const decision = revision.body
    if (
      decision.type === "adoption" &&
      decision.evidence.some((ref) => !Ref.equals(graph.get(ref, "evidence").body.claim, decision.claim))
    )
      invalid("an adoption lists evidence for the claim it adopts")
    if (decision.type === "challenge-ruling") {
      const challenge = graph.get(decision.challenge)
      if (challenge.kind !== "judgment" && challenge.kind !== "decision") invalid("a ruling rules on a challenge")
      if ((challenge.kind === "judgment" || challenge.kind === "decision") && challenge.body.type !== "challenge")
        invalid("a ruling rules on a challenge")
    }
    if (
      decision.type === "lens-setting" &&
      decision.overrides !== "none" &&
      graph.get(decision.overrides, "judgment").body.type !== "lens-choice"
    )
      invalid("a lens setting overrides a lens choice")
  }
  if (revision.kind === "snapshot") {
    if (revision.body.asOfSeq >= entry.seq) history("a snapshot's fence is before its own commit")
    const membership = Basis.claim(graph, { selected: revision.body.selected, asOfSeq: revision.body.asOfSeq })
    if (
      Canonical.json(membership.basis) !== Canonical.json(revision.body.members.basis) ||
      membership.members.length !== revision.body.members.closureCount
    )
      invalid("a snapshot's basis and closure count are what claim-basis@1 computes at its fence")
  }
  if (revision.kind === "receipt" && revision.body.written.some((ref) => graph.entry(ref).seq !== entry.seq))
    invalid("a receipt names only revisions written in its own commit")
}

function subquestion(graph: Graph, target: { readonly protocol: Ref.Exact; readonly subquestion: string }) {
  if (!graph.get(target.protocol, "protocol").body.subquestions.some((item) => item.id === target.subquestion))
    invalid(`sub-question ${target.subquestion} is not in its protocol`)
}

function history(message: string): never {
  throw new ContractError("invalid-history", message)
}

function invalid(message: string): never {
  throw new ContractError("invalid-record", message)
}
