export * as Ref from "./ref.js"

import { Schema } from "effect"
import { Canonical, ContractError } from "./canonical.js"

export const MAX_ID_LENGTH = 256

/** Never a part of a ref: `latest` is navigation, and a citation must not start pointing at different content. */
export const LATEST = "latest"

/** An identifier: non-blank, at most {@link MAX_ID_LENGTH} characters, and never `latest`. */
export const Id = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (value.trim() !== "" && value !== LATEST && value.length <= MAX_ID_LENGTH) ||
      "a non-blank id other than 'latest', at most 256 characters",
  ),
)

/**
 * An exact reference to one revision. A correction is a new revision, so an exact ref never moves. A bare object id
 * is not a ref.
 */
export interface Exact extends Schema.Schema.Type<typeof Exact> {}
export const Exact = Schema.Struct({ projectId: Id, objectId: Id, revisionId: Id }).annotate({
  identifier: "ResearchRecord.ExactRef",
})

const decode = Schema.decodeUnknownExit(Exact, { onExcessProperty: "error" })

/** Validates a ref and, when `projectId` is given, that it points inside that project. */
export function parse(value: unknown, projectId?: string): Exact {
  const result = decode(value)
  if (result._tag === "Failure")
    throw new ContractError("invalid-ref", "an exact ref is exactly { projectId, objectId, revisionId }, each an id")
  if (projectId !== undefined && result.value.projectId !== projectId)
    throw new ContractError("cross-project-ref", `a ref into ${result.value.projectId} was used in ${projectId}`)
  return result.value
}

export function equals(a: Exact, b: Exact) {
  return a.projectId === b.projectId && a.objectId === b.objectId && a.revisionId === b.revisionId
}

/** A map key for a ref. Not a wire format. */
export function key(ref: Exact) {
  return Canonical.json([ref.projectId, ref.objectId, ref.revisionId])
}

/** Orders by project, object, then revision, comparing UTF-16 code units as canonical JSON does. */
export function compare(a: Exact, b: Exact) {
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1
  if (a.objectId !== b.objectId) return a.objectId < b.objectId ? -1 : 1
  if (a.revisionId !== b.revisionId) return a.revisionId < b.revisionId ? -1 : 1
  return 0
}
