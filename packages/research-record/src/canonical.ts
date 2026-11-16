export * as Canonical from "./canonical.js"

// node:crypto rather than Bun.CryptoHasher: the exported verifier must also run under Node, with no OpenCode or Bun.
import { createHash } from "node:crypto"

/** `sha256:` followed by 64 lowercase hex digits. */
export type Digest = `sha256:${string}`

export type ErrorCode =
  | "non-finite-number"
  | "lone-surrogate"
  | "unsupported-value"
  | "cyclic-value"
  | "invalid-ref"
  | "cross-project-ref"
  | "invalid-record"
  | "unsupported-schema"
  | "invalid-author"
  | "invalid-history"
  | "wrong-kind"
  | "dangling-ref"
  | "digest-mismatch"
  | "selector-mismatch"

/** A refusal. `code` is part of the contract: the Python verifier reports the same codes. */
export class ContractError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ContractError"
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/

// In a `u` regex a surrogate pair reads as one astral code point, so only unpaired halves match.
const LONE_SURROGATE = /\p{Cs}/u

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST.test(value)
}

/**
 * RFC 8785 canonical JSON. Every revision id is a digest of this text, so a value hashes the same in TypeScript and
 * Python. Input must be I-JSON (RFC 7493): plain objects, arrays, strings without lone surrogates, finite numbers,
 * booleans and null. Anything else is refused rather than dropped or converted the way `JSON.stringify` would.
 */
export function json(value: unknown): string {
  return serialize(value, new Set())
}

/** SHA-256 over the UTF-8 bytes of the value's canonical JSON. */
export function digest(value: unknown): Digest {
  return `sha256:${createHash("sha256").update(json(value), "utf8").digest("hex")}`
}

/** SHA-256 over raw bytes. A byte identity is never a JSON identity: a string's blob digest differs from its digest. */
export function blobDigest(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

/** True for object literals and `Object.create(null)`; false for arrays and class instances. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean") return String(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractError("non-finite-number", `${value} has no JSON representation`)
    // RFC 8785 specifies ECMAScript's Number-to-String, which JSON.stringify emits; -0 becomes "0".
    return JSON.stringify(value)
  }
  if (typeof value === "string") return string(value)
  if (Array.isArray(value))
    return enter(value, ancestors, () => {
      const holes = value.findIndex((_, index) => !(index in value))
      if (Object.keys(value).length !== value.length || holes >= 0)
        throw new ContractError("unsupported-value", "an array with holes is not I-JSON")
      return `[${value.map((item) => serialize(item, ancestors)).join(",")}]`
    })
  if (isPlainObject(value))
    return enter(value, ancestors, () => {
      // The default sort compares UTF-16 code units, which is the member order RFC 8785 requires.
      const members = Object.keys(value)
        .sort()
        .map((key) => `${string(key)}:${serialize(value[key], ancestors)}`)
      return `{${members.join(",")}}`
    })
  throw new ContractError("unsupported-value", `${describe(value)} is not I-JSON`)
}

function string(value: string) {
  if (LONE_SURROGATE.test(value))
    throw new ContractError("lone-surrogate", "strings must not contain unpaired UTF-16 surrogates")
  // Without lone surrogates, JSON.stringify escapes exactly what RFC 8785 escapes: '"', '\' and U+0000-U+001F,
  // using \b \t \n \f \r where they exist and lowercase \u00xx otherwise.
  return JSON.stringify(value)
}

function enter(container: object, ancestors: Set<object>, members: () => string) {
  if (ancestors.has(container))
    throw new ContractError("cyclic-value", "a value that contains itself has no JSON representation")
  ancestors.add(container)
  const text = members()
  ancestors.delete(container)
  return text
}

function describe(value: unknown) {
  if (typeof value === "object" && value) return Object.getPrototypeOf(value)?.constructor?.name ?? "object"
  return typeof value
}
