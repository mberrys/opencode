import { Plugin } from "@opencode/plugin/effect"
import { Store } from "@opencode/research-store"
import { Effect } from "effect"
import { Agents } from "./agents.js"
import { skills } from "./skills.js"
import { Tools } from "./tools.js"

// The research harness. Core registers it only when the `research` flag is on.
export default Plugin.define({
  id: "opencode.research",
  effect: Effect.fn("ResearchPlugin")(function* (ctx) {
    // The record is opened on the first research call, so a project that never researches gets no `.research/`.
    const opened: Store.Store[] = []
    const store = () => {
      if (opened.length === 0) opened.push(Store.open(ctx.location.directory, { projectId: ctx.location.project.id }))
      return opened[0]
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => opened.splice(0).forEach((item) => item.close())))

    yield* Tools.install(ctx, store)
    yield* ctx.agent.transform((editor) => Agents.install(editor, ctx.location.directory))
    yield* ctx.skill.transform((editor) => skills.forEach((skill) => editor.add(skill)))
    yield* ctx.command.transform((editor) =>
      editor.add({
        name: "research",
        description: "research a question, with a cited answer",
        execute: (input) =>
          Effect.gen(function* () {
            const question = input.prompt.text.trim()
            if (question === "") return yield* Effect.fail(new Error("Usage: /research <question>"))
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: [
                "Research this question:",
                "",
                question,
                "",
                "Scope it first and write the protocol with research_protocol, then send one reader per sub-question. Quote before you claim, record every gap, and finish with the answer.",
              ].join("\n"),
            })
          }),
      }),
    )
  }),
})
