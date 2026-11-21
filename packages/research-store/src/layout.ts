export * as Layout from "./layout.js"

import path from "node:path"

/** Where a project's record lives: `.research/` beside the project, apart from OpenCode's session database. */
export interface Layout {
  readonly root: string
  readonly database: string
  readonly blobs: string
  readonly staging: string
}

export function of(directory: string): Layout {
  const root = path.join(path.resolve(directory), ".research")
  return {
    root,
    database: path.join(root, "record.db"),
    blobs: path.join(root, "blobs", "sha256"),
    staging: path.join(root, "staging"),
  }
}

/** A blob's file: `blobs/sha256/ab/cd/<64 hex>`, so no directory grows past 65,536 entries per level. */
export function blobPath(layout: Layout, digest: string) {
  const hex = digest.slice("sha256:".length)
  return path.join(layout.blobs, hex.slice(0, 2), hex.slice(2, 4), hex)
}
