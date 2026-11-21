import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Canonical, ResearchRecord } from "@opencode/research-record"
import fs from "node:fs"
import { Layout } from "../src/layout.js"
import { Replay } from "../src/replay.js"
import { PROJECT, cleanup, encoder, open } from "./fixture.js"

afterEach(cleanup)
// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const QUERY = encoder.encode('{"query":"union density"}')
const RESULTS = encoder.encode('{"results":["paper"]}')
const blob = (bytes: Uint8Array) => ({ digest: Canonical.blobDigest(bytes), schema: "none" })

/** A receipt for one step, in run `run`. */
function receipt(name: string, step: unknown, run = "run-1") {
  return ResearchRecord.create({
    projectId: PROJECT,
    kind: "receipt",
    schema: "receipt@1",
    objectId: `receipt-${name}`,
    parent: "none",
    author: { voice: "program", id: "research@2.3.0" },
    context: {
      run,
      session: "session-1",
      message: "message-1",
      call: `call-${name}`,
      initiator: { voice: "agent", id: "reader" },
    },
    body: {
      at: { started: "2026-11-15T10:00:00Z", ended: "2026-11-15T10:00:01Z" },
      step,
      written: [],
      skills: [],
      lenses: [],
      outcome: { status: "ok" },
    },
  })
}

const tool = (replay: "rerun" | "stored", output: Uint8Array = RESULTS) => ({
  kind: "tool",
  tool: "library.find",
  version: "1",
  replay,
  input: blob(QUERY),
  output: blob(output),
})

/** A store holding these receipts, one commit each, with the query and results admitted. */
function recorded(...receipts: ResearchRecord.Revision[]) {
  const store = open()
  ;[QUERY, RESULTS].forEach((bytes) => store.admit(bytes))
  receipts.forEach((revision) => store.commit({ revisions: [revision] }))
  return store
}

// A deterministic stand-in for library.find: the same query always returns the same results.
const rerun = (tool: string, _version: string, input: Uint8Array) =>
  tool === "library.find" && new TextDecoder().decode(input) === '{"query":"union density"}' ? RESULTS : undefined

const statuses = (report: Replay.Report) => report.entries.map((entry) => [entry.step, entry.status])

describe("replaying a record's receipts", () => {
  test("a tool recorded as rerun runs again and matches by digest", () => {
    const report = Replay.run(recorded(receipt("find", tool("rerun"))), { rerun })
    expect(report).toMatchObject({ ok: true, mismatches: 0, unverifiable: 0 })
    expect(report.entries).toEqual([expect.objectContaining({ seq: 1, step: "tool library.find", status: "match" })])
  })

  test("a rerun that returns other bytes is a mismatch", () => {
    const store = recorded(receipt("find", tool("rerun")))
    const report = Replay.run(store, { rerun: () => encoder.encode('{"results":[]}') })
    expect(report).toMatchObject({ ok: false, mismatches: 1 })
  })

  test("without a rerun, or when the tool cannot run here, the step is unverifiable and the replay fails", () => {
    const store = recorded(receipt("find", tool("rerun")))
    expect(Replay.run(store)).toMatchObject({ ok: false, unverifiable: 1 })
    expect(Replay.run(store, { rerun: () => undefined })).toMatchObject({ ok: false, unverifiable: 1 })
  })

  test("stored steps are answered from their files, and a script cannot replay yet", () => {
    const store = recorded(
      receipt("stored", tool("stored")),
      receipt("model", {
        kind: "model",
        provider: "anthropic",
        model: "claude",
        request: blob(QUERY),
        response: blob(RESULTS),
      }),
      receipt("command", { kind: "command", command: "adopt", input: blob(QUERY) }),
      receipt("script", {
        kind: "script",
        script: blob(QUERY),
        engine: { id: "codemode", version: "1" },
        clock: "2026-11-15T10:00:00Z",
        seed: "1",
        calls: [],
        result: "none",
      }),
    )
    expect(statuses(Replay.run(store, { rerun }))).toEqual([
      ["tool library.find", "match"],
      ["model anthropic/claude", "match"],
      ["command adopt", "match"],
      ["script", "unverifiable"],
    ])
  })

  test("a stored file that was damaged after the commit is a mismatch", () => {
    const store = recorded(receipt("stored", tool("stored")))
    fs.writeFileSync(Layout.blobPath(store.layout, Canonical.blobDigest(RESULTS)), "damaged")
    const report = Replay.run(store, { rerun })
    expect(report).toMatchObject({ ok: false, mismatches: 1 })
    expect(report.entries[0].detail).toContain("cannot be read")
  })

  test("replays only the receipts of the run asked for", () => {
    const store = recorded(receipt("first", tool("rerun")), receipt("second", tool("stored"), "run-2"))
    expect(Replay.run(store, { rerun, run: "run-2" }).entries.map((entry) => entry.seq)).toEqual([2])
  })

  test("a record with nothing to replay is not a pass", () => {
    expect(Replay.run(open())).toEqual({ ok: false, entries: [], mismatches: 0, unverifiable: 0 })
  })
})
