export * as Replay from "./replay.js"

import { Canonical, Ref, ResearchRecord } from "@opencode/research-record"
import { StoreError } from "./error.js"
import type { Store } from "./store.js"

export type Status = "match" | "mismatch" | "unverifiable"

export interface Entry {
  readonly seq: number
  readonly receipt: Ref.Exact
  /** `tool <name>`, `script`, `model <provider>/<model>` or `command <name>`. */
  readonly step: string
  readonly status: Status
  readonly detail: string
}

export interface Report {
  /** True only when there is something to replay and every step matched: an unverifiable step is not a pass. */
  readonly ok: boolean
  readonly entries: readonly Entry[]
  readonly mismatches: number
  readonly unverifiable: number
}

export interface Options {
  /** Replays only the receipts of this run. */
  readonly run?: string
  /**
   * Runs a deterministic tool again on its recorded input and returns its output bytes, or `undefined` when the tool
   * cannot run here. Without it, every step recorded as `rerun` is unverifiable.
   */
  readonly rerun?: (tool: string, version: string, input: Uint8Array) => Uint8Array | undefined
}

type Receipt = ResearchRecord.Revision<"receipt">

/**
 * Walks the record's receipts in commit order and rechecks each step without trusting it. A tool recorded as `rerun`
 * runs again and its output is compared by digest; a tool recorded as `stored`, a model call and a command are answered
 * from their stored files, which must be intact; a script cannot replay yet. A step that cannot be rechecked is
 * reported as unverifiable, never counted as a pass.
 */
export function run(reader: Store.Reader, options: Options = {}): Report {
  const entries = reader
    .graph()
    .entries.flatMap((entry) =>
      entry.revision.kind === "receipt" && (options.run === undefined || runOf(entry.revision) === options.run)
        ? [{ seq: entry.seq, receipt: entry.revision as Receipt }]
        : [],
    )
    .map((entry) => ({
      seq: entry.seq,
      receipt: ResearchRecord.refOf(entry.receipt),
      step: describe(entry.receipt.body.step),
      ...check(reader, entry.receipt.body.step, options),
    }))
  const mismatches = entries.filter((entry) => entry.status === "mismatch").length
  const unverifiable = entries.filter((entry) => entry.status === "unverifiable").length
  return { ok: entries.length > 0 && mismatches === 0 && unverifiable === 0, entries, mismatches, unverifiable }
}

function check(reader: Store.Reader, step: Receipt["body"]["step"], options: Options) {
  if (step.kind === "script") return unverifiable("a script cannot replay yet")
  if (step.kind === "command") return stored(reader, [step.input], "the command's input is stored intact")
  if (step.kind === "model") {
    if (step.response === "none") return unverifiable("the model call recorded no response")
    return stored(reader, [step.request, step.response], "answered from the stored response, with no model call")
  }
  if (step.output === "none") return unverifiable("the tool recorded no output to compare")
  if (step.replay === "stored") return stored(reader, [step.input, step.output], "the stored output is intact")
  const input = load(reader, step.input.digest)
  if (typeof input === "string") return { status: "mismatch" as const, detail: input }
  if (options.rerun === undefined) return unverifiable(`no rerun for ${step.tool}`)
  const output = options.rerun(step.tool, step.version, input)
  if (output === undefined) return unverifiable(`${step.tool} ${step.version} cannot run here`)
  if (Canonical.blobDigest(output) === step.output.digest)
    return { status: "match" as const, detail: "the rerun's output has the recorded digest" }
  return { status: "mismatch" as const, detail: "the rerun's output differs from the recorded one" }
}

function stored(reader: Store.Reader, blobs: readonly ResearchRecord.Blob[], detail: string) {
  const failure = blobs.map((blob) => load(reader, blob.digest)).find((loaded) => typeof loaded === "string")
  if (failure !== undefined) return { status: "mismatch" as const, detail: failure }
  return { status: "match" as const, detail }
}

/** The bytes of a stored file, or why they could not be read: a missing or damaged file is a mismatch. */
function load(reader: Store.Reader, digest: string): Uint8Array | string {
  try {
    return reader.readBlob(digest as Canonical.Digest)
  } catch (error) {
    if (error instanceof StoreError) return `the stored file ${digest} cannot be read: ${error.message}`
    throw error
  }
}

function runOf(revision: ResearchRecord.Revision) {
  return revision.context === "none" ? undefined : revision.context.run
}

function unverifiable(detail: string) {
  return { status: "unverifiable" as const, detail }
}

function describe(step: Receipt["body"]["step"]) {
  if (step.kind === "tool") return `tool ${step.tool}`
  if (step.kind === "model") return `model ${step.provider}/${step.model}`
  if (step.kind === "command") return `command ${step.command}`
  return "script"
}
