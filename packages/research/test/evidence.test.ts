import { describe, expect, test } from "bun:test"
import { refOf } from "@opencode/research-record"
import { claim, decide, gap, quote, record } from "../src/evidence.js"
import { verify } from "@opencode/research-store"
import { project } from "./fixture.js"

describe("evidence verbs", () => {
  test("a quote cut by address returns a card with the surrounding words", async () => {
    const { session, address } = await project()
    const result = quote(session, { address })
    expect(result.card.quote).toBe("Union decline explains about a fifth of the rise in wage inequality.")
    expect(result.card.before).toBe("Union decline\n\n")
    expect(result.card.after).toBe(" The rest comes from changes in the retu")
    expect(result.card.flags).toEqual([])
    expect(verify(session.store).ok).toBe(true)
  })

  test("a claim rests on a fragment this session cut, and earns quoted", async () => {
    const { session, address } = await project()
    const cut = quote(session, { address })
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    expect(written.tier.tier).toBe("quoted")
    expect(verify(session.store).ok).toBe(true)
  })

  test("a claim on a fragment the session never saw is refused with the reason", async () => {
    const { session, address } = await project()
    const cut = quote(session, { address })
    const other = { ...session, session: "ses_other", run: "ses_other" }
    expect(() =>
      claim(other, {
        text: "Union decline explains part of the rise.",
        evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
      }),
    ).toThrow("was never shown to this session")
  })

  test("a claim with no evidence is refused", async () => {
    const { session } = await project()
    expect(() => claim(session, { text: "x", evidence: [] })).toThrow("at least one piece of evidence")
  })

  test("the researcher's own claim is exempt from the shown set", async () => {
    const { session, address } = await project({ voice: "researcher" })
    const cut = quote(
      { ...session, session: "ses_reader", run: "ses_reader", actor: { voice: "agent", id: "reader" } },
      { address },
    )
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    expect(written.tier.tier).toBe("quoted")
  })

  test("a gap without its searches is refused", async () => {
    const { session } = await project()
    expect(() =>
      gap(session, { subquestion: "q1", searched: [], why: "nothing found", howToClose: "search more" }),
    ).toThrow("states what was searched")
    expect(() =>
      gap(session, { subquestion: "q1", searched: ["openalex: union decline"], why: "nothing", howToClose: "" }),
    ).toThrow("how to close it")
  })

  test("a recorded gap is a receipt the run can read back", async () => {
    const { session } = await project()
    const result = gap(session, {
      subquestion: "q1",
      searched: ["openalex: union decline 2010-2020"],
      why: "no full text was open",
      howToClose: "add the publisher PDF",
    })
    const receipt = session.store.get(result.receipt)
    expect(receipt.kind).toBe("receipt")
    expect(verify(session.store).ok).toBe(true)
  })

  test("only the researcher adopts, and the adoption raises the tier", async () => {
    const { session, address } = await project()
    const cut = quote(session, { address })
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    expect(() => decide(session, { target: `claim:${written.claim.id}`, ruling: "adopt" })).toThrow(
      "belong to the researcher",
    )
    const researcher = { ...session, actor: { voice: "researcher" as const, id: "micha" } }
    const adopted = decide(researcher, { target: `claim:${written.claim.id}`, ruling: "adopt", reason: "checked" })
    expect(adopted.ruling).toBe("adopt")
    const decision = session.store.get(adopted.decision)
    expect(decision.kind).toBe("decision")
    expect(refOf(decision as never).kind).toBe("decision")
  })

  test("every tool call leaves a receipt in order", async () => {
    const { session, address } = await project()
    quote(session, { address })
    quote(session, { address, sentences: 2 })
    record(session, "library.grep", { pattern: "union" }, [], () => ({ hits: 1 }))
    const receipts = session.store.kind("receipt").filter((item) => item.body.run === "ses_1")
    expect(receipts.map((item) => item.body.seq)).toEqual([1, 2, 3])
    expect(receipts.map((item) => (item.body.operation.kind === "tool" ? item.body.operation.tool : ""))).toEqual([
      "evidence.quote",
      "evidence.quote",
      "library.grep",
    ])
  })
})
