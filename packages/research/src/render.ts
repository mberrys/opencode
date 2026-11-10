import { type Csl, type Envelope, type FragmentBody, type Ref, type TierResult, formatRef, refOf, verifyFragment } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { gapsOf } from "./evidence.js"
import { type ClaimRecord, evidenceFor, tierOf } from "./tier.js"

export interface Rendered {
  readonly markdown: string
  readonly html: string
  readonly bib: string
  readonly ris: string
  readonly sources: readonly Ref[]
}

interface Citation {
  readonly source: Ref
  readonly csl: Csl
  readonly number: number
}

interface CardLine {
  readonly number: number
  readonly verified: boolean
  readonly role: string
  readonly source: Ref
  readonly address: string
  readonly quote: string
  readonly before: string
  readonly after: string
  readonly flags: readonly string[]
}

interface ClaimLine {
  readonly ref: Ref
  readonly text: string
  readonly tier: TierResult
  readonly rejected: boolean
  readonly cards: readonly CardLine[]
  readonly numbers: readonly number[]
}

/** Renders an answer artifact: tier marked sentences, then every card, then the gaps. */
export function renderAnswer(store: Store, answer: Ref): Rendered {
  const artifact = store.find(answer)
  if (artifact?.kind !== "artifact" || artifact.body.type !== "answer")
    throw new Error(`${formatRef(answer)} is not an answer`)
  const body = artifact.body
  const citations = new Map<string, Citation>()
  const claims = new Map<string, ClaimLine>()

  const sentenceLines = body.sentences.map((sentence) => {
    if (!sentence.claim) return { text: sentence.text, claim: undefined as ClaimLine | undefined, numbers: [] as number[] }
    const record = store.find(sentence.claim)
    if (record?.kind !== "claim") return { text: sentence.text, claim: undefined, numbers: [] }
    const key = formatRef(refOf(record))
    const existing = claims.get(key)
    const line = existing ?? buildClaim(store, record, citations)
    claims.set(key, line)
    return { text: sentence.text, claim: line, numbers: line.numbers }
  })

  const markdown = ["# Answer", "", ...sentenceLines.map((line) => renderSentence(line)), "", "## Evidence", ""]
  for (const claim of claims.values()) {
    markdown.push(`### [${claim.numbers.join(", ")}] ${claim.text}`, "")
    markdown.push(
      `Tier: **${claim.tier.tier}**${claim.rejected ? " (rejected by the researcher)" : ""}${claim.tier.flags.length ? ` (${claim.tier.flags.join(", ")})` : ""}`,
    )
    markdown.push("")
    for (const card of claim.cards) {
      markdown.push(`> ${card.before}**${card.quote}**${card.after}`, "")
      markdown.push(
        card.verified
          ? `- ${formatRef(card.source)} (${card.role}) at \`${card.address}\``
          : `- [unverified, the quote no longer matches its bytes] (${card.role}) at \`${card.address}\``,
      )
      if (card.flags.length > 0) markdown.push(`- flags: ${card.flags.join(", ")}`)
      markdown.push("")
    }
  }
  markdown.push("## References", "")
  for (const citation of [...citations.values()].sort((a, b) => a.number - b.number)) {
    markdown.push(`${citation.number}. ${reference(citation.csl)}`, "")
  }
  const gaps = gapsOf(store, body.run)
  if (gaps.length > 0) {
    markdown.push("## Gaps", "")
    for (const gap of gaps) {
      markdown.push(`- **${gap.subquestion}**: ${gap.why} Searched: ${gap.searched.join("; ")}. To close: ${gap.howToClose}`)
    }
    markdown.push("")
  }

  return {
    markdown: markdown.join("\n"),
    html: renderHtml(sentenceLines, [...claims.values()], [...citations.values()], gaps),
    bib: bibliography([...citations.values()]),
    ris: risOf([...citations.values()]),
    sources: [...citations.values()].sort((a, b) => a.number - b.number).map((citation) => citation.source),
  }
}

function buildClaim(store: Store, claim: ClaimRecord, citations: Map<string, Citation>): ClaimLine {
  const cards = evidenceFor(store, refOf(claim)).flatMap((link) => {
    if (link.body.target.kind !== "fragment") return []
    const fragment = store.find(link.body.target.fragment)
    if (fragment?.kind !== "fragment") return []
    const source = sourceOf(store, refOf(fragment))
    // A card whose bytes no longer match is shown, but it never earns a citation number.
    const verified = verifies(store, fragment)
    const citation = verified && source ? numberFor(source.ref, source.csl, citations) : undefined
    return [
      {
        number: citation?.number ?? 0,
        verified,
        role: link.body.role,
        source: source?.ref ?? refOf(fragment),
        address: fragment.body.address,
        quote: fragment.body.quote,
        before: fragment.body.before,
        after: fragment.body.after,
        flags: fragment.body.flags,
      },
    ]
  })
  const tier = tierOf(store, claim)
  return {
    ref: refOf(claim),
    text: claim.body.text,
    tier,
    rejected: tier.rejected,
    cards,
    numbers: [...new Set(cards.filter((card) => card.verified).map((card) => card.number).filter(Boolean))],
  }
}

function numberFor(source: Ref, csl: Csl, citations: Map<string, Citation>): Citation | undefined {
  const key = formatRef(source)
  const existing = citations.get(key)
  if (existing) return existing
  const citation = { source, csl, number: citations.size + 1 }
  citations.set(key, citation)
  return citation
}

function renderSentence(line: { text: string; claim?: ClaimLine }): string {
  if (!line.claim) return `${line.text} **[unsupported]**`
  const marks = line.claim.numbers.map((number) => `[${number}]`).join("")
  const state = line.claim.rejected ? "rejected" : line.claim.tier.tier
  const tier = line.claim.rejected || line.claim.tier.tier !== "adopted" ? ` *(${state})*` : ""
  return `${line.text}${marks}${tier}`
}

function verifies(store: Store, fragment: Envelope<"fragment", FragmentBody>): boolean {
  try {
    const record = store.find(fragment.body.representation)
    if (record?.kind !== "representation" || !store.blobs.has(record.body.text)) return false
    return verifyFragment(fragment.body, store.blobs.get(record.body.text)).ok
  } catch {
    return false
  }
}

function sourceOf(store: Store, fragment: Ref): { ref: Ref; csl: Csl } | undefined {
  const record = store.find(fragment)
  if (record?.kind !== "fragment") return undefined
  const representation = store.find(record.body.representation)
  if (representation?.kind !== "representation") return undefined
  const copy = store.find(representation.body.copy)
  if (copy?.kind !== "copy") return undefined
  const source = store.find(copy.body.source)
  if (source?.kind !== "source") return undefined
  return { ref: refOf(source), csl: source.body.csl }
}

export function reference(csl: Csl): string {
  const authors = csl.author ?? csl.editor ?? []
  const names =
    authors.length === 0
      ? "Anonymous"
      : authors.length === 1
        ? `${authors[0]!.family}, ${initials(authors[0]!.given)}`
        : `${authors.slice(0, -1).map((author) => `${author.family}, ${initials(author.given)}`).join(", ")}, & ${authors.at(-1)!.family}, ${initials(authors.at(-1)!.given)}`
  const year = csl.issued?.["date-parts"]?.[0]?.[0] ?? "n.d."
  const container = csl.container ? ` *${csl.container}*` : csl.publisher ? ` ${csl.publisher}.` : ""
  const link = csl.DOI ? ` https://doi.org/${csl.DOI}` : csl.URL ? ` ${csl.URL}` : ""
  return `${names} (${year}). ${csl.title}.${container}${link}`.replace(/\s+/g, " ").trim()
}

function initials(given: string | undefined): string {
  if (!given) return ""
  return given
    .split(/\s+/)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}.`)
    .join(" ")
}

export function bibliography(citations: readonly Citation[]): string {
  return citations
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((citation) => {
      const key = `${(citation.csl.author?.[0]?.family ?? "anon").toLowerCase().replace(/[^a-z]/g, "")}${citation.csl.issued?.["date-parts"]?.[0]?.[0] ?? "nd"}`
      const authors = (citation.csl.author ?? []).map((author) => `${author.family}, ${author.given ?? ""}`).join(" and ")
      const fields = [
        `  author = {${authors}}`,
        `  title = {${citation.csl.title}}`,
        citation.csl.container ? `  journal = {${citation.csl.container}}` : undefined,
        citation.csl.publisher ? `  publisher = {${citation.csl.publisher}}` : undefined,
        citation.csl.issued ? `  year = {${citation.csl.issued["date-parts"][0]?.[0]}}` : undefined,
        citation.csl.DOI ? `  doi = {${citation.csl.DOI}}` : undefined,
        citation.csl.URL ? `  url = {${citation.csl.URL}}` : undefined,
      ].filter(Boolean)
      return `@article{${key},\n${fields.join(",\n")}\n}`
    })
    .join("\n\n")
}

export function risOf(citations: readonly Citation[]): string {
  return citations
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((citation) =>
      [
        citation.csl.container ? "TY  - JOUR" : "TY  - GEN",
        ...(citation.csl.author ?? []).map((author) => `AU  - ${author.family}${author.given ? `, ${author.given}` : ""}`),
        `TI  - ${citation.csl.title}`,
        citation.csl.issued ? `PY  - ${citation.csl.issued["date-parts"][0]?.[0]}` : undefined,
        citation.csl.container ? `JO  - ${citation.csl.container}` : undefined,
        citation.csl.publisher ? `PB  - ${citation.csl.publisher}` : undefined,
        citation.csl.DOI ? `DO  - ${citation.csl.DOI}` : undefined,
        citation.csl.URL ? `UR  - ${citation.csl.URL}` : undefined,
        "ER  - ",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
}

function renderHtml(
  sentences: readonly { text: string; claim?: ClaimLine; numbers: readonly number[] }[],
  claims: readonly ClaimLine[],
  citations: readonly Citation[],
  gaps: readonly { subquestion: string; why: string; searched: readonly string[]; howToClose: string }[],
): string {
  const body = sentences
    .map((line) =>
      line.claim
        ? `<p>${escape(line.text)}<sup>${line.numbers.join(",")}</sup>${line.claim.rejected ? " <em>(rejected)</em>" : line.claim.tier.tier === "adopted" ? "" : ` <em>(${line.claim.tier.tier})</em>`}</p>`
        : `<p>${escape(line.text)} <strong>[unsupported]</strong></p>`,
    )
    .join("\n")
  const evidence = claims
    .map(
      (claim) =>
        `<section><h3>[${claim.numbers.join(", ")}] ${escape(claim.text)}</h3><p>Tier: <strong>${claim.tier.tier}</strong></p>${claim.cards
          .map(
            (card) =>
              `<blockquote>${escape(card.before)}${card.verified ? `<mark>${escape(card.quote)}</mark>` : `<del>${escape(card.quote)}</del>`}${escape(card.after)}</blockquote><p><code>${escape(card.address)}</code>${card.verified ? "" : " <strong>[unverified]</strong>"}${card.flags.length ? ` flags: ${escape(card.flags.join(", "))}` : ""}</p>`,
          )
          .join("\n")}</section>`,
    )
    .join("\n")
  const references = citations
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((citation) => `<li>${escape(reference(citation.csl))}</li>`)
    .join("\n")
  const gapSection = gaps.length
    ? `<section><h2>Gaps</h2><ul>${gaps
        .map(
          (gap) =>
            `<li><strong>${escape(gap.subquestion)}</strong>: ${escape(gap.why)} Searched: ${escape(gap.searched.join("; "))}. To close: ${escape(gap.howToClose)}</li>`,
        )
        .join("\n")}</ul></section>`
    : ""
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Answer</title></head>
<body><article><h1>Answer</h1>
${body}
<section><h2>Evidence</h2>
${evidence}
</section>
<section><h2>References</h2><ol>
${references}
</ol></section>
${gapSection}
</article></body></html>
`
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

