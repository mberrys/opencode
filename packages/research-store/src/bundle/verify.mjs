#!/usr/bin/env node
// Checks an exported research record with Node alone: no OpenCode, no SQLite, no model and no dependencies.
//   node verify.mjs [directory] [--json]
// It is written apart from the TypeScript packages, like the Python verifier, and is held to the same frozen vectors.
// It checks identities, the commit chain, the stored files and every quote. The cross-record contract rules (who may
// cite what, and when) are the store's own `verify`.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const BUNDLE = "research-bundle@1"
export const CHAIN = "research-commit@1"
export const PREIMAGE_FIELDS = ["projectId", "kind", "schema", "objectId", "parent", "author", "context", "body"]

// Which voices may write each kind. Kept apart from the TypeScript table on purpose, so the two can disagree visibly.
export const WRITERS = {
  source: ["program"],
  copy: ["program"],
  representation: ["program"],
  fragment: ["program"],
  claim: ["agent", "researcher"],
  evidence: ["agent", "researcher"],
  judgment: ["agent"],
  decision: ["researcher"],
  protocol: ["agent", "researcher"],
  artifact: ["program"],
  receipt: ["program"],
  snapshot: ["program"],
}

/** A refusal. `code` matches the ContractError code the TypeScript and Python implementations report. */
export class VerifyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "VerifyError"
    this.code = code
  }
}

/** RFC 8785 canonical JSON: sorted keys, ECMAScript number text, and no lone surrogates. */
export function canonical(value) {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new VerifyError("non-finite-number", `canonical JSON cannot hold ${value}`)
    return JSON.stringify(value)
  }
  if (typeof value === "string") {
    if (/\p{Cs}/u.test(value)) throw new VerifyError("lone-surrogate", "a string holds a lone surrogate")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).toSorted()
    return `{${keys.map((key) => `${canonical(key)}:${canonical(value[key])}`).join(",")}}`
  }
  throw new VerifyError("unsupported-value", `canonical JSON cannot hold ${typeof value}`)
}

export function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`
}

export function blobDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

/** Checks a revision's envelope and returns the digest of its preimage: exactly the eight fields. */
export function revisionId(revision) {
  const fields = revision !== null && typeof revision === "object" ? Object.keys(revision) : []
  const preimage = fields.filter((field) => field !== "revisionId")
  if (preimage.length !== PREIMAGE_FIELDS.length || !PREIMAGE_FIELDS.every((field) => preimage.includes(field)))
    throw new VerifyError("invalid-record", `a revision has exactly ${PREIMAGE_FIELDS.join(", ")}`)
  const writers = Object.hasOwn(WRITERS, revision.kind) ? WRITERS[revision.kind] : undefined
  if (writers === undefined) throw new VerifyError("invalid-record", `unknown kind ${JSON.stringify(revision.kind)}`)
  if (revision.schema !== `${revision.kind}@1`)
    throw new VerifyError("unsupported-schema", `unsupported schema ${JSON.stringify(revision.schema)}`)
  if (!writers.includes(revision.author?.voice))
    throw new VerifyError("invalid-author", `${revision.kind} is written by ${writers.join(" or ")}`)
  const id = digest(Object.fromEntries(PREIMAGE_FIELDS.map((field) => [field, revision[field]])))
  if ("revisionId" in revision && revision.revisionId !== id)
    throw new VerifyError("digest-mismatch", "revisionId is not the digest of the revision's preimage")
  return id
}

/** Checks a quote against the stored text byte for byte, with no normalization. */
export function verifyFragment(representationDigest, selector, bytes) {
  const shaped =
    selector !== null &&
    typeof selector === "object" &&
    Object.keys(selector).toSorted().join() === "end,profile,quote,start" &&
    selector.profile === "utf8-bytes@1" &&
    Number.isSafeInteger(selector.start) &&
    Number.isSafeInteger(selector.end) &&
    typeof selector.quote === "string"
  if (!shaped) throw new VerifyError("selector-mismatch", "a selector is utf8-bytes@1 with integer offsets and a quote")
  if (/\p{Cs}/u.test(selector.quote)) throw new VerifyError("selector-mismatch", "the quote is not well-formed text")
  if (blobDigest(bytes) !== representationDigest)
    throw new VerifyError("digest-mismatch", "the representation's bytes do not match its digest")
  const boundary = (offset) => offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80
  const start = selector.start
  const end = selector.end
  if (!(start >= 0 && start < end && end <= bytes.length) || !boundary(start) || !boundary(end))
    throw new VerifyError(
      "selector-mismatch",
      "a selector is a non-empty span inside the text, on code point boundaries",
    )
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new VerifyError("selector-mismatch", "the representation is not valid UTF-8 text")
  }
  if (!Buffer.from(bytes.subarray(start, end)).equals(Buffer.from(selector.quote, "utf8")))
    throw new VerifyError("selector-mismatch", "the quote does not equal the stored bytes")
}

/** The stored files a revision needs. */
export function blobsOf(revision) {
  const body = revision.body
  const of = (blob) => (blob === "none" ? [] : [blob.digest])
  const found = (() => {
    if (revision.kind === "source")
      return Object.values(body.fields).map((field) =>
        field.origin.by === "service" ? field.origin.response : field.origin.copy,
      )
    if (revision.kind === "copy") return [body.blob]
    if (revision.kind === "representation") return [body.blob, body.tree.digest]
    if (revision.kind === "fragment") return [body.representationDigest]
    if (revision.kind === "artifact") return [body.output.digest]
    if (revision.kind !== "receipt") return []
    const step = body.step
    if (step.kind === "tool") return [...of(step.input), ...of(step.output)]
    if (step.kind === "script")
      return [
        ...of(step.script),
        ...step.calls.flatMap((call) => [...of(call.input), ...("error" in call.output ? [] : of(call.output))]),
        ...of(step.result),
      ]
    if (step.kind === "model") return [...of(step.request), ...of(step.response)]
    return of(step.input)
  })()
  return [...new Set(found)]
}

/**
 * Checks a bundle: the manifest, the chain from the project's genesis, each revision's id, every stored file and every
 * quote. Each problem is reported at the item it concerns. `headDigest` is what an outside reader pins: removing the
 * newest commits leaves a valid chain with another head.
 */
export function verifyBundle(directory) {
  const problems = []
  const report = (problem) => problems.push(problem)
  const manifest = readJson(path.join(directory, "manifest.json"))
  if (manifest?.format !== BUNDLE || typeof manifest.projectId !== "string") {
    report({ reason: "manifest-invalid", message: `manifest.json is not a ${BUNDLE} manifest` })
    return { ok: false, headSeq: 0, headDigest: undefined, problems }
  }
  const commits = readLog(path.join(directory, "log.jsonl"), report)
  const genesis = digest({ chain: CHAIN, projectId: manifest.projectId })
  const head = commits.reduce(
    (previous, commit) => {
      checkCommit(commit, previous, report)
      return { seq: commit.seq, digest: commit.digest }
    },
    { seq: 0, digest: genesis },
  )
  const revisions = commits.flatMap((commit) =>
    commit.revisions.flatMap((revision) => {
      try {
        revisionId(revision)
        if (revision.projectId !== manifest.projectId)
          throw new VerifyError("cross-project-ref", "the revision belongs to another project")
        return [{ seq: commit.seq, revision }]
      } catch (error) {
        report({
          reason: "revision-invalid",
          seq: commit.seq,
          revisionId: revision?.revisionId,
          message: error.message,
        })
        return []
      }
    }),
  )
  const files = checkBlobs(directory, revisions, report)
  revisions.forEach((entry) => checkContent(entry, files, report))
  if (manifest.headSeq !== head.seq || manifest.headDigest !== head.digest)
    report({ reason: "head-mismatch", seq: head.seq, message: "the log does not end at the manifest's head" })
  return { ok: problems.length === 0, headSeq: head.seq, headDigest: head.digest, problems }
}

function checkCommit(commit, previous, report) {
  const at = { seq: commit.seq }
  if (commit.seq !== previous.seq + 1) report({ reason: "seq-gap", ...at })
  if (commit.prev !== previous.digest) report({ reason: "prev-mismatch", ...at })
  const ids = commit.revisions.map((revision) => revision?.revisionId)
  if (safeDigest(ids) !== commit.request) report({ reason: "request-mismatch", ...at })
  const link = { chain: CHAIN, seq: commit.seq, prev: commit.prev, key: commit.key, request: commit.request }
  if (safeDigest(link) !== commit.digest) report({ reason: "digest-mismatch", ...at })
}

/** Hashes each needed file once and keeps the quoted texts. */
function checkBlobs(directory, revisions, report) {
  const files = new Map()
  revisions.forEach((entry) =>
    blobsOf(entry.revision).forEach((wanted) => {
      if (files.has(wanted)) return
      const file = path.join(directory, "blobs", String(wanted).slice("sha256:".length))
      const bytes =
        fs.existsSync(file) && fs.statSync(file).isFile() ? new Uint8Array(fs.readFileSync(file)) : undefined
      files.set(wanted, bytes !== undefined && blobDigest(bytes) === wanted ? bytes : undefined)
      if (bytes === undefined) report({ reason: "blob-missing", seq: entry.seq, digest: wanted })
      if (bytes !== undefined && blobDigest(bytes) !== wanted)
        report({ reason: "blob-corrupt", seq: entry.seq, digest: wanted })
    }),
  )
  return files
}

function checkContent(entry, files, report) {
  const revision = entry.revision
  const at = { seq: entry.seq, revisionId: revision.revisionId }
  if (revision.kind === "copy") {
    const bytes = files.get(revision.body.blob)
    if (bytes !== undefined && bytes.length !== revision.body.size) report({ reason: "size-mismatch", ...at })
  }
  if (revision.kind !== "fragment") return
  const bytes = files.get(revision.body.representationDigest)
  if (bytes === undefined) return
  try {
    verifyFragment(revision.body.representationDigest, revision.body.selector, bytes)
  } catch (error) {
    report({ reason: "fragment-mismatch", ...at, message: error.message })
  }
}

function readLog(file, report) {
  if (!fs.existsSync(file)) {
    report({ reason: "malformed-commit", message: "log.jsonl is missing" })
    return []
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim() === "") return []
      const commit = parseJson(line)
      if (commit !== undefined && Number.isSafeInteger(commit.seq) && Array.isArray(commit.revisions)) return [commit]
      report({ reason: "malformed-commit", message: `line ${index + 1} of log.jsonl is not a commit` })
      return []
    })
}

function readJson(file) {
  return fs.existsSync(file) ? parseJson(fs.readFileSync(file, "utf8")) : undefined
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function safeDigest(value) {
  try {
    return digest(value)
  } catch {
    return undefined
  }
}

function main(argv) {
  const json = argv.includes("--json")
  const directory = argv.find((arg) => arg !== "--json") ?? path.dirname(fileURLToPath(import.meta.url))
  const result = verifyBundle(directory)
  if (json) console.log(JSON.stringify(result, null, 2))
  if (!json) {
    result.problems.forEach((problem) =>
      console.log(
        [problem.reason, problem.seq === undefined ? "" : `at commit ${problem.seq}`, problem.message ?? ""]
          .filter((part) => part !== "")
          .join(" "),
      ),
    )
    console.log(
      result.ok
        ? `${result.headSeq} commits verify; head ${result.headDigest}`
        : `${result.problems.length} problems in ${result.headSeq} commits`,
    )
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
