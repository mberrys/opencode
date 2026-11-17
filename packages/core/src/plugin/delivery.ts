export * as DeliveryPlugin from "./delivery.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionIdleBackground } from "@opencode/plugin/effect/session"
import { Delivery } from "@opencode/schema/delivery"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Cause, Clock, Duration, Effect, FiberMap, Option, Schema, Stream } from "effect"

/** Continuations in a row without a tool call after which the delivery stops instead of looping until its deadline. */
export const MAX_STALLS = 3

type State = Delivery.State
const decodeState = Schema.decodeUnknownOption(Delivery.State)
// Storage key prefix of a Session's delivery. Plugin storage is the plugin's own, so children and forks start without one.
const PREFIX = "session:"
const MINUTE = 60 * 1000
// How much of each feedback message the delivery keeps, and how much the status tool repeats back to the model.
const FEEDBACK_TEXT = 2_000
const FEEDBACK_PREVIEW = 300
// Identifies this server process. A delivery started by an earlier process stops instead of resuming on its own.
// Created on first use: Workers forbid random values while a module loads.
let processBoot: string | undefined
export const boot = () => (processBoot ??= crypto.randomUUID())

const WRAP_UP = "Start no new scope. Publish a version that is already usable, then call delivery_done."

/**
 * Live delivery: the agent ships a working first version, then publishes checked versions until its time budget runs
 * out or the user stops it. This holds each Session's delivery and serves it over RPC, gives the agent the tools to
 * plan, publish, read and finish it, keeps the agent going while time remains, and tells it to wrap up when the budget
 * runs out or the user stops it. The `/deliver` command builds on it.
 *
 * The tool rules follow the Qwen Live Delivery Plugin (Apache-2.0): https://github.com/QwenLM/Qwen-Live-Delivery-Plugin
 */
export const Plugin = define({
  id: "opencode.delivery",
  effect: Effect.fn(function* (ctx) {
    const read = Effect.fn("DeliveryPlugin.read")(function* (sessionID: string) {
      return Option.getOrUndefined(decodeState(yield* ctx.storage.get(PREFIX + sessionID)))
    })

    const timers = yield* FiberMap.make<string>()

    const rpc = yield* ctx.rpc
      .register(Delivery.Definition, {
        get: (input) => read(input.sessionID).pipe(Effect.map((delivery) => delivery ?? null)),
        stop: (input, call) =>
          Effect.gen(function* () {
            const sessionID = Session.ID.make(input.sessionID)
            const delivery = yield* read(sessionID)
            if (delivery?.status === "stopping") return delivery
            if (delivery?.status !== "active")
              return yield* Effect.fail(call.error("inactive", "No active delivery to stop.", {}))
            // The user's stop wins over the loop, so it writes without the loop's guard.
            const next: State = {
              ...delivery,
              status: "stopping",
              stoppedBy: "user",
              reason: "Stopped by the user",
              wrapUpSent: true,
              updatedAt: yield* Clock.currentTimeMillis,
            }
            yield* write(sessionID, next)
            yield* FiberMap.remove(timers, sessionID)
            yield* notify(
              { sessionID, text: wrapUp(next), description: "Live delivery: wrapping up", resume: true },
              next,
            )
            return next
          }),
        extend: (input, call) =>
          Effect.gen(function* () {
            const sessionID = Session.ID.make(input.sessionID)
            const delivery = yield* read(sessionID)
            if (!delivery || (delivery.status !== "active" && !resumable(delivery)))
              return yield* Effect.fail(call.error("inactive", "No delivery whose budget can be extended.", {}))
            const now = yield* Clock.currentTimeMillis
            const deadline = Math.min(
              Math.max(delivery.deadline, now) + input.by,
              delivery.startedAt + Delivery.MAX_BUDGET,
            )
            if (deadline <= now)
              return yield* Effect.fail(call.error("inactive", "The delivery has used the longest budget.", {}))
            if (delivery.status === "active") {
              const next: State = { ...delivery, deadline, updatedAt: now }
              yield* write(sessionID, next)
              yield* schedule(sessionID, next)
              return next
            }
            const { stoppedBy: _stoppedBy, reason: _reason, wrapUpSent: _wrapUpSent, ...rest } = delivery
            const resumed: State = { ...rest, status: "active", deadline, stalls: 0, boot: boot(), updatedAt: now }
            yield* write(sessionID, resumed)
            yield* schedule(sessionID, resumed)
            yield* notify(
              {
                sessionID,
                text: continuation(resumed, now, [], "The user extended the budget, so the live delivery resumes."),
                description: "Live delivery: budget extended",
                resume: true,
              },
              resumed,
            )
            return resumed
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

    // The loop's own writes apply only to the delivery they were decided on. Storage has no compare-and-set, so this
    // re-reads first: a publish, stop or extension that landed meanwhile wins instead of being overwritten.
    const replace = Effect.fn("DeliveryPlugin.replace")(function* (sessionID: string, expected: State, next: State) {
      const current = yield* read(sessionID)
      if (current?.id !== expected.id || current.updatedAt !== expected.updatedAt || current.status !== expected.status)
        return false
      yield* write(sessionID, next)
      return true
    })

    // A message the agent should see. It is logged rather than failed: the state change it reports is already written.
    const notify = (
      input: { sessionID: Session.ID; text: string; description?: string; resume?: boolean },
      delivery: State,
    ): Effect.Effect<void> =>
      ctx.session.synthetic({ ...input, metadata: { source: "delivery", deliveryID: delivery.id } }).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to message a delivery's agent", { sessionID: input.sessionID, cause }),
        ),
      )

    // Stops a delivery the loop decided on and tells the agent to wrap up. `resume` wakes a Session that is idle; inside
    // the idle hook the message continues the same execution instead.
    const halt = Effect.fn("DeliveryPlugin.halt")(function* (
      sessionID: Session.ID,
      delivery: State,
      stoppedBy: Delivery.StoppedBy,
      reason: string,
      resume: boolean,
    ) {
      const next: State = {
        ...delivery,
        status: "stopping",
        stoppedBy,
        reason,
        wrapUpSent: true,
        updatedAt: yield* Clock.currentTimeMillis,
      }
      if (!(yield* replace(sessionID, delivery, next))) return
      yield* notify(
        { sessionID, text: wrapUp(next), description: "Live delivery: wrapping up", ...(resume ? { resume } : {}) },
        next,
      )
    })

    // A delivery an earlier process started stops without waking its Session; extending the budget resumes it.
    const settleRestart = Effect.fn("DeliveryPlugin.settleRestart")(function* (sessionID: Session.ID, delivery: State) {
      yield* replace(sessionID, delivery, {
        ...delivery,
        status: "stopping",
        stoppedBy: "restart",
        reason: "The server restarted while the delivery was active",
        updatedAt: yield* Clock.currentTimeMillis,
      })
    })

    const expire = Effect.fn("DeliveryPlugin.expire")(function* (sessionID: Session.ID, deliveryID: string) {
      const delivery = yield* read(sessionID)
      if (delivery?.id !== deliveryID || delivery.status !== "active") return
      if ((yield* Clock.currentTimeMillis) < delivery.deadline) return
      yield* halt(sessionID, delivery, "budget", "The time budget ran out", true)
    })

    // Arms the deadline timer of an active delivery, replacing an earlier one. The timer never removes itself: it ends
    // after it fires, and one left behind by a stop finds the delivery no longer active.
    const schedule = Effect.fn("DeliveryPlugin.schedule")(function* (sessionID: Session.ID, delivery: State) {
      if (delivery.status !== "active") return yield* FiberMap.remove(timers, sessionID)
      const wait = Math.max(0, delivery.deadline - (yield* Clock.currentTimeMillis))
      yield* FiberMap.run(
        timers,
        sessionID,
        Effect.sleep(Duration.millis(wait)).pipe(
          Effect.andThen(expire(sessionID, delivery.id)),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to stop a delivery at its deadline", { sessionID, cause }),
          ),
        ),
      )
    })

    // Whether the agent called any tool since the delivery's last message to it. Without that message in view, for
    // example after a compaction, the round counts as progress.
    const usedTools = Effect.fn("DeliveryPlugin.usedTools")(function* (sessionID: Session.ID, deliveryID: string) {
      const messages = yield* ctx.session.context({ sessionID })
      const start = messages.findLastIndex(
        (message) =>
          (message.type === "synthetic" || message.type === "user") && message.metadata?.deliveryID === deliveryID,
      )
      return (
        start === -1 ||
        messages
          .slice(start + 1)
          .some((message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"))
      )
    })

    // Stop-hook style loop: the runner fires this only once the Session would go idle with nothing pending, and input
    // admitted here continues the same execution.
    const idle = Effect.fn("DeliveryPlugin.idle")(function* (
      sessionID: Session.ID,
      background: ReadonlyArray<SessionIdleBackground>,
    ) {
      const delivery = yield* read(sessionID)
      if (delivery?.status !== "active" && delivery?.status !== "stopping") return
      if (delivery.status === "active" && delivery.boot !== boot()) return yield* settleRestart(sessionID, delivery)
      // The Session's own running subagent or image job wakes it with its notice, and the hook runs again then.
      if (
        background.some((work) => (work.kind === "subagent" || work.kind === "image") && work.sessionID === sessionID)
      )
        return
      const now = yield* Clock.currentTimeMillis

      if (delivery.status === "stopping") {
        if (!delivery.wrapUpSent) {
          const next: State = { ...delivery, wrapUpSent: true, updatedAt: now }
          if (!(yield* replace(sessionID, delivery, next))) return
          return yield* notify({ sessionID, text: wrapUp(next), description: "Live delivery: wrapping up" }, next)
        }
        // It was told to wrap up and stopped anyway, so finish it rather than ask again.
        return yield* replace(sessionID, delivery, {
          ...delivery,
          status: "done",
          summary: delivery.summary ?? "The agent stopped without calling delivery_done.",
          updatedAt: now,
        })
      }

      if (now >= delivery.deadline) return yield* halt(sessionID, delivery, "budget", "The time budget ran out", false)
      const stalls = (yield* usedTools(sessionID, delivery.id)) ? 0 : (delivery.stalls ?? 0) + 1
      if (stalls >= MAX_STALLS)
        return yield* halt(
          sessionID,
          delivery,
          "stalled",
          `The agent called no tool in ${MAX_STALLS} continuations in a row`,
          false,
        )
      const next: State = { ...delivery, stalls, updatedAt: now }
      if (!(yield* replace(sessionID, delivery, next))) return
      // Only the Session's own shells wake it when they finish, so the agent hears about them instead of waiting.
      const shells = background.flatMap((work) =>
        work.kind === "shell" && work.sessionID === sessionID ? [work.command] : [],
      )
      // No description: timelines hide the continuation.
      yield* notify({ sessionID, text: continuation(next, now, shells) }, next)
    })

    yield* ctx.session.hook("experimental.idle", (event) =>
      idle(event.sessionID, event.background).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("delivery continuation failed", { sessionID: event.sessionID, cause }),
        ),
      ),
    )

    // The user's messages while the delivery runs are its feedback. They are kept as they arrive, so a compaction that
    // drops them from the context does not drop them from the delivery. The inbox ID becomes the message's ID.
    const record = Effect.fn("DeliveryPlugin.record")(function* (sessionID: Session.ID, feedback: Delivery.Feedback) {
      const delivery = yield* read(sessionID)
      if (delivery?.status !== "active" && delivery?.status !== "stopping") return
      if (delivery.feedback?.some((item) => item.id === feedback.id)) return
      yield* write(sessionID, {
        ...delivery,
        feedback: [...(delivery.feedback ?? []), feedback],
        updatedAt: yield* Clock.currentTimeMillis,
      })
    })

    const withdraw = Effect.fn("DeliveryPlugin.withdraw")(function* (sessionID: Session.ID, id: string) {
      const delivery = yield* read(sessionID)
      if (!delivery?.feedback?.some((item) => item.id === id)) return
      yield* write(sessionID, {
        ...delivery,
        feedback: delivery.feedback.filter((item) => item.id !== id),
        updatedAt: yield* Clock.currentTimeMillis,
      })
    })

    yield* ctx.event
      .subscribe({ types: ["session.inbox.enqueued", "session.inbox.cancelled", "session.deleted"] })
      .pipe(
        Stream.runForEach((event) => {
          const sessionID = event.data.sessionID
          const handled =
            event.type === "session.deleted"
              ? FiberMap.remove(timers, sessionID).pipe(Effect.andThen(ctx.storage.remove(PREFIX + sessionID)))
              : event.type === "session.inbox.cancelled"
                ? withdraw(sessionID, event.data.inboxID)
                : event.data.item.type === "user"
                  ? record(sessionID, {
                      id: event.data.inboxID,
                      text: event.data.item.payload.text.slice(0, FEEDBACK_TEXT),
                      at: event.created,
                    })
                  : Effect.void
          return handled.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to follow a delivery's Session", { sessionID, type: event.type, cause }),
            ),
          )
        }),
        Effect.forkScoped({ startImmediately: true }),
      )

    // A delivery an earlier process left active has no timer and nothing driving it, so stop those now; the boot check
    // in the hook covers any that wake first. Deliveries of Sessions deleted while no instance listened are dropped.
    // This assumes one server process per database, as the goal plugin does.
    yield* Effect.gen(function* () {
      let after: string | undefined
      do {
        const page = yield* ctx.storage.scan({ prefix: PREFIX, after, limit: 100 })
        yield* Effect.forEach(
          page.entries,
          (entry) =>
            Effect.gen(function* () {
              const sessionID = Session.ID.make(entry.key.slice(PREFIX.length))
              const session = yield* ctx.session.get({ sessionID }).pipe(Effect.option)
              if (Option.isNone(session)) return yield* ctx.storage.remove(entry.key)
              const delivery = Option.getOrUndefined(decodeState(entry.value))
              if (delivery?.status !== "active" || delivery.boot === boot()) return
              yield* settleRestart(sessionID, delivery)
            }),
          { discard: true },
        )
        after = page.next
      } while (after !== undefined)
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop deliveries left by an earlier process", { cause }),
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
              const known = new Set((delivery.feedback ?? []).map((item) => item.id))
              const unknown = answered.filter((id) => !known.has(id))
              if (unknown.length > 0)
                return yield* Effect.fail(
                  failure(
                    `Not published. No feedback message has the ID ${unknown.join(", ")}; delivery_status lists them.`,
                  ),
                )
              const now = yield* Clock.currentTimeMillis
              const { next: _published, ...rest } = delivery
              const published: State = {
                ...rest,
                versions: [
                  ...delivery.versions,
                  {
                    number: delivery.versions.length + 1,
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
                  delivery.status === "stopping" || now >= delivery.deadline
                    ? `Published version ${number}. The delivery is wrapping up: call delivery_done.`
                    : `Published version ${number}. ${minutes(delivery.deadline - now)} left: compare it with the full objective and plan the next version with delivery_plan.`,
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
              const feedback = (delivery.feedback ?? []).filter((item) => !answered.has(item.id))
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
              yield* FiberMap.remove(timers, tool.sessionID)
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

function resumable(delivery: State) {
  return delivery.status === "stopping" && (delivery.stoppedBy === "budget" || delivery.stoppedBy === "restart")
}

function minutes(ms: number) {
  const count = Math.max(0, Math.ceil(ms / MINUTE))
  return count === 1 ? "1 minute" : `${count} minutes`
}

function continuation(delivery: State, now: number, shells: ReadonlyArray<string>, lead?: string) {
  const next = delivery.next
  return [
    lead ?? "The live delivery continues.",
    `${minutes(delivery.deadline - now)} left.`,
    next
      ? `Keep building "${next.title}", due ${next.dueAt > now ? `in ${minutes(next.dueAt - now)}` : "now"}. Publish it with delivery_publish once each acceptance criterion has a passing check.`
      : `${delivery.versions.length === 0 ? "Plan the first version" : "Compare the latest version with the full objective and plan the next one"} with delivery_plan, then build it.`,
    "Finishing a plan does not finish the delivery: it runs until the user stops it or the time runs out. delivery_status has the objective and any feedback.",
    ...(shells.length > 0 ? ["Background shells still running:", ...shells.map((command) => `- ${command}`)] : []),
  ].join("\n")
}

function wrapUp(delivery: State) {
  return `The live delivery is wrapping up: ${delivery.reason ?? "it was stopped"}. ${WRAP_UP}`
}

function describe(delivery: State, now: number, feedback: ReadonlyArray<Delivery.Feedback>) {
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
