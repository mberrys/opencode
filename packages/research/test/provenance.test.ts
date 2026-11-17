import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { makeRecord, refOf } from "@opencode/research-record"
import { addSource, entryOf, read } from "@opencode/research-library"
import { exportBundle } from "@opencode/research-store"
import { check, claim, quote, record, replayLibrary } from "../src/evidence.js"
import { budgetsFor } from "../src/loop.js"
import { article, project } from "./fixture.js"

describe("the record a session writes", () => {
  test("verifies, replays its library calls, and passes the bundle verifier a reader runs without OpenCode", async () => {
    const { session, address, source } = await project()
    const ref = session.store.resolve(source)
    record(session, "library.read", { source }, [], () => read(session.store, { source: ref }))
    const cut = quote(session, { address })
    claim(session, {
      text: "Union decline explains part of the rise in wage inequality.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })

    const result = check(session)
    expect(result.record.issues).toEqual([])
    expect(result.replay.entries.find((entry) => entry.operation === "tool library.read")?.status).toBe("match")

    const out = join(session.store.root, "bundle")
    await exportBundle(session.store, { out })
    const bundle = Bun.spawnSync({ cmd: [process.execPath, join(out, "verify.mjs"), out] })
    expect(bundle.stdout.toString()).toContain("record verifies")
    expect(bundle.exitCode).toBe(0)
  })

  test("a library call replays to a mismatch once the text it read is no longer what the receipt saw", async () => {
    const { session, source } = await project()
    const ref = session.store.resolve(source)
    record(session, "library.read", { source }, [], () => ({ ...read(session.store, { source: ref }), note: "edited" }))
    const replayed = check(session).replay
    expect(replayed.entries.find((entry) => entry.operation === "tool library.read")?.status).toBe("mismatch")
    expect(replayLibrary(session.store)("library.add", {})).toBeUndefined()
  })

  test("a fragment cut under an earlier run cannot be cited once the session starts a new run", async () => {
    const { session, address } = await project()
    const cut = quote(session, { address })
    const protocol = makeRecord({
      kind: "protocol",
      at: "2026-11-10T00:00:01.000Z",
      author: session.actor,
      session: session.session,
      body: {
        question: "A second question",
        scope: { in: [], out: [] },
        subquestions: [],
        effort: "fast",
        budgets: budgetsFor("fast"),
        run: "run_2",
      },
    })
    record(session, "research.protocol", { question: "A second question" }, [protocol], () => ({ run: "run_2" }))
    expect(() =>
      claim(session, {
        text: "Union decline explains part of the rise.",
        evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
      }),
    ).toThrow("was never shown to this session")
  })

  test("a title an agent supplied flags every claim that cites the source", async () => {
    const { session } = await project()
    const respond = (async () =>
      new Response(article, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch
    const added = await addSource(
      session.store,
      { url: "https://example.org/retitled", title: "A title the agent chose" },
      { fetch: respond, now: new Date("2026-11-10T00:00:02.000Z") },
    )
    const short = entryOf(session.store, added.source)!.short
    const cut = quote(session, { address: `${short}:1/p1/s1` })
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    expect(written.tier.flags).toContain("agent-metadata")
    const source = session.store.get(added.source)
    expect(source.kind === "source" && source.body.fieldOrigins.title).toBe("agent")
    expect(refOf(source)).toEqual(added.source)
  })

  test("a title the researcher supplied is not flagged as the agent's", async () => {
    const { session } = await project()
    const respond = (async () =>
      new Response(article, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch
    const added = await addSource(
      session.store,
      { url: "https://example.org/retitled", title: "The researcher's title", by: "researcher" },
      { fetch: respond, now: new Date("2026-11-10T00:00:02.000Z") },
    )
    const source = session.store.get(added.source)
    expect(source.kind === "source" && source.body.fieldOrigins.title).toBe("researcher")
  })
})
