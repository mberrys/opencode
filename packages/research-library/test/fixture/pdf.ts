/** One line of text drawn on a page: font size in points, baseline origin in PDF user space. */
export interface Drawn {
  readonly size: number
  readonly x: number
  readonly y: number
  readonly text: string
}

/** A minimal PDF with a text layer in Helvetica, one US Letter page per array, so tests need no binary fixtures. */
export function makePdf(pages: readonly (readonly Drawn[])[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => objects.push(body)
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
  const parent = add("")
  const kids = pages.map((lines) => {
    const stream = lines
      .map((line) => `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td (${line.text.replace(/([()\\])/g, "\\$1")}) Tj ET`)
      .join("\n")
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    return add(
      `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    )
  })
  objects[parent - 1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`
  const catalog = add(`<< /Type /Catalog /Pages ${parent} 0 R >>`)
  let out = "%PDF-1.4\n"
  const offsets = objects.map((body, index) => {
    const offset = out.length
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const body = (y: number, text: string): Drawn => ({ size: 11, x: 72, y, text })
const head = (page: number): Drawn[] => [
  { size: 9, x: 72, y: 760, text: "Western and Rosenfeld, Unions and inequality" },
  { size: 9, x: 300, y: 40, text: String(page) },
]

/** A three-page paper: a wrapped title, hyphenated lines, a paragraph that runs onto page 2, and a reference list. */
export const PAPER = makePdf([
  [
    ...head(1),
    { size: 18, x: 72, y: 700, text: "Union decline and wage" },
    { size: 18, x: 72, y: 678, text: "inequality" },
    { size: 13, x: 72, y: 640, text: "1 Introduction" },
    body(620, "Union decline explains about a fifth of the rise in wage in-"),
    body(606, "equality. The rest comes from changes in the returns to edu-"),
    body(592, "cation."),
    body(570, "Some argue unions mattered little and that the decline was"),
    body(556, "slow. They point to"),
  ],
  [
    ...head(2),
    body(700, "trade instead, and to technology."),
    { size: 13, x: 72, y: 660, text: "References" },
    body(640, "[1] Western, B. and Rosenfeld, J. (2011). Unions, norms,"),
    body(626, "and the rise in US wage inequality."),
    body(612, "[2] Card, D. (2001). The effect of unions on wage inequality."),
  ],
  [...head(3), { size: 13, x: 72, y: 700, text: "Appendix A" }, body(680, "Appendix text.")],
])
