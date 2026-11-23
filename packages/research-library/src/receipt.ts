export * as Receipt from "./receipt.js"

import { Canonical, Ref, ResearchRecord } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { randomBytes } from "node:crypto"

/** Who is acting: the program that writes measurements, and the context of the call that asked for them. */
export interface Actor {
  /** The program's id, such as `research@2.3.0`. */
  readonly program: string
  readonly context: ResearchRecord.Context
  /** Names the tool call, so a retry of it replays its commit instead of writing twice. */
  readonly key?: string
  readonly now?: () => Date
}

export interface Tool {
  readonly tool: string
  readonly version: string
  /** Searches and fetches are `stored`: the library they ran against changes, so replay answers from their output. */
  readonly replay: "rerun" | "stored"
  readonly input: unknown
  readonly output: unknown
  readonly schema: { readonly input: string; readonly output: string }
}

/** A new object id: `<kind>-<16 hex>`. The random part is what a short address abbreviates. */
export function objectId(kind: ResearchRecord.Kind) {
  return `${kind}-${randomBytes(8).toString("hex")}`
}

/** A program revision of `kind` in the store's project, written in the actor's context. */
export function program<K extends ResearchRecord.Kind>(
  store: Store.Reader,
  actor: Actor,
  kind: K,
  body: unknown,
  id = objectId(kind),
) {
  return ResearchRecord.create({
    projectId: store.projectId,
    kind,
    schema: `${kind}@1`,
    objectId: id,
    parent: "none",
    author: { voice: "program", id: actor.program },
    context: actor.context,
    body,
  }) as ResearchRecord.Revision<K>
}

/**
 * Commits `revisions` with the receipt of the tool call that wrote them, in one commit, as the contract requires. The
 * call's input and output are stored as files the receipt names.
 */
export function commit(
  store: Store.Store,
  actor: Actor,
  started: string,
  tool: Tool,
  revisions: readonly ResearchRecord.Revision[],
) {
  const input = store.admit(new TextEncoder().encode(Canonical.json(tool.input))).digest
  const output = store.admit(new TextEncoder().encode(Canonical.json(tool.output))).digest
  const receipt = program(store, actor, "receipt", {
    at: { started, ended: now(actor) },
    step: {
      kind: "tool",
      tool: tool.tool,
      version: tool.version,
      replay: tool.replay,
      input: { digest: input, schema: tool.schema.input },
      output: { digest: output, schema: tool.schema.output },
    },
    // The contract keeps `written` sorted, so one set of revisions has one receipt.
    written: revisions.map(ResearchRecord.refOf).toSorted(Ref.compare),
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  })
  const committed = store.commit({
    ...(actor.key === undefined ? {} : { key: actor.key }),
    revisions: [...revisions, receipt],
  })
  return { receipt: ResearchRecord.refOf(receipt), seq: committed.seq, replayed: committed.replayed }
}

/**
 * Commits a researcher's command, such as a ruling typed at a terminal, with the receipt that names the command and
 * stores its input. The revisions it wrote are the researcher's own; the receipt is the program's account of them.
 */
export function command(
  store: Store.Store,
  actor: Actor,
  started: string,
  input: { readonly command: string; readonly input: unknown },
  revisions: readonly ResearchRecord.Revision[],
) {
  const stored = store.admit(new TextEncoder().encode(Canonical.json(input.input))).digest
  const receipt = program(store, actor, "receipt", {
    at: { started, ended: now(actor) },
    step: { kind: "command", command: input.command, input: { digest: stored, schema: `${input.command}-input@1` } },
    written: revisions.map(ResearchRecord.refOf).toSorted(Ref.compare),
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  })
  const committed = store.commit({
    ...(actor.key === undefined ? {} : { key: actor.key }),
    revisions: [...revisions, receipt],
  })
  return { receipt: ResearchRecord.refOf(receipt), seq: committed.seq }
}

export function now(actor: Actor) {
  return (actor.now?.() ?? new Date()).toISOString()
}
