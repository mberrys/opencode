import { describe, expect } from "bun:test"
import { Effect, Exit, Option, Queue, Schema, Stream } from "effect"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Delivery } from "@opencode/schema/delivery"
import { DeliveryPlugin } from "@opencode/core/plugin/delivery"
import { Session } from "@opencode/core/session"
import type { SessionEvent } from "@opencode/core/session/event"
import { it } from "../lib/effect"
import { host } from "./host"

const sessionID = Session.ID.make("ses_delivery")
const minute = 60 * 1000

const active: Delivery.State = {
  id: "delivery-1",
  objective: "Build a pendulum experiment",
  status: "active",
  startedAt: 0,
  deadline: 12 * minute,
  versions: [],
  boot: "boot",
  updatedAt: 0,
}

// SAFETY: the plugin reads only the type and Session ID of a deleted event.
const deleted = (id: Session.ID) =>
  ({ type: "session.deleted", data: { sessionID: id } }) as unknown as SessionEvent.Deleted

// SAFETY: the plugin only passes the error factory's result to Effect.fail; tests read its type.
const call = {
  error: (type: string, message: string, data: unknown) => ({ type, message, data }),
} as never

/** Runs the delivery plugin against plugin storage in memory and an RPC stub that records what it publishes. */
const run = Effect.fnUntraced(function* (seed?: Delivery.State) {
  const stored = new Map<string, Schema.Json>(seed ? [[`session:${sessionID}`, seed]] : [])
  const changed: unknown[] = []
  const handlers: Partial<RpcHandlers<typeof Delivery.Definition>> = {}
  const events = yield* Queue.unbounded<SessionEvent.Deleted>()
  yield* DeliveryPlugin.Plugin.effect(
    host({
      storage: {
        get: (key) => Effect.sync(() => stored.get(key)),
        set: (key, value) => Effect.sync(() => void stored.set(key, value)),
        remove: (key) => Effect.sync(() => void stored.delete(key)),
        scan: () => Effect.die("unused storage.scan"),
      },
      rpc: Object.assign(
        () => {
          throw new Error("unused rpc.client")
        },
        {
          // SAFETY: the delivery plugin registers one RPC, whose handlers and `changed` events these tests observe.
          register: ((_definition: unknown, registered: typeof handlers) =>
            Effect.sync(() => {
              Object.assign(handlers, registered)
              return {
                dispose: Effect.void,
                events: { emit: (_name: string, data: unknown) => Effect.sync(() => void changed.push(data)) },
              }
            })) as never,
        },
      ),
      // SAFETY: the plugin only filters the stream by event type.
      event: { subscribe: () => Stream.fromQueue(events) as never },
    }),
  )
  // Let the forked event watcher start.
  yield* Effect.yieldNow
  const handler = <Name extends keyof typeof handlers>(name: Name) =>
    handlers[name] ?? (() => Effect.die(`the delivery RPC has no ${name} handler`))
  return {
    delivery: () =>
      Option.getOrUndefined(Schema.decodeUnknownOption(Delivery.State)(stored.get(`session:${sessionID}`))),
    changed,
    get: () => handler("get")({ sessionID }, call),
    stop: () => handler("stop")({ sessionID }, call),
    extend: (by: number) => handler("extend")({ sessionID, by }, call),
    delete: (id: Session.ID) =>
      Queue.offer(events, deleted(id)).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow)),
  }
})

const failureType = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined

describe("delivery plugin", () => {
  it.effect("serves a Session's delivery, and null without one", () =>
    Effect.gen(function* () {
      expect(yield* (yield* run()).get()).toBeNull()
      expect(yield* (yield* run(active)).get()).toEqual(active)
    }),
  )

  it.effect("stops an active delivery and publishes the change", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      const stopped = yield* plugin.stop()

      expect(stopped).toMatchObject({ status: "stopping", reason: "Stopped by the user" })
      expect(plugin.delivery()).toEqual(stopped)
      expect(plugin.changed).toEqual([{ sessionID, delivery: stopped }])
    }),
  )

  it.effect("leaves a stopping delivery as it is when stopped again", () =>
    Effect.gen(function* () {
      const stopping: Delivery.State = { ...active, status: "stopping", reason: "The time budget ran out" }
      const plugin = yield* run(stopping)

      expect(yield* plugin.stop()).toEqual(stopping)
      expect(plugin.changed).toEqual([])
    }),
  )

  it.effect("refuses to stop or extend a delivery that is not active", () =>
    Effect.gen(function* () {
      const none = yield* run()
      const done = yield* run({ ...active, status: "done" })

      expect(failureType(yield* Effect.exit(none.stop()))).toMatchObject({ type: "inactive" })
      expect(failureType(yield* Effect.exit(done.stop()))).toMatchObject({ type: "inactive" })
      expect(failureType(yield* Effect.exit(done.extend(minute)))).toMatchObject({ type: "inactive" })
      expect(done.delivery()?.status).toBe("done")
      expect(done.changed).toEqual([])
    }),
  )

  it.effect("extends the budget, up to the longest budget from the start", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      expect((yield* plugin.extend(5 * minute)).deadline).toBe(17 * minute)
      expect((yield* plugin.extend(Delivery.MAX_BUDGET)).deadline).toBe(Delivery.MAX_BUDGET)
      expect(plugin.delivery()?.deadline).toBe(Delivery.MAX_BUDGET)
      expect(plugin.changed).toHaveLength(2)
    }),
  )

  it.effect("drops a deleted Session's delivery and keeps others", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.delete(Session.ID.make("ses_other"))
      expect(plugin.delivery()).toEqual(active)

      yield* plugin.delete(sessionID)
      expect(plugin.delivery()).toBeUndefined()
    }),
  )
})
