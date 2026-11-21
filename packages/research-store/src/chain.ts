export * as Chain from "./chain.js"

import { Canonical } from "@opencode/research-record"

/** The commit chain's name. It is in every digest, so a chain cannot be replayed as another format's. */
export const NAME = "research-commit@1"

/** What each commit's digest covers. A commit's revisions are covered through their ids, each a digest of its content. */
export interface Link {
  readonly seq: number
  readonly prev: Canonical.Digest
  readonly key: string | null
  readonly request: Canonical.Digest
}

/** The digest the first commit chains from. It binds the chain to its project. */
export function genesis(projectId: string) {
  return Canonical.digest({ chain: NAME, projectId })
}

/** The digest of a commit's revision ids, in the order they were committed. */
export function request(revisionIds: readonly string[]) {
  return Canonical.digest(revisionIds)
}

export function digest(link: Link) {
  return Canonical.digest({ chain: NAME, seq: link.seq, prev: link.prev, key: link.key, request: link.request })
}
