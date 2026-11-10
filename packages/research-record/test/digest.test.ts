import { describe, expect, test } from "bun:test"
import { canonical, digest, isDigest } from "../src/digest.js"

const vectors = (await Bun.file(new URL("./vectors.json", import.meta.url)).json()) as {
  name: string
  input: never
  canonical: string
  digest: string
}[]

describe("canonical JSON", () => {
  for (const vector of vectors) {
    test(`frozen vector ${vector.name}`, () => {
      expect(canonical(vector.input)).toBe(vector.canonical)
      expect(digest(vector.input)).toBe(vector.digest as never)
    })
  }

  test("a vector digests the same however the object was built", () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }))
  })

  test("one changed character changes the digest", () => {
    expect(digest({ text: "the policy caused it" })).not.toBe(digest({ text: "the policy may have caused it" }))
  })

  test("non-finite numbers are refused rather than serialized", () => {
    expect(() => canonical(Number.NaN)).toThrow("canonical JSON cannot hold NaN")
    expect(() => canonical(Number.POSITIVE_INFINITY)).toThrow("canonical JSON cannot hold Infinity")
  })

  test("undefined is refused rather than dropped silently", () => {
    expect(() => canonical({ a: undefined } as never)).toThrow("undefined")
  })

  test("negative zero serializes as zero", () => {
    expect(canonical(-0)).toBe("0")
  })

  test("keys sort by UTF-16 code unit, not by code point", () => {
    expect(canonical({ "\uFFFD": 2, "😀": 1 })).toBe('{"😀":1,"\uFFFD":2}')
  })

  test("a digest is sha256 plus 64 lowercase hex digits", () => {
    const value = digest({ a: 1 })
    expect(isDigest(value)).toBe(true)
    expect(value).toHaveLength(71)
  })

  test("the python verifier agrees with the frozen vectors", async () => {
    const { fileURLToPath } = await import("node:url")
    const runner = Bun.which("python") ?? Bun.which("python3") ?? Bun.which("py")
    if (!runner) throw new Error("python is needed for the independent digest verifier")
    const result = Bun.spawnSync({
      cmd: [runner, "script/verify_vectors.py", "test/vectors.json"],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    })
    expect(result.stdout.toString().trim()).toBe(`python verifier agrees on ${vectors.length} vectors`)
    expect(result.exitCode).toBe(0)
  })
})
