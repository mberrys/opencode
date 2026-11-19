export * as Failpoint from "./failpoint.js"

import fs from "node:fs"

/** The places a kill test may stop the process: inside blob admission, and on either side of the database commit. */
export const NAMES = [
  "duringBlobStage",
  "beforeBlobInstall",
  "afterBlobInstall",
  "beforeDbCommit",
  "afterDbCommit",
] as const
export type Name = (typeof NAMES)[number]

/** Kill the process the `afterHits`-th time `name` is reached, after writing `markerFile`. Tests only. */
export interface Config {
  readonly name: Name
  readonly afterHits: number
  readonly markerFile: string
}

let configured: Config | undefined
let hits = 0

export function configure(config: Config | undefined) {
  configured = config
  hits = 0
}

/** Does nothing unless `name` is the configured failpoint and this is its configured hit. */
export function hit(name: Name) {
  if (configured === undefined || configured.name !== name) return
  hits += 1
  if (hits !== configured.afterHits) return
  fs.writeFileSync(configured.markerFile, JSON.stringify({ name, pid: process.pid }))
  process.kill(process.pid, "SIGKILL")
  // The kill can take a moment to land, and nothing after the failpoint may run meanwhile.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
}
