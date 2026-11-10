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
      // A receipt holds the tool's own input: the source is the string the agent typed, and the limit it asked
      // for shapes the output, so both are resolved and passed exactly as the tool did.
      const input = value as {
        pattern?: string
        query?: string
        source?: string
        address?: string
        section?: number
        limit?: number
      }
      try {
        const ref = input.source ? store.resolve(input.source) : undefined
        if (ref && ref.kind !== "source") return undefined
        const source = ref ? { source: ref } : {}
        const limit = input.limit === undefined ? {} : { limit: input.limit }
        if (tool === "library.grep" && input.pattern !== undefined)
          return grep(store, { pattern: input.pattern, ...source, ...limit }) as unknown as Json
        if (tool === "library.search" && input.query !== undefined)
          return search(store, { query: input.query, ...source, ...limit }) as unknown as Json
        if (tool === "library.read")
          return read(store, {
            ...source,
            ...(input.address ? { address: input.address } : {}),
            ...(input.section === undefined ? {} : { section: input.section }),
            ...limit,
          }) as unknown as Json
        if (tool === "library.outline" && ref) return outline(store, ref) as unknown as Json
        if (tool === "library.cites" && ref) return cites(store, ref) as unknown as Json
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
