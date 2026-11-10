import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { exportBundle, sealRendered } from "../src/export.js"
import { buildProject } from "./fixture.js"

function run(dir: string) {
  return Bun.spawnSync({ cmd: [process.execPath, join(dir, "verify.mjs"), dir] })
}

describe("the export bundle", () => {
  test("a reader with no dependencies can check the record", async () => {
    const { store, directory } = buildProject()
    const out = join(directory, "bundle")
    const result = await exportBundle(store, { out })
    expect(result.blobs).toBe(4)
    expect(readFileSync(result.log, "utf8").trim().split("\n")).toHaveLength(3)

    const verified = run(out)
    expect(verified.stdout.toString()).toContain("record verifies: 8 records")
    expect(verified.exitCode).toBe(0)
  })

  test("one flipped byte in a stored file fails the bundle", async () => {
    const { store, directory, blobs } = buildProject()
    const out = join(directory, "bundle")
    await exportBundle(store, { out })
    writeFileSync(join(out, "blobs", blobs.text.slice(7)), "a byte changed")

    const verified = run(out)
    expect(verified.exitCode).toBe(1)
    expect(verified.stdout.toString()).toContain("blob")
  })

  test("a byte changed in the copy the text came from fails the bundle", async () => {
    const { store, directory, records } = buildProject()
    const out = join(directory, "bundle")
    await exportBundle(store, { out })
    if (records.copy.kind !== "copy") throw new Error("fixture is not a copy")
    writeFileSync(join(out, "blobs", records.copy.body.digest.slice(7)), "a byte changed")

    const verified = run(out)
    expect(verified.exitCode).toBe(1)
    expect(verified.stdout.toString()).toContain("blob")
  })

  test("an edited log row fails the bundle", async () => {
    const { store, directory } = buildProject()
    const out = join(directory, "bundle")
    await exportBundle(store, { out })
    const log = join(out, "log.jsonl")
    const lines = readFileSync(log, "utf8").trim().split("\n")
    const parsed: unknown = JSON.parse(lines[1]!)
    const second = parsed as { records: { body: { text: string } }[] }
    second.records[1]!.body.text = "Union decline explains most of the rise in wage inequality."
    lines[1] = JSON.stringify(second)
    writeFileSync(log, `${lines.join("\n")}\n`)

    const verified = run(out)
    expect(verified.exitCode).toBe(1)
    expect(verified.stdout.toString()).toContain("log.chain")
  })

  test("a rendered answer is covered by the manifest once it is sealed", async () => {
    const { store, directory } = buildProject()
    const out = join(directory, "bundle")
    await exportBundle(store, { out })
    await Bun.write(join(out, "answer.md"), "# Answer\n\nA sentence.[1]\n")
    const sealed = await sealRendered(out, ["answer.md"])
    expect(sealed["answer.md"]).toMatch(/^sha256:/)
    expect(run(out).exitCode).toBe(0)

    await Bun.write(join(out, "answer.md"), "# Answer\n\nA different sentence.[1]\n")
    const verified = run(out)
    expect(verified.exitCode).toBe(1)
    expect(verified.stdout.toString()).toContain("rendered")
  })

  test("a log with a commit removed disagrees with its manifest and fails", async () => {
    const { store, directory } = buildProject()
    const out = join(directory, "bundle")
    await exportBundle(store, { out })
    const log = join(out, "log.jsonl")
    const lines = readFileSync(log, "utf8").trim().split("\n")
    writeFileSync(log, `${lines.slice(0, -1).join("\n")}\n`)

    const verified = run(out)
    expect(verified.exitCode).toBe(1)
    expect(verified.stdout.toString()).toContain("manifest")
  })

  test("the manifest names the head of the chain", async () => {
    const { store, directory } = buildProject()
    const out = join(directory, "bundle")
    const result = await exportBundle(store, { out })
    const parsed: unknown = JSON.parse(readFileSync(result.manifest, "utf8"))
    const manifest = parsed as { head: string; commits: number }
    expect(manifest.head).toBe(store.head()!.digest)
    expect(manifest.commits).toBe(3)
  })
})
