import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeRecord, recordId, refOf } from "@opencode/research-record"
import { verify } from "../src/verify.js"
import { at, buildProject, text } from "./fixture.js"

describe("the record store", () => {
  test("a complete project verifies", () => {
    const { store } = buildProject()
    const report = verify(store)
    expect(report.issues).toEqual([])
    expect(report).toMatchObject({ ok: true, commits: 3, records: 8, blobs: 4 })
    expect(store.head()?.seq).toBe(3)
  })

  test("a record can be read back by exact ref and by unique prefix", () => {
    const { store, records } = buildProject()
    const id = recordId(records.claim)
    expect(store.get({ kind: "claim", id })).toEqual(records.claim)
    expect(store.resolve(`claim:${id.slice(7, 20)}`)).toEqual({ kind: "claim", id })
    expect(store.resolve(`claim:${id}`)).toEqual({ kind: "claim", id })
    expect(() => store.resolve("claim:aaaaaaaaaaaa")).toThrow("no claim matches")
    expect(() => store.resolve("claim:latest")).toThrow("6 or more lowercase hex digits")
  })

  test("a changed file is reported at its digest", () => {
    const { store, blobs } = buildProject()
    writeFileSync(store.blobs.path(blobs.text), "tampered")
    const report = verify(store)
    expect(report.ok).toBe(false)
    expect(report.issues[0]).toMatchObject({ check: "blob", detail: expect.stringContaining("damaged") })
  })

  test("a missing file is reported", () => {
    const { store, blobs } = buildProject()
    store.blobs.remove(blobs.content)
    const report = verify(store)
    expect(report.issues.find((issue) => issue.check === "blob")?.detail).toContain("missing")
  })

  test("an edited commit row breaks the chain at that commit", () => {
    const { directory, store } = buildProject()
    const database = new Database(join(directory, ".research", "record.db"))
    const row = database.query("SELECT body FROM commit_log WHERE seq = 2").get() as { body: string }
    const parsed: unknown = JSON.parse(row.body)
    const body = parsed as { records: { body: { text: string } }[] }
    body.records[2]!.body.text = "A claim the record does not support"
    database.query("UPDATE commit_log SET body = ? WHERE seq = 2").run(JSON.stringify(body))
    database.close()

    const report = verify(store)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => `${issue.check} ${issue.target}`)).toContain("log.chain commit 2")
  })

  test("a removed commit is reported as a gap", () => {
    const { directory, store } = buildProject()
    const database = new Database(join(directory, ".research", "record.db"))
    database.query("DELETE FROM commit_log WHERE seq = 2").run()
    database.close()

    const report = verify(store)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.check)).toContain("log.seq")
  })

  test("a record in the index that the log never held is reported", () => {
    const { directory, store } = buildProject()
    const forged = makeRecord({
      kind: "claim",
      at,
      author: { voice: "agent", id: "reader" },
      body: { text: "a claim nobody committed" },
    })
    const database = new Database(join(directory, ".research", "record.db"))
    database
      .query("INSERT INTO record (id, kind, object, body) VALUES (?, ?, ?, ?)")
      .run(recordId(forged), "claim", forged.object, JSON.stringify(forged))
    database.close()

    const report = verify(store)
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.check === "record.index")).toBe(true)
  })

  test("a quote one character off is reported against its fragment", () => {
    const { store, records } = buildProject()
    if (records.fragment.kind !== "fragment") throw new Error("fixture is not a fragment")
    const edited = {
      ...records.fragment,
      body: { ...records.fragment.body, quote: records.fragment.body.quote.replace("fifth", "sixth") },
    }
    store.commit([edited as never], { at: "2026-11-10T00:00:01.000Z" })
    const report = verify(store)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => `${issue.check} ${issue.detail}`)).toContain(
      "fragment.quote the quote is not the stored bytes",
    )
  })

  test("agent evidence for a passage the session never saw is reported", () => {
    const { store, records } = buildProject()
    const evidence = makeRecord({
      kind: "evidence",
      at,
      author: { voice: "agent", id: "reader" },
      session: "ses_other",
      body: {
        claim: refOf(records.claim),
        role: "supports",
        target: { kind: "fragment", fragment: refOf(records.fragment) },
      },
    })
    store.commit([evidence], { at })
    const report = verify(store)
    expect(report.issues.map((issue) => issue.detail)).toContain(
      "the fragment was never shown to that session",
    )
  })

  test("evidence a researcher wrote is exempt from the shown set", () => {
    const { store, records } = buildProject()
    const evidence = makeRecord({
      kind: "evidence",
      at,
      author: { voice: "researcher", id: "micha" },
      body: {
        claim: refOf(records.claim),
        role: "challenges",
        target: { kind: "fragment", fragment: refOf(records.fragment) },
      },
    })
    store.commit([evidence], { at })
    expect(verify(store).ok).toBe(true)
  })

  test("a citation that does not resolve is reported rather than ignored", () => {
    const { store } = buildProject()
    const dangling = makeRecord({
      kind: "decision",
      at,
      author: { voice: "researcher", id: "micha" },
      body: { target: { kind: "claim", id: `sha256:${"b".repeat(64)}` }, ruling: "adopt" },
    })
    store.commit([dangling], { at })
    const report = verify(store)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.check)).toContain("ref")
  })

  test("the report names the head a reader can compare against", () => {
    const { store } = buildProject()
    expect(verify(store).head).toBe(store.head()!.digest)
  })

  test("two commits cannot share a parent", () => {
    const { directory } = buildProject()
    const database = new Database(join(directory, ".research", "record.db"))
    const first = database.query("SELECT digest, body FROM commit_log WHERE seq = 1").get() as {
      digest: string
      body: string
    }
    expect(() =>
      database
        .query("INSERT INTO commit_log (seq, at, prev, digest, body) VALUES (?, ?, ?, ?, ?)")
        .run(9, at, first.digest, "sha256:" + "c".repeat(64), first.body),
    ).toThrow()
    database.close()
  })

  test("the stored text is the text the fragment was cut from", () => {
    const { store, blobs, records } = buildProject()
    expect(store.text(blobs.text)).toBe(text)
    expect(records.fragment.kind === "fragment" && records.fragment.body.quote).toBe(
      "Union decline explains about a fifth of the rise in wage inequality.",
    )
  })
})
