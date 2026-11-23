import { describe, expect, test } from "bun:test"
import { Basis, Canonical, ContractError, Fragment, Graph, Ref, ResearchRecord, Tier } from "../src/index"

const file: {
  projectId: string
  revisions: { name: string; seq: number; revision: ResearchRecord.Revision }[]
  fragments: {
    name: string
    text: string
    representationDigest: Canonical.Digest
    selector: ResearchRecord.Selector
    result: string
  }[]
  refusals: { name: string; revision: unknown; code: string }[]
  skills: { name: string; files: Record<string, string>; digest: string }[]
} = await Bun.file(new URL("./vectors/revisions.json", import.meta.url)).json()

const encoder = new TextEncoder()
const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof ContractError) return error.code
    throw error
  }
  return "ok"
}
const named = (name: string) => file.revisions.find((entry) => entry.name === name)!
const refOf = (name: string) => ResearchRecord.refOf(named(name).revision)
const entries = file.revisions.map((entry) => ({ seq: entry.seq, revision: ResearchRecord.parse(entry.revision) }))
const graph = Graph.make(file.projectId, entries)
const all = { verified: () => true, shown: () => true, replayed: () => true }

describe("frozen revision identities", () => {
  test.each(file.revisions)("$name", (entry) => {
    expect(ResearchRecord.parse(entry.revision).revisionId).toBe(entry.revision.revisionId)
  })

  test("cover every kind and every variant", () => {
    const revisions = file.revisions.map((entry) => entry.revision)
    expect(new Set(revisions.map((revision) => revision.kind))).toEqual(new Set(ResearchRecord.Kinds))
    const variants = (kind: "judgment" | "decision") =>
      new Set(revisions.flatMap((revision) => (revision.kind === kind ? [revision.body.type] : [])))
    expect(variants("judgment")).toEqual(
      new Set(["screening", "support", "challenge", "gap", "metadata", "lens-choice"]),
    )
    expect(variants("decision")).toEqual(
      new Set(["adoption", "challenge", "challenge-ruling", "metadata", "lens-setting", "lens-adoption"]),
    )
    const receipts = revisions.flatMap((revision) => (revision.kind === "receipt" ? [revision.body] : []))
    expect(new Set(receipts.map((receipt) => receipt.step.kind))).toEqual(
      new Set(["tool", "script", "model", "command"]),
    )
    expect(
      new Set(
        receipts.flatMap((receipt) => (receipt.outcome.status === "refused" ? [receipt.outcome.refusal.code] : [])),
      ),
    ).toEqual(
      new Set([
        "lens-works-missing",
        "not-shown",
        "no-match",
        "ambiguous-match",
        "refind-unresolved",
        "refind-ambiguous",
      ]),
    )
  })

  test.each(file.refusals)("refuse $name", (vector) => {
    expect(refusal(() => ResearchRecord.parse(vector.revision))).toBe(vector.code)
  })

  test("refuse a revision whose id is not its digest", () => {
    const revision = named("claim").revision
    expect(refusal(() => ResearchRecord.parse({ ...revision, revisionId: Canonical.digest("other") }))).toBe(
      "digest-mismatch",
    )
    expect(refusal(() => ResearchRecord.parse({ ...revision, body: { ...revision.body, text: "changed" } }))).toBe(
      "digest-mismatch",
    )
  })
})

describe("the vector project as a graph", () => {
  test("keeps the old revision of a corrected object resolvable", () => {
    const first = refOf("fragment")
    const second = refOf("fragment refound")
    expect(first.objectId).toBe(second.objectId)
    expect(graph.get(first, "fragment").body.page).not.toBe("none")
    const heads = graph.heads(graph.lastSeq).map((entry) => Ref.key(ResearchRecord.refOf(entry.revision)))
    expect(heads).toContain(Ref.key(second))
    expect(heads).not.toContain(Ref.key(first))
  })

  test("recomputes the snapshot's basis", () => {
    const snapshot = graph.get(refOf("snapshot"), "snapshot")
    const membership = Basis.claim(graph, { selected: snapshot.body.selected, asOfSeq: snapshot.body.asOfSeq })
    expect(membership.basis).toEqual(snapshot.body.members.basis)
    expect(membership.members).toHaveLength(snapshot.body.members.closureCount)
    const keys = membership.members.map(Ref.key)
    expect(keys).toContain(Ref.key(refOf("fragment")))
    expect(keys).toContain(Ref.key(refOf("receipt claim")))
    expect(keys).toContain(Ref.key(refOf("decision adoption")))
    // A receipt's written list is provenance, so the add receipt does not pull in the copy through it.
    expect(keys).not.toContain(Ref.key(refOf("receipt add")))
    expect(keys).not.toContain(Ref.key(refOf("claim computed")))
  })

  test("derives tiers and flags", () => {
    const at = (name: string, facts: Partial<Tier.Facts> = {}, asOfSeq = graph.lastSeq) =>
      Tier.derive({ graph, claim: refOf(name), asOfSeq, facts: { ...all, ...facts } })
    expect(at("claim")).toEqual({ tier: "adopted", flags: ["agent-metadata"] })
    // Before the fragment was re-placed on the newer text, its unresolved re-find marked it stale.
    expect(at("claim", {}, 9)).toEqual({ tier: "adopted", flags: ["agent-metadata", "stale"] })
    // The unattested adoption counts for nothing, and the open researcher challenge marks it contested.
    // The computation read its numbers from the fragment, so the fragment's source carries its flags to the claim.
    expect(at("claim computed")).toEqual({ tier: "computed", flags: ["agent-metadata", "contested"] })
    expect(at("claim computed", { replayed: () => false }).tier).toBe("unsupported")
    // A computation counts only while the fragment it read verifies and was shown to its session.
    expect(at("claim computed", { verified: () => false }).tier).toBe("unsupported")
    expect(at("claim computed", { shown: () => false }).tier).toBe("unsupported")
    // Before the rulings: the checker's challenge is open, and nothing is adopted yet.
    expect(at("claim", {}, 7)).toEqual({ tier: "quoted", flags: ["agent-metadata", "contested"] })
    expect(at("claim", { shown: () => false }, 7).tier).toBe("unsupported")
    expect(at("claim", { verified: () => false }, 7).tier).toBe("unsupported")
  })

  test("derives the effective citation, with each field's voice", () => {
    expect(Tier.citation(graph, refOf("source"), graph.lastSeq)).toEqual({
      title: { value: "Unions, Norms, and Wage Inequality", from: "researcher" },
      issued: { value: { "date-parts": [[2011]] }, from: "program" },
      publisher: { value: "SAGE", from: "agent" },
    })
  })
})

describe("fragment verification", () => {
  test.each(file.fragments)("$name", (vector) => {
    const bytes = encoder.encode(vector.text)
    expect(
      refusal(() =>
        Fragment.verify({ representationDigest: vector.representationDigest, selector: vector.selector, bytes }),
      ),
    ).toBe(vector.result)
  })

  test("checks a fragment in a graph against its representation's bytes", () => {
    const fragment = graph.get(refOf("fragment"), "fragment")
    const text = file.fragments[0].text
    expect(Fragment.verify({ graph, fragment: refOf("fragment"), bytes: encoder.encode(text) }).quote).toBe(
      fragment.body.selector.quote,
    )
    expect(
      refusal(() => Fragment.verify({ graph, fragment: refOf("fragment"), bytes: encoder.encode(`${text} `) })),
    ).toBe("digest-mismatch")
  })

  test("refuses text that is not UTF-8 anywhere, even outside the span", () => {
    const bytes = new Uint8Array([...encoder.encode("abc"), 0xff])
    expect(
      refusal(() =>
        Fragment.verify({
          representationDigest: Canonical.blobDigest(bytes),
          selector: { profile: "utf8-bytes@1", start: 0, end: 3, quote: "abc" },
          bytes,
        }),
      ),
    ).toBe("selector-mismatch")
  })
})

describe("skill digests", () => {
  test.each(file.skills)("$name", (vector) => {
    const files = Object.fromEntries(Object.entries(vector.files).map(([path, text]) => [path, encoder.encode(text)]))
    expect(ResearchRecord.skillDigest(files)).toBe(vector.digest as Canonical.Digest)
  })
})
