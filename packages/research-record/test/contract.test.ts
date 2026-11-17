import { describe, expect, test } from "bun:test"
import { digest } from "../src/digest.js"
import {
  type BodyMap,
  type Kind,
  type Voice,
  CONTRACT,
  KINDS,
  VOICES,
  assertRecord,
  makeRecord,
  recordId,
} from "../src/record.js"

const at = "2026-11-10T00:00:00.000Z"
const blob = digest("a stored file")
const ref = { kind: "claim" as const, id: digest("a claim") }

/** One minimal body per kind and artifact type: every field here is required, so removing any must be refused. */
const SAMPLES: readonly {
  [K in Kind]: { readonly kind: K; readonly label: string; readonly body: BodyMap[K] }
}[Kind][] = [
  {
    kind: "source",
    label: "source",
    body: { type: "other", identifiers: {}, csl: { title: "A title" }, fieldOrigins: {} },
  },
  {
    kind: "copy",
    label: "copy",
    body: { source: ref, digest: blob, mime: "text/plain", bytes: 1, fetchedAt: at, abstractOnly: false },
  },
  {
    kind: "representation",
    label: "representation",
    body: {
      copy: ref,
      text: blob,
      tree: blob,
      extractor: { name: "research-text", version: 1 },
      flags: [],
      sections: 1,
      paragraphs: 1,
      sentences: 1,
      characters: 1,
    },
  },
  {
    kind: "fragment",
    label: "fragment",
    body: {
      representation: ref,
      range: { start: 0, end: 1 },
      quote: "a",
      before: "",
      after: "",
      address: "abcd:1/p1/s1",
      flags: [],
    },
  },
  { kind: "claim", label: "claim", body: { text: "A claim." } },
  {
    kind: "evidence",
    label: "evidence",
    body: { claim: ref, role: "supports", target: { kind: "fragment", fragment: ref } },
  },
  { kind: "judgment", label: "judgment", body: { target: ref, verdict: "holds", reason: "checked" } },
  { kind: "decision", label: "decision", body: { target: ref, ruling: "adopt" } },
  {
    kind: "protocol",
    label: "protocol",
    body: {
      question: "Why?",
      scope: { in: [], out: [] },
      subquestions: [],
      effort: "fast",
      budgets: { subquestions: 1, sourcesPerSubquestion: 1, readFullText: false, gapRounds: 1 },
      run: "run_1",
    },
  },
  {
    kind: "artifact",
    label: "answer artifact",
    body: { type: "answer", run: "run_1", mediaType: "text/markdown", sentences: [], inputs: [] },
  },
  {
    kind: "artifact",
    label: "model-call artifact",
    body: { type: "model-call", run: "run_1", model: "test/model", contents: [blob], response: blob, inputs: [] },
  },
  {
    kind: "artifact",
    label: "script artifact",
    body: { type: "script", run: "run_1", script: blob, result: blob, calls: [], inputs: [] },
  },
  {
    kind: "artifact",
    label: "table artifact",
    body: { type: "table", run: "run_1", mediaType: "text/csv", digest: blob, inputs: [] },
  },
  {
    kind: "artifact",
    label: "export artifact",
    body: { type: "export", run: "run_1", mediaType: "application/zip", digest: blob, inputs: [] },
  },
  {
    kind: "receipt",
    label: "receipt",
    body: {
      run: "run_1",
      seq: 1,
      operation: { kind: "tool", tool: "library.read", input: {} },
      inputs: [],
      output: blob,
      records: [],
      startedAt: at,
      endedAt: at,
      ok: true,
    },
  },
  { kind: "snapshot", label: "snapshot", body: { artifact: ref, claims: [], evidence: [], sources: [] } },
]

/** The writer table as the contract publishes it. Changing who may write a kind is a contract change. */
const WRITERS: { readonly [K in Kind]: readonly Voice[] } = {
  source: ["program", "agent", "researcher"],
  copy: ["program"],
  representation: ["program"],
  fragment: ["program"],
  claim: ["agent", "researcher"],
  evidence: ["agent", "researcher"],
  judgment: ["agent"],
  decision: ["researcher"],
  protocol: ["agent", "researcher"],
  artifact: ["program"],
  receipt: ["program"],
  snapshot: ["program"],
}

function envelope(kind: Kind, body: unknown, voice: Voice = WRITERS[kind][0]!) {
  return { contract: CONTRACT, kind, object: digest({ kind }), author: { voice }, at, body }
}

describe("the record contract", () => {
  test("every kind has a sample and a row in the writer table", () => {
    expect([...new Set(SAMPLES.map((sample) => sample.kind))].sort()).toEqual([...KINDS].sort())
    expect(Object.keys(WRITERS).sort()).toEqual([...KINDS].sort())
  })

  test("every sample is a valid record", () => {
    for (const sample of SAMPLES) expect(() => assertRecord(envelope(sample.kind, sample.body))).not.toThrow()
  })

  test("each voice may write exactly the kinds the contract gives it", () => {
    const refused = KINDS.flatMap((kind) =>
      VOICES.map((voice) => {
        const sample = SAMPLES.find((item) => item.kind === kind)!
        const allowed = (() => {
          try {
            assertRecord(envelope(kind, sample.body, voice))
            return true
          } catch {
            return false
          }
        })()
        return { kind, voice, allowed, expected: WRITERS[kind].includes(voice) }
      }),
    ).filter((row) => row.allowed !== row.expected)
    expect(refused).toEqual([])
  })

  for (const sample of SAMPLES) {
    test(`${sample.label}: removing any field is refused`, () => {
      const accepted = Object.keys(sample.body).filter((field) => {
        const body: { [key: string]: unknown } = { ...sample.body }
        delete body[field]
        return accepts(envelope(sample.kind, body))
      })
      expect(accepted).toEqual([])
    })

    test(`${sample.label}: a field of the wrong type is refused`, () => {
      const accepted = Object.entries(sample.body).flatMap(([field, value]) => {
        const wrong = typeof value === "number" ? "7" : 7
        return accepts(envelope(sample.kind, { ...sample.body, [field]: wrong })) ? [field] : []
      })
      expect(accepted).toEqual([])
    })
  }

  test("envelope fields are checked: contract, object, parent, author and date", () => {
    const valid = envelope("claim", { text: "A claim." })
    expect(accepts(valid)).toBe(true)
    expect(accepts({ ...valid, contract: "research-record@2" })).toBe(false)
    expect(accepts({ ...valid, object: "sha256:ABC" })).toBe(false)
    expect(accepts({ ...valid, parent: "not a digest" })).toBe(false)
    expect(accepts({ ...valid, author: { voice: "model" } })).toBe(false)
    expect(accepts({ ...valid, author: { voice: "agent", id: 7 } })).toBe(false)
    expect(accepts({ ...valid, at: "yesterday" })).toBe(false)
    expect(accepts({ ...valid, body: [] })).toBe(false)
  })

  // Verification follows these nested refs and digests, so a malformed one must stop at the contract.
  const NESTED: readonly { readonly name: string; readonly kind: Kind; readonly body: unknown }[] = [
    {
      name: "a model receipt without the call it names",
      kind: "receipt",
      body: { ...sample("receipt"), operation: { kind: "model" } },
    },
    {
      name: "a script receipt whose artifact is not a ref",
      kind: "receipt",
      body: { ...sample("receipt"), operation: { kind: "script", artifact: "artifact:abc" } },
    },
    {
      name: "a receipt operation of an unknown kind",
      kind: "receipt",
      body: { ...sample("receipt"), operation: { kind: "guess" } },
    },
    {
      name: "a tool receipt without the tool's name",
      kind: "receipt",
      body: { ...sample("receipt"), operation: { kind: "tool", input: {} } },
    },
    {
      name: "an answer sentence whose claim is not a ref",
      kind: "artifact",
      body: { ...sample("artifact"), type: "answer", sentences: [{ text: "A sentence.", claim: "claim:abc" }] },
    },
    {
      name: "an answer sentence without text",
      kind: "artifact",
      body: { ...sample("artifact"), type: "answer", sentences: [{ claim: ref }] },
    },
    {
      name: "a fragment range that is not two byte offsets",
      kind: "fragment",
      body: { ...sample("fragment"), range: { start: "0", end: 1 } },
    },
    {
      name: "a script call whose output is not a digest",
      kind: "artifact",
      body: {
        type: "script",
        run: "run_1",
        script: blob,
        result: blob,
        calls: [{ tool: "t", input: blob, output: "../../etc/passwd" }],
        inputs: [],
      },
    },
    {
      name: "evidence whose target is neither a fragment nor a computation",
      kind: "evidence",
      body: { ...sample("evidence"), target: { kind: "hunch" } },
    },
  ]
  for (const item of NESTED) {
    test(`refused: ${item.name}`, () => {
      expect(accepts(envelope(item.kind, item.body))).toBe(false)
    })
  }

  test("a record's id survives a round trip through JSON text", () => {
    for (const item of SAMPLES) {
      const record = makeRecord({
        kind: item.kind,
        at,
        author: { voice: WRITERS[item.kind][0]! },
        body: item.body,
      } as never)
      const parsed: unknown = JSON.parse(JSON.stringify(record))
      assertRecord(parsed)
      expect(recordId(parsed)).toBe(recordId(record))
    }
  })
})

function sample(kind: Kind): { [key: string]: unknown } {
  return { ...SAMPLES.find((item) => item.kind === kind)!.body }
}

function accepts(value: unknown): boolean {
  try {
    assertRecord(value)
    return true
  } catch {
    return false
  }
}
