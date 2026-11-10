import { describe, expect, test } from "bun:test"
import { digest } from "../src/digest.js"
import { cut, verifyFragment } from "../src/fragment.js"
import type { Envelope, FragmentBody, SourceBody } from "../src/record.js"
import { makeRecord, refOf } from "../src/record.js"
import { deriveTier } from "../src/tier.js"

const at = "2026-11-10T00:00:00.000Z"
const text = "Union decline explains about a fifth of the rise in wage inequality."
const bytes = new TextEncoder().encode(text)
const representation = { kind: "representation" as const, id: digest({ representation: 1 }) }

const fragment = makeRecord({
  kind: "fragment",
  at,
  author: { voice: "program" },
  body: cut({ representation, text: bytes, start: 0, end: 9, address: "k7f2:1/p0/s1" }),
})

const source = makeRecord({
  kind: "source",
  at,
  author: { voice: "program" },
  body: {
    type: "journal-article",
    identifiers: { doi: "10.1093/sf/soaa001" },
    csl: { title: "Union decline and wage inequality" },
    fieldOrigins: { title: "crossref" },
  } satisfies SourceBody,
})

const claim = makeRecord({
  kind: "claim",
  at,
  author: { voice: "agent", id: "reader" },
  session: "ses_1",
  body: { text: "Union decline explains part of the rise in wage inequality." },
})

const link = (overrides: { role?: "supports" | "challenges" | "qualifies" | "contextualizes"; claim?: typeof claim } = {}) =>
  makeRecord({
    kind: "evidence",
    at,
    author: { voice: "agent", id: "reader" },
    body: {
      claim: refOf(overrides.claim ?? claim),
      role: overrides.role ?? "supports",
      target: { kind: "fragment", fragment: refOf(fragment) },
    },
  })

const decision = (ruling: "adopt" | "reject" | "sustain" | "overrule", target = claim) =>
  makeRecord({ kind: "decision", at, author: { voice: "researcher", id: "micha" }, body: { target: refOf(target), ruling } })

const judgment = (target = claim) =>
  makeRecord({
    kind: "judgment",
    at,
    author: { voice: "agent", id: "checker" },
    body: { target: refOf(target), verdict: "out-of-context", reason: "the passage is about a different decade" },
  })

function tier(
  input: Partial<Parameters<typeof deriveTier>[0]> & Pick<Parameters<typeof deriveTier>[0], "claim">,
  options: { verifies?: boolean; shown?: boolean; replays?: boolean } = {},
) {
  return deriveTier({
    evidence: [],
    decisions: [],
    judgments: [],
    fragment: (ref) => (ref.id === refOf(fragment).id ? fragment : undefined),
    sourceOf: (ref) => (ref.id === refOf(fragment).id ? source : undefined),
    verifies: () => options.verifies ?? true,
    shown: () => options.shown ?? true,
    replays: () => options.replays ?? false,
    ...input,
  })
}

describe("tiers", () => {
  test("a claim with no evidence is unsupported", () => {
    expect(tier({ claim })).toEqual({ tier: "unsupported", flags: [], rejected: false, reason: "no evidence is attached" })
  })

  test("a verified quote that was shown makes the claim quoted", () => {
    expect(tier({ claim, evidence: [link()] })).toMatchObject({ tier: "quoted", flags: [] })
  })

  test("a quote the writer never saw proves nothing", () => {
    expect(tier({ claim, evidence: [link()] }, { shown: false })).toMatchObject({ tier: "unsupported" })
  })

  test("a quote that no longer verifies proves nothing", () => {
    expect(tier({ claim, evidence: [link()] }, { verifies: false })).toMatchObject({ tier: "unsupported" })
  })

  test("a researcher's own citation is exempt from the shown set", () => {
    const own = makeRecord({
      kind: "claim",
      at,
      author: { voice: "researcher", id: "micha" },
      body: { text: "Union decline matters here." },
    })
    expect(tier({ claim: own, evidence: [link({ claim: own })] }, { shown: false })).toMatchObject({ tier: "quoted" })
  })

  test("a challenging quote is still a real quote", () => {
    expect(tier({ claim, evidence: [link({ role: "challenges" })] })).toMatchObject({ tier: "quoted" })
  })

  test("an adopted claim outranks its quote and keeps the quote's flags", () => {
    const flagged = makeRecord({
      kind: "fragment",
      at,
      author: { voice: "program" },
      body: { ...fragment.body, flags: ["secondary"] },
    })
    const evidence = makeRecord({
      kind: "evidence",
      at,
      author: { voice: "agent" },
      body: { claim: refOf(claim), role: "supports", target: { kind: "fragment", fragment: refOf(flagged) } },
    })
    expect(
      deriveTier({
        claim,
        evidence: [evidence],
        decisions: [decision("adopt")],
        judgments: [],
        fragment: () => flagged,
        sourceOf: () => source,
        verifies: () => true,
        shown: () => true,
        replays: () => false,
      }),
    ).toMatchObject({ tier: "adopted", flags: ["secondary"], rejected: false })
  })

  test("a rejection leaves the tier it earned and says it was rejected", () => {
    expect(tier({ claim, evidence: [link()], decisions: [decision("reject")] })).toMatchObject({
      tier: "quoted",
      rejected: true,
    })
  })

  test("a computation that replays earns computed, and one that does not earns nothing", () => {
    const computation = makeRecord({
      kind: "artifact",
      at,
      author: { voice: "program" },
      body: { type: "script", run: "run_1", script: digest({ script: 1 }), result: digest({ result: 1 }), calls: [], inputs: [] },
    })
    const evidence = makeRecord({
      kind: "evidence",
      at,
      author: { voice: "agent" },
      body: { claim: refOf(claim), role: "supports", target: { kind: "computation", artifact: refOf(computation) } },
    })
    expect(tier({ claim, evidence: [evidence] }, { replays: true })).toMatchObject({ tier: "computed" })
    expect(tier({ claim, evidence: [evidence] }, { replays: false })).toMatchObject({ tier: "unsupported" })
  })

  test("an open challenge is flagged, and a ruling on it clears the flag", () => {
    expect(tier({ claim, evidence: [link()], judgments: [judgment()] })).toMatchObject({ flags: ["contested"] })
    expect(tier({ claim, evidence: [link()], judgments: [judgment()], decisions: [decision("overrule")] })).toMatchObject({
      flags: [],
    })
  })

  test("a citation field an agent filled is flagged, a measured one is not", () => {
    const agentSource = makeRecord({
      kind: "source",
      at,
      author: { voice: "program" },
      body: { ...source.body, fieldOrigins: { title: "agent" } as never },
    })
    const flagged = deriveTier({
      claim,
      evidence: [link()],
      decisions: [],
      judgments: [],
      fragment: () => fragment,
      sourceOf: () => agentSource,
      verifies: () => true,
      shown: () => true,
      replays: () => false,
    })
    expect(flagged.flags).toContain("agent-metadata")
  })

  test("the fragment this test cut really verifies, so the quoted case rests on the real check", () => {
    expect(verifyFragment(fragment.body as FragmentBody, bytes)).toEqual({ ok: true })
  })

  test("the source and fragment helpers are real records", () => {
    expect((fragment as Envelope<"fragment", FragmentBody>).kind).toBe("fragment")
    expect(refOf(fragment).kind).toBe("fragment")
  })
})
