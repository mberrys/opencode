export * as Tree from "./tree.js"

import { Schema } from "effect"
import type { Block } from "./extract.js"

/** The schema name of a stored structure tree, as a representation's `tree` blob names it. */
export const SCHEMA = "research-tree@1"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const NodeKind = Schema.Literals([
  "heading",
  "paragraph",
  "list-item",
  "quote",
  "table",
  "sentence",
  "reference",
])
export type NodeKind = typeof NodeKind.Type

export const Node = Schema.Struct({
  kind: NodeKind,
  text: Schema.String,
  /** UTF-8 byte offsets into the representation's text, as a fragment's selector counts them. */
  start: Count,
  end: Count,
  section: Count,
  paragraph: Count,
  sentence: Schema.optionalKey(Ordinal),
  heading: Schema.Array(Schema.String),
})
export interface Node extends Schema.Schema.Type<typeof Node> {}

export const Structure = Schema.Struct({
  nodes: Schema.Array(Node),
  sections: Count,
  paragraphs: Count,
  sentences: Count,
  /** The text's length in UTF-8 bytes. */
  bytes: Count,
})
export interface Structure extends Schema.Schema.Type<typeof Structure> {}

const decodeTree = Schema.decodeUnknownSync(Schema.fromJsonString(Structure))

/** A stored tree, refused unless it is a `research-tree@1` tree. */
export function decode(bytes: Uint8Array): Structure {
  return decodeTree(new TextDecoder().decode(bytes))
}

export function encode(tree: Structure) {
  return new TextEncoder().encode(JSON.stringify(tree))
}

export interface Extracted {
  readonly text: string
  readonly tree: Structure
}

const encoder = new TextEncoder()

/** Builds the structure tree once per copy and extractor version, so nothing later depends on re-running it. */
export function build(blocks: readonly Block[]): Extracted {
  let text = ""
  const nodes: Node[] = []
  const path: string[] = []
  let section = 0
  let paragraph = 0
  let paragraphs = 0
  let sentences = 0
  // Byte length of `text` so far, kept as a running total so each block is encoded once.
  let bytes = 0
  let inReferences = false

  for (const block of blocks) {
    if (text.length > 0) {
      text += "\n\n"
      bytes += 2
    }
    const start = bytes
    text += block.text
    bytes += encoder.encode(block.text).length
    const end = bytes

    if (block.kind === "heading") {
      section += 1
      paragraph = 0
      inReferences = /^(references|bibliography|works cited|literature cited)$/i.test(block.text.trim())
      path.length = Math.max(0, (block.level ?? 1) - 1)
      path[block.level ? block.level - 1 : 0] = block.text
      nodes.push({
        kind: "heading",
        text: block.text,
        start,
        end,
        section,
        paragraph: 0,
        heading: path.filter(Boolean),
      })
      continue
    }

    paragraph += 1
    paragraphs += 1
    const heading = path.filter(Boolean)
    nodes.push({
      kind: inReferences ? "reference" : block.kind,
      text: block.text,
      start,
      end,
      section,
      paragraph,
      heading,
    })

    let cursor = 0
    let sentenceIndex = 0
    for (const sentence of splitSentences(block.text)) {
      const index = block.text.indexOf(sentence, cursor)
      if (index < 0) continue
      cursor = index + sentence.length
      sentenceIndex += 1
      const sentenceStart = start + encoder.encode(block.text.slice(0, index)).length
      const sentenceEnd = sentenceStart + encoder.encode(sentence).length
      nodes.push({
        kind: "sentence",
        text: sentence,
        start: sentenceStart,
        end: sentenceEnd,
        section,
        paragraph,
        sentence: sentenceIndex,
        heading,
      })
      sentences += 1
    }
  }

  return {
    text,
    tree: {
      nodes,
      sections: section || (blocks.length > 0 ? 1 : 0),
      paragraphs,
      sentences,
      bytes,
    },
  }
}

/** Splits where a terminal mark stops a sentence and the next word starts a new one. Abbreviations are left for later. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["'”’)\]]*)\s+(?=["'“‘(\[]?[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function nodesOf(tree: Structure, kind: NodeKind): Node[] {
  return tree.nodes.filter((node) => node.kind === kind)
}

export function sentenceAt(
  tree: Structure,
  address: { section: number; paragraph: number; sentence?: number },
): Node[] {
  const inParagraph = tree.nodes.filter(
    (node) =>
      node.kind === "sentence" &&
      node.section === address.section &&
      node.paragraph === address.paragraph &&
      (address.sentence === undefined || node.sentence === address.sentence),
  )
  return inParagraph
}
