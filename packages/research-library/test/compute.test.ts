import { describe, expect, test } from "bun:test"
import { Canonical } from "@opencode/research-record"
import { Compute } from "../src/compute.js"

const evaluate = (expression: string, inputs: Record<string, number> = {}) => Compute.evaluate({ expression, inputs })

describe("the compute engine", () => {
  test("follows arithmetic precedence over named inputs", () => {
    expect(evaluate("(before - after) / before * 100", { before: 40, after: 10 })).toBe(75)
    expect(evaluate("2 + 3 * 4 - 6 / 2")).toBe(11)
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512)
    expect(evaluate("-2 ^ 2")).toBe(4)
    expect(evaluate("min(3, x, 7) + max(1, 2) + abs(-1) + sqrt(16) + round(2.5)", { x: 1 })).toBe(11)
    expect(evaluate("1.5e3 / 3")).toBe(500)
    expect(evaluate("0 * -1")).toBe(0)
    expect(Object.is(evaluate("0 * -1"), -0)).toBe(false)
  })

  test("refuses unknown names, malformed expressions and results that are not finite", () => {
    expect(() => evaluate("x + 1")).toThrow("unknown name x")
    expect(() => evaluate("constructor(1)")).toThrow("unknown name constructor")
    expect(() => evaluate("toString(1)")).toThrow("unknown name toString")
    expect(() => evaluate("(1 + 2")).toThrow("expected )")
    expect(() => evaluate("1 2")).toThrow("unexpected 2")
    expect(() => evaluate("1 / 0")).toThrow("not a finite number")
    expect(() => evaluate("")).toThrow("expected more")
  })

  test("replays only its own engine, and a script that no longer evaluates yields an error result", () => {
    const step = (id: string) => ({
      kind: "script" as const,
      script: { digest: Canonical.blobDigest(new Uint8Array()), schema: Compute.SCRIPT },
      engine: { id, version: "1" },
      clock: "2026-11-15T10:00:00Z",
      seed: "none",
      calls: [],
      result: "none" as const,
    })
    const script = (value: unknown) => new TextEncoder().encode(Canonical.json(value))
    const text = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes))
    expect(text(Compute.replay(step(Compute.ENGINE.id), script({ expression: "a * 2", inputs: { a: 3 } })))).toBe(
      '{"value":6}',
    )
    expect(Compute.replay(step("codemode"), script({ expression: "1", inputs: {} }))).toBeUndefined()
    expect(text(Compute.replay(step(Compute.ENGINE.id), script({ expression: "a", inputs: {} })))).toContain("error")
    expect(text(Compute.replay(step(Compute.ENGINE.id), new TextEncoder().encode("not json")))).toContain("error")
  })
})
