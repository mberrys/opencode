import { Canonical, ResearchRecord } from "@opencode/research-record"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Store } from "../src/store.js"

export const PROJECT = "project-1"
export const encoder = new TextEncoder()

const program = { voice: "program", id: "research@2.3.0" } as const
const reader = { voice: "agent", id: "reader" } as const
const context = (call: string) => ({
  run: "run-1",
  session: "session-1",
  message: "message-1",
  call,
  initiator: reader,
})

const made: string[] = []
const opened: { close(): void }[] = []

/** A fresh project directory, removed by `cleanup`. */
export function project() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-store-"))
  made.push(directory)
  return directory
}

/** Closes every store a test opened, since Windows will not remove a directory with an open database in it. */
export function cleanup() {
  opened.splice(0).forEach((store) => store.close())
  made.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
}

export function open(directory = project(), options: Partial<Store.Options> = {}) {
  return track(Store.open(directory, { projectId: PROJECT, ...options }))
}

export function track<T extends { close(): void }>(store: T) {
  opened.push(store)
  return store
}

const revision = (
  kind: ResearchRecord.Kind,
  objectId: string,
  author: unknown,
  call: string,
  body: unknown,
  parent: unknown = "none",
) =>
  ResearchRecord.create({
    projectId: PROJECT,
    kind,
    schema: `${kind}@1`,
    objectId,
    parent,
    author,
    context: context(call),
    body,
  })

/** A source and the copy that holds `bytes`, which must already be admitted. */
export function acquired(name: string, bytes: Uint8Array) {
  const source = revision("source", `source-${name}`, program, `call-${name}`, {
    type: "article-journal",
    identifiers: [{ scheme: "doi", value: `10.1/${name}` }],
    fields: {},
  })
  const copy = revision("copy", `copy-${name}`, program, `call-${name}`, {
    source: ResearchRecord.refOf(source),
    blob: Canonical.blobDigest(bytes),
    mediaType: "application/pdf",
    size: bytes.length,
    content: "full-text",
    retrieved: { from: "file", at: "2026-11-15T10:00:00Z" },
    licence: "none",
  })
  return { source, copy }
}

/** The extracted text of a copy, with its structure tree; both blobs must already be admitted. */
export function extracted(copy: ResearchRecord.Revision, text: Uint8Array, tree: Uint8Array) {
  return revision("representation", `representation-${copy.objectId}`, program, "call-extract", {
    copy: ResearchRecord.refOf(copy),
    blob: Canonical.blobDigest(text),
    extractor: { id: "plain-text", version: "1" },
    tree: { digest: Canonical.blobDigest(tree), schema: "none" },
    ocr: false,
  })
}

/** A fragment of `text` from byte `start` to `end`, quoting `quote`. */
export function quoted(
  representation: ResearchRecord.Revision,
  text: Uint8Array,
  start: number,
  end: number,
  quote: string,
) {
  return revision("fragment", `fragment-${start}-${end}`, program, "call-quote", {
    representation: ResearchRecord.refOf(representation),
    representationDigest: Canonical.blobDigest(text),
    selector: { profile: "utf8-bytes@1", start, end, quote },
    before: "",
    after: "",
    page: "none",
  })
}

/** A claim, or a correction of one when `parent` is given. */
export function claim(objectId: string, text: string, parent?: ResearchRecord.Revision) {
  return revision(
    "claim",
    objectId,
    reader,
    `call-${objectId}`,
    { text, scope: "United States, 1979-2019", addresses: "none" },
    parent === undefined ? "none" : ResearchRecord.refOf(parent),
  )
}

export function refusal(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error as { code?: string; detail?: unknown; message?: string }
  }
  throw new Error("expected a refusal")
}

/** A paper named `name`: 32 bytes derived from the name, and the source and copy that record it. */
export function paper(name: string) {
  const bytes = new Uint8Array(createHash("sha256").update(name).digest())
  const { source, copy } = acquired(name, bytes)
  return { bytes, revisions: [source, copy] }
}
