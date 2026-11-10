import type { FragmentBody, FragmentFlag, PagePosition, Ref } from "./record.js"

export const CONTEXT_CHARACTERS = 40
const CONTEXT_BYTES = 256

export interface Address {
  /** The shortest unique prefix of a source's object id, as the library assigned it. */
  readonly short: string
  readonly section: number
  readonly paragraph: number
  readonly sentence?: number
}

const ADDRESS_PATTERN = /^([0-9a-z]{4,}):([0-9]+)\/p([0-9]+)(?:\/s([0-9]+))?$/

export function formatAddress(address: Address): string {
  const sentence = address.sentence === undefined ? "" : `/s${address.sentence}`
  return `${address.short}:${address.section}/p${address.paragraph}${sentence}`
}

export function parseAddress(value: string): Address {
  const match = ADDRESS_PATTERN.exec(value)
  if (!match) throw new Error(`not an address: ${value}`)
  return {
    short: match[1]!,
    section: Number(match[2]),
    paragraph: Number(match[3]),
    sentence: match[4] === undefined ? undefined : Number(match[4]),
  }
}

export interface CutInput {
  readonly representation: Ref
  readonly text: Uint8Array
  readonly start: number
  readonly end: number
  readonly address: string
  readonly flags?: readonly FragmentFlag[]
  readonly page?: PagePosition
}

export interface VerificationFailure {
  readonly code: "range" | "quote" | "before" | "after" | "encoding"
  readonly detail: string
}

export type Check = { readonly ok: true } | { readonly ok: false; readonly failure: VerificationFailure }

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Cuts a fragment by address. The program, never a model, finds the bytes and copies the words. */
export function cut(input: CutInput): FragmentBody {
  assertRange(input.text, input.start, input.end)
  const quote = decode(input.text.subarray(input.start, input.end))
  return {
    representation: input.representation,
    range: { start: input.start, end: input.end },
    quote,
    before: preceding(input.text, input.start),
    after: following(input.text, input.end),
    address: input.address,
    flags: input.flags ?? [],
    ...(input.page ? { page: input.page } : {}),
  }
}

/**
 * Rechecks a fragment against the bytes it claims. A quote one character off, or a context that does not sit
 * exactly beside it, fails. Nothing here normalizes: the comparison is over the stored bytes as they are.
 */
export function verifyFragment(fragment: FragmentBody, text: Uint8Array): Check {
  const range = fragment.range
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start)
    return fail("range", `range ${range.start}..${range.end} is not a span`)
  if (range.end > text.length) return fail("range", `range ends at ${range.end} but the text is ${text.length} bytes`)

  const quote = encoder.encode(fragment.quote)
  if (fragment.quote.length === 0) return fail("quote", "the quote is empty")
  if (quote.length !== range.end - range.start)
    return fail("quote", `the quote is ${quote.length} bytes but the range spans ${range.end - range.start}`)
  // Compare the decoded string, so a lone surrogate cannot pass for the replacement character it encodes to.
  if (decode(text.subarray(range.start, range.end)) !== fragment.quote)
    return fail("quote", "the quote is not the stored bytes")

  const before = encoder.encode(fragment.before)
  if (range.start < before.length) return fail("before", "the context before runs past the start of the text")
  if (!bytesEqual(text.subarray(range.start - before.length, range.start), before))
    return fail("before", "the words before the quote are not the stored bytes")

  const after = encoder.encode(fragment.after)
  if (text.length - range.end < after.length) return fail("after", "the context after runs past the end of the text")
  if (!bytesEqual(text.subarray(range.end, range.end + after.length), after))
    return fail("after", "the words after the quote are not the stored bytes")

  return { ok: true }
}

export function verifyFragmentBytes(fragment: FragmentBody, text: Uint8Array): Check {
  try {
    return verifyFragment(fragment, text)
  } catch (error) {
    return fail("encoding", (error as Error).message)
  }
}

function assertRange(text: Uint8Array, start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error("a range needs integer byte offsets")
  if (start < 0 || end < start || end > text.length)
    throw new Error(`range ${start}..${end} is outside 0..${text.length}`)
}

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new Error("the range does not fall on UTF-8 character boundaries")
  }
}

function preceding(text: Uint8Array, start: number): string {
  const from = Math.max(0, start - CONTEXT_BYTES)
  let begin = from
  while (begin < start && (text[begin]! & 0xc0) === 0x80) begin++
  const window = decode(text.subarray(begin, start))
  return [...window].slice(-CONTEXT_CHARACTERS).join("")
}

function following(text: Uint8Array, end: number): string {
  let stop = Math.min(text.length, end + CONTEXT_BYTES)
  while (stop > end && stop < text.length && (text[stop]! & 0xc0) === 0x80) stop--
  const window = decode(text.subarray(end, stop))
  return [...window].slice(0, CONTEXT_CHARACTERS).join("")
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

function fail(code: VerificationFailure["code"], detail: string): Check {
  return { ok: false, failure: { code, detail } }
}
