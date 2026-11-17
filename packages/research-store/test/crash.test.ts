import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { digestBytes } from "@opencode/research-record"
import { Store } from "../src/store.js"
import { verify } from "../src/verify.js"
import { buildProject } from "./fixture.js"

const crasher = fileURLToPath(new URL("./crasher.ts", import.meta.url))
const bytes = new TextEncoder().encode("bytes written by the crasher")

/** Runs the crasher, killed with SIGKILL at `failpoint` when one is given, as a power cut would stop it. */
async function run(directory: string, action: "commit" | "blob", failpoint?: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, crasher, directory, action],
    env: { ...process.env, OPENCODE_RESEARCH_FAILPOINT: failpoint ?? "" },
    stderr: "pipe",
  })
  await child.exited
  return child.signalCode ?? child.exitCode
}

describe("a process killed part way through a write", () => {
  test("before its commit is durable leaves the record as it was, and a retry lands", async () => {
    const fixture = buildProject()
    const head = fixture.store.head()
    expect(await run(fixture.directory, "commit", "commit.before-commit")).not.toBe(0)

    const reopened = Store.open(fixture.directory)
    expect(reopened.head()).toEqual(head)
    expect(verify(reopened).issues).toEqual([])
    expect(await run(fixture.directory, "commit")).toBe(0)
    expect(reopened.head()!.seq).toBe(head!.seq + 1)
    expect(verify(reopened).issues).toEqual([])
    reopened.close()
  })

  test("after its commit is durable keeps the commit whole", async () => {
    const fixture = buildProject()
    const head = fixture.store.head()
    expect(await run(fixture.directory, "commit", "commit.after-commit")).not.toBe(0)

    const reopened = Store.open(fixture.directory)
    expect(reopened.head()!.seq).toBe(head!.seq + 1)
    expect(reopened.kind("claim").map((claim) => claim.body.text)).toContain("A claim the crasher commits.")
    expect(verify(reopened).issues).toEqual([])
    reopened.close()
  })

  test("before a stored file is renamed into place leaves no file under the digest, and a retry stores it", async () => {
    const fixture = buildProject()
    const digest = digestBytes(bytes)
    expect(await run(fixture.directory, "blob", "blob.before-rename")).not.toBe(0)

    // The half-finished write is only ever a temporary name; the digest names complete bytes or nothing.
    expect(fixture.store.blobs.has(digest)).toBe(false)
    expect(fixture.store.blobs.list()).not.toContain(digest)
    expect(readdirSync(fixture.store.blobs.directory).some((name) => name.endsWith(".tmp"))).toBe(true)
    expect(verify(fixture.store).issues).toEqual([])

    expect(await run(fixture.directory, "blob")).toBe(0)
    expect(fixture.store.blobs.get(digest)).toEqual(bytes)
  })
})
