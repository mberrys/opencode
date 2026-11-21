import { describe, expect, test } from "bun:test"
import { Pdf } from "../src/pdf.js"
import { Tree } from "../src/tree.js"
import { PAPER, makePdf } from "./fixture/pdf.js"

describe("reading a PDF's text layer", () => {
  test("finds headings, joins hyphenated lines, and leaves out running heads and page numbers", async () => {
    const read = await Pdf.blocks(PAPER)
    expect(read.pages).toBe(3)
    expect(read.dropped).toBe(6)
    expect(read.blocks.map((block) => [block.kind, block.text])).toEqual([
      ["heading", "Union decline and wage inequality"],
      ["heading", "1 Introduction"],
      [
        "paragraph",
        "Union decline explains about a fifth of the rise in wage inequality. The rest comes from changes in the returns to education.",
      ],
      [
        "paragraph",
        "Some argue unions mattered little and that the decline was slow. They point to trade instead, and to technology.",
      ],
      ["heading", "References"],
      ["paragraph", "[1] Western, B. and Rosenfeld, J. (2011). Unions, norms, and the rise in US wage inequality."],
      ["paragraph", "[2] Card, D. (2001). The effect of unions on wage inequality."],
      ["heading", "Appendix A"],
      ["paragraph", "Appendix text."],
    ])
  })

  test("keeps each line's page and box, in byte offsets once the tree is built", async () => {
    const { tree, text } = Tree.build((await Pdf.blocks(PAPER)).blocks)
    const bytes = new TextEncoder().encode(text)
    expect(tree.layout?.length).toBeGreaterThan(0)
    for (const placed of tree.layout ?? []) expect(placed.end).toBeLessThanOrEqual(bytes.length)
    const spanning = tree.nodes.find((node) => node.kind === "sentence" && node.text.startsWith("They point to"))!
    expect(Tree.pageAt(tree, spanning.start)).toBe(1)
    // The sentence runs onto page 2; a fragment names the page it starts on, with that page's lines.
    const placement = Tree.placement(tree, spanning.start, spanning.end)
    expect(placement).not.toBe("none")
    if (placement === "none") return
    expect(placement.number).toBe(1)
    expect(placement.boxes).toHaveLength(1)
    expect(placement.boxes[0]![1]).toBe(556)
    const references = tree.nodes.filter((node) => node.kind === "reference")
    expect(references.map((node) => node.text.slice(0, 3))).toEqual(["[1]", "[2]"])
  })

  test("a PDF with no text layer yields no blocks, and a broken one is refused", async () => {
    expect((await Pdf.blocks(makePdf([[]]))).blocks).toEqual([])
    expect(Pdf.blocks(new TextEncoder().encode("%PDF-1.7 bytes"))).rejects.toThrow()
  })
})
