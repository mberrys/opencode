export * as Store from "./store.js"

import type { Database } from "bun:sqlite"
import { Canonical, Fragment, Graph, Ref, ResearchRecord } from "@opencode/research-record"
import fs from "node:fs"
import { Blobs } from "./blobs.js"
import { Bundle } from "./bundle.js"
import { Chain } from "./chain.js"
import { StoreError, messageOf } from "./error.js"
import { Failpoint } from "./failpoint.js"
import { Layout } from "./layout.js"
import { Tables } from "./tables.js"
import { Verify } from "./verify.js"

export interface Head {
  readonly seq: number
  readonly digest: Canonical.Digest
}

/**
 * A commit as the store keeps it. `replayed` says the revisions had already committed together, and nothing was
 * written; `revisions` then lists the request's own, which may be some of that commit's in any order.
 */
export interface Committed extends Head {
  readonly revisions: readonly Ref.Exact[]
  readonly replayed: boolean
}

export interface CommitRequest {
  /**
   * Optional: names the request, such as the tool call that made it. A retry of revisions already committed together
   * returns that commit, with or without a key, whatever their order and even if it sends only some of them. New
   * revisions under a key already used are refused with
   * `idempotency-conflict`, whose detail names the commit the key made: a retry that rebuilt its revisions, with new
   * timestamps say, learns that its call already landed.
   */
  readonly key?: string
  /** Revisions with their ids, written together or not at all. */
  readonly revisions: readonly unknown[]
}

export interface Copy {
  readonly copy: Ref.Exact
  readonly source: Ref.Exact
}

/** What a reader can do. Nothing reads "latest" except `latest`, which names its object and returns an exact revision. */
export interface Reader {
  readonly projectId: string
  readonly layout: Layout.Layout
  /** The last commit, or `undefined` for an empty record. */
  head(): Head | undefined
  /** Any revision the record holds, old ones included. */
  get(ref: Ref.Exact): ResearchRecord.Revision
  /** The newest revision of an object, or `undefined` when there is none. */
  latest(objectId: string): ResearchRecord.Revision | undefined
  graph(): Graph.Graph
  /** A stored file that some commit references, re-hashed as it is read. */
  readBlob(digest: Canonical.Digest): Uint8Array
  /** The copy objects whose newest revision holds these bytes, with their sources. */
  copiesOf(digest: Canonical.Digest): readonly Copy[]
  verify(): Verify.Verification
  /** Writes the record to a new directory as plain files that `node verify.mjs` checks without OpenCode. */
  exportTo(directory: string): Bundle.Exported
  close(): void
}

export interface Store extends Reader {
  /** The pids of dead processes whose staged files were swept when the record was opened. */
  readonly swept: readonly number[]
  /** Stores bytes under their digest. Identical bytes are stored once. */
  admit(bytes: Uint8Array): Blobs.Admitted
  commit(request: CommitRequest): Committed
}

export interface Options {
  readonly projectId: string
  /** How long a commit waits for another writer before it is refused with `writer-busy`. */
  readonly busyTimeoutMs?: number
}

const BUSY_TIMEOUT_MS = 2_000
const MAX_KEY_LENGTH = 256

/** Opens the record in `<directory>/.research/` for writing, creating it when it is new. */
export function open(directory: string, options: Options): Store {
  if (!validProjectId(options.projectId))
    throw new StoreError("invalid-argument", "a project id is a non-blank string of at most 256 characters")
  const layout = Layout.of(directory)
  fs.mkdirSync(layout.root, { recursive: true })
  const swept = Blobs.sweep(layout)
  const db = Tables.openWriter(layout.database, options.projectId, options.busyTimeoutMs ?? BUSY_TIMEOUT_MS)
  const opened = read(db, layout, options.projectId)
  return {
    ...opened.reader,
    swept,
    admit: (bytes) => {
      opened.assertOpen()
      return Blobs.admit(layout, bytes)
    },
    commit: (request) => {
      opened.assertOpen()
      return commit(db, layout, opened.cache, options.projectId, request)
    },
  }
}

/** Opens a record for reading only, as `verify` does: no schema is created, nothing is swept, no write lock is taken. */
export function openReadOnly(directory: string, options: { readonly busyTimeoutMs?: number } = {}): Reader {
  const layout = Layout.of(directory)
  const opened = Tables.openReader(layout.database, options.busyTimeoutMs ?? BUSY_TIMEOUT_MS)
  return read(opened.db, layout, opened.projectId).reader
}

/** Every revision the record holds, parsed once and kept until another writer moves the head. */
interface Cache {
  head: Head | undefined
  graph: Graph.Graph | undefined
}

function read(db: Database, layout: Layout.Layout, projectId: string) {
  const cache: Cache = { head: undefined, graph: undefined }
  let closed = false
  const assertOpen = () => {
    if (closed) throw new StoreError("store-closed", "the record is closed")
  }
  const current = () => {
    assertOpen()
    return db.transaction(() => refresh(db, projectId, cache).graph).deferred()
  }
  const reader: Reader = {
    projectId,
    layout,
    head: () => {
      assertOpen()
      return headOf(db)
    },
    get: (ref) => {
      assertOpen()
      const exact = Ref.parse(ref, projectId)
      const row = db
        .query<
          { json: string; object_id: string },
          [string]
        >("SELECT json, object_id FROM revisions WHERE revision_id = ?")
        .get(exact.revisionId)
      if (row === null || row.object_id !== exact.objectId)
        throw new StoreError("unknown-revision", `${Ref.key(exact)} is not in the record`)
      return stored(row.json)
    },
    latest: (objectId) => {
      assertOpen()
      const row = db
        .query<{ json: string }, [string]>("SELECT json FROM revisions WHERE object_id = ? ORDER BY seq DESC LIMIT 1")
        .get(objectId)
      return row === null ? undefined : stored(row.json)
    },
    graph: () => current(),
    readBlob: (digest) => {
      assertOpen()
      if (!Canonical.isDigest(digest)) throw new StoreError("invalid-argument", "a blob is read by its sha256 digest")
      if (db.query("SELECT 1 FROM blob_refs WHERE digest = ? LIMIT 1").get(digest) === null)
        throw new StoreError("blob-unreferenced", `no commit references the blob ${digest}`)
      return Blobs.read(layout, digest)
    },
    copiesOf: (digest) => {
      const graph = current()
      return graph
        .heads(graph.lastSeq)
        .flatMap((entry) =>
          entry.revision.kind === "copy" && entry.revision.body.blob === digest
            ? [{ copy: ResearchRecord.refOf(entry.revision), source: entry.revision.body.source }]
            : [],
        )
    },
    verify: () => {
      assertOpen()
      return db.transaction(() => Verify.run(db, layout, projectId)).deferred()
    },
    exportTo: (directory) => {
      assertOpen()
      return db.transaction(() => Bundle.write(db, layout, projectId, directory)).deferred()
    },
    close: () => {
      if (closed) return
      closed = true
      db.close()
    },
  }
  return { reader, cache, assertOpen }
}

function commit(
  db: Database,
  layout: Layout.Layout,
  cache: Cache,
  projectId: string,
  request: CommitRequest,
): Committed {
  const key = parseKey(request.key)
  if (!Array.isArray(request.revisions) || request.revisions.length === 0)
    throw new StoreError("invalid-argument", "a commit writes at least one revision")
  const revisions = request.revisions.map((input) => {
    const revision = ResearchRecord.parse(input)
    Ref.parse(ResearchRecord.refOf(revision), projectId)
    return revision
  })
  const refs = revisions.map(ResearchRecord.refOf)
  const ids = revisions.map((revision) => revision.revisionId)
  const digestOfRequest = Chain.request(ids)
  const required = [...new Set(revisions.flatMap(ResearchRecord.blobs))].toSorted() as Canonical.Digest[]
  // Hashing happens before the write lock, so a large file never holds it. Nothing deletes blobs, so inside the
  // lock it is enough that each is still there. A quoted text is read once, and that read is its check.
  const quoted = new Set(
    revisions.flatMap((revision) => (revision.kind === "fragment" ? [revision.body.representationDigest] : [])),
  )
  const texts = new Map<string, Uint8Array>(
    required.filter((digest) => quoted.has(digest)).map((digest) => [digest, Blobs.read(layout, digest)] as const),
  )
  const sizes = new Map<string, number>(
    required
      .filter((digest) => !quoted.has(digest))
      .map((digest) => {
        const found = Blobs.measure(Layout.blobPath(layout, digest), digest)
        if (found.check === "missing") throw new StoreError("blob-missing", `the blob ${digest} has not been admitted`)
        if (found.check === "corrupt")
          throw new StoreError("blob-corrupt", `the blob ${digest} does not match its digest`)
        return [digest, found.size] as const
      }),
  )
  // A copy states its file's size, and verify would fail forever on one that is wrong.
  revisions.forEach((revision) => {
    if (revision.kind !== "copy") return
    const size = sizes.get(revision.body.blob) ?? texts.get(revision.body.blob)?.length
    if (size !== revision.body.size)
      throw new StoreError("size-mismatch", `the copy says ${revision.body.size} bytes; its blob has ${size}`)
  })
  // A quote one byte off its stored text never enters the record. The graph checks, under the lock, that the digest
  // quoted against is the representation's.
  revisions.forEach((revision) => {
    if (revision.kind !== "fragment") return
    const digest = revision.body.representationDigest
    const bytes = texts.get(digest)
    if (bytes === undefined) return
    Fragment.verify({ representationDigest: digest as Canonical.Digest, selector: revision.body.selector, bytes })
  })

  const outcome = Tables.busy(() =>
    db
      .transaction((): { committed: Committed; graph?: Graph.Graph } => {
        const replay = replayOf(db, key, ids, refs)
        if (replay !== undefined) return { committed: replay }
        const current = refresh(db, projectId, cache)
        const head = current.head
        const seq = (head?.seq ?? 0) + 1
        required.forEach((digest) => {
          if (!fs.existsSync(Layout.blobPath(layout, digest)))
            throw new StoreError("blob-missing", `the blob ${digest} disappeared before the commit`)
        })
        const added = revisions.map((revision) => ({ seq, revision }))
        const next = Graph.make(projectId, [...current.graph.entries, ...added])
        const insertRevision = db.query(
          "INSERT INTO revisions(revision_id, seq, object_id, kind, json) VALUES (?, ?, ?, ?, ?)",
        )
        revisions.forEach((revision) =>
          insertRevision.run(revision.revisionId, seq, revision.objectId, revision.kind, Canonical.json(revision)),
        )
        const insertRef = db.query("INSERT INTO blob_refs(digest, seq) VALUES (?, ?)")
        required.forEach((digest) => insertRef.run(digest, seq))
        const prev = head?.digest ?? Chain.genesis(projectId)
        const digest = Chain.digest({ seq, prev, key, request: digestOfRequest })
        db.query("INSERT INTO commits(seq, prev, digest, key, request, revisions) VALUES (?, ?, ?, ?, ?, ?)").run(
          seq,
          prev,
          digest,
          key,
          digestOfRequest,
          Canonical.json(ids),
        )
        Failpoint.hit("beforeDbCommit")
        return { committed: { seq, digest, revisions: refs, replayed: false }, graph: next }
      })
      .immediate(),
  )
  Failpoint.hit("afterDbCommit")
  // The cache moves only once the commit is durable.
  if (outcome.graph !== undefined) {
    cache.head = { seq: outcome.committed.seq, digest: outcome.committed.digest }
    cache.graph = outcome.graph
  }
  return outcome.committed
}

/**
 * The earlier commit that holds all of these revisions, if there is one: identical revisions can never legitimately
 * commit twice, so a retry finds its commit by the revisions themselves, whatever key it carries, in whatever order
 * and however many of them it resends. Revisions spread over several commits, or only partly committed, are not a
 * retry, and the contract refuses them. New revisions under a used key are refused.
 */
function replayOf(db: Database, key: string | null, ids: readonly string[], refs: readonly Ref.Exact[]) {
  const seqOf = db.query<{ seq: number }, [string]>("SELECT seq FROM revisions WHERE revision_id = ?")
  const seqs = new Set(ids.map((id) => seqOf.get(id)?.seq))
  const seq = seqs.size === 1 ? [...seqs][0] : undefined
  const found =
    seq === undefined ? null : db.query<Tables.CommitRow, [number]>("SELECT * FROM commits WHERE seq = ?").get(seq)
  if (found !== null)
    return { seq: found.seq, digest: found.digest as Canonical.Digest, revisions: refs, replayed: true }
  const byKey =
    key === null ? null : db.query<Tables.CommitRow, [string]>("SELECT * FROM commits WHERE key = ?").get(key)
  if (byKey !== null)
    throw new StoreError("idempotency-conflict", `the key ${key} already committed other revisions`, {
      seq: byKey.seq,
    })
  return undefined
}

/** Reloads the parsed revisions when another writer has moved the head since they were read. */
function refresh(db: Database, projectId: string, cache: Cache): { graph: Graph.Graph; head: Head | undefined } {
  const head = headOf(db)
  if (cache.graph !== undefined && cache.head?.seq === head?.seq && cache.head?.digest === head?.digest)
    return { graph: cache.graph, head }
  const entries = db
    .query<{ seq: number; json: string }, []>("SELECT seq, json FROM revisions ORDER BY seq, rowid")
    .all()
    .map((row) => ({ seq: row.seq, revision: stored(row.json) }))
  const graph = (() => {
    try {
      return Graph.make(projectId, entries)
    } catch (error) {
      throw new StoreError("store-corrupt", `the stored revisions break the contract; run verify: ${messageOf(error)}`)
    }
  })()
  cache.head = head
  cache.graph = graph
  return { graph, head }
}

/** A stored revision. One that no longer parses is damage to the record, never the caller's fault. */
function stored(json: string) {
  try {
    return ResearchRecord.parse(JSON.parse(json))
  } catch (error) {
    throw new StoreError("store-corrupt", `a stored revision does not parse; run verify: ${messageOf(error)}`)
  }
}

function headOf(db: Database): Head | undefined {
  const row = db
    .query<{ seq: number; digest: string }, []>("SELECT seq, digest FROM commits ORDER BY seq DESC LIMIT 1")
    .get()
  return row === null ? undefined : { seq: row.seq, digest: row.digest as Canonical.Digest }
}

function parseKey(key: unknown) {
  if (key === undefined) return null
  if (typeof key !== "string" || key.trim() === "" || key.length > MAX_KEY_LENGTH || !key.isWellFormed())
    throw new StoreError("invalid-argument", `a key is a non-blank string of at most ${MAX_KEY_LENGTH} characters`)
  return key
}

function validProjectId(projectId: unknown) {
  try {
    Ref.parse({ projectId, objectId: "project", revisionId: "project" })
    return true
  } catch {
    return false
  }
}
