import type { Csl, CslAuthor, FieldOrigin, SourceType } from "@opencode/research-record"

export interface PageMetadata {
  readonly title?: string
  readonly authors: readonly CslAuthor[]
  readonly site?: string
  readonly published?: string
  readonly container?: string
  readonly doi?: string
}

export function pageMetadata(html: string, url?: string): PageMetadata {
  const tags = metaTags(html)
  const authors = allTags(html, "citation_author").flatMap(parseAuthor)
  const published = tags.get("citation_publication_date") ?? tags.get("citation_date") ?? tags.get("article:published_time")
  return {
    title: tags.get("citation_title") ?? tags.get("og:title") ?? textOf(html, "title"),
    authors,
    site: tags.get("og:site_name") ?? siteOf(tags.get("og:url") ?? url),
    published: published ? isoDate(published) : undefined,
    container: tags.get("citation_journal_title") ?? tags.get("citation_conference_title"),
    doi: tags.get("citation_doi") ?? tags.get("dc.identifier") ?? tags.get("doi"),
  }
}

export function cslOfPage(
  metadata: PageMetadata,
  url?: string,
  accessed?: string,
): { csl: Csl; type: SourceType; origins: { [field: string]: FieldOrigin } } {
  const origins: { [field: string]: FieldOrigin } = {}
  if (metadata.title) origins.title = "page"
  if (metadata.authors.length > 0) origins.author = "page"
  if (metadata.published) origins.issued = "page"
  if (metadata.container) origins.container = "page"
  if (metadata.doi) origins.DOI = "page"
  if (url) {
    origins.URL = "page"
    origins.accessed = "page"
  }
  return {
    type: metadata.container ? "journal-article" : url ? "web-page" : "other",
    origins,
    csl: {
      title: metadata.title ?? url ?? "",
      ...(metadata.authors.length > 0 ? { author: metadata.authors } : {}),
      ...(metadata.published ? { issued: { "date-parts": [dateParts(metadata.published)] } } : {}),
      ...(metadata.container ? { container: metadata.container } : {}),
      ...(metadata.site && !metadata.container ? { publisher: metadata.site } : {}),
      ...(metadata.doi ? { DOI: metadata.doi } : {}),
      ...(url
        ? { URL: url, accessed: { "date-parts": [dateParts(accessed ?? new Date().toISOString())] } }
        : {}),
    },
  }
}

export interface CrossrefWork {
  readonly csl: Csl
  readonly type: SourceType
  readonly abstract?: string
  readonly origins: { readonly [field: string]: FieldOrigin }
}

/** Maps a Crossref `message` to CSL-JSON. The service is the origin of every field it fills. */
export function crossrefWork(message: unknown): CrossrefWork | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const work = message as {
    title?: string[]
    author?: { family?: string; given?: string; name?: string }[]
    editor?: { family?: string; given?: string; name?: string }[]
    issued?: { "date-parts"?: number[][] }
    container?: string[]
    "container-title"?: string[]
    publisher?: string
    DOI?: string
    type?: string
    abstract?: string
    page?: string
    volume?: string
    issue?: string
  }
  const title = work.title?.[0]
  if (!title) return undefined
  const authors = (work.author ?? []).flatMap(toAuthor)
  const editors = (work.editor ?? []).flatMap(toAuthor)
  const container = work["container-title"]?.[0] ?? work.container?.[0]
  const csl: Csl = {
    title,
    ...(authors.length > 0 ? { author: authors } : {}),
    ...(editors.length > 0 ? { editor: editors } : {}),
    ...(work.issued?.["date-parts"]?.[0] ? { issued: { "date-parts": [work.issued["date-parts"][0]!] } } : {}),
    ...(container ? { container } : {}),
    ...(work.publisher ? { publisher: work.publisher } : {}),
    ...(work.DOI ? { DOI: work.DOI } : {}),
    ...(work.page ? { page: work.page } : {}),
    ...(work.volume ? { volume: work.volume } : {}),
    ...(work.issue ? { issue: work.issue } : {}),
    ...(work.type ? { type: work.type } : {}),
  }
  const origins: { [field: string]: FieldOrigin } = { title: "crossref" }
  if (authors.length > 0) origins.author = "crossref"
  if (csl.issued) origins.issued = "crossref"
  if (container) origins.container = "crossref"
  if (work.publisher) origins.publisher = "crossref"
  if (work.DOI) origins.DOI = "crossref"
  return {
    csl,
    type: crossrefType(work.type),
    ...(work.abstract ? { abstract: stripJats(work.abstract) } : {}),
    origins,
  }
}

function crossrefType(type: string | undefined): SourceType {
  switch (type) {
    case "journal-article":
    case "proceedings-article":
      return "journal-article"
    case "posted-content":
      return "working-paper"
    case "book":
    case "monograph":
      return "book"
    case "book-chapter":
      return "chapter"
    case "report":
      return "report"
    case "dataset":
      return "dataset"
    case undefined:
      return "other"
    default:
      return "other"
  }
}

function toAuthor(author: { family?: string; given?: string; name?: string }): CslAuthor[] {
  const family = author.family ?? author.name
  if (!family) return []
  return [{ family, ...(author.given ? { given: author.given } : {}) }]
}

function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = attribute(match[0], "name") ?? attribute(match[0], "property")
    const content = attribute(match[0], "content")
    if (name && content !== undefined) tags.set(name.toLowerCase(), content)
  }
  return tags
}

function allTags(html: string, name: string): string[] {
  const values: string[] = []
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attribute(match[0], "name") ?? attribute(match[0], "property")
    const content = attribute(match[0], "content")
    if (key?.toLowerCase() === name && content) values.push(content)
  }
  return values
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined
}

function textOf(html: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html)
  return match ? match[1]!.replace(/<[^>]+>/g, "").trim() || undefined : undefined
}

function siteOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function parseAuthor(value: string): CslAuthor[] {
  const [family, given] = value.split(",").map((part) => part.trim())
  if (!family) return []
  return [{ family, ...(given ? { given } : {}) }]
}

function isoDate(value: string): string | undefined {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value)
  if (match) return `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`
  const year = /^(\d{4})/.exec(value)
  return year ? `${year[1]}-01-01` : undefined
}

function dateParts(value: string): number[] {
  const [year, month, day] = value.split("-").map((part) => Number(part))
  return day ? [year!, month!, day] : [year!]
}

/** Crossref abstracts arrive as JATS XML. The text is kept, the markup is not. */
export function stripJats(abstract: string): string {
  return abstract
    .replace(/<jats:title>([\s\S]*?)<\/jats:title>/gi, "$1: ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}
