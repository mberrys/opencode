import {
  type Csl,
  type Ref,
  type Digest,
  type Record,
  type SourceBody,
  type SourceType,
  type FragmentBody,
  canonical,
  digest,
  recordId,
  refOf,
  verifyFragment,
  wasShown,
} from "@opencode/research-record"
import type { CommitBody, Store } from "./store.js"

export type CheckName =
  | "log.chain"
  | "log.seq"
  | "record.id"
  | "record.index"
  | "ref"
  | "blob"
  | "fragment.quote"
  | "citation.fields"
  | "evidence.shown"

export interface VerifyIssue {
  readonly check: CheckName
  readonly target: string
  readonly detail: string
}

export interface VerifyReport {
  readonly ok: boolean
  /** The head a reader should compare with a copy they kept: an internal chain cannot prove it was not truncated. */
  readonly head: Digest | null
  readonly commits: number
  readonly records: number
  readonly blobs: number
  readonly issues: readonly VerifyIssue[]
}

/** Rechecks the whole record from the log, not from the query index, so a damaged index cannot hide anything. */
export function verify(store: Store): VerifyReport {
  const issues: VerifyIssue[] = []
  const rows = store.commits()
  const records: Record[] = []
  const ids = new Map<string, Record>()
  const referenced = new Set<Digest>()
  let previous: Digest | null = null

  for (const [index, row] of rows.entries()) {
    if (row.seq !== index + 1) issue(issues, "log.seq", `commit ${row.seq}`, `expected sequence ${index + 1}`)
    const parsed = parseCommit(row.body, row.seq, issues)
    if (!parsed) continue
    if (canonical(parsed as never) !== row.body)
      issue(issues, "log.chain", `commit ${row.seq}`, "the stored body is not its canonical form")
    if (parsed.prev !== previous)
      issue(issues, "log.chain", `commit ${row.seq}`, `prev is ${String(parsed.prev)}, not ${String(previous)}`)
    if (digest(parsed as never) !== row.digest)
      issue(issues, "log.chain", `commit ${row.seq}`, "the commit does not hash to its digest")
    if (parsed.seq !== row.seq) issue(issues, "log.chain", `commit ${row.seq}`, "the body names another sequence")
    if (row.prev !== parsed.prev) issue(issues, "log.chain", `commit ${row.seq}`, "the indexed prev differs from the body")
    previous = row.digest
    for (const record of parsed.records) records.push(record)
  }

  for (const record of records) {
    const id = recordId(record)
    const seen = ids.get(id)
    if (seen && canonical(seen as never) !== canonical(record as never))
      issue(issues, "record.id", short(id), "two records share one id with different content")
    ids.set(id, record)
  }

  const indexed = new Map<string, Record>()
  try {
    for (const record of store.all()) indexed.set(recordId(record), record)
  } catch (error) {
    issue(issues, "record.index", "index", `the query index cannot be read: ${(error as Error).message}`)
  }
  for (const [id] of ids) {
    if (!indexed.has(id)) issue(issues, "record.index", short(id), "the record is in the log but not in the index")
  }
  for (const [id] of indexed) {
    if (!ids.has(id)) issue(issues, "record.index", short(id), "the index holds a record the log does not")
  }

  for (const record of records) {
    for (const blob of blobsOf(record)) referenced.add(blob)
  }
  for (const blob of referenced) {
    if (!store.blobs.has(blob)) {
      issue(issues, "blob", short(blob), "a referenced file is missing")
      continue
    }
    try {
      store.blobs.get(blob)
    } catch (error) {
      issue(issues, "blob", short(blob), (error as Error).message)
    }
  }

  const byId = new Map(records.map((record) => [recordId(record), record] as const))
  for (const record of records) {
    const from = short(recordId(record))
    for (const target of refsOf(record)) {
      const found = byId.get(target.id)
      if (!found) issue(issues, "ref", from, `${target.kind}:${short(target.id)} does not resolve to a record`)
      else if (found.kind !== target.kind) issue(issues, "ref", from, `${target.kind}:${short(target.id)} names a ${found.kind}`)
    }
  }

  for (const record of records) {
    if (record.kind !== "fragment") continue
    const representation = byId.get(record.body.representation.id)
    if (!representation || representation.kind !== "representation") {
      issue(issues, "fragment.quote", short(recordId(record)), "the representation it was cut from is missing")
      continue
    }
    if (!store.blobs.has(representation.body.text)) continue
    try {
      const result = verifyFragment(record.body as FragmentBody, store.blobs.get(representation.body.text))
      if (!result.ok) issue(issues, "fragment.quote", short(recordId(record)), result.failure.detail)
    } catch (error) {
      issue(issues, "fragment.quote", short(recordId(record)), (error as Error).message)
    }
  }

  for (const record of records) {
    if (record.kind !== "source") continue
    for (const missing of missingCitationFields(record.body)) {
      issue(issues, "citation.fields", short(recordId(record)), `missing ${missing}`)
    }
  }

  const sessions = new Map(records.map((record) => [recordId(record), record] as const))
  const shown = new Map<string, ReturnType<Store["shownSet"]>>()
  // A receipt that recorded the fragment proves this session cut it; the model-call set is the stronger check.
  const cutInSession = (session: string, fragment: { id: string }) =>
    records.some(
      (record) =>
        record.kind === "receipt" &&
        record.session === session &&
        record.body.records.some((written) => written.kind === "fragment" && written.id === fragment.id),
    )
  for (const record of records) {
    if (record.kind !== "evidence" || record.author.voice !== "agent") continue
    if (record.body.target.kind !== "fragment") continue
    const fragment = sessions.get(record.body.target.fragment.id)
    if (!fragment || fragment.kind !== "fragment") {
      issue(issues, "evidence.shown", short(recordId(record)), "the fragment it cites is missing")
      continue
    }
    if (!record.session) {
      issue(issues, "evidence.shown", short(recordId(record)), "agent evidence without a session cannot be shown")
      continue
    }
    let set = shown.get(record.session)
    if (!set) {
      try {
        set = store.shownSet(record.session)
      } catch (error) {
        issue(issues, "evidence.shown", short(recordId(record)), `the session's model calls cannot be read: ${(error as Error).message}`)
        continue
      }
      shown.set(record.session, set)
    }
    if (!wasShown(set, fragment.body as FragmentBody) && !cutInSession(record.session, refOf(fragment))) {
      issue(issues, "evidence.shown", short(recordId(record)), "the fragment was never shown to that session")
    }
  }

  return {
    ok: issues.length === 0,
    head: rows.at(-1)?.digest ?? null,
    commits: rows.length,
    records: records.length,
    blobs: referenced.size,
    issues,
  }
}

function parseCommit(body: string, seq: number, issues: VerifyIssue[]): CommitBody | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    const value = parsed as CommitBody
    if (typeof value.seq !== "number" || !Array.isArray(value.records)) throw new Error("not a commit")
    return value
  } catch (error) {
    issue(issues, "log.chain", `commit ${seq}`, `unreadable commit: ${(error as Error).message}`)
    return undefined
  }
}

/** Every file the records point at, so an export can copy exactly the bytes the record needs. */
/** Every ref a record makes, so a dangling citation fails verification rather than only a lookup. */
export function refsOf(record: Record): Ref[] {
  if (record.kind === "copy") return [record.body.source]
  if (record.kind === "representation") return [record.body.copy]
  if (record.kind === "fragment") return [record.body.representation]
  if (record.kind === "evidence")
    return [record.body.claim, record.body.target.kind === "fragment" ? record.body.target.fragment : record.body.target.artifact]
  if (record.kind === "judgment") return record.body.fragment ? [record.body.target, record.body.fragment] : [record.body.target]
  if (record.kind === "decision") return [record.body.target]
  if (record.kind === "artifact") {
    if (record.body.type === "answer")
      return [...record.body.inputs, ...record.body.sentences.flatMap((sentence) => (sentence.claim ? [sentence.claim] : []))]
    return [...record.body.inputs]
  }
  if (record.kind === "receipt") {
    const operation = record.body.operation
    const call = operation.kind === "model" ? [operation.call] : operation.kind === "script" ? [operation.artifact] : []
    return [...record.body.records, ...call]
  }
  if (record.kind === "snapshot")
    return [record.body.artifact, ...record.body.claims, ...record.body.evidence, ...record.body.sources]
  return []
}

export function referencedBlobs(records: readonly Record[]): Digest[] {
  return [...new Set(records.flatMap(blobsOf))]
}

function blobsOf(record: Record): Digest[] {
  if (record.kind === "copy") return [record.body.digest]
  if (record.kind === "representation") return [record.body.text, record.body.tree]
  if (record.kind === "artifact" && record.body.type === "model-call")
    return [record.body.response, ...record.body.contents]
  if (record.kind === "artifact" && (record.body.type === "table" || record.body.type === "export"))
    return [record.body.digest]
  if (record.kind === "artifact" && record.body.type === "script")
    return [record.body.script, record.body.result, ...record.body.calls.flatMap((call) => [call.input, call.output])]
  if (record.kind === "receipt") return [...record.body.inputs]
  return []
}

const REQUIRED: Readonly<{ [K in SourceType]: readonly (readonly string[])[] }> = {
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

/** A citation renders only when the fields its source type requires are present. */
export function missingCitationFields(source: Pick<SourceBody, "type" | "csl" | "identifiers">): string[] {
  const csl = source.csl as Csl & { [field: string]: unknown }
  const present = (field: string): boolean => {
    if (field === "URL") return Boolean(csl.URL ?? source.identifiers.url)
    if (field === "DOI") return Boolean(csl.DOI ?? source.identifiers.doi)
    const value = csl[field]
    return value !== undefined && value !== null && value !== ""
  }
  return (REQUIRED[source.type] ?? [["title"]])
    .filter((group) => !group.some(present))
    .map((group) => group.join(" or "))
}

function short(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7, 19) : value
}

function issue(issues: VerifyIssue[], check: CheckName, target: string, detail: string): void {
  issues.push({ check, target, detail })
}
