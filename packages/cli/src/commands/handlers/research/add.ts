import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { add, researcher, terminal } from "./researcher"
import { openWriter, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.add,
  Effect.fn("cli.research.add")(function* (input) {
    const store = yield* openWriter(input.directory)
    const title = Option.getOrUndefined(input.title)
    const added = yield* Effect.tryPromise({
      try: () =>
        add(
          store,
          {
            target: input.target,
            ...(title === undefined ? {} : { title }),
            researcher: researcher(),
            cwd: process.cwd(),
          },
          terminal,
        ),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    if (added === undefined) return yield* print(["nothing was recorded"])
    yield* print([
      `${added.status}: source ${added.source.objectId}`,
      added.representation === undefined ? "no text extracted" : "text extracted",
      ...added.notes,
    ])
  }, Effect.scoped),
)
