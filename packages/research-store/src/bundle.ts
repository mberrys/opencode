export * as Bundle from "./bundle.js"

import type { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { Canonical } from "@opencode/research-record"
import { StoreError } from "./error.js"
import { Layout } from "./layout.js"
import { Tables } from "./tables.js"
import { Verify } from "./verify.js"

export const FORMAT = "research-bundle@1"

/** What `export` wrote. `verified` is the store's own verify of the record it exported. */
export interface Exported {
  readonly directory: string
  readonly headSeq: number
  readonly headDigest: Canonical.Digest
  readonly commits: number
  readonly blobs: number
  readonly verified: Verify.Verification
}

const README = `This directory is an exported research record.

Check it with Node alone, with no OpenCode, SQLite, model or dependencies:

  node verify.mjs

log.jsonl holds one commit per line. Each commit names the commit before it by digest, back to a genesis bound to the
project, and lists its revisions in full. Each revision's id is the digest of its content.
blobs/ holds every file the revisions cite, named by the SHA-256 of its bytes. A fragment quotes a byte range of one of
those files, and verify.mjs checks the quote against the bytes.
manifest.json names the head commit. A reader who pins its digest can tell if commits were later removed.
`

/**
 * Writes the record as plain files a reader can check without OpenCode: the commit log as JSON lines, every file the
 * revisions cite, a manifest naming the head, and `verify.mjs`. Damage is exported as it is, so the reader's verifier
 * reports it; a missing file is left out. Runs inside one read transaction, so the log, the files and the head agree.
 */
export function write(db: Database, layout: Layout.Layout, projectId: string, directory: string): Exported {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0)
    throw new StoreError("invalid-argument", `${directory} is not empty; a bundle is written to a new directory`)
  fs.mkdirSync(path.join(directory, "blobs"), { recursive: true })
  const commits = db.query<Tables.CommitRow, []>("SELECT * FROM commits ORDER BY seq").all()
  const revisions = db.query<{ seq: number; json: string }, []>("SELECT seq, json FROM revisions ORDER BY seq, rowid")
  const bySeq = Map.groupBy(revisions.all(), (row) => row.seq)
  const lines = commits.map((commit) =>
    JSON.stringify({
      seq: commit.seq,
      prev: commit.prev,
      digest: commit.digest,
      key: commit.key,
      request: commit.request,
      // The commit's own order, so a reader recomputes `request` from what it reads.
      revisions: order(commit.revisions, bySeq.get(commit.seq) ?? []),
    }),
  )
  fs.writeFileSync(path.join(directory, "log.jsonl"), lines.map((line) => `${line}\n`).join(""))
  const digests = db.query<{ digest: string }, []>("SELECT DISTINCT digest FROM blob_refs ORDER BY digest").all()
  const copied = digests.filter((row) => {
    const from = Layout.blobPath(layout, row.digest)
    if (!fs.existsSync(from)) return false
    fs.copyFileSync(from, path.join(directory, "blobs", row.digest.slice("sha256:".length)))
    return true
  })
  fs.copyFileSync(new URL("./bundle/verify.mjs", import.meta.url), path.join(directory, "verify.mjs"))
  fs.writeFileSync(path.join(directory, "README.txt"), README)
  const last = commits.at(-1)
  const headSeq = last?.seq ?? 0
  const headDigest = (last?.digest ?? Canonical.digest({ chain: "research-commit@1", projectId })) as Canonical.Digest
  const manifest = { format: FORMAT, contract: "research-record@1", projectId, headSeq, headDigest }
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    directory,
    headSeq,
    headDigest,
    commits: commits.length,
    blobs: copied.length,
    verified: Verify.run(db, layout, projectId),
  }
}

/** The stored revisions in the order the commit lists them; any it does not list follow, so nothing is dropped. */
function order(listed: string, rows: readonly { json: string }[]) {
  const revisions = rows.map((row) => parse(row.json))
  const ids = parseIds(listed)
  const position = (revision: unknown) => {
    const index = ids.indexOf(idOf(revision))
    return index === -1 ? ids.length : index
  }
  return revisions.toSorted((a, b) => position(a) - position(b))
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

function parseIds(json: string): readonly unknown[] {
  const ids = parse(json)
  return Array.isArray(ids) ? ids : []
}

function idOf(revision: unknown) {
  return Canonical.isPlainObject(revision) ? revision.revisionId : undefined
}
