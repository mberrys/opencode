import type { Ref } from "@opencode/research-record"
import { parseAddress, refOf } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import type { TreeNode } from "./tree.js"
import { type Located, addressOf, entries, entryOf, entryOfShort, latest, latestOfEntry } from "./workspace.js"

export interface SectionView {
  readonly section: number
  readonly heading: string
  readonly path: readonly string[]
  readonly paragraphs: number
  readonly sentences: number
}

export interface OutlineResult {
  readonly source: Ref
  readonly short: string
  readonly title: string
  readonly representation: Ref | null
  readonly sections: readonly SectionView[]
  readonly note: string
}

export function outline(store: Store, source: Ref): OutlineResult {
  const entry = entryOf(store, source)
  if (!entry) throw new Error(`no source with id ${source.id}`)
  const located = latest(store, source)
  if (!located) {
    return {
      source,
      short: entry.short,
      title: entry.source.body.csl.title,
      representation: null,
      sections: [],
      note: "no text has been extracted for this work yet; add a full text copy",
    }
  }
  const sections = new Map<number, { heading: string; path: readonly string[]; paragraphs: Set<number>; sentences: number }>()
  for (const node of located.tree.nodes) {
    const current = sections.get(node.section) ?? {
      heading: `Section ${node.section}`,
      path: node.heading,
      paragraphs: new Set<number>(),
      sentences: 0,
    }
    current.path = node.heading
    if (node.kind === "heading") current.heading = node.text
    if (node.kind !== "heading" && node.kind !== "sentence") current.paragraphs.add(node.paragraph)
    if (node.kind === "sentence") current.sentences += 1
    sections.set(node.section, current)
  }
  return {
    source,
    short: entry.short,
    title: entry.source.body.csl.title,
    representation: refOf(located.representation),
    sections: [...sections.entries()].map(([section, value]) => ({
      section,
      heading: value.heading,
      path: value.path,
      paragraphs: value.paragraphs.size,
      sentences: value.sentences,
    })),
    note: located.copy.body.abstractOnly
      ? "this copy is an abstract only; every quote from it is flagged abstract-only"
      : "",
  }
}

export interface SentenceView {
  readonly address: string
  readonly text: string
  readonly start: number
  readonly end: number
}

export interface ReadResult {
  readonly source: Ref
  readonly short: string
  readonly representation: Ref
  readonly address: string
  readonly sentences: readonly SentenceView[]
  readonly truncated: boolean
  readonly note: string
}

export interface ReadInput {
  readonly source?: Ref
  readonly address?: string
  readonly section?: number
  readonly limit?: number
}

/** Reads by address, or a whole section. Every sentence comes back with the address that names it. */
export function read(store: Store, input: ReadInput): ReadResult {
  const limit = Math.min(input.limit ?? 12, 200)
  const located = input.address
    ? locateAddress(store, input.address)
    : input.source
      ? latest(store, input.source)
      : undefined
  if (!located) throw new Error(input.address ? `no document has the address ${input.address}` : "give a source or an address")

  const position = input.address ? parseAddress(input.address) : undefined
  const section = position?.section ?? input.section ?? located.tree.nodes[0]?.section ?? 1
  const sentences = located.tree.nodes.filter((node) => node.kind === "sentence" && node.section === section)
  const from = position
    ? sentences.findIndex(
        (node) =>
          node.paragraph > (position.paragraph ?? 0) ||
          (node.paragraph === position.paragraph && (node.sentence ?? 0) >= (position.sentence ?? 0)),
      )
    : 0
  const start = from < 0 ? sentences.length : from
  const selected = sentences.slice(start, start + limit).map((node) => view(located, node))
  return {
    source: refOf(located.entry.source),
    short: located.entry.short,
    representation: refOf(located.representation),
    address: input.address ?? `${located.entry.short}:${section}/p0`,
    sentences: selected,
    truncated: start + selected.length < sentences.length,
    note: located.copy.body.abstractOnly ? "abstract only" : "",
  }
}

function locateAddress(store: Store, address: string): Located | undefined {
  const parsed = parseAddress(address)
  const entry = entryOfShort(store, parsed.short)
  return entry ? latestOfEntry(store, entry) : undefined
}

function view(located: Located, node: TreeNode): SentenceView {
  return {
    address: addressOf(located.entry, { section: node.section, paragraph: node.paragraph, sentence: node.sentence }),
    text: node.text,
    start: node.start,
    end: node.end,
  }
}

function allLocated(store: Store): Located[] {
  return entries(store).flatMap((entry) => {
    const located = latestOfEntry(store, entry)
    return located ? [located] : []
  })
}

export interface GrepHit extends SentenceView {
  readonly source: Ref
  readonly short: string
  readonly title: string
}

export interface GrepResult {
  readonly hits: readonly GrepHit[]
  readonly truncated: boolean
  readonly searched: number
}

export interface GrepInput {
  readonly pattern: string
  readonly source?: Ref
  readonly ignoreCase?: boolean
  readonly limit?: number
}

export function grep(store: Store, input: GrepInput): GrepResult {
  const expression = new RegExp(input.pattern, input.ignoreCase === false ? "" : "i")
  const limit = Math.min(input.limit ?? 20, 200)
  const targets = input.source ? [latest(store, input.source)].filter((value): value is Located => Boolean(value)) : allLocated(store)
  const hits: GrepHit[] = []
  let searched = 0
  for (const located of targets) {
    for (const node of located.tree.nodes) {
      if (node.kind !== "sentence") continue
      searched += 1
      if (!expression.test(node.text)) continue
      hits.push({
        ...view(located, node),
        source: refOf(located.entry.source),
        short: located.entry.short,
        title: located.source.body.csl.title,
      })
    }
  }
  return { hits: hits.slice(0, limit), truncated: hits.length > limit, searched }
}

export interface SearchHit {
  readonly address: string
  readonly text: string
  readonly source: Ref
  readonly short: string
  readonly title: string
  readonly score: number
}

export interface SearchResult {
  readonly hits: readonly SearchHit[]
  readonly truncated: boolean
  readonly searched: number
}

export interface SearchInput {
  readonly query: string
  readonly source?: Ref
  readonly limit?: number
}

/**
 * Lexical ranking over paragraphs, which needs no index and replays by running again. Embeddings are a later
 * ranker (check C5), and every hit is already an exact span with an address.
 */
export function search(store: Store, input: SearchInput): SearchResult {
  const terms = [...new Set(input.query.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])]
  if (terms.length === 0) return { hits: [], truncated: false, searched: 0 }
  const targets = input.source ? [latest(store, input.source)].filter((value): value is Located => Boolean(value)) : allLocated(store)
  const paragraphs = targets.flatMap((located) =>
    located.tree.nodes
      .filter((node) => node.kind === "paragraph" || node.kind === "list-item" || node.kind === "quote")
      .map((node) => ({ located, node, lowered: node.text.toLowerCase() })),
  )
  if (paragraphs.length === 0) return { hits: [], truncated: false, searched: 0 }

  const frequency = new Map(
    terms.map((term) => [term, paragraphs.filter((paragraph) => paragraph.lowered.includes(term)).length] as const),
  )
  const scored = paragraphs.flatMap((paragraph) => {
    const score = terms.reduce((total, term) => {
      const count = paragraph.lowered.split(term).length - 1
      if (count === 0) return total
      return total + count * Math.log(1 + paragraphs.length / Math.max(frequency.get(term) ?? 0, 1))
    }, 0)
    if (score <= 0) return []
    return [
      {
        address: addressOf(paragraph.located.entry, { section: paragraph.node.section, paragraph: paragraph.node.paragraph }),
        text: paragraph.node.text,
        source: refOf(paragraph.located.entry.source),
        short: paragraph.located.entry.short,
        title: paragraph.located.source.body.csl.title,
        score: Number(score.toFixed(6)),
      },
    ]
  })
  scored.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
  const limit = Math.min(input.limit ?? 10, 100)
  return { hits: scored.slice(0, limit), truncated: scored.length > limit, searched: paragraphs.length }
}

export interface CitesResult {
  readonly source: Ref
  readonly short: string
  readonly entries: readonly { address: string; text: string }[]
  readonly note: string
}

/** The reference list as printed. Matching an entry to a work in the library still needs a DOI lookup. */
export function cites(store: Store, source: Ref): CitesResult {
  const located = latest(store, source)
  if (!located) throw new Error(`no text has been extracted for ${source.id}`)
  const references = located.tree.nodes.filter((node) => node.kind === "reference")
  return {
    source,
    short: located.entry.short,
    entries: references.map((node) => ({
      address: addressOf(located.entry, { section: node.section, paragraph: node.paragraph }),
      text: node.text,
    })),
    note: references.length === 0 ? "no reference list was found in this text" : "",
  }
}
