export * as Find from "./find.js"

import { Graph, Ref, ResearchRecord } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { Tree } from "./tree.js"
import { Workspace } from "./workspace.js"

export interface Sentence {
  readonly address: string
  readonly text: string
  /** UTF-8 byte offsets into the representation's text: what a fragment's selector names. */
  readonly start: number
  readonly end: number
  /** The printed page the sentence starts on, for a text extracted from a PDF. */
  readonly page?: number
}

export interface Section {
  readonly section: number
  readonly heading: string
  readonly path: readonly string[]
  readonly paragraphs: number
  readonly sentences: number
}

export interface Outline {
  readonly source: Ref.Exact
  readonly short: string
  readonly title: string
  readonly representation: Ref.Exact | undefined
  readonly sections: readonly Section[]
  readonly note: string
}

/** The sections of a work's text, or a note saying it has none yet. */
export function outline(reader: Store.Reader, source: string | Ref.Exact): Outline {
  const graph = reader.graph()
  const entry = entryOf(graph, source)
  const located = Workspace.locate(reader, graph, entry)
  const base = { source: ResearchRecord.refOf(entry.source), short: entry.short, title: entry.title }
  if (located === undefined)
    return { ...base, representation: undefined, sections: [], note: "no text has been extracted for this work yet" }
  const sections = Map.groupBy(located.tree.nodes, (node) => node.section)
  return {
    ...base,
    representation: ResearchRecord.refOf(located.representation),
    sections: [...sections].map(([section, nodes]) => ({
      section,
      heading: nodes.find((node) => node.kind === "heading")?.text ?? `Section ${section}`,
      path: nodes.at(-1)?.heading ?? [],
      paragraphs: new Set(
        nodes.filter((node) => node.kind !== "heading" && node.kind !== "sentence").map((node) => node.paragraph),
      ).size,
      sentences: nodes.filter((node) => node.kind === "sentence").length,
    })),
    note: abstractNote(located),
  }
}

export interface Read {
  readonly source: Ref.Exact
  readonly short: string
  readonly representation: Ref.Exact
  readonly address: string
  readonly sentences: readonly Sentence[]
  readonly truncated: boolean
  readonly note: string
}

/** Reads from an address onwards within its section, or a whole section. Every sentence carries its address. */
export function read(
  reader: Store.Reader,
  input: { readonly address: string; readonly section?: number; readonly limit?: number },
): Read {
  const graph = reader.graph()
  const position = Workspace.parseAddress(input.address)
  const located = textOf(reader, graph, entryOf(graph, position.short))
  const section = position.section ?? input.section ?? located.tree.nodes[0]?.section ?? 1
  const sentences = located.tree.nodes.filter((node) => node.kind === "sentence" && node.section === section)
  const found = sentences.findIndex(
    (node) =>
      node.paragraph > (position.paragraph ?? 0) ||
      (node.paragraph === position.paragraph && (node.sentence ?? 0) >= (position.sentence ?? 0)),
  )
  const from = found === -1 ? sentences.length : found
  const limit = Math.min(input.limit ?? 12, 200)
  const selected = sentences.slice(from, from + limit).map((node) => view(located, node))
  return {
    source: ResearchRecord.refOf(located.entry.source),
    short: located.entry.short,
    representation: ResearchRecord.refOf(located.representation),
    address: input.address,
    sentences: selected,
    truncated: from + selected.length < sentences.length,
    note: abstractNote(located),
  }
}

export interface Hit extends Sentence {
  readonly source: Ref.Exact
  readonly short: string
  readonly title: string
}

export interface Grep {
  readonly hits: readonly Hit[]
  readonly truncated: boolean
  readonly searched: number
}

/** Sentences matching a regular expression, case-insensitive unless asked otherwise. */
export function grep(
  reader: Store.Reader,
  input: {
    readonly pattern: string
    readonly source?: string | Ref.Exact
    readonly ignoreCase?: boolean
    readonly limit?: number
  },
): Grep {
  const expression = new RegExp(input.pattern, input.ignoreCase === false ? "" : "i")
  const sentences = texts(reader, input.source).flatMap((located) =>
    located.tree.nodes.flatMap((node) => (node.kind === "sentence" ? [{ located, node }] : [])),
  )
  const hits = sentences.flatMap((item) =>
    expression.test(item.node.text)
      ? [
          {
            ...view(item.located, item.node),
            source: ResearchRecord.refOf(item.located.entry.source),
            short: item.located.entry.short,
            title: item.located.entry.title,
          },
        ]
      : [],
  )
  const limit = Math.min(input.limit ?? 20, 200)
  return { hits: hits.slice(0, limit), truncated: hits.length > limit, searched: sentences.length }
}

export interface Ranked {
  readonly address: string
  readonly text: string
  readonly source: Ref.Exact
  readonly short: string
  readonly title: string
  readonly score: number
  readonly page?: number
}

export interface Search {
  readonly hits: readonly Ranked[]
  readonly truncated: boolean
  readonly searched: number
}

/**
 * Lexical ranking over paragraphs (TF-IDF without an index), which replays by running again. Every hit is an exact
 * paragraph with an address.
 */
export function search(
  reader: Store.Reader,
  input: { readonly query: string; readonly source?: string | Ref.Exact; readonly limit?: number },
): Search {
  const terms = [...new Set(input.query.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])]
  if (terms.length === 0) return { hits: [], truncated: false, searched: 0 }
  const paragraphs = texts(reader, input.source).flatMap((located) =>
    located.tree.nodes
      .filter((node) => node.kind === "paragraph" || node.kind === "list-item" || node.kind === "quote")
      .map((node) => ({ located, node, lowered: node.text.toLowerCase() })),
  )
  const frequency = new Map(
    terms.map((term) => [term, paragraphs.filter((paragraph) => paragraph.lowered.includes(term)).length]),
  )
  const scored = paragraphs.flatMap((paragraph) => {
    const score = terms.reduce((total, term) => {
      const count = paragraph.lowered.split(term).length - 1
      if (count === 0) return total
      return total + count * Math.log(1 + paragraphs.length / Math.max(frequency.get(term) ?? 0, 1))
    }, 0)
    if (score <= 0) return []
    const entry = paragraph.located.entry
    return [
      {
        address: Workspace.addressOf(entry, paragraph.node),
        text: paragraph.node.text,
        source: ResearchRecord.refOf(entry.source),
        short: entry.short,
        title: entry.title,
        score: Number(score.toFixed(6)),
        ...pageOf(paragraph.located, paragraph.node),
      },
    ]
  })
  const ranked = scored.toSorted((a, b) => b.score - a.score || a.address.localeCompare(b.address))
  const limit = Math.min(input.limit ?? 10, 100)
  return { hits: ranked.slice(0, limit), truncated: ranked.length > limit, searched: paragraphs.length }
}

export interface Cites {
  readonly source: Ref.Exact
  readonly short: string
  readonly entries: readonly { readonly address: string; readonly text: string }[]
  readonly note: string
}

/** The reference list as printed. Matching an entry to a work in the library is left to a DOI lookup. */
export function cites(reader: Store.Reader, source: string | Ref.Exact): Cites {
  const graph = reader.graph()
  const located = textOf(reader, graph, entryOf(graph, source))
  const references = located.tree.nodes.filter((node) => node.kind === "reference")
  return {
    source: ResearchRecord.refOf(located.entry.source),
    short: located.entry.short,
    entries: references.map((node) => ({ address: Workspace.addressOf(located.entry, node), text: node.text })),
    note: references.length === 0 ? "no reference list was found in this text" : "",
  }
}

function texts(reader: Store.Reader, source: string | Ref.Exact | undefined) {
  const graph = reader.graph()
  const chosen = source === undefined ? Workspace.entries(graph) : [entryOf(graph, source)]
  return chosen.flatMap((entry) => {
    const located = Workspace.locate(reader, graph, entry)
    return located === undefined ? [] : [located]
  })
}

function entryOf(graph: Graph.Graph, source: string | Ref.Exact) {
  const entry = Workspace.find(graph, source)
  if (entry === undefined)
    throw new Error(`no work in the library is ${typeof source === "string" ? source : source.objectId}`)
  return entry
}

function textOf(reader: Store.Reader, graph: Graph.Graph, entry: Workspace.Entry) {
  const located = Workspace.locate(reader, graph, entry)
  if (located === undefined) throw new Error(`no text has been extracted for ${entry.short} yet`)
  return located
}

function view(located: Workspace.Located, node: Tree.Node): Sentence {
  return {
    address: Workspace.addressOf(located.entry, node),
    text: node.text,
    start: node.start,
    end: node.end,
    ...pageOf(located, node),
  }
}

function pageOf(located: Workspace.Located, node: Tree.Node) {
  const page = Tree.pageAt(located.tree, node.start)
  return page === undefined ? {} : { page }
}

function abstractNote(located: Workspace.Located) {
  return located.copy.body.content === "abstract"
    ? "this copy is an abstract only; every quote from it is flagged abstract-only"
    : ""
}
