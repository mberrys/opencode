import { EOL } from "node:os"
import path from "node:path"
import { Store } from "@opencode/research-store"
import { Effect, Option } from "effect"

/**
 * Opens the record in `<directory>/.research/` for reading only. It never creates one, so a mistyped directory fails
 * instead of verifying an empty record.
 */
export const open = (directory: Option.Option<string>) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => Store.openReadOnly(path.resolve(Option.getOrElse(directory, () => process.cwd()))),
      catch: (error) =>
        new Error(`no research record to read: ${error instanceof Error ? error.message : String(error)}`),
    }),
    (reader) => Effect.sync(() => reader.close()),
  )

/**
 * Opens an existing record for writing under its own project id. It never creates one: the project id belongs to the
 * server's project, and a record made here under another id would refuse the research plugin.
 */
export const openWriter = (directory: Option.Option<string>) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const root = path.resolve(Option.getOrElse(directory, () => process.cwd()))
        const reader = Store.openReadOnly(root)
        const projectId = reader.projectId
        reader.close()
        return Store.open(root, { projectId })
      },
      catch: (error) =>
        new Error(
          `no research record to write to: ${error instanceof Error ? error.message : String(error)}. The project's first research call creates it`,
        ),
    }),
    (store) => Effect.sync(() => store.close()),
  )

export const print = (lines: readonly string[]) =>
  Effect.sync(() => process.stdout.write(lines.filter((line) => line !== "").join(EOL) + EOL))
