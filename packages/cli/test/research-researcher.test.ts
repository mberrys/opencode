import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Receipt } from "@opencode/research-library"
import { ResearchRecord, Tier } from "@opencode/research-record"
import { Store } from "@opencode/research-store"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { add, rule, type Terminal } from "../src/commands/handlers/research/researcher"

// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const made: string[] = []
const opened: Store.Store[] = []
afterEach(() => {
  opened.splice(0).forEach((store) => store.close())
  made.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
})

const QUOTE = "Union density fell from 35% to 11%."

function project() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-research-researcher-"))
  made.push(directory)
  fs.writeFileSync(path.join(directory, "paper.txt"), `${QUOTE} Wages diverged.`)
  const store = Store.open(directory, { projectId: "project-1" })
  opened.push(store)
  return { directory, store }
}

/** A terminal that answers `answer` and keeps every prompt it was shown. */
function terminal(input: { readonly interactive: boolean; readonly answer?: boolean }) {
  const shown: string[] = []
  const prompt: Terminal = {
    interactive: () => input.interactive,
    confirm: async (message) => {
      shown.push(message)
      return input.answer ?? false
    },
  }
  return { prompt, shown }
}

/** A project holding one paper, a fragment of it, and a claim with one piece of supporting evidence. */
async function claimed() {
  const lib = project()
  const added = await add(
    lib.store,
    { target: "paper.txt", researcher: "me", cwd: lib.directory },
    terminal({ interactive: false }).prompt,
  )
  const representation = lib.store.graph().get(added!.representation!, "representation")
  const fragment = Receipt.program(lib.store, { program: "test", context: researcherContext }, "fragment", {
    representation: added!.representation!,
    representationDigest: representation.body.blob,
    selector: { profile: "utf8-bytes@1", start: 0, end: QUOTE.length, quote: QUOTE },
    before: "",
    after: "Wages diverged.",
    page: "none",
  })
  const claim = researcherRevision(lib.store, "claim", "claim-1", {
    text: "Unions declined.",
    scope: "",
    addresses: "none",
  })
  const evidence = researcherRevision(lib.store, "evidence", "evidence-1", {
    claim: ResearchRecord.refOf(claim),
    role: "supports",
    basis: {
      kind: "quote",
      cited: [
        {
          fragment: ResearchRecord.refOf(fragment),
          read: [{ start: 0, end: QUOTE.length }],
          insertions: [],
          secondary: "no",
        },
      ],
    },
    note: "",
  })
  lib.store.commit({ revisions: [fragment, claim, evidence] })
  return { ...lib, claim, evidence }
}

const researcherContext = {
  run: "none",
  session: "none",
  message: "none",
  call: "none",
  initiator: { voice: "researcher" as const, id: "me" },
}

function researcherRevision(store: Store.Store, kind: "claim" | "evidence", objectId: string, body: unknown) {
  return ResearchRecord.create({
    projectId: store.projectId,
    kind,
    schema: `${kind}@1`,
    objectId,
    parent: "none",
    author: { voice: "researcher", id: "me" },
    context: "none",
    body,
  })
}

const facts: Tier.Facts = { verified: () => true, shown: () => true, replayed: () => false }

function tier(store: Store.Store, claim: ResearchRecord.Revision) {
  const graph = store.graph()
  return Tier.derive({ graph, claim: ResearchRecord.refOf(claim), asOfSeq: graph.lastSeq, facts })
}

describe("opencode research adopt and reject", () => {
  test("record an attested ruling that names the claim revision and the evidence shown, and a later one revises it", async () => {
    const lib = await claimed()
    expect(tier(lib.store, lib.claim)).toEqual({ tier: "quoted", flags: [] })

    const adopting = terminal({ interactive: true, answer: true })
    const adopted = await rule(
      lib.store,
      { claim: "claim-1", ruling: "adopt", reason: "matches the series", researcher: "me" },
      adopting.prompt,
    )
    expect(adopting.shown).toHaveLength(1)
    expect(adopting.shown[0]).toContain(lib.claim.revisionId)
    expect(adopting.shown[0]).toContain(`supports evidence-1: "${QUOTE}"`)
    expect(adopting.shown[0]).toContain("Reason: matches the series")
    const decision = lib.store.graph().get(adopted!.decision, "decision")
    expect(decision).toMatchObject({
      author: { voice: "researcher", id: "me" },
      context: "none",
      parent: "none",
      body: {
        type: "adoption",
        ruling: "adopt",
        claim: ResearchRecord.refOf(lib.claim),
        evidence: [ResearchRecord.refOf(lib.evidence)],
        attestation: { level: "tty", surface: "opencode research adopt" },
      },
    })
    expect(lib.store.graph().get(adopted!.receipt, "receipt").body).toMatchObject({
      step: { kind: "command", command: "research.adopt" },
      written: [adopted!.decision],
    })
    expect(tier(lib.store, lib.claim)).toEqual({ tier: "adopted", flags: [] })

    const rejected = await rule(
      lib.store,
      { claim: "claim-1", ruling: "reject", reason: "", researcher: "me" },
      terminal({ interactive: true, answer: true }).prompt,
    )
    expect(rejected!.decision.objectId).toBe(adopted!.decision.objectId)
    expect(lib.store.graph().get(rejected!.decision, "decision").parent).toEqual(adopted!.decision)
    expect(tier(lib.store, lib.claim)).toEqual({ tier: "quoted", flags: ["rejected"] })
    expect(lib.store.verify().ok).toBe(true)
  })

  test("are refused away from a terminal, and write nothing when declined", async () => {
    const lib = await claimed()
    const before = lib.store.head()
    const piped = terminal({ interactive: false, answer: true })
    await expect(
      rule(lib.store, { claim: "claim-1", ruling: "adopt", reason: "", researcher: "me" }, piped.prompt),
    ).rejects.toThrow("only when you confirm it at a terminal")
    expect(piped.shown).toEqual([])

    const declined = await rule(
      lib.store,
      { claim: "claim-1", ruling: "adopt", reason: "", researcher: "me" },
      terminal({ interactive: true, answer: false }).prompt,
    )
    expect(declined).toBeUndefined()
    expect(lib.store.head()).toEqual(before)
    expect(tier(lib.store, lib.claim).tier).toBe("quoted")
  })

  test("refuse an id that is not a claim", async () => {
    const lib = await claimed()
    await expect(
      rule(
        lib.store,
        { claim: "evidence-1", ruling: "adopt", reason: "", researcher: "me" },
        terminal({ interactive: true, answer: true }).prompt,
      ),
    ).rejects.toThrow("no claim has the id evidence-1")
  })
})

describe("opencode research add", () => {
  test("attests a title confirmed at a terminal, records one given without a terminal as unattested, and writes nothing when declined", async () => {
    const lib = project()
    const titles = () =>
      lib.store
        .graph()
        .entries.flatMap((entry) =>
          entry.revision.kind === "decision" && entry.revision.body.type === "metadata"
            ? [{ value: entry.revision.body.value, level: entry.revision.body.attestation.level }]
            : [],
        )

    const declining = terminal({ interactive: true, answer: false })
    expect(
      await add(
        lib.store,
        { target: "paper.txt", title: "Unions", researcher: "me", cwd: lib.directory },
        declining.prompt,
      ),
    ).toBeUndefined()
    expect(declining.shown[0]).toContain('record "Unions" as its title')
    expect(lib.store.head()).toBeUndefined()

    const added = await add(
      lib.store,
      { target: "paper.txt", title: "Unions", researcher: "me", cwd: lib.directory },
      terminal({ interactive: true, answer: true }).prompt,
    )
    expect(added?.status).toBe("added")
    // The same bytes again resolve to the source already held, and the second title revises the first.
    const again = await add(
      lib.store,
      { target: "paper.txt", title: "Union decline", researcher: "me", cwd: lib.directory },
      terminal({ interactive: false }).prompt,
    )
    expect(again?.status).toBe("existing")
    expect(titles()).toEqual([
      { value: "Unions", level: "tty" },
      { value: "Union decline", level: "unattested" },
    ])
    // An unattested title does not displace the attested one.
    expect(Tier.citation(lib.store.graph(), added!.source, lib.store.graph().lastSeq).title).toEqual({
      value: "Unions",
      from: "researcher",
    })
    expect(lib.store.verify().ok).toBe(true)
  })
})
