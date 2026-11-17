export * as Delivery from "./delivery.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/** The longest budget a delivery may run for, measured from its start. */
export const MAX_BUDGET = 7 * 24 * 60 * 60 * 1000

/**
 * `active` while time remains and the agent keeps publishing, `stopping` once the user stops it or the budget runs
 * out and the agent is wrapping up, `done` once it has finished.
 */
export const Status = Schema.Literals(["active", "stopping", "done"])
export type Status = typeof Status.Type

export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  /** What was checked, for example the command that ran. */
  name: Schema.String,
  passed: Schema.Boolean,
}).annotate({ identifier: "Delivery.Check" })

export interface Version extends Schema.Schema.Type<typeof Version> {}
export const Version = Schema.Struct({
  /** Counts from 1 within a delivery. */
  number: Schema.Int,
  summary: Schema.String,
  checks: Schema.Array(Check),
  /** The inbox messages whose feedback this version answers. */
  feedback: optional(Schema.Array(Schema.String)),
  publishedAt: Schema.Number,
}).annotate({ identifier: "Delivery.Version" })

export interface State extends Schema.Schema.Type<typeof State> {}
export const State = Schema.Struct({
  id: Schema.String,
  objective: Schema.String,
  status: Status,
  /** Why the delivery last changed status, such as a stop by the user or the budget running out. */
  reason: optional(Schema.String),
  startedAt: Schema.Number,
  /** When the budget runs out, in epoch milliseconds. */
  deadline: Schema.Number,
  versions: Schema.Array(Version),
  /** The server process that started the delivery. */
  boot: Schema.String,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Delivery.State" })

const session = { sessionID: Schema.String }
const errors = {
  /** The Session has no delivery the method applies to. */
  inactive: Schema.toStandardSchemaV1(Schema.Struct({})),
}

/**
 * The live delivery plugin's RPC. Clients read a Session's delivery with `get` and keep it current from `changed`,
 * which the plugin publishes in the Session's Location on every write. `stop` asks an active delivery to wrap up and
 * leaves one already stopping as it is. `extend` adds time to an active delivery's budget, up to `MAX_BUDGET` from its
 * start. The schemas are Standard Schemas too, so Promise clients can call it.
 */
export const Definition = Rpc.define({
  id: "opencode.delivery",
  methods: {
    get: {
      input: Schema.toStandardSchemaV1(Schema.Struct(session)),
      output: Schema.toStandardSchemaV1(Schema.NullOr(State)),
    },
    stop: {
      input: Schema.toStandardSchemaV1(Schema.Struct(session)),
      output: Schema.toStandardSchemaV1(State),
      errors,
    },
    extend: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          ...session,
          /** Milliseconds to add to the budget. */
          by: Schema.Int.check(Schema.isGreaterThan(0)),
        }),
      ),
      output: Schema.toStandardSchemaV1(State),
      errors,
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String, delivery: Schema.NullOr(State) })),
    },
  },
})
