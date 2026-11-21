import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Canonical, Fragment, Ref, ResearchRecord, Tier } from "@opencode/research-record"
import { Store } from "@opencode/research-store"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Add } from "../src/add.js"
import { Fetch } from "../src/fetch.js"
import { Find } from "../src/find.js"
import { Workspace } from "../src/workspace.js"

// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const PAPER = [
  "# Union decline",
  "",
  "Union decline explains about a fifth of the rise in wage inequality — façade naïveté ✓. The rest comes from changes in the returns to education.",
  "",
  "# References",
  "",
  "Western, B. and Rosenfeld, J. (2011). Unions, norms, and the rise in US wage inequality.",
].join("\n")

const HTML = [
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

const WORK = {
  title: ["Union decline and wage inequality"],
  author: [{ family: "Western", given: "Bruce" }],
  issued: { "date-parts": [[2011, 6]] },
  "container-title": ["Social Forces"],
  DOI: "10.1093/sf/soaa001",
  type: "journal-article",
  abstract: "<jats:p>Union decline explains about a fifth of the rise.</jats:p>",
}

// A real local server stands in for the web and for Crossref, so redirects and body limits go through real HTTP.
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url)
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
    const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } })
    if (url.pathname === "/paper") return html(HTML)
    if (url.pathname === "/note")
      return html("<html><head><title>A note</title></head><body><p>A note.</p></body></html>")
    if (url.pathname === "/moved") return redirect("/paper")
    if (url.pathname === "/away") return redirect("http://localhost:1/elsewhere")
    if (url.pathname === "/loop") return redirect("/loop")
    if (url.pathname === "/big") return new Response("x".repeat(4096), { headers: { "content-type": "text/plain" } })
    if (url.pathname === "/works/10.1093%2Fsf%2Fsoaa001") return Response.json({ message: WORK })
    if (url.pathname === "/works/10.1093%2Fsf%2Fbare")
      return Response.json({ message: { ...WORK, abstract: undefined } })
    return new Response("not found", { status: 404 })
  },
})
const origin = `http://127.0.0.1:${server.port}`
afterAll(() => server.stop(true))

const made: string[] = []
const opened: { close(): void }[] = []
afterEach(() => {
  opened.splice(0).forEach((store) => store.close())
  made.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
})

function library() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-library-"))
  made.push(directory)
  const store = Store.open(directory, { projectId: "project-1" })
  opened.push(store)
  return { directory, store }
}

const asked: string[] = []
beforeAll(() => asked.splice(0))

/** An agent's tool call. Only the local server may be fetched. */
const agent = (overrides: Partial<Add.Options> = {}): Add.Options => ({
  program: "research@2.3.0",
  context: {
    run: "run-1",
    session: "session-1",
    message: "message-1",
    call: "call-1",
    initiator: { voice: "agent", id: "reader" },
  },
  crossref: `${origin}/works/`,
  allow: (url) => {
    asked.push(url.href)
    return url.origin === origin
  },
  ...overrides,
})

function file(directory: string, name: string, content: string | Uint8Array) {
  const at = path.join(directory, name)
  fs.writeFileSync(at, content)
  return at
}

describe("adding an own file", () => {
  test("commits the source, copy, text and receipt together, and reads the text back by address", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { file: file(lib.directory, "paper.md", PAPER) }, agent())
    expect(added.status).toBe("added")
    expect(lib.store.head()?.seq).toBe(1)
    const graph = lib.store.graph()
    const receipt = graph.get(added.receipt, "receipt")
    expect(receipt.body.written).toEqual([added.source, added.copy!, added.representation!].toSorted(Ref.compare))
    expect(receipt.body.step).toMatchObject({ kind: "tool", tool: "library.add", replay: "stored" })

    const outline = Find.outline(lib.store, added.source)
    expect(outline.sections.map((section) => section.heading)).toEqual(["Union decline", "References"])
    const passage = Find.read(lib.store, { address: `${outline.short}:1/p1/s2` })
    expect(passage.sentences[0].text).toBe("The rest comes from changes in the returns to education.")
    expect(lib.store.verify().ok).toBe(true)
  })

  test("every sentence's offsets quote the stored text, non-ASCII included", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { file: file(lib.directory, "paper.md", PAPER) }, agent())
    const graph = lib.store.graph()
    const located = Workspace.locate(lib.store, graph, Workspace.find(graph, added.source)!)!
    const bytes = Workspace.text(lib.store, located)
    const representationDigest = Canonical.blobDigest(bytes)
    const sentences = located.tree.nodes.filter((node) => node.kind === "sentence")
    expect(sentences[0].text).toContain("façade naïveté ✓")
    sentences.forEach((node) =>
      Fragment.verify({
        representationDigest,
        selector: { profile: "utf8-bytes@1", start: node.start, end: node.end, quote: node.text },
        bytes,
      }),
    )
  })

  test("grep, search and cites find the same stored text", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { file: file(lib.directory, "paper.md", PAPER) }, agent())
    expect(Find.grep(lib.store, { pattern: "returns to education" }).hits.map((hit) => hit.address)).toEqual([
      `${Find.outline(lib.store, added.source).short}:1/p1/s2`,
    ])
    expect(Find.search(lib.store, { query: "union wage inequality" }).hits[0].text).toContain("a fifth")
    expect(Find.cites(lib.store, added.source).entries.map((entry) => entry.text)).toEqual([
      "Western, B. and Rosenfeld, J. (2011). Unions, norms, and the rise in US wage inequality.",
    ])
  })

  test("identical bytes resolve to the source that already holds them", async () => {
    const lib = library()
    const first = await Add.add(lib.store, { file: file(lib.directory, "paper.md", PAPER) }, agent())
    const again = await Add.add(lib.store, { file: file(lib.directory, "copy.md", PAPER) }, agent())
    expect(again).toMatchObject({ status: "existing", source: first.source, copy: first.copy })
    expect(lib.store.graph().get(again.receipt, "receipt").body.written).toEqual([])
    expect(Workspace.entries(lib.store.graph())).toHaveLength(1)
  })

  test("a title proposed with bytes already held is recorded against the existing source", async () => {
    const lib = library()
    const first = await Add.add(lib.store, { file: file(lib.directory, "paper.md", PAPER) }, agent())
    const again = await Add.add(
      lib.store,
      { file: file(lib.directory, "copy.md", PAPER), title: "Union decline and inequality" },
      agent(),
    )
    expect(again.status).toBe("existing")
    const graph = lib.store.graph()
    expect(Tier.citation(graph, first.source, graph.lastSeq).title).toEqual({
      value: "Union decline and inequality",
      from: "agent",
    })
  })

  test("a file over the size limit is refused before it is read", async () => {
    const lib = library()
    const big = file(lib.directory, "big.txt", "x".repeat(4096))
    expect(Add.add(lib.store, { file: big }, agent({ maxBytes: 1024 }))).rejects.toThrow("the limit is 1024")
    expect(lib.store.head()).toBeUndefined()
  })

  test("a PDF is stored, and the missing extraction is said rather than silent", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { file: file(lib.directory, "paper.pdf", "%PDF-1.7 bytes") }, agent())
    expect(added.status).toBe("no-text")
    expect(added.representation).toBeUndefined()
    expect(added.notes[0]).toContain("PDF")
    expect(Find.outline(lib.store, added.source).note).toContain("no text")
  })
})

describe("a proposed title", () => {
  test("from an agent is the agent's metadata judgment, flagged where it is used", async () => {
    const lib = library()
    const added = await Add.add(
      lib.store,
      { file: file(lib.directory, "notes.txt", "Plain notes."), title: "Field notes" },
      agent(),
    )
    const graph = lib.store.graph()
    const judgment = graph.heads(graph.lastSeq).find((entry) => entry.revision.kind === "judgment")!.revision
    expect(judgment).toMatchObject({
      author: { voice: "agent", id: "reader" },
      body: { field: "title", value: "Field notes" },
    })
    expect(Tier.citation(graph, added.source, graph.lastSeq).title).toEqual({ value: "Field notes", from: "agent" })
    expect(Workspace.find(graph, added.source)?.title).toBe("Field notes")
  })

  test("from the researcher is a decision that names how it was confirmed", async () => {
    const lib = library()
    const researcher = agent({
      context: {
        run: "none",
        session: "none",
        message: "none",
        call: "none",
        initiator: { voice: "researcher", id: "me" },
      },
      attestation: { level: "tty", surface: "opencode research add" },
    })
    await Add.add(
      lib.store,
      { file: file(lib.directory, "notes.txt", "Plain notes."), title: "Field notes" },
      researcher,
    )
    const graph = lib.store.graph()
    const decision = graph.heads(graph.lastSeq).find((entry) => entry.revision.kind === "decision")!.revision
    expect(decision.body).toMatchObject({ type: "metadata", attestation: { level: "tty" } })
  })
})

describe("adding a web page", () => {
  test("cites the page from its own tags, each field measured from the stored copy", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { url: `${origin}/paper` }, agent())
    const source = lib.store.graph().get(added.source, "source")
    expect(source.body.type).toBe("article-journal")
    expect(source.body.identifiers).toEqual([
      { scheme: "doi", value: "10.1093/sf/soaa001" },
      { scheme: "url", value: `${origin}/paper` },
    ])
    const copy = lib.store.graph().get(added.copy!, "copy")
    expect(source.body.fields.title).toEqual({
      value: "Union decline and wage inequality",
      origin: { by: "file", copy: copy.body.blob },
    })
    expect(source.body.fields.author.value).toEqual([{ family: "Western", given: "Bruce" }])
    expect(lib.store.verify().ok).toBe(true)
  })

  test("a page with no citation tags is a web page with its site as publisher", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { url: `${origin}/note` }, agent())
    const source = lib.store.graph().get(added.source, "source")
    expect(source.body.type).toBe("webpage")
    expect(source.body.fields.publisher.value).toBe("127.0.0.1")
  })

  test("a redirect is followed only after it too is allowed, and the copy names where it came from", async () => {
    const lib = library()
    asked.splice(0)
    const added = await Add.add(lib.store, { url: `${origin}/moved` }, agent())
    expect(asked).toEqual([`${origin}/moved`, `${origin}/paper`])
    expect(lib.store.graph().get(added.copy!, "copy").body.retrieved.from).toBe(`${origin}/paper`)
  })

  test("a redirect to a URL the caller refuses is refused, and nothing is written", async () => {
    const lib = library()
    const refused = await Add.add(lib.store, { url: `${origin}/away` }, agent()).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Fetch.FetchError)
    expect((refused as Fetch.FetchError).code).toBe("refused")
    expect(lib.store.head()).toBeUndefined()
  })

  test("a redirect loop stops at the limit", async () => {
    const lib = library()
    const looped = await Add.add(lib.store, { url: `${origin}/loop` }, agent()).catch((error: unknown) => error)
    expect((looped as Fetch.FetchError).code).toBe("too-many-redirects")
  })

  test("a body over the limit is refused without being kept", async () => {
    const lib = library()
    const big = await Add.add(lib.store, { url: `${origin}/big` }, agent({ maxBytes: 1024 })).catch(
      (error: unknown) => error,
    )
    expect((big as Fetch.FetchError).code).toBe("too-large")
    expect(lib.store.head()).toBeUndefined()
  })
})

describe("adding by DOI", () => {
  test("stores Crossref's answer, cites from it, and keeps the abstract as an abstract-only copy", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { doi: "10.1093/sf/soaa001" }, agent())
    expect(added.status).toBe("abstract-only")
    const graph = lib.store.graph()
    const title = graph.get(added.source, "source").body.fields.title
    expect(title.value).toBe("Union decline and wage inequality")
    expect(title.origin).toMatchObject({ by: "service", service: "crossref" })
    const response =
      title.origin.by === "service" ? lib.store.readBlob(title.origin.response as Canonical.Digest) : undefined
    expect(JSON.parse(new TextDecoder().decode(response))).toEqual({ message: WORK })
    expect(graph.get(added.copy!, "copy").body.content).toBe("abstract")
    expect(Find.outline(lib.store, added.source).note).toContain("abstract only")
    expect(Find.read(lib.store, { address: Find.outline(lib.store, added.source).short }).sentences[0].text).toBe(
      "Union decline explains about a fifth of the rise.",
    )
  })

  test("without an abstract it stores the citation and says what is missing", async () => {
    const lib = library()
    const added = await Add.add(lib.store, { doi: "10.1093/sf/bare" }, agent())
    expect(added.status).toBe("metadata-only")
    expect(added.copy).toBeUndefined()
    expect(added.notes[0]).toContain("add a file or a URL")
  })

  test("an unknown DOI is refused with the reason", async () => {
    const lib = library()
    expect(Add.add(lib.store, { doi: "10.9999/nope" }, agent())).rejects.toThrow("does not know the DOI")
  })
})

describe("short addresses", () => {
  test("two works keep separate addresses, and adding one never changes another's", async () => {
    const lib = library()
    const first = await Add.add(lib.store, { file: file(lib.directory, "a.md", PAPER) }, agent())
    const before = Find.outline(lib.store, first.source).short
    await Add.add(lib.store, { file: file(lib.directory, "b.txt", "Another work entirely.") }, agent())
    const shorts = Workspace.entries(lib.store.graph()).map((entry) => entry.short)
    expect(new Set(shorts).size).toBe(2)
    expect(Find.outline(lib.store, first.source).short).toBe(before)
    expect(Workspace.parseAddress(`${before}:1/p1/s2`)).toEqual({
      short: before,
      section: 1,
      paragraph: 1,
      sentence: 2,
    })
    expect(ResearchRecord.refOf(Workspace.find(lib.store.graph(), before)!.source)).toEqual(first.source)
  })
})
