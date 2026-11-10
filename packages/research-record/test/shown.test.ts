import { describe, expect, test } from "bun:test"
import { digest } from "../src/digest.js"
import { cut } from "../src/fragment.js"
import { deriveShownSet, parsePassages, wasShown, wrapPassage, wrapPassages } from "../src/shown.js"

const text = "Union decline explains about a fifth of the rise in wage inequality."
const bytes = new TextEncoder().encode(text)
const representation = { kind: "representation" as const, id: digest({ representation: 1 }) }

const fragment = cut({ representation, text: bytes, start: 0, end: 9, address: "k7f2:1/p0/s1" })

const call = (content: string) => {
  const blob = digest({ content })
  return { blob, call: { contents: [blob] } }
}

describe("the shown set", () => {
  test("a passage round trips through its marker", () => {
    const passage = { address: "k7f2:4/p3/s2", text: "Two sentences. Of the passage." }
    expect(parsePassages(wrapPassage(passage))).toEqual([passage])
  })

  test("several passages in one content are each read back", () => {
    const passages = [
      { address: "k7f2:1/p0/s1", text: "first" },
      { address: "k7f2:1/p1/s1", text: "second" },
    ]
    expect(parsePassages(wrapPassages(passages))).toEqual(passages)
  })

  test("a phrase that looks like a marker but is not closed is ignored", () => {
    expect(parsePassages("[research:k7f2:1/p0/s1]unclosed")).toEqual([])
  })

  test("a passed passage is shown when its text sits intact in a recorded call", () => {
    const recorded = call(wrapPassage({ address: fragment.address, text }))
    const shown = deriveShownSet({ calls: [recorded.call], read: (blob) => (blob === recorded.blob ? wrapPassage({ address: fragment.address, text }) : undefined) })
    expect(wasShown(shown, fragment)).toBe(true)
  })

  test("a quote that was never in the call is not shown", () => {
    const recorded = call(wrapPassage({ address: fragment.address, text: "A different passage about wages." }))
    const shown = deriveShownSet({ calls: [recorded.call], read: () => wrapPassage({ address: fragment.address, text: "A different passage about wages." }) })
    expect(wasShown(shown, fragment)).toBe(false)
  })

  test("a passage shown under another address does not count", () => {
    const other = { ...fragment, address: "k7f2:9/p9/s9" }
    const recorded = call(wrapPassage({ address: "k7f2:1/p0/s1", text }))
    const shown = deriveShownSet({ calls: [recorded.call], read: () => wrapPassage({ address: "k7f2:1/p0/s1", text }) })
    expect(wasShown(shown, other)).toBe(false)
  })

  test("a call whose content blob is gone shows nothing", () => {
    const recorded = call(wrapPassage({ address: fragment.address, text }))
    const shown = deriveShownSet({ calls: [recorded.call], read: () => undefined })
    expect(wasShown(shown, fragment)).toBe(false)
  })

  test("two calls that show the same address keep both texts", () => {
    const one = call(wrapPassage({ address: "k7f2:1/p0/s1", text: "first rendering" }))
    const two = call(wrapPassage({ address: "k7f2:1/p0/s1", text: "second rendering" }))
    const blobs = new Map([
      [one.blob, wrapPassage({ address: "k7f2:1/p0/s1", text: "first rendering" })],
      [two.blob, wrapPassage({ address: "k7f2:1/p0/s1", text: "second rendering" })],
    ])
    const shown = deriveShownSet({ calls: [one.call, two.call], read: (blob) => blobs.get(blob) })
    expect(shown.passages.get("k7f2:1/p0/s1")).toEqual(["first rendering", "second rendering"])
  })
})
