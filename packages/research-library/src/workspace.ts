export * as Workspace from "./workspace.js"

import { Canonical, Graph, Ref, ResearchRecord, Tier } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { Tree } from "./tree.js"

/** A work in the library: its source's newest revision, a short address, and the copies and texts it has. */
export interface Entry {
  readonly source: ResearchRecord.Revision<"source">
  readonly short: string
  readonly title: string
  readonly copies: readonly ResearchRecord.Revision<"copy">[]
  readonly representations: readonly ResearchRecord.Revision<"representation">[]
}

/** A text to read: the representation, the copy it was extracted from, and its decoded structure tree. */
export interface Located {
  readonly entry: Entry
  readonly copy: ResearchRecord.Revision<"copy">
  readonly representation: ResearchRecord.Revision<"representation">
  readonly tree: Tree.Structure
}

/**
 * Every source in the library, in the order it was added. A source's short address is the shortest prefix, of at
 * least four characters, of its object id's random part that no earlier source took, so adding a work never changes
 * an address already written down.
 */
export function entries(graph: Graph.Graph): Entry[] {
  const heads = graph.heads(graph.lastSeq).map((entry) => entry.revision)
  const copies = heads.flatMap((revision) => (revision.kind === "copy" ? [revision] : []))
  const representations = heads.flatMap((revision) => (revision.kind === "representation" ? [revision] : []))
  const sourceOfCopy = new Map(copies.map((copy) => [copy.objectId, copy.body.source.objectId]))
  const shorts = assignShorts(
    graph.entries.flatMap((entry) => (entry.revision.kind === "source" ? [entry.revision.objectId] : [])),
  )
  return heads.flatMap((revision) => {
    if (revision.kind !== "source") return []
    const title = Tier.citation(graph, ResearchRecord.refOf(revision), graph.lastSeq).title?.value
    return [
      {
        source: revision,
        short: shorts.get(revision.objectId) ?? revision.objectId,
        title: typeof title === "string" ? title : revision.objectId,
        copies: copies.filter((copy) => copy.body.source.objectId === revision.objectId),
        representations: representations.filter(
          (representation) => sourceOfCopy.get(representation.body.copy.objectId) === revision.objectId,
        ),
      },
    ]
  })
}

/** Finds a source by its short address or by any ref to one of its revisions. */
export function find(graph: Graph.Graph, source: string | Ref.Exact): Entry | undefined {
  return entries(graph).find((entry) =>
    typeof source === "string" ? entry.short === source : entry.source.objectId === source.objectId,
  )
}

/** The text a work is read in: its most recently extracted representation. */
export function locate(reader: Store.Reader, graph: Graph.Graph, entry: Entry): Located | undefined {
  const representation = entry.representations.at(-1)
  if (representation === undefined) return undefined
  const copy = graph.get(representation.body.copy, "copy")
  return {
    entry,
    copy,
    representation,
    tree: Tree.decode(reader.readBlob(representation.body.tree.digest as Canonical.Digest)),
  }
}

/** The text of a located representation, as the bytes its fragments quote. */
export function text(reader: Store.Reader, located: Located) {
  return reader.readBlob(located.representation.body.blob as Canonical.Digest)
}

/** `short:section/pN[/sN]`: a passage's display address. The byte offsets in the tree are the authority. */
export function addressOf(entry: Entry, node: { section: number; paragraph: number; sentence?: number }) {
  return `${entry.short}:${node.section}/p${node.paragraph}${node.sentence === undefined ? "" : `/s${node.sentence}`}`
}

/** Parses `short:section/pN[/sN]`, or `short` alone. */
export function parseAddress(address: string) {
  const match = /^([0-9a-z]{4,})(?::(\d+)(?:\/p(\d+)(?:\/s(\d+))?)?)?$/.exec(address.trim())
  if (match === null) throw new Error(`an address looks like ab12:3/p2/s1, not ${address}`)
  return {
    short: match[1],
    section: match[2] === undefined ? undefined : Number(match[2]),
    paragraph: match[3] === undefined ? undefined : Number(match[3]),
    sentence: match[4] === undefined ? undefined : Number(match[4]),
  }
}

function assignShorts(objectIds: readonly string[]) {
  const taken = new Set<string>()
  return objectIds.reduce((shorts, objectId) => {
    if (shorts.has(objectId)) return shorts
    const random = objectId.slice(objectId.lastIndexOf("-") + 1)
    const length = [...Array(random.length).keys()]
      .map((index) => index + 4)
      .find((candidate) => candidate >= random.length || !taken.has(random.slice(0, candidate)))
    const short = random.slice(0, length)
    taken.add(short)
    return shorts.set(objectId, short)
  }, new Map<string, string>())
}
