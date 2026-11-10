import { describe, expect, test } from "bun:test"
import { digest } from "../src/digest.js"
import { cut, formatAddress, parseAddress, verifyFragment } from "../src/fragment.js"
import { ref } from "../src/record.js"

const representation = ref("representation", digest({ representation: 1 }))
const text = "Café ☕ costs €5. Résumé says 研究 is hard."
const bytes = new TextEncoder().encode(text)

function span(quote: string) {
  const start = new TextEncoder().encode(text.slice(0, text.indexOf(quote))).length
  return { start, end: start + new TextEncoder().encode(quote).length }
}

describe("fragments", () => {
  test("a cut fragment verifies against the bytes it was cut from", () => {
    const range = span("Résumé says 研究 is hard.")
    const fragment = cut({ representation, text: bytes, ...range, address: "k7f2:1/p0/s2" })
    expect(fragment.quote).toBe("Résumé says 研究 is hard.")
    expect(fragment.before).toBe("Café ☕ costs €5. ")
    expect(fragment.after).toBe("")
    expect(verifyFragment(fragment, bytes)).toEqual({ ok: true })
  })

  test("the byte range is the authority, not the address", () => {
    const range = span("Résumé says 研究 is hard.")
    const fragment = cut({ representation, text: bytes, ...range, address: "k7f2:9/p9/s9" })
    expect(verifyFragment(fragment, bytes)).toEqual({ ok: true })
  })

  test("a quote one character off is refused", () => {
    const range = span("Résumé says 研究 is hard.")
    const fragment = cut({ representation, text: bytes, ...range, address: "k7f2:1/p0/s2" })
    expect(verifyFragment({ ...fragment, quote: "Résumé says 研究 is hard?" }, bytes)).toMatchObject({
      ok: false,
      failure: { code: "quote" },
    })
  })

  test("a quote that shrinks by one character no longer matches the range", () => {
    const range = span("Résumé says 研究 is hard.")
    const fragment = cut({ representation, text: bytes, ...range, address: "k7f2:1/p0/s2" })
    expect(verifyFragment({ ...fragment, quote: fragment.quote.slice(0, -1) }, bytes)).toMatchObject({
      ok: false,
      failure: { code: "quote" },
    })
  })

  test("context that does not sit beside the quote is refused", () => {
    const range = span("Résumé says")
    const fragment = cut({ representation, text: bytes, ...range, address: "k7f2:1/p0/s2" })
    expect(verifyFragment({ ...fragment, before: "Something else entirely " }, bytes)).toMatchObject({
      ok: false,
      failure: { code: "before" },
    })
    expect(verifyFragment({ ...fragment, after: " and then something else" }, bytes)).toMatchObject({
      ok: false,
      failure: { code: "after" },
    })
  })

  test("a range that falls inside a multi-byte character is refused when cutting", () => {
    // "Café": c a f é, with é at bytes 3..5, so byte 4 is inside it.
    expect(() => cut({ representation, text: bytes, start: 4, end: 6, address: "k7f2:1/p0/s1" })).toThrow(
      "character boundaries",
    )
  })

  test("a fragment at the start and end of a document has no context to lie about", () => {
    const first = cut({ representation, text: bytes, start: 0, end: 3, address: "k7f2:1/p0/s1" })
    expect(first.before).toBe("")
    expect(verifyFragment(first, bytes)).toEqual({ ok: true })

    const lastStart = new TextEncoder().encode(text.slice(0, text.lastIndexOf("hard."))).length
    const last = cut({ representation, text: bytes, start: lastStart, end: bytes.length, address: "k7f2:1/p0/s9" })
    expect(last.after).toBe("")
    expect(verifyFragment(last, bytes)).toEqual({ ok: true })
  })

  test("a lone surrogate does not pass for the replacement character it encodes to", () => {
    const replacement = new TextEncoder().encode("\uFFFD")
    const fragment = cut({ representation, text: replacement, start: 0, end: replacement.length, address: "k7f2:1/p0/s1" })
    expect(verifyFragment({ ...fragment, quote: "\uD800" }, replacement)).toMatchObject({
      ok: false,
      failure: { code: "quote" },
    })
  })

  test("a fragment longer than its text is refused", () => {
    const fragment = cut({ representation, text: bytes, start: 0, end: 3, address: "k7f2:1/p0/s1" })
    expect(verifyFragment(fragment, bytes.subarray(0, 2))).toMatchObject({ ok: false, failure: { code: "range" } })
  })

  test("an address round trips and refuses anything that is not one", () => {
    expect(formatAddress({ short: "k7f2", section: 4, paragraph: 3, sentence: 2 })).toBe("k7f2:4/p3/s2")
    expect(parseAddress("k7f2:4/p3/s2")).toEqual({ short: "k7f2", section: 4, paragraph: 3, sentence: 2 })
    expect(parseAddress("k7f2:4/p3")).toEqual({ short: "k7f2", section: 4, paragraph: 3, sentence: undefined })
    expect(() => parseAddress("section 4")).toThrow("not an address")
    expect(() => parseAddress("k7f2/p3/s2")).toThrow("not an address")
  })
})
