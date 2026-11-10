import { resolve } from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import {
  type Effort,
  type Json,
  type Ref,
  makeRecord,
  refOf,
  wrapPassage,
} from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import { addSource, cites, grep, outline, read, search } from "@opencode/research-library"
import { cardOf, claim, check, gap, quote, record } from "./evidence.js"
import { resolveRun } from "./tier.js"
import { budgetsFor, openGaps, stopping } from "./loop.js"

export interface Workspace {
  readonly store: Store
  readonly session: string
  readonly run: string
  readonly actor: { voice: "agent"; id: string }
}

const ErrorText = (error: unknown) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) })

export function installTools(ctx: Pick<Context, "tool" | "permission" | "location">, open: () => Store) {
  const workspace = (tool: Tool.Context): Workspace => {
    const store = open()
    return {
      store,
      session: tool.sessionID,
      // Readers and writers work in child sessions; the protocol names the run they all join.
      run: resolveRun(store, tool.sessionID),
      actor: { voice: "agent", id: tool.agent },
    }
  }

  const execute = <T>(tool: Tool.Context, run: () => T, content: (value: T) => string) =>
    Effect.map(Effect.try({ try: run, catch: ErrorText }), (value) => ({ output: value, content: content(value) }))

  const passages = (result: { sentences: readonly { address: string; text: string }[] }) =>
    result.sentences.map((sentence) => wrapPassage({ address: sentence.address, text: sentence.text })).join("\n\n")

  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "library",
      description:
        "The documents this project holds. Addresses name a sentence as k7f2:1/p1/s2. Every passage comes back with its address, and a quote is cut by that address.",
    })
    editor.namespace({
      name: "evidence",
      description:
        "The record. Cut fragments, write claims, record gaps and recheck the whole record. A claim is refused unless this session was shown the fragment.",
    })
    editor.namespace({
      name: "research",
      description: "The run: write the protocol, read the open gaps, compose the answer.",
    })

    editor.add({
      name: "find",
      description:
        "Search OpenAlex for works matching a query. Returns titles, years, DOIs and whether an open copy exists. Writes a search receipt.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        query: Schema.String.annotate({ description: "Keywords or a phrase, in the field's own vocabulary." }),
        limit: Schema.optional(Schema.Number.annotate({ description: "How many works to return, up to 50." })),
      }),
      execute: (input, tool) =>
        Effect.map(
          Effect.tryPromise({
            try: async () => {
              const ws = workspace(tool)
              const works = await findWorks(input.query, input.limit ?? 20)
              record(ws, "library.find", input as Json, [], () => works)
              return works
            },
            catch: ErrorText,
          }),
          (works) => ({
            output: works,
            content: works
              .map((work) => `- ${work.title} (${work.year ?? "n.d."})${work.doi ? ` doi:${work.doi}` : ""}${work.openAccess ? " [open access]" : ""}`)
              .join("\n") || "no works matched",
          }),
        ),
    })

    editor.add({
      name: "add",
      description:
        "Acquire a DOI, URL or file: store the bytes, extract the text and build the structure tree. A PDF is stored but text extraction is not built yet.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        doi: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        file: Schema.optional(Schema.String.annotate({ description: "Path on the machine that runs OpenCode." })),
        title: Schema.optional(Schema.String),
      }),
      execute: (input, tool) =>
        Effect.gen(function* () {
          // Reading a file or fetching a URL outside the permission system would bypass the session's rules.
          // A relative path names a file in the project, not in whatever directory the server was started from.
          const file = input.file ? resolve(ctx.location.directory, input.file) : undefined
          if (file)
            yield* ctx.permission.assert({
              sessionID: tool.sessionID,
              agent: tool.agent,
              action: "read",
              resources: [file],
              save: ["*"],
            })
          if (input.url)
            yield* ctx.permission.assert({
              sessionID: tool.sessionID,
              agent: tool.agent,
              action: "webfetch",
              resources: [input.url],
              save: ["*"],
            })
          const ws = workspace(tool)
          const added = yield* Effect.tryPromise({
            try: () => addSource(ws.store, { ...input, ...(file ? { file } : {}) }),
            catch: ErrorText,
          })
          record(ws, "library.add", input as Json, [], () => added)
          return {
            output: added,
            content: [
              `added ${added.title}`,
              `source ${added.source.kind}:${added.source.id}`,
              added.representation ? "text extracted" : "no text extracted",
              ...added.notes,
            ].join("\n"),
          }
        }),
    })

    editor.add({
      name: "outline",
      description: "A document's sections, with how many paragraphs and sentences each holds.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({ source: Schema.String.annotate({ description: "A source ref: source:sha256:... or a unique prefix." }) }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const ref = ws.store.resolve(input.source)
            if (ref.kind !== "source") throw new Error(`${input.source} is not a source`)
            const result = outline(ws.store, ref)
            record(ws, "library.outline", input as Json, [], () => result)
            return result
          },
          (result) =>
            [
              `${result.title} (${result.short})`,
              ...result.sections.map(
                (section) => `${section.section}. ${section.heading} — ${section.paragraphs} paragraphs, ${section.sentences} sentences`,
              ),
              result.note,
            ]
              .filter(Boolean)
              .join("\n"),
        ),
    })

    editor.add({
      name: "read",
      description: "Read a document by source or by address. Every sentence comes back with its address.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        source: Schema.optional(Schema.String),
        address: Schema.optional(Schema.String.annotate({ description: "k7f2:1/p2/s1" })),
        section: Schema.optional(Schema.Number),
        limit: Schema.optional(Schema.Number),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const result = read(ws.store, {
              ...(input.source ? { source: sourceRef(ws.store, input.source) } : {}),
              ...(input.address ? { address: input.address } : {}),
              ...(input.section === undefined ? {} : { section: input.section }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            record(ws, "library.read", input as Json, [], () => result)
            return result
          },
          (result) => passages(result),
        ),
    })

    editor.add({
      name: "grep",
      description: "Exact words or a pattern across every stored text.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        pattern: Schema.String,
        source: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const result = grep(ws.store, {
              pattern: input.pattern,
              ...(input.source ? { source: sourceRef(ws.store, input.source) } : {}),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            record(ws, "library.grep", input as Json, [], () => result)
            return result
          },
          (result) => passages({ sentences: result.hits }) || "no matches",
        ),
    })

    editor.add({
      name: "search",
      description: "The paragraphs that best match a query, ranked lexically. Each hit is already an exact span with an address.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        query: Schema.String,
        source: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const result = search(ws.store, {
              query: input.query,
              ...(input.source ? { source: sourceRef(ws.store, input.source) } : {}),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            record(ws, "library.search", input as Json, [], () => result)
            return result
          },
          (result) => passages({ sentences: result.hits }) || "no matches",
        ),
    })

    editor.add({
      name: "cites",
      description: "A document's reference list as printed.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({ source: Schema.String }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const result = cites(ws.store, sourceRef(ws.store, input.source))
            record(ws, "library.cites", input as Json, [], () => result)
            return result
          },
          (result) => result.entries.map((entry) => `[${entry.address}] ${entry.text}`).join("\n") || result.note,
        ),
    })

    editor.add({
      name: "quote",
      description:
        "Cut a fragment by address and return its card: the quote, the words around it, the citation and any flags. The passage comes back marked so the session has seen it.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        address: Schema.String.annotate({ description: "The address of the first sentence, such as k7f2:1/p2/s1." }),
        sentences: Schema.optional(Schema.Number.annotate({ description: "How many consecutive sentences to cut, up to 20." })),
        secondary: Schema.optional(Schema.Boolean.annotate({ description: "The quote is one work summarizing another." })),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => quote(workspace(tool), input),
          (result) =>
            [
              wrapPassage({ address: result.card.address, text: result.card.before + result.card.quote + result.card.after }),
              `fragment ${result.fragment.kind}:${result.fragment.id}`,
              `citation ${result.card.title} (${result.card.citation})`,
              result.card.flags.length ? `flags ${result.card.flags.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
        ),
    })

    editor.add({
      name: "claim",
      description:
        "Write a claim and link it to fragments. Refused when a fragment was never shown to this session, so quote first.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        text: Schema.String,
        evidence: Schema.Array(
          Schema.Struct({
            fragment: Schema.String,
            role: Schema.Literals(["supports", "challenges", "qualifies", "contextualizes"]),
          }),
        ),
        subquestion: Schema.optional(Schema.String),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () =>
            claim(workspace(tool), {
              text: input.text,
              evidence: input.evidence,
              ...(input.subquestion ? { scope: { subquestion: input.subquestion } } : {}),
            }),
          (result) => `claim ${result.claim.kind}:${result.claim.id}\ntier ${result.tier.tier}${result.tier.flags.length ? ` (${result.tier.flags.join(", ")})` : ""}`,
        ),
    })

    editor.add({
      name: "gap",
      description:
        "Record what could not be answered: what was searched, where and when, and how to close it. A gap without its searches is refused.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        subquestion: Schema.String,
        searched: Schema.Array(Schema.String),
        why: Schema.String,
        howToClose: Schema.String,
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => gap(workspace(tool), input),
          (result) => `gap recorded on receipt ${result.receipt.kind}:${result.receipt.id}`,
        ),
    })

    editor.add({
      name: "verify",
      description: "Recheck the chain, every stored file, every quote, every citation and the shown set. No model and no network.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({}),
      execute: (_input, tool) =>
        execute(
          tool,
          () => check(workspace(tool)),
          (result) =>
            [
              result.record.ok ? "record verifies" : "record failed verification",
              ...result.record.issues.map((issue) => `${issue.check} ${issue.target}: ${issue.detail}`),
              result.replay.ok ? "replay passes" : `replay: ${result.replay.unverifiable} unverifiable`,
            ].join("\n"),
        ),
    })

    editor.add({
      name: "protocol",
      description:
        "Write the protocol before searching: the question, scope, sub-questions and effort. The record's chain then proves the criteria came first.",
      options: { namespace: "research", permission: "research" },
      input: Schema.Struct({
        question: Schema.String,
        inScope: Schema.Array(Schema.String),
        outOfScope: Schema.Array(Schema.String),
        subquestions: Schema.Array(Schema.Struct({ id: Schema.String, question: Schema.String })),
        effort: Schema.Literals(["fast", "balanced", "deep"]),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const at = new Date().toISOString()
            // A fresh run id, so a second question in this session cannot inherit the first run's claims.
            const run = `run_${Date.now().toString(36)}`
            const protocol = makeRecord({
              kind: "protocol",
              at,
              author: ws.actor,
              session: ws.session,
              body: {
                question: input.question,
                scope: { in: input.inScope, out: input.outOfScope },
                subquestions: input.subquestions,
                effort: input.effort as Effort,
                budgets: budgetsFor(input.effort as Effort),
                run,
              },
            })
            ws.store.commit([protocol], { at })
            record(ws, "research.protocol", input as Json, [protocol], () => ({ protocol: refOf(protocol), run }))
            return { protocol: refOf(protocol), run }
          },
          (result) => `protocol ${result.protocol.kind}:${result.protocol.id}
run ${result.run}`,
        ),
    })

    editor.add({
      name: "status",
      description: "The open gaps and the exit code the run would have now.",
      options: { namespace: "research", permission: "research" },
      input: Schema.Struct({}),
      execute: (_input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            return { stopping: stopping(ws.store, ws.run), gaps: openGaps(ws.store, ws.run) }
          },
          (result) =>
            [
              `exit ${result.stopping.exitCode}: ${result.stopping.reason}`,
              ...result.gaps.map((item) => `- ${item.kind}${item.subquestion ? ` ${item.subquestion}` : ""}: ${item.detail}`),
            ].join("\n"),
        ),
    })

    editor.add({
      name: "answer",
      description: "Compose the answer artifact from sentences and the claims they rest on. The program numbers citations.",
      options: { namespace: "research", permission: "research" },
      input: Schema.Struct({
        sentences: Schema.Array(Schema.Struct({ text: Schema.String, claim: Schema.optional(Schema.String) })),
      }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const sentences = input.sentences.map((sentence) => {
              if (!sentence.claim) return { text: sentence.text }
              const ref = ws.store.resolve(sentence.claim)
              if (ref.kind !== "claim") throw new Error(`${sentence.claim} is not a claim`)
              return { text: sentence.text, claim: ref }
            })
            const at = new Date().toISOString()
            const answer = makeRecord({
              kind: "artifact",
              at,
              author: { voice: "program" },
              session: ws.session,
              body: {
                type: "answer",
                run: ws.run,
                mediaType: "text/markdown",
                sentences,
                inputs: sentences.flatMap((sentence) => (sentence.claim ? [sentence.claim as Ref] : [])),
              },
            })
            ws.store.commit([answer], { at })
            record(ws, "research.answer", input as Json, [answer], () => ({ answer: refOf(answer) }))
            return { answer: refOf(answer) }
          },
          (result) => `answer ${result.answer.kind}:${result.answer.id}`,
        ),
    })

    editor.add({
      name: "card",
      description: "Show one fragment as a card: the quote in context, its citation, tier and flags.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({ fragment: Schema.String }),
      execute: (input, tool) =>
        execute(
          tool,
          () => {
            const ws = workspace(tool)
            const ref = ws.store.resolve(input.fragment)
            if (ref.kind !== "fragment") throw new Error(`${input.fragment} is not a fragment`)
            return cardOf(ws.store, ref)
          },
          (card) =>
            [
              wrapPassage({ address: card.address, text: card.before + card.quote + card.after }),
              `${card.title} (${card.citation})`,
              `fragment ${card.fragment.kind}:${card.fragment.id}`,
              card.flags.length ? `flags ${card.flags.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
        ),
    })
  })
}

function sourceRef(store: Store, value: string): Ref {
  const ref = store.resolve(value)
  if (ref.kind !== "source") throw new Error(`${value} is not a source`)
  return ref
}

export interface FoundWork {
  readonly title: string
  readonly doi?: string
  readonly year?: number
  readonly openAccess?: boolean
  readonly citedBy?: number
}

/** OpenAlex indexes works, so the project builds no index of its own for finding documents. */
export async function findWorks(query: string, limit: number): Promise<FoundWork[]> {
  const url = new URL("https://api.openalex.org/works")
  url.searchParams.set("search", query)
  url.searchParams.set("per-page", String(Math.min(Math.max(limit, 1), 50)))
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": "opencode-research/1" } })
  if (!response.ok) throw new Error(`OpenAlex returned ${response.status}`)
  const body = (await response.json()) as {
    results?: {
      title?: string
      doi?: string
      publication_year?: number
      cited_by_count?: number
      open_access?: { is_oa?: boolean }
    }[]
  }
  return (body.results ?? []).flatMap((work) =>
    work.title
      ? [
          {
            title: work.title,
            ...(work.doi ? { doi: work.doi.replace(/^https:\/\/doi\.org\//, "") } : {}),
            ...(work.publication_year ? { year: work.publication_year } : {}),
            ...(work.cited_by_count === undefined ? {} : { citedBy: work.cited_by_count }),
            ...(work.open_access?.is_oa ? { openAccess: true } : {}),
          },
        ]
      : [],
  )
}
