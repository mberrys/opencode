export * as ResearchRecord from "./record.js"

import { Schema } from "effect"
import { Canonical, ContractError } from "./canonical.js"
import { Ref } from "./ref.js"

export const CONTRACT = "research-record@1"

const check = <T>(predicate: (value: T) => boolean, message: string) =>
  Schema.makeFilter<T>((value) => predicate(value) || message)

/** A non-blank string: names, ids and anything a reader must be able to see. */
const Name = Schema.String.check(check((value: string) => value.trim() !== "", "a non-blank string"))
const Text = Schema.String
const Count = Schema.Number.check(
  check((value: number) => Number.isSafeInteger(value) && value >= 0, "a safe integer >= 0"),
)
const Ordinal = Schema.Number.check(
  check((value: number) => Number.isSafeInteger(value) && value >= 1, "a safe integer >= 1"),
)
const Time = Schema.String.check(
  check(
    (value: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      // Date.parse rolls 2026-02-30 over to March 2, so a real calendar time must survive the round trip.
      new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19),
    "an RFC 3339 UTC time",
  ),
)
const Digest = Schema.String.check(check(Canonical.isDigest, "sha256: followed by 64 lowercase hex digits"))
const None = Schema.Literal("none")
const orNone = <S extends Schema.Top>(schema: S) => Schema.Union([schema, None])

export const Voice = Schema.Literals(["program", "agent", "researcher"])
export type Voice = typeof Voice.Type

export const Principal = Schema.Struct({ voice: Voice, id: Name })
export interface Principal extends Schema.Schema.Type<typeof Principal> {}

/** A stored file and the schema its bytes follow. Blob schemas are frozen by the layer that owns them, not here. */
export const Blob = Schema.Struct({ digest: Digest, schema: orNone(Name) })
export interface Blob extends Schema.Schema.Type<typeof Blob> {}

export const LensPin = Schema.Struct({ id: Name, version: Name, digest: Digest })
export interface LensPin extends Schema.Schema.Type<typeof LensPin> {}

/** `digest` is the canonical digest of the skill's `{ path: blobDigest }` file map; the files are kept as blobs. */
export const SkillPin = Schema.Struct({ name: Name, digest: Digest })
export interface SkillPin extends Schema.Schema.Type<typeof SkillPin> {}

export const Context = Schema.Struct({
  run: orNone(Name),
  session: orNone(Name),
  message: orNone(Name),
  call: orNone(Name),
  /** Who asked for the step: an agent cutting a fragment, or the researcher at a command. */
  initiator: Principal,
})
export interface Context extends Schema.Schema.Type<typeof Context> {}

export const Selector = Schema.Struct({
  profile: Schema.Literal("utf8-bytes@1"),
  start: Count,
  end: Count,
  quote: Text,
})
export interface Selector extends Schema.Schema.Type<typeof Selector> {}

const Span = Schema.Struct({ start: Count, end: Count })

const Grounds = Schema.Literals(["clipped", "out-of-context", "does-not-support", "secondary", "other"])

const Origin = Schema.Union([
  Schema.Struct({ by: Schema.Literal("service"), service: Name, response: Digest }),
  Schema.Struct({ by: Schema.Literal("file"), copy: Digest }),
])

export const Source = Schema.Struct({
  type: Name,
  identifiers: Schema.Array(Schema.Struct({ scheme: Name, value: Name })),
  fields: Schema.Record(Schema.String, Schema.Struct({ value: Schema.Json, origin: Origin })),
})

export const Copy = Schema.Struct({
  source: Ref.Exact,
  blob: Digest,
  mediaType: Name,
  size: Count,
  content: Schema.Literals(["full-text", "abstract"]),
  retrieved: Schema.Struct({
    from: Name.check(check((value: string) => value === "file" || URL.canParse(value), "a URL or 'file'")),
    at: Time,
  }),
  licence: orNone(Name),
})

export const Representation = Schema.Struct({
  copy: Ref.Exact,
  blob: Digest,
  extractor: Schema.Struct({ id: Name, version: Name }),
  tree: Blob,
  ocr: Schema.Boolean,
})

export const Fragment = Schema.Struct({
  representation: Ref.Exact,
  representationDigest: Digest,
  selector: Selector,
  before: Text,
  after: Text,
  page: orNone(
    Schema.Struct({
      number: Ordinal,
      boxes: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number])),
    }),
  ),
})

export const Claim = Schema.Struct({
  text: Name,
  scope: Text,
  addresses: orNone(Schema.Struct({ protocol: Ref.Exact, subquestion: Name })),
})

const Cited = Schema.Struct({
  fragment: Ref.Exact,
  read: Schema.NonEmptyArray(Span),
  insertions: Schema.Array(Schema.Struct({ at: Count, text: Name })),
  secondary: Schema.Union([Schema.Struct({ of: orNone(Ref.Exact) }), Schema.Literal("no")]),
})
export interface Cited extends Schema.Schema.Type<typeof Cited> {}

export const Evidence = Schema.Struct({
  claim: Ref.Exact,
  role: Schema.Literals(["supports", "challenges", "qualifies", "contextualizes"]),
  basis: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("quote"), cited: Schema.NonEmptyArray(Cited) }),
    Schema.Struct({ kind: Schema.Literal("computation"), run: Ref.Exact, output: Ref.Exact }),
  ]),
  note: Text,
})

const judged = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), reason: Name, ...fields })

export const Judgment = Schema.Union([
  judged("screening", {
    source: Ref.Exact,
    protocol: Ref.Exact,
    call: Schema.Literals(["include", "exclude", "unsure"]),
  }),
  judged("support", { evidence: Ref.Exact, opinion: Schema.Literals(["supports", "partly"]) }),
  judged("challenge", { evidence: Ref.Exact, grounds: Grounds }),
  judged("gap", {
    protocol: Ref.Exact,
    subquestion: Name,
    missing: Name,
    searched: Schema.NonEmptyArray(Ref.Exact),
    close: Name,
  }),
  judged("metadata", { source: Ref.Exact, field: Name, value: Schema.Json }),
  judged("lens-choice", { subject: Schema.NonEmptyArray(Ref.Exact), chosen: orNone(LensPin) }),
])

const Attestation = Schema.Struct({ level: Schema.Literals(["tty", "tui-gesture", "unattested"]), surface: Name })

const ruled = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), reason: Text, attestation: Attestation, ...fields })

export const Decision = Schema.Union([
  ruled("adoption", {
    claim: Ref.Exact,
    evidence: Schema.Array(Ref.Exact),
    ruling: Schema.Literals(["adopt", "reject"]),
  }),
  ruled("challenge", { evidence: Ref.Exact, grounds: Grounds }),
  ruled("challenge-ruling", { challenge: Ref.Exact, ruling: Schema.Literals(["upheld", "dismissed"]) }),
  ruled("metadata", { source: Ref.Exact, field: Name, value: Schema.Json }),
  ruled("lens-setting", {
    subject: Schema.NonEmptyArray(Ref.Exact),
    lens: orNone(LensPin),
    overrides: orNone(Ref.Exact),
  }),
  ruled("lens-adoption", { manifest: Ref.Exact, ruling: Schema.Literals(["adopt", "reject"]) }),
])

export const Protocol = Schema.Struct({
  question: Name,
  scope: Schema.Struct({ in: Schema.Array(Name), out: Schema.Array(Name) }),
  subquestions: Schema.NonEmptyArray(Schema.Struct({ id: Name, text: Name })),
  criteria: Schema.Array(Name),
  plan: Text,
  effort: Name,
  budgets: Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.Boolean, Schema.String])),
})

export const Artifact = Schema.Struct({
  inputs: Schema.Array(Ref.Exact),
  output: Schema.Struct({ digest: Digest, schema: orNone(Name), mediaType: Name }),
  transformation: Name,
})

const Step = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool"),
    tool: Name,
    version: Name,
    replay: Schema.Literals(["rerun", "stored"]),
    input: Blob,
    output: orNone(Blob),
  }),
  Schema.Struct({
    kind: Schema.Literal("script"),
    script: Blob,
    engine: Schema.Struct({ id: Name, version: Name }),
    clock: Time,
    seed: Name,
    calls: Schema.Array(
      Schema.Struct({
        tool: Name,
        version: Name,
        input: Blob,
        output: Schema.Union([Blob, Schema.Struct({ error: Name })]),
      }),
    ),
    result: orNone(Blob),
  }),
  Schema.Struct({ kind: Schema.Literal("model"), provider: Name, model: Name, request: Blob, response: orNone(Blob) }),
  Schema.Struct({ kind: Schema.Literal("command"), command: Name, input: Blob }),
])

const Refusal = Schema.Union([
  Schema.Struct({ code: Schema.Literal("lens-works-missing"), missing: Schema.NonEmptyArray(Digest) }),
  Schema.Struct({ code: Schema.Literal("not-shown"), fragment: Ref.Exact }),
  Schema.Struct({ code: Schema.Literal("no-match") }),
  Schema.Struct({ code: Schema.Literal("ambiguous-match") }),
  Schema.Struct({ code: Schema.Literal("refind-unresolved"), fragment: Ref.Exact, against: Ref.Exact }),
  Schema.Struct({ code: Schema.Literal("refind-ambiguous"), fragment: Ref.Exact, against: Ref.Exact }),
])

export const Receipt = Schema.Struct({
  at: Schema.Struct({ started: Time, ended: Time }),
  step: Step,
  written: Schema.Array(Ref.Exact),
  skills: Schema.Array(SkillPin),
  lenses: Schema.Array(LensPin),
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal("ok") }),
    Schema.Struct({ status: Schema.Literal("failed"), error: Name }),
    Schema.Struct({ status: Schema.Literal("refused"), refusal: Refusal }),
  ]),
})

export const Snapshot = Schema.Struct({
  basisRule: Schema.Literal("claim-basis@1"),
  output: Ref.Exact,
  selected: Schema.NonEmptyArray(Ref.Exact),
  asOfSeq: Count,
  members: Schema.Struct({ basis: Schema.Array(Ref.Exact), closureCount: Count }),
})

/** Which voices may write each kind. Only `judgment` holds an agent's assessment and only `decision` a ruling. */
export const Writers = {
  source: ["program"],
  copy: ["program"],
  representation: ["program"],
  fragment: ["program"],
  claim: ["agent", "researcher"],
  evidence: ["agent", "researcher"],
  judgment: ["agent"],
  decision: ["researcher"],
  protocol: ["agent", "researcher"],
  artifact: ["program"],
  receipt: ["program"],
  snapshot: ["program"],
} as const satisfies { [kind: string]: readonly Voice[] }

export type Kind = keyof typeof Writers
export const Kinds = Object.keys(Writers) as Kind[]

const envelope = <K extends Kind, B extends Schema.Top>(kind: K, body: B) =>
  Schema.Struct({
    projectId: Ref.Id,
    kind: Schema.Literal(kind),
    schema: Schema.Literal(`${kind}@1` as const),
    objectId: Ref.Id,
    parent: orNone(Ref.Exact),
    author: Principal,
    context: orNone(Context),
    body,
  })

export const Preimage = Schema.Union([
  envelope("source", Source),
  envelope("copy", Copy),
  envelope("representation", Representation),
  envelope("fragment", Fragment),
  envelope("claim", Claim),
  envelope("evidence", Evidence),
  envelope("judgment", Judgment),
  envelope("decision", Decision),
  envelope("protocol", Protocol),
  envelope("artifact", Artifact),
  envelope("receipt", Receipt),
  envelope("snapshot", Snapshot),
])
export type Preimage = typeof Preimage.Type
export type PreimageOf<K extends Kind> = Extract<Preimage, { kind: K }>
export type Revision<K extends Kind = Kind> = PreimageOf<K> & { readonly revisionId: Canonical.Digest }
export type Body<K extends Kind> = PreimageOf<K>["body"]

const FIELDS = ["projectId", "kind", "schema", "objectId", "parent", "author", "context", "body"] as const
const decodePreimage = Schema.decodeUnknownExit(Preimage, { onExcessProperty: "error" })

/** Parses a revision preimage: no coercion, no defaults, no unknown fields, and only a voice the kind admits. */
export function parsePreimage(input: unknown): Preimage {
  Canonical.json(input)
  const kind = kindOf(input)
  const result = decodePreimage(input)
  if (result._tag === "Failure")
    throw new ContractError("invalid-record", `not a valid ${kind}@1 revision: ${String(result.cause)}`)
  const preimage = result.value
  if (!(Writers[preimage.kind] as readonly Voice[]).includes(preimage.author.voice))
    throw new ContractError("invalid-author", `${preimage.kind} is written by ${Writers[preimage.kind].join(" or ")}`)
  if (preimage.parent !== "none" && preimage.parent.objectId !== preimage.objectId)
    throw new ContractError("invalid-history", "a parent is a revision of the same object")
  refs(preimage).forEach((dependency) => Ref.parse(dependency.ref, preimage.projectId))
  if (preimage.parent !== "none") Ref.parse(preimage.parent, preimage.projectId)
  validate(preimage)
  return preimage
}

/** Parses a revision and checks that its id is the digest of its preimage. */
export function parse(input: unknown): Revision {
  if (!Canonical.isPlainObject(input) || !("revisionId" in input))
    throw new ContractError("invalid-record", "a revision has a revisionId")
  const { revisionId, ...rest } = input
  const preimage = parsePreimage(rest)
  if (revisionId !== Canonical.digest(preimage))
    throw new ContractError("digest-mismatch", "revisionId is not the digest of the revision's preimage")
  return { ...preimage, revisionId: revisionId as Canonical.Digest }
}

const decodeSelector = Schema.decodeUnknownExit(Selector, { onExcessProperty: "error" })

/** Parses a bare selector, as a lens category's defining passage carries one outside any revision. */
export function parseSelector(input: unknown): Selector {
  const result = decodeSelector(input)
  // A lone surrogate would be encoded as U+FFFD and could then match stored bytes it does not spell.
  if (result._tag === "Failure" || !result.value.quote.isWellFormed())
    throw new ContractError(
      "selector-mismatch",
      "a selector is utf8-bytes@1 with integer offsets and a well-formed quote",
    )
  return result.value
}

/** Builds a revision from a preimage, parsing it first. */
export function create(input: unknown): Revision {
  const preimage = parsePreimage(input)
  return { ...preimage, revisionId: Canonical.digest(preimage) }
}

export function refOf(revision: Revision): Ref.Exact {
  return { projectId: revision.projectId, objectId: revision.objectId, revisionId: revision.revisionId }
}

/**
 * A decision's object id is derived from what it rules on, so the object's head is the latest ruling on that subject
 * and two rulings on one subject can never sit side by side as separate objects.
 */
export function decisionObjectId(decision: Body<"decision">) {
  return Canonical.digest({ type: decision.type, subject: subjectOf(decision) })
}

function subjectOf(decision: Body<"decision">) {
  if (decision.type === "adoption") return [decision.claim.objectId]
  if (decision.type === "challenge") return [decision.evidence.objectId]
  if (decision.type === "challenge-ruling") return [decision.challenge.objectId]
  if (decision.type === "metadata") return [decision.source.objectId, decision.field]
  if (decision.type === "lens-setting") return decision.subject.map((ref) => ref.objectId)
  return [decision.manifest.objectId]
}

export interface Dependency {
  readonly ref: Ref.Exact
  /** The kinds the ref may resolve to. */
  readonly kinds: readonly Kind[]
}

const ANY = [] as const satisfies readonly Kind[]

/** Every ref a revision's body holds, with the kinds each must resolve to. An empty `kinds` admits any kind. */
export function refs(revision: Preimage): readonly Dependency[] {
  const to = (ref: Ref.Exact, ...kinds: Kind[]): Dependency => ({ ref, kinds })
  if (revision.kind === "source" || revision.kind === "protocol") return []
  if (revision.kind === "copy") return [to(revision.body.source, "source")]
  if (revision.kind === "representation") return [to(revision.body.copy, "copy")]
  if (revision.kind === "fragment") return [to(revision.body.representation, "representation")]
  if (revision.kind === "claim")
    return revision.body.addresses === "none" ? [] : [to(revision.body.addresses.protocol, "protocol")]
  if (revision.kind === "evidence") {
    const basis = revision.body.basis
    return [
      to(revision.body.claim, "claim"),
      ...(basis.kind === "computation"
        ? [to(basis.run, "receipt"), to(basis.output, "artifact")]
        : basis.cited.flatMap((cited) => [
            to(cited.fragment, "fragment"),
            ...(cited.secondary !== "no" && cited.secondary.of !== "none" ? [to(cited.secondary.of, "source")] : []),
          ])),
    ]
  }
  if (revision.kind === "judgment") {
    const judgment = revision.body
    if (judgment.type === "screening") return [to(judgment.source, "source"), to(judgment.protocol, "protocol")]
    if (judgment.type === "support" || judgment.type === "challenge") return [to(judgment.evidence, "evidence")]
    if (judgment.type === "gap")
      return [to(judgment.protocol, "protocol"), ...judgment.searched.map((ref) => to(ref, "receipt"))]
    if (judgment.type === "metadata") return [to(judgment.source, "source")]
    return judgment.subject.map((ref) => to(ref, ...ANY))
  }
  if (revision.kind === "decision") {
    const decision = revision.body
    if (decision.type === "adoption")
      return [to(decision.claim, "claim"), ...decision.evidence.map((ref) => to(ref, "evidence"))]
    if (decision.type === "challenge") return [to(decision.evidence, "evidence")]
    if (decision.type === "challenge-ruling") return [to(decision.challenge, "judgment", "decision")]
    if (decision.type === "metadata") return [to(decision.source, "source")]
    if (decision.type === "lens-setting")
      return [
        ...decision.subject.map((ref) => to(ref, ...ANY)),
        ...(decision.overrides === "none" ? [] : [to(decision.overrides, "judgment")]),
      ]
    return [to(decision.manifest, "artifact")]
  }
  if (revision.kind === "artifact") return revision.body.inputs.map((ref) => to(ref, ...ANY))
  if (revision.kind === "receipt") {
    const refusal = revision.body.outcome.status === "refused" ? revision.body.outcome.refusal : undefined
    return [
      ...revision.body.written.map((ref) => to(ref, ...ANY)),
      ...(refusal?.code === "not-shown" ? [to(refusal.fragment, "fragment")] : []),
      ...(refusal?.code === "refind-unresolved" || refusal?.code === "refind-ambiguous"
        ? [to(refusal.fragment, "fragment"), to(refusal.against, "representation")]
        : []),
    ]
  }
  return [
    to(revision.body.output, "artifact"),
    ...revision.body.selected.map((ref) => to(ref, "claim")),
    ...revision.body.members.basis.map((ref) => to(ref, ...ANY)),
  ]
}

/**
 * What an object is about, which no revision may change: a judgment's type and target, and the claim an evidence
 * object supports. Decisions need no entry, because their object id is derived from the same thing.
 */
export function about(revision: Preimage) {
  if (revision.kind === "evidence") return revision.body.claim.objectId
  if (revision.kind !== "judgment") return ""
  const judgment = revision.body
  const targets =
    judgment.type === "screening"
      ? [judgment.source.objectId, judgment.protocol.objectId]
      : judgment.type === "support" || judgment.type === "challenge"
        ? [judgment.evidence.objectId]
        : judgment.type === "gap"
          ? [judgment.protocol.objectId, judgment.subquestion]
          : judgment.type === "metadata"
            ? [judgment.source.objectId, judgment.field]
            : judgment.subject.map((ref) => ref.objectId)
  return Canonical.json([judgment.type, ...targets])
}

/** Rules a schema cannot state: order, uniqueness, spans and derived ids. */
function validate(revision: Preimage) {
  if (revision.context === "none" && revision.author.voice === "agent")
    refuse("an agent writes only inside a run, so its revisions name their context")
  if (revision.kind === "fragment") {
    const selector = revision.body.selector
    if (
      selector.start >= selector.end ||
      new TextEncoder().encode(selector.quote).length !== selector.end - selector.start
    )
      refuse("a selector is a non-empty span whose quote has exactly end - start bytes")
  }
  if (revision.kind === "evidence" && revision.body.basis.kind === "quote") {
    unique(
      revision.body.basis.cited.map((cited) => Ref.key(cited.fragment)),
      "cited fragments",
    )
    revision.body.basis.cited.forEach((cited) => {
      // Adjacent spans would render a gap marker where the source has no gap.
      if (
        cited.read.some(
          (span, index) => span.start >= span.end || (index > 0 && span.start <= cited.read[index - 1].end),
        )
      )
        refuse("read spans are non-empty, in order, and separated by a gap")
      if (
        cited.insertions.some(
          (insertion) => !cited.read.some((span) => insertion.at >= span.start && insertion.at <= span.end),
        )
      )
        refuse("an insertion sits at the start, end or inside of a read span")
      if (cited.insertions.some((insertion, index) => index > 0 && insertion.at < cited.insertions[index - 1].at))
        refuse("insertions are in order")
    })
  }
  if (revision.kind === "protocol")
    unique(
      revision.body.subquestions.map((item) => item.id),
      "sub-question ids",
    )
  if (revision.kind === "artifact") unique(revision.body.inputs.map(Ref.key), "inputs")
  if (revision.kind === "judgment" && revision.body.type === "gap") sortedRefs(revision.body.searched, "searched")
  if (revision.kind === "judgment" && revision.body.type === "lens-choice") sortedRefs(revision.body.subject, "subject")
  if (revision.kind === "decision") {
    if (revision.objectId !== decisionObjectId(revision.body))
      throw new ContractError("invalid-record", "a decision's object id is derived from its type and subject")
    if (revision.body.type === "adoption") sortedRefs(revision.body.evidence, "evidence")
    if (revision.body.type === "lens-setting") sortedRefs(revision.body.subject, "subject")
  }
  if (revision.kind === "receipt") {
    const body = revision.body
    if (instant(body.at.ended) < instant(body.at.started)) refuse("a receipt ends after it starts")
    sortedRefs(body.written, "written")
    sorted(body.skills.map(Canonical.json), "skills")
    sorted(body.lenses.map(Canonical.json), "lenses")
    if (body.outcome.status === "refused" && body.outcome.refusal.code === "lens-works-missing")
      sorted(body.outcome.refusal.missing, "missing")
  }
  if (revision.kind === "snapshot") {
    sortedRefs(revision.body.selected, "selected")
    sortedRefs(revision.body.members.basis, "basis")
  }
}

/** A UTC time as a fixed-width string that orders correctly, down to the nanosecond. */
function instant(value: string) {
  const fraction = value.slice(19, -1).replace(".", "")
  return value.slice(0, 19) + fraction.padEnd(9, "0")
}

function sortedRefs(values: readonly Ref.Exact[], field: string) {
  if (values.some((value, index) => index > 0 && Ref.compare(values[index - 1], value) >= 0))
    refuse(`${field} is sorted and unique`)
}

function sorted(values: readonly string[], field: string) {
  if (values.some((value, index) => index > 0 && values[index - 1] >= value)) refuse(`${field} is sorted and unique`)
}

function unique(values: readonly string[], field: string) {
  if (new Set(values).size !== values.length) refuse(`${field} are unique`)
}

function refuse(message: string): never {
  throw new ContractError("invalid-record", message)
}

function kindOf(input: unknown) {
  if (!Canonical.isPlainObject(input) || FIELDS.some((field) => !Object.hasOwn(input, field)))
    throw new ContractError("invalid-record", `a revision has exactly ${FIELDS.join(", ")}`)
  if (!Kinds.includes(input.kind as Kind))
    throw new ContractError("invalid-record", `unknown kind ${String(input.kind)}`)
  if (input.schema !== `${input.kind}@1`)
    throw new ContractError("unsupported-schema", `unsupported ${String(input.kind)} schema ${String(input.schema)}`)
  return input.kind as Kind
}

/** The digest of a skill: the canonical digest of its `{ path: blobDigest }` file map. */
export function skillDigest(files: Readonly<Record<string, Uint8Array>>) {
  return Canonical.digest(
    Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Canonical.blobDigest(bytes)])),
  )
}
