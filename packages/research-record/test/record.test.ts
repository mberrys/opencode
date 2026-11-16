import { describe, expect, test } from "bun:test"
import { Canonical, ContractError, Graph, Ref, ResearchRecord } from "../src/index"

const file: { projectId: string; revisions: { name: string; seq: number; revision: ResearchRecord.Revision }[] } =
  await Bun.file(new URL("./vectors/revisions.json", import.meta.url)).json()

const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof ContractError) return error.code
    throw error
  }
  return "ok"
}
const named = (name: string) => file.revisions.find((entry) => entry.name === name)!.revision
const preimage = (name: string) => {
  const { revisionId: _, ...rest } = named(name)
  return rest as Record<string, unknown> & { body: Record<string, unknown> }
}
const withBody = (name: string, body: Record<string, unknown>) => ({
  ...preimage(name),
  body: { ...preimage(name).body, ...body },
})

describe("three voices", () => {
  test("only judgment holds an agent's assessment, only decision a ruling, and program kinds only the program", () => {
    expect(ResearchRecord.Writers.judgment).toEqual(["agent"])
    expect(ResearchRecord.Writers.decision).toEqual(["researcher"])
    ResearchRecord.Kinds.filter((kind) =>
      (ResearchRecord.Writers[kind] as readonly string[]).includes("program"),
    ).forEach((kind) => expect(ResearchRecord.Writers[kind]).toEqual(["program"]))
  })

  test.each([
    ["an agent's decision", "decision adoption", { voice: "agent", id: "reader" }],
    ["the program's judgment", "judgment support", { voice: "program", id: "research" }],
    ["an agent's source", "source", { voice: "agent", id: "reader" }],
    ["an agent's fragment", "fragment", { voice: "agent", id: "reader" }],
    ["the program's claim", "claim", { voice: "program", id: "research" }],
  ])("refuses %s", (_, name, author) => {
    expect(refusal(() => ResearchRecord.create({ ...preimage(name), author }))).toBe("invalid-author")
  })

  test("no kind stores a tier", () => {
    const fields = (value: unknown): string[] =>
      Canonical.isPlainObject(value)
        ? Object.entries(value).flatMap(([key, item]) => [key, ...fields(item)])
        : Array.isArray(value)
          ? value.flatMap(fields)
          : []
    expect(file.revisions.flatMap((entry) => fields(entry.revision)).filter((field) => field === "tier")).toEqual([])
  })
})

describe("the parser refuses", () => {
  test.each([
    ["an unknown envelope field", { ...preimage("claim"), extra: 1 }, "invalid-record"],
    ["an unknown body field", withBody("claim", { tier: "adopted" }), "invalid-record"],
    ["a missing body field", { ...preimage("claim"), body: { text: "x", scope: "" } }, "invalid-record"],
    ["an unknown kind", { ...preimage("claim"), kind: "statement", schema: "statement@1" }, "invalid-record"],
    ["a later schema", { ...preimage("claim"), schema: "claim@2" }, "unsupported-schema"],
    [
      "a ref to latest",
      withBody("evidence", { claim: { ...Ref.parse(preimage("evidence").body.claim), revisionId: "latest" } }),
      "invalid-record",
    ],
    [
      "a ref into another project",
      withBody("evidence", { claim: { ...Ref.parse(preimage("evidence").body.claim), projectId: "project-2" } }),
      "cross-project-ref",
    ],
    ["a parent of another object", { ...preimage("fragment refound"), objectId: "fragment-2" }, "invalid-history"],
    ["a blank claim", withBody("claim", { text: " " }), "invalid-record"],
    [
      "a non-integer offset",
      withBody("fragment", { selector: { profile: "utf8-bytes@1", start: 0.5, end: 34, quote: "x" } }),
      "invalid-record",
    ],
    [
      "a quote whose byte length is not its span",
      withBody("fragment", { selector: { profile: "utf8-bytes@1", start: 0, end: 3, quote: "ab" } }),
      "invalid-record",
    ],
    [
      "an empty span",
      withBody("fragment", { selector: { profile: "utf8-bytes@1", start: 3, end: 3, quote: "" } }),
      "invalid-record",
    ],
    [
      "a local time",
      withBody("copy", { retrieved: { from: "file", at: "2026-11-15T10:02:00+01:00" } }),
      "invalid-record",
    ],
    [
      "a non-I-JSON value",
      withBody("source", {
        fields: { title: { value: Number.NaN, origin: { by: "file", copy: Canonical.digest(1) } } },
      }),
      "non-finite-number",
    ],
  ])("%s", (_, input, code) => {
    expect(refusal(() => ResearchRecord.create(input))).toBe(code)
  })

  test("a gap without its searches", () => {
    expect(refusal(() => ResearchRecord.create(withBody("judgment gap", { searched: [] })))).toBe("invalid-record")
  })

  test("unsorted or repeated pins and refs", () => {
    const receipt = preimage("receipt add").body as { written: Ref.Exact[] }
    expect(
      refusal(() => ResearchRecord.create(withBody("receipt add", { written: receipt.written.toReversed() }))),
    ).toBe("invalid-record")
    expect(
      refusal(() =>
        ResearchRecord.create(withBody("receipt add", { written: [receipt.written[0], receipt.written[0]] })),
      ),
    ).toBe("invalid-record")
    const pin = { id: "b", version: "1", digest: Canonical.digest("b") }
    expect(refusal(() => ResearchRecord.create(withBody("receipt add", { lenses: [pin, { ...pin, id: "a" }] })))).toBe(
      "invalid-record",
    )
  })

  test("read spans out of order, and an insertion outside them", () => {
    const cited = (preimage("evidence").body.basis as { cited: Record<string, unknown>[] }).cited[0]
    const evidence = (patch: Record<string, unknown>) =>
      withBody("evidence", { basis: { kind: "quote", cited: [{ ...cited, ...patch }] } })
    expect(
      refusal(() =>
        ResearchRecord.create(
          evidence({
            read: [
              { start: 19, end: 34 },
              { start: 0, end: 13 },
            ],
          }),
        ),
      ),
    ).toBe("invalid-record")
    expect(
      refusal(() =>
        ResearchRecord.create(
          evidence({
            read: [
              { start: 0, end: 13 },
              { start: 10, end: 34 },
            ],
          }),
        ),
      ),
    ).toBe("invalid-record")
    expect(refusal(() => ResearchRecord.create(evidence({ insertions: [{ at: 15, text: "x" }] })))).toBe(
      "invalid-record",
    )
  })

  test("a decision whose object id is not derived from its subject", () => {
    expect(refusal(() => ResearchRecord.create({ ...preimage("decision adoption"), objectId: "decision-1" }))).toBe(
      "invalid-record",
    )
  })

  test("repeated sub-question ids", () => {
    expect(
      refusal(() =>
        ResearchRecord.create(
          withBody("protocol", {
            subquestions: [
              { id: "a", text: "x" },
              { id: "a", text: "y" },
            ],
          }),
        ),
      ),
    ).toBe("invalid-record")
  })
})

describe("the graph refuses", () => {
  const entries = file.revisions.map((entry) => ({ seq: entry.seq, revision: ResearchRecord.parse(entry.revision) }))
  const without = (name: string) => entries.filter((entry) => entry.revision.revisionId !== named(name).revisionId)
  const replacing = (name: string, input: unknown, seq?: number) =>
    entries.map((entry) =>
      entry.revision.revisionId === named(name).revisionId
        ? { seq: seq ?? entry.seq, revision: ResearchRecord.create(input) }
        : entry,
    )
  const build = (list: typeof entries) => refusal(() => Graph.make(file.projectId, list))

  test("the vector project as it is", () => {
    expect(build(entries)).toBe("ok")
  })

  test("a ref to a revision it does not hold", () => {
    expect(build(without("claim"))).toBe("dangling-ref")
  })

  test("a ref of the wrong kind", () => {
    expect(build(replacing("evidence", withBody("evidence", { claim: ResearchRecord.refOf(named("protocol")) })))).toBe(
      "wrong-kind",
    )
  })

  test("a ref to a later commit", () => {
    expect(
      build(
        entries.map((entry) =>
          entry.revision.revisionId === named("protocol").revisionId ? { ...entry, seq: 5 } : entry,
        ),
      ),
    ).toBe("invalid-history")
  })

  test("a revision accepted twice", () => {
    expect(build([...entries, entries[0]])).toBe("invalid-history")
  })

  test("a second first revision of one object", () => {
    expect(build(replacing("fragment refound", { ...preimage("fragment refound"), parent: "none" }))).toBe(
      "invalid-history",
    )
  })

  test("a receipt naming a revision from another commit", () => {
    expect(
      build(
        entries.map((entry) =>
          entry.revision.revisionId === named("receipt add").revisionId ? { ...entry, seq: 3 } : entry,
        ),
      ),
    ).toBe("invalid-record")
  })

  test("a claim addressing a sub-question its protocol lacks", () => {
    const claim = preimage("claim").body.addresses as Record<string, unknown>
    expect(
      refusal(() => ResearchRecord.create(withBody("claim", { addresses: { ...claim, subquestion: "sq-9" } }))),
    ).toBe("ok")
    const list = replacing("claim", withBody("claim", { addresses: { ...claim, subquestion: "sq-9" } }))
    expect(build(list)).toBe("invalid-record")
  })

  test("a ruling on something that is not a challenge", () => {
    const body = {
      ...(preimage("decision challenge ruling").body as ResearchRecord.Body<"decision">),
      challenge: ResearchRecord.refOf(named("judgment support")),
    }
    const input = { ...preimage("decision challenge ruling"), objectId: ResearchRecord.decisionObjectId(body), body }
    expect(build([...entries, { seq: 11, revision: ResearchRecord.create(input) }])).toBe("invalid-record")
  })

  test("a snapshot whose basis is not what claim-basis computes", () => {
    const snapshot = preimage("snapshot").body as ResearchRecord.Body<"snapshot">
    expect(
      build(replacing("snapshot", withBody("snapshot", { members: { ...snapshot.members, closureCount: 1 } }))),
    ).toBe("invalid-record")
  })
})
