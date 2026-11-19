import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.show,
  Effect.fn("cli.research.show")(function* (input) {
    const reader = yield* open(input.directory)
    const revision = reader.latest(input.id)
    if (revision === undefined) return yield* Effect.fail(new Error(`no object has the id ${input.id}`))
    yield* print([JSON.stringify(revision, null, 2)])
  }, Effect.scoped),
)
