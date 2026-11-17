import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Digest, type Record, canonical, digest, recordId, revise } from "@opencode/research-record"
import { exportBundle } from "../src/export.js"
import { type CheckName, verify } from "../src/verify.js"
import { type Fixture, at, buildProject } from "./fixture.js"

interface Entry {
  body: { seq: number; at: string; prev: Digest | null; records: Record[] }
  digest: Digest
}

interface Tamper {
  readonly name: string
  /** Rewrites the record before it is exported, as someone with write access to `.research` could. */
  readonly record?: (fixture: Fixture) => void
  /** Damages stored files after the export, in the store and in the bundle alike. */
  readonly files?: (fixture: Fixture, out: string) => void
  /** Either verifier may name any of these; both must name one. */
  readonly expected: readonly CheckName[]
}

const OTHER = `sha256:${"0".repeat(64)}` as Digest

/**
 * Every attack here must be caught twice: by `verify` over the SQLite record, and by the dependency-free
 * `verify.mjs` over the exported bundle. A reader outside OpenCode has only the second, so the two must agree.
 */
const TAMPERS: readonly Tamper[] = [
  {
    name: "a quote edited in place, chain left as it was",
    record: (fixture) =>
      rewrite(fixture, false, (entries) => {
        edit(
          find(entries, "fragment"),
          ["body", "quote"],
          "Union decline explains about a third of the rise in wage inequality.",
        )
      }),
    expected: ["log.chain"],
  },
  {
    name: "a quote edited and the whole chain recomputed",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(
          find(entries, "fragment"),
          ["body", "quote"],
          "Union decline explains about a third of the rise in wage inequality.",
        )
      }),
    expected: ["fragment.quote"],
  },
  {
    name: "the context after a quote edited and the chain recomputed",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "fragment"), ["body", "after"], " The rest comes from changes in the returns to luck.")
      }),
    expected: ["fragment.quote"],
  },
  {
    name: "a quote's byte range shifted by one and the chain recomputed",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        const fragment = find(entries, "fragment")
        if (fragment.kind !== "fragment") return
        edit(fragment, ["body", "range"], { start: fragment.body.range.start + 1, end: fragment.body.range.end + 1 })
      }),
    expected: ["fragment.quote"],
  },
  {
    name: "a commit removed from the middle",
    record: (fixture) => rewrite(fixture, false, (entries) => void entries.splice(1, 1)),
    expected: ["log.chain", "log.seq"],
  },
  {
    name: "two commits swapped",
    record: (fixture) =>
      rewrite(fixture, false, (entries) => {
        const [first, second] = [entries[0]!, entries[1]!]
        entries[0] = second
        entries[1] = first
      }),
    expected: ["log.chain", "log.seq"],
  },
  {
    name: "an adoption rewritten as the agent's and the chain recomputed",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "decision"), ["author"], { voice: "agent", id: "reader" })
      }),
    expected: ["record.contract"],
  },
  {
    name: "a record of a kind the contract does not know",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "decision"), ["kind"], "verdict")
      }),
    expected: ["record.contract"],
  },
  {
    name: "a copy whose source ref is removed",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "copy"), ["body", "source"], undefined)
      }),
    // The full verifier refuses the body; the bundle verifier, which checks envelopes only, finds the broken ref.
    expected: ["record.contract", "ref"],
  },
  {
    name: "evidence with no target",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "evidence"), ["body", "target"], undefined)
      }),
    expected: ["record.contract"],
  },
  {
    name: "a fragment with no byte range",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "fragment"), ["body", "range"], undefined)
      }),
    expected: ["record.contract"],
  },
  {
    name: "a model call with no request contents",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "artifact"), ["body", "contents"], undefined)
      }),
    expected: ["record.contract"],
  },
  {
    name: "evidence that cites a claim the record never held",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "evidence"), ["body", "claim"], { kind: "claim", id: OTHER })
      }),
    expected: ["ref"],
  },
  {
    name: "a ref that names the right id under the wrong kind",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "decision"), ["body", "target", "kind"], "source")
      }),
    expected: ["ref"],
  },
  {
    name: "a revision whose parent is not in the record",
    record: (fixture) => {
      const revision = reviseClaim(fixture)
      edit(revision, ["parent"], OTHER)
      fixture.store.commit([revision], { at })
    },
    expected: ["ref"],
  },
  {
    name: "a revision that names another object than its parent",
    record: (fixture) => {
      const revision = reviseClaim(fixture)
      edit(revision, ["object"], OTHER)
      fixture.store.commit([revision], { at })
    },
    expected: ["record.object"],
  },
  {
    name: "a first revision whose object is not the digest of its content",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "claim"), ["body", "text"], "Union decline explains all of the rise in wage inequality.")
      }),
    expected: ["record.object"],
  },
  {
    name: "a citation field removed from a source",
    record: (fixture) =>
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "source"), ["body", "csl", "issued"], undefined)
      }),
    expected: ["citation.fields"],
  },
  {
    name: "agent evidence for a passage the session's model calls never showed",
    record: (fixture) => {
      const unrelated = fixture.store.put(new TextEncoder().encode("A passage about something else entirely."))
      rewrite(fixture, true, (entries) => {
        edit(find(entries, "artifact"), ["body", "contents"], [unrelated])
      })
    },
    expected: ["evidence.shown"],
  },
  {
    name: "one byte of the extracted text changed",
    files: (fixture, out) => damage(fixture, out, fixture.blobs.text, (bytes) => bytes.with(0, bytes[0]! ^ 1)),
    expected: ["blob"],
  },
  {
    name: "a stored file deleted",
    files: (fixture, out) => {
      rmSync(fixture.store.blobs.path(fixture.blobs.response))
      rmSync(join(out, "blobs", fixture.blobs.response.slice(7)))
    },
    expected: ["blob"],
  },
]

describe("tampering is caught by both verifiers", () => {
  test("the untampered project passes both", async () => {
    const fixture = buildProject()
    const out = join(fixture.directory, "bundle")
    await exportBundle(fixture.store, { out })
    expect(verify(fixture.store).issues).toEqual([])
    expect(bundle(out)).toEqual({ exitCode: 0, checks: [] })
  })

  for (const tamper of TAMPERS) {
    test(tamper.name, async () => {
      const fixture = buildProject()
      tamper.record?.(fixture)
      const out = join(fixture.directory, "bundle")
      await exportBundle(fixture.store, { out })
      tamper.files?.(fixture, out)

      const report = verify(fixture.store)
      expect(report.ok).toBe(false)
      expect(report.issues.map((issue) => issue.check).filter((check) => tamper.expected.includes(check))).not.toEqual(
        [],
      )

      const checked = bundle(out)
      expect(checked.exitCode).toBe(1)
      expect(checked.checks.filter((check) => tamper.expected.includes(check as CheckName))).not.toEqual([])
    })
  }
})

describe("truncation", () => {
  test("dropping the last commits leaves a chain that links, so only the pinned head and the manifest catch it", async () => {
    const fixture = buildProject()
    const pinned = verify(fixture.store).head
    const out = join(fixture.directory, "bundle")
    await exportBundle(fixture.store, { out })

    rewrite(fixture, false, (entries) => void entries.pop())
    const report = verify(fixture.store)
    expect(report.issues.filter((issue) => issue.check.startsWith("log."))).toEqual([])
    expect(report.head).not.toBe(pinned)

    const log = join(out, "log.jsonl")
    const lines = readFileSync(log, "utf8").trim().split("\n")
    writeFileSync(log, `${lines.slice(0, -1).join("\n")}\n`)
    expect(bundle(out).checks).toContain("manifest")
  })
})

describe("the query index is checked column by column", () => {
  const cases: readonly { name: string; sql: (record: Record) => [string, ...string[]] }[] = [
    {
      // Filing the adoption under another kind would hide it from every lookup by kind, and so from the tier.
      name: "a record filed under another kind",
      sql: (record) => ["UPDATE record SET kind = 'claim' WHERE id = ?", recordId(record)],
    },
    {
      name: "a record filed under another id",
      sql: (record) => ["UPDATE record SET id = ? WHERE id = ?", OTHER, recordId(record)],
    },
    {
      name: "a record filed under another object",
      sql: (record) => ["UPDATE record SET object = ? WHERE id = ?", OTHER, recordId(record)],
    },
    {
      name: "a record missing from the index",
      sql: (record) => ["DELETE FROM record WHERE id = ?", recordId(record)],
    },
    {
      name: "an indexed body that is not a record",
      sql: (record) => ["UPDATE record SET body = '{}' WHERE id = ?", recordId(record)],
    },
  ]
  for (const item of cases) {
    test(item.name, () => {
      const fixture = buildProject()
      const [statement, ...values] = item.sql(fixture.records.decision)
      const database = new Database(join(fixture.store.root, "record.db"))
      database.query(statement).run(...values)
      database.close()
      const report = verify(fixture.store)
      expect(report.issues.map((issue) => issue.check)).toContain("record.index")
    })
  }
})

describe("a project written through the store verifies however it grows", () => {
  test("revisions written through the store keep their object and verify", () => {
    const fixture = buildProject()
    fixture.store.commit([reviseClaim(fixture)], { at })
    expect(verify(fixture.store).issues).toEqual([])
  })
})

function reviseClaim(fixture: Fixture): Record {
  const claim = fixture.records.claim
  if (claim.kind !== "claim") throw new Error("the fixture's claim is not a claim")
  return revise(
    claim,
    { text: "Union decline explains roughly a fifth of the rise in wage inequality." },
    claim.author,
    {
      at,
      session: "ses_1",
    },
  ) as Record
}

/**
 * Rewrites the commit log as an attacker with the database file could. With `rechain`, every prev and digest is
 * recomputed and the index rebuilt to match, so only checks over the content itself can catch the change.
 */
function rewrite(fixture: Fixture, rechain: boolean, mutate: (entries: Entry[]) => void): void {
  const database = new Database(join(fixture.store.root, "record.db"))
  const rows = database.query("SELECT body, digest FROM commit_log ORDER BY seq").all() as {
    body: string
    digest: Digest
  }[]
  const entries: Entry[] = rows.map((row) => ({ body: JSON.parse(row.body) as Entry["body"], digest: row.digest }))
  mutate(entries)
  database.run("DROP INDEX IF EXISTS commit_parent")
  database.run("DELETE FROM commit_log")
  const insert = database.query("INSERT INTO commit_log (seq, at, prev, digest, body) VALUES (?, ?, ?, ?, ?)")
  entries.reduce<Digest | null>((previous, entry, index) => {
    const body = rechain ? { ...entry.body, prev: previous } : entry.body
    const id = rechain ? digest(body as never) : entry.digest
    insert.run(index + 1, body.at, body.prev, id, canonical(body as never))
    return id
  }, null)
  if (rechain) {
    database.run("DELETE FROM record")
    const index = database.query(
      "INSERT INTO record (id, kind, object, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    for (const record of entries.flatMap((entry) => entry.body.records))
      index.run(recordId(record), record.kind, record.object, canonical(record as never))
  }
  database.close()
}

function find(entries: Entry[], kind: Record["kind"]): Record {
  const found = entries.flatMap((entry) => entry.body.records).find((record) => record.kind === kind)
  if (!found) throw new Error(`the fixture holds no ${kind}`)
  return found
}

/** Sets, or with `undefined` removes, the field at `path`: an attacker's edit need not respect the record's type. */
function edit(record: Record, path: readonly string[], value: unknown): void {
  const parent = path
    .slice(0, -1)
    .reduce((node, key) => node[key] as { [key: string]: unknown }, record as unknown as { [key: string]: unknown })
  const key = path.at(-1)!
  if (value === undefined) delete parent[key]
  else parent[key] = value
}

function damage(fixture: Fixture, out: string, blob: Digest, change: (bytes: Uint8Array) => Uint8Array): void {
  for (const path of [fixture.store.blobs.path(blob), join(out, "blobs", blob.slice(7))])
    writeFileSync(path, change(new Uint8Array(readFileSync(path))))
}

function bundle(out: string): { exitCode: number; checks: string[] } {
  const result = Bun.spawnSync({ cmd: [process.execPath, join(out, "verify.mjs"), out] })
  const lines = result.stdout.toString().trim().split("\n")
  return {
    exitCode: result.exitCode,
    checks: result.exitCode === 0 ? [] : lines.slice(0, -1).map((line) => line.split(" ")[0]!),
  }
}

describe("concurrent writers", () => {
  test("four processes committing at once leave one contiguous chain with no fork and no lost commit", async () => {
    const fixture = buildProject()
    const head = fixture.store.head()!.seq
    const writers = ["a", "b", "c", "d"].map((name) =>
      Bun.spawn({
        cmd: [process.execPath, fileURLToPath(new URL("./writer.ts", import.meta.url)), fixture.directory, name, "5"],
        stderr: "pipe",
      }),
    )
    const codes = await Promise.all(writers.map((writer) => writer.exited))
    expect(codes).toEqual([0, 0, 0, 0])

    const rows = fixture.store.commits()
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: head + 20 }, (_, index) => index + 1))
    expect(new Set(rows.map((row) => row.prev)).size).toBe(rows.length)
    expect(fixture.store.kind("claim")).toHaveLength(21)
    expect(verify(fixture.store).issues).toEqual([])
  })
})
