import type { Block } from "./extract.js"

export type NodeKind = "heading" | "paragraph" | "list-item" | "quote" | "table" | "sentence" | "reference"

export interface TreeNode {
  readonly kind: NodeKind
  readonly text: string
  /** Byte offset into the representation's text. The address is display; this is the authority. */
  readonly start: number
  readonly end: number
  readonly section: number
  readonly paragraph: number
  readonly sentence?: number
  readonly heading: readonly string[]
}

export interface Tree {
  readonly nodes: readonly TreeNode[]
  readonly sections: number
  readonly paragraphs: number
  readonly sentences: number
  readonly characters: number
}

export interface Extracted {
  readonly text: string
  readonly tree: Tree
}

const encoder = new TextEncoder()

/** Builds the structure tree once per copy and extractor version, so nothing later depends on re-running it. */
export function buildTree(blocks: readonly Block[]): Extracted {
  let text = ""
  const nodes: TreeNode[] = []
  const path: string[] = []
  let section = 0
  let paragraph = 0
  let sentences = 0
  let inReferences = false

  for (const block of blocks) {
    if (text.length > 0) text += "\n\n"
    const start = encoder.encode(text).length
    text += block.text
    const end = encoder.encode(text).length

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
    const heading = path.filter(Boolean)
    nodes.push({ kind: inReferences ? "reference" : block.kind, text: block.text, start, end, section, paragraph, heading })

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
      paragraphs: paragraph,
      sentences,
      characters: text.length,
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

export function nodesOf(tree: Tree, kind: NodeKind): TreeNode[] {
  return tree.nodes.filter((node) => node.kind === kind)
}

export function sentenceAt(tree: Tree, address: { section: number; paragraph: number; sentence?: number }): TreeNode[] {
  const inParagraph = tree.nodes.filter(
    (node) =>
      node.kind === "sentence" &&
      node.section === address.section &&
      node.paragraph === address.paragraph &&
      (address.sentence === undefined || node.sentence === address.sentence),
  )
  return inParagraph
}
