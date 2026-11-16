import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Canonical } from "@opencode/research-record"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Blobs } from "../src/blobs.js"
import { StoreError } from "../src/error.js"
import { Layout } from "../src/layout.js"

// Ported from Ivory's cas.spec.ts: admission, the Windows install races, and installation corruption.

const made: string[] = []
// Every admission flushes to disk, which is slow on Windows.
setDefaultTimeout(30_000)
afterEach(() => made.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))

function layout() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "research-blobs-"))
  made.push(directory)
  return Layout.of(directory)
}

const bytes = (text: string) => new TextEncoder().encode(text)
const target = (where: Layout.Layout, data: Uint8Array) => Layout.blobPath(where, Canonical.blobDigest(data))
const staged = (where: Layout.Layout) => (fs.existsSync(where.staging) ? fs.readdirSync(where.staging) : [])
const failure = (code: string) => Object.assign(new Error(code), { code })

function refusal(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error as { code?: string }
  }
  throw new Error("expected a refusal")
}

describe("admission", () => {
  test("stores the bytes under the digest and leaves no staged file", () => {
    const where = layout()
    const digest = Blobs.admit(where, bytes("hello")).digest
    expect(digest).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
    expect(target(where, bytes("hello"))).toMatch(/[\\/]sha256[\\/]2c[\\/]f2[\\/]2cf24dba5fb0a30e/)
    expect(new Uint8Array(fs.readFileSync(target(where, bytes("hello"))))).toEqual(bytes("hello"))
    expect(staged(where)).toEqual([])
  })

  test("admits the empty blob", () => {
    const where = layout()
    expect(Blobs.admit(where, new Uint8Array()).digest).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
    expect(fs.statSync(target(where, new Uint8Array())).size).toBe(0)
  })

  test("admits the same bytes twice to one blob", () => {
    const where = layout()
    const first = Blobs.admit(where, bytes("twice"))
    expect(first.existed).toBe(false)
    expect(Blobs.admit(where, bytes("twice"))).toEqual({ digest: first.digest, existed: true })
    expect(fs.readdirSync(path.dirname(target(where, bytes("twice"))))).toHaveLength(1)
    expect(staged(where)).toEqual([])
  })

  test("names the staged file after the process", () => {
    const where = layout()
    const seen: string[] = []
    Blobs.admit(where, bytes("tagged"), {
      ...Blobs.defaultOps,
      install: (from, to) => {
        seen.push(...staged(where))
        Blobs.defaultOps.install(from, to)
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{16}\\.tmp$`))
  })

  test("refuses a name that holds other bytes, and does not overwrite them", () => {
    const where = layout()
    const file = target(where, bytes("the real bytes"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "damaged")
    const error = refusal(() => Blobs.admit(where, bytes("the real bytes")))
    expect(error).toBeInstanceOf(StoreError)
    expect(error.code).toBe("blob-corrupt")
    expect(fs.readFileSync(file, "utf8")).toBe("damaged")
    expect(staged(where)).toEqual([])
  })
})

describe("an install that fails because another admission got there first", () => {
  test("skips the install when the same bytes are already stored and held open", () => {
    const where = layout()
    Blobs.admit(where, bytes("held open"))
    let installs = 0
    const held = fs.openSync(target(where, bytes("held open")), "r")
    try {
      Blobs.admit(where, bytes("held open"), {
        ...Blobs.defaultOps,
        install: (from, to) => {
          installs += 1
          Blobs.defaultOps.install(from, to)
        },
      })
    } finally {
      fs.closeSync(held)
    }
    expect(installs).toBe(0)
    expect(staged(where)).toEqual([])
  })

  test("admits the blob when the install fails with EPERM but the same bytes appeared", () => {
    const where = layout()
    const data = bytes("appeared meanwhile")
    const { digest } = Blobs.admit(where, data, {
      ...Blobs.defaultOps,
      install: (from, to) => {
        fs.copyFileSync(from, to)
        throw failure("EPERM")
      },
    })
    expect(digest).toBe(Canonical.blobDigest(data))
    expect(new Uint8Array(fs.readFileSync(target(where, data)))).toEqual(data)
    expect(staged(where)).toEqual([])
  })

  test("rethrows EPERM when no blob appeared", () => {
    const where = layout()
    const error = refusal(() =>
      Blobs.admit(where, bytes("nothing appeared"), {
        ...Blobs.defaultOps,
        install: () => {
          throw failure("EPERM")
        },
      }),
    )
    expect(error.code).toBe("EPERM")
    expect(fs.existsSync(target(where, bytes("nothing appeared")))).toBe(false)
    expect(staged(where)).toEqual([])
  })

  test("refuses when what appeared does not match", () => {
    const where = layout()
    const error = refusal(() =>
      Blobs.admit(where, bytes("something else appeared"), {
        ...Blobs.defaultOps,
        install: (_from, to) => {
          fs.writeFileSync(to, "other bytes")
          throw failure("EPERM")
        },
      }),
    )
    expect(error.code).toBe("blob-corrupt")
    expect(staged(where)).toEqual([])
  })

  test("does not treat other install errors as a race", () => {
    const where = layout()
    const error = refusal(() =>
      Blobs.admit(where, bytes("disk trouble"), {
        ...Blobs.defaultOps,
        install: (from, to) => {
          fs.copyFileSync(from, to)
          throw failure("EIO")
        },
      }),
    )
    expect(error.code).toBe("EIO")
  })
})

describe("installation corruption", () => {
  test("a staged file damaged before install is refused before it gets a name", () => {
    const where = layout()
    const data = bytes("staging fixture")
    const error = refusal(() =>
      Blobs.admit(where, data, {
        ...Blobs.defaultOps,
        check: (file, digest) => {
          if (file.endsWith(".tmp")) fs.writeFileSync(file, "corrupt staging")
          return Blobs.defaultOps.check(file, digest)
        },
      }),
    )
    expect(error.code).toBe("blob-corrupt")
    expect(fs.existsSync(target(where, data))).toBe(false)
    expect(staged(where)).toEqual([])
  })

  test("an install that wrote other bytes fails its read-back and loses its name", () => {
    const where = layout()
    const data = bytes("readback fixture")
    const error = refusal(() =>
      Blobs.admit(where, data, {
        ...Blobs.defaultOps,
        install: (_from, to) => fs.writeFileSync(to, "corrupt install"),
      }),
    )
    expect(error.code).toBe("blob-corrupt")
    expect(fs.existsSync(target(where, data))).toBe(false)
    expect(staged(where)).toEqual([])
  })

  test("a different file that wins the race to the name is never replaced", () => {
    const where = layout()
    const data = bytes("publication fixture")
    const error = refusal(() =>
      Blobs.admit(where, data, {
        ...Blobs.defaultOps,
        install: (from, to) => {
          fs.writeFileSync(to, "race winner")
          Blobs.defaultOps.install(from, to)
        },
      }),
    )
    expect(error.code).toBe("blob-corrupt")
    expect(fs.readFileSync(target(where, data), "utf8")).toBe("race winner")
    expect(staged(where)).toEqual([])
  })
})

describe("reading", () => {
  test("returns the stored bytes", () => {
    const where = layout()
    expect(Blobs.read(where, Blobs.admit(where, bytes("read me")).digest)).toEqual(bytes("read me"))
  })

  test("refuses a blob with one flipped byte", () => {
    const where = layout()
    const { digest } = Blobs.admit(where, bytes("flip one byte"))
    const file = Layout.blobPath(where, digest)
    const stored = fs.readFileSync(file)
    stored[0] ^= 0x01
    fs.writeFileSync(file, stored)
    expect(refusal(() => Blobs.read(where, digest)).code).toBe("blob-corrupt")
  })

  test("refuses a missing blob", () => {
    const where = layout()
    expect(refusal(() => Blobs.read(where, Canonical.blobDigest(bytes("never stored")))).code).toBe("blob-missing")
  })
})

describe("sweeping", () => {
  test("removes staged files of dead processes and keeps this process's own", () => {
    const where = layout()
    fs.mkdirSync(where.staging, { recursive: true })
    const dead = 2 ** 30
    fs.writeFileSync(path.join(where.staging, `${dead}-00aa.tmp`), "left by a killed admission")
    fs.writeFileSync(path.join(where.staging, `${process.pid}-00bb.tmp`), "in progress")
    const parent = process.ppid
    fs.writeFileSync(path.join(where.staging, `${parent}-00cc.tmp`), "a live process, staging now")
    fs.writeFileSync(path.join(where.staging, `${parent}-00dd.tmp`), "a live pid, but a day old")
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(path.join(where.staging, `${parent}-00dd.tmp`), old, old)
    fs.writeFileSync(path.join(where.staging, "notes.txt"), "not a staged file")
    expect(Blobs.sweep(where)).toEqual([parent, dead].toSorted((a, b) => a - b))
    expect(staged(where).toSorted()).toEqual([`${process.pid}-00bb.tmp`, `${parent}-00cc.tmp`, "notes.txt"].toSorted())
  })
})
