import { describe, expect, test } from "bun:test"
import { Canonical, ResearchRecord } from "../src/index"

const file: { revisions: { name: string; revision: ResearchRecord.Revision }[] } = await Bun.file(
  new URL("./vectors/revisions.json", import.meta.url),
).json()

// Where a required blob's digest sits in a body. Classified by path, not value, so a new digest field fails the test
// even when its value happens to equal a digest listed for another reason.
const REQUIRED = [
  /^body\.fields\.[^.]+\.origin\.(response|copy)$/,
  /^body\.blob$/,
  /^body\.tree\.digest$/,
  /^body\.representationDigest$/,
  /^body\.output\.digest$/,
  /^body\.step\.(input|output|script|result|request|response)\.digest$/,
  /^body\.step\.calls\.\d+\.(input|output)\.digest$/,
]
// Digests that name no stored file the revision needs: pins, and the works a lens-works-missing refusal lists.
const EXEMPT = [
  /^body\.skills\.\d+\.digest$/,
  /^body\.lenses\.\d+\.digest$/,
  /^body\.(lens|chosen)\.digest$/,
  /^body\.outcome\.refusal\.missing\.\d+$/,
]

/** Every digest-shaped string in a value, with its path, except the revision ids inside exact refs. */
function digests(value: unknown, at: string): { path: string; digest: string }[] {
  if (typeof value === "string") return Canonical.isDigest(value) ? [{ path: at, digest: value }] : []
  if (Array.isArray(value)) return value.flatMap((item, index) => digests(item, `${at}.${index}`))
  if (!Canonical.isPlainObject(value)) return []
  if ("revisionId" in value && "objectId" in value) return []
  return Object.entries(value).flatMap(([key, item]) => digests(item, `${at}.${key}`))
}

const listed = (revision: ResearchRecord.Preimage) =>
  [
    ...new Set(
      digests(revision.body, "body")
        .filter((item) => REQUIRED.some((pattern) => pattern.test(item.path)))
        .map((item) => item.digest as Canonical.Digest),
    ),
  ].toSorted()

describe("blobs", () => {
  test("every digest in every vector body sits at a required or an exempt path", () => {
    file.revisions.forEach(({ name, revision }) =>
      digests(revision.body, "body").forEach(({ path }) => {
        const required = REQUIRED.some((pattern) => pattern.test(path))
        const exempt = EXEMPT.some((pattern) => pattern.test(path))
        expect({ name, path, classified: required !== exempt }).toEqual({ name, path, classified: true })
      }),
    )
  })

  test("lists exactly the digests at required paths, sorted and unique", () => {
    file.revisions.forEach(({ revision }) => expect(ResearchRecord.blobs(revision)).toEqual(listed(revision)))
  })

  test("a field taken from the file names the copy's bytes, and a command names its input", () => {
    const source = file.revisions.find(({ revision }) => revision.kind === "source")!.revision
    const copy = `sha256:${"c".repeat(64)}` as const
    const fromFile = {
      ...source,
      body: { ...source.body, fields: { title: { value: "A title", origin: { by: "file", copy } } } },
    } as ResearchRecord.Preimage
    expect(ResearchRecord.blobs(fromFile)).toEqual([copy])
    const receipt = file.revisions.find(({ revision }) => revision.kind === "receipt")!.revision
    const input = `sha256:${"d".repeat(64)}` as const
    const command = {
      ...receipt,
      body: { ...receipt.body, step: { kind: "command", command: "adopt", input: { digest: input, schema: "none" } } },
    } as ResearchRecord.Preimage
    expect(ResearchRecord.blobs(command)).toEqual([input])
    expect(listed(command)).toEqual([input])
  })
})
