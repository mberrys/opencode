#!/usr/bin/env node
// Checks a research record bundle with no dependencies, no model and no OpenCode.
// Usage: node verify.mjs [directory]
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const directory = process.argv[2] ?? "."
const issues = []
const fail = (check, target, detail) => issues.push({ check, target, detail })
const short = (value) => (value.startsWith("sha256:") ? value.slice(7, 19) : value)

function canonical(value) {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot hold " + value)
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
    return "{" + entries.join(",") + "}"
  }
  throw new Error("canonical JSON cannot hold " + typeof value)
}

function digestOf(value) {
  return "sha256:" + createHash("sha256").update(canonical(value), "utf8").digest("hex")
}

const blobs = new Map()
function blob(digest) {
  if (blobs.has(digest)) return blobs.get(digest)
  const path = join(directory, "blobs", digest.slice("sha256:".length))
  if (!existsSync(path)) {
    fail("blob", short(digest), "a referenced file is missing")
    blobs.set(digest, undefined)
    return undefined
  }
  const bytes = readFileSync(path)
  const actual = "sha256:" + createHash("sha256").update(bytes).digest("hex")
  if (actual !== digest) fail("blob", short(digest), "the file's bytes hash to " + short(actual))
  blobs.set(digest, bytes)
  return bytes
}

function text(digest) {
  const bytes = blob(digest)
  return bytes === undefined ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

const records = []
const ids = new Set()
let previous = null
let commits = 0

const logPath = join(directory, "log.jsonl")
if (!existsSync(logPath)) fail("log.chain", "log.jsonl", "the bundle has no log")
else {
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean)
  commits = lines.length
  lines.forEach((line, index) => {
    let row
    try {
      row = JSON.parse(line)
    } catch (error) {
      fail("log.chain", "commit " + (index + 1), "unreadable commit")
      return
    }
    if (row.seq !== index + 1) fail("log.seq", "commit " + row.seq, "expected sequence " + (index + 1))
    const body = { seq: row.seq, at: row.at, prev: row.prev, records: row.records }
    if (row.prev !== previous)
      fail("log.chain", "commit " + row.seq, "prev is " + String(row.prev) + ", not " + String(previous))
    if (digestOf(body) !== row.digest) fail("log.chain", "commit " + row.seq, "the commit does not hash to its digest")
    previous = row.digest
    for (const record of row.records ?? []) records.push(record)
  })
}

const seenIds = new Map()
for (const record of records) {
  const id = digestOf(record)
  const canonical = canonicalOf(record)
  const already = seenIds.get(id)
  if (already !== undefined && already !== canonical) fail("record.id", short(id), "two records share one id with different content")
  seenIds.set(id, canonical)
  ids.add(id)
}

const byId = new Map(records.map((record) => [digestOf(record), record]))

function refsOf(record) {
  if (record.kind === "copy") return [record.body.source]
  if (record.kind === "representation") return [record.body.copy]
  if (record.kind === "fragment") return [record.body.representation]
  if (record.kind === "evidence")
    return [record.body.claim, record.body.target.kind === "fragment" ? record.body.target.fragment : record.body.target.artifact]
  if (record.kind === "judgment") return record.body.fragment ? [record.body.target, record.body.fragment] : [record.body.target]
  if (record.kind === "decision") return [record.body.target]
  if (record.kind === "artifact") {
    if (record.body.type === "answer")
      return [...(record.body.inputs ?? []), ...(record.body.sentences ?? []).flatMap((sentence) => (sentence.claim ? [sentence.claim] : []))]
    return [...(record.body.inputs ?? [])]
  }
  if (record.kind === "receipt") {
    const operation = record.body.operation ?? {}
    const call = operation.kind === "model" ? [operation.call] : operation.kind === "script" ? [operation.artifact] : []
    return [...(record.body.records ?? []), ...call]
  }
  if (record.kind === "snapshot")
    return [record.body.artifact, ...(record.body.claims ?? []), ...(record.body.evidence ?? []), ...(record.body.sources ?? [])]
  return []
}

function canonicalOf(value) {
  return canonical(value)
}

function blobsOf(record) {
  if (record.kind === "copy") return [record.body.digest]
  if (record.kind === "representation") return [record.body.text, record.body.tree]
  if (record.kind === "artifact" && record.body.type === "model-call") return [record.body.response, ...record.body.contents]
  if (record.kind === "artifact" && (record.body.type === "table" || record.body.type === "export")) return [record.body.digest]
  if (record.kind === "artifact" && record.body.type === "script")
    return [record.body.script, record.body.result, ...(record.body.calls ?? []).flatMap((call) => [call.input, call.output])]
  if (record.kind === "receipt") return [...(record.body.inputs ?? [])]
  return []
}

// Every referenced file is read and rehashed, whether or not a fragment also points at it.
for (const record of byId.values()) for (const digest of blobsOf(record)) blob(digest)
for (const [id, record] of byId) {
  for (const target of refsOf(record)) {
    const found = byId.get(target.id)
    if (!found) fail("ref", short(id), target.kind + ":" + short(target.id) + " does not resolve to a record")
    else if (found.kind !== target.kind) fail("ref", short(id), target.kind + ":" + short(target.id) + " names a " + found.kind)
  }
}
const REQUIRED = {
  "journal-article": [["author", "editor"], ["issued"], ["title"], ["container", "publisher"], ["DOI", "URL"]],
  "working-paper": [["author", "editor"], ["issued"], ["title"], ["container", "publisher"], ["DOI", "URL"]],
  book: [["author", "editor"], ["issued"], ["title"], ["publisher"]],
  chapter: [["author", "editor"], ["issued"], ["title"], ["publisher"], ["page"]],
  report: [["publisher"], ["title"], ["issued"], ["URL", "number"]],
  "web-page": [["author", "publisher"], ["title"], ["URL"], ["accessed"]],
  dataset: [["publisher"], ["title"], ["issued"], ["DOI", "URL"]],
  archival: [["publisher"], ["title"], ["issued"], ["URL", "number"]],
  interview: [["title"], ["issued"]],
  other: [["title"]],
}

function missingCitationFields(source) {
  const csl = source.csl ?? {}
  const identifiers = source.identifiers ?? {}
  const present = (field) => {
    if (field === "URL") return Boolean(csl.URL ?? identifiers.url)
    if (field === "DOI") return Boolean(csl.DOI ?? identifiers.doi)
    const value = csl[field]
    return value !== undefined && value !== null && value !== ""
  }
  return (REQUIRED[source.type] ?? [["title"]]).filter((group) => !group.some(present)).map((group) => group.join(" or "))
}

for (const [id, record] of byId) {
  if (record.kind === "fragment") {
    const representation = byId.get(record.body.representation.id)
    if (!representation || representation.kind !== "representation") {
      fail("fragment.quote", short(id), "the representation it was cut from is missing")
      continue
    }
    const bytes = blob(representation.body.text)
    if (bytes === undefined) continue
    const quote = Buffer.from(record.body.quote, "utf8")
    const start = record.body.range.start
    const end = record.body.range.end
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > bytes.length)
      fail("fragment.quote", short(id), "range " + start + ".." + end + " is not a span")
    else if (record.body.quote.length === 0) fail("fragment.quote", short(id), "the quote is empty")
    else if (end - start !== quote.length)
      fail("fragment.quote", short(id), "the quote is " + quote.length + " bytes but the range spans " + (end - start))
    else if (bytes.subarray(start, end).toString("utf8") !== record.body.quote)
      fail("fragment.quote", short(id), "the quote is not the stored bytes")
    const before = Buffer.from(record.body.before, "utf8")
    if (start < before.length || !bytes.subarray(start - before.length, start).equals(before))
      fail("fragment.quote", short(id), "the words before the quote are not the stored bytes")
    const after = Buffer.from(record.body.after, "utf8")
    if (bytes.length - end < after.length || !bytes.subarray(end, end + after.length).equals(after))
      fail("fragment.quote", short(id), "the words after the quote are not the stored bytes")
  }
  if (record.kind === "source") {
    for (const missing of missingCitationFields(record.body)) fail("citation.fields", short(id), "missing " + missing)
  }
}

const MARKER = /\[research:([^\]\n]+)\]([\s\S]*?)\[\/research:\1\]/g
function shownPassages(session) {
  const passages = new Map()
  for (const record of records) {
    if (record.kind !== "artifact" || record.body.type !== "model-call") continue
    if (record.session !== session) continue
    for (const content of record.body.contents ?? []) {
      const body = text(content)
      if (body === undefined) continue
      for (const match of body.matchAll(MARKER)) {
        const list = passages.get(match[1]) ?? []
        list.push(match[2])
        passages.set(match[1], list)
      }
    }
  }
  return passages
}

for (const [id, record] of byId) {
  if (record.kind !== "evidence" || record.author?.voice !== "agent") continue
  if (record.body.target?.kind !== "fragment") continue
  const fragment = byId.get(record.body.target.fragment.id)
  if (!fragment || fragment.kind !== "fragment") {
    fail("evidence.shown", short(id), "the fragment it cites is missing")
    continue
  }
  if (!record.session) {
    fail("evidence.shown", short(id), "agent evidence without a session cannot be shown")
    continue
  }
  const passages = shownPassages(record.session)
  const texts = passages.get(fragment.body.address) ?? []
  if (!texts.some((body) => body.includes(fragment.body.quote)) && !wasCutInSession(record.session, record.body.target.fragment.id))
    fail("evidence.shown", short(id), "the fragment was never shown to that session")
}

function wasCutInSession(session, fragmentID) {
  return records.some(
    (candidate) =>
      candidate.kind === "receipt" &&
      candidate.session === session &&
      (candidate.body.records ?? []).some((written) => written.kind === "fragment" && written.id === fragmentID),
  )
}

const manifestPath = join(directory, "manifest.json")
if (existsSync(manifestPath)) {
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    fail("rendered", "manifest.json", "the manifest is unreadable")
  }
  if (typeof manifest.commits === "number" && manifest.commits !== commits)
    fail("manifest", "commits", "the manifest says " + manifest.commits + " but the log holds " + commits + " commits")
  if (manifest.head && manifest.head !== previous) fail("manifest", "head", "the manifest head is not the last commit")
  if (Array.isArray(manifest.recordIds)) {
    const count = (values) => {
      const map = new Map()
      for (const value of values) map.set(value, (map.get(value) ?? 0) + 1)
      return [...map.entries()].sort().map(([key, n]) => key + "x" + n).join()
    }
    if (count(manifest.recordIds) !== count(records.map((record) => digestOf(record))))
      fail("manifest", "recordIds", "the manifest lists other records than the log holds")
  }
  for (const [name, expected] of Object.entries(manifest.rendered ?? {})) {
    const path = join(directory, name)
    if (!existsSync(path)) {
      fail("rendered", name, "the rendered file is missing")
      continue
    }
    const actual = "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex")
    if (actual !== expected) fail("rendered", name, "the rendered file does not match the manifest")
  }
}

if (issues.length === 0) {
  console.log("record verifies: " + records.length + " records, " + blobs.size + " files, " + ids.size + " ids")
  process.exit(0)
}
for (const issue of issues) console.log(issue.check + " " + issue.target + ": " + issue.detail)
console.log(issues.length + " failed checks")
process.exit(1)
