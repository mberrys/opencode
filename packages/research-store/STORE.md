# `research-store`

The research record on disk: content-addressed blobs and a hash-chained commit log, in `.research/` beside the project and apart from OpenCode's session database. It stores `research-record@1` revisions and enforces every contract rule on commit; `verify` checks everything again without trusting the store.

## Layout

```text
.research/
  record.db              SQLite (WAL, synchronous=FULL): meta, commits, revisions, blob_refs
  blobs/sha256/ab/cd/<64 hex>
  staging/<pid>-<random>.tmp
```

## Blobs

`admit(bytes)` returns `{ digest, existed }`. The bytes are written to a staged file, flushed, hashed, and only then hard-linked to their name, so a name always holds complete bytes. Where the filesystem has no hard links (FAT, exFAT, some network shares), the checked staged file is renamed into place instead. Identical bytes are stored once. A name that holds other bytes is never overwritten. Admission happens outside any transaction; bytes no commit references stay unreadable (`blob-unreferenced`).

On open, staged files of dead processes, or older than a day, are removed, including ones named with the opening process's own pid, which a restart under the same pid can leave; a file that vanishes or is held open meanwhile is left alone. Nothing deletes blobs yet: there is no garbage collection.

## Commits

`commit({ key?, revisions })` writes one or more revisions together, or nothing:

1. Each revision is parsed, its id checked against its content, and its project checked.
2. Every blob the revisions need (`ResearchRecord.blobs`) must be admitted and intact; every fragment's quote must equal its stored text. Hashing happens here, before the write lock.
3. Under `BEGIN IMMEDIATE`: revisions already committed together return their commit with `replayed: true`, whatever key the retry carries, in any order and even if only some are resent; new revisions under a key already used are refused with `idempotency-conflict`, naming the commit the key made. Then `Graph.make` over the whole record plus the new revisions enforces every contract rule, and the rows are written.

A refusal writes nothing and takes no sequence number. Concurrent writers, in one process or several, queue on SQLite's lock; one held past the busy timeout is refused with `writer-busy`.

Each commit's digest is chained:

```text
genesis = digest({ chain: "research-commit@1", projectId })
request = digest([revisionId, ...])                       in commit order
digest  = digest({ chain: "research-commit@1", seq, prev, key, request })   key is null when absent
```

Revision content is covered through the ids. `blob_refs` is an index derived from the revisions, not part of the chain.

## Reads

`get(ref)` resolves any revision the record holds, old ones included; nothing updates or deletes a revision. `latest(objectId)`, `graph()`, `readBlob(digest)` and `copiesOf(digest)` (the copy objects holding some bytes, with their sources) complete the reader. `openReadOnly` opens a record without creating its schema, sweeping or taking the write lock; SQLite still creates the `-wal` and `-shm` files beside the database. Rows that no longer parse or break the contract are reported as `store-corrupt`, never as the caller's error.

## Verify

`verify()` runs in one read transaction and returns `{ ok, headSeq, headDigest, problems }`. It reports each problem at the item it concerns:

| Check                                                            | Reasons                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The chain from genesis                                           | `seq-gap`, `prev-mismatch`, `digest-mismatch`, `request-mismatch`, `malformed-commit` |
| Revisions against content and commits, both ways                 | `revision-invalid`, `revision-missing`, `revision-unlisted`, `revision-misplaced`     |
| The blob index and every needed blob                             | `blob-refs-mismatch`, `blob-missing`, `blob-corrupt`, `size-mismatch`                 |
| Every contract rule, located at the first commit that breaks one | `history-invalid`                                                                     |
| Every fragment's quote against its stored text                   | `fragment-mismatch`                                                                   |

Each blob is read once, so one that changes or vanishes while verify runs is reported, not thrown. Quotes are checked even when a contract rule breaks elsewhere; only the check that a fragment's representation names its digest needs the whole history to hold.

Deleting the newest commits leaves a valid record; only `headDigest` shows it, so it is what an outside reader pins.

## Not yet

- Export as JSON lines plus blobs, for a reader with neither OpenCode nor SQLite (layer 3).
- Garbage collection of unreferenced blobs, and change notices for a UI.
- How skill files stay reachable: a skill pin digests a file map that no revision names.
- Scale: each commit rebuilds the graph over the whole record, O(N); `busy_timeout` blocks the caller's thread while it waits. The 1.5 gate measures both.
