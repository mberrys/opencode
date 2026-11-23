import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { researcher, rule, terminal } from "./researcher"
import { openWriter, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.adopt,
  Effect.fn("cli.research.adopt")(function* (input) {
    const store = yield* openWriter(input.directory)
    const ruled = yield* Effect.tryPromise({
      try: () =>
        rule(
          store,
          {
            claim: input.claim,
            ruling: "adopt",
            reason: Option.getOrElse(input.reason, () => ""),
            researcher: researcher(),
          },
          terminal,
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    if (ruled === undefined) return yield* print(["nothing was recorded"])
    yield* print([`adopted ${input.claim}: decision ${ruled.decision.objectId}`])
  }, Effect.scoped),
)
