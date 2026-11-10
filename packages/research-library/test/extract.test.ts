import { describe, expect, test } from "bun:test"
import { HTML_MIME, MARKDOWN_MIME, PDF_MIME, TEXT_MIME, blocksOf, decodeEntities } from "../src/extract.js"

const encoder = new TextEncoder()

describe("extraction", () => {
  test("markdown headings, lists, quotes and inline markers become blocks", () => {
    const markdown = [
      "# Title",
      "",
      "First paragraph with **bold** and [a link](https://example.org).",
      "",
      "- one",
      "- two",
      "",
      "> quoted",
      "",
      "## Sub",
      "",
      "Second paragraph.",
    ].join("\n")
    expect(blocksOf(MARKDOWN_MIME, encoder.encode(markdown))).toEqual([
      { kind: "heading", text: "Title", level: 1 },
      { kind: "paragraph", text: "First paragraph with bold and a link." },
      { kind: "list-item", text: "one" },
      { kind: "list-item", text: "two" },
      { kind: "quote", text: "quoted" },
      { kind: "heading", text: "Sub", level: 2 },
      { kind: "paragraph", text: "Second paragraph." },
    ])
  })

  test("a fenced code block stays one paragraph", () => {
    const markdown = "Before.\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter."
    expect(blocksOf(MARKDOWN_MIME, encoder.encode(markdown))).toEqual([
      { kind: "paragraph", text: "Before." },
      { kind: "paragraph", text: "const a = 1\n\nconst b = 2" },
      { kind: "paragraph", text: "After." },
    ])
  })

  test("html is read in order with headings, lists and cells kept apart", () => {
    const html = [
      "<html><head><title>Fallback</title><script>var hidden = 1</script></head>",
      "<body><h1>Heading</h1><p>One &amp; two.</p>",
      "<ul><li>Item <b>bold</b></li></ul>",
      "<table><tr><td>cell</td></tr></table>",
      "</body></html>",
    ].join("")
    expect(blocksOf(HTML_MIME, encoder.encode(html))).toEqual([
      { kind: "heading", text: "Heading", level: 1 },
      { kind: "paragraph", text: "One & two." },
      { kind: "list-item", text: "Item bold" },
      { kind: "table", text: "cell" },
    ])
  })

  test("plain text splits on blank lines and keeps single newlines", () => {
    expect(blocksOf(TEXT_MIME, encoder.encode("Para one\nstill one.\n\nPara two."))).toEqual([
      { kind: "paragraph", text: "Para one\nstill one." },
      { kind: "paragraph", text: "Para two." },
    ])
  })

  test("a pdf has no extractor yet, and says so by returning nothing", () => {
    expect(blocksOf(PDF_MIME, new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeUndefined()
  })

  test("entities decode by name and by code point", () => {
    expect(decodeEntities("a &amp; b &#233; &#x1F600; &unknown;")).toBe("a & b é 😀 &unknown;")
  })
})
