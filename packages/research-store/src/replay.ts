import type { Json, Ref, Digest } from "@opencode/research-record"
import { digest, recordId } from "@opencode/research-record"
import type { Store } from "./store.js"

export type ReplayStatus = "match" | "mismatch" | "unverifiable"

export interface ReplayEntry {
  readonly seq: number
  readonly receipt: Ref
  readonly operation: string
  readonly status: ReplayStatus
  readonly detail: string
}

export interface ReplayReport {
  readonly ok: boolean
  readonly run: string
  readonly entries: readonly ReplayEntry[]
  readonly unverifiable: number
  readonly mismatches: number
}

export interface ReplayOptions {
  /** Deterministic tools only. Returning undefined means the tool cannot replay here. */
  readonly execute?: (tool: string, input: Json) => Json | undefined
}

/**
 * Walks a run's receipts in order. Model calls are answered from the stored response, tool calls are run
 * again and compared by digest, and anything that cannot be rechecked is reported as unverifiable rather than
 * counted as a pass.
 */
export function replay(store: Store, run: string, options: ReplayOptions = {}): ReplayReport {
  const receipts = store
    .kind("receipt")
    .filter((receipt) => receipt.body.run === run)
    .sort((a, b) => a.body.seq - b.body.seq)

  const entries = receipts.map((receipt): ReplayEntry => {
    const entry = {
      seq: receipt.body.seq,
      receipt: { kind: "receipt" as const, id: recordId(receipt) },
      operation: operationName(receipt.body.operation),
    }
    const operation = receipt.body.operation
    if (operation.kind === "model") return { ...entry, ...checkModel(store, receipt.body.output, operation.call) }
    if (operation.kind === "script")
      return { ...entry, status: "unverifiable", detail: "Code Mode scripts cannot replay yet (check C6)" }
    if (!options.execute) return { ...entry, status: "unverifiable", detail: `no replay for ${operation.tool}` }
    const output = options.execute(operation.tool, operation.input)
    if (output === undefined) return { ...entry, status: "unverifiable", detail: `${operation.tool} did not replay` }
    return digest(output) === receipt.body.output
      ? { ...entry, status: "match", detail: "the replay hashes to the recorded output" }
      : { ...entry, status: "mismatch", detail: "the replay hashes to a different output" }
  })

  // A run with no receipts, or with a gap in them, is not evidence of anything.
  const contiguous = entries.every((entry, index) => entry.seq === index + 1)
  const unverifiable = entries.filter((entry) => entry.status === "unverifiable").length
  const mismatches = entries.filter((entry) => entry.status === "mismatch").length
  return {
    ok: entries.length > 0 && contiguous && mismatches === 0 && unverifiable === 0,
    run,
    entries,
    unverifiable,
    mismatches,
  }
}

function checkModel(store: Store, output: Digest, call: Ref): { status: ReplayStatus; detail: string } {
  if (!store.has(call)) return { status: "mismatch", detail: "the recorded model call is missing" }
  const artifact = store.get(call)
  if (artifact.kind !== "artifact" || artifact.body.type !== "model-call")
    return { status: "mismatch", detail: "the receipt points at something that is not a model call" }
  const missing = [artifact.body.response, ...artifact.body.contents].filter((blob) => !store.blobs.has(blob))
  if (missing.length > 0) return { status: "mismatch", detail: `${missing.length} stored request or response files are missing` }
  if (output !== artifact.body.response) return { status: "mismatch", detail: "the receipt and the call name different responses" }
  return { status: "match", detail: "answered from the stored response, with no model call" }
}

function operationName(operation: { kind: string } & Record<string, unknown>): string {
  if (operation.kind === "tool") return `tool ${String(operation.tool)}`
  if (operation.kind === "model") return "model call"
  return "script"
}
