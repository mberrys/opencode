import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import { type Digest, digestBytes, hex, isDigest } from "@opencode/research-record"

/** Content addressed bytes: a file is named by its digest and is never rewritten. */
export class Blobs {
  readonly directory: string

  constructor(root: string) {
    this.directory = join(root, "blobs", "sha256")
    mkdirSync(this.directory, { recursive: true })
  }

  path(digest: Digest): string {
    return join(this.directory, hex(digest))
  }

  has(digest: Digest): boolean {
    return existsSync(this.path(digest))
  }

  /** Writes through a temporary file and a rename, so a reader never sees a half written blob. */
  put(bytes: Uint8Array): Digest {
    const digest = digestBytes(bytes)
    const target = this.path(digest)
    if (existsSync(target)) return digest
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    const handle = openSync(temporary, "w")
    try {
      writeSync(handle, bytes)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, target)
    return digest
  }

  get(digest: Digest): Uint8Array {
    if (!isDigest(digest)) throw new Error(`not a digest: ${digest}`)
    const bytes = readFileSync(this.path(digest))
    const actual = digestBytes(bytes)
    if (actual !== digest) throw new Error(`blob ${hex(digest)} is damaged: its bytes hash to ${hex(actual)}`)
    return bytes
  }

  text(digest: Digest): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.get(digest))
  }

  remove(digest: Digest): void {
    rmSync(this.path(digest), { force: true })
  }

  list(): Digest[] {
    return readdirSync(this.directory)
      .filter((name) => /^[0-9a-f]{64}$/.test(name))
      .map((name) => `sha256:${name}` as Digest)
      .sort()
  }
}
