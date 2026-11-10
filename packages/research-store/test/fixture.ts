import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type Digest,
  type ReceiptOperation,
  type Record,
  cut,
  makeRecord,
  refOf,
  wrapPassage,
} from "@opencode/research-record"
import { Store } from "../src/store.js"

export const at = "2026-11-10T00:00:00.000Z"

export const text =
  "Union decline explains about a fifth of the rise in wage inequality. " +
  "The rest comes from changes in the returns to education."

export function temporaryProject(): string {
  return mkdtempSync(join(tmpdir(), "research-store-"))
}

export interface Fixture {
  readonly directory: string
  readonly store: Store
  readonly records: {
    readonly source: Record
    readonly copy: Record
    readonly representation: Record
    readonly fragment: Record
    readonly claim: Record
    readonly call: Record
    readonly evidence: Record
    readonly decision: Record
  }
  readonly blobs: { readonly text: Digest; readonly response: Digest; readonly content: Digest }
}

/** A complete, verifiable project: one paper, one quote, one claim, one model call, one adoption. */
export function buildProject(directory = temporaryProject()): Fixture {
  const store = Store.open(directory)
  const bytes = new TextEncoder().encode(text)
  const textBlob = store.put(bytes)
  const tree = { nodes: [{ kind: "paragraph", start: 0, end: bytes.length, section: 1, paragraph: 0 }] }
  const treeBlob = store.put(new TextEncoder().encode(JSON.stringify(tree)))

  const source = makeRecord({
    kind: "source",
    at,
    author: { voice: "program" },
    body: {
      type: "journal-article",
      identifiers: { doi: "10.1093/sf/soaa001" },
      csl: {
        title: "Union decline and wage inequality",
        author: [{ family: "Western", given: "Bruce" }],
        issued: { "date-parts": [[2011]] },
        container: "Social Forces",
        DOI: "10.1093/sf/soaa001",
      },
      fieldOrigins: { title: "crossref", author: "crossref", issued: "crossref", container: "crossref", DOI: "crossref" },
    },
  })
  const copy = makeRecord({
    kind: "copy",
    at,
    author: { voice: "program" },
    body: {
      source: refOf(source),
      digest: textBlob,
      mime: "text/plain",
      bytes: bytes.length,
      fetchedAt: at,
      url: "https://example.org/preprint.txt",
      abstractOnly: false,
    },
  })
  const representation = makeRecord({
    kind: "representation",
    at,
    author: { voice: "program" },
    body: {
      copy: refOf(copy),
      text: textBlob,
      tree: treeBlob,
      extractor: { name: "research-text", version: 1 },
      flags: [],
      sections: 1,
      paragraphs: 1,
      sentences: 2,
      characters: text.length,
    },
  })
  store.commit([source, copy, representation], { at })

  const fragment = makeRecord({
    kind: "fragment",
    at,
    author: { voice: "program" },
    body: cut({
      representation: refOf(representation),
      text: bytes,
      start: 0,
      end: new TextEncoder().encode("Union decline explains about a fifth of the rise in wage inequality.").length,
      address: "k7f2:1/p0/s1",
    }),
  })
  const claim = makeRecord({
    kind: "claim",
    at,
    author: { voice: "agent", id: "reader" },
    session: "ses_1",
    body: { text: "Union decline explains part of the rise in wage inequality." },
  })
  const contentBlob = store.put(new TextEncoder().encode(wrapPassage({ address: "k7f2:1/p0/s1", text })))
  const responseBlob = store.put(new TextEncoder().encode("I will quote from this passage."))
  const call = makeRecord({
    kind: "artifact",
    at,
    author: { voice: "program" },
    session: "ses_1",
    body: {
      type: "model-call",
      run: "run_1",
      model: "test/model",
      contents: [contentBlob],
      response: responseBlob,
      inputs: [refOf(fragment)],
    },
  })
  const evidence = makeRecord({
    kind: "evidence",
    at,
    author: { voice: "agent", id: "reader" },
    session: "ses_1",
    body: { claim: refOf(claim), role: "supports", target: { kind: "fragment", fragment: refOf(fragment) } },
  })
  store.commit([fragment, claim, call, evidence], { at })

  const decision = makeRecord({
    kind: "decision",
    at,
    author: { voice: "researcher", id: "micha" },
    body: { target: refOf(claim), ruling: "adopt", reason: "checked against the published table" },
  })
  store.commit([decision], { at })

  return {
    directory,
    store,
    records: { source, copy, representation, fragment, claim, call, evidence, decision },
    blobs: { text: textBlob, response: responseBlob, content: contentBlob },
  }
}

export function receipt(
  input: {
    readonly run?: string
    readonly seq: number
    readonly operation: ReceiptOperation
    readonly output: Digest
  },
) {
  return makeRecord({
    kind: "receipt",
    at,
    author: { voice: "program" },
    body: {
      run: input.run ?? "run_1",
      seq: input.seq,
      operation: input.operation,
      inputs: [],
      output: input.output,
      records: [],
      startedAt: at,
      endedAt: at,
      ok: true,
    },
  })
}
