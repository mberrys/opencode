import {
  type ClaimBody,
  type DecisionBody,
  type Envelope,
  type EvidenceBody,
  type EvidenceRole,
  type FragmentBody,
  type JudgmentBody,
  type SourceBody,
  type Ref,
  type TierResult,
  verifyFragment,
  wasShown,
} from "@opencode/research-record"
import { refOf, sameRef } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { deriveTier } from "@opencode/research-record"

export type ClaimRecord = Envelope<"claim", ClaimBody>
export type EvidenceRecord = Envelope<"evidence", EvidenceBody>
export type DecisionRecord = Envelope<"decision", DecisionBody>
export type JudgmentRecord = Envelope<"judgment", JudgmentBody>
export type FragmentRecord = Envelope<"fragment", FragmentBody>

/** A claim's tier, computed from the record every time it is shown. */
export function tierOf(store: Store, claim: ClaimRecord): TierResult {
  const claimRef = refOf(claim)
  return deriveTier({
    claim,
    evidence: store.kind("evidence").filter((link) => sameRef(link.body.claim, claimRef)),
    decisions: store.kind("decision").filter((decision) => sameRef(decision.body.target, claimRef)),
    judgments: store.kind("judgment").filter((judgment) => sameRef(judgment.body.target, claimRef)),
    fragment: (ref) => {
      const found = store.find(ref)
      return found?.kind === "fragment" ? found : undefined
    },
    sourceOf: (fragment) => sourceOfFragment(store, fragment),
    verifies: (fragment) => {
      try {
        const located = representationOfFragment(store, refOf(fragment))
        if (!located) return false
        return verifyFragment(fragment.body, located.text).ok
      } catch {
        // A damaged or missing blob makes the quote unverifiable, not the report unreadable.
        return false
      }
    },
    shown: (fragment) => {
      if (!claim.session) return false
      return shownToSession(store, claim.session, refOf(fragment), claim.body.run)
    },
    // A script that replays is check C6, which is not built yet, so no claim is computed in version 1.
    replays: () => false,
  })
}

export function representationOfFragment(store: Store, fragment: Ref): { representation: Ref; text: Uint8Array } | undefined {
  const record = store.find(fragment)
  if (record?.kind !== "fragment") return undefined
  const representation = store.find(record.body.representation)
  if (representation?.kind !== "representation") return undefined
  return { representation: refOf(representation), text: store.blobs.get(representation.body.text) }
}

export function sourceOfFragment(store: Store, fragment: Ref): Envelope<"source", SourceBody> | undefined {
  const record = store.find(fragment)
  if (record?.kind !== "fragment") return undefined
  const representation = store.find(record.body.representation)
  if (representation?.kind !== "representation") return undefined
  const copy = store.find(representation.body.copy)
  if (copy?.kind !== "copy") return undefined
  const source = store.find(copy.body.source)
  return source?.kind === "source" ? source : undefined
}

/**
 * A fragment counts as shown to a session either because it appears in a recorded model call, or because this
 * session cut it with `evidence.quote` and still holds the receipt. The receipt is the weaker of the two; the
 * model-call check takes over once request capture is wired (check C1).
 */
export function shownToSession(store: Store, session: string, fragment: Ref, run = resolveRun(store, session)): boolean {
  const record = store.find(fragment)
  if (record?.kind !== "fragment") return false
  if (wasShown(store.shownSet(session), record.body)) return true
  return store
    .kind("receipt")
    .some(
      (receipt) =>
        receipt.session === session &&
        receipt.body.run === run &&
        receipt.body.records.some((written) => written.kind === "fragment" && written.id === fragment.id),
    )
}

/**
 * The run a session is working on. A reader or writer subagent has no protocol of its own, so it joins the
 * most recent protocol in the project; a session that wrote one joins its own, which is what makes a second
 * research question in the same session a new run.
 */
export function resolveRun(store: Store, session: string): string {
  const protocols = store.kind("protocol")
  return (
    protocols.filter((protocol) => protocol.session === session).at(-1)?.body.run ??
    protocols.at(-1)?.body.run ??
    session
  )
}

export function evidenceFor(store: Store, claim: Ref): EvidenceRecord[] {
  return store.kind("evidence").filter((link) => sameRef(link.body.claim, claim))
}

export function roles(): readonly EvidenceRole[] {
  return ["supports", "challenges", "qualifies", "contextualizes"]
}
