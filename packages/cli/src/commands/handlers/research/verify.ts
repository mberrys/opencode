import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.verify,
  Effect.fn("cli.research.verify")(function* (input) {
    const reader = yield* open(input.directory)
    const verified = reader.verify()
    yield* print([
      ...verified.problems.map((problem) =>
        [
          problem.reason.padEnd(20),
          problem.seq === undefined ? "" : `commit ${problem.seq}`,
          problem.revisionId ?? problem.digest ?? "",
          problem.message ?? "",
        ]
          .filter((part) => part !== "")
          .join(" "),
      ),
      `head ${verified.headSeq} ${verified.headDigest}`,
      verified.ok ? "the record verifies" : `${verified.problems.length} problems`,
    ])
    if (!verified.ok) process.exitCode = 2
  }, Effect.scoped),
)
