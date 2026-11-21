export * as Metadata from "./metadata.js"

import { Option, Schema } from "effect"

/** A CSL-JSON name. */
export interface Person {
  readonly family: string
  readonly given?: string
}

/** CSL-JSON citation fields by their CSL names. The caller records where each one came from. */
export type Fields = Readonly<Record<string, string | readonly Person[] | { readonly "date-parts": number[][] }>>

export interface Page {
  readonly title?: string
  readonly authors: readonly Person[]
  readonly site?: string
  readonly published?: string
  readonly container?: string
  readonly doi?: string
}

/** The citation tags a page carries about itself: Highwire `citation_*`, Open Graph and the `<title>`. */
export function page(html: string, url?: string): Page {
  const tags = metaTags(html)
  const published =
    tags.get("citation_publication_date") ?? tags.get("citation_date") ?? tags.get("article:published_time")
  return {
    title: tags.get("citation_title") ?? tags.get("og:title") ?? textOf(html, "title"),
    authors: allTags(html, "citation_author").flatMap(parseAuthor),
    site: tags.get("og:site_name") ?? siteOf(tags.get("og:url") ?? url),
    published: published === undefined ? undefined : isoDate(published),
    container: tags.get("citation_journal_title") ?? tags.get("citation_conference_title"),
    doi: tags.get("citation_doi") ?? tags.get("dc.identifier") ?? tags.get("doi"),
  }
}

/**
 * A page's citation as a CSL type and fields, all read from the page itself. Where and when it was fetched is the
 * copy's `retrieved`, not a citation field the page measured.
 */
export function ofPage(found: Page, web = false) {
  const fields: Record<string, Fields[string]> = {}
  if (found.title !== undefined) fields.title = found.title
  if (found.authors.length > 0) fields.author = found.authors
  if (found.published !== undefined) fields.issued = { "date-parts": [dateParts(found.published)] }
  if (found.container !== undefined) fields["container-title"] = found.container
  if (found.site !== undefined && found.container === undefined) fields.publisher = found.site
  if (found.doi !== undefined) fields.DOI = found.doi
  const type = found.container !== undefined ? "article-journal" : web ? "webpage" : "document"
  return { type, fields: fields as Fields }
}

export interface CrossrefWork {
  readonly type: string
  readonly fields: Fields
  readonly abstract?: string
}

const Name = Schema.Struct({
  family: Schema.optional(Schema.String),
  given: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})

/** The part of a Crossref works answer the citation is read from. Fields Crossref leaves out stay out. */
const CrossrefAnswer = Schema.Struct({
  message: Schema.Struct({
    title: Schema.optional(Schema.Array(Schema.String)),
    author: Schema.optional(Schema.Array(Name)),
    editor: Schema.optional(Schema.Array(Name)),
    issued: Schema.optional(
      Schema.Struct({ "date-parts": Schema.optional(Schema.Array(Schema.Array(Schema.Number))) }),
    ),
    "container-title": Schema.optional(Schema.Array(Schema.String)),
    publisher: Schema.optional(Schema.String),
    DOI: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    abstract: Schema.optional(Schema.String),
    page: Schema.optional(Schema.String),
    volume: Schema.optional(Schema.String),
    issue: Schema.optional(Schema.String),
  }),
})

const decodeCrossref = Schema.decodeUnknownOption(Schema.fromJsonString(CrossrefAnswer))

/** Maps a Crossref works answer to a CSL type and fields, or `undefined` when it is not one or names no title. */
export function crossref(answer: string): CrossrefWork | undefined {
  const decoded = decodeCrossref(answer)
  if (Option.isNone(decoded)) return undefined
  const work = decoded.value.message
  const title = work.title?.[0]
  if (title === undefined) return undefined
  const authors = (work.author ?? []).flatMap(toPerson)
  const editors = (work.editor ?? []).flatMap(toPerson)
  const issued = work.issued?.["date-parts"]?.[0]
  const container = work["container-title"]?.[0]
  const fields: Record<string, Fields[string]> = { title }
  if (authors.length > 0) fields.author = authors
  if (editors.length > 0) fields.editor = editors
  if (issued !== undefined) fields.issued = { "date-parts": [[...issued]] }
  if (container !== undefined) fields["container-title"] = container
  if (work.publisher !== undefined) fields.publisher = work.publisher
  if (work.DOI !== undefined) fields.DOI = work.DOI
  if (work.page !== undefined) fields.page = work.page
  if (work.volume !== undefined) fields.volume = work.volume
  if (work.issue !== undefined) fields.issue = work.issue
  return {
    type: cslType(work.type),
    fields: fields as Fields,
    ...(work.abstract === undefined ? {} : { abstract: stripJats(work.abstract) }),
  }
}

/** Crossref's work types, as CSL types. */
function cslType(type: string | undefined) {
  if (type === "journal-article") return "article-journal"
  if (type === "proceedings-article") return "paper-conference"
  if (type === "posted-content") return "article"
  if (type === "book" || type === "monograph") return "book"
  if (type === "book-chapter") return "chapter"
  if (type === "report" || type === "dataset") return type
  return "document"
}

function toPerson(person: typeof Name.Type): Person[] {
  const family = person.family ?? person.name
  if (family === undefined) return []
  return [{ family, ...(person.given === undefined ? {} : { given: person.given }) }]
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

function parseAuthor(value: string): Person[] {
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
  // Only the date of an ISO timestamp is read, so a time of day never turns the day into NaN.
  const [year, month, day] = value
    .slice(0, 10)
    .split("-")
    .map((part) => Number(part))
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
