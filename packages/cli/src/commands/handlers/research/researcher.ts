import { confirm, isCancel } from "@clack/prompts"
import { Add, Receipt } from "@opencode/research-library"
import { type Graph, Ref, ResearchRecord } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import path from "node:path"
import { OPENCODE_VERSION } from "../../../version"

/**
 * How a ruling is confirmed. Only a person at a terminal can answer the prompt, so `tty` is recorded only when both
 * stdin and stdout are terminals and the prompt was answered yes; no flag or variable can claim it.
 */
export interface Terminal {
  readonly interactive: () => boolean
  readonly confirm: (message: string) => Promise<boolean>
}

export const terminal: Terminal = {
  interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: async (message) => {
    const answer = await confirm({ message, initialValue: false })
    return !isCancel(answer) && answer === true
  },
}

export type Ruling = "adopt" | "reject"

/**
 * Records the researcher's adoption ruling on a claim's newest revision, naming the evidence they were shown. A ruling
 * is written only when confirmed at a terminal: an unattested one counts for nothing toward a tier, and an agent can
 * run this command too, so outside a terminal it is refused rather than recorded.
 */
export async function rule(
  store: Store.Store,
  input: { readonly claim: string; readonly ruling: Ruling; readonly reason: string; readonly researcher: string },
  prompt: Terminal,
) {
  const graph = store.graph()
  const claim = graph.heads(graph.lastSeq).find((entry) => entry.revision.objectId === input.claim)?.revision
  if (claim?.kind !== "claim") throw new Error(`no claim has the id ${input.claim}`)
  const evidence = graph
    .heads(graph.lastSeq)
    .flatMap((entry) =>
      entry.revision.kind === "evidence" && Ref.equals(entry.revision.body.claim, ResearchRecord.refOf(claim))
        ? [entry.revision]
        : [],
    )
    .toSorted((a, b) => Ref.compare(ResearchRecord.refOf(a), ResearchRecord.refOf(b)))
  const surface = `opencode research ${input.ruling}`
  if (!prompt.interactive())
    throw new Error(
      `${surface} records a ruling only when you confirm it at a terminal; an unattested ruling would count for nothing`,
    )
  const shown = [
    `${input.ruling === "adopt" ? "Adopt" : "Reject"} claim ${claim.objectId} at revision ${claim.revisionId}:`,
    `  "${claim.body.text}"`,
    evidence.length === 0 ? "with no evidence read." : `having read ${evidence.length} pieces of evidence:`,
    ...evidence.map((item) => `  - ${item.body.role} ${item.objectId}: ${summary(graph, item)}`),
    ...(input.reason === "" ? [] : [`Reason: ${input.reason}`]),
    "Record this ruling as yours?",
  ].join("\n")
  if (!(await prompt.confirm(shown))) return undefined
  const started = new Date().toISOString()
  const body = {
    type: "adoption" as const,
    reason: input.reason,
    attestation: { level: "tty" as const, surface },
    claim: ResearchRecord.refOf(claim),
    evidence: evidence.map(ResearchRecord.refOf),
    ruling: input.ruling,
  }
  // A decision's object id is derived from the claim, so a later ruling on the same claim revises the earlier one.
  const objectId = ResearchRecord.decisionObjectId(body)
  const previous = store.latest(objectId)
  const decision = ResearchRecord.create({
    projectId: store.projectId,
    kind: "decision",
    schema: "decision@1",
    objectId,
    parent: previous === undefined ? "none" : ResearchRecord.refOf(previous),
    author: { voice: "researcher", id: input.researcher },
    context: "none",
    body,
  })
  const written = Receipt.command(
    store,
    actor(input.researcher),
    started,
    { command: `research.${input.ruling}`, input: { claim: input.claim, reason: input.reason } },
    [decision],
  )
  return { decision: ResearchRecord.refOf(decision), receipt: written.receipt }
}

/**
 * Adds a file or a URL to the library as the researcher. A title they give is their own citation field: attested
 * when they confirm it at a terminal, and otherwise recorded unattested, which the citation ignores until a later
 * attested title. Declining the prompt writes nothing.
 */
export async function add(
  store: Store.Store,
  input: { readonly target: string; readonly title?: string; readonly researcher: string; readonly cwd: string },
  prompt: Terminal,
) {
  const url = /^https?:\/\//i.test(input.target) ? input.target : undefined
  const file = url === undefined ? path.resolve(input.cwd, input.target) : undefined
  const interactive = input.title !== undefined && prompt.interactive()
  if (
    interactive &&
    !(await prompt.confirm(`Add ${url ?? file} and record "${input.title}" as its title, as your own citation field?`))
  )
    return undefined
  return Add.add(
    store,
    { ...(url === undefined ? { file } : { url }), ...(input.title === undefined ? {} : { title: input.title }) },
    {
      ...actor(input.researcher),
      // The researcher asked for this URL themselves, so every request it makes, redirects included, is theirs.
      allow: () => true,
      attestation: { level: interactive ? "tty" : "unattested", surface: "opencode research add" },
    },
  )
}

/** The researcher at a terminal, outside any run. */
export function actor(researcher: string): Receipt.Actor {
  return {
    program: `opencode@${OPENCODE_VERSION}`,
    context: {
      run: "none",
      session: "none",
      message: "none",
      call: "none",
      initiator: { voice: "researcher", id: researcher },
    },
  }
}

/** The researcher's name as the record shows it: the account running the command. */
export function researcher() {
  return process.env.USER ?? process.env.USERNAME ?? "researcher"
}

/** What an evidence link rests on, as one line: its first quote, or the computation it cites. */
function summary(graph: Graph.Graph, evidence: ResearchRecord.Revision<"evidence">) {
  const basis = evidence.body.basis
  if (basis.kind === "computation") return `the computation ${basis.output.objectId}`
  return basis.cited.map((cited) => `"${graph.get(cited.fragment, "fragment").body.selector.quote}"`).join(" ")
}
