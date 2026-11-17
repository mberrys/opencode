import { describe, expect, test } from "bun:test"
import { digest, ref, cut, verifyFragment } from "@opencode/research-record"
import type { Block } from "../src/extract.js"
import { buildTree, sentenceAt, splitSentences } from "../src/tree.js"

const encoder = new TextEncoder()

describe("the structure tree", () => {
  test("every node span is the node's own bytes in the text", () => {
    const { text, tree } = buildTree([
      { kind: "paragraph", text: "Intro one — naïve. Intro two." },
      { kind: "heading", text: "Methods", level: 1 },
      { kind: "paragraph", text: "We sampled forty cases. We counted them." },
    ])
    const bytes = encoder.encode(text)
    for (const node of tree.nodes) {
      expect(new TextDecoder().decode(bytes.subarray(node.start, node.end))).toBe(node.text)
    }
  })

  test("paragraphs before the first heading are section zero, and a heading opens the next section", () => {
    const { tree } = buildTree([
      { kind: "paragraph", text: "Intro." },
      { kind: "heading", text: "Methods", level: 1 },
      { kind: "paragraph", text: "We sampled." },
    ])
    expect(tree.nodes.map((node) => [node.kind, node.section, node.paragraph])).toEqual([
      ["paragraph", 0, 1],
      ["sentence", 0, 1],
      ["heading", 1, 0],
      ["paragraph", 1, 1],
      ["sentence", 1, 1],
    ])
    // The total counts every section, not only the last one.
    expect(tree.paragraphs).toBe(2)
  })

  test("sentences are numbered inside their paragraph and carry the heading path", () => {
    const { tree } = buildTree([
      { kind: "heading", text: "Results", level: 1 },
      { kind: "heading", text: "Wages", level: 2 },
      { kind: "paragraph", text: "Wages fell. Then they rose again." },
    ])
    const sentences = tree.nodes.filter((node) => node.kind === "sentence")
    expect(sentences.map((node) => [node.sentence, node.text])).toEqual([
      [1, "Wages fell."],
      [2, "Then they rose again."],
    ])
    expect(sentences[0]!.heading).toEqual(["Results", "Wages"])
    expect(tree.sections).toBe(2)
  })

  test("a reference list is marked as references", () => {
    const { tree } = buildTree([
      { kind: "heading", text: "References", level: 1 },
      { kind: "paragraph", text: "Western, B. (2011). Unions and norms." },
    ])
    expect(tree.nodes.filter((node) => node.kind === "reference")).toHaveLength(1)
  })

  test("sentence split leaves abbreviations for later, but splits at a real stop", () => {
    expect(splitSentences("Wages fell. Then they rose.")).toEqual(["Wages fell.", "Then they rose."])
    expect(splitSentences("It was the U.S. case that mattered.")).toHaveLength(1)
    expect(splitSentences("“Quoted stop.” Next one.")).toEqual(["“Quoted stop.”", "Next one."])
  })

  test("reading a sentence range starts where the address says", () => {
    const { tree } = buildTree([{ kind: "paragraph", text: "One. Two. Three." }])
    expect(sentenceAt(tree, { section: 0, paragraph: 1 }).map((node) => node.text)).toEqual(["One.", "Two.", "Three."])
    expect(sentenceAt(tree, { section: 0, paragraph: 1, sentence: 2 }).map((node) => node.text)).toEqual(["Two."])
  })
  test("a seeded sweep: every sentence the tree records cuts to itself and verifies", () => {
    let state = 0x7ee
    const next = () => {
      state = (state + 0x6d2b79f5) | 0
      let value = Math.imul(state ^ (state >>> 15), 1 | state)
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
    const words = ["Union", "naïve", "研究", "décline", "😀", "co-op", "“quoted”", "(aside)", "5.2%", "Ü"]
    const sentence = () =>
      Array.from({ length: 2 + Math.floor(next() * 8) }, () => words[Math.floor(next() * words.length)]).join(" ") +
      [".", "!", "?", "."][Math.floor(next() * 4)]
    const blocks: Block[] = Array.from({ length: 80 }, (_, index) =>
      index % 9 === 0
        ? { kind: "heading", text: `Section ${index} — ${words[index % words.length]}`, level: 1 + (index % 3) }
        : { kind: "paragraph", text: Array.from({ length: 1 + Math.floor(next() * 5) }, sentence).join(" ") },
    )
    const { text, tree } = buildTree(blocks)
    const bytes = encoder.encode(text)
    const representation = ref("representation", digest({ sweep: 1 }))
    const broken = tree.nodes.flatMap((node) => {
      if (new TextDecoder().decode(bytes.subarray(node.start, node.end)) !== node.text) return [`span ${node.start}..${node.end}`]
      if (node.kind !== "sentence") return []
      const fragment = cut({ representation, text: bytes, start: node.start, end: node.end, address: "k7f2:1/p1/s1" })
      if (fragment.quote !== node.text) return [`quote ${node.start}..${node.end}`]
      return verifyFragment(fragment, bytes).ok ? [] : [`verify ${node.start}..${node.end}`]
    })
    expect(tree.sentences).toBeGreaterThan(50)
    expect(broken).toEqual([])
  })
})
