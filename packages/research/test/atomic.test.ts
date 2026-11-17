import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { makeRecord } from "@opencode/research-record"
import { Store, verify } from "@opencode/research-store"
import { record } from "../src/evidence.js"
import { budgetsFor } from "../src/loop.js"
import { project } from "./fixture.js"

const writer = fileURLToPath(new URL("./writer.ts", import.meta.url))

/** A protocol every writer's session joins, so all their receipts are numbered in one run. */
async function sharedRun() {
  const fixture = await project()
  const protocol = makeRecord({
    kind: "protocol",
    at: "2026-11-10T00:00:01.000Z",
    author: fixture.session.actor,
    session: fixture.session.session,
    body: {
      question: "Who writes first?",
      scope: { in: [], out: [] },
      subquestions: [],
      effort: "fast",
      budgets: budgetsFor("fast"),
      run: "run_shared",
    },
  })
  record(fixture.session, "research.protocol", {}, [protocol], () => ({ run: "run_shared" }))
  return fixture
}

function receiptsOf(store: Store, run: string) {
  return store.kind("receipt").filter((receipt) => receipt.body.run === run)
}

describe("a tool call's records and receipt land together", () => {
  test("a call that fails after its records are written leaves neither the records nor a receipt", async () => {
    const { session } = await project()
    const before = { commits: session.store.commits().length, receipts: session.store.kind("receipt").length }
    const claim = makeRecord({
      kind: "claim",
      author: session.actor,
      session: session.session,
      body: { text: "A claim whose card could not be built." },
    })
    expect(() =>
      record(session, "evidence.claim", {}, [claim], () => {
        throw new Error("the card could not be built")
      }),
    ).toThrow("the card could not be built")
    expect(session.store.commits().length).toBe(before.commits)
    expect(session.store.kind("receipt").length).toBe(before.receipts)
    expect(session.store.kind("claim")).toEqual([])
    expect(verify(session.store).issues).toEqual([])
  })

  test("four processes writing to one run never take the same receipt number", async () => {
    const { store, directory } = await sharedRun()
    const writers = ["a", "b", "c", "d"].map((name) =>
      Bun.spawn({ cmd: [process.execPath, writer, directory, name, "5"], stderr: "pipe" }),
    )
    expect(await Promise.all(writers.map((item) => item.exited))).toEqual([0, 0, 0, 0])
    // The protocol's own receipt is number 1; the writers took 2 through 21 between them, each once.
    expect(receiptsOf(store, "run_shared").map((receipt) => receipt.body.seq)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    )
    expect(verify(store).issues).toEqual([])
  })
})

describe("a crash between a tool's records and its receipt", () => {
  test("leaves neither, and the call succeeds when it is retried", async () => {
    const { store, directory } = await sharedRun()
    const before = store.commits().length
    const killed = Bun.spawn({
      cmd: [process.execPath, writer, directory, "a", "1", "claim"],
      env: { ...process.env, OPENCODE_RESEARCH_FAILPOINT: "record.before-receipt" },
      stderr: "pipe",
    })
    await killed.exited
    expect(killed.signalCode ?? killed.exitCode).not.toBe(0)

    const reopened = Store.open(directory)
    expect(reopened.commits().length).toBe(before)
    expect(reopened.kind("claim")).toEqual([])
    expect(verify(reopened).issues).toEqual([])

    const retried = Bun.spawn({ cmd: [process.execPath, writer, directory, "a", "1", "claim"], stderr: "pipe" })
    expect(await retried.exited).toBe(0)
    expect(reopened.kind("claim")).toHaveLength(1)
    expect(receiptsOf(reopened, "run_shared").map((receipt) => receipt.body.seq)).toEqual([1, 2])
    expect(verify(reopened).issues).toEqual([])
    reopened.close()
  })
})
