import type { Digest } from "./digest.js"
import type { FragmentBody } from "./record.js"

export interface Passage {
  readonly address: string
  readonly text: string
}

export const MARKER_PREFIX = "research:"

export function wrapPassage(passage: Passage): string {
  return `[${MARKER_PREFIX}${passage.address}]${passage.text}[/${MARKER_PREFIX}${passage.address}]`
}

export function wrapPassages(passages: readonly Passage[]): string {
  return passages.map(wrapPassage).join("\n\n")
}

/** Parses the markers a library tool wrote, so a recorded call can be read back for what it showed. */
export function parsePassages(content: string): Passage[] {
  const passages: Passage[] = []
  const pattern = /\[research:([^\]\n]+)\]([\s\S]*?)\[\/research:\1\]/g
  for (const match of content.matchAll(pattern)) {
    passages.push({ address: match[1]!, text: match[2]! })
  }
  return passages
}

export interface ShownSet {
  /** Address to every passage text recorded under it, in call order. */
  readonly passages: ReadonlyMap<string, readonly string[]>
}

export interface ModelCallContent {
  readonly contents: readonly Digest[]
}

/**
 * A passage is shown when it appears intact inside a recorded model call. Deriving this from the calls, rather
 * than tracking it beside them, means a crash cannot leave the two out of step.
 */
export function deriveShownSet(input: {
  readonly calls: readonly ModelCallContent[]
  readonly read: (digest: Digest) => string | undefined
}): ShownSet {
  const passages = new Map<string, string[]>()
  for (const call of input.calls) {
    for (const content of call.contents) {
      const text = input.read(content)
      if (text === undefined) continue
      for (const passage of parsePassages(text)) {
        const existing = passages.get(passage.address)
        if (existing) existing.push(passage.text)
        else passages.set(passage.address, [passage.text])
      }
    }
  }
  return { passages }
}

/** An agent may cite only words that were in front of it, so a quote must sit inside a shown passage. */
export function wasShown(set: ShownSet, fragment: FragmentBody): boolean {
  const texts = set.passages.get(fragment.address)
  if (!texts) return false
  return texts.some((text) => text.includes(fragment.quote))
}
