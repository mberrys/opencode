import type { ClaimBody, DecisionBody, Envelope, EvidenceBody, FragmentBody, JudgmentBody, Ref, SourceBody } from "./record.js"
import { refOf, sameRef } from "./record.js"

export type Tier = "unsupported" | "quoted" | "computed" | "adopted"

export const TIERS: readonly Tier[] = ["unsupported", "quoted", "computed", "adopted"]

export type Qualifier = "abstract-only" | "secondary" | "ocr" | "agent-metadata" | "contested" | "stale"

export interface TierInput {
  readonly claim: Envelope<"claim", ClaimBody>
  readonly evidence: readonly Envelope<"evidence", EvidenceBody>[]
  readonly decisions: readonly Envelope<"decision", DecisionBody>[]
  readonly judgments: readonly Envelope<"judgment", JudgmentBody>[]
  readonly fragment: (ref: Ref) => Envelope<"fragment", FragmentBody> | undefined
  /** Resolves a fragment to the work it was cut from, through its representation and copy. */
  readonly sourceOf: (fragment: Ref) => Envelope<"source", SourceBody> | undefined
  readonly verifies: (fragment: Envelope<"fragment", FragmentBody>) => boolean
  readonly shown: (fragment: Envelope<"fragment", FragmentBody>) => boolean
  readonly replays: (artifact: Ref) => boolean
}

export interface TierResult {
  readonly tier: Tier
  readonly flags: readonly Qualifier[]
  /** A researcher rejected the claim. The tier still says what the evidence proves. */
  readonly rejected: boolean
  readonly reason: string
}

/**
 * Computes what the record proves about a claim. Never stored, so it cannot drift from the facts below it.
 * `quoted` certifies the bytes and that the writer saw them, and nothing about whether they support the claim.
 */
export function deriveTier(input: TierInput): TierResult {
  const claim = refOf(input.claim)
  const links = input.evidence.filter((link) => sameRef(link.body.claim, claim))
  const decisions = input.decisions.filter((decision) => sameRef(decision.body.target, claim))
  const adopted = decisions.some((decision) => decision.body.ruling === "adopt")
  const rejected = decisions.some((decision) => decision.body.ruling === "reject")

  const cited = links.flatMap((link) => {
    if (link.body.target.kind !== "fragment") return []
    const fragment = input.fragment(link.body.target.fragment)
    return fragment ? [fragment] : []
  })

  const exempt = input.claim.author.voice === "researcher"
  const quoted = cited.some((fragment) => input.verifies(fragment) && (exempt || input.shown(fragment)))
  const computed = links.some(
    (link) => link.body.target.kind === "computation" && input.replays(link.body.target.artifact),
  )

  const contested =
    input.judgments.some((judgment) => sameRef(judgment.body.target, claim)) &&
    !decisions.some((decision) => decision.body.ruling === "sustain" || decision.body.ruling === "overrule")

  const flags = new Set<Qualifier>()
  for (const fragment of cited) for (const flag of fragment.body.flags) flags.add(flag)
  if (contested) flags.add("contested")
  if (cited.some((fragment) => hasAgentMetadata(fragment, input))) flags.add("agent-metadata")
  const tier: Tier = adopted
    ? "adopted"
    : computed
      ? "computed"
      : quoted
        ? "quoted"
        : "unsupported"

  return { tier, flags: [...flags].sort(), rejected, reason: explain({ tier, links, quoted, computed, adopted }) }
}

function hasAgentMetadata(
  fragment: Envelope<"fragment", FragmentBody>,
  input: Pick<TierInput, "sourceOf">,
): boolean {
  const source = input.sourceOf(refOf(fragment))
  if (!source) return false
  return Object.values(source.body.fieldOrigins).some((origin) => origin === "agent")
}

function explain(input: {
  readonly tier: Tier
  readonly links: readonly Envelope<"evidence", EvidenceBody>[]
  readonly quoted: boolean
  readonly computed: boolean
  readonly adopted: boolean
}): string {
  if (input.adopted) return "a researcher adopted the claim"
  if (input.computed) return "a computation replays to the recorded output"
  if (input.quoted)
    return `the quote is byte exact in a stored copy${input.links.length > 1 ? ` and ${input.links.length} pieces of evidence are attached` : ""}`
  if (input.links.length > 0) return "evidence is attached but no quote verifies or no passage was shown to the writer"
  return "no evidence is attached"
}
