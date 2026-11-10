import { describe, expect, test } from "bun:test"
import { type Digest, makeRecord, refOf } from "@opencode/research-record"
import { bibliography, reference, renderAnswer, risOf } from "../src/render.js"
import { claim, decide, gap, quote } from "../src/evidence.js"
import { writeFileSync } from "node:fs"
import { exportBundle } from "@opencode/research-store"
import { join } from "node:path"
import { project } from "./fixture.js"

describe("rendering a cited answer", () => {
  test("every sentence shows its tier or is marked unsupported, and references are numbered", async () => {
    const { session, store, address } = await project()
    const cut = quote(session, { address })
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    const at = new Date().toISOString()
    const answer = makeRecord({
      kind: "artifact",
      at,
      author: { voice: "program" },
      session: session.session,
      body: {
        type: "answer",
        run: session.run,
        mediaType: "text/markdown",
        sentences: [
          { text: "Union decline explains part of the rise in wage inequality.", claim: written.claim },
          { text: "This paragraph summarizes the findings." },
        ],
        inputs: [written.claim],
      },
    })
    store.commit([answer], { at })

    const rendered = renderAnswer(store, refOf(answer))
    expect(rendered.markdown).toContain("Union decline explains part of the rise in wage inequality.[1]")
    expect(rendered.markdown).toContain("This paragraph summarizes the findings. **[unsupported]**")
    expect(rendered.markdown).toContain("Tier: **quoted**")
    expect(rendered.markdown).toContain("(supports) at")
    expect(rendered.markdown).toContain("1. Western, B. (2011). Union decline and wage inequality. *Social Forces* https://doi.org/10.1093/sf/soaa001")
    expect(rendered.html).toContain("<mark>")
    expect(rendered.bib).toContain("@article{western2011")
    expect(rendered.ris).toContain("TY  - JOUR")
    expect(rendered.html).toContain("<sup>1</sup>")
    expect(rendered.sources).toHaveLength(1)
  })

  test("a quote whose stored bytes are damaged is shown unverified and unnumbered", async () => {
    const { session, store, address } = await project()
    const cut = quote(session, { address })
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    const fragment = store.get(cut.fragment)
    if (fragment.kind !== "fragment") throw new Error("not a fragment")
    const representation = store.get(fragment.body.representation)
    if (representation.kind !== "representation") throw new Error("not a representation")
    // Same digest, different bytes: the case a verifier exists to catch.
    writeFileSync(store.blobs.path(representation.body.text), "Ruin has come to our family.")
    const at = new Date().toISOString()
    const answer = makeRecord({
      kind: "artifact",
      at,
      author: { voice: "program" },
      session: session.session,
      body: {
        type: "answer",
        run: session.run,
        mediaType: "text/markdown",
        sentences: [{ text: "A sentence.", claim: written.claim }],
        inputs: [written.claim],
      },
    })
    store.commit([answer], { at })
    const rendered = renderAnswer(store, refOf(answer))
    expect(rendered.markdown).toContain("[unverified, the quote no longer matches its bytes]")
    expect(rendered.markdown).not.toContain("A sentence.[1]")
  })

  test("a rejected claim is printed as rejected", async () => {
    const { session, store, address } = await project()
    const cut = quote(session, { address })
    const written = claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    decide({ ...session, actor: { voice: "researcher", id: "micha" } }, {
      target: `claim:${written.claim.id}`,
      ruling: "reject",
      reason: "the quote is about a different decade",
    })
    const at = new Date().toISOString()
    const answer = makeRecord({
      kind: "artifact",
      at,
      author: { voice: "program" },
      session: session.session,
      body: {
        type: "answer",
        run: session.run,
        mediaType: "text/markdown",
        sentences: [{ text: "A sentence.", claim: written.claim }],
        inputs: [written.claim],
      },
    })
    store.commit([answer], { at })
    const rendered = renderAnswer(store, refOf(answer))
    expect(rendered.markdown).toContain("(rejected)")
    expect(rendered.markdown).toContain("rejected by the researcher")
  })

  test("a disclosed gap is printed with what was searched", async () => {
    const { session, store } = await project()
    gap(session, {
      subquestion: "q2",
      searched: ["openalex: unions 1990-2000"],
      why: "no full text was open",
      howToClose: "add the publisher PDF",
    })
    const at = new Date().toISOString()
    const answer = makeRecord({
      kind: "artifact",
      at,
      author: { voice: "program" },
      session: session.session,
      body: { type: "answer", run: session.run, mediaType: "text/markdown", sentences: [{ text: "Nothing." }], inputs: [] },
    })
    store.commit([answer], { at })
    const rendered = renderAnswer(store, refOf(answer))
    expect(rendered.markdown).toContain("## Gaps")
    expect(rendered.markdown).toContain("openalex: unions 1990-2000")
    expect(rendered.markdown).toContain("**q2**: no full text was open")
  })

  test("a citation renders author, year, title, container and DOI", () => {
    expect(
      reference({
        title: "Union decline and wage inequality",
        author: [{ family: "Western", given: "Bruce" }, { family: "Rosenfeld", given: "Jake" }],
        issued: { "date-parts": [[2011]] },
        container: "Social Forces",
        DOI: "10.1093/sf/soaa001",
      }),
    ).toBe(
      "Western, B., & Rosenfeld, J. (2011). Union decline and wage inequality. *Social Forces* https://doi.org/10.1093/sf/soaa001",
    )
  })

  test("an author with no given name leaves no dangling comma", () => {
    expect(reference({ title: "Employment Outlook", author: [{ family: "OECD" }], issued: { "date-parts": [[2020]] } })).toBe(
      "OECD (2020). Employment Outlook.",
    )
  })

  test("two works by one author in one year get different keys", () => {
    const work = (number: number, title: string) => ({
      number,
      source: { kind: "source" as const, id: `sha256:${String(number).repeat(64)}` as Digest },
      csl: { title, author: [{ family: "Western", given: "Bruce" }], issued: { "date-parts": [[2011]] } },
    })
    const bib = bibliography([work(1, "First"), work(2, "Second")])
    expect(bib).toContain("@article{western2011,")
    expect(bib).toContain("@article{western2011-2,")
  })

  test("the bibliography and the ris use the same fields", () => {
    const citations = [
      {
        number: 1,
        source: { kind: "source" as const, id: `sha256:${"a".repeat(64)}` as Digest },
        csl: {
          title: "Union decline and wage inequality",
          author: [{ family: "Western", given: "Bruce" }],
          issued: { "date-parts": [[2011]] },
          container: "Social Forces",
          DOI: "10.1093/sf/soaa001",
        },
      },
    ]
    expect(bibliography(citations)).toContain("author = {Western, Bruce}")
    expect(bibliography(citations)).toContain("journal = {Social Forces}")
    expect(risOf(citations)).toContain("AU  - Western, Bruce")
    expect(risOf(citations)).toContain("DO  - 10.1093/sf/soaa001")
  })
})

describe("exporting a run that quotes and claims", () => {
  test("the bundle verifies when the fragment was shown by the session's own quote", async () => {
    const { session, store, address, directory } = await project()
    const cut = quote(session, { address })
    claim(session, {
      text: "Union decline explains part of the rise.",
      evidence: [{ fragment: `fragment:${cut.fragment.id}`, role: "supports" }],
    })
    const out = join(directory, "bundle")
    await exportBundle(store, { out })
    const verified = Bun.spawnSync({ cmd: [process.execPath, join(out, "verify.mjs"), out] })
    expect(verified.stdout.toString()).toContain("record verifies")
    expect(verified.exitCode).toBe(0)
  })
})
