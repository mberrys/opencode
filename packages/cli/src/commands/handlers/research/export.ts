import { join } from "node:path"
import { Effect, Option } from "effect"
import { refOf } from "@opencode/research-record"
import { renderAnswer } from "@opencode/research"
import { exportBundle, sealRendered, type Store } from "@opencode/research-store"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.export,
  Effect.fn("cli.research.export")(function* (input) {
    const { store, directory } = open(Option.getOrUndefined(input.directory))
    const requested = Option.getOrUndefined(input.run)
    const run = requested ?? latestRun(store)
    const out = Option.getOrUndefined(input.out) ?? join(directory, ".research", "export", run ?? "record")

    const result = yield* Effect.tryPromise({
      try: () => exportBundle(store, { out }),
      catch: (error) => new Error((error as Error).message),
    })

    const answer = store
      .kind("artifact")
      .filter((artifact) => artifact.body.type === "answer" && (run === undefined || artifact.body.run === run))
      .at(-1)

    if (answer) {
      const rendered = renderAnswer(store, refOf(answer))
      yield* Effect.tryPromise({
        try: async () => {
          await Bun.write(join(out, "answer.md"), rendered.markdown)
          await Bun.write(join(out, "answer.html"), rendered.html)
          await Bun.write(join(out, "references.bib"), rendered.bib)
          await Bun.write(join(out, "references.ris"), rendered.ris)
          await sealRendered(out, ["answer.md", "answer.html", "references.bib", "references.ris"])
        },
        catch: (error) => new Error((error as Error).message),
      })
    }

    print(
      [
        `bundle     ${result.directory}`,
        `log        ${result.log}`,
        `blobs      ${result.blobs}`,
        `verifier   ${result.verifier}`,
        answer ? "written    answer.md, answer.html, references.bib, references.ris" : "written    record only, no answer artifact",
        "",
        `check it with no dependencies:  node ${join(result.directory, "verify.mjs")} ${result.directory}`,
      ].join("\n"),
    )
    store.close()
  }),
)

function latestRun(store: Store): string | undefined {
  return store
    .kind("receipt")
    .map((receipt) => receipt.body.run)
    .at(-1)
}
