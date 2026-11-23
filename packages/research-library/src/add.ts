export * as Add from "./add.js"

import { Canonical, Ref, ResearchRecord } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import path from "node:path"
import { Extract } from "./extract.js"
import { Fetch } from "./fetch.js"
import { Metadata } from "./metadata.js"
import { Receipt } from "./receipt.js"
import { Tree } from "./tree.js"

export interface Input {
  readonly file?: string
  readonly url?: string
  readonly doi?: string
  /** A title the caller proposes. It is recorded as the initiator's own metadata, never as a measured field. */
  readonly title?: string
}

export interface Options extends Receipt.Actor {
  /** Asked before every request, redirects included. Permissions belong to the caller, not the library. */
  readonly allow: Fetch.Options["allow"]
  readonly fetch?: typeof fetch
  readonly maxBytes?: number
  /** Crossref's works endpoint, such as a mirror's. */
  readonly crossref?: string
  /** How a researcher's title was confirmed. An agent's title is a judgment and needs none. */
  readonly attestation?: { readonly level: "tty" | "tui-gesture" | "unattested"; readonly surface: string }
}

/**
 * `added`: a source with a full-text copy and its text. `abstract-only`: the copy is an abstract. `metadata-only`: no
 * copy could be had. `no-text`: the copy is stored but no text was extracted (a PDF, for now). `existing`: these bytes
 * were already in the library, and their source is returned.
 */
export type Status = "added" | "abstract-only" | "metadata-only" | "no-text" | "existing"

export interface Added {
  readonly status: Status
  readonly source: Ref.Exact
  readonly copy?: Ref.Exact
  readonly representation?: Ref.Exact
  readonly receipt: Ref.Exact
  readonly seq: number
  readonly notes: readonly string[]
}

export const TOOL = "library.add"
export const VERSION = "1"
export const CROSSREF = "https://api.crossref.org/works/"

interface Draft {
  readonly type: string
  readonly identifiers: readonly { readonly scheme: string; readonly value: string }[]
  /** Fields measured from the copy itself, and fields a service answered with. */
  readonly page: Metadata.Fields
  readonly service?: { readonly fields: Metadata.Fields; readonly response: Uint8Array }
  readonly copy?: {
    readonly bytes: Uint8Array
    readonly mediaType: string
    readonly content: "full-text" | "abstract"
    readonly from: string
  }
  readonly notes: readonly string[]
}

/**
 * Acquires one work into the library and commits, with the receipt of the call, a source, a copy of its bytes and
 * the text extracted from them, as far as each could be had. Identical bytes resolve to the source that already
 * holds them.
 */
export async function add(store: Store.Store, input: Input, options: Options): Promise<Added> {
  const started = Receipt.now(options)
  const draft = await acquire(input, options)
  const copyBytes = draft.copy?.bytes
  const existing = copyBytes === undefined ? undefined : store.copiesOf(Canonical.blobDigest(copyBytes)).at(0)
  if (existing !== undefined) {
    const output = { status: "existing" as const, source: existing.source, copy: existing.copy }
    // A proposed title still counts: it is recorded against the source that already holds the bytes.
    const metadata =
      input.title === undefined
        ? []
        : [title(store, options, store.graph().get(existing.source, "source"), input.title)]
    const written = Receipt.commit(store, options, started, tool(input, output), metadata)
    return { ...output, receipt: written.receipt, seq: written.seq, notes: ["these bytes were already in the library"] }
  }
  const revisions = build(store, input, options, draft)
  const output = {
    status: revisions.status,
    source: ResearchRecord.refOf(revisions.source),
    ...(revisions.copy === undefined ? {} : { copy: ResearchRecord.refOf(revisions.copy) }),
    ...(revisions.representation === undefined
      ? {}
      : { representation: ResearchRecord.refOf(revisions.representation) }),
  }
  const written = Receipt.commit(store, options, started, tool(input, output), revisions.all)
  return { ...output, receipt: written.receipt, seq: written.seq, notes: [...draft.notes, ...revisions.notes] }
}

/** The file's media type from its extension. */
export function mediaTypeOf(file: string) {
  const extension = path.extname(file).toLowerCase()
  if (extension === ".pdf") return Extract.PDF_MIME
  if (extension === ".html" || extension === ".htm") return Extract.HTML_MIME
  if (extension === ".md" || extension === ".markdown") return Extract.MARKDOWN_MIME
  return Extract.TEXT_MIME
}

async function acquire(input: Input, options: Options): Promise<Draft> {
  if (input.file !== undefined) return fromFile(input.file, input, options)
  if (input.url !== undefined) return fromUrl(input.url, input, options)
  if (input.doi !== undefined) return fromDoi(input.doi, options)
  throw new Error("give a file, a url or a doi")
}

async function fromFile(file: string, input: Input, options: Options): Promise<Draft> {
  const limit = options.maxBytes ?? Fetch.MAX_BYTES
  const size = Bun.file(file).size
  if (size > limit) throw new Error(`${file} is ${size} bytes; the limit is ${limit}`)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const mediaType = mediaTypeOf(file)
  // A file is still added when Crossref cannot be reached; its own metadata is used instead.
  const service = input.doi === undefined ? undefined : await crossref(input.doi, options).catch(() => undefined)
  const found =
    mediaType === Extract.HTML_MIME ? Metadata.ofPage(Metadata.page(new TextDecoder().decode(bytes))) : undefined
  return {
    type: service?.work.type ?? found?.type ?? "document",
    identifiers: identifiers({ doi: input.doi ?? stringField(found?.fields.DOI) }),
    page: found?.fields ?? {},
    ...(service === undefined ? {} : { service: { fields: service.work.fields, response: service.response } }),
    copy: { bytes, mediaType, content: "full-text", from: "file" },
    notes:
      input.doi !== undefined && service === undefined
        ? [`Crossref did not answer for ${input.doi}; the citation uses the file's own metadata`]
        : [],
  }
}

async function fromUrl(url: string, input: Input, options: Options): Promise<Draft> {
  const fetched = await Fetch.get(url, options)
  const mediaType = mediaTypeOfHeader(fetched.mediaType)
  const found = Metadata.ofPage(
    mediaType === Extract.HTML_MIME
      ? Metadata.page(new TextDecoder().decode(fetched.bytes), fetched.url.href)
      : { authors: [] },
    true,
  )
  return {
    type: found.type,
    identifiers: identifiers({ url: fetched.url.href, doi: input.doi ?? stringField(found.fields.DOI) }),
    page: found.fields,
    copy: { bytes: fetched.bytes, mediaType, content: "full-text", from: fetched.url.href },
    notes: fetched.url.href === new URL(url).href ? [] : [`${url} redirected to ${fetched.url.href}`],
  }
}

async function fromDoi(doi: string, options: Options): Promise<Draft> {
  const service = await crossref(doi, options)
  if (service === undefined) throw new Error(`Crossref does not know the DOI ${doi}`)
  const abstract = service.work.abstract
  return {
    type: service.work.type,
    identifiers: identifiers({ doi }),
    page: {},
    service: { fields: service.work.fields, response: service.response },
    ...(abstract === undefined
      ? {}
      : {
          copy: {
            bytes: new TextEncoder().encode(abstract),
            mediaType: Extract.TEXT_MIME,
            content: "abstract" as const,
            from: `https://doi.org/${encodeURI(doi)}`,
          },
        }),
    notes:
      abstract === undefined
        ? ["Crossref supplied no abstract and no full text; add a file or a URL to quote from it"]
        : ["only the abstract is stored, so every quote from it is flagged abstract-only"],
  }
}

/** The revisions an add writes. Every field names where it came from: the service's stored answer, or the copy. */
function build(store: Store.Store, input: Input, options: Options, draft: Draft) {
  const response = draft.service === undefined ? undefined : store.admit(draft.service.response).digest
  const copyBlob = draft.copy === undefined ? undefined : store.admit(draft.copy.bytes).digest
  const fields = {
    ...(copyBlob === undefined ? {} : originate(draft.page, { by: "file", copy: copyBlob })),
    ...(response === undefined || draft.service === undefined
      ? {}
      : originate(draft.service.fields, { by: "service", service: "crossref", response })),
  }
  const source = Receipt.program(store, options, "source", { type: draft.type, identifiers: draft.identifiers, fields })
  const metadata = input.title === undefined ? [] : [title(store, options, source, input.title)]
  if (draft.copy === undefined || copyBlob === undefined)
    return { status: "metadata-only" as const, source, all: [source, ...metadata], notes: [] }
  const copy = Receipt.program(store, options, "copy", {
    source: ResearchRecord.refOf(source),
    blob: copyBlob,
    mediaType: draft.copy.mediaType,
    size: draft.copy.bytes.length,
    content: draft.copy.content,
    retrieved: { from: draft.copy.from, at: Receipt.now(options) },
    licence: "none",
  })
  const blocks = Extract.blocksOf(draft.copy.mediaType, draft.copy.bytes)
  const extracted = blocks === undefined ? undefined : Tree.build(blocks)
  if (extracted === undefined || extracted.text.trim() === "") {
    const note =
      blocks === undefined
        ? "text is not extracted from PDFs yet; the file is stored and can be quoted once it is"
        : "the extractor found no text in this file"
    return { status: "no-text" as const, source, copy, all: [source, copy, ...metadata], notes: [note] }
  }
  const representation = Receipt.program(store, options, "representation", {
    copy: ResearchRecord.refOf(copy),
    blob: store.admit(new TextEncoder().encode(extracted.text)).digest,
    extractor: { id: extractorOf(draft.copy.mediaType), version: "1" },
    tree: { digest: store.admit(Tree.encode(extracted.tree)).digest, schema: Tree.SCHEMA },
    ocr: false,
  })
  return {
    status: draft.copy.content === "abstract" ? ("abstract-only" as const) : ("added" as const),
    source,
    copy,
    representation,
    all: [source, copy, representation, ...metadata],
    notes: [],
  }
}

/**
 * A proposed title is the initiator's metadata: an agent's is a judgment, flagged on every claim that cites the
 * source; a researcher's is a decision, with how it was confirmed.
 */
function title(store: Store.Store, options: Options, source: ResearchRecord.Revision<"source">, value: string) {
  const initiator = options.context.initiator
  const body = { type: "metadata", source: ResearchRecord.refOf(source), field: "title", value }
  if (initiator.voice === "program") throw new Error("a title is proposed by an agent or the researcher")
  const decision = initiator.voice === "researcher"
  const content = decision
    ? {
        ...body,
        reason: "the researcher gave the title when adding the work",
        attestation: options.attestation ?? { level: "unattested", surface: TOOL },
      }
    : { ...body, reason: "the agent gave the title when adding the work" }
  const objectId = decision
    ? ResearchRecord.decisionObjectId(content as ResearchRecord.Body<"decision">)
    : Receipt.objectId("judgment")
  // A decision's object id is derived from its subject, so a second title for the same source revises the first.
  const previous = decision ? store.latest(objectId) : undefined
  return ResearchRecord.create({
    projectId: store.projectId,
    kind: decision ? "decision" : "judgment",
    schema: decision ? "decision@1" : "judgment@1",
    objectId,
    parent: previous === undefined ? "none" : ResearchRecord.refOf(previous),
    author: initiator,
    context: options.context,
    body: content,
  })
}

function tool(input: Input, output: unknown): Receipt.Tool {
  return {
    tool: TOOL,
    version: VERSION,
    replay: "stored",
    input,
    output,
    schema: { input: "library-add-input@1", output: "library-add-output@1" },
  }
}

async function crossref(doi: string, options: Options) {
  // Crossref answers an unknown DOI with 404; any other failure is the caller's to see.
  const fetched = await Fetch.get(`${options.crossref ?? CROSSREF}${encodeURIComponent(doi)}`, options).catch(
    (error: unknown) => {
      if (error instanceof Fetch.FetchError && error.code === "status") return undefined
      throw error
    },
  )
  if (fetched === undefined) return undefined
  const work = Metadata.crossref(new TextDecoder().decode(fetched.bytes))
  return work === undefined ? undefined : { work, response: fetched.bytes }
}

function originate(fields: Metadata.Fields, origin: unknown) {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { value, origin }]))
}

function identifiers(found: { readonly doi?: string; readonly url?: string }) {
  return [
    ...(found.doi === undefined ? [] : [{ scheme: "doi", value: found.doi }]),
    ...(found.url === undefined ? [] : [{ scheme: "url", value: found.url }]),
  ]
}

function stringField(value: Metadata.Fields[string] | undefined) {
  return typeof value === "string" ? value : undefined
}

function mediaTypeOfHeader(header: string) {
  if (header === "application/pdf") return Extract.PDF_MIME
  if (header === "text/html" || header === "application/xhtml+xml") return Extract.HTML_MIME
  if (header === "text/markdown") return Extract.MARKDOWN_MIME
  return Extract.TEXT_MIME
}

function extractorOf(mediaType: string) {
  if (mediaType === Extract.HTML_MIME) return "research-html"
  if (mediaType === Extract.MARKDOWN_MIME) return "research-markdown"
  return "research-text"
}
