import { describe, expect, test } from "bun:test"
import { buildTree, sentenceAt, splitSentences } from "../src/tree.js"

const encoder = new TextEncoder()

describe("the structure tree", () => {
  test("every node span is the node's own bytes in the text", () => {
    const { text, tree } = buildTree([
      { kind: "paragraph", text: "Intro one. Intro two." },
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
})
