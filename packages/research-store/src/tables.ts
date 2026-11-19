export * as Tables from "./tables.js"

import { Database } from "bun:sqlite"
import fs from "node:fs"
import { StoreError, codeOf } from "./error.js"

export const SCHEMA_VERSION = 1

export interface CommitRow {
  readonly seq: number
  readonly prev: string
  readonly digest: string
  readonly key: string | null
  readonly request: string
  readonly revisions: string
}

/**
 * `commits` is the chain: each row's digest covers its sequence, the previous digest, its idempotency key and the
 * digest of its ordered revision ids. `revisions` holds each revision's canonical JSON. `blob_refs` is an index derived
 * from the revisions, which verify recomputes; it is not chained.
 */
const SCHEMA = [
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  `CREATE TABLE commits (
    seq INTEGER PRIMARY KEY,
    prev TEXT NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    key TEXT UNIQUE,
    request TEXT NOT NULL,
    revisions TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX commits_request ON commits(request)",
  `CREATE TABLE revisions (
    revision_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    object_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    json TEXT NOT NULL
  ) STRICT`,
  "CREATE INDEX revisions_object ON revisions(object_id, seq)",
  `CREATE TABLE blob_refs (
    digest TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (digest, seq)
  ) STRICT`,
]

/**
 * Opens the one connection a writing process uses, creating the record when it is new. An existing record is checked
 * with a read, so opening never queues behind a long commit; a new one creates its schema inside an immediate
 * transaction, so processes opening it at once agree on one schema.
 */
export function openWriter(file: string, projectId: string, busyTimeoutMs: number) {
  const deadline = Date.now() + busyTimeoutMs
  const db = new Database(file, { create: true, strict: true })
  try {
    db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    // SQLite does not wait out a lock when switching the journal mode, so several processes opening a new record at
    // once retry it until the deadline.
    retry(() => db.run("PRAGMA journal_mode = WAL"), deadline)
    db.run("PRAGMA synchronous = FULL")
    if (retry(() => hasMeta(db), deadline)) {
      assertMatches(db, projectId)
      return db
    }
    retry(
      () =>
        db
          .transaction(() => {
            if (hasMeta(db)) return assertMatches(db, projectId)
            SCHEMA.forEach((statement) => db.run(statement))
            db.query("INSERT INTO meta(key, value) VALUES (?, ?), (?, ?)").run(
              "schema_version",
              String(SCHEMA_VERSION),
              "project_id",
              projectId,
            )
          })
          .immediate(),
      deadline,
    )
    return db
  } catch (error) {
    db.close()
    throw notARecord(error, file)
  }
}

/**
 * Opens a record for reading only: nothing is swept, no schema is created and no write lock is taken. SQLite still
 * creates the `-wal` and `-shm` files beside a WAL database it reads.
 */
export function openReader(file: string, busyTimeoutMs: number) {
  if (!fs.existsSync(file)) throw new StoreError("store-mismatch", `${file} does not exist`)
  const db = new Database(file, { readonly: true, strict: true })
  try {
    db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    if (!hasMeta(db)) throw new StoreError("store-mismatch", `${file} is not a research record`)
    const projectId = meta(db, "project_id")
    if (projectId === undefined) throw new StoreError("store-mismatch", `${file} names no project`)
    assertSchema(db)
    return { db, projectId }
  } catch (error) {
    db.close()
    throw notARecord(error, file)
  }
}

export function meta(db: Database, key: string) {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
  return row?.value
}

/** Runs `run`, turning SQLite's lock timeout into a typed refusal. */
export function busy<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (isBusy(error)) throw new StoreError("writer-busy", "another writer held the record past the busy timeout")
    throw error
  }
}

/** Runs `run` again while SQLite reports a lock, until the deadline; then refuses with `writer-busy`. */
function retry<T>(run: () => T, deadline: number): T {
  for (;;) {
    try {
      return run()
    } catch (error) {
      if (!isBusy(error)) throw error
      if (Date.now() >= deadline)
        throw new StoreError("writer-busy", "another process held the record past the busy timeout")
      Bun.sleepSync(5)
    }
  }
}

function isBusy(error: unknown) {
  const code = codeOf(error)
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")
}

function notARecord(error: unknown, file: string) {
  if (codeOf(error).startsWith("SQLITE_NOTADB")) return new StoreError("store-mismatch", `${file} is not a database`)
  return error
}

function hasMeta(db: Database) {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== null
}

function assertMatches(db: Database, projectId: string) {
  const stored = meta(db, "project_id")
  if (stored !== projectId)
    throw new StoreError("store-mismatch", `the record belongs to project ${stored ?? "none"}, not ${projectId}`)
  assertSchema(db)
}

function assertSchema(db: Database) {
  const version = Number(meta(db, "schema_version"))
  if (version !== SCHEMA_VERSION)
    throw new StoreError("unsupported-schema", `the record has schema ${version}; this build reads ${SCHEMA_VERSION}`)
}
