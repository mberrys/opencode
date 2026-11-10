import { define } from "@opencode/plugin/effect/plugin"
import { Store } from "@opencode/research-store"
import { Effect } from "effect"
import { installAgents } from "./agents.js"
import { skills } from "./skills.js"
import { installTools } from "./tools.js"

/**
 * The research harness as one built-in plugin. `verify`, `show`, `export` and `replay` also work without it,
 * because they run on the record packages alone.
 */
export const Plugin = define({
  id: "opencode.research",
  effect: Effect.fn("ResearchPlugin")(function* (ctx) {
    const stores = new Map<string, Store>()
    const open = () => {
      const directory = ctx.location.directory
      const existing = stores.get(directory)
      if (existing) return existing
      const created = Store.open(directory)
      stores.set(directory, created)
      return created
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const store of stores.values()) store.close()
        stores.clear()
      }),
    )

    yield* installTools(ctx, open)
    yield* ctx.agent.transform((editor) => installAgents(editor))
    yield* ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "research",
        description: "run the research loop on a question, with a cited answer",
        execute: (input) =>
          Effect.gen(function* () {
            const question = input.prompt.text.trim()
            if (!question) return yield* Effect.fail(new Error("Usage: /research <question>"))
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: [
                "Run the research loop for this question:",
                "",
                question,
                "",
                "Scope it first and write the protocol with research.protocol, then send one reader per sub-question. Quote before you claim, disclose every gap, and finish with the answer.",
              ].join("\n"),
              resume: true,
            })
          }),
      })
    })
  }),
})

export default Plugin
