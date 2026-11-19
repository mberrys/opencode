import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Add, Find } from "@opencode/research-library"
import { Store } from "@opencode/research-store"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agents } from "../src/agents.js"
import { Evidence } from "../src/evidence.js"
import { Tools } from "../src/tools.js"

// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const PAPER = [
  "# Union decline",
  "",
  "Union decline explains about a fifth of the rise in wage inequality. The rest comes from changes in the returns to education.",
  "",
  "Some argue unions mattered little. They point to trade instead.",
].join("\n")

const made: string[] = []
const opened: Store.Store[] = []
afterEach(() => {
  opened.splice(0).forEach((store) => store.close())
  made.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
})

let calls = 0
/** A call in `session`, in `run`, from the reader agent. */
const call = (session = "session-reader", run = "none"): Evidence.Call => ({
  program: Tools.PROGRAM,
  key: `call-${(calls += 1)}`,
  context: { run, session, message: "message-1", call: `call-${calls}`, initiator: { voice: "agent", id: "reader" } },
})

/** A project whose library holds one paper, and the paper's short address. */
async function project() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-plugin-"))
  made.push(directory)
  const store = Store.open(directory, { projectId: "project-1" })
  opened.push(store)
  const file = path.join(directory, "paper.md")
  fs.writeFileSync(file, PAPER)
  const added = await Add.add(store, { file }, { ...call(), allow: () => false })
  return { directory, store, short: Find.outline(store, added.source).short }
}

const plan = {
  question: "Why did wage inequality rise?",
  scope: { in: ["United States"], out: [] },
  subquestions: [
    { id: "unions", text: "How much did union decline contribute?" },
    { id: "education", text: "How much did returns to education contribute?" },
  ],
  criteria: [],
  plan: "Read the labour economics literature.",
  effort: "fast" as const,
}

describe("quoting and claiming", () => {
  test("a quote is cut by address and checked against the stored text", async () => {
    const lib = await project()
    const quoted = Evidence.quote(lib.store, call(), { address: `${lib.short}:1/p1/s2` })
    expect(quoted).toMatchObject({
      quote: "The rest comes from changes in the returns to education.",
      before: "Union decline explains about a fifth of the rise in wage inequality.",
      after: "",
    })
    const two = Evidence.quote(lib.store, call(), { address: `${lib.short}:1/p1/s1`, sentences: 2 })
    expect(two.quote).toBe(
      "Union decline explains about a fifth of the rise in wage inequality. The rest comes from changes in the returns to education.",
    )
    expect(lib.store.verify().ok).toBe(true)
  })

  test("an agent may claim only from a fragment its own session cut", async () => {
    const lib = await project()
    const quoted = Evidence.quote(lib.store, call("session-a"), { address: `${lib.short}:1/p1/s1` })
    const evidence = [{ fragment: quoted.fragment, role: "supports" as const }]
    expect(() => Evidence.claim(lib.store, call("session-b"), { text: "Unions explain a fifth.", evidence })).toThrow(
      "never shown to this session",
    )
    const claimed = Evidence.claim(lib.store, call("session-a"), { text: "Unions explain a fifth.", evidence })
    const graph = lib.store.graph()
    const link = graph.heads(graph.lastSeq).find((entry) => entry.revision.objectId === claimed.evidence[0])!.revision
    expect(link).toMatchObject({ kind: "evidence", author: { voice: "agent" }, body: { role: "supports" } })
  })

  test("a claim that names a sub-question needs the run's protocol, and that sub-question", async () => {
    const lib = await project()
    const quoted = Evidence.quote(lib.store, call(), { address: `${lib.short}:1/p1/s1` })
    const evidence = [{ fragment: quoted.fragment, role: "supports" as const }]
    expect(() =>
      Evidence.claim(lib.store, call(), { text: "Unions explain a fifth.", evidence, subquestion: "unions" }),
    ).toThrow("write the protocol first")
    const started = Evidence.protocol(lib.store, call("session-lead"), plan)
    expect(() =>
      Evidence.claim(lib.store, call("session-reader", started.run), {
        text: "Unions explain a fifth.",
        evidence,
        subquestion: "trade",
      }),
    ).toThrow("no sub-question trade")
  })
})

describe("a run", () => {
  test("owes every sub-question a claim or a gap, and a gap names the searches it rests on", async () => {
    const lib = await project()
    const started = Evidence.protocol(lib.store, call("session-lead"), plan)
    const reader = () => call("session-reader", started.run)
    expect(Evidence.status(lib.store.graph(), started.run).open.map((item) => item.subquestion)).toEqual([
      "unions",
      "education",
    ])

    const quoted = Evidence.quote(lib.store, reader(), { address: `${lib.short}:1/p1/s1` })
    Evidence.claim(lib.store, reader(), {
      text: "Union decline explains about a fifth of the rise.",
      evidence: [{ fragment: quoted.fragment, role: "supports" }],
      subquestion: "unions",
    })
    expect(() =>
      Evidence.gap(lib.store, reader(), { subquestion: "education", missing: "an estimate", searched: [], close: "x" }),
    ).toThrow("names the searches")
    const graph = lib.store.graph()
    const search = graph.heads(graph.lastSeq).findLast((entry) => entry.revision.kind === "receipt")!.revision
    Evidence.gap(lib.store, reader(), {
      subquestion: "education",
      missing: "a decomposition of the returns to education",
      searched: [search.objectId],
      close: "add Goldin and Katz (2008)",
    })
    expect(Evidence.status(lib.store.graph(), started.run)).toMatchObject({ claims: 1, gaps: 1, open: [] })
    expect(lib.store.verify().ok).toBe(true)
  })

  test("the answer is an artifact over its claims, rendered with tiers, quotes and numbered sources", async () => {
    const lib = await project()
    const started = Evidence.protocol(lib.store, call("session-lead"), plan)
    const reader = () => call("session-reader", started.run)
    const quoted = Evidence.quote(lib.store, reader(), { address: `${lib.short}:1/p1/s1` })
    const claimed = Evidence.claim(lib.store, reader(), {
      text: "Union decline explains about a fifth of the rise.",
      evidence: [{ fragment: quoted.fragment, role: "supports" }],
      subquestion: "unions",
    })
    const answered = Evidence.answer(lib.store, call("session-writer", started.run), {
      sentences: [
        { text: "Union decline explains about a fifth of the rise.", claim: claimed.claim },
        { text: "More work is needed." },
      ],
    })
    expect(answered.markdown).toContain(
      "Union decline explains about a fifth of the rise. [1] More work is needed. _(unsupported)_",
    )
    expect(answered.markdown).toContain("Tier: **quoted**")
    expect(answered.markdown).toContain("> Union decline explains about a fifth of the rise in wage inequality.")
    expect(answered.markdown).toContain("## Open")
    const graph = lib.store.graph()
    const artifact = graph.heads(graph.lastSeq).find((entry) => entry.revision.objectId === answered.answer)!.revision
    expect(artifact).toMatchObject({ kind: "artifact", body: { transformation: "research.answer@1" } })
    expect(Evidence.check(lib.store, started.run)).toMatchObject({ record: { ok: true }, replay: { mismatches: 0 } })
  })
})

describe("run resolution", () => {
  test("a child session joins its parent's run, not the newest run in the project", async () => {
    const lib = await project()
    const first = Evidence.protocol(lib.store, call("session-a"), plan)
    Evidence.protocol(lib.store, call("session-b"), plan)
    const parents: Record<string, string | undefined> = { "session-a-reader": "session-a", "session-a": undefined }
    const run = await Effect.runPromise(
      Tools.resolveRun(
        () => lib.store,
        Session.ID.make("session-a-reader"),
        (id) => Effect.succeed(parents[id] === undefined ? undefined : Session.ID.make(parents[id])),
      ),
    )
    expect(run).toBe(first.run)
  })

  test("a session with no protocol and no parent is in no run", async () => {
    const lib = await project()
    const run = await Effect.runPromise(
      Tools.resolveRun(
        () => lib.store,
        Session.ID.make("session-alone"),
        () => Effect.succeed(undefined),
      ),
    )
    expect(run).toBe("none")
  })
})

describe("the research agents' permissions", () => {
  test("ask before every fetch and every read outside the project, and before reading .env files", () => {
    // Later rules win: fetching always asks, reading asks unless it is in the project, and .env files ask again.
    expect(
      Agents.rules("/work/project").filter((rule) => rule.action === "webfetch" || rule.action === "read"),
    ).toEqual([
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "ask" },
      { action: "read", resource: "/work/project/*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ])
  })
})
