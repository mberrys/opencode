# `research-record@1`

The research record's wire contract. Pure: no I/O, no OpenCode imports. The store (`research-store`) persists it; `verify`, `replay` and `export` read it without a model or OpenCode.

Sources: the foundation's Provenance section (record kinds, three voices, tiers), Ivory's `ivory-research@1` (hash method, exact refs, fragments, claim basis), and the 1.1 lens decision (board issue #6).

## Identity

Kept from Ivory unchanged.

- `canonicalJson`: RFC 8785. Refuses non-I-JSON input (lone surrogates, non-finite numbers, class instances, cycles, holes).
- `digest(value)`: `sha256:` + 64 lowercase hex over the UTF-8 bytes of the canonical JSON.
- `blobDigest(bytes)`: the same spelling over raw bytes. Byte identity and JSON identity are never mixed.
- `ExactRef`: exactly `{ projectId, objectId, revisionId }`, each a non-blank string of at most 256 characters other than `latest`. A bare object id or `latest` is never a ref.

A revision is these eight fields, and its id is their canonical digest:

```text
revisionId = digest({ projectId, kind, schema, objectId, parent, author, context, body })
```

| Field            | Holds                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`, `schema` | One of the twelve kinds, and `<kind>@1`                                                                                                                                                   |
| `objectId`       | The object this revision belongs to. A correction is a new revision of the same object                                                                                                    |
| `parent`         | The exact ref of the previous revision of the same object, or `"none"` for the first                                                                                                      |
| `author`         | `{ voice: "program" \| "agent" \| "researcher", id }`. `id` names the agent (`reader`), the researcher, or the program build                                                              |
| `context`        | `{ run, session, message, call, initiator }` (each id a string or `"none"`; `initiator` is `{ voice, id }`, who asked for the step), or `"none"` for a researcher command outside any run |
| `body`           | The kind's body below                                                                                                                                                                     |

Parsing refuses unknown fields, unsupported schemas, a voice the kind does not admit, an agent revision with no context, a parent of another object, and a revision whose id does not match its preimage. Existing revisions are never rewritten; a body change needs a new schema.

"Latest" and "before" always mean the commit log's sequence, which the store supplies; the contract never reads time to order records.

## Three voices

| Voice      | Kinds                                                                             | Standing                             |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| Program    | `source`, `copy`, `representation`, `fragment`, `artifact`, `receipt`, `snapshot` | A measurement. Anyone can recheck it |
| Agent      | `claim`, `evidence`, `judgment`, `protocol`                                       | An opinion, with its reason          |
| Researcher | `decision`, and any `claim`, `evidence` or `protocol` they write themselves       | A ruling                             |

- `judgment` is agent-only and is the only kind that carries an agent's assessment.
- `decision` is researcher-only and is the only kind that carries a ruling.
- Program kinds admit only the program, and hold only what the program measured or copied from a named service or file.
- No kind stores a tier. Tiers are derived.

## Shared shapes

- `Digest`: `sha256:<64 hex>`. `Ref<K>`: an exact ref that must resolve to kind `K`.
- `Blob`: `{ digest: Digest, schema: string | "none" }`, a stored file and the schema its bytes follow (`"none"` for opaque bytes such as a PDF). Blob schemas (search results, context manifests, structure trees, lens manifests) are frozen by the layer that owns them, not here, so they never force a new record schema.
- `LensPin`: `{ id, version, digest }`. `SkillPin`: `{ name, digest }`, where `digest` is `digest` of the skill's `{ path: blobDigest }` file map; the files are kept as blobs.
- Non-empty lists refuse `[]`. Pin lists and ref lists are sorted and unique.
- An `other` member of a closed union carries its content in a `reason`; no derivation ever branches on `other`.

## Kinds

| Kind             | Voice             | Body                                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`         | program           | `type` (CSL type), `identifiers: [{ scheme, value }]` (open scheme names), `fields: { [cslName]: { value: Json, origin } }`, where `origin` is `{ by: "service", service, response: Digest }` or `{ by: "file", copy: Digest }`                                                                                    |
| `copy`           | program           | `source: Ref<source>`, `blob: Digest`, `mediaType`, `size`, `content: "full-text" \| "abstract"`, `retrieved: { from: URL or "file", at: RFC 3339 }`, `licence: string \| "none"`                                                                                                                                  |
| `representation` | program           | `copy: Ref<copy>`, `blob: Digest` (UTF-8 text), `extractor: { id, version }`, `tree: Blob`, `ocr: boolean`                                                                                                                                                                                                         |
| `fragment`       | program           | `representation: Ref<representation>`, `representationDigest: Digest`, `selector: { profile: "utf8-bytes@1", start, end, quote }`, `before`, `after`, `page: { number, boxes: [[x0, y0, x1, y1]] } \| "none"`. A re-find onto newer text is a new revision of the same fragment object (its parent is the old one) |
| `claim`          | agent, researcher | `text`, `scope`, `addresses: { protocol: Ref<protocol>, subquestion } \| "none"`                                                                                                                                                                                                                                   |
| `evidence`       | agent, researcher | `claim: Ref<claim>`, `role: "supports" \| "challenges" \| "qualifies" \| "contextualizes"`, `basis`, `note`                                                                                                                                                                                                        |
| `judgment`       | agent             | `reason` plus one variant (below)                                                                                                                                                                                                                                                                                  |
| `decision`       | researcher        | `reason`, `attestation`, plus one variant (below)                                                                                                                                                                                                                                                                  |
| `protocol`       | agent, researcher | `question`, `scope: { in: string[], out: string[] }`, `subquestions: non-empty [{ id, text }]` (unique ids), `criteria: string[]`, `plan`, `effort`, `budgets: { [name]: number \| boolean \| string }`                                                                                                            |
| `artifact`       | program           | `inputs: ExactRef[]`, `output: Blob & { mediaType }`, `transformation` (an id, not a closed list)                                                                                                                                                                                                                  |
| `receipt`        | program           | `at: { started, ended }` (RFC 3339), `step`, `written: ExactRef[]`, `skills: SkillPin[]`, `lenses: LensPin[]`, `outcome`                                                                                                                                                                                           |
| `snapshot`       | program           | `basisRule: "claim-basis@1"`, `output: Ref<artifact>`, `selected: non-empty Ref<claim>[]`, `asOfSeq`, `members: { basis: ExactRef[], closureCount }`                                                                                                                                                               |

### Evidence basis

`{ kind: "quote", cited: non-empty [Cited] }` or `{ kind: "computation", run: Ref<receipt>, output: Ref<artifact> }`.

`Cited` is `{ fragment: Ref<fragment>, read: non-empty [{ start, end }], insertions: [{ at, text }], secondary: { of: Ref<source> \| "none" } \| "no" }`:

- `read` spans are byte offsets into the fragment's quote, on code point boundaries, in order, and separated by a gap (adjacent spans would render a gap marker where the source has none). The rendered quote is the spans joined in order with a visible gap marker between them (no clipping, no hidden gaps).
- `insertions[].at` is a byte offset into the quote, on a code point boundary, at the start, end or inside of a `read` span. Insertions at the same offset render in list order, always in brackets.
- A paraphrased claim keeps its original through `cited`, like any other.

### Judgment variants

| `type`        | Fields                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screening`   | `source: Ref<source>`, `protocol: Ref<protocol>`, `call: "include" \| "exclude" \| "unsure"`                                                                                                                          |
| `support`     | `evidence: Ref<evidence>`, `opinion: "supports" \| "partly"`. A negative opinion is a `challenge`                                                                                                                     |
| `challenge`   | `evidence: Ref<evidence>`, `grounds: "clipped" \| "out-of-context" \| "does-not-support" \| "secondary" \| "other"`                                                                                                   |
| `gap`         | `protocol: Ref<protocol>`, `subquestion`, `missing`, `searched: non-empty Ref<receipt>[]`, `close`. A gap without its searches is refused (principle 6). The `evidence.gap` call's receipt names the gap in `written` |
| `metadata`    | `source: Ref<source>`, `field`, `value: Json` (an agent's proposed citation field)                                                                                                                                    |
| `lens-choice` | `subject: non-empty ExactRef[]`, `chosen: LensPin \| "none"`                                                                                                                                                          |

### Decision variants

A decision's `objectId` is derived from its `type` and subject, so the object's head is "the latest ruling" on that subject.

| `type`             | Fields                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `adoption`         | `claim: Ref<claim>`, `evidence: Ref<evidence>[]` (what was read), `ruling: "adopt" \| "reject"`  |
| `challenge`        | `evidence: Ref<evidence>`, `grounds` (as in judgments)                                           |
| `challenge-ruling` | `challenge: Ref<judgment \| decision>`, `ruling: "upheld" \| "dismissed"`                        |
| `metadata`         | `source: Ref<source>`, `field`, `value: Json` (the researcher's citation field)                  |
| `lens-setting`     | `subject: non-empty ExactRef[]`, `lens: LensPin \| "none"`, `overrides: Ref<judgment> \| "none"` |
| `lens-adoption`    | `manifest: Ref<artifact>`, `ruling: "adopt" \| "reject"`                                         |

`attestation` is `{ level: "tty" \| "tui-gesture" \| "unattested", surface }`. An agent can run shell commands, so a ruling only counts toward a tier when its level is not `unattested`.

### Receipt steps

| `kind`    | Fields                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool`    | `tool`, `version`, `replay: "rerun" \| "stored"`, `input: Blob`, `output: Blob \| "none"`                                                                           |
| `script`  | `script: Blob`, `engine: { id, version }`, `clock`, `seed`, `calls: [{ tool, version, input: Blob, output: Blob \| { error } }]` in order, `result: Blob \| "none"` |
| `model`   | `provider`, `model`, `request: Blob` (the context manifest), `response: Blob \| "none"`                                                                             |
| `command` | `command`, `input: Blob` (a researcher command)                                                                                                                     |

`replay` says how replay checks a tool: `rerun` runs it again and compares digests (deterministic tools); `stored` answers from the stored output (fetches, searches). A script replays from its call log with the recorded clock and seed.

`outcome` is `{ status: "ok" }`, `{ status: "failed", error }` or `{ status: "refused", refusal }`. `refusal` is one of `lens-works-missing { missing: non-empty Digest[] }`, `not-shown { fragment: Ref<fragment> }`, `no-match`, `ambiguous-match`, `refind-unresolved { fragment: Ref<fragment>, against: Ref<representation> }` or `refind-ambiguous { fragment, against }`. An unforeseen refusal is a `failed` outcome.

`lenses: []` means no lens was in force.

## Derived, never stored

### Blobs a revision needs

`ResearchRecord.blobs(revision)` lists the stored files a revision needs, sorted and unique. The store refuses a commit until each is admitted, and `verify` checks each is present and intact.

| Digest field                                                                                                                                            | Required blob                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `source` field origins: a service's `response`, a file's `copy`                                                                                         | Yes                                                                                 |
| `copy.blob`; `representation.blob` and `tree`; `fragment.representationDigest`; `artifact.output`                                                       | Yes                                                                                 |
| Every `Blob` in a receipt step: tool `input` and `output`, `script`, call inputs and outputs, `result`, model `request` and `response`, command `input` | Yes, except `"none"` and a call output that is an error                             |
| `SkillPin.digest`                                                                                                                                       | No. It digests a file map; how skill files stay reachable is a later layer's choice |
| `LensPin.digest`                                                                                                                                        | No. The manifest is an artifact's output, required there                            |
| `lens-works-missing.missing`                                                                                                                            | No. Those works are absent by definition                                            |

A test walks every vector body and fails on a digest that is neither listed nor exempt.

### Effective citation

A source's citation fields come from its program revision, overridden by attested researcher `metadata` decisions, then by agent `metadata` judgments where neither has the field. Within one voice the latest commit wins. A field from a judgment carries the `agent-metadata` flag.

### Standing rulings

A decision object's standing ruling is its latest **attested** revision at the fence. An unattested revision counts for nothing and does not displace an attested one under it.

### What an object is about

No revision may change what its object is about: a judgment keeps its type and target, and an evidence object keeps its claim object. Otherwise an agent could revise an upheld challenge into a support judgment, or re-point evidence at another claim. Decisions need no rule, because their object id is derived from their subject. The graph also refuses a gap or computation that cites a failed or refused receipt.

### Tier

Computed per claim revision from the graph at a sequence fence, plus facts the caller supplies: which fragments verified against their bytes, which fragments were in the writing session's shown set before the evidence was written, and which computation runs replayed.

Evidence counts unless a standing `challenge-ruling` upheld a challenge to that exact evidence revision; upheld rulings are found from the rulings, so revising the challenge cannot erase one. A corrected evidence revision starts unchallenged. A challenge, from a head judgment or a standing researcher decision, is open until ruled.

| Tier          | When                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `adopted`     | The standing `adoption` ruling for this claim object adopts this exact claim revision                                |
| `computed`    | Otherwise, a counting `supports` evidence with a computation basis whose run replayed                                |
| `quoted`      | Otherwise, a counting `supports` evidence whose every cited fragment verified and, when an agent wrote it, was shown |
| `unsupported` | Otherwise                                                                                                            |

Flags qualify a tier and render wherever it does: `abstract-only`, `secondary`, `ocr`, `agent-metadata`, `contested` (an open challenge to any of the claim's evidence, or an upheld challenge to evidence an adoption read), `stale` (an unresolved re-find, until the fragment object is placed on that text; an ambiguous re-find is the researcher's to place, not stale), `rejected` (the standing adoption ruling rejects this exact claim revision). A corrected claim starts neither adopted nor rejected.

### Snapshot basis

`claimBasis` (Ivory's `claim-basis@1`, adapted) collects what a reader needs to recompute every tier and flag an output shows. At the `asOfSeq` fence, the basis is: the selected claims; the head evidence for them; the standing adoption rulings on those claim objects; the head support and challenge judgments and standing challenge decisions on that evidence or on evidence an adoption read; the standing rulings on those challenges; lens choices and settings naming a selected claim or its evidence; the citation amendments for every source the members reach; and the receipts that wrote any of these.

The members are the basis plus everything reached by following refs and parents forward, so an exported snapshot carries the history its graph needs to load. A receipt's `written` list is not followed (provenance, not meaning), and nothing is followed out of an earlier snapshot (cited, not re-opened).

### Lens labels

"Agent-made" (the manifest artifact's `context.initiator` is an agent and no `lens-adoption` adopts it) and "hypothesis" (the manifest lists no founding works) are derived. A missing founding work is refused by the loader at run start and recorded as `lens-works-missing`.

## Fragment verification

`verifyFragment` takes either a fragment in a graph with its representation's bytes, or a bare `{ representationDigest, selector, bytes }` whose selector it parses first (integer offsets, the `utf8-bytes@1` profile, a well-formed quote). It checks the bytes' digest, UTF-8 validity of the whole text, code point boundaries, and exact byte equality of the quote. It never normalizes or remaps.

## Vectors

`test/vectors/canonical-json.json` is Ivory's file, unchanged. `test/vectors/revisions.json` freezes new identities: one revision per kind, each variant of `judgment`, `decision`, `step` and `refusal`, the lens fields, quote checks including malformed selectors, and envelope refusals (edited body, extra field, unknown kind, later schema, wrong voice). TypeScript and the Python verifier in `python/` must agree on every entry. The Python verifier checks identity, envelope, voices, quotes and skill digests; body shapes are the TypeScript parser's alone.
