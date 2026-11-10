import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { parseAddress, recordId, verifyFragment } from "@opencode/research-record"
import { Store, verify } from "@opencode/research-store"
import { addSource, cites, entryOf, grep, outline, read, search } from "../src/index.js"
import { assignShorts, entries } from "../src/workspace.js"

const paper = [
  "# Union decline",
  "",
  "Union decline explains about a fifth of the rise in wage inequality. The rest comes from changes in the returns to education.",
  "",
  "# References",
  "",
  "Western, B. and Rosenfeld, J. (2011). Unions, norms, and the rise in US wage inequality.",
].join("\n")

function project() {
  const directory = mkdtempSync(join(tmpdir(), "research-library-"))
  writeFileSync(join(directory, "paper.md"), paper)
  return { directory, store: Store.open(directory) }
}

const html = [
  "<html><head>",
  '<meta name="citation_title" content="Union decline and wage inequality">',
  '<meta name="citation_author" content="Western, Bruce">',
  '<meta name="citation_publication_date" content="2011/06/01">',
  '<meta name="citation_journal_title" content="Social Forces">',
  '<meta name="citation_doi" content="10.1093/sf/soaa001">',
  "<title>Fallback title</title>",
  "</head><body><h1>Union decline</h1>",
  "<p>Union decline explains about a fifth of the rise in wage inequality.</p>",
  "</body></html>",
].join("")

function respond(body: string, contentType: string) {
  return (async () => new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch
}

describe("adding an own file", () => {
  test("stores the copy, extracts the text, and reads it back by address", async () => {
    const { directory, store } = project()
    const added = await addSource(store, { file: join(directory, "paper.md") })
    expect(added).toMatchObject({ status: "added", title: "paper" })
    expect(added.representation).not.toBeNull()

    const outlineOf = outline(store, added.source)
    expect(outlineOf.sections.map((section) => section.heading)).toEqual(["Union decline", "References"])
    expect(outlineOf.note).toBe("")

    const entry = entryOf(store, added.source)!
    const passage = read(store, { source: added.source })
    expect(passage.sentences.map((sentence) => sentence.address)).toEqual([
      `${entry.short}:1/p1/s1`,
      `${entry.short}:1/p1/s2`,
    ])
    expect(passage.sentences[0]!.text).toBe("Union decline explains about a fifth of the rise in wage inequality.")

    const representation = store.get({ kind: "representation", id: added.representation!.id })
    if (representation.kind !== "representation") throw new Error("not a representation")
    const bytes = store.blobs.get(representation.body.text)
    const first = passage.sentences[0]!
    expect(new TextDecoder().decode(bytes.subarray(first.start, first.end))).toBe(first.text)

    expect(verifyFragment({
      representation: added.representation!,
      range: { start: first.start, end: first.end },
      quote: first.text,
      before: "",
      after: new TextDecoder().decode(bytes.subarray(first.end, first.end + 1)),
      address: first.address,
      flags: [],
    }, bytes).ok).toBe(true)
  })

  test("grep, search and cites find the same stored text", async () => {
    const { directory, store } = project()
    const added = await addSource(store, { file: join(directory, "paper.md") })
    const entry = entryOf(store, added.source)!

    const grepResult = grep(store, { pattern: "education" })
    expect(grepResult.hits.map((hit) => hit.address)).toEqual([`${entry.short}:1/p1/s2`])
    expect(grepResult.searched).toBeGreaterThan(0)

    const searchResult = search(store, { query: "union decline wage inequality" })
    expect(searchResult.hits[0]!.address).toBe(`${entry.short}:1/p1`)

    const citations = cites(store, added.source)
    expect(citations.entries.map((citation) => citation.address)).toEqual([`${entry.short}:2/p1`])
    expect(citations.entries[0]!.text).toContain("Western")
  })

  test("reading from a sentence address starts there", async () => {
    const { directory, store } = project()
    const added = await addSource(store, { file: join(directory, "paper.md") })
    const entry = entryOf(store, added.source)!
    const second = read(store, { address: `${entry.short}:1/p1/s2` })
    expect(second.sentences.map((sentence) => sentence.text)).toEqual(["The rest comes from changes in the returns to education."])
  })

  test("the record verifies after the library writes it", async () => {
    const { directory, store } = project()
    await addSource(store, { file: join(directory, "paper.md") })
    expect(verify(store).issues).toEqual([])
  })
})

describe("adding a web page", () => {
  test("reads the page's citation metadata and stores the html", async () => {
    const { store } = project()
    const added = await addSource(
      store,
      { url: "https://example.org/union-decline" },
      { fetch: respond(html, "text/html; charset=utf-8") },
    )
    expect(added.status).toBe("added")
    const source = store.get(added.source)
    if (source.kind !== "source") throw new Error("not a source")
    expect(source.body.type).toBe("journal-article")
    expect(source.body.csl).toMatchObject({
      title: "Union decline and wage inequality",
      container: "Social Forces",
      DOI: "10.1093/sf/soaa001",
    })
    expect(source.body.csl.author).toEqual([{ family: "Western", given: "Bruce" }])
    expect(source.body.fieldOrigins.title).toBe("page")
    expect(verify(store).ok).toBe(true)
  })

  test("a downloaded html file is cited from its own citation tags", async () => {
    const { directory, store } = project()
    writeFileSync(join(directory, "article.html"), html)
    const added = await addSource(store, { file: join(directory, "article.html") })
    const source = store.get(added.source)
    if (source.kind !== "source") throw new Error("not a source")
    expect(source.body.type).toBe("journal-article")
    expect(source.body.csl).toMatchObject({
      title: "Union decline and wage inequality",
      container: "Social Forces",
      DOI: "10.1093/sf/soaa001",
    })
    expect(source.body.csl.author).toEqual([{ family: "Western", given: "Bruce" }])
    expect(source.body.fieldOrigins.title).toBe("page")
    expect(verify(store).ok).toBe(true)
  })

  test("a page with no citation tags is a web page with its site as publisher", async () => {
    const { store } = project()
    const plain = "<html><head><title>A note</title></head><body><p>A note.</p></body></html>"
    const added = await addSource(store, { url: "https://example.org/note" }, { fetch: respond(plain, "text/html") })
    const source = store.get(added.source)
    if (source.kind !== "source") throw new Error("not a source")
    expect(source.body.type).toBe("web-page")
    expect(source.body.csl.publisher).toBe("example.org")
    expect(source.body.csl.accessed).toBeDefined()
  })
})

describe("adding by DOI", () => {
  const work = {
    message: {
      title: ["Union decline and wage inequality"],
      author: [{ family: "Western", given: "Bruce" }],
      issued: { "date-parts": [[2011, 6]] },
      "container-title": ["Social Forces"],
      DOI: "10.1093/sf/soaa001",
      type: "journal-article",
      abstract: "<jats:p>Union decline explains about a fifth of the rise.</jats:p>",
    },
  }

  test("stores the abstract and flags it as abstract only", async () => {
    const { store } = project()
    const added = await addSource(
      store,
      { doi: "10.1093/sf/soaa001" },
      { fetch: respond(JSON.stringify(work), "application/json") },
    )
    expect(added).toMatchObject({ status: "abstract-only", title: "Union decline and wage inequality" })
    const copy = store.get(added.copy!)
    if (copy.kind !== "copy") throw new Error("not a copy")
    expect(copy.body.abstractOnly).toBe(true)
    expect(outline(store, added.source).note).toContain("abstract only")
    const passage = read(store, { source: added.source })
    expect(passage.sentences[0]!.text).toBe("Union decline explains about a fifth of the rise.")
  })

  test("without an abstract it stores the citation and says what is missing", async () => {
    const { store } = project()
    const metadataOnly = { message: { ...work.message, abstract: undefined } }
    const added = await addSource(
      store,
      { doi: "10.1093/sf/soaa001" },
      { fetch: respond(JSON.stringify(metadataOnly), "application/json") },
    )
    expect(added).toMatchObject({ status: "metadata-only", copy: null, representation: null })
    expect(added.notes[0]).toContain("add a file or a URL")
    expect(outline(store, added.source).sections).toEqual([])
  })

  test("an unknown DOI is refused with the reason", async () => {
    const { store } = project()
    const fetch404 = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
    expect(addSource(store, { doi: "10.9999/nope" }, { fetch: fetch404 })).rejects.toThrow("does not know the DOI")
  })
})

describe("a pdf copy", () => {
  test("is stored, and extraction is reported as missing rather than silent", async () => {
    const { directory, store } = project()
    writeFileSync(join(directory, "paper.pdf"), "%PDF-1.4\nnot really a pdf")
    const added = await addSource(store, { file: join(directory, "paper.pdf") })
    expect(added).toMatchObject({ status: "pdf-pending", representation: null })
    expect(added.copy).not.toBeNull()
    expect(added.notes.join(" ")).toContain("PDF text extraction is not built yet")
    expect(outline(store, added.source).note).toContain("no text has been extracted")
  })
})

describe("short source ids", () => {
  test("extend only as far as two ids need", () => {
    const one = `sha256:${"a".repeat(64)}` as const
    const two = `sha256:${"a".repeat(3)}b${"c".repeat(60)}` as const
    const three = `sha256:${"b".repeat(64)}` as const
    const shorts = assignShorts([one, two, three])
    expect(shorts.get(one)).toBe("aaaa")
    expect(shorts.get(three)).toBe("bbbb")
    expect(shorts.get(two)).toBe("aaab")
  })

  test("two sources in one library keep separate addresses", async () => {
    const { directory, store } = project()
    writeFileSync(join(directory, "second.md"), "# Second\n\nAnother document about wages.")
    const first = await addSource(store, { file: join(directory, "paper.md") })
    const second = await addSource(store, { file: join(directory, "second.md") })
    const all = entries(store)
    expect(all).toHaveLength(2)
    const shortOf = (ref: { id: string }) =>
      all.find((entry) => recordId(entry.source) === ref.id)?.short
    expect(shortOf(first.source)).not.toBe(shortOf(second.source))
    const secondShort = shortOf(second.source)!
    expect(parseAddress(`${secondShort}:1/p1/s1`).short).toBe(secondShort)
  })
})
