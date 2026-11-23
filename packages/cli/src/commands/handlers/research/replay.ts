import { Compute } from "@opencode/research-library"
import { Replay } from "@opencode/research-store"
import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.replay,
  Effect.fn("cli.research.replay")(function* (input) {
    const reader = yield* open(input.directory)
    const run = Option.getOrUndefined(input.run)
    const report = Replay.run(reader, { script: Compute.replay, ...(run === undefined ? {} : { run }) })
    yield* print([
      ...report.entries.map(
        (entry) => `${String(entry.seq).padStart(5)}  ${entry.status.padEnd(12)} ${entry.step}: ${entry.detail}`,
      ),
      report.entries.length === 0
        ? "nothing to replay"
        : `${report.entries.length} steps, ${report.mismatches} mismatches, ${report.unverifiable} unverifiable`,
    ])
    if (!report.ok) process.exitCode = 1
  }, Effect.scoped),
)
