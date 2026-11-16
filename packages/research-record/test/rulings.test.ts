import { describe, expect, test } from "bun:test"
import { Basis, Canonical, ContractError, Graph, Ref, ResearchRecord, Tier } from "../src/index"

const file: { projectId: string; revisions: { name: string; seq: number; revision: ResearchRecord.Revision }[] } =
  await Bun.file(new URL("./vectors/revisions.json", import.meta.url)).json()

const base = file.revisions.map((entry) => ({ seq: entry.seq, revision: ResearchRecord.parse(entry.revision) }))
const named = (name: string) => file.revisions.find((entry) => entry.name === name)!.revision
const refOf = (name: string) => ResearchRecord.refOf(named(name))
const all = { verified: () => true, shown: () => true, replayed: () => true }
const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof ContractError) return error.code
    throw error
  }
  return "ok"
}

/** The next revision of a vector object: same object, parent set to it, body patched. */
const next = (
  revision: ResearchRecord.Revision,
  patch: Record<string, unknown>,
  rest: Record<string, unknown> = {},
) => {
  const { revisionId: _, ...preimage } = revision
  return ResearchRecord.create({
    ...preimage,
    ...rest,
    parent: ResearchRecord.refOf(revision),
    body: { ...preimage.body, ...patch },
  })
}
const decisionNext = (revision: ResearchRecord.Revision<"decision">, patch: Record<string, unknown>) =>
  next(revision, patch)
const graphWith = (...extra: { seq: number; revision: ResearchRecord.Revision }[]) =>
  Graph.make(file.projectId, [...base, ...extra])
const tierOf = (graph: Graph.Graph, claim: Ref.Exact, facts: Partial<Tier.Facts> = {}) =>
  Tier.derive({ graph, claim, asOfSeq: graph.lastSeq, facts: { ...all, ...facts } })

const adoption = named("decision adoption") as ResearchRecord.Revision<"decision">
const ruling = named("decision challenge ruling") as ResearchRecord.Revision<"decision">
const unattested = { level: "unattested", surface: "shell" }

describe("an unattested decision cannot displace an attested one", () => {
  test("an unattested rejection leaves the adoption standing", () => {
    const graph = graphWith({
      seq: 12,
      revision: decisionNext(adoption, { ruling: "reject", attestation: unattested }),
    })
    expect(tierOf(graph, refOf("claim"))).toEqual({ tier: "adopted", flags: ["agent-metadata"] })
  })

  test("an attested rejection rejects", () => {
    const graph = graphWith({ seq: 12, revision: decisionNext(adoption, { ruling: "reject" }) })
    expect(tierOf(graph, refOf("claim"))).toEqual({ tier: "quoted", flags: ["agent-metadata", "rejected"] })
  })

  test("an unattested dismissal leaves an attested upheld ruling standing", () => {
    const upheld = decisionNext(ruling, { ruling: "upheld" })
    const graph = graphWith(
      { seq: 12, revision: upheld },
      { seq: 13, revision: next(upheld, { ruling: "dismissed", attestation: unattested }) },
    )
    // The upheld challenge removes the only evidence; the adoption stands, now contested.
    expect(tierOf(graph, refOf("claim"))).toEqual({ tier: "adopted", flags: ["contested"] })
  })

  test("an unattested metadata decision does not hide the attested title", () => {
    const metadata = named("decision metadata") as ResearchRecord.Revision<"decision">
    const graph = graphWith({ seq: 12, revision: decisionNext(metadata, { value: "Other", attestation: unattested }) })
    expect(Tier.citation(graph, refOf("source"), graph.lastSeq).title).toEqual({
      value: "Unions, Norms, and Wage Inequality",
      from: "researcher",
    })
  })
})

describe("an object cannot change what it is about", () => {
  test("a challenge cannot be revised into praise", () => {
    const challenge = named("judgment challenge")
    expect(
      refusal(() =>
        graphWith({
          seq: 12,
          revision: next(challenge, { type: "support", opinion: "supports", grounds: undefined }, {}),
        }),
      ),
    ).not.toBe("ok")
    const { revisionId: _, ...preimage } = challenge
    const { grounds: _grounds, ...body } = preimage.body as Record<string, unknown>
    const praise = ResearchRecord.create({
      ...preimage,
      parent: ResearchRecord.refOf(challenge),
      body: { ...body, type: "support", opinion: "supports" },
    })
    expect(refusal(() => graphWith({ seq: 12, revision: praise }))).toBe("invalid-history")
  })

  test("evidence cannot be re-pointed at another claim", () => {
    const evidence = named("evidence")
    expect(refusal(() => graphWith({ seq: 12, revision: next(evidence, { claim: refOf("claim computed") }) }))).toBe(
      "invalid-history",
    )
  })

  test("an object cannot change kind or fork its history", () => {
    const claim = named("claim")
    const corrected = next(claim, { text: "Corrected." })
    expect(
      refusal(() =>
        graphWith({ seq: 12, revision: corrected }, { seq: 13, revision: next(claim, { text: "Again." }) }),
      ),
    ).toBe("invalid-history")
  })
})

describe("rulings bind exact revisions", () => {
  const claim = named("claim")
  const corrected = next(claim, { text: "US union density fell by more than half between 1979 and 2019." })

  test("a corrected claim is neither adopted nor rejected until ruled on", () => {
    const graph = graphWith({ seq: 12, revision: corrected })
    expect(tierOf(graph, ResearchRecord.refOf(corrected))).toEqual({ tier: "unsupported", flags: [] })
    expect(tierOf(graph, refOf("claim")).tier).toBe("adopted")
  })

  test("the latest ruling on the claim object decides, for whichever revision it names", () => {
    const graph = graphWith(
      { seq: 12, revision: corrected },
      {
        seq: 13,
        revision: decisionNext(adoption, { claim: ResearchRecord.refOf(corrected), evidence: [], ruling: "reject" }),
      },
    )
    expect(tierOf(graph, ResearchRecord.refOf(corrected)).flags).toContain("rejected")
    expect(tierOf(graph, refOf("claim")).tier).toBe("quoted")
  })
})

describe("stale clears once the fragment is placed on the newer text", () => {
  test("stale before the re-find, not after", () => {
    const graph = graphWith()
    expect(Tier.derive({ graph, claim: refOf("claim"), asOfSeq: 9, facts: all }).flags).toContain("stale")
    expect(Tier.derive({ graph, claim: refOf("claim"), asOfSeq: 10, facts: all }).flags).not.toContain("stale")
  })
})

describe("agent citation amendments: the latest commit wins", () => {
  test("a revised judgment beats one first written later", () => {
    const metadata = named("judgment metadata")
    const { revisionId: _, ...preimage } = metadata
    const other = ResearchRecord.create({
      ...preimage,
      objectId: "judgment-metadata-2",
      body: { ...preimage.body, value: "Sage Publications" },
    })
    const graph = graphWith(
      { seq: 12, revision: other },
      { seq: 13, revision: next(metadata, { value: "SAGE Journals" }) },
    )
    expect(Tier.citation(graph, refOf("source"), graph.lastSeq).publisher).toEqual({
      value: "SAGE Journals",
      from: "agent",
    })
  })
})

describe("claim-basis", () => {
  test("a snapshot of a corrected claim carries the history it needs to load", () => {
    const claim = named("claim")
    const corrected = next(claim, { text: "Corrected." })
    const graph = graphWith({ seq: 12, revision: corrected })
    const members = Basis.claim(graph, { selected: [ResearchRecord.refOf(corrected)], asOfSeq: 12 }).members
    expect(members.map(Ref.key)).toContain(Ref.key(refOf("claim")))
    const keys = new Set(members.map(Ref.key))
    const subset = graph.entries.filter((entry) => keys.has(Ref.key(ResearchRecord.refOf(entry.revision))))
    expect(refusal(() => Graph.make(file.projectId, subset))).toBe("ok")
  })

  test("a snapshot used as an input is cited, not re-opened", () => {
    const script = named("receipt script")
    const { revisionId: _, ...scriptPreimage } = script
    const claim3 = ResearchRecord.create({
      ...(({ revisionId: _id, ...rest }) => rest)(named("claim computed")),
      objectId: "claim-3",
      body: { text: "One snapshot came before this one.", scope: "", addresses: "none" },
    })
    const artifact = ResearchRecord.create({
      ...(({ revisionId: _id, ...rest }) => rest)(named("artifact table")),
      objectId: "artifact-from-snapshot",
      body: {
        inputs: [refOf("snapshot")],
        output: { digest: Canonical.digest("x"), schema: "none", mediaType: "text/plain" },
        transformation: "codemode.script",
      },
    })
    const run = ResearchRecord.create({
      ...scriptPreimage,
      objectId: "receipt-script-2",
      body: {
        ...scriptPreimage.body,
        written: [ResearchRecord.refOf(artifact), ResearchRecord.refOf(claim3)].sort(Ref.compare),
      },
    })
    const evidence3 = ResearchRecord.create({
      ...(({ revisionId: _id, ...rest }) => rest)(named("evidence computed")),
      objectId: "evidence-3",
      body: {
        claim: ResearchRecord.refOf(claim3),
        role: "supports",
        basis: { kind: "computation", run: ResearchRecord.refOf(run), output: ResearchRecord.refOf(artifact) },
        note: "",
      },
    })
    const graph = graphWith(
      { seq: 12, revision: claim3 },
      { seq: 12, revision: artifact },
      { seq: 12, revision: run },
      { seq: 13, revision: evidence3 },
    )
    const keys = Basis.claim(graph, { selected: [ResearchRecord.refOf(claim3)], asOfSeq: 13 }).members.map(Ref.key)
    expect(keys).toContain(Ref.key(refOf("snapshot")))
    expect(keys).not.toContain(Ref.key(refOf("claim")))
  })

  test("includes the rulings and amendments the tier reads", () => {
    const graph = graphWith()
    const keys = Basis.claim(graph, { selected: [refOf("claim")], asOfSeq: graph.lastSeq }).basis.map(Ref.key)
    for (const name of [
      "decision adoption",
      "judgment challenge",
      "decision challenge ruling",
      "judgment support",
      "judgment metadata",
      "decision metadata",
    ])
      expect(keys).toContain(Ref.key(refOf(name)))
  })
})

describe("graph rules", () => {
  test("a gap cannot cite a failed search", () => {
    const gap = named("judgment gap")
    const { revisionId: _, ...preimage } = gap
    const bad = ResearchRecord.create({
      ...preimage,
      objectId: "judgment-gap-2",
      body: { ...preimage.body, subquestion: "sq-1", searched: [refOf("failed")] },
    })
    expect(refusal(() => graphWith({ seq: 12, revision: bad }))).toBe("invalid-record")
  })

  test("a computation must be a script run", () => {
    const evidence = named("evidence computed")
    const { revisionId: _, ...preimage } = evidence
    const bad = ResearchRecord.create({
      ...preimage,
      objectId: "evidence-bad",
      body: {
        ...preimage.body,
        basis: { kind: "computation", run: refOf("receipt claim"), output: refOf("artifact table") },
      },
    })
    expect(refusal(() => graphWith({ seq: 12, revision: bad }))).toBe("invalid-record")
  })

  test("read spans must sit on code point boundaries inside the quote", () => {
    const fragment = named("fragment")
    const { revisionId: _, ...preimage } = fragment
    const multibyte = ResearchRecord.create({
      ...preimage,
      objectId: "fragment-2",
      body: {
        ...preimage.body,
        selector: { profile: "utf8-bytes@1", start: 83, end: 104, quote: "façade naïveté ✓" },
        before: "rose — ",
        after: ".",
        page: "none",
      },
    })
    const evidence = named("evidence")
    const { revisionId: _e, ...evidencePreimage } = evidence
    const cut = (start: number, end: number) =>
      ResearchRecord.create({
        ...evidencePreimage,
        objectId: `evidence-cut-${start}-${end}`,
        body: {
          ...evidencePreimage.body,
          basis: {
            kind: "quote",
            cited: [
              { fragment: ResearchRecord.refOf(multibyte), read: [{ start, end }], insertions: [], secondary: "no" },
            ],
          },
        },
      })
    expect(refusal(() => graphWith({ seq: 12, revision: multibyte }, { seq: 13, revision: cut(0, 7) }))).toBe("ok")
    expect(refusal(() => graphWith({ seq: 12, revision: multibyte }, { seq: 13, revision: cut(0, 3) }))).toBe(
      "invalid-record",
    )
    expect(refusal(() => graphWith({ seq: 12, revision: multibyte }, { seq: 13, revision: cut(0, 40) }))).toBe(
      "invalid-record",
    )
  })

  test("a snapshot's fence is before its own commit", () => {
    const snapshot = named("snapshot")
    expect(
      refusal(() =>
        Graph.make(
          file.projectId,
          base.map((entry) => (entry.revision.revisionId === snapshot.revisionId ? { ...entry, seq: 10 } : entry)),
        ),
      ),
    ).toBe("invalid-history")
  })
})

describe("flags from what the evidence cites", () => {
  test("a secondary quote from OCR text", () => {
    const { revisionId: _c, ...claimPreimage } = named("claim")
    const claim = ResearchRecord.create({
      ...claimPreimage,
      objectId: "claim-ocr",
      body: { ...claimPreimage.body, addresses: "none" },
    })
    const { revisionId: _e, ...evidencePreimage } = named("evidence")
    const evidence = ResearchRecord.create({
      ...evidencePreimage,
      objectId: "evidence-ocr",
      body: {
        ...evidencePreimage.body,
        claim: ResearchRecord.refOf(claim),
        basis: {
          kind: "quote",
          cited: [
            {
              fragment: refOf("fragment refound"),
              read: [{ start: 0, end: 13 }],
              insertions: [],
              secondary: { of: refOf("source") },
            },
          ],
        },
      },
    })
    const graph = graphWith({ seq: 12, revision: claim }, { seq: 12, revision: evidence })
    expect(tierOf(graph, ResearchRecord.refOf(claim))).toEqual({
      tier: "quoted",
      flags: ["agent-metadata", "ocr", "secondary"],
    })
  })
})
