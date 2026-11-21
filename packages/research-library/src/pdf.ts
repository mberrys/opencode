export * as Pdf from "./pdf.js"

import type { Block, Placed } from "./extract.js"

/**
 * The PDF extractor's id and version as a representation records them. The version names pdf.js too, because a
 * different pdf.js can lay the same bytes out as different text.
 */
export const ID = "research-pdf"
export const PDFJS = "6.4.299"
export const VERSION = `1+pdfjs-${PDFJS}`

export interface Extracted {
  readonly blocks: Block[]
  readonly pages: number
  /** Lines dropped as running headers, footers or page numbers. */
  readonly dropped: number
}

type Box = [number, number, number, number]

interface Line {
  text: string
  readonly page: number
  readonly size: number
  box: Box
}

interface TextItem {
  readonly str: string
  readonly transform: readonly number[]
  readonly width: number
  readonly height: number
  readonly hasEOL: boolean
}

/**
 * Reads the text layer of a PDF into blocks, each run of which keeps the page and box it was printed in. A PDF
 * without a text layer (a scan) yields no blocks; OCR is not done here.
 *
 * GUESS: reading order is the content stream's order, which is right for most born-digital papers (LaTeX, Word) and
 * wrong for some two-column layouts and for tables.
 */
export async function blocks(bytes: Uint8Array): Promise<Extracted> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
  // pdf.js takes ownership of the buffer it is given, so it reads a copy.
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  try {
    const document = await task.promise
    const pages: { lines: Line[]; height: number }[] = []
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const [, y0, , y1] = page.view
      pages.push({ lines: linesOf(content.items as TextItem[], number), height: Math.abs(y1 - y0) || 792 })
      page.cleanup()
    }
    const kept = dropRunning(pages)
    return {
      blocks: group(kept.lines),
      pages: document.numPages,
      dropped: kept.dropped,
    }
  } finally {
    await task.destroy()
  }
}

/** Items that share a baseline join into a line; a gap wider than a fifth of the font size becomes a space. */
function linesOf(items: readonly TextItem[], page: number): Line[] {
  const lines: Line[] = []
  let current: Line | undefined
  let endX = 0
  let broken = false
  for (const item of items) {
    const size = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height
    const x = item.transform[4] ?? 0
    const y = item.transform[5] ?? 0
    if (item.str.trim() === "") {
      if (item.str.length > 0 && current !== undefined && !current.text.endsWith(" ")) current.text += " "
      if (item.hasEOL) broken = true
      continue
    }
    // Rounded to a hundredth of a point, so every verifier writes the same number in canonical JSON.
    const box: Box = [round(x), round(y), round(x + item.width), round(y + size)]
    const sameLine =
      current !== undefined && !broken && Math.abs(y - current.box[1]) < Math.max(current.size, size) * 0.5
    if (!sameLine) {
      if (current !== undefined) lines.push(current)
      current = { text: item.str, page, size, box }
    } else {
      const gap = x - endX
      if (gap > size * 0.2 && !current!.text.endsWith(" ") && !item.str.startsWith(" ")) current!.text += " "
      current!.text += item.str
      current!.box = [
        Math.min(current!.box[0], box[0]),
        Math.min(current!.box[1], box[1]),
        Math.max(current!.box[2], box[2]),
        Math.max(current!.box[3], box[3]),
      ]
    }
    endX = x + item.width
    broken = item.hasEOL
  }
  if (current !== undefined) lines.push(current)
  return lines.flatMap((line) => {
    const text = line.text.replace(/\s+/g, " ").trim()
    return text === "" ? [] : [{ ...line, text }]
  })
}

/**
 * Drops bare page numbers in the top or bottom tenth of a page, and lines that repeat in those margins on at least
 * three pages and half of all pages (running heads), counting digits as alike.
 *
 * GUESS: the margin and repeat thresholds are tuned on nothing yet; a short heading that repeats in the margin of
 * every page would be dropped too.
 */
function dropRunning(pages: readonly { lines: Line[]; height: number }[]) {
  const inMargin = (line: Line, height: number) => line.box[1] < height * 0.1 || line.box[1] > height * 0.9
  const shape = (text: string) => text.toLowerCase().replace(/\d+/g, "#")
  const seen = new Map<string, Set<number>>()
  for (const page of pages)
    for (const line of page.lines)
      if (inMargin(line, page.height))
        seen.set(shape(line.text), (seen.get(shape(line.text)) ?? new Set()).add(line.page))
  const running = (text: string) => {
    const on = seen.get(shape(text))?.size ?? 0
    return pages.length >= 3 && on >= 3 && on >= pages.length / 2
  }
  let dropped = 0
  const lines = pages.flatMap((page) =>
    page.lines.filter((line) => {
      const drop = inMargin(line, page.height) && (/^(?:page\s+)?[0-9ivxlc]+$/i.test(line.text) || running(line.text))
      if (drop) dropped += 1
      return !drop
    }),
  )
  return { lines, dropped }
}

const NAMED_SECTION =
  /^(?:(?:\d+(?:\.\d+)*|[IVX]+|[A-Z])\.?\s+)?(abstract|introduction|background|related work|preliminaries|methods?|materials and methods|methodology|data|experiments?|results|results and discussion|discussion|limitations|conclusions?|acknowledge?ments?|references|bibliography|works cited|literature cited|appendix(?:\s+[A-Z0-9]{1,3}(?:[:.]\s.*)?)?)$/i
const NUMBERED_HEADING = /^((?:\d+\.)*\d+)\.?\s+[A-Z][^.!?]{0,100}$/
const REFERENCES = /^(references|bibliography|works cited|literature cited)$/i
const REFERENCE_START = /^(?:\[\d+\]|\d+\.\s)/

/**
 * Lines become blocks. A line is a heading when its font is clearly larger than the body's, or when it names a usual
 * section of a paper. A paragraph ends at a wide vertical gap, or after a short line that ends a sentence. Inside a
 * reference list, a line that starts `[n]` or `n.` starts a new entry.
 *
 * GUESS: a word hyphenated across a line break is joined without its hyphen when the next line starts in lower case,
 * so `compu-` + `tation` reads `computation`; a hyphenated compound split at its hyphen (`well-` + `known`) loses the
 * hyphen too. The quote is then of the joined word, not of the glyphs as printed.
 */
function group(lines: readonly Line[]): Block[] {
  if (lines.length === 0) return []
  const body = median(lines.flatMap((line) => Array<number>(Math.min(line.text.length, 200)).fill(line.size)))
  const leading = median(
    lines.flatMap((line, index) => {
      const next = lines[index + 1]
      if (next === undefined || next.page !== line.page || Math.abs(next.size - body) > 0.5) return []
      const gap = line.box[1] - next.box[1]
      return gap > 0 ? [gap] : []
    }),
  )

  const blocks: Block[] = []
  let text = ""
  let layout: Placed[] = []
  let references = false
  const flush = () => {
    if (text !== "") blocks.push({ kind: "paragraph", text, layout })
    text = ""
    layout = []
  }
  const append = (line: Line) => {
    if (text === "") {
      text = line.text
      layout = [{ start: 0, end: line.text.length, page: line.page, box: line.box }]
      return
    }
    const hyphenated = /\p{L}-$/u.test(text) && /^\p{Ll}/u.test(line.text)
    if (hyphenated) text = text.slice(0, -1)
    else text += " "
    const start = text.length
    text += line.text
    layout.push({ start, end: text.length, page: line.page, box: line.box })
  }

  let previous: Line | undefined
  let before: Line | undefined
  for (const line of lines) {
    const large = line.size >= body * 1.15 && line.text.length <= 160
    const named = NAMED_SECTION.exec(line.text)
    const numbered = line.size >= body - 0.5 && NUMBERED_HEADING.test(line.text) && !references
    if (large || named !== null || numbered) {
      flush()
      const depth = /^((?:\d+\.)*\d+)/.exec(line.text)?.[1]?.split(".").length
      // Consecutive heading lines of one size are one heading wrapped over lines.
      const last = blocks.at(-1)
      if (
        last?.kind === "heading" &&
        previous !== undefined &&
        previous.size === line.size &&
        large &&
        depth === undefined
      ) {
        blocks.pop()
        text = last.text
        layout = [...(last.layout ?? [])]
        append(line)
        blocks.push({ kind: "heading", text, layout, level: last.level })
        text = ""
        layout = []
      } else {
        blocks.push({
          kind: "heading",
          text: line.text,
          level: depth ?? 1,
          layout: [{ start: 0, end: line.text.length, page: line.page, box: line.box }],
        })
      }
      references = REFERENCES.test((named?.[1] ?? line.text).trim())
      before = undefined
      previous = line
      continue
    }
    if (previous !== undefined && text !== "" && breaks(before, previous, line, { leading, body, references })) flush()
    append(line)
    before = previous
    previous = line
  }
  flush()
  return blocks
}

/**
 * Whether a paragraph ends between `previous` and `line`. A line is short when it stops well before the right edge of
 * a neighbouring line in its column, so the measure holds in one- and two-column layouts alike.
 */
function breaks(
  before: Line | undefined,
  previous: Line,
  line: Line,
  measure: { leading: number; body: number; references: boolean },
) {
  if (measure.references && REFERENCE_START.test(line.text)) return true
  if (Math.abs(line.size - previous.size) > 0.5) return true
  const column = (other: Line | undefined) =>
    other !== undefined && other.page === previous.page && Math.abs(other.box[0] - previous.box[0]) < measure.body * 2
  const edge = Math.max(column(before) ? before!.box[2] : 0, column(line) ? line.box[2] : 0)
  const ended = /[.!?:]["'”’)\]]*$/.test(previous.text)
  if (ended && previous.box[2] < edge - measure.body * 3) return true
  if (line.page !== previous.page) return false
  const gap = previous.box[1] - line.box[1]
  // A line above the previous one starts a new column, and continues the paragraph.
  if (gap <= 0) return false
  return measure.leading > 0 && gap > measure.leading * 1.6
}

function median(values: readonly number[]) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
