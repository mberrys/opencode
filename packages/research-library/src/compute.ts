export * as Compute from "./compute.js"

import { Canonical, Ref, ResearchRecord } from "@opencode/research-record"
import type { Replay, Store } from "@opencode/research-store"
import { Option, Schema } from "effect"
import { Receipt } from "./receipt.js"

/**
 * The engine a computation runs in: arithmetic over named numbers. It reads no clock, no randomness, no files and no
 * network, so a stored script gives the same result wherever it is replayed, and running someone else's record is safe.
 */
export const ENGINE = { id: "research.compute", version: "1" } as const
export const SCRIPT = "research-compute-script@1"
export const RESULT = "research-compute-result@1"
export const TRANSFORMATION = "research.compute@1"

const Script = Schema.Struct({
  expression: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.Number),
})
export interface Script extends Schema.Schema.Type<typeof Script> {}

const decodeScript = Schema.decodeUnknownOption(Schema.fromJsonString(Script))

export interface Computed {
  readonly artifact: Ref.Exact
  readonly receipt: Ref.Exact
  /** The result's bytes, exactly as stored and as shown to whoever asked. */
  readonly result: string
  readonly value: number
}

/**
 * Runs a script and commits its result as an artifact, with the receipt of the run, in one commit: the script and
 * result are stored as files the receipt names, so replay can run the script again and compare. `from` names the
 * revisions the inputs were read from. A script that does not evaluate is refused and nothing is written.
 */
export function record(
  store: Store.Store,
  actor: Receipt.Actor,
  input: Script & { readonly from: readonly Ref.Exact[] },
): Computed {
  const started = Receipt.now(actor)
  const script = new TextEncoder().encode(Canonical.json({ expression: input.expression, inputs: input.inputs }))
  const value = evaluate({ expression: input.expression, inputs: input.inputs })
  const bytes = encodeResult(value)
  const result = store.admit(bytes).digest
  const artifact = Receipt.program(store, actor, "artifact", {
    inputs: [...input.from].toSorted(Ref.compare),
    output: { digest: result, schema: RESULT, mediaType: "application/json" },
    transformation: TRANSFORMATION,
  })
  const receipt = Receipt.program(store, actor, "receipt", {
    at: { started, ended: Receipt.now(actor) },
    step: {
      kind: "script",
      script: { digest: store.admit(script).digest, schema: SCRIPT },
      engine: ENGINE,
      clock: started,
      seed: "none",
      calls: [],
      result: { digest: result, schema: RESULT },
    },
    written: [ResearchRecord.refOf(artifact)],
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  })
  store.commit({ ...(actor.key === undefined ? {} : { key: actor.key }), revisions: [artifact, receipt] })
  return {
    artifact: ResearchRecord.refOf(artifact),
    receipt: ResearchRecord.refOf(receipt),
    result: new TextDecoder().decode(bytes),
    value,
  }
}

/**
 * Replays a stored script for `Replay.run`: the result bytes it produces now, or `undefined` for another engine. A
 * script that no longer evaluates produces an error result, which cannot match a recorded one.
 */
export function replay(step: Replay.ScriptStep, script: Uint8Array) {
  if (step.engine.id !== ENGINE.id || step.engine.version !== ENGINE.version) return undefined
  const decoded = decodeScript(new TextDecoder().decode(script))
  if (Option.isNone(decoded)) return new TextEncoder().encode(Canonical.json({ error: "not a compute script" }))
  try {
    return encodeResult(evaluate(decoded.value))
  } catch (error) {
    return new TextEncoder().encode(Canonical.json({ error: error instanceof Error ? error.message : String(error) }))
  }
}

function encodeResult(value: number) {
  return new TextEncoder().encode(Canonical.json({ value }))
}

/**
 * Evaluates `expression` over `inputs`: numbers, input names, `+ - * / ^`, parentheses and `min`, `max`, `abs`,
 * `sqrt`, `round`. Throws on anything else, and on a result that is not a finite number.
 */
export function evaluate(script: Script): number {
  const tokens = script.expression.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|\S/gi) ?? []
  const state = { at: 0 }
  const peek = () => tokens[state.at]
  const take = (expected?: string) => {
    const token = tokens[state.at]
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new Error(`expected ${expected ?? "more"} at token ${state.at + 1} of ${script.expression}`)
    state.at += 1
    return token
  }
  // `+ -` and `* /` fold left to right; `^` is right-associative, and unary minus binds tighter than it (-2^2 is 4).
  const sum = (): number => {
    let value = product()
    while (peek() === "+" || peek() === "-") value = take() === "+" ? value + product() : value - product()
    return value
  }
  const product = (): number => {
    let value = power()
    while (peek() === "*" || peek() === "/") value = take() === "*" ? value * power() : value / power()
    return value
  }
  const power = (): number => {
    const base = unary()
    if (peek() !== "^") return base
    take()
    return base ** power()
  }
  const unary = (): number => {
    if (peek() !== "-") return atom()
    take()
    return -unary()
  }
  const atom = (): number => {
    const token = take()
    if (token === "(") {
      const inner = sum()
      take(")")
      return inner
    }
    if (/^\d/.test(token)) return Number(token)
    if (Object.hasOwn(FUNCTIONS, token) && peek() === "(") {
      take("(")
      const args = [sum()]
      while (peek() === ",") {
        take()
        args.push(sum())
      }
      take(")")
      return FUNCTIONS[token](args)
    }
    if (Object.hasOwn(script.inputs, token)) return script.inputs[token]
    throw new Error(`unknown name ${token} in ${script.expression}`)
  }
  const value = sum()
  if (state.at < tokens.length) throw new Error(`unexpected ${tokens[state.at]} in ${script.expression}`)
  if (!Number.isFinite(value)) throw new Error(`${script.expression} is not a finite number`)
  // Canonical JSON has one zero.
  return value === 0 ? 0 : value
}

const FUNCTIONS: Readonly<Record<string, (args: readonly number[]) => number>> = {
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
  abs: (args) => Math.abs(args[0]),
  sqrt: (args) => Math.sqrt(args[0]),
  round: (args) => Math.round(args[0]),
}
