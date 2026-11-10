import { EOL } from "node:os"
import type { Session } from "@opencode/research"
import { Store } from "@opencode/research-store"

export function open(directory: string | undefined = process.cwd()): { store: Store; directory: string } {
  return { store: Store.open(directory), directory }
}

export function print(text: string): void {
  process.stdout.write(text + EOL)
}

export function researcher(store: Store): Session {
  return {
    store,
    session: "cli",
    run: "cli",
    actor: { voice: "researcher", id: process.env.USERNAME ?? process.env.USER ?? "researcher" },
  }
}

export function reason(value: string | undefined): { reason?: string } {
  return value ? { reason: value } : {}
}
