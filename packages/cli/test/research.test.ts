import { afterEach, describe, expect, test } from "bun:test"
import { ResearchRecord } from "@opencode/research-record"
import { Store } from "@opencode/research-store"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

const made: string[] = []
afterEach(() => made.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))

function directory() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-research-cli-"))
  made.push(created)
  return created
}

async function cli(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

// Each spawn boots the CLI, so the read-only commands share one record and one test.
describe("opencode research", () => {
  test("verifies and exports an existing record, and refuses a directory that has none without creating one", async () => {
    const root = directory()
    const project = path.join(root, "project")
    const store = Store.open(project, { projectId: "project-1" })
    store.commit({
      revisions: [
        ResearchRecord.create({
          projectId: "project-1",
          kind: "claim",
          schema: "claim@1",
          objectId: "claim-1",
          parent: "none",
          author: { voice: "researcher", id: "me" },
          context: "none",
          body: { text: "Union density fell.", scope: "", addresses: "none" },
        }),
      ],
    })
    store.close()

    const verified = await cli(root, ["research", "verify", "--directory", project])
    expect({ exitCode: verified.exitCode, last: verified.stdout.trim().split("\n").at(-1) }).toEqual({
      exitCode: 0,
      last: "the record verifies",
    })

    const out = path.join(root, "bundle")
    const exported = await cli(root, ["research", "export", out, "--directory", project])
    expect(exported.exitCode).toBe(0)
    expect(fs.existsSync(path.join(out, "verify.mjs"))).toBe(true)

    const missing = path.join(root, "typo")
    const refused = await cli(root, ["research", "verify", "--directory", missing])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr + refused.stdout).toContain("no research record")
    expect(fs.existsSync(path.join(missing, ".research"))).toBe(false)
    // Three CLI boots, each about 8s of start-up on Windows, so this needs more than the package's 30s.
  }, 90_000)
})
