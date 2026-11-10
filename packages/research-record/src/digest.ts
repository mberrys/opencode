export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export type Digest = `sha256:${string}`

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export const DIGEST_LENGTH = 71

/**
 * RFC 8785 canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, ECMAScript number and string
 * serialization. A record's id is the digest of exactly this string, so any other serializer would drift.
 */
export function canonical(value: Json): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON cannot hold ${value}`)
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as { readonly [key: string]: Json })[key]
        if (item === undefined) throw new Error(`canonical JSON cannot hold undefined at ${key}`)
        return `${JSON.stringify(key)}:${canonical(item)}`
      })
    return `{${entries.join(",")}}`
  }
  throw new Error(`canonical JSON cannot hold ${typeof value}`)
}

export function digest(value: Json): Digest {
  return digestBytes(new TextEncoder().encode(canonical(value)))
}

export function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value)
}

export function assertDigest(value: unknown, where: string): Digest {
  if (!isDigest(value)) throw new Error(`${where} must be sha256 plus 64 lowercase hex digits`)
  return value
}

export function hex(digest: Digest): string {
  return digest.slice("sha256:".length)
}

/** Short display form: the kind-free prefix a person can match by eye. */
export function shortDigest(digest: Digest, length = 10): string {
  return hex(digest).slice(0, length)
}

export function assertJson(value: unknown, where: string): Json {
  try {
    canonical(value as Json)
  } catch (error) {
    throw new Error(`${where} is not canonical JSON: ${(error as Error).message}`)
  }
  return value as Json
}
