// Builds test/vectors/revisions.json, the frozen identities of research-record@1. Run it only to add vectors on
// purpose (`bun test/vectors/build.ts`); the tests and the Python verifier check the file, never this script.
import { Canonical } from "../../src/canonical"
import { ResearchRecord } from "../../src/record"
import type { Ref } from "../../src/ref"

const PROJECT = "project-1"
const encoder = new TextEncoder()
const blob = (text: string, schema: string | "none" = "none") => ({
  digest: Canonical.blobDigest(encoder.encode(text)),
  schema,
})
const at = (minute: number) => ({
  started: `2026-11-15T10:${String(minute).padStart(2, "0")}:00Z`,
  ended: `2026-11-15T10:${String(minute).padStart(2, "0")}:30Z`,
})
const program = { voice: "program", id: "research@2.3.0" } as const
const reader = { voice: "agent", id: "reader" } as const
const researchAgent = { voice: "agent", id: "research" } as const
const checker = { voice: "agent", id: "checker" } as const
const researcher = { voice: "researcher", id: "owner" } as const
const inSession = (call: string, initiator: { voice: string; id: string } = reader) => ({
  run: "run-1",
  session: "session-reader-1",
  message: "message-1",
  call,
  initiator,
})
const attested = { level: "tty", surface: "cli" } as const

/** The representation text: multibyte characters keep the byte offsets honest. */
export const TEXT = "Union density fell from 35% to 11% between 1979 and 2019. Wage inequality rose — façade naïveté ✓."
export const TEXT_2 = "Union density fell from 35% to 11% between 1979 and 2019.\nWage inequality rose."

const entries: { name: string; seq: number; revision: ResearchRecord.Revision }[] = []
const add = (name: string, seq: number, preimage: unknown) => {
  const revision = ResearchRecord.create(preimage)
  entries.push({ name, seq, revision })
  return ResearchRecord.refOf(revision)
}
const sortRefs = (refs: Ref.Exact[]) => refs.toSorted((a, b) => (Canonical.json(a) < Canonical.json(b) ? -1 : 1))
const base = (
  kind: ResearchRecord.Kind,
  objectId: string,
  author: unknown,
  context: unknown,
  body: unknown,
  parent: unknown = "none",
) => ({
  projectId: PROJECT,
  kind,
  schema: `${kind}@1`,
  objectId,
  parent,
  author,
  context,
  body,
})
const decision = (seq: number, name: string, body: ResearchRecord.Body<"decision">) =>
  add(name, seq, base("decision", ResearchRecord.decisionObjectId(body), researcher, "none", body))

// 1: the protocol, written by the research agent before any search.
const protocol = add(
  "protocol",
  1,
  base(
    "protocol",
    "protocol-1",
    researchAgent,
    { ...inSession("call-protocol", researchAgent), session: "session-research" },
    {
      question: "How much of the rise in US wage inequality since 1979 does union decline explain?",
      scope: { in: ["United States", "1979-2019"], out: ["public sector"] },
      subquestions: [
        { id: "sq-1", text: "How far did union density fall?" },
        { id: "sq-2", text: "What share of the rise in inequality is attributed to it?" },
      ],
      criteria: ["peer-reviewed or official statistics"],
      plan: "Search OpenAlex, read full text where open, quote counter-evidence.",
      effort: "standard",
      budgets: { subquestions: 2, sourcesPerSubquestion: 5, fullText: true },
    },
  ),
)

// 2: a search, then the work acquired with its copy and text.
const search = add(
  "receipt search",
  2,
  base("receipt", "receipt-search", program, inSession("call-find"), {
    at: at(1),
    step: {
      kind: "tool",
      tool: "library.find",
      version: "1",
      replay: "stored",
      input: blob('{"query":"union decline"}', "search-query@1"),
      output: blob('["W1"]', "search-results@1"),
    },
    written: [],
    skills: [
      {
        name: "search-strategy",
        digest: ResearchRecord.skillDigest({ "SKILL.md": encoder.encode("# search-strategy\n") }),
      },
    ],
    lenses: [],
    outcome: { status: "ok" },
  }),
)
const source = add(
  "source",
  2,
  base("source", "source-1", program, inSession("call-add"), {
    type: "article-journal",
    identifiers: [
      { scheme: "doi", value: "10.1177/0003122411414817" },
      { scheme: "openalex", value: "W1" },
    ],
    fields: {
      title: {
        value: "Unions, Norms, and the Rise in U.S. Wage Inequality",
        origin: { by: "service", service: "crossref", response: blob("crossref-response").digest },
      },
      issued: {
        value: { "date-parts": [[2011]] },
        origin: { by: "service", service: "crossref", response: blob("crossref-response").digest },
      },
    },
  }),
)
const copy = add(
  "copy",
  2,
  base("copy", "copy-1", program, inSession("call-add"), {
    source,
    blob: blob("%PDF-1.7 bytes").digest,
    mediaType: "application/pdf",
    size: 14,
    content: "full-text",
    retrieved: { from: "https://example.org/paper.pdf", at: "2026-11-15T10:02:00Z" },
    licence: "CC-BY-4.0",
  }),
)
const representation = add(
  "representation",
  2,
  base("representation", "representation-1", program, inSession("call-add"), {
    copy,
    blob: Canonical.blobDigest(encoder.encode(TEXT)),
    extractor: { id: "pdf-text", version: "0.4.1" },
    tree: blob("tree", "structure-tree@1"),
    ocr: false,
  }),
)
add(
  "receipt add",
  2,
  base("receipt", "receipt-add", program, inSession("call-add"), {
    at: at(2),
    step: {
      kind: "tool",
      tool: "library.add",
      version: "1",
      replay: "stored",
      input: blob('{"doi":"10.1177/0003122411414817"}'),
      output: blob('{"source":"source-1"}'),
    },
    written: sortRefs([source, copy, representation]),
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  }),
)

// 3: the program cuts a fragment at the reader's request.
const quote = "Union density fell from 35% to 11%"
const fragment = add(
  "fragment",
  3,
  base("fragment", "fragment-1", program, inSession("call-quote"), {
    representation,
    representationDigest: Canonical.blobDigest(encoder.encode(TEXT)),
    selector: { profile: "utf8-bytes@1", start: 0, end: encoder.encode(quote).length, quote },
    before: "",
    after: " between 1979 and 2019.",
    page: { number: 4, boxes: [[72, 540.5, 523, 552]] },
  }),
)

// 4: a claim and its quoted evidence, with the receipt of the evidence.claim call.
const claim = add(
  "claim",
  4,
  base("claim", "claim-1", reader, inSession("call-claim"), {
    text: "US union density fell from 35% to 11% between 1979 and 2019.",
    scope: "Private and public sectors combined",
    addresses: { protocol, subquestion: "sq-1" },
  }),
)
const evidence = add(
  "evidence",
  4,
  base("evidence", "evidence-1", reader, inSession("call-claim"), {
    claim,
    role: "supports",
    basis: {
      kind: "quote",
      cited: [
        {
          fragment,
          read: [
            { start: 0, end: 13 },
            { start: 19, end: encoder.encode(quote).length },
          ],
          insertions: [{ at: 0, text: "US" }],
          secondary: "no",
        },
      ],
    },
    note: "The headline numbers, read from the abstract's first sentence.",
  }),
)
add(
  "receipt claim",
  4,
  base("receipt", "receipt-claim", program, inSession("call-claim"), {
    at: at(4),
    step: {
      kind: "tool",
      tool: "evidence.claim",
      version: "1",
      replay: "rerun",
      input: blob("claim input"),
      output: blob("claim output"),
    },
    written: sortRefs([claim, evidence]),
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  }),
)

// 5: a script that counts, its output, and a model call.
const claim2 = add(
  "claim computed",
  5,
  base("claim", "claim-2", reader, inSession("call-script"), {
    text: "Two of the five sources report a decline of more than 20 points.",
    scope: "This library",
    addresses: "none",
  }),
)
const table = add(
  "artifact table",
  5,
  base("artifact", "artifact-table", program, inSession("call-script"), {
    inputs: [source],
    output: { digest: blob("count,2").digest, schema: "none", mediaType: "text/csv" },
    transformation: "codemode.script",
  }),
)
const script = add(
  "receipt script",
  5,
  base("receipt", "receipt-script", program, inSession("call-script"), {
    at: at(5),
    step: {
      kind: "script",
      script: blob(
        "const hits = await tools.library.grep({ pattern: 'fell' }); return hits.length",
        "codemode-script@1",
      ),
      engine: { id: "opencode-codemode", version: "2.3.0" },
      clock: "2026-11-15T10:05:00Z",
      seed: "seed-1",
      calls: [
        { tool: "library.grep", version: "1", input: blob('{"pattern":"fell"}'), output: blob("[1,2]") },
        {
          tool: "library.read",
          version: "1",
          input: blob('{"address":"k7f2:9"}'),
          output: { error: "no such address" },
        },
      ],
      result: blob("2"),
    },
    written: sortRefs([claim2, table]),
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  }),
)
add(
  "receipt model",
  5,
  base(
    "receipt",
    "receipt-model",
    program,
    { ...inSession("none"), call: "none" },
    {
      at: at(6),
      step: {
        kind: "model",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        request: blob("[manifest]", "context-manifest@1"),
        response: blob("response", "model-response@1"),
      },
      written: [],
      skills: [
        {
          name: "read-and-quote",
          digest: ResearchRecord.skillDigest({
            "SKILL.md": encoder.encode("# read-and-quote\n"),
            "examples.md": encoder.encode("example\n"),
          }),
        },
      ],
      lenses: [],
      outcome: { status: "ok" },
    },
  ),
)

// 6: computed evidence, a lens manifest and the answer.
const evidence2 = add(
  "evidence computed",
  6,
  base("evidence", "evidence-2", reader, inSession("call-claim-2"), {
    claim: claim2,
    role: "supports",
    basis: { kind: "computation", run: script, output: table },
    note: "",
  }),
)
const manifest = add(
  "artifact lens manifest",
  6,
  base(
    "artifact",
    "artifact-lens",
    program,
    { ...inSession("call-draft-lens", researchAgent), session: "session-research" },
    {
      inputs: [source],
      output: { digest: blob('{"categories":[]}').digest, schema: "lens-manifest@1", mediaType: "application/json" },
      transformation: "lens.draft",
    },
  ),
)
const answer = add(
  "artifact answer",
  6,
  base(
    "artifact",
    "artifact-answer",
    program,
    { ...inSession("call-render", researchAgent), session: "session-research" },
    {
      inputs: [claim],
      output: { digest: blob("# Answer").digest, schema: "answer@1", mediaType: "text/markdown" },
      transformation: "render.answer",
    },
  ),
)

// 7: agent judgments.
const lensPin = { id: "power-resources", version: "0.1.0", digest: blob('{"categories":[]}').digest }
add(
  "judgment support",
  7,
  base("judgment", "judgment-support", checker, inSession("call-check"), {
    type: "support",
    reason: "The quote states the figures.",
    evidence,
    opinion: "supports",
  }),
)
const challenge = add(
  "judgment challenge",
  7,
  base("judgment", "judgment-challenge", checker, inSession("call-check"), {
    type: "challenge",
    reason: "The read spans skip 'fell'.",
    evidence,
    grounds: "clipped",
  }),
)
add(
  "judgment screening",
  7,
  base("judgment", "judgment-screening", reader, inSession("call-screen"), {
    type: "screening",
    reason: "On topic and in period.",
    source,
    protocol,
    call: "include",
  }),
)
add(
  "judgment gap",
  7,
  base("judgment", "judgment-gap", reader, inSession("call-gap"), {
    type: "gap",
    reason: "No source attributes a share.",
    protocol,
    subquestion: "sq-2",
    missing: "A decomposition of the inequality rise",
    searched: [search],
    close: "Add Western and Rosenfeld (2011) in full text.",
  }),
)
add(
  "judgment metadata",
  7,
  base("judgment", "judgment-metadata", reader, inSession("call-meta"), {
    type: "metadata",
    reason: "Printed on the first page.",
    source,
    field: "publisher",
    value: "SAGE",
  }),
)
const lensChoice = add(
  "judgment lens choice",
  7,
  base(
    "judgment",
    "judgment-lens",
    researchAgent,
    { ...inSession("call-lens", researchAgent), session: "session-research" },
    {
      type: "lens-choice",
      reason: "The question is about bargaining power.",
      subject: [protocol],
      chosen: lensPin,
    },
  ),
)

// 8: the researcher's rulings.
decision(8, "decision challenge ruling", {
  type: "challenge-ruling",
  reason: "The gap is marked; nothing is clipped.",
  attestation: attested,
  challenge,
  ruling: "dismissed",
})
decision(8, "decision adoption", {
  type: "adoption",
  reason: "",
  attestation: attested,
  claim,
  evidence: [evidence],
  ruling: "adopt",
})
decision(8, "decision metadata", {
  type: "metadata",
  reason: "Shorter title.",
  attestation: attested,
  source,
  field: "title",
  value: "Unions, Norms, and Wage Inequality",
})
decision(8, "decision challenge", {
  type: "challenge",
  reason: "The count includes a duplicate.",
  attestation: { level: "tui-gesture", surface: "tui" },
  evidence: evidence2,
  grounds: "other",
})
decision(8, "decision lens setting", {
  type: "lens-setting",
  reason: "Keep the default reading too.",
  attestation: attested,
  subject: [protocol],
  lens: lensPin,
  overrides: lensChoice,
})
decision(8, "decision lens adoption", {
  type: "lens-adoption",
  reason: "",
  attestation: attested,
  manifest,
  ruling: "adopt",
})
decision(8, "decision unattested", {
  type: "adoption",
  reason: "Run by a shell command.",
  attestation: { level: "unattested", surface: "shell" },
  claim: claim2,
  evidence: [evidence2],
  ruling: "adopt",
})

// 9: a newer text, the re-find onto it, and every refusal.
const representation2 = add(
  "representation newer",
  9,
  base("representation", "representation-2", program, inSession("call-add-2"), {
    copy,
    blob: Canonical.blobDigest(encoder.encode(TEXT_2)),
    extractor: { id: "pdf-text", version: "0.5.0" },
    tree: blob("tree 2", "structure-tree@1"),
    ocr: true,
  }),
)
const refusal = (name: string, minute: number, outcome: unknown, extra: { lenses?: unknown[] } = {}) =>
  add(
    name,
    9,
    base("receipt", `receipt-${name.replaceAll(" ", "-")}`, program, inSession(`call-${minute}`), {
      at: at(minute),
      step: { kind: "tool", tool: "evidence.quote", version: "1", replay: "rerun", input: blob(name), output: "none" },
      written: [],
      skills: [],
      lenses: extra.lenses ?? [],
      outcome,
    }),
  )
refusal(
  "refused lens works missing",
  10,
  {
    status: "refused",
    refusal: { code: "lens-works-missing", missing: [blob("a").digest, blob("b").digest].toSorted() },
  },
  { lenses: [lensPin] },
)
refusal("refused not shown", 11, { status: "refused", refusal: { code: "not-shown", fragment } })
refusal("refused no match", 12, { status: "refused", refusal: { code: "no-match" } })
refusal("refused ambiguous match", 13, { status: "refused", refusal: { code: "ambiguous-match" } })
refusal("refused refind unresolved", 14, {
  status: "refused",
  refusal: { code: "refind-unresolved", fragment, against: representation2 },
})
refusal("refused refind ambiguous", 15, {
  status: "refused",
  refusal: { code: "refind-ambiguous", fragment, against: representation2 },
})
refusal("failed", 16, { status: "failed", error: "extractor crashed" })
add(
  "receipt command",
  9,
  base("receipt", "receipt-command", program, "none", {
    at: at(17),
    step: { kind: "command", command: "research adopt", input: blob("claim-1") },
    written: [],
    skills: [],
    lenses: [],
    outcome: { status: "ok" },
  }),
)

// 10: the fragment re-found on the newer text, as its next revision.
add(
  "fragment refound",
  10,
  base(
    "fragment",
    "fragment-1",
    program,
    inSession("call-refind"),
    {
      representation: representation2,
      representationDigest: Canonical.blobDigest(encoder.encode(TEXT_2)),
      selector: { profile: "utf8-bytes@1", start: 0, end: encoder.encode(quote).length, quote },
      before: "",
      after: " between 1979 and 2019.",
      page: "none",
    },
    fragment,
  ),
)

export { entries, PROJECT }

/** Revisions both languages must refuse, each built by changing one thing in a valid vector. */
function refusals() {
  const claimRevision = entries.find((entry) => entry.name === "claim")!.revision
  const decisionRevision = entries.find((entry) => entry.name === "decision adoption")!.revision
  const { revisionId: _claimId, ...claimPreimage } = claimRevision
  const { revisionId: _decisionId, ...decisionPreimage } = decisionRevision
  const sealed = (value: Record<string, unknown>) => ({ ...value, revisionId: Canonical.digest(value) })
  return [
    {
      name: "an edited body under the old id",
      revision: { ...claimRevision, body: { ...claimRevision.body, text: "Edited." } },
      code: "digest-mismatch",
    },
    { name: "an extra envelope field", revision: sealed({ ...claimPreimage, extra: 1 }), code: "invalid-record" },
    {
      name: "an unknown kind",
      revision: sealed({ ...claimPreimage, kind: "statement", schema: "statement@1" }),
      code: "invalid-record",
    },
    { name: "a later schema", revision: sealed({ ...claimPreimage, schema: "claim@2" }), code: "unsupported-schema" },
    {
      name: "a program claim",
      revision: sealed({ ...claimPreimage, author: { voice: "program", id: "research" } }),
      code: "invalid-author",
    },
    {
      name: "an agent's decision",
      revision: sealed({ ...decisionPreimage, author: { voice: "agent", id: "reader" } }),
      code: "invalid-author",
    },
  ]
}

if (import.meta.main) {
  const { Basis } = await import("../../src/basis")
  const { Graph } = await import("../../src/graph")
  const graph = Graph.make(PROJECT, entries)
  const membership = Basis.claim(graph, { selected: [claim], asOfSeq: 10 })
  add(
    "snapshot",
    11,
    base(
      "snapshot",
      "snapshot-1",
      program,
      { ...inSession("call-export", researcher), session: "session-research" },
      {
        basisRule: "claim-basis@1",
        output: answer,
        selected: [claim],
        asOfSeq: 10,
        members: { basis: membership.basis, closureCount: membership.members.length },
      },
    ),
  )
  const bytes = encoder.encode(TEXT)
  const multibyte = "façade naïveté ✓"
  const start = encoder.encode(TEXT.slice(0, TEXT.indexOf(multibyte))).length
  const end = start + encoder.encode(multibyte).length
  if (Buffer.from(bytes.subarray(start, end)).toString("utf8") !== multibyte) throw new Error("bad multibyte offsets")
  const textDigest = Canonical.blobDigest(bytes)
  const fragmentCase = (name: string, selector: unknown, result: string, text = TEXT) => ({
    name,
    text,
    representationDigest: textDigest,
    selector,
    result,
  })
  const file = {
    description:
      "Frozen research-record@1 identities. Each revision's id must equal the canonical digest of its other eight fields, in TypeScript (test/vectors.test.ts) and Python (python/tests). Built once by test/vectors/build.ts; never regenerate to make a test pass.",
    projectId: PROJECT,
    revisions: entries.map((entry) => ({ name: entry.name, seq: entry.seq, revision: entry.revision })),
    fragments: [
      fragmentCase("the cited quote", { profile: "utf8-bytes@1", start: 0, end: 34, quote }, "ok"),
      fragmentCase("a multibyte quote", { profile: "utf8-bytes@1", start, end, quote: multibyte }, "ok"),
      fragmentCase("one byte off", { profile: "utf8-bytes@1", start: 1, end: 35, quote }, "selector-mismatch"),
      fragmentCase(
        "inside a code point",
        { profile: "utf8-bytes@1", start: start + 3, end: start + 4, quote: "a" },
        "selector-mismatch",
      ),
      fragmentCase(
        "a normalized quote is not the stored bytes",
        { profile: "utf8-bytes@1", start, end, quote: "facade naivete ✓" },
        "selector-mismatch",
      ),
      fragmentCase("the wrong text", { profile: "utf8-bytes@1", start: 0, end: 34, quote }, "digest-mismatch", TEXT_2),
      fragmentCase("another profile", { profile: "utf16@1", start: 0, end: 34, quote }, "selector-mismatch"),
      fragmentCase("a negative offset", { profile: "utf8-bytes@1", start: -1, end: 34, quote }, "selector-mismatch"),
      fragmentCase("a fractional offset", { profile: "utf8-bytes@1", start: 0, end: 33.5, quote }, "selector-mismatch"),
      fragmentCase(
        "a lone surrogate in the quote",
        { profile: "utf8-bytes@1", start: 0, end: 3, quote: "\ud800" },
        "selector-mismatch",
      ),
      fragmentCase(
        "an extra selector field",
        { profile: "utf8-bytes@1", start: 0, end: 34, quote, page: 1 },
        "selector-mismatch",
      ),
    ],
    refusals: refusals(),
    skills: [
      {
        name: "one file",
        files: { "SKILL.md": "# search-strategy\n" },
        digest: ResearchRecord.skillDigest({ "SKILL.md": encoder.encode("# search-strategy\n") }),
      },
      {
        name: "two files",
        files: { "SKILL.md": "# read-and-quote\n", "examples.md": "example\n" },
        digest: ResearchRecord.skillDigest({
          "SKILL.md": encoder.encode("# read-and-quote\n"),
          "examples.md": encoder.encode("example\n"),
        }),
      },
    ],
  }
  await Bun.write(new URL("./revisions.json", import.meta.url), JSON.stringify(file, null, 2) + "\n")
  console.log(
    `${file.revisions.length} revisions, ${file.fragments.length} fragment cases, ${file.refusals.length} refusals, ${file.skills.length} skills`,
  )
}
