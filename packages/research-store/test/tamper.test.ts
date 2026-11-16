import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Canonical, ResearchRecord } from "@opencode/research-record"
import fs from "node:fs"
import { Layout } from "../src/layout.js"
import { Store } from "../src/store.js"
import { Verify } from "../src/verify.js"
import { acquired, claim, cleanup, encoder, extracted, open, project, quoted, track } from "./fixture.js"

// Ported from Ivory's commit-chain and verify tests: each kind of damage is reported at the item it hits, and a
// damaged commit does not blame the commits after it.

afterEach(cleanup)
// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const PDF = encoder.encode("%PDF-1.7 tampered paper")
const TEXT = encoder.encode("Union density fell from 35% to 11% between 1979 and 2019.")
const TREE = encoder.encode('{"sections":[]}')

/** Five commits: a source with its copy, its text, a quote, and a claim corrected once. */
function recorded() {
  const directory = project()
  const store = open(directory)
  ;[PDF, TEXT, TREE].forEach((bytes) => store.admit(bytes))
  const { source, copy } = acquired("paper", PDF)
  const representation = extracted(copy, TEXT, TREE)
  const fragment = quoted(representation, TEXT, 0, 13, "Union density")
  const v1 = claim("claim-1", "Union density fell.")
  const v2 = claim("claim-1", "Union density fell from 35% to 11%.", v1)
  ;[[source, copy], [representation], [fragment], [v1], [v2]].forEach((revisions) => store.commit({ revisions }))
  const before = store.verify()
  expect(before.ok).toBe(true)
  store.close()
  return { directory, layout: Layout.of(directory), source, copy, representation, fragment, v1, v2, before }
}

function tamper(directory: string, statements: (db: Database) => void) {
  const db = new Database(Layout.of(directory).database)
  statements(db)
  db.close()
}

function verify(directory: string) {
  return track(Store.openReadOnly(directory)).verify()
}

const reasons = (verification: Verify.Verification) =>
  verification.problems.map((problem) => ({ reason: problem.reason, seq: problem.seq }))

describe("a tampered commit row", () => {
  test("an edited request digest is reported at its row", () => {
    const record = recorded()
    tamper(record.directory, (db) =>
      db.run(`UPDATE commits SET request = '${Canonical.digest(["forged"])}' WHERE seq = 3`),
    )
    expect(reasons(verify(record.directory))).toEqual([
      { reason: "request-mismatch", seq: 3 },
      { reason: "digest-mismatch", seq: 3 },
    ])
  })

  test("a broken prev link is reported at its row, and not at the rows after it", () => {
    const record = recorded()
    tamper(record.directory, (db) => db.run(`UPDATE commits SET prev = '${Canonical.digest("forged")}' WHERE seq = 2`))
    expect(reasons(verify(record.directory))).toEqual([
      { reason: "prev-mismatch", seq: 2 },
      { reason: "digest-mismatch", seq: 2 },
    ])
  })

  test("a rewritten digest is caught by its own row and by the link of the next one", () => {
    const record = recorded()
    tamper(record.directory, (db) =>
      db.run(`UPDATE commits SET digest = '${Canonical.digest("forged")}' WHERE seq = 2`),
    )
    expect(reasons(verify(record.directory))).toEqual([
      { reason: "digest-mismatch", seq: 2 },
      { reason: "prev-mismatch", seq: 3 },
    ])
  })

  test("a removed commit leaves a gap and revisions no commit lists", () => {
    const record = recorded()
    tamper(record.directory, (db) => db.run("DELETE FROM commits WHERE seq = 4"))
    expect(reasons(verify(record.directory))).toEqual([
      { reason: "seq-gap", seq: 5 },
      { reason: "prev-mismatch", seq: 5 },
      { reason: "revision-unlisted", seq: 4 },
      { reason: "history-invalid", seq: 5 },
    ])
  })

  test("removing the newest commits leaves a valid record with another head digest", () => {
    const record = recorded()
    tamper(record.directory, (db) => {
      db.run("DELETE FROM commits WHERE seq = 5")
      db.run("DELETE FROM revisions WHERE seq = 5")
    })
    const after = verify(record.directory)
    expect(after.ok).toBe(true)
    expect(after.headSeq).toBe(4)
    expect(after.headDigest).not.toBe(record.before.headDigest)
  })

  test("a record moved to another project breaks the chain at its first commit", () => {
    const record = recorded()
    tamper(record.directory, (db) => db.run("UPDATE meta SET value = 'project-2' WHERE key = 'project_id'"))
    expect(reasons(verify(record.directory))[0]).toEqual({ reason: "prev-mismatch", seq: 1 })
  })
})

describe("a tampered revision", () => {
  test("an edited body is reported at its commit", () => {
    const record = recorded()
    const forged = { ...record.v1, body: { ...record.v1.body, text: "Union density rose." } }
    tamper(record.directory, (db) =>
      db.query("UPDATE revisions SET json = ? WHERE revision_id = ?").run(JSON.stringify(forged), record.v1.revisionId),
    )
    const problems = verify(record.directory).problems
    expect(problems[0]).toEqual({ reason: "revision-invalid", seq: 4, revisionId: record.v1.revisionId })
  })

  test("a revision swapped in that no commit lists is reported", () => {
    const record = recorded()
    const intruder = claim("claim-9", "Inserted after the fact.")
    tamper(record.directory, (db) =>
      db
        .query("INSERT INTO revisions(revision_id, seq, object_id, kind, json) VALUES (?, 4, ?, 'claim', ?)")
        .run(intruder.revisionId, intruder.objectId, Canonical.json(intruder)),
    )
    expect(verify(record.directory).problems).toEqual([
      { reason: "revision-unlisted", seq: 4, revisionId: intruder.revisionId },
    ])
  })

  test("a deleted revision is reported as missing from the commit that lists it", () => {
    const record = recorded()
    tamper(record.directory, (db) => db.query("DELETE FROM revisions WHERE revision_id = ?").run(record.v2.revisionId))
    expect(verify(record.directory).problems).toEqual([
      { reason: "revision-missing", seq: 5, revisionId: record.v2.revisionId },
    ])
  })

  test("a revision moved to another commit is reported", () => {
    const record = recorded()
    tamper(record.directory, (db) =>
      db.query("UPDATE revisions SET seq = 5 WHERE revision_id = ?").run(record.v1.revisionId),
    )
    expect(reasons(verify(record.directory))).toEqual([
      { reason: "revision-misplaced", seq: 5 },
      { reason: "history-invalid", seq: 5 },
    ])
  })
})

describe("a tampered blob", () => {
  test("one flipped byte in a stored file is reported at the blob", () => {
    const record = recorded()
    const file = Layout.blobPath(record.layout, Canonical.blobDigest(PDF))
    const bytes = fs.readFileSync(file)
    bytes[5] ^= 0x01
    fs.writeFileSync(file, bytes)
    expect(verify(record.directory).problems).toEqual([
      { reason: "blob-corrupt", seq: 1, digest: Canonical.blobDigest(PDF) },
    ])
  })

  test("a deleted file is reported missing", () => {
    const record = recorded()
    fs.rmSync(Layout.blobPath(record.layout, Canonical.blobDigest(TREE)))
    expect(verify(record.directory).problems).toEqual([
      { reason: "blob-missing", seq: 2, digest: Canonical.blobDigest(TREE) },
    ])
  })

  test("a damaged text is reported at the blob; quotes on bytes that do not verify are not rechecked", () => {
    const record = recorded()
    const file = Layout.blobPath(record.layout, Canonical.blobDigest(TEXT))
    fs.writeFileSync(file, "Union density rose from 35% to 11% between 1979 and 2019.")
    expect(reasons(verify(record.directory))).toEqual([{ reason: "blob-corrupt", seq: 2 }])
  })

  test("a removed blob index row is reported", () => {
    const record = recorded()
    tamper(record.directory, (db) => db.query("DELETE FROM blob_refs WHERE digest = ?").run(Canonical.blobDigest(TREE)))
    expect(verify(record.directory).problems).toEqual([
      { reason: "blob-refs-mismatch", seq: 2, digest: Canonical.blobDigest(TREE) },
    ])
  })

  test("a quote rewritten so it no longer matches its text is reported at its fragment", () => {
    const record = recorded()
    const { revisionId: _revisionId, ...preimage } = record.fragment
    const body = record.fragment.body as ResearchRecord.Body<"fragment">
    const rewritten = ResearchRecord.create({
      ...preimage,
      body: { ...body, selector: { ...body.selector, quote: "Union densitY" } },
    })
    tamper(record.directory, (db) => {
      db.query("UPDATE revisions SET revision_id = ?, json = ? WHERE revision_id = ?").run(
        rewritten.revisionId,
        Canonical.json(rewritten),
        record.fragment.revisionId,
      )
      db.query("UPDATE commits SET revisions = ? WHERE seq = 3").run(JSON.stringify([rewritten.revisionId]))
    })
    const found = verify(record.directory).problems
    expect(found).toContainEqual(expect.objectContaining({ reason: "fragment-mismatch", seq: 3 }))
    expect(found).toContainEqual({ reason: "request-mismatch", seq: 3 })
  })

  test("a copy whose stated size is not its file's size is reported", () => {
    const record = recorded()
    const resized = ResearchRecord.create({
      ...Object.fromEntries(Object.entries(record.copy).filter(([field]) => field !== "revisionId")),
      body: { ...record.copy.body, size: PDF.length + 1 },
    })
    tamper(record.directory, (db) => {
      db.query("UPDATE revisions SET revision_id = ?, json = ? WHERE revision_id = ?").run(
        resized.revisionId,
        Canonical.json(resized),
        record.copy.revisionId,
      )
      const ids = [record.source.revisionId, resized.revisionId]
      db.query("UPDATE commits SET revisions = ? WHERE seq = 1").run(JSON.stringify(ids))
    })
    expect(reasons(verify(record.directory))).toContainEqual({ reason: "size-mismatch", seq: 1 })
  })
})
