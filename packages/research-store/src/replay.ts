export * as Replay from "./replay.js"

import { Canonical, Ref, ResearchRecord } from "@opencode/research-record"
import { StoreError } from "./error.js"
import type { Store } from "./store.js"

export type Status = "match" | "mismatch" | "unverifiable"

export interface Entry {
  readonly seq: number
  readonly receipt: Ref.Exact
  /** `tool <name>`, `script <engine>`, `model <provider>/<model>` or `command <name>`. */
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

type Receipt = ResearchRecord.Revision<"receipt">
export type ScriptStep = Extract<Receipt["body"]["step"], { kind: "script" }>

export interface Options {
  /** Replays only the receipts of this run. */
  readonly run?: string
  /**
   * Runs a deterministic tool again on its recorded input and returns its output bytes, or `undefined` when the tool
   * cannot run here. Without it, every step recorded as `rerun` is unverifiable.
   */
  readonly rerun?: (tool: string, version: string, input: Uint8Array) => Uint8Array | undefined
  /**
   * Runs a script again in its engine, with the step's recorded clock and seed, and returns its result bytes, or
   * `undefined` when the engine cannot run here. Without it, every script is unverifiable.
   */
  readonly script?: (step: ScriptStep, script: Uint8Array) => Uint8Array | undefined
}

/**
 * Walks the record's receipts in commit order and rechecks each step without trusting it. A tool recorded as `rerun`
 * and a script run again and their outputs are compared by digest; a tool recorded as `stored`, a model call and a
 * command are answered from their stored files, which must be intact. A step that cannot be rechecked is reported as
 * unverifiable, never counted as a pass.
 */
export function run(reader: Store.Reader, options: Options = {}): Report {
  const graph = reader.graph()
  const entries = graph.entries
    .filter(
      (entry) =>
        entry.revision.kind === "receipt" && (options.run === undefined || runOf(entry.revision) === options.run),
    )
    .map((entry) => receipt(reader, ResearchRecord.refOf(entry.revision), options))
  const mismatches = entries.filter((entry) => entry.status === "mismatch").length
  const unverifiable = entries.filter((entry) => entry.status === "unverifiable").length
  return { ok: entries.length > 0 && mismatches === 0 && unverifiable === 0, entries, mismatches, unverifiable }
}

/** Rechecks one receipt, as `run` does each. */
export function receipt(reader: Store.Reader, ref: Ref.Exact, options: Options = {}): Entry {
  const graph = reader.graph()
  const found = graph.get(ref, "receipt")
  return {
    seq: graph.entry(ref).seq,
    receipt: ResearchRecord.refOf(found),
    step: describe(found.body.step),
    ...check(reader, found, options),
  }
}

function check(reader: Store.Reader, receipt: Receipt, options: Options) {
  const step = receipt.body.step
  if (step.kind === "script") return script(reader, receipt, step, options)
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

/**
 * Runs the stored script again and compares its result by digest. Every artifact the run wrote must hold that result,
 * so an artifact a claim cites cannot differ from what the script computes.
 */
function script(reader: Store.Reader, receipt: Receipt, step: ScriptStep, options: Options) {
  if (step.result === "none") return unverifiable("the script recorded no result to compare")
  if (step.calls.length > 0) return unverifiable("a script that called tools cannot replay yet")
  const result = step.result.digest
  const graph = reader.graph()
  if (
    receipt.body.written.some((ref) => {
      const written = graph.get(ref)
      return written.kind === "artifact" && written.body.output.digest !== result
    })
  )
    return { status: "mismatch" as const, detail: "an artifact the script wrote does not hold its result" }
  const bytes = load(reader, step.script.digest)
  if (typeof bytes === "string") return { status: "mismatch" as const, detail: bytes }
  if (options.script === undefined) return unverifiable(`no engine for ${step.engine.id}`)
  const output = options.script(step, bytes)
  if (output === undefined) return unverifiable(`${step.engine.id} ${step.engine.version} cannot run here`)
  if (Canonical.blobDigest(output) === result)
    return { status: "match" as const, detail: "the script's result has the recorded digest" }
  return { status: "mismatch" as const, detail: "the script's result differs from the recorded one" }
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
  return `script ${step.engine.id}`
}
