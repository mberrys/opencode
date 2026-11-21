import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Option, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Agent } from "@opencode/schema/agent"
import { Delivery } from "@opencode/schema/delivery"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
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

// SAFETY: the plugin reads only the type, ID, text and creation time of a user message.
const user = (id: string, text: string, at: number) =>
  ({ type: "user", id, text, time: { created: DateTime.makeUnsafe(at) } }) as unknown as SessionMessage.Info

const toolContext: Tool.Context = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_delivery_tool"),
  id: Tool.CallID.make("call_delivery"),
  progress: () => Effect.void,
}

/**
 * Runs the delivery plugin against plugin storage in memory, an RPC stub that records what it publishes, a tool editor
 * that keeps the tools it adds, and a Session context of the given messages. `whileReading` runs each time the context
 * is read, with a setter for the stored delivery, so a test can land a write while a tool is mid-call.
 */
const run = Effect.fnUntraced(function* (
  seed?: Delivery.State,
  messages: ReadonlyArray<SessionMessage.Info> = [],
  whileReading?: (store: (state: Delivery.State) => void) => void,
) {
  const stored = new Map<string, Schema.Json>(seed ? [[`session:${sessionID}`, seed]] : [])
  const changed: unknown[] = []
  const handlers: Partial<RpcHandlers<typeof Delivery.Definition>> = {}
  const tools = new Map<string, Tool.Info>()
  const events = yield* Queue.unbounded<SessionEvent.Deleted>()
  yield* DeliveryPlugin.Plugin.effect(
    host({
      session: {
        context: () =>
          Effect.sync(() => {
            whileReading?.((state) => void stored.set(`session:${sessionID}`, state))
            return messages
          }) as never,
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
    tool: (name: string, input: unknown) =>
      Effect.suspend(() => {
        const tool = tools.get(name)
        return tool ? tool.execute(input, toolContext) : Effect.die(`the delivery plugin has no ${name} tool`)
      }),
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
      expect(failureType(yield* Effect.exit(plugin.extend(minute)))).toMatchObject({ type: "inactive" })
      expect(plugin.changed).toHaveLength(2)
    }),
  )

  it.effect("extends an expired budget from now, so the extension is time the agent gets", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)
      yield* TestClock.adjust(20 * minute)

      expect((yield* plugin.extend(5 * minute)).deadline).toBe(25 * minute)
    }),
  )

  it.effect("drops a deleted Session's delivery and keeps others", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active)

      yield* plugin.delete(Session.ID.make("ses_other"))
      expect(plugin.delivery()).toEqual(active)
      expect(plugin.changed).toEqual([])

      yield* plugin.delete(sessionID)
      expect(plugin.delivery()).toBeUndefined()
      expect(plugin.changed).toEqual([{ sessionID, delivery: null }])
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

  it.effect("record the feedback a version answers, and refuse messages from before the delivery started", () =>
    Effect.gen(function* () {
      const plugin = yield* run({ ...planned, startedAt: minute }, [
        user("msg_before", "Hello", 0),
        user("msg_blue", "Make it blue", 2 * minute),
      ])

      expect(
        message(
          yield* Effect.exit(plugin.tool("publish", { summary: "v1", checks: passing, feedback: ["msg_before"] })),
        ),
      ).toBe(
        "Not published. msg_before came before the delivery started, so it is not feedback; delivery_status lists the feedback.",
      )

      // msg_compacted was listed by delivery_status, then a compaction dropped it from the context.
      yield* plugin.tool("publish", {
        summary: "Blue pendulum",
        checks: passing,
        feedback: ["msg_blue", "msg_compacted"],
      })
      expect(plugin.delivery()?.versions[0]?.feedback).toEqual(["msg_blue", "msg_compacted"])
    }),
  )

  it.effect("refuse to publish against a plan that changed while the feedback was read", () =>
    Effect.gen(function* () {
      const replanned = { ...planned, next: { ...milestone, title: "Double pendulum" } }
      const plugin = yield* run(planned, [user("msg_blue", "Make it blue", minute)], (store) => store(replanned))

      expect(
        message(yield* Effect.exit(plugin.tool("publish", { summary: "v1", checks: passing, feedback: ["msg_blue"] }))),
      ).toBe("Not published. The plan changed while publishing; check against the new plan and publish again.")
      expect(plugin.delivery()).toEqual(replanned)
    }),
  )

  it.effect("leave the kickoff that started the delivery out of its feedback", () =>
    Effect.gen(function* () {
      const plugin = yield* run(active, [user("msg_kickoff", "Build a pendulum experiment", 0)])

      expect((yield* plugin.tool("status", {})).output).toMatchObject({ feedback: [] })
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
      const plugin = yield* run(
        {
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
        },
        [user("msg_answered", "Draw it first", 0), user("msg_waiting", "Make  it\nblue", minute)],
      )
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
