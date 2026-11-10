import type { Effort, ProtocolBody } from "@opencode/research-record"
import { refOf } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { verify } from "@opencode/research-store"
import { gapsOf } from "./evidence.js"
import { evidenceFor } from "./tier.js"

export type Budgets = ProtocolBody["budgets"]

/** One setting sets every budget, and the setting is written into the protocol so two runs can be compared. */
export function budgetsFor(effort: Effort): Budgets {
  if (effort === "fast") return { subquestions: 2, sourcesPerSubquestion: 3, readFullText: false, gapRounds: 1 }
  if (effort === "deep") return { subquestions: 8, sourcesPerSubquestion: 20, readFullText: true, gapRounds: 4 }
  return { subquestions: 4, sourcesPerSubquestion: 8, readFullText: true, gapRounds: 2 }
}

export type GapKind = "unanswered" | "unevidenced" | "abstract-only" | "disclosed"

export interface ResearchGap {
  readonly kind: GapKind
  readonly subquestion?: string
  readonly detail: string
  readonly howToClose?: string
}

export interface Stopping {
  readonly exitCode: 0 | 1 | 2
  readonly gaps: readonly ResearchGap[]
  readonly reason: string
}

/** Answered plus disclosed must equal asked. A run cannot end by going quiet about a sub-question. */
export function stopping(store: Store, run: string): Stopping {
  const gaps = openGaps(store, run)
  const record = verify(store)
  if (!record.ok) {
    return {
      exitCode: 2,
      gaps,
      reason: `the record failed verification at ${record.issues.length} ${record.issues.length === 1 ? "item" : "items"}`,
    }
  }
  if (gaps.length > 0) return { exitCode: 1, gaps, reason: `${gaps.length} open ${gaps.length === 1 ? "item" : "items"}` }
  return { exitCode: 0, gaps: [], reason: "every sub-question is answered" }
}

export function openGaps(store: Store, run: string): ResearchGap[] {
  const protocol = latestProtocol(store, run)
  const claims = store.kind("claim").filter((claim) => claim.body.run === run)
  const answered = new Set(claims.flatMap((claim) => (claim.body.scope?.subquestion ? [claim.body.scope.subquestion] : [])))
  const gaps: ResearchGap[] = []

  for (const subquestion of protocol?.body.subquestions ?? []) {
    if (!answered.has(subquestion.id)) {
      gaps.push({
        kind: "unanswered",
        subquestion: subquestion.id,
        detail: `${subquestion.question} has no quoted claim`,
        howToClose: "search for it again, or record a gap that names what was searched",
      })
    }
  }

  for (const claim of claims) {
    if (evidenceFor(store, refOf(claim)).length === 0) {
      gaps.push({
        kind: "unevidenced",
        subquestion: claim.body.scope?.subquestion,
        detail: `the claim "${claim.body.text}" has no evidence`,
        howToClose: "attach a fragment, or remove the claim",
      })
    }
  }

  for (const claim of claims) {
    for (const link of evidenceFor(store, refOf(claim))) {
      if (link.body.target.kind !== "fragment") continue
      const fragment = store.find(link.body.target.fragment)
      if (fragment?.kind !== "fragment") continue
      if (fragment.body.flags.includes("abstract-only")) {
        gaps.push({
          kind: "abstract-only",
          subquestion: claim.body.scope?.subquestion,
          detail: `"${fragment.body.quote.slice(0, 80)}" comes from an abstract`,
          howToClose: "add the full text of that work",
        })
      }
    }
  }

  for (const gap of gapsOf(store, run)) {
    gaps.push({ kind: "disclosed", subquestion: gap.subquestion, detail: gap.why, howToClose: gap.howToClose })
  }
  return gaps
}

export function latestProtocol(store: Store, run: string) {
  return store.kind("protocol").filter((protocol) => protocol.body.run === run).at(-1)
}

export interface NextStep {
  readonly instruction: string
  readonly remaining: readonly string[]
}

/** What the research agent is told next, given the protocol and the gaps. The plugin bounds the loop, not the model. */
export function nextStep(store: Store, run: string): NextStep {
  const gaps = openGaps(store, run).filter((gap) => gap.kind !== "disclosed")
  const remaining = [...new Set(gaps.flatMap((gap) => (gap.subquestion ? [gap.subquestion] : [])))]
  if (remaining.length === 0) return { instruction: "Every sub-question is answered. Write the answer from the claims.", remaining }
  return {
    instruction: [
      `Open sub-questions: ${remaining.join(", ")}.`,
      `Send one reader per open sub-question. Each reader searches, adds what it finds, reads the full text, quotes the passages that bear on the question, and writes claims.`,
      `If a sub-question cannot be answered, record a gap with evidence.gap that states what was searched, where and when, and how to close it.`,
    ].join("\n"),
    remaining,
  }
}

