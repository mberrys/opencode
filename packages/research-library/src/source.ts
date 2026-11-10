import { basename, extname } from "node:path"
import {
  type Csl,
  type FieldOrigin,
  type Ref,
  type SourceBody,
  type SourceType,
  makeRecord,
  refOf,
} from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { HTML_MIME, MARKDOWN_MIME, PDF_MIME, TEXT_MIME, blocksOf } from "./extract.js"
import { type CrossrefWork, crossrefWork, cslOfPage, pageMetadata } from "./metadata.js"
import { buildTree } from "./tree.js"

export type AddStatus = "added" | "abstract-only" | "metadata-only" | "pdf-pending"

export interface AddInput {
  readonly file?: string
  readonly url?: string
  readonly doi?: string
  readonly title?: string
  readonly type?: SourceType
}

export interface AddOptions {
  readonly fetch?: typeof fetch
  readonly now?: Date
}

export interface AddResult {
  readonly source: Ref
  readonly copy: Ref | null
  readonly representation: Ref | null
  readonly status: AddStatus
  readonly title: string
  readonly notes: readonly string[]
}

interface Draft {
  readonly type: SourceType
  readonly identifiers: SourceBody["identifiers"]
  readonly csl: Csl
  readonly origins: { readonly [field: string]: FieldOrigin }
  readonly bytes?: Uint8Array
  readonly mime?: string
  readonly url?: string
  readonly abstractOnly: boolean
  readonly status: AddStatus
  readonly notes: readonly string[]
}

/** Acquires one work into the library: a source, a copy of its bytes, and the text extracted from that copy. */
export async function addSource(store: Store, input: AddInput, options: AddOptions = {}): Promise<AddResult> {
  const at = (options.now ?? new Date()).toISOString()
  const draft = input.file
    ? await fromFile(input, options)
    : input.url
      ? await fromUrl(input, options)
      : input.doi
        ? await fromDoi(input, options)
        : undefined
  if (!draft) throw new Error("give a file, a url or a doi")
  return persist(store, draft, at)
}

async function fromFile(input: AddInput, options: AddOptions): Promise<Draft> {
  const path = input.file!
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  const mime = mimeOf(path)
  const notes: string[] = []
  const enriched = input.doi ? await crossref(input.doi, options.fetch ?? fetch) : undefined
  if (input.doi && !enriched) notes.push(`Crossref did not answer for ${input.doi}; the citation uses the file's own metadata`)
  // An HTML file carries its own citation metadata, so a downloaded article is cited from its own tags.
  const page = mime === HTML_MIME ? cslOfPage(pageMetadata(new TextDecoder().decode(bytes))) : undefined
  const title = input.title ?? enriched?.csl.title ?? (page?.csl.title || undefined) ?? basename(path, extname(path))
  const type = input.type ?? enriched?.type ?? page?.type ?? (mime === PDF_MIME ? "journal-article" : "other")
  return {
    type,
    identifiers: {
      ...(page?.csl.DOI ? { doi: page.csl.DOI } : {}),
      ...(input.doi ? { doi: input.doi } : {}),
    },
    csl: { ...(page?.csl ?? {}), ...(enriched?.csl ?? {}), title },
    origins: {
      ...(page?.origins ?? {}),
      ...(enriched?.origins ?? {}),
      title: input.title ? "file" : enriched ? "crossref" : page?.origins.title ?? "file",
    },
    bytes,
    mime,
    abstractOnly: false,
    status: mime === PDF_MIME ? "pdf-pending" : "added",
    notes: [...notes, ...(mime === PDF_MIME ? ["PDF text extraction is not built yet (check C3); the file is stored and can be quoted only after extraction"] : [])],
  }
}

async function fromUrl(input: AddInput, options: AddOptions): Promise<Draft> {
  const url = input.url!
  const response = await (options.fetch ?? fetch)(url, {
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": "opencode-research/1" },
  })
  if (!response.ok) throw new Error(`fetching ${url} returned ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const header = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
  const mime = header === "application/pdf" ? PDF_MIME : header === "text/html" || header === "application/xhtml+xml" ? HTML_MIME : header === "text/markdown" ? MARKDOWN_MIME : TEXT_MIME
  const at = new Date().toISOString()
  const page = mime === HTML_MIME ? cslOfPage(pageMetadata(new TextDecoder().decode(bytes), url), url, at) : undefined
  const csl: Csl = page?.csl ?? { title: input.title ?? url, URL: url, accessed: { "date-parts": [[new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, new Date(at).getUTCDate()]] } }
  return {
    type: input.type ?? page?.type ?? "other",
    identifiers: { url, ...(page?.csl.DOI ? { doi: page.csl.DOI } : {}) },
    csl: { ...csl, ...(input.title ? { title: input.title } : {}) },
    origins: page?.origins ?? { title: "page", URL: "page", accessed: "page" },
    bytes,
    mime,
    url,
    abstractOnly: false,
    status: mime === PDF_MIME ? "pdf-pending" : "added",
    notes: mime === PDF_MIME ? ["the page serves a PDF; text extraction is not built yet (check C3)"] : [],
  }
}

async function fromDoi(input: AddInput, options: AddOptions): Promise<Draft> {
  const doi = input.doi!
  const work = await crossref(doi, options.fetch ?? fetch)
  if (!work) throw new Error(`Crossref does not know the DOI ${doi}`)
  if (!work.abstract) {
    return {
      type: input.type ?? work.type,
      identifiers: { doi },
      csl: work.csl,
      origins: work.origins,
      abstractOnly: false,
      status: "metadata-only",
      notes: ["Crossref supplied no abstract and no full text; add a file or a URL to quote from it"],
    }
  }
  return {
    type: input.type ?? work.type,
    identifiers: { doi },
    csl: work.csl,
    origins: work.origins,
    bytes: new TextEncoder().encode(work.abstract),
    mime: TEXT_MIME,
    url: `https://doi.org/${doi}`,
    abstractOnly: true,
    status: "abstract-only",
    notes: ["only the abstract is stored, so every quote from it is flagged abstract-only"],
  }
}

function persist(store: Store, draft: Draft, at: string): AddResult {
  const source = makeRecord({
    kind: "source",
    at,
    author: { voice: "program" },
    body: { type: draft.type, identifiers: draft.identifiers, csl: draft.csl, fieldOrigins: draft.origins },
  })
  if (!draft.bytes || !draft.mime) {
    store.commit([source], { at })
    return {
      source: refOf(source),
      copy: null,
      representation: null,
      status: draft.status,
      title: draft.csl.title,
      notes: draft.notes,
    }
  }

  const bytes = draft.bytes
  const copy = makeRecord({
    kind: "copy",
    at,
    author: { voice: "program" },
    body: {
      source: refOf(source),
      digest: store.put(bytes),
      mime: draft.mime,
      bytes: bytes.length,
      fetchedAt: at,
      ...(draft.url ? { url: draft.url } : {}),
      abstractOnly: draft.abstractOnly,
    },
  })

  const blocks = blocksOf(draft.mime, bytes)
  if (!blocks) {
    store.commit([source, copy], { at })
    return {
      source: refOf(source),
      copy: refOf(copy),
      representation: null,
      status: draft.status,
      title: draft.csl.title,
      notes: draft.notes,
    }
  }

  const extracted = buildTree(blocks)
  if (!extracted.text.trim()) {
    store.commit([source, copy], { at })
    return {
      source: refOf(source),
      copy: refOf(copy),
      representation: null,
      status: draft.status,
      title: draft.csl.title,
      notes: [...draft.notes, "the extractor found no text in this file"],
    }
  }

  const representation = makeRecord({
    kind: "representation",
    at,
    author: { voice: "program" },
    body: {
      copy: refOf(copy),
      text: store.put(new TextEncoder().encode(extracted.text)),
      tree: store.put(new TextEncoder().encode(JSON.stringify(extracted.tree))),
      extractor: { name: extractorOf(draft.mime), version: 1 },
      flags: [],
      sections: extracted.tree.sections,
      paragraphs: extracted.tree.paragraphs,
      sentences: extracted.tree.sentences,
      characters: extracted.text.length,
    },
  })
  store.commit([source, copy, representation], { at })
  return {
    source: refOf(source),
    copy: refOf(copy),
    representation: refOf(representation),
    status: draft.status,
    title: draft.csl.title,
    notes: draft.notes,
  }
}

async function crossref(doi: string, fetchImpl: typeof fetch): Promise<CrossrefWork | undefined> {
  const mailto = process.env.OPENCODE_RESEARCH_MAILTO
  const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    signal: AbortSignal.timeout(20000),
    headers: { "user-agent": `opencode-research/1${mailto ? ` (mailto:${mailto})` : ""}` },
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json()) as { message?: unknown }
  return crossrefWork(body.message)
}

export function mimeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return PDF_MIME
    case ".html":
    case ".htm":
      return HTML_MIME
    case ".md":
    case ".markdown":
      return MARKDOWN_MIME
    default:
      return TEXT_MIME
  }
}

function extractorOf(mime: string): string {
  if (mime === HTML_MIME) return "research-html"
  if (mime === MARKDOWN_MIME) return "research-markdown"
  return "research-text"
}
