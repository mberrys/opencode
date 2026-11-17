import { Effect, Option } from "effect"
import { replayLibrary } from "@opencode/research"
import { replay } from "@opencode/research-store"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.replay,
  Effect.fn("cli.research.replay")(function* (input) {
    const { store } = open(Option.getOrUndefined(input.directory))
    const requested = Option.getOrUndefined(input.run)
    const runs = requested
      ? [requested]
      : [...new Set(store.kind("receipt").map((receipt) => receipt.body.run))].sort()

    if (runs.length === 0) {
      print("no receipts: nothing has been run in this project yet")
      store.close()
      return
    }

    let failed = false
    for (const run of runs) {
      const report = replay(store, run, { execute: replayLibrary(store) })
      if (report.entries.length === 0) {
        print(`${run}: no receipts were recorded, so there is nothing to replay`)
        continue
      }
      const detail = report.ok
        ? "replays"
        : report.mismatches > 0
          ? `${report.mismatches} of ${report.entries.length} answers differ from the recorded run`
          : `${report.unverifiable} of ${report.entries.length} answers cannot be replayed yet (check C6)`
      print(`${run}: ${detail}`)
      for (const entry of report.entries) {
        print(`  ${String(entry.seq).padStart(3)} ${entry.operation.padEnd(24)} ${entry.status.padEnd(13)} ${entry.detail}`)
        if (entry.status === "mismatch") failed = true
      }
    }
    store.close()
    if (failed) process.exitCode = 1
  }),
)
