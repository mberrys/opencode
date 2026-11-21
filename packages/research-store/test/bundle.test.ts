import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Canonical, ResearchRecord } from "@opencode/research-record"
import fs from "node:fs"
import path from "node:path"
import { blobsOf, canonical, digest, revisionId, verifyBundle, verifyFragment } from "../src/bundle/verify.mjs"
import { acquired, claim, cleanup, encoder, extracted, open, project, quoted, refusal } from "./fixture.js"

afterEach(cleanup)
// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const PDF = encoder.encode("%PDF-1.7 exported paper")
const TEXT = encoder.encode("Union density fell from 35% to 11% between 1979 and 2019.")
const TREE = encoder.encode('{"sections":[]}')

/** Four commits: a source with its copy, its text, a quote and a claim, exported to a new directory. */
function exported() {
  const store = open()
  ;[PDF, TEXT, TREE].forEach((bytes) => store.admit(bytes))
  const { source, copy } = acquired("paper", PDF)
  const representation = extracted(copy, TEXT, TREE)
  const fragment = quoted(representation, TEXT, 0, 13, "Union density")
  ;[[source, copy], [representation], [fragment], [claim("claim-1", "Union density fell.")]].forEach((revisions) =>
    store.commit({ key: `call-${revisions[0].objectId}`, revisions }),
  )
  const directory = path.join(project(), "bundle")
  return { store, directory, fragment, result: store.exportTo(directory) }
}

const reasons = (directory: string) =>
  (verifyBundle(directory).problems as { reason: string; seq?: number }[]).map((problem) => ({
    reason: problem.reason,
    seq: problem.seq,
  }))

const lines = (directory: string) =>
  fs
    .readFileSync(path.join(directory, "log.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))

const rewrite = (directory: string, commits: unknown[]) =>
  fs.writeFileSync(path.join(directory, "log.jsonl"), commits.map((commit) => `${JSON.stringify(commit)}\n`).join(""))

describe("an exported record", () => {
  test("holds the log, every cited file, a manifest naming the head, and the verifier", () => {
    const record = exported()
    const head = record.store.head()!
    expect(record.result).toMatchObject({ headSeq: 4, headDigest: head.digest, commits: 4, blobs: 3 })
    expect(record.result.verified.ok).toBe(true)
    expect(fs.readdirSync(record.directory).toSorted()).toEqual(
      ["README.txt", "blobs", "log.jsonl", "manifest.json", "verify.mjs"].toSorted(),
    )
    expect(JSON.parse(fs.readFileSync(path.join(record.directory, "manifest.json"), "utf8"))).toEqual({
      format: "research-bundle@1",
      contract: "research-record@1",
      projectId: record.store.projectId,
      headSeq: 4,
      headDigest: head.digest,
    })
    expect(verifyBundle(record.directory)).toEqual({ ok: true, headSeq: 4, headDigest: head.digest, problems: [] })
  })

  test("verifies under Node alone, run from inside the bundle", () => {
    const record = exported()
    const run = Bun.spawnSync(["node", "verify.mjs", "--json"], { cwd: record.directory })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toMatchObject({ ok: true, headSeq: 4 })
  })

  test("is written only to a new or empty directory", () => {
    const record = exported()
    expect(refusal(() => record.store.exportTo(record.directory)).code).toBe("invalid-argument")
  })

  test("of an empty record names the genesis as its head", () => {
    const store = open()
    const directory = path.join(project(), "bundle")
    expect(store.exportTo(directory)).toMatchObject({ headSeq: 0, commits: 0, blobs: 0 })
    expect(verifyBundle(directory)).toMatchObject({ ok: true, headSeq: 0 })
  })
})

describe("a tampered bundle", () => {
  test("a flipped byte in a file is reported at the blob", () => {
    const record = exported()
    const file = path.join(record.directory, "blobs", Canonical.blobDigest(PDF).slice("sha256:".length))
    const bytes = fs.readFileSync(file)
    bytes[3] ^= 0x01
    fs.writeFileSync(file, bytes)
    expect(reasons(record.directory)).toEqual([{ reason: "blob-corrupt", seq: 1 }])
  })

  test("a deleted file is reported missing", () => {
    const record = exported()
    fs.rmSync(path.join(record.directory, "blobs", Canonical.blobDigest(TREE).slice("sha256:".length)))
    expect(reasons(record.directory)).toEqual([{ reason: "blob-missing", seq: 2 }])
  })

  test("an edited body under its old id is reported at its revision", () => {
    const record = exported()
    const commits = lines(record.directory)
    commits[3].revisions[0].body.text = "Union density rose."
    rewrite(record.directory, commits)
    expect(reasons(record.directory)).toEqual([{ reason: "revision-invalid", seq: 4 }])
  })

  test("a quote rewritten with a fresh id is reported at the fragment and breaks the chain", () => {
    const record = exported()
    const { revisionId: _revisionId, ...preimage } = record.fragment
    const body = record.fragment.body as ResearchRecord.Body<"fragment">
    const rewritten = ResearchRecord.create({
      ...preimage,
      body: { ...body, selector: { ...body.selector, quote: "Union densitY" } },
    })
    const commits = lines(record.directory)
    commits[2].revisions = [rewritten]
    rewrite(record.directory, commits)
    expect(reasons(record.directory)).toEqual([
      { reason: "request-mismatch", seq: 3 },
      { reason: "fragment-mismatch", seq: 3 },
    ])
  })

  test("a removed newest commit leaves a chain that no longer ends at the manifest's head", () => {
    const record = exported()
    rewrite(record.directory, lines(record.directory).slice(0, 3))
    expect(reasons(record.directory)).toEqual([{ reason: "head-mismatch", seq: 3 }])
  })

  test("a removed middle commit leaves a gap and a broken link", () => {
    const record = exported()
    const commits = lines(record.directory)
    rewrite(record.directory, [...commits.slice(0, 1), ...commits.slice(2)])
    expect(reasons(record.directory)).toEqual([
      { reason: "seq-gap", seq: 3 },
      { reason: "prev-mismatch", seq: 3 },
    ])
  })

  test("a missing manifest is refused before anything else is read", () => {
    const record = exported()
    fs.rmSync(path.join(record.directory, "manifest.json"))
    expect(reasons(record.directory)).toEqual([{ reason: "manifest-invalid", seq: undefined }])
  })

  test("the verifier exits non-zero and names the problem", () => {
    const record = exported()
    fs.rmSync(path.join(record.directory, "blobs", Canonical.blobDigest(TREE).slice("sha256:".length)))
    const run = Bun.spawnSync(["node", path.join(record.directory, "verify.mjs"), record.directory])
    expect(run.exitCode).toBe(1)
    expect(run.stdout.toString()).toContain("blob-missing at commit 2")
  })
})

// The verifier is written apart from research-record, so it is held to the same frozen vectors as the Python one.
describe("the verifier against research-record's frozen vectors", () => {
  const vectors = path.join(import.meta.dir, "..", "..", "research-record", "test", "vectors")
  const canonicalVectors = JSON.parse(fs.readFileSync(path.join(vectors, "canonical-json.json"), "utf8"))
  const revisionVectors = JSON.parse(fs.readFileSync(path.join(vectors, "revisions.json"), "utf8"))
  const code = (run: () => unknown) => {
    try {
      run()
      return "ok"
    } catch (error) {
      return (error as { code?: string }).code
    }
  }
  const double = (bits: string) => new DataView(Uint8Array.from(Buffer.from(bits, "hex")).buffer).getFloat64(0)

  test("canonical JSON and its digests", () => {
    canonicalVectors.valid.forEach((vector: { json: string; canonical: string; digest: string }) => {
      expect(canonical(JSON.parse(vector.json))).toBe(vector.canonical)
      expect(digest(JSON.parse(vector.json))).toBe(vector.digest)
    })
    canonicalVectors.invalid.forEach((vector: { json: string; code: string }) =>
      expect(code(() => canonical(JSON.parse(vector.json)))).toBe(vector.code),
    )
    canonicalVectors.numbers.forEach((vector: { bits: string; canonical: string }) =>
      expect(canonical(double(vector.bits))).toBe(vector.canonical),
    )
    canonicalVectors.invalidNumbers.forEach((vector: { bits: string; code: string }) =>
      expect(code(() => canonical(double(vector.bits)))).toBe(vector.code),
    )
  })

  test("revision ids, refusals, and the files each revision needs", () => {
    revisionVectors.revisions.forEach((vector: { revision: ResearchRecord.Revision }) => {
      expect(revisionId(vector.revision)).toBe(vector.revision.revisionId)
      expect(blobsOf(vector.revision).toSorted()).toEqual(
        [...new Set(ResearchRecord.blobs(vector.revision))].toSorted(),
      )
    })
    revisionVectors.refusals.forEach((vector: { revision: unknown; code: string }) =>
      expect(code(() => revisionId(vector.revision))).toBe(vector.code),
    )
  })

  test("quotes", () => {
    revisionVectors.fragments.forEach(
      (vector: { text: string; representationDigest: string; selector: unknown; result: string }) =>
        expect(
          code(() => verifyFragment(vector.representationDigest, vector.selector, encoder.encode(vector.text))),
        ).toBe(vector.result),
    )
  })
})
