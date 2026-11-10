import type { CopyBody, Digest, Envelope, Ref, RepresentationBody, SourceBody } from "@opencode/research-record"
import { hex, recordId } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import type { Tree } from "./tree.js"

export type SourceRecord = Envelope<"source", SourceBody>
export type CopyRecord = Envelope<"copy", CopyBody>
export type RepresentationRecord = Envelope<"representation", RepresentationBody>

export interface Entry {
  readonly source: SourceRecord
  readonly short: string
  readonly copies: readonly CopyRecord[]
  readonly representations: readonly RepresentationRecord[]
}

export interface Located {
  readonly entry: Entry
  readonly source: SourceRecord
  readonly copy: CopyRecord
  readonly representation: RepresentationRecord
  readonly tree: Tree
}

/**
 * A short id is the shortest prefix of a source id that no earlier source took. Ids are taken in the order the
 * sources were added, so a later source never changes an address that has already been written into a record.
 */
export function assignShorts(ids: readonly Digest[]): Map<Digest, string> {
  const result = new Map<Digest, string>()
  const taken = new Set<string>()
  for (const id of ids) {
    if (result.has(id)) continue
    const full = hex(id)
    let length = 4
    while (length < full.length && taken.has(full.slice(0, length))) length++
    taken.add(full.slice(0, length))
    result.set(id, full.slice(0, length))
  }
  return result
}

export function entries(store: Store): Entry[] {
  const sources = store.kind("source")
  const ids = sources.map((source) => recordId(source))
  const shorts = assignShorts(ids)
  // Grouped once by source id, so listing the library hashes each record a single time.
  const copies = new Map<Digest, CopyRecord[]>()
  const copySource = new Map<Digest, Digest>()
  for (const copy of store.kind("copy")) {
    copySource.set(recordId(copy), copy.body.source.id)
    if (copy.body.source.kind !== "source") continue
    copies.set(copy.body.source.id, [...(copies.get(copy.body.source.id) ?? []), copy])
  }
  const representations = new Map<Digest, RepresentationRecord[]>()
  for (const representation of store.kind("representation")) {
    const source = copySource.get(representation.body.copy.id)
    if (source) representations.set(source, [...(representations.get(source) ?? []), representation])
  }
  return sources.map((source, index) => {
    const id = ids[index]!
    return {
      source,
      short: shorts.get(id) ?? hex(id).slice(0, 4),
      copies: copies.get(id) ?? [],
      representations: representations.get(id) ?? [],
    }
  })
}

export function entryOf(store: Store, source: Ref): Entry | undefined {
  const id = source.id
  return entries(store).find((candidate) => recordId(candidate.source) === id)
}

export function entryOfShort(store: Store, short: string): Entry | undefined {
  return entries(store).find((candidate) => candidate.short === short)
}

/** The representation a source is read in: the most recently added one. */
export function latest(store: Store, source: Ref): Located | undefined {
  const entry = entryOf(store, source)
  return entry ? latestOfEntry(store, entry) : undefined
}

export function latestOfEntry(store: Store, entry: Entry): Located | undefined {
  const representation = entry.representations.at(-1)
  return representation ? locate(store, entry, representation) : undefined
}

export function representationOf(store: Store, ref: Ref): Located | undefined {
  for (const entry of entries(store)) {
    const representation = entry.representations.find((candidate) => recordId(candidate) === ref.id)
    if (representation) return locate(store, entry, representation)
  }
  return undefined
}

function locate(store: Store, entry: Entry, representation: RepresentationRecord): Located | undefined {
  const copy = store.get(representation.body.copy)
  if (copy.kind !== "copy") return undefined
  return {
    entry,
    source: entry.source,
    copy,
    representation,
    tree: readTree(store.text(representation.body.tree)),
  }
}

function readTree(text: string): Tree {
  const value: unknown = JSON.parse(text)
  const tree = value as Tree
  if (!Array.isArray(tree.nodes)) throw new Error("the stored structure tree is not a tree")
  return tree
}

export function addressOf(entry: Entry, node: { section: number; paragraph: number; sentence?: number }): string {
  return `${entry.short}:${node.section}/p${node.paragraph}${node.sentence === undefined ? "" : `/s${node.sentence}`}`
}
