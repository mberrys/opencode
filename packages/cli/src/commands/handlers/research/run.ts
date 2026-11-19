import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { waitForPlugins } from "../../../services/plugin-startup"

const PROMPT = [
  "Scope it first and write the protocol with research_protocol, then send one reader per sub-question.",
  "Quote before you claim, record every gap, and finish by composing the answer with research_answer.",
]

export default Runtime.handler(
  Commands.commands.research.commands.run,
  Effect.fn("cli.research.run")(function* (input) {
    const { reportRunError, runNonInteractive } = yield* Effect.promise(() => import("../../../run/run"))
    const report = (message: string) => Effect.sync(() => reportRunError({ format: "default" }, message))
    const server = yield* ServerConnection.resolve({ autostart: false }).pipe(
      Effect.tapError((error) => Effect.logError("research could not resolve its server", { cause: error })),
      Effect.catch((error) => report(error.message)),
    )
    if (!server) return
    // The research agent exists only where the server runs the research plugin, which the research flag turns on.
    const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    yield* waitForPlugins(client, process.cwd())
    const agents = yield* Effect.promise(() => client.agent.list({ location: { directory: process.cwd() } }))
    if (!agents.data.some((agent) => agent.id === "research"))
      return yield* report(
        "the server has no research agent; turn the research flag on with OPENCODE_FLAGS=research or experimental.research",
      )
    // SIGINT and SIGTERM interrupt this fiber; the abort signal cancels the run first. A failed run is reported.
    yield* Effect.tryPromise({
      try: (signal) =>
        runNonInteractive(
          {
            server,
            message: [["Research this question:", "", input.question.join(" "), "", ...PROMPT].join("\n")],
            continue: false,
            session: undefined,
            fork: false,
            worktree: undefined,
            model: undefined,
            agent: "research",
            format: "default",
            file: [],
            title: undefined,
            archived: false,
            thinking: false,
            auto: false,
          },
          signal,
        ),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(Effect.catch(report))
  }),
)
