import { mkdirSync } from "node:fs"
import { basename, join } from "node:path"
import { type Digest, type Record, digestBytes, recordId } from "@opencode/research-record"
import type { Store } from "./store.js"
import { referencedBlobs } from "./verify.js"

const VERIFIER = new URL("./assets/verify.mjs", import.meta.url)

export interface ExportBundleOptions {
  readonly out: string
  readonly exportedAt?: string
}

export interface ExportBundleResult {
  readonly directory: string
  readonly manifest: string
  readonly log: string
  readonly verifier: string
  readonly blobs: number
}

/**
 * Writes the record as plain files: the log as JSON lines, the blobs it points at, and a verifier that needs
 * no dependencies. A reader can then check the record with node alone.
 */
export async function exportBundle(store: Store, options: ExportBundleOptions): Promise<ExportBundleResult> {
  const directory = options.out
  mkdirSync(join(directory, "blobs"), { recursive: true })

  const rows = store.commits()
  const records: Record[] = rows.flatMap((row) => {
    const body: unknown = JSON.parse(row.body)
    return (body as { records: Record[] }).records
  })
  const lines = rows.map((row) => {
    const parsed: unknown = JSON.parse(row.body)
    const body = parsed as { seq: number; at: string; prev: Digest | null; records: Record[] }
    return JSON.stringify({ seq: body.seq, at: body.at, prev: body.prev, digest: row.digest, records: body.records })
  })

  const log = join(directory, "log.jsonl")
  await Bun.write(log, `${lines.join("\n")}\n`)

  const blobs = referencedBlobs(records)
  for (const blob of blobs) {
    await Bun.write(join(directory, "blobs", blob.slice("sha256:".length)), store.blobs.get(blob))
  }

  const verifier = join(directory, "verify.mjs")
  await Bun.write(verifier, await Bun.file(VERIFIER).text())

  const manifest = join(directory, "manifest.json")
  await Bun.write(
    manifest,
    `${JSON.stringify(
      {
        contract: "research-record@1",
        bundle: basename(directory),
        exportedAt: options.exportedAt ?? new Date().toISOString(),
        head: store.head()?.digest ?? null,
        commits: rows.length,
        records: records.length,
        blobs: blobs.length,
        recordIds: records.map(recordId),
      },
      null,
      2,
    )}\n`,
  )

  await Bun.write(
    join(directory, "README.txt"),
    [
      "This bundle is a research record.",
      "",
      "Check it with no dependencies, no model and no OpenCode:",
      "",
      "  node verify.mjs .",
      "",
      "log.jsonl holds one commit per line, chained by the digest of the commit before it.",
      "blobs/ holds every file the records cite, named by the SHA-256 of its bytes.",
      "A fragment cites a byte range of one of those files; verify.mjs rechecks the bytes.",
      "",
    ].join("\n"),
  )

  return { directory, manifest, log, verifier, blobs: blobs.length }
}

/**
 * Records the digest of each rendered file in the manifest, so a reader can tell a flipped sentence in
 * answer.md from one the record produced.
 */
export async function sealRendered(directory: string, files: readonly string[]): Promise<{ [name: string]: Digest }> {
  const path = join(directory, "manifest.json")
  const manifest = (await Bun.file(path).json()) as { [key: string]: unknown }
  const rendered: { [name: string]: Digest } = {}
  for (const name of files) {
    const file = join(directory, name)
    if (!(await Bun.file(file).exists())) continue
    rendered[name] = digestBytes(new Uint8Array(await Bun.file(file).arrayBuffer()))
  }
  manifest.rendered = rendered
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}
`)
  return rendered
}
