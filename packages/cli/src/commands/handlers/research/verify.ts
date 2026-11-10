import { Effect, Option } from "effect"
import { verify } from "@opencode/research-store"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.verify,
  Effect.fn("cli.research.verify")(function* (input) {
    const { store } = open(Option.getOrUndefined(input.directory))
    const report = verify(store)
    print(
      [
        `${report.commits} commits, ${report.records} records, ${report.blobs} files`,
        `head       ${report.head ?? "none"}`,
        ...report.issues.map((issue) => `${issue.check.padEnd(16)} ${issue.target}  ${issue.detail}`),
        report.ok ? "the record verifies" : `${report.issues.length} checks failed`,
      ].join("\n"),
    )
    store.close()
    if (!report.ok) process.exitCode = 2
  }),
)
