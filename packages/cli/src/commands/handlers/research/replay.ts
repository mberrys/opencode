import { Effect, Option } from "effect"
import type { Json } from "@opencode/research-record"
import { cites, grep, outline, read, search } from "@opencode/research-library"
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

    const execute = (tool: string, value: Json) => {
      const input = value as { pattern: string; query: string; source?: { kind: "source"; id: `sha256:${string}` }; address?: string }
      try {
        if (tool === "library.grep") return grep(store, { pattern: input.pattern, ...(input.source ? { source: input.source } : {}) }) as unknown as Json
        if (tool === "library.search") return search(store, { query: input.query, ...(input.source ? { source: input.source } : {}) }) as unknown as Json
        if (tool === "library.read") return read(store, input) as unknown as Json
        if (tool === "library.outline" && input.source) return outline(store, input.source) as unknown as Json
        if (tool === "library.cites" && input.source) return cites(store, input.source) as unknown as Json
      } catch {
        return undefined
      }
      return undefined
    }

    let failed = false
    for (const run of runs) {
      const report = replay(store, run, { execute })
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
