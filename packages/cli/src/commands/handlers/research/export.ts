import path from "node:path"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.export,
  Effect.fn("cli.research.export")(function* (input) {
    const reader = yield* open(input.directory)
    const out = path.resolve(input.out)
    const exported = yield* Effect.try(() => reader.exportTo(out))
    yield* print([
      `${exported.commits} commits and ${exported.blobs} files written to ${exported.directory}`,
      `head ${exported.headSeq} ${exported.headDigest}`,
      exported.verified.ok
        ? `check it anywhere with: node ${path.join(out, "verify.mjs")}`
        : `the record has ${exported.verified.problems.length} problems; the bundle carries them and verify.mjs reports them`,
    ])
    if (!exported.verified.ok) process.exitCode = 2
  }, Effect.scoped),
)
