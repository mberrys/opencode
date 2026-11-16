import { describe, expect, test } from "bun:test"
import { Canonical, ContractError } from "../src/canonical"

const vectors: {
  valid: { name: string; json: string; canonical: string; digest: string }[]
  invalid: { name: string; json: string; code: string }[]
  numbers: { bits: string; canonical: string }[]
  invalidNumbers: { name: string; bits: string; code: string }[]
} = await Bun.file(new URL("./vectors/canonical-json.json", import.meta.url)).json()

const double = (bits: string) => Buffer.from(bits, "hex").readDoubleBE(0)

const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    if (error instanceof ContractError) return error.code
    throw error
  }
  return "accepted"
}

describe("canonical JSON vectors shared with the Python verifier", () => {
  test.each(vectors.valid)("$name", (vector) => {
    const value = JSON.parse(vector.json)
    expect(Canonical.json(value)).toBe(vector.canonical)
    expect(Canonical.digest(value)).toBe(vector.digest as Canonical.Digest)
    expect(Canonical.isDigest(vector.digest)).toBe(true)
  })

  test.each(vectors.invalid)("refuses $name", (vector) => {
    expect(refusal(() => Canonical.digest(JSON.parse(vector.json)))).toBe(vector.code)
  })

  test("serializes the RFC 8785 number samples", () => {
    expect(vectors.numbers.map((vector) => Canonical.json(double(vector.bits)))).toEqual(
      vectors.numbers.map((vector) => vector.canonical),
    )
  })

  test.each(vectors.invalidNumbers)("refuses $name", (vector) => {
    expect(refusal(() => Canonical.json(double(vector.bits)))).toBe(vector.code)
  })
})

describe("values only TypeScript can produce", () => {
  test.each([
    ["undefined", undefined, "unsupported-value"],
    ["a class instance", new Date(0), "unsupported-value"],
    ["a function", () => 1, "unsupported-value"],
    ["a bigint", 1n, "unsupported-value"],
    ["an array hole", [1, , 3], "unsupported-value"],
    ["an array with an extra property", Object.assign([1], { extra: 2 }), "unsupported-value"],
    [
      "a cycle",
      (() => {
        const cycle: unknown[] = []
        cycle.push({ cycle })
        return cycle
      })(),
      "cyclic-value",
    ],
  ] as const)("refuses %s", (_, value, code) => {
    expect(refusal(() => Canonical.json(value))).toBe(code)
  })

  test("serializes a repeated but acyclic value", () => {
    const shared = { a: 1 }
    expect(Canonical.json([shared, shared])).toBe('[{"a":1},{"a":1}]')
  })

  test("keeps a byte identity apart from a JSON identity", () => {
    expect(Canonical.blobDigest(new TextEncoder().encode("a"))).not.toBe(Canonical.digest("a"))
  })
})
