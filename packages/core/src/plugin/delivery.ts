export * as DeliveryPlugin from "./delivery.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Delivery } from "@opencode/schema/delivery"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Clock, DateTime, Effect, Option, Schema, Stream } from "effect"

type State = Delivery.State
const decodeState = Schema.decodeUnknownOption(Delivery.State)
// Storage key prefix of a Session's delivery. Plugin storage is the plugin's own, so children and forks start without one.
const PREFIX = "session:"
const MINUTE = 60 * 1000
// How much of each feedback message the status tool repeats back to the model.
const FEEDBACK_PREVIEW = 300

const WRAP_UP = "Start no new scope. Publish a version that is already usable, then call delivery_done."

/**
 * Live delivery: the agent ships a working first version, then publishes checked versions until its time budget runs
 * out or the user stops it. This holds each Session's delivery, serves it over RPC, and gives the agent the tools to
 * plan, publish, read and finish it. The idle hook that keeps the agent going and the `/deliver` command build on it.
 *
 * The tool rules follow the Qwen Live Delivery Plugin (Apache-2.0): https://github.com/QwenLM/Qwen-Live-Delivery-Plugin
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

    const current = (sessionID: string) =>
      read(sessionID).pipe(
        Effect.flatMap((delivery) =>
          delivery
            ? Effect.succeed(delivery)
            : Effect.fail(failure("This session has no live delivery. The user starts one with /deliver.")),
        ),
      )

    // The user's messages since the delivery started are its feedback. Compaction drops older ones from the context.
    const userMessages = Effect.fn("DeliveryPlugin.userMessages")(function* (sessionID: Session.ID, delivery: State) {
      const messages = yield* ctx.session
        .context({ sessionID })
        .pipe(Effect.mapError((error) => new Tool.Error({ message: "Unable to read the session's feedback", error })))
      return messages.flatMap((message) =>
        message.type === "user" && DateTime.toEpochMillis(message.time.created) >= delivery.startedAt
          ? [{ id: String(message.id), text: message.text }]
          : [],
      )
    })

    yield* ctx.tool
      .transform((editor) => {
        editor.namespace({
          name: "delivery",
          description:
            "Live delivery, for sessions the user started with /deliver: plan the next version, publish it once its checks pass, read the budget and feedback, and finish.",
        })

        editor.add({
          name: "plan",
          description:
            "Commit to the next version during a live delivery: a concise title, its scope, observable acceptance criteria and when you expect to publish it. Start with the smallest version that serves the user's core purpose. Call it again to replace the plan when feedback changes it. Production starts at once; no approval is needed.",
          options: { namespace: "delivery", codemode: false },
          input: Schema.Struct({
            title: Schema.String,
            scope: Schema.String.annotate({
              description: "What this version adds, as a useful part of the objective.",
            }),
            acceptance: Schema.Array(Schema.String)
              .check(Schema.isMinLength(1))
              .annotate({ description: "Observable criteria. Publishing needs a passing check named after each one." }),
            dueInMinutes: Schema.Number.check(Schema.isGreaterThan(0)).annotate({
              description: "Minutes from now until you expect to publish it, within the time left.",
            }),
          }),
          output: Delivery.State,
          execute: (input, tool) =>
            Effect.gen(function* () {
              const delivery = yield* current(tool.sessionID)
              if (delivery.status === "done") return yield* Effect.fail(failure("The delivery is done."))
              const now = yield* Clock.currentTimeMillis
              if (delivery.status === "stopping" || now >= delivery.deadline)
                return yield* Effect.fail(failure(`The delivery is wrapping up. ${WRAP_UP}`))
              const dueAt = now + input.dueInMinutes * MINUTE
              if (dueAt > delivery.deadline)
                return yield* Effect.fail(
                  failure(
                    `That is past the budget, which has ${minutes(delivery.deadline - now)} left. Plan a smaller version.`,
                  ),
                )
              const next: State = {
                ...delivery,
                next: { title: input.title, scope: input.scope, acceptance: input.acceptance, dueAt },
                updatedAt: now,
              }
              yield* write(tool.sessionID, next)
              return {
                output: next,
                content: `Planned "${input.title}", due in ${minutes(dueAt - now)}. Build it, run a check for each acceptance criterion, then publish it with delivery_publish.`,
              }
            }),
        })

        editor.add({
          name: "publish",
          description:
            "Publish the planned version once it is usable. Report every check truthfully: each acceptance criterion needs a passing check with exactly its name, and a failed or unrun check is never reported as passed. A plan changed by feedback invalidates earlier checks, so recheck against the latest plan. Name the feedback messages this version answers.",
          options: { namespace: "delivery", codemode: false },
          input: Schema.Struct({
            summary: Schema.String.annotate({ description: "What changed in this version, for the user." }),
            checks: Schema.Array(Delivery.Check).check(Schema.isMinLength(1)),
            feedback: Schema.optional(
              Schema.Array(Schema.String).annotate({
                description: "IDs of the feedback messages this version answers, as delivery_status lists them.",
              }),
            ),
          }),
          output: Delivery.State,
          execute: (input, tool) =>
            Effect.gen(function* () {
              const delivery = yield* current(tool.sessionID)
              if (delivery.status === "done") return yield* Effect.fail(failure("The delivery is done."))
              const milestone = delivery.next
              if (!milestone)
                return yield* Effect.fail(
                  failure("No version is planned. Plan it with delivery_plan before publishing."),
                )
              const unmet = milestone.acceptance.filter(
                (criterion) => !input.checks.some((check) => check.name === criterion && check.passed),
              )
              if (unmet.length > 0)
                return yield* Effect.fail(
                  failure(
                    [
                      "Not published. Each acceptance criterion needs a passing check with exactly its name. Missing or failing:",
                      ...unmet.map((criterion) => `- ${criterion}`),
                    ].join("\n"),
                  ),
                )
              const answered = input.feedback ?? []
              if (answered.length > 0) {
                const known = new Set((yield* userMessages(tool.sessionID, delivery)).map((message) => message.id))
                const unknown = answered.filter((id) => !known.has(id))
                if (unknown.length > 0)
                  return yield* Effect.fail(
                    failure(
                      `Not published. No feedback message has the ID ${unknown.join(", ")}; delivery_status lists them.`,
                    ),
                  )
              }
              // Re-read so a stop or extension that landed while the feedback was read is kept.
              const latest = yield* current(tool.sessionID)
              const now = yield* Clock.currentTimeMillis
              const { next: _published, ...rest } = latest
              const published: State = {
                ...rest,
                versions: [
                  ...latest.versions,
                  {
                    number: latest.versions.length + 1,
                    title: milestone.title,
                    summary: input.summary,
                    checks: input.checks,
                    ...(answered.length > 0 ? { feedback: answered } : {}),
                    publishedAt: now,
                  },
                ],
                updatedAt: now,
              }
              yield* write(tool.sessionID, published)
              const number = published.versions.length
              return {
                output: published,
                content:
                  latest.status === "stopping" || now >= latest.deadline
                    ? `Published version ${number}. The delivery is wrapping up: call delivery_done.`
                    : `Published version ${number}. ${minutes(latest.deadline - now)} left: compare it with the full objective and plan the next version with delivery_plan.`,
              }
            }),
        })

        editor.add({
          name: "status",
          description:
            "Read the live delivery: the objective, the time left, the published versions, the planned version, and feedback no version has answered yet. Read it at phase changes, not to fill time.",
          options: { namespace: "delivery", codemode: false },
          input: Schema.Struct({}),
          execute: (_input, tool) =>
            Effect.gen(function* () {
              const delivery = yield* current(tool.sessionID)
              const answered = new Set(delivery.versions.flatMap((version) => version.feedback ?? []))
              const feedback = (yield* userMessages(tool.sessionID, delivery)).filter(
                (message) => !answered.has(message.id),
              )
              return {
                output: { delivery, feedback },
                content: describe(delivery, yield* Clock.currentTimeMillis, feedback),
              }
            }),
        })

        editor.add({
          name: "done",
          description:
            "Finish the live delivery once the user stops it or the time budget runs out. Finishing the current plan is not finishing: while time remains, plan the next version instead. Publish any improvement that is already usable first.",
          options: { namespace: "delivery", codemode: false },
          input: Schema.Struct({
            summary: Schema.String.annotate({ description: "What the user has now, and anything left unfinished." }),
          }),
          output: Delivery.State,
          execute: (input, tool) =>
            Effect.gen(function* () {
              const delivery = yield* current(tool.sessionID)
              if (delivery.status === "done") return yield* Effect.fail(failure("The delivery is already done."))
              const now = yield* Clock.currentTimeMillis
              if (delivery.status === "active" && now < delivery.deadline)
                return yield* Effect.fail(
                  failure(
                    `${minutes(delivery.deadline - now)} left. Plan and publish the next version; only the user can stop the delivery early.`,
                  ),
                )
              const done: State = {
                ...delivery,
                status: "done",
                reason: delivery.reason ?? "The time budget ran out",
                summary: input.summary,
                updatedAt: now,
              }
              yield* write(tool.sessionID, done)
              const count = done.versions.length
              return {
                output: done,
                content: `Delivery finished with ${count === 0 ? "no published version" : count === 1 ? "1 version" : `${count} versions`}.`,
              }
            }),
        })
      })
      .pipe(Effect.orDie)
  }),
})

function failure(message: string) {
  return new Tool.Error({ message })
}

function minutes(ms: number) {
  const count = Math.max(0, Math.ceil(ms / MINUTE))
  return count === 1 ? "1 minute" : `${count} minutes`
}

function describe(delivery: State, now: number, feedback: ReadonlyArray<{ id: string; text: string }>) {
  const status =
    delivery.status === "done"
      ? `done: ${delivery.reason ?? "finished"}`
      : delivery.status === "stopping"
        ? `wrapping up: ${delivery.reason ?? "stopped"}. ${WRAP_UP}`
        : now >= delivery.deadline
          ? `the time budget ran out. ${WRAP_UP}`
          : `active, ${minutes(delivery.deadline - now)} left`
  const latest = delivery.versions.at(-1)
  const next = delivery.next
  return [
    `Objective: ${delivery.objective}`,
    `Status: ${status}`,
    latest
      ? `Published: ${delivery.versions.length} version${delivery.versions.length === 1 ? "" : "s"}; latest is ${latest.number}, "${latest.title}": ${latest.summary}`
      : "Published: nothing yet.",
    ...(next
      ? [
          `Planned: "${next.title}", due in ${minutes(next.dueAt - now)}`,
          `Scope: ${next.scope}`,
          "Acceptance:",
          ...next.acceptance.map((criterion) => `- ${criterion}`),
        ]
      : delivery.status === "active"
        ? ["Planned: nothing. Plan the next version with delivery_plan."]
        : []),
    ...(feedback.length > 0
      ? [
          "Feedback no version has answered yet:",
          ...feedback.map((message) => `- [${message.id}] ${truncate(message.text, FEEDBACK_PREVIEW)}`),
        ]
      : ["Feedback: none waiting."]),
  ].join("\n")
}

function truncate(text: string, length: number) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}
