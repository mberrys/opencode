import type { CopyBody, Digest, Envelope, Ref, RepresentationBody, SourceBody } from "@opencode/research-record"
import { hex, recordId, refOf, sameRef } from "@opencode/research-record"
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

/** Short ids are the shortest unique prefix of a source id, so every address reads the same to a person. */
export function assignShorts(ids: readonly Digest[]): Map<Digest, string> {
  const unique = [...new Set(ids)].sort()
  const result = new Map<Digest, string>()
  for (let length = 4; length <= 16 && result.size < unique.length; length++) {
    const remaining = unique.filter((id) => !result.has(id))
    const counts = new Map<string, number>()
    for (const id of remaining) {
      const prefix = hex(id).slice(0, length)
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }
    for (const id of remaining) {
      const prefix = hex(id).slice(0, length)
      if ((counts.get(prefix) ?? 0) === 1) result.set(id, prefix)
    }
  }
  for (const id of unique) if (!result.has(id)) result.set(id, hex(id).slice(0, 16))
  return result
}

export function entries(store: Store): Entry[] {
  const sources = store.kind("source")
  const copies = store.kind("copy")
  const representations = store.kind("representation")
  const shorts = assignShorts(sources.map((source) => recordId(source)))
  const copySource = new Map<Digest, Digest>()
  for (const copy of copies) copySource.set(recordId(copy), copy.body.source.id)
  const representationSource = new Map<Digest, Digest>()
  for (const representation of representations) {
    const source = copySource.get(representation.body.copy.id)
    if (source) representationSource.set(recordId(representation), source)
  }
  return sources.map((source) => {
    const id = recordId(source)
    return {
      source,
      short: shorts.get(id) ?? hex(id).slice(0, 4),
      copies: copies.filter((copy) => sameRef(copy.body.source, { kind: "source", id })),
      representations: representations.filter(
        (representation) => representationSource.get(recordId(representation)) === id,
      ),
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
  const representation = entry?.representations.at(-1)
  if (!entry || !representation) return undefined
  return locate(store, entry, representation)
}

export function latestOfEntry(store: Store, entry: Entry): Located | undefined {
  return latest(store, refOf(entry.source))
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
