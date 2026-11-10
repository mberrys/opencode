import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "@opencode/research-store"
import { addSource, entryOf } from "@opencode/research-library"
import type { Session } from "../src/evidence.js"

export const article = [
  "<html><head>",
  '<meta name="citation_title" content="Union decline and wage inequality">',
  '<meta name="citation_author" content="Western, Bruce">',
  '<meta name="citation_publication_date" content="2011/06/01">',
  '<meta name="citation_journal_title" content="Social Forces">',
  '<meta name="citation_doi" content="10.1093/sf/soaa001">',
  "</head><body>",
  "<h1>Union decline</h1>",
  "<p>Union decline explains about a fifth of the rise in wage inequality. The rest comes from changes in the returns to education.</p>",
  "<h1>References</h1>",
  "<p>Western, B. and Rosenfeld, J. (2011). Unions, norms, and the rise in US wage inequality.</p>",
  "</body></html>",
].join("")

export interface Fixture {
  readonly store: Store
  readonly directory: string
  readonly session: Session
  readonly source: string
  readonly short: string
  readonly address: string
}

const respond = (body: string) =>
  (async () => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch

export async function project(options: { voice?: "agent" | "researcher" } = {}): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "research-plugin-"))
  const store = Store.open(directory)
  const added = await addSource(
    store,
    { url: "https://example.org/union-decline" },
    { fetch: respond(article), now: new Date("2026-11-10T00:00:00.000Z") },
  )
  const entry = entryOf(store, added.source)!
  return {
    store,
    directory,
    source: `source:${added.source.id}`,
    short: entry.short,
    address: `${entry.short}:1/p1/s1`,
    session: {
      store,
      session: "ses_1",
      run: "ses_1",
      actor: { voice: options.voice ?? "agent", id: options.voice === "researcher" ? "micha" : "reader" },
    },
  }
}
