import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.research.commands.run,
  Effect.fn("cli.research.run")(function* (input) {
    const question = [...input.question].join(" ").trim()
    if (!question) return yield* Effect.fail(new Error("Usage: opencode research run <question>"))
    const { reportRunError, runNonInteractive } = yield* Effect.promise(() => import("../../../run/run"))
    const server = yield* ServerConnection.resolve({ autostart: false }).pipe(
      Effect.tapError((error) => Effect.logError("research could not resolve its server", { cause: error })),
      Effect.catch((error) => Effect.sync(() => reportRunError({ format: "default" } as never, error.message))),
    )
    if (!server) return
    yield* Effect.callback<void>((resume) => {
      const controller = new AbortController()
      const done = runNonInteractive(
        {
          server,
          message: [
            [
              "Run the research loop for this question:",
              "",
              question,
              "",
              "Scope it first and write the protocol with research.protocol, then send one reader per sub-question.",
              "Quote before you claim, disclose every gap, and finish by composing the answer with research.answer.",
            ].join("\n"),
          ],
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
        controller.signal,
      ).then(() => resume(Effect.void))
      return Effect.promise(() => {
        controller.abort()
        return done
      })
    })
  }),
)
