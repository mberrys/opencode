import { type Digest, type Json, digest, isDigest } from "./digest.js"

export const CONTRACT = "research-record@1"

export const KINDS = [
  "source",
  "copy",
  "representation",
  "fragment",
  "claim",
  "evidence",
  "judgment",
  "decision",
  "protocol",
  "artifact",
  "receipt",
  "snapshot",
] as const

export type Kind = (typeof KINDS)[number]

/** Who wrote a record. The voice, not the tool, decides what the record may claim. */
export type Voice = "program" | "agent" | "researcher"

export const VOICES: readonly Voice[] = ["program", "agent", "researcher"]

/**
 * The three voices hold separate record kinds. Only the program measures, only an agent opines, and only the
 * researcher rules, so no record can hold two voices at once.
 */
const WRITERS: Readonly<{ [K in Kind]: readonly Voice[] }> = {
  source: ["program", "agent", "researcher"],
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

export interface Author {
  readonly voice: Voice
  /** The agent name (`reader`) or the researcher's label. Absent for the program. */
  readonly id?: string
}

export interface Ref {
  readonly kind: Kind
  readonly id: Digest
}

export function ref(kind: Kind, id: Digest): Ref {
  return { kind, id }
}

export function refOf<K extends Kind>(record: Envelope<K, BodyMap[K]> | Ref): Ref {
  // A caller that already holds a ref must get it back untouched; hashing the ref would invent an id.
  if (!("body" in record)) return { kind: record.kind, id: record.id }
  return { kind: record.kind, id: recordId(record) }
}

export function formatRef(value: Ref): string {
  return `${value.kind}:${value.id}`
}

export function parseRef(value: string): Ref {
  const separator = value.indexOf(":")
  if (separator < 0) throw new Error(`not a ref: ${value}`)
  const kind = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (!KINDS.includes(kind as Kind)) throw new Error(`unknown record kind: ${kind}`)
  if (!isDigest(id)) throw new Error(`not a ref id: ${id}`)
  return { kind: kind as Kind, id }
}

export function sameRef(a: Ref, b: Ref): boolean {
  return a.kind === b.kind && a.id === b.id
}

export const SOURCE_TYPES = [
  "journal-article",
  "working-paper",
  "book",
  "chapter",
  "report",
  "web-page",
  "dataset",
  "archival",
  "interview",
  "other",
] as const

export type SourceType = (typeof SOURCE_TYPES)[number]

export type FieldOrigin = "crossref" | "openalex" | "unpaywall" | "file" | "page" | "agent" | "researcher"

export interface CslAuthor {
  readonly family: string
  readonly given?: string
}

/** CSL-JSON, kept to the fields version 1 renders. */
export interface Csl {
  readonly title: string
  readonly author?: readonly CslAuthor[]
  readonly editor?: readonly CslAuthor[]
  readonly issued?: { readonly "date-parts": readonly (readonly number[])[] }
  readonly container?: string
  readonly publisher?: string
  readonly DOI?: string
  readonly URL?: string
  readonly accessed?: { readonly "date-parts": readonly (readonly number[])[] }
  readonly page?: string
  readonly volume?: string
  readonly issue?: string
  readonly type?: string
  readonly number?: string
}

export interface SourceBody {
  readonly type: SourceType
  readonly identifiers: {
    readonly doi?: string
    readonly openalex?: string
    readonly url?: string
    readonly isbn?: string
    readonly arxiv?: string
  }
  readonly csl: Csl
  /** Where each citation field came from, so an agent-filled field is never shown as measured. */
  readonly fieldOrigins: Readonly<{ [field: string]: FieldOrigin }>
}

export interface CopyBody {
  readonly source: Ref
  readonly digest: Digest
  readonly mime: string
  readonly bytes: number
  readonly fetchedAt: string
  readonly url?: string
  readonly licence?: string
  /** The only file this work offers is an abstract, so every quote from it is qualified. */
  readonly abstractOnly: boolean
}

export type RepresentationFlag = "ocr"

export interface RepresentationBody {
  readonly copy: Ref
  /** UTF-8 text blob. Every span in the library is a byte offset into this blob. */
  readonly text: Digest
  /** Canonical JSON blob of the structure tree. */
  readonly tree: Digest
  readonly extractor: { readonly name: string; readonly version: number }
  readonly flags: readonly RepresentationFlag[]
  readonly sections: number
  readonly paragraphs: number
  readonly sentences: number
  readonly characters: number
}

export type FragmentFlag = "secondary" | "abstract-only" | "ocr"

export interface PagePosition {
  readonly number: number
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
}

export interface FragmentBody {
  readonly representation: Ref
  readonly range: { readonly start: number; readonly end: number }
  readonly quote: string
  readonly before: string
  readonly after: string
  /** Display form, `k7f2:4/p3/s2`. Never the authority for a byte range. */
  readonly address: string
  readonly page?: PagePosition
  readonly flags: readonly FragmentFlag[]
}

export interface ClaimBody {
  readonly text: string
  readonly scope?: { readonly question?: string; readonly subquestion?: string }
  readonly run?: string
}

export const EVIDENCE_ROLES = ["supports", "challenges", "qualifies", "contextualizes"] as const

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number]

export type EvidenceTarget =
  | { readonly kind: "fragment"; readonly fragment: Ref }
  | { readonly kind: "computation"; readonly artifact: Ref }

export interface EvidenceBody {
  readonly claim: Ref
  readonly role: EvidenceRole
  readonly target: EvidenceTarget
  /** The words read inside the fragment, as byte ranges relative to the quote. */
  readonly words?: readonly { readonly start: number; readonly end: number }[]
}

export interface JudgmentBody {
  readonly target: Ref
  readonly verdict: string
  readonly reason: string
  readonly fragment?: Ref
}

export const RULINGS = ["adopt", "reject", "sustain", "overrule"] as const

export type Ruling = (typeof RULINGS)[number]

export interface DecisionBody {
  readonly target: Ref
  readonly ruling: Ruling
  readonly reason?: string
}

export const EFFORTS = ["fast", "balanced", "deep"] as const

export type Effort = (typeof EFFORTS)[number]

export interface ProtocolBody {
  readonly question: string
  readonly scope: { readonly in: readonly string[]; readonly out: readonly string[] }
  readonly subquestions: readonly { readonly id: string; readonly question: string }[]
  readonly effort: Effort
  readonly budgets: {
    readonly subquestions: number
    readonly sourcesPerSubquestion: number
    readonly readFullText: boolean
    readonly gapRounds: number
  }
  readonly run: string
}

export const ARTIFACT_TYPES = ["answer", "model-call", "script", "table", "export"] as const

export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export interface AnswerSentence {
  readonly text: string
  /** Absent means the sentence is shown as unsupported. */
  readonly claim?: Ref
}

export type ArtifactBody =
  | {
      readonly type: "answer"
      readonly run: string
      readonly mediaType: string
      readonly sentences: readonly AnswerSentence[]
      readonly inputs: readonly Ref[]
    }
  | {
      readonly type: "model-call"
      readonly run: string
      readonly model: string
      /** Content blobs of the request in provider order, so the shown set can be derived from them. */
      readonly contents: readonly Digest[]
      readonly response: Digest
      readonly inputs: readonly Ref[]
    }
  | {
      readonly type: "script"
      readonly run: string
      readonly script: Digest
      readonly result: Digest
      readonly calls: readonly { readonly tool: string; readonly input: Digest; readonly output: Digest }[]
      readonly inputs: readonly Ref[]
    }
  | {
      readonly type: "table"
      readonly run: string
      readonly mediaType: string
      readonly digest: Digest
      readonly inputs: readonly Ref[]
    }
  | {
      readonly type: "export"
      readonly run: string
      readonly mediaType: string
      readonly digest: Digest
      readonly inputs: readonly Ref[]
    }

export type ReceiptOperation =
  | { readonly kind: "tool"; readonly tool: string; readonly input: Json }
  | { readonly kind: "model"; readonly call: Ref }
  | { readonly kind: "script"; readonly artifact: Ref }

export interface ReceiptBody {
  readonly run: string
  readonly seq: number
  readonly operation: ReceiptOperation
  readonly inputs: readonly Digest[]
  readonly output: Digest
  readonly records: readonly Ref[]
  readonly startedAt: string
  readonly endedAt: string
  readonly ok: boolean
  readonly error?: string
}

export interface SnapshotBody {
  readonly artifact: Ref
  readonly claims: readonly Ref[]
  readonly evidence: readonly Ref[]
  readonly sources: readonly Ref[]
}

export interface BodyMap {
  source: SourceBody
  copy: CopyBody
  representation: RepresentationBody
  fragment: FragmentBody
  claim: ClaimBody
  evidence: EvidenceBody
  judgment: JudgmentBody
  decision: DecisionBody
  protocol: ProtocolBody
  artifact: ArtifactBody
  receipt: ReceiptBody
  snapshot: SnapshotBody
}

export interface Envelope<K extends Kind, B> {
  readonly contract: typeof CONTRACT
  readonly kind: K
  /** The id of the first revision of this object. */
  readonly object: Digest
  /** The id of the revision this one replaces. */
  readonly parent?: Digest
  readonly author: Author
  readonly at: string
  /** The session, message and tool call the record came from, when a session wrote it. */
  readonly session?: string
  readonly message?: string
  readonly call?: string
  readonly body: B
}

export type Record = { [K in Kind]: Envelope<K, BodyMap[K]> }[Kind]

/** The same union under a name that does not shadow the built-in `Record` in a consumer. */
export type ResearchRecord = Record

export function recordId<K extends Kind>(record: Envelope<K, BodyMap[K]>): Digest {
  return digest(compact(record) as Json)
}

export interface WriteInput<K extends Kind> {
  readonly kind: K
  readonly body: BodyMap[K]
  readonly author: Author
  readonly at?: string
  readonly session?: string
  readonly message?: string
  readonly call?: string
}

/** A first revision names its object by its own content, so the object id never depends on the revision id. */
export function makeRecord<K extends Kind>(input: WriteInput<K>): Envelope<K, BodyMap[K]> {
  const object = digest({ contract: CONTRACT, kind: input.kind, body: compact(input.body) as Json })
  return build(input, object)
}

export function revise<K extends Kind>(
  previous: Envelope<K, BodyMap[K]>,
  body: BodyMap[K],
  author: Author,
  meta: { readonly at?: string; readonly session?: string; readonly message?: string; readonly call?: string } = {},
): Envelope<K, BodyMap[K]> {
  return build({ kind: previous.kind, body, author, ...meta }, previous.object, recordId(previous as unknown as Record))
}

function build<K extends Kind>(
  input: WriteInput<K>,
  object: Digest,
  parent?: Digest,
): Envelope<K, BodyMap[K]> {
  const record = compact({
    contract: CONTRACT,
    kind: input.kind,
    object,
    parent,
    author: input.author,
    at: input.at ?? new Date().toISOString(),
    session: input.session,
    message: input.message,
    call: input.call,
    body: input.body,
  }) as Envelope<K, BodyMap[K]>
  assertRecord(record as unknown as Record)
  return record
}

export function assertRecord(value: unknown): asserts value is Record {
  const record = requireObject(value, "record")
  if (record.contract !== CONTRACT) throw new Error(`record contract must be ${CONTRACT}`)
  const kind = record.kind
  if (typeof kind !== "string" || !KINDS.includes(kind as Kind)) throw new Error(`unknown record kind: ${String(kind)}`)
  if (!isDigest(record.object)) throw new Error("record object must be a digest")
  if (record.parent !== undefined && !isDigest(record.parent)) throw new Error("record parent must be a digest")
  const author = requireObject(record.author, "record author")
  if (!VOICES.includes(author.voice as Voice)) throw new Error(`unknown author voice: ${String(author.voice)}`)
  if (!WRITERS[kind as Kind].includes(author.voice as Voice))
    throw new Error(`a ${author.voice as string} may not write a ${kind}`)
  if (author.id !== undefined && typeof author.id !== "string") throw new Error("author id must be a string")
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) throw new Error("record at must be a date")
  assertBody(kind as Kind, record.body)
}

function assertBody(kind: Kind, value: unknown): void {
  const body = requireObject(value, `${kind} body`)
  for (const [field, type] of Object.entries(FIELDS[kind]) as [string, FieldType][]) {
    check(body[field], type, `${kind}.${field}`)
  }
  for (const [field, type] of Object.entries(OPTIONAL[kind] ?? {}) as [string, FieldType][]) {
    if (body[field] !== undefined) check(body[field], type, `${kind}.${field}`)
  }
  const enumField = ENUMS[kind]
  if (enumField && !(enumField.values as readonly unknown[]).includes(body[enumField.field]))
    throw new Error(`${kind}.${enumField.field} must be one of ${enumField.values.join(", ")}`)
  const flags = FLAG_VALUES[kind]
  if (flags && Array.isArray(body.flags))
    for (const flag of body.flags)
      if (!flags.includes(flag as string)) throw new Error(`${kind}.flags must be among ${flags.join(", ")}`)
  if (kind === "artifact") assertArtifact(body)
  if (kind === "evidence") assertEvidence(body)
}

function assertArtifact(body: { [key: string]: unknown }): void {
  if (body.type === "answer") {
    check(body.sentences, "json-array", "artifact.sentences")
    check(body.mediaType, "string", "artifact.mediaType")
    return
  }
  if (body.type === "model-call") {
    check(body.model, "string", "artifact.model")
    check(body.contents, "digests", "artifact.contents")
    check(body.response, "digest", "artifact.response")
    return
  }
  if (body.type === "script") {
    check(body.script, "digest", "artifact.script")
    check(body.result, "digest", "artifact.result")
    check(body.calls, "json-array", "artifact.calls")
    return
  }
  check(body.mediaType, "string", "artifact.mediaType")
  check(body.digest, "digest", "artifact.digest")
}

function assertEvidence(body: { [key: string]: unknown }): void {
  const target = requireObject(body.target, "evidence.target")
  if (target.kind === "fragment") return assertRefValue(target.fragment, "evidence.target.fragment")
  if (target.kind === "computation") {
    assertRefValue(target.artifact, "evidence.target.artifact")
    if ((target.artifact as { kind: string }).kind !== "artifact")
      throw new Error("evidence.target.artifact must name an artifact")
    return
  }
  throw new Error("evidence.target.kind must be fragment or computation")
}

type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "digest"
  | "ref"
  | "refs"
  | "strings"
  | "digests"
  | "object"
  | "json"
  | "json-array"

const FIELDS: Readonly<{ [K in Kind]: Readonly<{ [key: string]: FieldType }> }> = {
  source: { type: "string", identifiers: "object", csl: "object", fieldOrigins: "object" },
  copy: {
    source: "ref",
    digest: "digest",
    mime: "string",
    bytes: "number",
    fetchedAt: "string",
    abstractOnly: "boolean",
  },
  representation: {
    copy: "ref",
    text: "digest",
    tree: "digest",
    extractor: "object",
    flags: "strings",
    sections: "number",
    paragraphs: "number",
    sentences: "number",
    characters: "number",
  },
  fragment: {
    representation: "ref",
    range: "object",
    quote: "string",
    before: "string",
    after: "string",
    address: "string",
    flags: "strings",
  },
  claim: { text: "string" },
  evidence: { claim: "ref", role: "string", target: "object" },
  judgment: { target: "ref", verdict: "string", reason: "string" },
  decision: { target: "ref", ruling: "string" },
  protocol: {
    question: "string",
    scope: "object",
    subquestions: "json-array",
    effort: "string",
    budgets: "object",
    run: "string",
  },
  artifact: { type: "string", run: "string", inputs: "refs" },
  receipt: {
    run: "string",
    seq: "number",
    operation: "object",
    inputs: "digests",
    output: "digest",
    records: "refs",
    startedAt: "string",
    endedAt: "string",
    ok: "boolean",
  },
  snapshot: { artifact: "ref", claims: "refs", evidence: "refs", sources: "refs" },
}

const OPTIONAL: Readonly<Partial<{ [K in Kind]: Readonly<{ [key: string]: FieldType }> }>> = {
  copy: { url: "string", licence: "string" },
  fragment: { page: "object" },
  claim: { scope: "object", run: "string" },
  evidence: { words: "json-array" },
  judgment: { fragment: "ref" },
  decision: { reason: "string" },
  receipt: { error: "string" },
}

const ENUMS: Partial<{ [K in Kind]: { field: string; values: readonly string[] } }> = {
  evidence: { field: "role", values: EVIDENCE_ROLES },
  decision: { field: "ruling", values: RULINGS },
  protocol: { field: "effort", values: EFFORTS },
  artifact: { field: "type", values: ARTIFACT_TYPES },
  source: { field: "type", values: SOURCE_TYPES },
}

const FLAG_VALUES: Readonly<{ [K in Kind]?: readonly string[] }> = {
  fragment: ["secondary", "abstract-only", "ocr"],
  representation: ["ocr"],
}

function check(value: unknown, type: FieldType, where: string): void {
  switch (type) {
    case "string":
      if (typeof value !== "string") throw new Error(`${where} must be a string`)
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${where} must be a number`)
      return
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`)
      return
    case "digest":
      if (!isDigest(value)) throw new Error(`${where} must be a digest`)
      return
    case "ref":
      assertRefValue(value, where)
      return
    case "refs":
      if (!Array.isArray(value)) throw new Error(`${where} must be a list of refs`)
      value.forEach((item, index) => assertRefValue(item, `${where}[${index}]`))
      return
    case "strings":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new Error(`${where} must be a list of strings`)
      return
    case "digests":
      // These name blob files, so anything but a digest could point outside the blob directory.
      if (!Array.isArray(value) || !value.every(isDigest)) throw new Error(`${where} must be a list of digests`)
      return
    case "json":
      requireObject(value, where)
      return
    case "json-array":
      if (!Array.isArray(value)) throw new Error(`${where} must be a list`)
      return
    case "object":
      requireObject(value, where)
      return
  }
}

function assertRefValue(value: unknown, where: string): void {
  const item = requireObject(value, where)
  if (typeof item.kind !== "string" || !KINDS.includes(item.kind as Kind))
    throw new Error(`${where} kind must be a record kind`)
  if (!isDigest(item.id)) throw new Error(`${where} id must be a digest`)
}

function requireObject(value: unknown, where: string): { [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object`)
  return value as { [key: string]: unknown }
}

/** Drops undefined properties so the canonical form of a record never depends on which optional fields were set. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact)
  if (typeof value !== "object" || value === null) return value
  // A null prototype keeps a body key named __proto__ a property rather than the prototype.
  const result: { [key: string]: unknown } = Object.create(null)
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = compact(item)
  }
  return result
}
