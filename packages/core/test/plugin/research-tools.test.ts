import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import ResearchPlugin from "@opencode/research"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { permissionLayer } from "../lib/permission"
import { executeTool, registerToolPlugin, toolIdentity, toolNodeReplacements } from "../lib/tool"

const it = testEffect(
  AppNodeBuilder.build(Tool.node, toolNodeReplacements(permissionLayer({ assert: () => Effect.void }))),
)

const PAPER = [
  "# Union decline",
  "",
  "Union decline explains about a fifth of the rise in wage inequality. The rest comes from changes in the returns to education.",
  "",
  "Some argue unions mattered little. They point to trade instead.",
].join("\n")

/** One Code Mode program that chains every research tool but `library.find` (which asks OpenAlex), id to id. */
const RUN = `
const before = await tools.research.status({})
const protocol = await tools.research.protocol({
  question: "Why did wage inequality rise?",
  scope: { in: ["United States"], out: [] },
  subquestions: [
    { id: "unions", text: "How much did union decline contribute?" },
    { id: "trade", text: "How much did trade contribute?" },
  ],
  criteria: [],
  plan: "Read the labour economics literature.",
  effort: "fast",
})
const added = await tools.library.add({ file: "paper.md" })
const grep = await tools.library.grep({ pattern: "fifth" })
const short = grep.hits[0].short
const outline = await tools.library.outline({ source: short })
const read = await tools.library.read({ address: short })
const search = await tools.library.search({ query: "trade unions" })
const cites = await tools.library.cites({ source: short })
const quote = await tools.evidence.quote({ address: grep.hits[0].address })
const claim = await tools.evidence.claim({
  text: "Union decline explains a fifth of the rise.",
  evidence: [{ fragment: quote.fragment, role: "supports" }],
  subquestion: "unions",
})
const gap = await tools.evidence.gap({
  subquestion: "trade",
  missing: "No source measures trade.",
  searched: [search.receipt],
  close: "Search the trade literature.",
})
const status = await tools.research.status({})
const check = await tools.evidence.check({})
const answer = await tools.research.answer({ sentences: [{ text: "Unions explain a fifth.", claim: claim.claim }] })
return { before, protocol, added, outline, read, grep, search, cites, quote, claim, gap, status, check, answer }
`

describe("research tools", () => {
  it.live("return their declared output to a Code Mode program, so ids chain from call to call", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped("opencode-research-tools-")).path
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "paper.md"), PAPER))
      const registry = yield* Tool.Service
      const sessionID = Session.ID.make("ses_research_tools")
      yield* registerToolPlugin(ResearchPlugin, {
        location: new Location.Info({
          directory: AbsolutePath.make(directory),
          project: {
            id: Project.ID.global,
            directory: AbsolutePath.make(directory),
            canonical: AbsolutePath.make(directory),
          },
        }),
        permission: {
          hook: () => Effect.die("unused permission.hook"),
          list: () => Effect.die("unused permission.list"),
          get: () => Effect.die("unused permission.get"),
          reply: () => Effect.die("unused permission.reply"),
          assert: () => Effect.void,
        },
        session: {
          // SAFETY: the plugin reads only `parentID`, to find the run a session joins.
          get: () => Effect.succeed({ parentID: undefined }) as never,
        },
        agent: {
          get: () => Effect.die("unused agent.get"),
          list: () => Effect.die("unused agent.list"),
          transform: () => Effect.succeed({ dispose: Effect.void }),
          reload: () => Effect.die("unused agent.reload"),
        },
        skill: {
          list: () => Effect.die("unused skill.list"),
          transform: () => Effect.succeed({ dispose: Effect.void }),
          reload: () => Effect.die("unused skill.reload"),
        },
        command: {
          list: () => Effect.die("unused command.list"),
          transform: () => Effect.succeed({ dispose: Effect.void }),
          reload: () => Effect.die("unused command.reload"),
        },
      })

      const research = (yield* registry.list()).filter((tool) =>
        ["library", "evidence", "research"].includes(tool.options?.namespace ?? ""),
      )
      expect(research.map((tool) => `${tool.options?.namespace}.${tool.name}`).toSorted()).toEqual([
        "evidence.check",
        "evidence.claim",
        "evidence.gap",
        "evidence.quote",
        "library.add",
        "library.cites",
        "library.find",
        "library.grep",
        "library.outline",
        "library.read",
        "library.search",
        "research.answer",
        "research.protocol",
        "research.status",
      ])
      expect(research.filter((tool) => tool.output === undefined).map((tool) => tool.name)).toEqual([])

      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call_research", name: "execute", input: { code: RUN } },
      })
      expect(result.status).toBe("completed")
      // A failing tool call fails the program, and its message comes back as the program's output.
      expect(result.output.error ? result.output.output : undefined).toBeUndefined()
      expect(
        result.output.toolCalls.filter((call: { status: string }) => call.status !== "completed").length,
      ).toBe(0)
      const out = JSON.parse(result.output.output)

      expect(out.before).toEqual({ claims: 0, gaps: 0, open: [] })
      expect(Object.keys(out.protocol).toSorted()).toEqual(["protocol", "receipt", "run"])
      expect(out.protocol.protocol).toMatch(/^protocol-/)
      expect(out.protocol.run).toMatch(/^run-/)
      expect(out.protocol.receipt).toMatch(/^receipt-/)
      expect(out.added.status).toBe("added")
      expect(out.added.source.objectId).toMatch(/^source-/)
      expect(out.added.receipt.objectId).toMatch(/^receipt-/)
      expect(out.grep.hits[0].source).toEqual(out.added.source)
      expect(out.outline.source).toEqual(out.added.source)
      expect(out.outline.sections.length).toBeGreaterThan(0)
      // Byte offsets into the stored text: the fields a fragment's selector names.
      expect(out.read.sentences[0].end - out.read.sentences[0].start).toBe(
        Buffer.byteLength(out.read.sentences[0].text),
      )
      expect(out.grep.receipt).toMatch(/^receipt-/)
      expect(out.grep.hits[0].text).toContain("fifth")
      expect(out.search.receipt).toMatch(/^receipt-/)
      expect(out.search.hits.length).toBeGreaterThan(0)
      expect(out.cites.source.objectId).toBe(out.added.source.objectId)
      expect(out.quote).toMatchObject({
        fragment: expect.stringMatching(/^fragment-/),
        address: out.grep.hits[0].address,
        receipt: expect.stringMatching(/^receipt-/),
      })
      expect(out.claim).toEqual({
        claim: expect.stringMatching(/^claim-/),
        evidence: [expect.stringMatching(/^evidence-/)],
        receipt: expect.stringMatching(/^receipt-/),
      })
      expect(out.gap.gap).toMatch(/^judgment-/)
      expect(out.status).toEqual({
        protocol: out.protocol.protocol,
        question: "Why did wage inequality rise?",
        claims: 1,
        gaps: 1,
        open: [],
      })
      expect(out.check.record.ok).toBe(true)
      expect(out.check.replay.entries.length).toBeGreaterThan(0)
      expect(out.answer).toMatchObject({
        answer: expect.stringMatching(/^artifact-/),
        receipt: expect.stringMatching(/^receipt-/),
        markdown: expect.stringContaining("Unions explain a fifth."),
      })
    }),
  )
})
