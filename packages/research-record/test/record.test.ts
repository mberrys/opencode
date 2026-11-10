import { describe, expect, test } from "bun:test"
import { digest } from "../src/digest.js"
import type { ClaimBody, SourceBody } from "../src/record.js"
import { CONTRACT, KINDS, assertRecord, makeRecord, parseRef, recordId, refOf, revise } from "../src/record.js"

const at = "2026-11-10T00:00:00.000Z"

const source = makeRecord({
  kind: "source",
  at,
  author: { voice: "program" },
  body: {
    type: "journal-article",
    identifiers: { doi: "10.1093/sf/soaa001" },
    csl: { title: "Union decline and wage inequality", container: "Social Forces", DOI: "10.1093/sf/soaa001" },
    fieldOrigins: { title: "crossref", container: "crossref", DOI: "crossref" },
  } satisfies SourceBody,
})

const claim = makeRecord({
  kind: "claim",
  at,
  author: { voice: "agent", id: "reader" },
  session: "ses_1",
  body: { text: "Union decline explains part of the rise in wage inequality." } satisfies ClaimBody,
})

describe("records", () => {
  test("a record names its own contract", () => {
    expect(claim.contract).toBe(CONTRACT)
    expect(KINDS).toContain(claim.kind)
  })

  test("the first revision's object id comes from its content, not from its revision id", () => {
    const again = makeRecord({ kind: "claim", at, author: { voice: "agent" }, body: { text: claim.body.text } })
    expect(again.object).toBe(claim.object)
    expect(recordId(again)).not.toBe(recordId(claim))
    expect(claim.object).not.toBe(recordId(claim))
  })

  test("a revision keeps the object and points at the revision it replaces", () => {
    const revision = revise(claim, { text: "Union decline explains about a fifth of the rise." }, {
      voice: "agent",
      id: "reader",
    }, { at })
    expect(revision.object).toBe(claim.object)
    expect(revision.parent).toBe(recordId(claim))
    expect(recordId(revision)).not.toBe(recordId(claim))
  })

  test("changing one word changes the revision id", () => {
    const other = revise(claim, { text: "Union decline explains most of the rise." }, { voice: "agent" }, { at })
    expect(recordId(other)).not.toBe(recordId(revise(claim, claim.body, { voice: "agent" }, { at })))
  })

  test("the program may not write a claim and an agent may not write a decision", () => {
    expect(() =>
      makeRecord({ kind: "claim", at, author: { voice: "program" }, body: { text: "x" } }),
    ).toThrow("a program may not write a claim")
    expect(() =>
      makeRecord({
        kind: "decision",
        at,
        author: { voice: "agent", id: "reader" },
        body: { target: refOf(claim), ruling: "adopt" },
      }),
    ).toThrow("a agent may not write a decision")
  })

  test("a decision is written by the researcher", () => {
    const decision = makeRecord({
      kind: "decision",
      at,
      author: { voice: "researcher", id: "micha" },
      body: { target: refOf(claim), ruling: "adopt" },
    })
    expect(decision.body.ruling).toBe("adopt")
  })

  test("an unknown kind, a bad digest and a missing body are refused", () => {
    expect(() => assertRecord({ ...claim, kind: "guess" })).toThrow("unknown record kind")
    expect(() => assertRecord({ ...claim, object: "md5:abc" })).toThrow("object must be a digest")
    expect(() => assertRecord({ ...claim, body: {} })).toThrow("claim.text must be a string")
  })

  test("an evidence role and a protocol effort are closed sets", () => {
    expect(() =>
      makeRecord({
        kind: "evidence",
        at,
        author: { voice: "agent" },
        body: { claim: refOf(claim), role: "supports-ish" as never, target: { kind: "fragment", fragment: refOf(source) } },
      }),
    ).toThrow("evidence.role must be one of")
  })

  test("optional fields that were never set are absent from the digest", async () => {
    const minimal = makeRecord({ kind: "claim", at, author: { voice: "agent" }, body: { text: "x" } })
    const given = makeRecord({
      kind: "claim",
      at,
      author: { voice: "agent" },
      body: { text: "x", scope: { question: "q" } },
    })
    expect(Object.keys(minimal)).not.toContain("parent")
    expect(recordId(minimal)).not.toBe(recordId(given))
    expect(minimal).toMatchObject({ object: digest({ contract: CONTRACT, kind: "claim", body: { text: "x" } }) })
  })

  test("asking for the ref of a ref returns it unchanged", () => {
    const record = makeRecord({
      kind: "source",
      at: "2026-01-01T00:00:00.000Z",
      author: { voice: "program" },
      body: { type: "other", identifiers: {}, csl: { title: "T" }, fieldOrigins: {} },
    })
    expect(refOf(refOf(record))).toEqual(refOf(record))
  })

  test("a ref round trips through its string form", () => {
    const value = refOf(claim)
    expect(parseRef(`${value.kind}:${value.id}`)).toEqual(value)
    expect(() => parseRef(`${value.kind}:latest`)).toThrow("not a ref id")
    expect(() => parseRef(value.id)).toThrow("unknown record kind")
    expect(() => parseRef("no-colon")).toThrow("not a ref")
  })
})
