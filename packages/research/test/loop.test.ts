import { describe, expect, test } from "bun:test"
import { makeRecord } from "@opencode/research-record"
import { budgetsFor, nextStep, openGaps, stopping } from "../src/loop.js"
import { claim, gap, quote } from "../src/evidence.js"
import { project } from "./fixture.js"

describe("the research loop", () => {
  test("the effort setting fixes every budget", () => {
    expect(budgetsFor("fast")).toEqual({ subquestions: 2, sourcesPerSubquestion: 3, readFullText: false, gapRounds: 1 })
    expect(budgetsFor("balanced")).toEqual({ subquestions: 4, sourcesPerSubquestion: 8, readFullText: true, gapRounds: 2 })
    expect(budgetsFor("deep")).toEqual({ subquestions: 8, sourcesPerSubquestion: 20, readFullText: true, gapRounds: 4 })
  })

  test("an unanswered sub-question is an open gap, and a quoted claim closes it", async () => {
    const { session, store, address } = await project()
    const at = new Date().toISOString()
    store.commit(
      [
        makeRecord({
          kind: "protocol",
          at,
          author: { voice: "agent", id: "research" },
          body: {
            question: "Why did wage inequality rise?",
            scope: { in: ["United States", "1970-2010"], out: ["Europe"] },
            subquestions: [
              { id: "q1", question: "How much did union decline contribute?" },
              { id: "q2", question: "How much did education returns contribute?" },
            ],
            effort: "balanced",
            budgets: budgetsFor("balanced"),
            run: session.run,
          },
        }),
      ],
      { at },
    )
    expect(openGaps(store, session.run).map((gap) => gap.kind)).toEqual(["unanswered", "unanswered"])

    const cut = quote(session, { address })
    claim(session, {
      text: "Union decline explains about a fifth.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
      scope: { subquestion: "q1" },
    })
    expect(openGaps(store, session.run).map((gap) => gap.subquestion)).toEqual(["q2"])
    expect(stopping(store, session.run).exitCode).toBe(1)
  })

  test("a disclosed gap still leaves the run open, and the next step names it", async () => {
    const { session, store } = await project()
    const at = new Date().toISOString()
    store.commit(
      [
        makeRecord({
          kind: "protocol",
          at,
          author: { voice: "agent", id: "research" },
          body: {
            question: "Q",
            scope: { in: [], out: [] },
            subquestions: [{ id: "q1", question: "First" }],
            effort: "fast",
            budgets: budgetsFor("fast"),
            run: session.run,
          },
        }),
      ],
      { at },
    )
    gap(session, { subquestion: "q1", searched: ["openalex: q"], why: "nothing open", howToClose: "add a PDF" })
    expect(openGaps(store, session.run).map((g) => g.kind)).toEqual(["unanswered", "disclosed"])
    expect(nextStep(store, session.run).instruction).toContain("Open sub-questions: q1")
  })

  test("a reader in a child session closes the run its protocol names", async () => {
    const { session, store, address } = await project()
    const at = new Date().toISOString()
    store.commit(
      [
        makeRecord({
          kind: "protocol",
          at,
          author: { voice: "agent", id: "research" },
          session: session.session,
          body: {
            question: "Q",
            scope: { in: [], out: [] },
            subquestions: [{ id: "q1", question: "First" }],
            effort: "fast",
            budgets: budgetsFor("fast"),
            run: "run_parent",
          },
        }),
      ],
      { at },
    )
    const reader = { ...session, session: "ses_reader", actor: { voice: "agent" as const, id: "reader" } }
    const cut = quote(reader, { address })
    const written = claim(reader, {
      text: "Union decline explains about a fifth.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
      scope: { subquestion: "q1" },
    })
    expect(written.tier.tier).toBe("quoted")
    expect(stopping(store, "run_parent").exitCode).toBe(0)
  })

  test("a claim with no evidence cannot end a run", async () => {
    const { session, store } = await project()
    const at = new Date().toISOString()
    store.commit(
      [
        makeRecord({
          kind: "claim",
          at,
          author: { voice: "agent", id: "reader" },
          session: session.session,
          body: { text: "An unsupported assertion.", run: session.run },
        }),
      ],
      { at },
    )
    expect(openGaps(store, session.run).map((g) => g.kind)).toContain("unevidenced")
    expect(stopping(store, session.run).exitCode).toBe(1)
  })

  test("a run with nothing open ends at zero", async () => {
    const { session, store } = await project()
    const result = stopping(store, session.run)
    expect(result.exitCode).toBe(0)
    expect(nextStep(store, session.run).instruction).toContain("Every sub-question is answered")
  })
})
