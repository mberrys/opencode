import { afterEach, describe, expect, test } from "bun:test"
import { Canonical } from "@opencode/research-record"
import fs from "node:fs"
import path from "node:path"
import { Failpoint } from "../src/failpoint.js"
import { Layout } from "../src/layout.js"
import { cleanup, open, paper, project, refusal } from "./fixture.js"

// Ported from Ivory's failpoint tests: a process killed at any point of admission or commit leaves no half-written
// record, and bytes it was writing stay invisible until a commit references them.

afterEach(cleanup)

const CHILD = path.join(import.meta.dir, "child.ts")

/** The head after a kill on the second hit: only `afterDbCommit` lets the second commit land. */
const HEAD_AFTER_KILL: Record<Failpoint.Name, number> = {
  duringBlobStage: 1,
  beforeBlobInstall: 1,
  afterBlobInstall: 1,
  beforeDbCommit: 1,
  afterDbCommit: 2,
}

async function killedAt(directory: string, name: Failpoint.Name) {
  const marker = path.join(directory, "marker.json")
  const child = Bun.spawn(["bun", CHILD, "kill", directory, name, "2", marker], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 30_000)
  const exitCode = await child.exited
  clearTimeout(timer)
  const output = await new Response(child.stdout).text()
  return { exitCode, pid: child.pid, output, marker: JSON.parse(fs.readFileSync(marker, "utf8")) }
}

describe("a process killed", () => {
  for (const name of Failpoint.NAMES) {
    test(`at ${name} leaves a record that verifies, and bytes no commit references stay unreadable`, async () => {
      const directory = project()
      const layout = Layout.of(directory)
      const killed = await killedAt(directory, name)
      expect(killed.output).toContain(`ready ${killed.pid}`)
      expect(killed.marker).toEqual({ name, pid: killed.pid })
      expect(killed.exitCode).not.toBe(0)

      const staged = fs.existsSync(layout.staging) ? fs.readdirSync(layout.staging) : []
      const second = paper("k1")
      const digest = Canonical.blobDigest(second.bytes)
      const installed = fs.existsSync(Layout.blobPath(layout, digest))
      if (name === "duringBlobStage") {
        expect(staged).toHaveLength(1)
        expect(fs.statSync(path.join(layout.staging, staged[0])).size).toBe(16)
        expect(installed).toBe(false)
      }
      if (name === "beforeBlobInstall") {
        expect(staged).toHaveLength(1)
        expect(fs.statSync(path.join(layout.staging, staged[0])).size).toBe(32)
        expect(installed).toBe(false)
      }
      if (name === "afterBlobInstall" || name === "beforeDbCommit") expect(installed).toBe(true)

      const store = open(directory)
      // A kill inside admission leaves its staged file (after the install, a second name for the blob's data).
      if (name.includes("Blob")) expect(staged).toHaveLength(1)
      if (staged.length > 0) expect(store.swept).toEqual([killed.pid])
      expect(fs.readdirSync(layout.staging)).toEqual([])
      expect(store.head()?.seq).toBe(HEAD_AFTER_KILL[name])
      expect(store.verify().ok).toBe(true)

      if (name !== "afterDbCommit") {
        if (installed) expect(refusal(() => store.readBlob(digest)).code).toBe("blob-unreferenced")
        // The same request, retried, commits as if the kill never happened.
        store.admit(second.bytes)
        const retried = store.commit({ key: "k1", revisions: second.revisions })
        expect({ seq: retried.seq, replayed: retried.replayed }).toEqual({ seq: 2, replayed: false })
      }
      if (name === "afterDbCommit") {
        expect(store.readBlob(digest)).toEqual(second.bytes)
        // The commit landed before the kill, so the retry finds it, with or without its key.
        expect(store.commit({ key: "k1", revisions: second.revisions }).replayed).toBe(true)
        expect(store.commit({ revisions: second.revisions }).replayed).toBe(true)
      }
      expect(store.verify().ok).toBe(true)
    }, 60_000)
  }
})

describe("several processes", () => {
  test("open a new record and commit at once without breaking the chain", async () => {
    const directory = project()
    const writers = ["a", "b", "c", "d"].map((writer) =>
      Bun.spawn(["bun", CHILD, "claims", directory, writer, "15"], { stdout: "pipe", stderr: "pipe" }),
    )
    const codes = await Promise.all(writers.map((writer) => writer.exited))
    const errors = await Promise.all(writers.map((writer) => new Response(writer.stderr).text()))
    expect({ codes, errors: errors.filter((text) => text.includes("error")) }).toEqual({
      codes: [0, 0, 0, 0],
      errors: [],
    })
    const store = open(directory)
    const verified = store.verify()
    expect({ ok: verified.ok, headSeq: verified.headSeq }).toEqual({ ok: true, headSeq: 60 })
    expect(store.graph().entries).toHaveLength(60)
  }, 120_000)
})
