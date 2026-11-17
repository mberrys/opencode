export * as DeliveryPlugin from "./delivery.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Delivery } from "@opencode/schema/delivery"
import { Clock, Effect, Option, Schema, Stream } from "effect"

type State = Delivery.State
const decodeState = Schema.decodeUnknownOption(Delivery.State)
// Storage key prefix of a Session's delivery. Plugin storage is the plugin's own, so children and forks start without one.
const PREFIX = "session:"

/**
 * Live delivery: the agent ships a working first version, then publishes checked versions until its time budget runs
 * out or the user stops it. This holds each Session's delivery and serves it over RPC; the tools, the idle hook that
 * keeps the agent going, and the `/deliver` command build on it.
 */
export const Plugin = define({
  id: "opencode.delivery",
  effect: Effect.fn(function* (ctx) {
    const read = Effect.fn("DeliveryPlugin.read")(function* (sessionID: string) {
      return Option.getOrUndefined(decodeState(yield* ctx.storage.get(PREFIX + sessionID)))
    })

    const rpc = yield* ctx.rpc
      .register(Delivery.Definition, {
        get: (input) => read(input.sessionID).pipe(Effect.map((delivery) => delivery ?? null)),
        stop: (input, call) =>
          Effect.gen(function* () {
            const delivery = yield* read(input.sessionID)
            if (delivery?.status === "stopping") return delivery
            if (delivery?.status !== "active")
              return yield* Effect.fail(call.error("inactive", "No active delivery to stop.", {}))
            const next: State = {
              ...delivery,
              status: "stopping",
              reason: "Stopped by the user",
              updatedAt: yield* Clock.currentTimeMillis,
            }
            yield* write(input.sessionID, next)
            return next
          }),
        extend: (input, call) =>
          Effect.gen(function* () {
            const delivery = yield* read(input.sessionID)
            if (delivery?.status !== "active")
              return yield* Effect.fail(call.error("inactive", "No active delivery to extend.", {}))
            const next: State = {
              ...delivery,
              deadline: Math.min(delivery.deadline + input.by, delivery.startedAt + Delivery.MAX_BUDGET),
              updatedAt: yield* Clock.currentTimeMillis,
            }
            yield* write(input.sessionID, next)
            return next
          }),
      })
      .pipe(Effect.orDie)

    // Clients read the delivery through `get` and follow `changed`, so every write publishes the new value. The return
    // type is spelled out because the RPC handlers above call this before `rpc` is inferred.
    const write = (sessionID: string, delivery: State | undefined): Effect.Effect<void> =>
      (delivery ? ctx.storage.set(PREFIX + sessionID, delivery) : ctx.storage.remove(PREFIX + sessionID)).pipe(
        Effect.andThen(
          rpc.events
            .emit("changed", { sessionID, delivery: delivery ?? null })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to publish a delivery change", { sessionID, cause }),
              ),
            ),
        ),
        Effect.withSpan("DeliveryPlugin.write"),
      )

    yield* ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
      Stream.runForEach((event) =>
        ctx.storage.remove(PREFIX + event.data.sessionID).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to drop a deleted Session's delivery", {
              sessionID: event.data.sessionID,
              cause,
            }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
