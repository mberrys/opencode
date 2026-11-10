import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  type Digest,
  type Kind,
  type Record,
  type Ref,
  type ShownSet,
  assertRecord,
  canonical,
  deriveShownSet,
  digest,
  isDigest,
  recordId,
} from "@opencode/research-record"
import { Blobs } from "./blob.js"

export interface CommitBody {
  readonly seq: number
  readonly at: string
  readonly prev: Digest | null
  readonly records: readonly Record[]
}

export interface CommitRow {
  readonly seq: number
  readonly at: string
  readonly prev: Digest | null
  readonly digest: Digest
  readonly body: string
}

export interface CommitResult {
  readonly seq: number
  readonly digest: Digest
  readonly ids: readonly Digest[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commit_log (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  prev TEXT,
  digest TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  object TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS record_kind ON record (kind);
-- One commit per predecessor: a second child of the same commit is a fork, not a history.
CREATE UNIQUE INDEX IF NOT EXISTS commit_parent ON commit_log (prev);
`

/**
 * The record store for one project: a hash chained commit log, its records, and the files they point at.
 * It lives apart from OpenCode's session database so that a reader can check it with this package alone.
 */
export class Store {
  /** The `.research` directory this store owns. */
  readonly root: string
  readonly blobs: Blobs
  private readonly database: Database

  private constructor(root: string) {
    this.root = root
    this.blobs = new Blobs(root)
    this.database = new Database(join(root, "record.db"))
    this.database.query("PRAGMA journal_mode = WAL").get()
    this.database.run("PRAGMA synchronous = FULL")
    this.database.run("PRAGMA busy_timeout = 5000")
    this.database.run(SCHEMA)
  }

  static open(project: string): Store {
    const root = join(project, ".research")
    mkdirSync(root, { recursive: true })
    return new Store(root)
  }

  static at(root: string): Store {
    mkdirSync(root, { recursive: true })
    return new Store(root)
  }

  close(): void {
    this.database.close()
  }

  head(): { seq: number; digest: Digest } | undefined {
    const row = this.database.query("SELECT seq, digest FROM commit_log ORDER BY seq DESC LIMIT 1").get() as {
      seq: number
      digest: Digest
    } | null
    return row ?? undefined
  }

  /** One transaction per commit, so a crash leaves either the whole commit or none of it. */
  commit(records: readonly Record[], options: { readonly at?: string } = {}): CommitResult {
    if (records.length === 0) throw new Error("a commit needs at least one record")
    for (const record of records) assertRecord(record)
    const at = options.at ?? new Date().toISOString()
    // An immediate transaction takes the write lock up front, so a second writer waits out busy_timeout instead
    // of failing the moment a deferred transaction tries to upgrade its read snapshot. The transaction wrapper
    // also rolls back when the COMMIT itself fails, so the connection is never left inside a transaction.
    return this.database
      .transaction((): CommitResult => {
        const previous = this.head()
        const seq = previous ? previous.seq + 1 : 1
        const body: CommitBody = { seq, at, prev: previous?.digest ?? null, records }
        const commitDigest = digest(body as never)
        const ids = records.map(recordId)
        const insertRecord = this.database.query(
          "INSERT INTO record (id, kind, object, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        for (const [index, record] of records.entries()) {
          const json = canonical(record as never)
          insertRecord.run(ids[index]!, record.kind, record.object, json)
          const stored = this.database.query("SELECT body FROM record WHERE id = ?").get(ids[index]!) as {
            body: string
          } | null
          if (stored?.body !== json) throw new Error(`record ${ids[index]} is already stored with other content`)
        }
        this.database
          .query("INSERT INTO commit_log (seq, at, prev, digest, body) VALUES (?, ?, ?, ?, ?)")
          .run(seq, at, body.prev, commitDigest, canonical(body as never))
        return { seq, digest: commitDigest, ids }
      })
      .immediate()
  }

  commits(): CommitRow[] {
    return this.database.query("SELECT seq, at, prev, digest, body FROM commit_log ORDER BY seq").all() as CommitRow[]
  }

  /** Every record, in commit order. */
  all(): Record[] {
    const rows = this.database.query("SELECT body FROM record ORDER BY rowid").all() as { body: string }[]
    return rows.map((row) => parse(row.body))
  }

  kind<K extends Kind>(kind: K): Extract<Record, { kind: K }>[] {
    const rows = this.database.query("SELECT body FROM record WHERE kind = ? ORDER BY rowid").all(kind) as {
      body: string
    }[]
    return rows.map((row) => parse(row.body) as Extract<Record, { kind: K }>)
  }

  has(ref: Ref): boolean {
    return this.database.query("SELECT 1 FROM record WHERE id = ? AND kind = ?").get(ref.id, ref.kind) !== null
  }

  get(ref: Ref): Record {
    const found = this.find(ref)
    if (!found) throw new Error(`no ${ref.kind} with id ${ref.id}`)
    return found
  }

  find(ref: Ref): Record | undefined {
    if (!isDigest(ref.id)) throw new Error(`not a digest: ${ref.id}`)
    const row = this.database.query("SELECT body FROM record WHERE id = ? AND kind = ?").get(ref.id, ref.kind) as {
      body: string
    } | null
    if (!row) return undefined
    const record = parse(row.body)
    if (recordId(record) !== ref.id) throw new Error(`${ref.kind} ${ref.id} does not hash to its id`)
    return record
  }

  /**
   * Resolves `kind:digest` or `kind:hexprefix`. A prefix that matches more than one record is refused rather
   * than guessed, and nothing resolves `latest`.
   */
  resolve(value: string): Ref {
    const separator = value.indexOf(":")
    if (separator < 0) throw new Error(`a ref looks like claim:sha256:... , not ${value}`)
    const kind = value.slice(0, separator) as Kind
    const rest = value.slice(separator + 1)
    const prefix = rest.startsWith("sha256:") ? rest.slice("sha256:".length) : rest
    if (!/^[0-9a-f]{6,64}$/.test(prefix)) throw new Error(`a ref id is 6 or more lowercase hex digits, not ${rest}`)
    const rows = this.database
      .query("SELECT id FROM record WHERE kind = ? AND substr(id, 8) LIKE ? || '%' LIMIT 2")
      .all(kind, prefix) as { id: Digest }[]
    if (rows.length === 0) throw new Error(`no ${kind} matches ${prefix}`)
    if (rows.length > 1) throw new Error(`${prefix} matches more than one ${kind}; give more of the id`)
    return { kind, id: rows[0]!.id }
  }

  /** The passages a session was shown, derived from its recorded model calls rather than tracked beside them. */
  shownSet(session: string): ShownSet {
    const calls = this.kind("artifact")
      .filter((artifact) => artifact.body.type === "model-call" && artifact.session === session)
      .flatMap((artifact) => (artifact.body.type === "model-call" ? [{ contents: artifact.body.contents }] : []))
    return deriveShownSet({ calls, read: (blob) => (this.blobs.has(blob) ? this.blobs.text(blob) : undefined) })
  }

  text(blob: Digest): string {
    return this.blobs.text(blob)
  }

  bytes(blob: Digest): Uint8Array {
    return this.blobs.get(blob)
  }

  put(bytes: Uint8Array): Digest {
    return this.blobs.put(bytes)
  }
}

function parse(body: string): Record {
  const value: unknown = JSON.parse(body)
  assertRecord(value)
  return value
}
