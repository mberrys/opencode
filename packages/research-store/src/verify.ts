export * as Verify from "./verify.js"

import type { Database } from "bun:sqlite"
import { Canonical, Fragment, Graph, ResearchRecord } from "@opencode/research-record"
import { Blobs } from "./blobs.js"
import { Chain } from "./chain.js"
import { messageOf } from "./error.js"
import { Layout } from "./layout.js"
import { Tables } from "./tables.js"

export type Reason =
  /** A commit's sequence number is not one more than the commit before it: a commit was removed or reordered. */
  | "seq-gap"
  /** A commit does not chain from the digest of the commit before it, or from the project's genesis. */
  | "prev-mismatch"
  /** A commit's digest is not the digest of its fields. */
  | "digest-mismatch"
  /** A commit's request digest is not the digest of the revision ids it lists. */
  | "request-mismatch"
  /** A commit's list of revision ids is not a list of ids. */
  | "malformed-commit"
  /** A stored revision does not parse, or its id does not match its content or its row. */
  | "revision-invalid"
  /** A commit lists a revision the record does not hold. */
  | "revision-missing"
  /** The record holds a revision no commit lists. */
  | "revision-unlisted"
  /** A revision is stored under another commit than the one that lists it. */
  | "revision-misplaced"
  /** The blob index disagrees with the blobs the commit's revisions need. */
  | "blob-refs-mismatch"
  | "blob-missing"
  | "blob-corrupt"
  /** A copy's stated size is not its blob's size. */
  | "size-mismatch"
  /** The revisions break a contract rule from this commit on. */
  | "history-invalid"
  /** A fragment's quote is not the stored text at its offsets. */
  | "fragment-mismatch"

export interface Problem {
  readonly reason: Reason
  readonly seq?: number
  readonly revisionId?: string
  readonly digest?: string
  readonly message?: string
}

/**
 * `headDigest` is what an outside reader pins: removing the newest commits cannot be seen from inside the record, but
 * it changes the head digest.
 */
export interface Verification {
  readonly ok: boolean
  readonly headSeq: number
  readonly headDigest: Canonical.Digest
  readonly problems: readonly Problem[]
}

interface RevisionRow {
  readonly revision_id: string
  readonly seq: number
  readonly object_id: string
  readonly kind: string
  readonly json: string
}

/**
 * Checks the whole record: the chain from genesis, every revision against its content and its commit, the blob index,
 * every needed blob's bytes, every contract rule, and every fragment's quote. Each problem is reported at the item it
 * concerns; a damaged commit does not blame the commits after it. Run inside one read transaction.
 */
export function run(db: Database, layout: Layout.Layout, projectId: string): Verification {
  const problems: Problem[] = []
  const report = (problem: Problem) => problems.push(problem)

  const listed = new Map<string, number>()
  const genesis = Chain.genesis(projectId)
  const head = db
    .query<Tables.CommitRow, []>("SELECT * FROM commits ORDER BY seq")
    .all()
    .reduce(
      (previous, row) => {
        if (row.seq !== previous.seq + 1) report({ reason: "seq-gap", seq: row.seq })
        if (row.prev !== previous.digest) report({ reason: "prev-mismatch", seq: row.seq })
        const ids = idsOf(row.revisions)
        if (ids === undefined) report({ reason: "malformed-commit", seq: row.seq })
        if (ids !== undefined && Chain.request(ids) !== row.request)
          report({ reason: "request-mismatch", seq: row.seq })
        const link = {
          seq: row.seq,
          prev: row.prev as Canonical.Digest,
          key: row.key,
          request: row.request as Canonical.Digest,
        }
        if (!Canonical.isDigest(row.request) || Chain.digest(link) !== row.digest)
          report({ reason: "digest-mismatch", seq: row.seq })
        ids?.forEach((id) => listed.set(id, row.seq))
        // The next row is checked against this row's stored digest, so one damaged row does not blame its successors.
        return { seq: row.seq, digest: row.digest as Canonical.Digest }
      },
      { seq: 0, digest: genesis },
    )

  const entries = db
    .query<RevisionRow, []>("SELECT * FROM revisions ORDER BY seq, rowid")
    .all()
    .flatMap((row): Graph.Entry[] => {
      const at = { seq: row.seq, revisionId: row.revision_id }
      const revision = parse(row.json)
      if (
        revision === undefined ||
        revision.revisionId !== row.revision_id ||
        revision.objectId !== row.object_id ||
        revision.kind !== row.kind
      ) {
        report({ reason: "revision-invalid", ...at })
        listed.delete(row.revision_id)
        return []
      }
      const listedAt = listed.get(row.revision_id)
      listed.delete(row.revision_id)
      if (listedAt === undefined) {
        report({ reason: "revision-unlisted", ...at })
        return []
      }
      if (listedAt !== row.seq) {
        report({ reason: "revision-misplaced", ...at })
        return []
      }
      return [{ seq: row.seq, revision }]
    })
  listed.forEach((seq, revisionId) => report({ reason: "revision-missing", seq, revisionId }))

  const needed = new Set(
    entries.flatMap((entry) => ResearchRecord.blobs(entry.revision).map((digest) => `${entry.seq} ${digest}`)),
  )
  const indexed = new Set(
    db
      .query<{ digest: string; seq: number }, []>("SELECT digest, seq FROM blob_refs")
      .all()
      .map((row) => `${row.seq} ${row.digest}`),
  )
  ;[...needed].filter((item) => !indexed.has(item)).forEach((item) => report(blobRef(item)))
  ;[...indexed].filter((item) => !needed.has(item)).forEach((item) => report(blobRef(item)))

  // Each blob is read once, and that read decides both whether it is intact and what is checked against it: a file
  // that changes or vanishes while verify runs is reported, never thrown. A quoted text is kept for its quotes; any
  // other blob is only hashed and measured.
  const quoted = new Set(
    entries.flatMap((entry) => (entry.revision.kind === "fragment" ? [entry.revision.body.representationDigest] : [])),
  )
  const texts = new Map<string, Uint8Array>()
  const sizes = new Map<string, number>()
  const seen = new Set<string>()
  entries.forEach((entry) =>
    ResearchRecord.blobs(entry.revision).forEach((digest) => {
      if (seen.has(digest)) return
      seen.add(digest)
      const damaged = (check: Blobs.Check) =>
        report({ reason: check === "missing" ? "blob-missing" : "blob-corrupt", seq: entry.seq, digest })
      if (quoted.has(digest)) {
        const text = Blobs.load(layout, digest)
        if (typeof text === "string") return damaged(text)
        texts.set(digest, text)
        sizes.set(digest, text.length)
        return
      }
      const found = Blobs.measure(Layout.blobPath(layout, digest), digest)
      if (found.check !== "valid") return damaged(found.check)
      sizes.set(digest, found.size)
    }),
  )
  entries.forEach((entry) => {
    const revision = entry.revision
    if (revision.kind !== "copy") return
    const size = sizes.get(revision.body.blob)
    if (size !== undefined && size !== revision.body.size)
      report({ reason: "size-mismatch", seq: entry.seq, revisionId: revision.revisionId })
  })

  // A quote is checked against its text even when the history breaks a rule elsewhere, so one damaged commit cannot
  // hide an edited quote. With a valid graph the fragment's representation is checked too.
  const graph = build(projectId, entries, report)
  entries.forEach((entry) => {
    const revision = entry.revision
    if (revision.kind !== "fragment") return
    const bytes = texts.get(revision.body.representationDigest)
    if (bytes === undefined) return
    try {
      Fragment.verify(
        graph === undefined
          ? {
              representationDigest: revision.body.representationDigest as Canonical.Digest,
              selector: revision.body.selector,
              bytes,
            }
          : { graph, fragment: ResearchRecord.refOf(revision), bytes },
      )
    } catch (error) {
      report({
        reason: "fragment-mismatch",
        seq: entry.seq,
        revisionId: revision.revisionId,
        message: messageOf(error),
      })
    }
  })

  return { ok: problems.length === 0, headSeq: head.seq, headDigest: head.digest, problems }
}

/**
 * The graph of the whole record, or `undefined` with the first commit at which a contract rule breaks. Rules only look
 * backwards, so a prefix that holds stays holding, and the first failing commit is found by halving.
 */
function build(projectId: string, entries: readonly Graph.Entry[], report: (problem: Problem) => void) {
  const attempt = (upTo: number) => {
    try {
      Graph.make(
        projectId,
        entries.filter((entry) => entry.seq <= upTo),
      )
      return undefined
    } catch (error) {
      return messageOf(error)
    }
  }
  try {
    return Graph.make(projectId, entries)
  } catch (error) {
    const seqs = [...new Set(entries.map((entry) => entry.seq))]
    let low = 0
    let high = seqs.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      const holds = attempt(seqs[middle]) === undefined
      if (holds) low = middle + 1
      if (!holds) high = middle
    }
    report({ reason: "history-invalid", seq: seqs[low], message: attempt(seqs[low]) ?? messageOf(error) })
    return undefined
  }
}

function idsOf(json: string) {
  try {
    const ids: unknown = JSON.parse(json)
    if (Array.isArray(ids) && ids.length > 0 && ids.every(Canonical.isDigest)) return ids
    return undefined
  } catch {
    return undefined
  }
}

function parse(json: string) {
  try {
    return ResearchRecord.parse(JSON.parse(json))
  } catch {
    return undefined
  }
}

function blobRef(item: string): Problem {
  const [seq, digest] = item.split(" ")
  return { reason: "blob-refs-mismatch", seq: Number(seq), digest }
}
