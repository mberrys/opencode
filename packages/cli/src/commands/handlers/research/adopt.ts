import { Effect, Option } from "effect"
import { formatRef } from "@opencode/research-record"
import { decide } from "@opencode/research"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print, reason, researcher } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.adopt,
  Effect.fn("cli.research.adopt")(function* (input) {
    const { store } = open(Option.getOrUndefined(input.directory))
    const result = yield* Effect.try({
      try: () => decide(researcher(store), { target: input.ref, ruling: "adopt", ...reason(Option.getOrUndefined(input.reason)) }),
      catch: (error) => new Error((error as Error).message),
    })
    print(`adopted ${formatRef(result.target)}\ndecision ${formatRef(result.decision)}`)
    store.close()
  }),
)
