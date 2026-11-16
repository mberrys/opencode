export type StoreErrorCode =
  | "invalid-argument"
  | "store-mismatch"
  | "unsupported-schema"
  | "writer-busy"
  | "store-closed"
  | "store-corrupt"
  | "blob-corrupt"
  | "blob-missing"
  | "blob-unreferenced"
  | "size-mismatch"
  | "unknown-revision"
  | "idempotency-conflict"

/** A refusal or failure of the store. A refused commit writes nothing and consumes no sequence number. */
export class StoreError extends Error {
  readonly code: StoreErrorCode
  readonly detail: unknown

  constructor(code: StoreErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = "StoreError"
    this.code = code
    this.detail = detail
  }
}

export function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
