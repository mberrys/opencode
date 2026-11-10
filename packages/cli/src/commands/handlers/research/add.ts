import { resolve } from "node:path"
import { Effect, Option } from "effect"
import { SOURCE_TYPES } from "@opencode/research-record"
import { addSource } from "@opencode/research-library"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.add,
  Effect.fn("cli.research.add")(function* (input) {
    const { store, directory } = open(Option.getOrUndefined(input.directory))
    const target = input.target
    const doi = /^10\.[0-9]{4,9}\/\S+$/.test(target) ? target : undefined
    const url = /^https?:\/\//i.test(target) ? target : undefined
    const file = !doi && !url ? resolve(directory, target) : undefined
    const requested = Option.getOrUndefined(input.type)
    const type = SOURCE_TYPES.find((item) => item === requested)
    if (requested !== undefined && !type)
      return yield* Effect.fail(new Error(`--type must be one of ${SOURCE_TYPES.join(", ")}`))
    const added = yield* Effect.tryPromise({
      try: () =>
        addSource(store, {
          ...(doi ? { doi } : {}),
          ...(url ? { url } : {}),
          ...(file ? { file } : {}),
          ...(Option.isSome(input.title) ? { title: input.title.value } : {}),
          ...(type ? { type } : {}),
        }),
      catch: (error) => new Error((error as Error).message),
    })
    print(
      [
        `added ${added.title}`,
        `source     ${added.source.kind}:${added.source.id}`,
        added.copy ? `copy       ${added.copy.kind}:${added.copy.id}` : "copy       none",
        added.representation ? `text       ${added.representation.id}` : "text       not extracted",
        `status     ${added.status}`,
        ...added.notes.map((note) => `note       ${note}`),
      ].join("\n"),
    )
    store.close()
  }),
)
