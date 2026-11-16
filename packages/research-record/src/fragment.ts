export * as Fragment from "./fragment.js"

import { Canonical, ContractError } from "./canonical.js"
import { Graph } from "./graph.js"
import { ResearchRecord } from "./record.js"
import { Ref } from "./ref.js"

export interface Verified {
  readonly quote: string
  readonly quoteDigest: Canonical.Digest
  readonly representationDigest: Canonical.Digest
}

/**
 * Checks a quote against the stored text, byte for byte. No normalization, no remap and no judgment of support. The
 * caller supplies the representation's bytes: this function reads no files. A fragment in a graph, or a bare selector
 * (a lens category's defining passage, which belongs to no project), are checked the same way.
 */
export function verify(
  input:
    | { readonly graph: Graph.Graph; readonly fragment: Ref.Exact; readonly bytes: Uint8Array }
    | {
        readonly representationDigest: Canonical.Digest
        readonly selector: ResearchRecord.Selector
        readonly bytes: Uint8Array
      },
): Verified {
  const target =
    "graph" in input
      ? inGraph(input.graph, input.fragment)
      : { representationDigest: input.representationDigest, selector: ResearchRecord.parseSelector(input.selector) }
  if (Canonical.blobDigest(input.bytes) !== target.representationDigest)
    throw new ContractError("digest-mismatch", "the representation's bytes do not match its digest")
  const bytes = input.bytes
  const selector = target.selector
  const boundary = (offset: number) => offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80
  if (
    selector.start >= selector.end ||
    selector.end > bytes.length ||
    !boundary(selector.start) ||
    !boundary(selector.end)
  )
    throw new ContractError(
      "selector-mismatch",
      "a selector is a non-empty span inside the text, on code point boundaries",
    )
  if (!valid(bytes)) throw new ContractError("selector-mismatch", "the representation is not valid UTF-8 text")
  const span = bytes.subarray(selector.start, selector.end)
  if (!Buffer.from(span).equals(Buffer.from(selector.quote, "utf8")))
    throw new ContractError("selector-mismatch", "the quote does not equal the stored bytes")
  return {
    quote: selector.quote,
    quoteDigest: Canonical.blobDigest(span),
    representationDigest: target.representationDigest,
  }
}

function inGraph(graph: Graph.Graph, ref: Ref.Exact) {
  const fragment = graph.get(ref, "fragment")
  const representation = graph.get(fragment.body.representation, "representation")
  if (representation.body.blob !== fragment.body.representationDigest)
    throw new ContractError("digest-mismatch", "the fragment's representation digest is not its representation's blob")
  return {
    representationDigest: fragment.body.representationDigest as Canonical.Digest,
    selector: fragment.body.selector,
  }
}

/** The whole text must be valid UTF-8, including bytes outside the selected span. */
function valid(bytes: Uint8Array) {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}
