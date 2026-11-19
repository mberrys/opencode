import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Canonical, ResearchRecord } from "@opencode/research-record"
import fs from "node:fs"
import path from "node:path"
import { Chain } from "../src/chain.js"
import { Layout } from "../src/layout.js"
import { Store } from "../src/store.js"
import {
  PROJECT,
  acquired,
  claim,
  cleanup,
  encoder,
  extracted,
  open,
  project,
  quoted,
  refusal,
  track,
} from "./fixture.js"

afterEach(cleanup)
// Every admission and commit flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)

const TEXT = encoder.encode("Union density fell from 35% to 11% — façade naïveté ✓.")

describe("opening", () => {
  test("creates the record in .research/ beside the project, empty", () => {
    const directory = project()
    const store = open(directory)
    expect(fs.existsSync(path.join(directory, ".research", "record.db"))).toBe(true)
    expect(store.head()).toBeUndefined()
    expect(store.verify()).toEqual({ ok: true, headSeq: 0, headDigest: Chain.genesis(PROJECT), problems: [] })
    store.close()
  })

  test("refuses a record that belongs to another project", () => {
    const directory = project()
    open(directory).close()
    expect(refusal(() => Store.open(directory, { projectId: "project-2" })).code).toBe("store-mismatch")
  })

  test("refuses to read a directory with no record", () => {
    expect(refusal(() => Store.openReadOnly(project())).code).toBe("store-mismatch")
  })

  test("refuses use after close", () => {
    const store = open()
    store.close()
    expect(refusal(() => store.head()).code).toBe("store-closed")
  })
})

describe("commits", () => {
  test("are numbered from 1 and chained from the project's genesis", () => {
    const store = open()
    const first = store.commit({ revisions: [claim("claim-1", "Union density fell.")] })
    const second = store.commit({ revisions: [claim("claim-2", "Wage inequality rose.")] })
    expect([first.seq, second.seq]).toEqual([1, 2])
    expect(first.digest).toBe(
      Chain.digest({
        seq: 1,
        prev: Chain.genesis(PROJECT),
        key: null,
        request: Chain.request([first.revisions[0].revisionId]),
      }),
    )
    expect(store.head()).toEqual({ seq: 2, digest: second.digest })
    expect(store.verify().ok).toBe(true)
  })

  test("write every revision of a commit together, in order", () => {
    const store = open()
    const bytes = encoder.encode("%PDF-1.7 one")
    store.admit(bytes)
    const { source, copy } = acquired("one", bytes)
    const committed = store.commit({ revisions: [source, copy] })
    expect(committed.revisions).toEqual([ResearchRecord.refOf(source), ResearchRecord.refOf(copy)])
    expect(store.graph().entries.map((entry) => entry.seq)).toEqual([1, 1])
  })

  test("bind the genesis to the project, so the same request chains differently in another project", () => {
    expect(Chain.genesis("project-1")).not.toBe(Chain.genesis("project-2"))
  })

  test("are refused, and consume no sequence number, when a contract rule breaks", () => {
    const store = open()
    const original = claim("claim-1", "Union density fell.")
    const orphan = claim(
      "claim-1",
      "A correction of a revision the record does not hold.",
      claim("claim-1", "never committed"),
    )
    expect(refusal(() => store.commit({ revisions: [orphan] })).code).toBe("invalid-history")
    expect(store.commit({ revisions: [original] }).seq).toBe(1)
  })

  test("are refused when a revision names a blob that was never admitted", () => {
    const store = open()
    const { source, copy } = acquired("missing", encoder.encode("never admitted"))
    expect(refusal(() => store.commit({ revisions: [source, copy] })).code).toBe("blob-missing")
    expect(store.head()).toBeUndefined()
  })

  test("are refused when a revision's id does not match its content", () => {
    const store = open()
    const forged = {
      ...claim("claim-1", "Union density fell."),
      body: { text: "Edited.", scope: "", addresses: "none" },
    }
    expect(refusal(() => store.commit({ revisions: [forged] })).code).toBe("digest-mismatch")
  })

  test("are refused when a revision belongs to another project", () => {
    const store = track(Store.open(project(), { projectId: "project-2" }))
    expect(refusal(() => store.commit({ revisions: [claim("claim-1", "Union density fell.")] })).code).toBe(
      "cross-project-ref",
    )
  })

  test("refuse an empty commit and a blank key", () => {
    const store = open()
    expect(refusal(() => store.commit({ revisions: [] })).code).toBe("invalid-argument")
    expect(refusal(() => store.commit({ key: " ", revisions: [claim("c", "t")] })).code).toBe("invalid-argument")
    expect(refusal(() => store.commit({ key: "k".repeat(257), revisions: [claim("c", "t")] })).code).toBe(
      "invalid-argument",
    )
  })

  test("refuse a copy whose stated size is not its file's size", () => {
    const store = open()
    const bytes = encoder.encode("%PDF-1.7 sized")
    store.admit(bytes)
    const { source, copy } = acquired("sized", bytes)
    const { revisionId: _revisionId, ...preimage } = copy
    const wrong = ResearchRecord.create({ ...preimage, body: { ...copy.body, size: bytes.length + 7 } })
    expect(refusal(() => store.commit({ revisions: [source, wrong] })).code).toBe("size-mismatch")
    expect(store.head()).toBeUndefined()
  })

  test("refuse a fragment whose quote is one byte off the stored text", () => {
    const store = open()
    const pdf = encoder.encode("%PDF-1.7 quoted")
    const tree = encoder.encode("{}")
    ;[pdf, TEXT, tree].forEach((bytes) => store.admit(bytes))
    const { source, copy } = acquired("quoted", pdf)
    const representation = extracted(copy, TEXT, tree)
    store.commit({ revisions: [source, copy, representation] })
    expect(
      refusal(() => store.commit({ revisions: [quoted(representation, TEXT, 0, 13, "Union densitY")] })).code,
    ).toBe("selector-mismatch")
    const exact = store.commit({ revisions: [quoted(representation, TEXT, 0, 13, "Union density")] })
    expect(exact.seq).toBe(2)
    expect(store.verify().ok).toBe(true)
  })
})

describe("retries", () => {
  test("a retry under the same key returns the first commit and writes nothing", () => {
    const store = open()
    const request = { key: "call-1", revisions: [claim("claim-1", "Union density fell.")] }
    const first = store.commit(request)
    expect(store.commit(request)).toEqual({ ...first, replayed: true })
    expect(store.head()?.seq).toBe(1)
  })

  test("a different request under a used key is refused", () => {
    const store = open()
    store.commit({ key: "call-1", revisions: [claim("claim-1", "Union density fell.")] })
    const error = refusal(() => store.commit({ key: "call-1", revisions: [claim("claim-2", "Something else.")] }))
    expect(error.code).toBe("idempotency-conflict")
    expect(error.detail).toEqual({ seq: 1 })
  })

  test("revisions already committed replay under any key, and a key never commits a second request", () => {
    const store = open()
    const first = { revisions: [claim("claim-1", "Union density fell.")] }
    const landed = store.commit(first)
    expect(store.commit({ key: "call-1", ...first })).toEqual({ ...landed, replayed: true })
    const second = store.commit({ key: "call-1", revisions: [claim("claim-2", "Wage inequality rose.")] })
    expect(second.seq).toBe(2)
    expect(store.commit({ key: "call-1", ...first })).toEqual({ ...landed, replayed: true })
    expect(refusal(() => store.commit({ key: "call-1", revisions: [claim("claim-3", "Third.")] })).detail).toEqual({
      seq: 2,
    })
  })

  test("a retry that reorders or resends only some of a commit's revisions replays that commit", () => {
    const store = open()
    const a = claim("claim-1", "Union density fell.")
    const b = claim("claim-2", "Wage inequality rose.")
    const landed = store.commit({ key: "call-1", revisions: [a, b] })
    const head = { seq: landed.seq, digest: landed.digest, replayed: true }
    expect(store.commit({ key: "call-1", revisions: [b, a] })).toEqual({
      ...head,
      revisions: [ResearchRecord.refOf(b), ResearchRecord.refOf(a)],
    })
    expect(store.commit({ revisions: [a] })).toEqual({ ...head, revisions: [ResearchRecord.refOf(a)] })
    expect(store.head()?.seq).toBe(1)
  })

  test("revisions from two commits, or partly committed, are not a retry", () => {
    const store = open()
    const a = claim("claim-1", "Union density fell.")
    const b = claim("claim-2", "Wage inequality rose.")
    store.commit({ revisions: [a] })
    store.commit({ revisions: [b] })
    expect(refusal(() => store.commit({ revisions: [a, b] })).message).toContain("only once")
    expect(refusal(() => store.commit({ revisions: [a, claim("claim-3", "New.")] })).message).toContain("only once")
    expect(store.head()?.seq).toBe(2)
  })

  test("a key that is not well-formed text is refused as an argument", () => {
    const store = open()
    expect(refusal(() => store.commit({ key: "call-\ud800", revisions: [claim("c", "t")] })).code).toBe(
      "invalid-argument",
    )
  })

  test("a retry of identical revisions without a key finds its commit by content", () => {
    const store = open()
    const request = { revisions: [claim("claim-1", "Union density fell.")] }
    const first = store.commit(request)
    store.commit({ revisions: [claim("claim-2", "Wage inequality rose.")] })
    expect(store.commit(request)).toEqual({ ...first, replayed: true })
    expect(store.head()?.seq).toBe(2)
  })

  test("keys survive a reopen", () => {
    const directory = project()
    const request = { key: "call-1", revisions: [claim("claim-1", "Union density fell.")] }
    const original = open(directory)
    const first = original.commit(request)
    original.close()
    const reopened = open(directory)
    expect(reopened.commit(request)).toEqual({ ...first, replayed: true })
    expect(reopened.commit({ revisions: [claim("claim-2", "Wage inequality rose.")] }).seq).toBe(2)
  })
})

describe("nothing overwritten", () => {
  test("changing a claim leaves the old revision resolvable under its old id", () => {
    const store = open()
    const v1 = claim("claim-1", "Union density fell from 35% to 11%.")
    store.commit({ revisions: [v1] })
    const v2 = claim("claim-1", "Union density fell from 35% to 11% between 1979 and 2019.", v1)
    store.commit({ revisions: [v2] })
    expect(store.get(ResearchRecord.refOf(v1))).toEqual(v1)
    expect(store.get(ResearchRecord.refOf(v2))).toEqual(v2)
    expect(store.latest("claim-1")).toEqual(v2)
    expect(
      store
        .graph()
        .heads(2)
        .map((entry) => entry.revision),
    ).toEqual([v2])
    expect(
      store
        .graph()
        .heads(1)
        .map((entry) => entry.revision),
    ).toEqual([v1])
  })

  test("a ref with the right revision id but another object is not resolved", () => {
    const store = open()
    const v1 = claim("claim-1", "Union density fell.")
    store.commit({ revisions: [v1] })
    expect(refusal(() => store.get({ ...ResearchRecord.refOf(v1), objectId: "claim-2" })).code).toBe("unknown-revision")
    expect(refusal(() => store.get({ ...ResearchRecord.refOf(v1), revisionId: "latest" })).code).toBe("invalid-ref")
  })
})

describe("identical bytes", () => {
  test("two admissions of identical bytes resolve to one source", () => {
    const store = open()
    const bytes = encoder.encode("%PDF-1.7 the same paper")
    const first = store.admit(bytes)
    expect(first.existed).toBe(false)
    const { source, copy } = acquired("paper", bytes)
    store.commit({ revisions: [source, copy] })

    const second = store.admit(new Uint8Array(bytes))
    expect(second).toEqual({ digest: first.digest, existed: true })
    expect(fs.readdirSync(path.dirname(Layout.blobPath(store.layout, first.digest)))).toHaveLength(1)
    expect(store.copiesOf(second.digest)).toEqual([
      { copy: ResearchRecord.refOf(copy), source: ResearchRecord.refOf(source) },
    ])
  })

  test("bytes no copy holds have no copies", () => {
    const store = open()
    expect(store.copiesOf(store.admit(encoder.encode("loose bytes")).digest)).toEqual([])
  })
})

describe("reading blobs", () => {
  test("returns a referenced blob's bytes", () => {
    const store = open()
    const bytes = encoder.encode("%PDF-1.7 read")
    store.admit(bytes)
    store.commit({ revisions: Object.values(acquired("read", bytes)) })
    expect(store.readBlob(Canonical.blobDigest(bytes))).toEqual(bytes)
  })

  test("refuses bytes no commit references, such as an admission that never committed", () => {
    const store = open()
    const { digest } = store.admit(encoder.encode("admitted, never committed"))
    expect(refusal(() => store.readBlob(digest)).code).toBe("blob-unreferenced")
  })

  test("refuses a referenced blob with one flipped byte", () => {
    const store = open()
    const bytes = encoder.encode("%PDF-1.7 flipped")
    store.admit(bytes)
    store.commit({ revisions: Object.values(acquired("flipped", bytes)) })
    const file = Layout.blobPath(store.layout, Canonical.blobDigest(bytes))
    const stored = fs.readFileSync(file)
    stored[3] ^= 0x01
    fs.writeFileSync(file, stored)
    expect(refusal(() => store.readBlob(Canonical.blobDigest(bytes))).code).toBe("blob-corrupt")
  })
})

describe("damage the caller did not cause", () => {
  test("a stored revision that no longer parses is reported as a corrupt record", () => {
    const directory = project()
    const store = open(directory)
    const v1 = claim("claim-1", "Union density fell.")
    store.commit({ revisions: [v1] })
    store.close()
    const raw = new Database(Layout.of(directory).database)
    raw
      .query("UPDATE revisions SET json = ? WHERE revision_id = ?")
      .run(JSON.stringify({ ...v1, body: { ...v1.body, text: "Edited in place." } }), v1.revisionId)
    raw.close()
    const reopened = open(directory)
    expect(refusal(() => reopened.get(ResearchRecord.refOf(v1))).code).toBe("store-corrupt")
    expect(refusal(() => reopened.latest("claim-1")).code).toBe("store-corrupt")
    expect(refusal(() => reopened.commit({ revisions: [claim("claim-2", "Unrelated.")] })).code).toBe("store-corrupt")
  })

  test("a file that is not a database is not a record", () => {
    const directory = project()
    fs.mkdirSync(Layout.of(directory).root)
    fs.writeFileSync(Layout.of(directory).database, "not a database at all, just some text that is long enough")
    expect(refusal(() => open(directory)).code).toBe("store-mismatch")
    expect(refusal(() => Store.openReadOnly(directory)).code).toBe("store-mismatch")
  })

  test("a directory under a blob's name is refused as corrupt when read", () => {
    const store = open()
    const bytes = encoder.encode("%PDF-1.7 replaced by a directory")
    store.admit(bytes)
    store.commit({ revisions: Object.values(acquired("directory", bytes)) })
    const file = Layout.blobPath(store.layout, Canonical.blobDigest(bytes))
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(refusal(() => store.readBlob(Canonical.blobDigest(bytes))).code).toBe("blob-corrupt")
  })

  test("an invalid project id is refused as an argument", () => {
    expect(refusal(() => Store.open(project(), { projectId: "latest" })).code).toBe("invalid-argument")
  })
})

describe("readers and writers", () => {
  test("a read-only reader sees the record and verifies it", () => {
    const directory = project()
    const store = open(directory)
    store.commit({ revisions: [claim("claim-1", "Union density fell.")] })
    const reader = track(Store.openReadOnly(directory))
    expect(reader.head()).toEqual(store.head())
    expect(reader.verify().ok).toBe(true)
    expect("commit" in reader).toBe(false)
    reader.close()
  })

  test("a commit sees another writer's commits", () => {
    const directory = project()
    const a = open(directory)
    const b = open(directory)
    const v1 = claim("claim-1", "Union density fell.")
    a.commit({ revisions: [v1] })
    expect(b.commit({ revisions: [claim("claim-1", "Corrected.", v1)] }).seq).toBe(2)
    expect(a.latest("claim-1")?.body).toEqual({
      text: "Corrected.",
      scope: "United States, 1979-2019",
      addresses: "none",
    })
    expect(refusal(() => a.commit({ revisions: [claim("claim-1", "A stale correction.", v1)] })).code).toBe(
      "invalid-history",
    )
  })

  test("a writer held past the busy timeout is refused, and the commit takes no sequence number", () => {
    const directory = project()
    const store = open(directory, { busyTimeoutMs: 50 })
    const holder = new Database(Layout.of(directory).database)
    holder.run("BEGIN IMMEDIATE")
    expect(refusal(() => store.commit({ revisions: [claim("claim-1", "Union density fell.")] })).code).toBe(
      "writer-busy",
    )
    holder.run("ROLLBACK")
    holder.close()
    expect(store.commit({ revisions: [claim("claim-1", "Union density fell.")] }).seq).toBe(1)
  })

  test("stored revisions that break the contract are reported as a corrupt record, not as the caller's fault", () => {
    const directory = project()
    const store = open(directory)
    const bytes = encoder.encode("%PDF-1.7 corrupt")
    store.admit(bytes)
    const { source, copy } = acquired("corrupt", bytes)
    store.commit({ revisions: [source, copy] })
    store.close()
    const raw = new Database(Layout.of(directory).database)
    raw.query("DELETE FROM revisions WHERE revision_id = ?").run(source.revisionId)
    raw.close()
    expect(refusal(() => open(directory).commit({ revisions: [claim("claim-1", "Anything.")] })).code).toBe(
      "store-corrupt",
    )
  })
})
