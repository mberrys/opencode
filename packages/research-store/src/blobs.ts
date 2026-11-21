export * as Blobs from "./blobs.js"

import { Canonical } from "@opencode/research-record"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { StoreError, codeOf } from "./error.js"
import { Failpoint } from "./failpoint.js"
import { Layout } from "./layout.js"

export type Check = "valid" | "corrupt" | "missing"

/** An admitted blob, and whether the same bytes were already stored. */
export interface Admitted {
  readonly digest: Canonical.Digest
  readonly existed: boolean
}

/** The two filesystem steps of admission, replaceable so tests can force the errors Windows raises. */
export interface Ops {
  /** Installs a complete file under a new name, never replacing an existing one: a hard link. */
  readonly install: (from: string, to: string) => void
  /** Hashes a file and compares it with `digest`. */
  readonly check: (file: string, digest: Canonical.Digest) => Check
}

export const defaultOps: Ops = {
  install: (from, to) => fs.linkSync(from, to),
  check: (file, digest) => check(file, digest),
}

// A staged file this old is swept even if its pid looks alive: the pid may have been reused, or belong to another
// pid namespace. An admission that loses its staged file fails at the link and can be retried.
const STALE_MS = 24 * 60 * 60 * 1000

// What a hard link raises when another admission of the same bytes got there first, or Windows holds the name open.
const RACE_CODES = ["EEXIST", "EPERM", "EBUSY"]

/**
 * Stores bytes under their digest and returns it. Runs outside any transaction: the bytes are staged, flushed and
 * checked, and only then linked to their name, so a blob name always holds complete bytes. Bytes already stored are
 * checked and reused, never overwritten. Staged files are named `<pid>-<random>.tmp` so that `sweep` can tell whose they are.
 */
export function admit(layout: Layout.Layout, bytes: Uint8Array, ops: Ops = defaultOps): Admitted {
  if (!(bytes instanceof Uint8Array)) throw new StoreError("invalid-argument", "a blob is bytes")
  const digest = Canonical.blobDigest(bytes)
  const target = Layout.blobPath(layout, digest)
  fs.mkdirSync(layout.staging, { recursive: true })
  const staged = path.join(layout.staging, `${process.pid}-${randomBytes(8).toString("hex")}.tmp`)
  try {
    stage(staged, bytes)
    if (ops.check(staged, digest) !== "valid")
      throw new StoreError("blob-corrupt", "the staged bytes do not match their digest")
    Failpoint.hit("beforeBlobInstall")
    // A reused blob may have been linked by a process killed before it flushed the name, so flush it again.
    const reused = reuse(target, digest, ops)
    if (reused) syncDirectory(path.dirname(target))
    if (!reused) place(staged, target, digest, ops)
    Failpoint.hit("afterBlobInstall")
    return { digest, existed: reused }
  } finally {
    fs.rmSync(staged, { force: true })
  }
}

/** Hashes the file at `file`. A directory or other non-file under a blob name is corrupt, not missing. */
export function check(file: string, digest: Canonical.Digest): Check {
  return measure(file, digest).check
}

/** Hashes the file at `file` and returns its size from the same read, so the two cannot disagree. */
export function measure(file: string, digest: Canonical.Digest): { readonly check: Check; readonly size: number } {
  const handle = open(file)
  if (handle === undefined) return { check: "missing", size: 0 }
  try {
    if (!fs.fstatSync(handle).isFile()) return { check: "corrupt", size: 0 }
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(128 * 1024)
    let size = 0
    for (let count = fs.readSync(handle, buffer); count > 0; count = fs.readSync(handle, buffer)) {
      hash.update(buffer.subarray(0, count))
      size += count
    }
    return { check: `sha256:${hash.digest("hex")}` === digest ? "valid" : "corrupt", size }
  } finally {
    fs.closeSync(handle)
  }
}

/** The bytes of a stored blob, re-hashed as they are read. A flipped byte is refused. */
export function read(layout: Layout.Layout, digest: string) {
  if (!Canonical.isDigest(digest)) throw new StoreError("invalid-argument", "a blob is read by its sha256 digest")
  const bytes = load(layout, digest)
  if (bytes === "missing") throw new StoreError("blob-missing", `the blob ${digest} is missing`)
  if (bytes === "corrupt") throw new StoreError("blob-corrupt", `the blob ${digest} does not match its digest`)
  return bytes
}

/** The bytes of a stored blob, checked against its digest in the one read, or why they cannot be had. */
export function load(layout: Layout.Layout, digest: Canonical.Digest): Uint8Array | Exclude<Check, "valid"> {
  const bytes = readFile(Layout.blobPath(layout, digest))
  if (typeof bytes === "string") return bytes
  return Canonical.blobDigest(bytes) === digest ? bytes : "corrupt"
}

/**
 * Removes staged files left by processes that are no longer running, or older than a day, and returns their pids.
 * A killed admission leaves its staged file behind; a live one keeps its own. Files named with this process's pid
 * follow the same rule: a container restarts under the same pid, so they may be an earlier run's.
 */
export function sweep(layout: Layout.Layout): readonly number[] {
  if (!fs.existsSync(layout.staging)) return []
  const swept = new Set<number>()
  fs.readdirSync(layout.staging).forEach((name) => {
    const pid = Number(/^(\d+)-[0-9a-f]+\.tmp$/.exec(name)?.[1])
    const file = path.join(layout.staging, name)
    if (!Number.isSafeInteger(pid)) return
    // A live admission may finish, and remove its file, between the listing and this look.
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat === undefined || (alive(pid) && Date.now() - stat.mtimeMs < STALE_MS)) return
    try {
      fs.rmSync(file, { force: true })
    } catch (error) {
      // Windows refuses to remove a file a live process still holds open; the next open tries again.
      if (["EBUSY", "EPERM"].includes(codeOf(error))) return
      throw error
    }
    swept.add(pid)
  })
  return [...swept].toSorted((a, b) => a - b)
}

function stage(file: string, bytes: Uint8Array) {
  const handle = fs.openSync(file, "wx")
  try {
    const half = bytes.length >> 1
    write(handle, bytes.subarray(0, half))
    Failpoint.hit("duringBlobStage")
    write(handle, bytes.subarray(half))
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function write(handle: number, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; ) offset += fs.writeSync(handle, bytes, offset, bytes.length - offset)
}

/** True when the blob is already there and intact. A name that holds other bytes is never overwritten. */
function reuse(target: string, digest: Canonical.Digest, ops: Ops) {
  const found = ops.check(target, digest)
  if (found === "missing") return false
  if (found === "corrupt")
    throw new StoreError("blob-corrupt", `the blob ${digest} is stored with other bytes than its digest names`)
  return true
}

function place(staged: string, target: string, digest: Canonical.Digest, ops: Ops) {
  const directory = path.dirname(target)
  const missing = missingDirectories(directory)
  fs.mkdirSync(directory, { recursive: true })
  // Each directory made now is a new entry in its parent, which must reach the disk too.
  missing.forEach((made) => syncDirectory(path.dirname(made)))
  try {
    ops.install(staged, target)
  } catch (error) {
    // Another admission of the same bytes may have installed them first. Reuse that copy only if it checks.
    if (RACE_CODES.includes(codeOf(error)) && reuse(target, digest, ops)) return syncDirectory(directory)
    // Nothing holds the name, so the link itself failed: FAT, exFAT and some network shares have no hard links, and
    // each raises its own error. The staged file is already flushed and checked, so it is renamed into place.
    if (fs.existsSync(target)) throw error
    fs.renameSync(staged, target)
  }
  // The new name holds the staged file's own data, which was flushed and checked before it was installed, so only the
  // name needs flushing; reading the bytes back would hash the same data again.
  syncDirectory(directory)
}

/** The directories from the topmost one that does not exist down to `directory`, in creation order. */
function missingDirectories(directory: string) {
  const missing: string[] = []
  for (let current = directory; !fs.existsSync(current); current = path.dirname(current)) {
    if (path.dirname(current) === current) break
    missing.unshift(current)
  }
  return missing
}

/** Windows opens a directory for flushing only with write access, other platforms only with read access. */
function syncDirectory(directory: string) {
  const handle = fs.openSync(directory, process.platform === "win32" ? "r+" : "r")
  try {
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function open(file: string) {
  try {
    return fs.openSync(file, "r")
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined
    throw error
  }
}

function readFile(file: string): Uint8Array | Exclude<Check, "valid"> {
  try {
    return new Uint8Array(fs.readFileSync(file))
  } catch (error) {
    if (codeOf(error) === "ENOENT") return "missing"
    // A directory under a blob name is damage, as `check` reports it.
    if (codeOf(error) === "EISDIR") return "corrupt"
    throw error
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) === "EPERM"
  }
}
