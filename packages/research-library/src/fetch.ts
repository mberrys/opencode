export * as Fetch from "./fetch.js"

export interface Options {
  /** Asked before every request, the first and each redirect, so a redirect cannot reach a URL the caller would refuse. */
  readonly allow: (url: URL) => boolean | Promise<boolean>
  readonly fetch?: typeof fetch
  /** The most bytes a body may have. A longer one is cancelled and refused, never buffered whole. */
  readonly maxBytes?: number
  readonly maxRedirects?: number
  readonly timeoutMs?: number
}

export interface Fetched {
  /** The URL that answered, after redirects. */
  readonly url: URL
  readonly mediaType: string
  readonly bytes: Uint8Array
}

export class FetchError extends Error {
  constructor(
    readonly code: "refused" | "too-large" | "too-many-redirects" | "status" | "scheme",
    message: string,
  ) {
    super(message)
    this.name = "FetchError"
  }
}

export const MAX_BYTES = 50 * 1024 * 1024
export const MAX_REDIRECTS = 5

/** GETs `url`, following at most `maxRedirects` redirects itself so each hop is asked for, and caps the body. */
export async function get(url: string | URL, options: Options): Promise<Fetched> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  const follow = async (current: URL, hops: number): Promise<Fetched> => {
    if (current.protocol !== "http:" && current.protocol !== "https:")
      throw new FetchError("scheme", `only http and https URLs are fetched, not ${current.protocol}`)
    if (!(await options.allow(current))) throw new FetchError("refused", `fetching ${current.href} is not allowed`)
    const response = await (options.fetch ?? fetch)(current, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "opencode-research/1" },
    })
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel()
      if (hops >= (options.maxRedirects ?? MAX_REDIRECTS))
        throw new FetchError(
          "too-many-redirects",
          `${url} redirected more than ${options.maxRedirects ?? MAX_REDIRECTS} times`,
        )
      return follow(new URL(location, current), hops + 1)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new FetchError("status", `fetching ${current.href} returned ${response.status}`)
    }
    return {
      url: current,
      mediaType: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
      bytes: await capped(response, options.maxBytes ?? MAX_BYTES, current),
    }
  }
  return follow(new URL(url), 0)
}

async function capped(response: Response, maxBytes: number, url: URL) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new FetchError("too-large", `${url.href} is ${declared} bytes; the limit is ${maxBytes}`)
  }
  if (response.body === null) return new Uint8Array()
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  // A server may send more than it declared, so the limit is enforced on what arrives.
  for (let total = 0, read = await reader.read(); !read.done; read = await reader.read()) {
    total += read.value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new FetchError("too-large", `${url.href} sent more than ${maxBytes} bytes`)
    }
    chunks.push(read.value)
  }
  return Buffer.concat(chunks)
}
