export type BlockKind = "heading" | "paragraph" | "list-item" | "quote" | "table"

export interface Block {
  readonly kind: BlockKind
  readonly text: string
  readonly level?: number
}

export const TEXT_MIME = "text/plain"
export const MARKDOWN_MIME = "text/markdown"
export const HTML_MIME = "text/html"
export const PDF_MIME = "application/pdf"

/** The extractor writes the text once; after this step nothing normalizes anything. */
export function blocksOf(mime: string, bytes: Uint8Array): Block[] | undefined {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  if (mime === HTML_MIME) return htmlBlocks(text)
  if (mime === MARKDOWN_MIME) return markdownBlocks(text)
  if (mime === TEXT_MIME) return textBlocks(text)
  if (mime === PDF_MIME) return undefined
  return textBlocks(text)
}

function textBlocks(text: string): Block[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({ kind: "paragraph" as const, text: block }))
}

function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let fenced = false
  let buffer: string[] = []
  let code: string[] = []
  const flush = () => {
    const joined = buffer.join("\n").trim()
    if (joined) blocks.push({ kind: "paragraph", text: inlineMarkdown(joined) })
    buffer = []
  }
  const flushCode = () => {
    const joined = code.join("\n").trim()
    if (joined) blocks.push({ kind: "paragraph", text: joined })
    code = []
  }
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      if (fenced) flush()
      else flushCode()
      continue
    }
    if (fenced) {
      code.push(raw)
      continue
    }
    if (!raw.trim()) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      flush()
      blocks.push({ kind: "heading", text: inlineMarkdown(heading[2]!.trim()), level: heading[1]!.length })
      continue
    }
    const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(raw)
    if (item) {
      flush()
      blocks.push({ kind: "list-item", text: inlineMarkdown(item[1]!.trim()) })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote) {
      flush()
      blocks.push({ kind: "quote", text: inlineMarkdown(quote[1]!.trim()) })
      continue
    }
    buffer.push(raw)
  }
  flush()
  return blocks
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
])

const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "head"])

/**
 * Walks the tags rather than matching balanced pairs, so a nested list stays one reading order. Headings carry
 * their level; everything else is a paragraph, list item, quote or table cell.
 */
function htmlBlocks(html: string): Block[] {
  const blocks: Block[] = []
  const source = html.replace(/<!--[\s\S]*?-->/g, " ")
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  let cursor = 0
  let buffer = ""
  let skip = 0
  let heading: number | undefined
  let kind: BlockKind = "paragraph"

  const flush = () => {
    const text = clean(buffer)
    if (text) blocks.push({ kind: heading ? "heading" : kind, text, ...(heading ? { level: heading } : {}) })
    buffer = ""
    kind = "paragraph"
  }

  for (const match of source.matchAll(tag)) {
    if (skip === 0) buffer += source.slice(cursor, match.index)
    cursor = match.index + match[0].length
    const name = match[1]!.toLowerCase()
    const closing = match[0].startsWith("</")
    if (SKIP_TAGS.has(name)) {
      skip = closing ? Math.max(0, skip - 1) : skip + 1
      continue
    }
    if (!BLOCK_TAGS.has(name)) continue
    if (skip > 0) continue
    flush()
    if (name === "li") kind = "list-item"
    if (name === "td" || name === "th") kind = "table"
    if (name === "blockquote") kind = "quote"
    if (/^h[1-6]$/.test(name)) heading = closing ? undefined : Number(name.slice(1))
  }
  if (skip === 0) buffer += source.slice(cursor)
  flush()
  return blocks
}

function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // A reference outside Unicode, or to a surrogate, is left as written rather than thrown on.
      const scalar = code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      return scalar ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}
