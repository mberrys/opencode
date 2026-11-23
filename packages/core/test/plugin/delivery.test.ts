import { describe, expect } from "bun:test"
import { Effect, Exit, Option, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import type { SessionIdle, SessionIdleBackground } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Delivery } from "@opencode/schema/delivery"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { DeliveryPlugin } from "@opencode/core/plugin/delivery"
import { Session } from "@opencode/core/session"
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
  boot: DeliveryPlugin.boot(),
  updatedAt: 0,
}

// SAFETY: the plugin reads only the type, Session ID, inbox ID, item and creation time of these events.
type Watched = { readonly type: string; readonly created?: number; readonly data: Record<string, unknown> }
const deleted = (id: Session.ID): Watched => ({ type: "session.deleted", data: { sessionID: id } })
const enqueued = (id: string, type: "user" | "synthetic", text: string, at: number): Watched => ({
  type: "session.inbox.enqueued",
  created: at,
  data: { sessionID, inboxID: id, item: { type, payload: { text }, delivery: "steer" } },
})
const cancelled = (id: string): Watched => ({ type: "session.inbox.cancelled", data: { sessionID, inboxID: id } })

// SAFETY: the plugin reads only the type, metadata and tool parts of context messages.
const deliveryMessage = { type: "synthetic", metadata: { deliveryID: active.id } } as unknown as SessionMessage.Info
const toolCall = { type: "assistant", content: [{ type: "tool", name: "bash" }] } as unknown as SessionMessage.Info
const statusCall = {
  type: "assistant",
  content: [{ type: "tool", name: "delivery_status" }],
} as unknown as SessionMessage.Info
const reply = { type: "assistant", content: [{ type: "text" }] } as unknown as SessionMessage.Info

// SAFETY: the plugin only passes the error factory's result to Effect.fail; tests read its type.
const call = {
  error: (type: string, message: string, data: unknown) => ({ type, message, data }),
} as never

const toolContext: Tool.Context = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_delivery_tool"),
  id: Tool.CallID.make("call_delivery"),
  progress: () => Effect.void,
}

interface Sent {
  readonly sessionID: Session.ID
  readonly text: string
  readonly description?: string
  readonly resume?: boolean
  readonly metadata?: Record<string, unknown>
}

/**
 * Runs the delivery plugin against stubbed domains: plugin storage in memory, an RPC stub that records what it
 * publishes, a tool editor that keeps the tools it adds, the idle hook it registers, a Session context the test can
 * change, and the synthetic messages it sends.
 */
const run = Effect.fnUntraced(function* (
  seed?: Delivery.State,
  options: {
    context?: () => ReadonlyArray<SessionMessage.Info>
    // The Session is gone, or looking it up fails for another reason.
    missing?: boolean
    unavailable?: boolean
    // Storage reads yield before returning, as a database read lets other fibers run.
    yields?: boolean
    // Runs while a message is being sent, before it is recorded. A failure means the message was not sent.
    sending?: () => Effect.Effect<void, unknown>
  } = {},
) {
  const stored = new Map<string, Schema.Json>(seed ? [[`session:${sessionID}`, seed]] : [])
  const changed: unknown[] = []
  const sent: Sent[] = []
  const handlers: Partial<RpcHandlers<typeof Delivery.Definition>> = {}
  const tools = new Map<string, Tool.Info>()
  const hooks = new Map<string, (event: SessionIdle) => Effect.Effect<void>>()
  const events = yield* Queue.unbounded<Watched>()
  yield* DeliveryPlugin.Plugin.effect(
    host({
      session: {
        // SAFETY: the plugin registers only the idle hook.
        hook: ((name: string, handler: (event: SessionIdle) => Effect.Effect<void>) =>
          Effect.sync(() => void hooks.set(name, handler))) as never,
        context: () => Effect.sync(() => options.context?.() ?? []) as never,
        synthetic: (input) =>
          (options.sending?.() ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => void sent.push(input)))) as never,
        // SAFETY: the startup sweep only checks that the Session exists.
        get: (input) =>
          options.missing
            ? Effect.fail(new Session.NotFoundError({ sessionID: input.sessionID }))
            : options.unavailable
              ? Effect.fail(new Error("the database is busy"))
              : (Effect.succeed({ id: input.sessionID }) as never),
      },
      tool: {
        // SAFETY: the plugin only declares its namespace and adds tools.
        transform: (callback) =>
          Effect.sync(() =>
            callback({ namespace: () => {}, add: (tool: Tool.Info) => void tools.set(tool.name, tool) } as never),
          ) as never,
        reload: () => Effect.die("unused tool.reload"),
        list: () => Effect.die("unused tool.list"),
        hook: () => Effect.die("unused tool.hook"),
      },
      storage: {
        get: (key) =>
          Effect.sync(() => stored.get(key)).pipe(Effect.tap(() => (options.yields ? Effect.yieldNow : Effect.void))),
        set: (key, value) => Effect.sync(() => void stored.set(key, value)),
        remove: (key) => Effect.sync(() => void stored.delete(key)),
        scan: (input) =>
          Effect.sync(() => ({
            entries: [...stored].flatMap(([key, value]) => (key.startsWith(input.prefix) ? [{ key, value }] : [])),
          })),
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
  // Let the forked event watcher and startup sweep start.
  yield* Effect.yieldNow
  const handler = <Name extends keyof typeof handlers>(name: Name) =>
    handlers[name] ?? (() => Effect.die(`the delivery RPC has no ${name} handler`))
  const settle = Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow))
  return {
    delivery: () =>
      Option.getOrUndefined(Schema.decodeUnknownOption(Delivery.State)(stored.get(`session:${sessionID}`))),
    // Stands in for a write another fiber makes, such as a tool call.
    replace: (delivery: Delivery.State) => void stored.set(`session:${sessionID}`, delivery),
    changed,
    sent,
    get: () => handler("get")({ sessionID }, call),
    stop: () => handler("stop")({ sessionID }, call).pipe(Effect.tap(() => settle)),
    extend: (by: number) => handler("extend")({ sessionID, by }, call).pipe(Effect.tap(() => settle)),
    idle: (background: ReadonlyArray<SessionIdleBackground> = []) =>
      Effect.suspend(() => hooks.get("experimental.idle")?.({ sessionID, background }) ?? Effect.die("no idle hook")),
    tool: (name: string, input: unknown) =>
      Effect.suspend(() => {
        const tool = tools.get(name)
        return tool ? tool.execute(input, toolContext) : Effect.die(`the delivery plugin has no ${name} tool`)
      }),
    emit: (event: Watched) => Queue.offer(events, event).pipe(Effect.andThen(settle)),
    advance: (ms: number) => TestClock.adjust(ms).pipe(Effect.andThen(settle)),
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

  it.effect("stops an active delivery, publishes the change and tells the agent to wrap up", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      const stopped = yield* plugin.stop()

      expect(stopped).toMatchObject({
        status: "stopping",
        stoppedBy: "user",
        reason: "Stopped by the user",
        wrapUpSent: true,
      })
      expect(plugin.delivery()).toEqual(stopped)
      expect(plugin.changed).toEqual([
        { sessionID, delivery: { ...stopped, wrapUpSent: undefined } },
        { sessionID, delivery: stopped },
      ])
      expect(plugin.sent).toEqual([
        {
          sessionID,
          text: "The live delivery is wrapping up: Stopped by the user. Start no new scope. Publish a version that is already usable, then call delivery_done.",
          description: "Live delivery: wrapping up",
          resume: true,
          metadata: { source: "delivery", deliveryID: active.id },
        },
      ])
    }),
  )

  it.effect(
    "tells the agent again, rather than finishing the delivery, when it goes idle while the wrap-up is sent",
    () =>
      Effect.gen(function* () {
        let idled = false
        let plugin: Effect.Success<ReturnType<typeof run>> | undefined
        plugin = yield* run(active, {
          sending: () =>
            Effect.suspend(() => {
              if (idled || !plugin) return Effect.void
              idled = true
              return plugin.idle()
            }),
        })

        yield* plugin.stop()

        expect(plugin.delivery()).toMatchObject({ status: "stopping", stoppedBy: "user", wrapUpSent: true })
        expect(plugin.sent.map((message) => message.text)).toEqual([
          expect.stringContaining("The live delivery is wrapping up"),
          expect.stringContaining("The live delivery is wrapping up"),
        ])
      }),
  )

  it.effect("leaves a stopping delivery as it is when stopped again", () =>
    Effect.gen(function* () {
      const stopping: Delivery.State = { ...active, status: "stopping", reason: "The time budget ran out" }
      const plugin = yield* run(stopping)

      expect(yield* plugin.stop()).toEqual(stopping)
      expect(plugin.changed).toEqual([])
      expect(plugin.sent).toEqual([])
    }),
  )

  it.effect("refuses to stop a delivery that is not active, or extend one the user stopped or that is done", () =>
    Effect.gen(function* () {
      const none = yield* run()
      const done = yield* run({ ...active, status: "done" })
      const stopped = yield* run({ ...active, status: "stopping", stoppedBy: "user" })

      expect(failureType(yield* Effect.exit(none.stop()))).toMatchObject({ type: "inactive" })
      expect(failureType(yield* Effect.exit(done.stop()))).toMatchObject({ type: "inactive" })
      expect(failureType(yield* Effect.exit(done.extend(minute)))).toMatchObject({ type: "inactive" })
      expect(failureType(yield* Effect.exit(stopped.extend(minute)))).toMatchObject({ type: "inactive" })
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
      expect(plugin.sent).toEqual([])
      expect(failureType(yield* Effect.exit(plugin.extend(minute)))).toMatchObject({ type: "inactive" })
      expect(plugin.changed).toHaveLength(2)
    }),
  )

  it.effect("resumes a delivery the budget stopped when the user extends it", () =>
    Effect.gen(function* () {
      const plugin = yield* run({
        ...active,
        status: "stopping",
        stoppedBy: "budget",
        reason: "The time budget ran out",
        wrapUpSent: true,
        boot: "an-earlier-process",
      })
      yield* plugin.advance(20 * minute)

      const resumed = yield* plugin.extend(5 * minute)

      expect(resumed).toEqual({
        ...active,
        deadline: 25 * minute,
        stalls: 0,
        updatedAt: 20 * minute,
      })
      expect(plugin.sent).toMatchObject([
        {
          text: expect.stringContaining(
            "The user extended the budget, so the live delivery resumes.\n5 minutes left.\nPlan the first version",
          ),
          description: "Live delivery: budget extended",
          resume: true,
        },
      ])
    }),
  )

  it.effect("drops a deleted Session's delivery and keeps others", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.emit(deleted(Session.ID.make("ses_other")))
      expect(plugin.delivery()).toEqual(active)
      expect(plugin.changed).toEqual([])

      yield* plugin.emit(deleted(sessionID))
      expect(plugin.delivery()).toBeUndefined()
      expect(plugin.changed).toEqual([{ sessionID, delivery: null }])
    }),
  )

  it.effect("stops a delivery an earlier process left active without waking its Session", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...active, boot: "an-earlier-process" })

      expect(plugin.delivery()).toMatchObject({
        status: "stopping",
        stoppedBy: "restart",
        reason: "The server restarted while the delivery was active",
      })
      expect(plugin.delivery()?.wrapUpSent).toBeUndefined()
      expect(plugin.sent).toEqual([])
    }),
  )

  it.effect("drops the delivery of a Session deleted while the plugin was not running", () =>
    Effect.gen(function* () {
      expect((yield* run(active, { missing: true })).delivery()).toBeUndefined()
    }),
  )
})

describe("delivery deadline", () => {
  it.effect("tells the agent to wrap up at the deadline, which an extension moves", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)
      // An extension arms the timer for the new deadline, 13 and then 15 minutes in.
      yield* plugin.extend(minute)
      yield* plugin.extend(2 * minute)

      yield* plugin.advance(13 * minute)
      expect(plugin.delivery()?.status).toBe("active")

      yield* plugin.advance(2 * minute)
      expect(plugin.delivery()).toMatchObject({
        status: "stopping",
        stoppedBy: "budget",
        reason: "The time budget ran out",
        wrapUpSent: true,
      })
      expect(plugin.sent).toMatchObject([
        { text: expect.stringContaining("The live delivery is wrapping up: The time budget ran out."), resume: true },
      ])
    }),
  )

  it.effect("arms the timer of this process's active delivery when the plugin starts", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.advance(12 * minute)

      expect(plugin.delivery()).toMatchObject({ status: "stopping", stoppedBy: "budget" })
      expect(plugin.sent).toMatchObject([{ resume: true }])
    }),
  )

  it.effect("does not stop a delivery the user stopped before its deadline", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)
      yield* plugin.extend(minute)
      yield* plugin.stop()

      yield* plugin.advance(20 * minute)

      expect(plugin.delivery()?.stoppedBy).toBe("user")
      expect(plugin.sent).toHaveLength(1)
    }),
  )
})

describe("delivery idle hook", () => {
  it.effect("keeps the agent going while time remains, naming its running shells", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)
      yield* plugin.advance(2 * minute)

      yield* plugin.idle([{ kind: "shell", sessionID, shellID: "shell_1", command: "bun run dev" }])

      expect(plugin.sent).toEqual([
        {
          sessionID,
          text: [
            "The live delivery continues.",
            "10 minutes left.",
            "Plan the first version with delivery_plan, then build it.",
            "Finishing a plan does not finish the delivery: it runs until the user stops it or the time runs out. delivery_status has the objective and any feedback.",
            "Background shells still running:",
            "- bun run dev",
          ].join("\n"),
          metadata: { source: "delivery", deliveryID: active.id },
        },
      ])
      expect(plugin.delivery()).toMatchObject({ status: "active", stalls: 0 })
    }),
  )

  it.effect("waits for the Session's own subagent instead of continuing", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.idle([
        {
          kind: "subagent",
          sessionID,
          childSessionID: Session.ID.make("ses_child"),
          agent: "general",
          description: "",
        },
      ])

      expect(plugin.sent).toEqual([])
    }),
  )

  it.effect("counts continuations without a tool call, and stops after too many", () =>
    Effect.gen(function* () {
      const working = yield* run({ ...active, stalls: 2 }, { context: () => [deliveryMessage, toolCall] })
      const stalled = yield* run(
        { ...active, stalls: DeliveryPlugin.MAX_STALLS - 1 },
        { context: () => [deliveryMessage, reply] },
      )

      yield* working.idle()
      yield* stalled.idle()

      expect(working.delivery()?.stalls).toBe(0)
      expect(stalled.delivery()).toMatchObject({
        status: "stopping",
        stoppedBy: "stalled",
        reason: `The agent made no progress in ${DeliveryPlugin.MAX_STALLS} continuations in a row`,
        wrapUpSent: true,
      })
      expect(stalled.sent).toMatchObject([{ text: expect.stringContaining("The live delivery is wrapping up") }])
      expect(stalled.sent[0]?.resume).toBeUndefined()
    }),
  )

  it.effect("counts a continuation that only read delivery_status as a stall", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...active, stalls: 1 }, { context: () => [deliveryMessage, statusCall, reply] })

      yield* plugin.idle()

      expect(plugin.delivery()?.stalls).toBe(2)
    }),
  )

  it.effect("tells the agent to wrap up when it goes idle past a deadline its timer missed", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)
      // The startup timer follows the first delivery, so it leaves this one to the hook.
      plugin.replace({ ...active, id: "delivery-2" })
      yield* plugin.advance(12 * minute)

      yield* plugin.idle()

      expect(plugin.delivery()).toMatchObject({ status: "stopping", stoppedBy: "budget", wrapUpSent: true })
      expect(plugin.sent).toHaveLength(1)
    }),
  )

  it.effect("tells a stopping agent to wrap up once, then finishes the delivery when it stops again", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...active, status: "stopping", stoppedBy: "budget", reason: "Out of time" })

      yield* plugin.idle()
      expect(plugin.delivery()?.wrapUpSent).toBe(true)
      expect(plugin.sent).toMatchObject([
        { text: expect.stringContaining("The live delivery is wrapping up: Out of time.") },
      ])

      yield* plugin.idle()
      expect(plugin.delivery()).toMatchObject({
        status: "done",
        summary: "The agent stopped without calling delivery_done.",
      })
      expect(plugin.sent).toHaveLength(1)
    }),
  )

  it.effect("leaves a write that lands while it decides alone", () =>
    Effect.gen(function* () {
      const published: Delivery.State = { ...active, updatedAt: 1 }
      let plugin: Effect.Success<ReturnType<typeof run>> | undefined
      plugin = yield* run(active, {
        context: () => {
          // A tool call writes while the hook reads the context.
          plugin?.replace(published)
          return [deliveryMessage, toolCall]
        },
      })

      yield* plugin.idle()

      expect(plugin.delivery()).toEqual(published)
      expect(plugin.sent).toEqual([])
    }),
  )

  it.effect("keeps a delivery a restart stopped quiet when its Session goes idle, so an extension can resume it", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...active, boot: "an-earlier-process" })

      yield* plugin.idle()
      yield* plugin.idle()

      expect(plugin.delivery()).toMatchObject({ status: "stopping", stoppedBy: "restart" })
      expect(plugin.sent).toEqual([])
      expect((yield* plugin.tool("status", {})).content).toContain(
        "Status: paused: The server restarted while the delivery was active. Extending the budget resumes it.",
      )
      const plan = yield* Effect.exit(
        plugin.tool("plan", { title: "Next", scope: "More", acceptance: ["works"], dueInMinutes: 1 }),
      )
      expect(Exit.isFailure(plan) ? Option.getOrUndefined(Exit.findErrorOption(plan)) : undefined).toMatchObject({
        message: "The delivery is paused because the server restarted. Extending the budget resumes it.",
      })
      expect((yield* plugin.extend(5 * minute)).status).toBe("active")
    }),
  )

  it.effect("does not record a wrap-up that failed to send, and sends it again when the Session goes idle", () =>
    Effect.gen(function* () {
      let failures = 1
      const plugin = yield* run(active, {
        sending: () => (failures-- > 0 ? Effect.fail(new Error("the Session is closing")) : Effect.void),
      })

      yield* plugin.stop()
      expect(plugin.delivery()).toMatchObject({ status: "stopping", stoppedBy: "user" })
      expect(plugin.delivery()?.wrapUpSent).toBeUndefined()
      expect(plugin.sent).toEqual([])

      yield* plugin.idle()
      expect(plugin.delivery()).toMatchObject({ status: "stopping", wrapUpSent: true })
      expect(plugin.sent).toMatchObject([{ text: expect.stringContaining("The live delivery is wrapping up") }])
    }),
  )

  it.effect("keeps feedback that arrives while the wrap-up is sent", () =>
    Effect.gen(function* () {
      let plugin: Effect.Success<ReturnType<typeof run>> | undefined
      plugin = yield* run(active, {
        sending: () => plugin?.emit(enqueued("msg_faster", "user", "Faster", 1)) ?? Effect.void,
      })

      yield* plugin.stop()

      expect(plugin.delivery()).toMatchObject({
        wrapUpSent: true,
        feedback: [{ id: "msg_faster", text: "Faster", at: 1 }],
      })
    }),
  )

  it.effect("keeps a delivery whose Session it cannot look up at startup, and resumes it when extended", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...active, boot: "an-earlier-process" }, { unavailable: true })
      expect(plugin.delivery()).toMatchObject({ status: "active", boot: "an-earlier-process" })

      const resumed = yield* plugin.extend(5 * minute)

      expect(resumed).toMatchObject({ status: "active", boot: DeliveryPlugin.boot(), deadline: 17 * minute })
      expect(plugin.sent).toMatchObject([
        { text: expect.stringContaining("The user extended the budget"), resume: true },
      ])
    }),
  )
})

describe("delivery feedback", () => {
  it.effect("keeps the user's messages as they arrive, and drops cancelled ones", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.emit(enqueued("msg_blue", "user", "Make it blue", minute))
      yield* plugin.emit(enqueued("msg_blue", "user", "Make it blue", minute))
      yield* plugin.emit(enqueued("msg_continue", "synthetic", "The live delivery continues.", minute))
      yield* plugin.emit(enqueued("msg_slow", "user", "Slower", 2 * minute))
      yield* plugin.emit(cancelled("msg_slow"))

      expect(plugin.delivery()?.feedback).toEqual([{ id: "msg_blue", text: "Make it blue", at: minute }])
    }),
  )

  it.effect("ignores messages once the delivery is done", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...active, status: "done" })

      yield* plugin.emit(enqueued("msg_blue", "user", "Make it blue", minute))

      expect(plugin.delivery()?.feedback).toBeUndefined()
    }),
  )

  it.effect("leaves the kickoff that started the delivery out of its feedback", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.emit(enqueued("msg_kickoff", "user", "Build a pendulum experiment", active.startedAt))

      expect(plugin.delivery()?.feedback).toBeUndefined()
    }),
  )
})

const milestone: Delivery.Milestone = {
  title: "Swinging pendulum",
  scope: "A pendulum that swings, with a length slider",
  acceptance: ["the pendulum animates", "the slider changes the period"],
  dueAt: 4 * minute,
}
const planned: Delivery.State = { ...active, next: milestone }
const passing = milestone.acceptance.map((name) => ({ name, passed: true }))

const message = (exit: Exit.Exit<unknown, Tool.Error>) => failureType(exit)?.message

describe("delivery tools", () => {
  it.effect("plan the next version within the time left", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)
      yield* TestClock.adjust(2 * minute)

      const result = yield* plugin.tool("plan", {
        title: milestone.title,
        scope: milestone.scope,
        acceptance: milestone.acceptance,
        dueInMinutes: 4,
      })

      expect(result.content).toContain("due in 4 minutes")
      expect(plugin.delivery()?.next).toEqual({ ...milestone, dueAt: 6 * minute })
      expect(plugin.changed).toHaveLength(1)
      expect(
        message(
          yield* Effect.exit(
            plugin.tool("plan", { title: "Everything", scope: "All of it", acceptance: ["done"], dueInMinutes: 11 }),
          ),
        ),
      ).toBe("That is past the budget, which has 10 minutes left. Plan a smaller version.")
    }),
  )

  it.effect("keep a plan and feedback that are written at the same time", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active, { yields: true })

      yield* Effect.all(
        [
          plugin.emit(enqueued("msg_blue", "user", "Make it blue", 1)),
          plugin.tool("plan", {
            title: milestone.title,
            scope: milestone.scope,
            acceptance: milestone.acceptance,
            dueInMinutes: 4,
          }),
        ],
        { concurrency: "unbounded" },
      )
      // The feedback write waits for the plan's to finish.
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })

      expect(plugin.delivery()).toMatchObject({
        next: milestone,
        feedback: [{ id: "msg_blue", text: "Make it blue", at: 1 }],
      })
    }),
  )

  it.effect("refuse to plan new scope once the delivery is wrapping up", () =>
    Effect.gen(function* () {
      const stopping = yield* run({ ...active, status: "stopping", reason: "Stopped by the user" })
      const expired = yield* run(active)
      yield* TestClock.adjust(12 * minute)
      const input = { title: "More", scope: "More", acceptance: ["more"], dueInMinutes: 1 }

      expect(message(yield* Effect.exit(stopping.tool("plan", input)))).toStartWith("The delivery is wrapping up.")
      expect(message(yield* Effect.exit(expired.tool("plan", input)))).toStartWith("The delivery is wrapping up.")
      expect(expired.delivery()?.next).toBeUndefined()
    }),
  )

  it.effect("publish a planned version whose acceptance checks pass, keeping a failed extra check", () =>
    Effect.gen(function* () {
      const plugin = yield* run(planned)
      yield* TestClock.adjust(3 * minute)
      const checks = [...passing, { name: "works offline", passed: false }]

      const result = yield* plugin.tool("publish", { summary: "First swing", checks })

      expect(result.content).toBe(
        "Published version 1. 9 minutes left: compare it with the full objective and plan the next version with delivery_plan.",
      )
      expect(plugin.delivery()).toEqual({
        ...active,
        versions: [{ number: 1, title: milestone.title, summary: "First swing", checks, publishedAt: 3 * minute }],
        updatedAt: 3 * minute,
      })
    }),
  )

  it.effect("refuse to publish without a plan or with an acceptance check missing or failing", () =>
    Effect.gen(function* () {
      const unplanned = yield* run(active)
      const plugin = yield* run(planned)
      const failing = [
        { name: "the pendulum animates", passed: true },
        { name: "the slider changes the period", passed: false },
      ]

      expect(message(yield* Effect.exit(unplanned.tool("publish", { summary: "v1", checks: passing })))).toBe(
        "No version is planned. Plan it with delivery_plan before publishing.",
      )
      expect(message(yield* Effect.exit(plugin.tool("publish", { summary: "v1", checks: failing })))).toBe(
        "Not published. Each acceptance criterion needs a passing check with exactly its name. Missing or failing:\n- the slider changes the period",
      )
      expect(
        message(
          yield* Effect.exit(plugin.tool("publish", { summary: "v1", checks: [{ name: "it works", passed: true }] })),
        ),
      ).toContain("- the pendulum animates\n- the slider changes the period")
      expect(plugin.delivery()).toEqual(planned)
      expect(plugin.changed).toEqual([])
    }),
  )

  it.effect("record the feedback a version answers, and refuse IDs the delivery did not receive", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...planned, feedback: [{ id: "msg_blue", text: "Make it blue", at: minute }] })

      expect(
        message(
          yield* Effect.exit(plugin.tool("publish", { summary: "v1", checks: passing, feedback: ["msg_before"] })),
        ),
      ).toBe("Not published. No feedback message has the ID msg_before; delivery_status lists them.")

      yield* plugin.tool("publish", { summary: "Blue pendulum", checks: passing, feedback: ["msg_blue"] })
      expect(plugin.delivery()?.versions[0]?.feedback).toEqual(["msg_blue"])
    }),
  )

  it.effect("tell the agent to finish after publishing while the delivery wraps up", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...planned, status: "stopping", reason: "Stopped by the user" })

      const result = yield* plugin.tool("publish", { summary: "Last swing", checks: passing })

      expect(result.content).toBe("Published version 1. The delivery is wrapping up: call delivery_done.")
      expect(plugin.delivery()).toMatchObject({ status: "stopping", reason: "Stopped by the user" })
    }),
  )

  it.effect("report the time left, the plan, and only the feedback no version has answered", () =>
    Effect.gen(function* () {
      const plugin = yield* run({
        ...planned,
        versions: [
          {
            number: 1,
            title: "Still pendulum",
            summary: "Draws the pendulum",
            checks: [{ name: "it draws", passed: true }],
            feedback: ["msg_answered"],
            publishedAt: minute,
          },
        ],
        feedback: [
          { id: "msg_answered", text: "Draw it first", at: 0 },
          { id: "msg_waiting", text: "Make  it\nblue", at: minute },
        ],
      })
      yield* TestClock.adjust(2 * minute)

      const result = yield* plugin.tool("status", {})

      expect(result.content).toBe(
        [
          "Objective: Build a pendulum experiment",
          "Status: active, 10 minutes left",
          'Published: 1 version; latest is 1, "Still pendulum": Draws the pendulum',
          'Planned: "Swinging pendulum", due in 2 minutes',
          "Scope: A pendulum that swings, with a length slider",
          "Acceptance:",
          "- the pendulum animates",
          "- the slider changes the period",
          "Feedback no version has answered yet:",
          "- [msg_waiting] Make it blue",
        ].join("\n"),
      )
    }),
  )

  it.effect("refuse to finish while time remains, and finish once the budget runs out or the user stops it", () =>
    Effect.gen(function* () {
      const expiring = yield* run(active)
      const stopped = yield* run({ ...active, status: "stopping", reason: "Stopped by the user" })

      expect(message(yield* Effect.exit(expiring.tool("done", { summary: "All done" })))).toBe(
        "12 minutes left. Plan and publish the next version; only the user can stop the delivery early.",
      )

      yield* TestClock.adjust(12 * minute)
      expect((yield* expiring.tool("done", { summary: "Nothing usable yet" })).content).toBe(
        "Delivery finished with no published version.",
      )
      expect(expiring.delivery()).toMatchObject({
        status: "done",
        reason: "The time budget ran out",
        summary: "Nothing usable yet",
      })

      yield* stopped.tool("done", { summary: "Stopped early" })
      expect(stopped.delivery()).toMatchObject({ status: "done", reason: "Stopped by the user" })
      expect(message(yield* Effect.exit(stopped.tool("done", { summary: "Again" })))).toBe(
        "The delivery is already done.",
      )
    }),
  )

  it.effect("tell a session without a delivery how one starts", () =>
    Effect.gen(function* () {
      const plugin = yield* run()

      expect(message(yield* Effect.exit(plugin.tool("status", {})))).toBe(
        "This session has no live delivery. The user starts one with /deliver.",
      )
    }),
  )
})
