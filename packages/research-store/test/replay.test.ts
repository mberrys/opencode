import { describe, expect, test } from "bun:test"
import { digest, makeRecord, refOf } from "@opencode/research-record"
import { replay } from "../src/replay.js"
import { at, buildProject, receipt } from "./fixture.js"

describe("replay", () => {
  test("a model call replays from the stored response with no model call", () => {
    const { store, records, blobs } = buildProject()
    expect(replay(store, "run_1").entries).toEqual([])
    store.commit(
      [receipt({ seq: 1, operation: { kind: "model", call: refOf(records.call) }, output: blobs.response })],
      { at },
    )
    const replayed = replay(store, "run_1")
    expect(replayed.entries).toEqual([
      expect.objectContaining({
        operation: "model call",
        status: "match",
        detail: "answered from the stored response, with no model call",
      }),
    ])
    expect(replayed.ok).toBe(true)
  })

  test("a deterministic tool run again hashes to the recorded output", () => {
    const { store } = buildProject()
    const output = { hits: [{ address: "k7f2:1/p0/s1", text: "Union decline" }] }
    store.commit(
      [
        receipt({
          seq: 1,
          operation: { kind: "tool", tool: "library.grep", input: { pattern: "union" } as never },
          output: digest(output),
        }),
      ],
      { at },
    )
    expect(replay(store, "run_1", { execute: () => output }).entries[0]).toMatchObject({ status: "match" })
    expect(replay(store, "run_1", { execute: () => ({ hits: [] }) }).entries[0]).toMatchObject({ status: "mismatch" })
    expect(replay(store, "run_1").entries[0]).toMatchObject({ status: "unverifiable" })
  })

  test("a script receipt is called unverifiable, not passed", () => {
    const { store } = buildProject()
    const script = makeRecord({
      kind: "artifact",
      at,
      author: { voice: "program" },
      body: {
        type: "script",
        run: "run_1",
        script: digest({ script: "count" }),
        result: digest({ result: 3 }),
        calls: [],
        inputs: [],
      },
    })
    store.commit([script, receipt({ seq: 1, operation: { kind: "script", artifact: refOf(script) }, output: digest({ result: 3 }) })], { at })
    const report = replay(store, "run_1")
    expect(report.entries[0]).toMatchObject({ operation: "script", status: "unverifiable" })
    expect(report.unverifiable).toBe(1)
    expect(report.ok).toBe(false)
  })

  test("a missing model call is a mismatch rather than a pass", () => {
    const { store } = buildProject()
    store.commit(
      [
        receipt({
          seq: 1,
          operation: { kind: "model", call: { kind: "artifact", id: digest({ missing: 1 }) } },
          output: digest({ response: 1 }),
        }),
      ],
      { at },
    )
    expect(replay(store, "run_1").entries[0]).toMatchObject({
      status: "mismatch",
      detail: "the recorded model call is missing",
    })
  })

  test("a run with no receipts does not replay", () => {
    const { store } = buildProject()
    const report = replay(store, "no-such-run")
    expect(report.entries).toEqual([])
    expect(report.ok).toBe(false)
  })

  test("receipts of another run are not replayed", () => {
    const { store } = buildProject()
    store.commit([receipt({ run: "run_2", seq: 1, operation: { kind: "tool", tool: "library.grep", input: {} as never }, output: digest({}) })], { at })
    expect(replay(store, "run_1").entries).toEqual([])
  })
})
