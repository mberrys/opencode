export * as Tools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Add, Fetch, Find, Receipt } from "@opencode/research-library"
import { Ref } from "@opencode/research-record"
import type { Store } from "@opencode/research-store"
import type { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { Evidence } from "./evidence.js"

export const PROGRAM = "research@2.3.0"

const failure = (error: unknown) =>
  error instanceof Tool.Error
    ? error
    : new Tool.Error({ message: error instanceof Error ? error.message : String(error) })

/** Every passage is fenced and addressed, so text from a source reads as data and is cited by its address. */
const passage = (item: { readonly address: string; readonly text: string }) =>
  `<passage address="${item.address}">\n${item.text}\n</passage>`

export function install(ctx: Pick<Context, "tool" | "permission" | "session" | "location">, store: () => Store.Store) {
  const runOf = (sessionID: Session.ID) =>
    resolveRun(store, sessionID, (id) =>
      ctx.session.get({ sessionID: id }).pipe(
        Effect.map((session) => session.parentID),
        Effect.mapError(failure),
      ),
    )

  // Every tool a Code Mode program calls carries the program's own call id, and a commit key may write only once. So
  // the key numbers the calls made under one call id in this process. A program that runs again after a restart
  // makes the same keys, and its first write is refused as a retry.
  const made = new Map<string, number>()
  const keyOf = (id: string) => {
    const n = made.get(id) ?? 0
    made.set(id, n + 1)
    return `${id}#${n}`
  }

  const callOf = (tool: Tool.Context) =>
    Effect.map(runOf(tool.sessionID), (run) => ({
      program: PROGRAM,
      key: keyOf(tool.id),
      context: {
        run,
        session: tool.sessionID,
        message: tool.messageID,
        call: tool.id,
        initiator: { voice: "agent" as const, id: tool.agent },
      },
    }))

  /** Runs `work` for a tool call; any refusal reaches the agent as the tool's error, with its reason. */
  const run = <T>(tool: Tool.Context, work: (call: Evidence.Call) => T) =>
    Effect.flatMap(callOf(tool), (call) => Effect.try({ try: () => work(call), catch: failure }))

  /** Asks the session's rules before each request, redirects included. A refusal is the tool's error. */
  const allow = (tool: Tool.Context) =>
    Effect.map(
      Effect.context<never>(),
      (context) => (url: URL) =>
        Effect.runPromiseWith(context)(
          ctx.permission
            .assert({
              sessionID: tool.sessionID,
              agent: tool.agent,
              action: "webfetch",
              resources: [url.href],
              save: ["*"],
            })
            .pipe(Effect.as(true)),
        ),
    )

  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "library",
      description:
        "The works this project holds. A passage's address names a sentence as ab12:1/p1/s2; every passage comes back with its address, and a quote is cut by it.",
    })
    editor.namespace({
      name: "evidence",
      description:
        "The record: cut quotes, run computations, write claims and record gaps. A claim is refused unless this session cut the quote or ran the computation it cites.",
    })
    editor.namespace({
      name: "research",
      description: "The run: write the protocol, read what is open, compose the answer.",
    })

    editor.add({
      name: "find",
      description:
        "Search OpenAlex for works matching a query. Returns titles, years and DOIs, and a receipt id a gap can cite.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        query: Schema.String.annotate({ description: "Keywords in the field's own vocabulary." }),
        limit: Schema.optional(Schema.Number.annotate({ description: "How many works, up to 50." })),
      }),
      output: FindOutput,
      execute: (input, tool) =>
        Effect.gen(function* () {
          const call = yield* callOf(tool)
          const started = Receipt.now(call)
          const asked = yield* allow(tool)
          const works = yield* Effect.tryPromise({
            try: () => scholar(input.query, input.limit ?? 20, (url) => asked(url).catch(() => false)),
            catch: failure,
          })
          const written = yield* Effect.try({
            try: () => Receipt.commit(store(), call, started, stored("library.find", input, works), []),
            catch: failure,
          })
          return {
            output: { works, receipt: written.receipt.objectId },
            content: [
              ...works.map(
                (work) => `- ${work.title} (${work.year ?? "n.d."})${work.doi === undefined ? "" : ` doi:${work.doi}`}`,
              ),
              `receipt ${written.receipt.objectId}`,
            ].join("\n"),
          }
        }),
    })

    editor.add({
      name: "add",
      description:
        "Add a work by DOI, URL or file: store its bytes, extract its text and build its structure tree. A PDF is stored, but its text is not extracted yet.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        doi: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        file: Schema.optional(Schema.String.annotate({ description: "A path, relative to the project." })),
        title: Schema.optional(Schema.String),
      }),
      output: AddOutput,
      execute: (input, tool) =>
        Effect.gen(function* () {
          // A relative path names a file in the project, and reading it goes through the session's rules.
          const file = input.file === undefined ? undefined : path.resolve(ctx.location.directory, input.file)
          if (file !== undefined)
            yield* ctx.permission.assert({
              sessionID: tool.sessionID,
              agent: tool.agent,
              action: "read",
              resources: [file],
              save: ["*"],
            })
          const call = yield* callOf(tool)
          const asked = yield* allow(tool)
          const added = yield* Effect.tryPromise({
            try: () =>
              Add.add(
                store(),
                { ...input, ...(file === undefined ? {} : { file }) },
                { ...call, allow: (url) => asked(url).catch(() => false) },
              ),
            catch: failure,
          })
          return {
            output: added,
            content: [
              `${added.status}: source ${added.source.objectId}`,
              added.representation === undefined ? "no text extracted" : "text extracted",
              ...added.notes,
            ].join("\n"),
          }
        }),
    })

    editor.add({
      name: "outline",
      description: "A work's sections, with how many paragraphs and sentences each holds.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({ source: Schema.String.annotate({ description: "A short address, such as ab12." }) }),
      output: OutlineOutput,
      execute: (input, tool) =>
        run(tool, () => Find.outline(store(), input.source)).pipe(
          Effect.map((result) => ({
            output: result,
            content: [
              `${result.title} (${result.short})`,
              ...result.sections.map(
                (item) =>
                  `${item.section}. ${item.heading}: ${item.paragraphs} paragraphs, ${item.sentences} sentences`,
              ),
              result.note,
            ]
              .filter((line) => line !== "")
              .join("\n"),
          })),
        ),
    })

    editor.add({
      name: "read",
      description: "Read a work from an address onwards. Every sentence comes back with its address.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        address: Schema.String.annotate({ description: "ab12, ab12:2 or ab12:2/p3/s1" }),
        limit: Schema.optional(Schema.Number),
      }),
      output: ReadOutput,
      execute: (input, tool) =>
        run(tool, () => Find.read(store(), input)).pipe(
          Effect.map((result) => ({
            output: result,
            content: [...result.sentences.map(passage), result.truncated ? "(more follows)" : "", result.note]
              .filter((line) => line !== "")
              .join("\n\n"),
          })),
        ),
    })

    editor.add({
      name: "grep",
      description:
        "Sentences matching a regular expression across every stored text. Returns a receipt id a gap can cite.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        pattern: Schema.String,
        source: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
      output: GrepOutput,
      execute: (input, tool) =>
        run(tool, (call) => {
          const started = Receipt.now(call)
          const result = Find.grep(store(), input)
          const written = Receipt.commit(store(), call, started, stored("library.grep", input, result), [])
          return { ...result, receipt: written.receipt.objectId }
        }).pipe(
          Effect.map((result) => ({
            output: result,
            content: [
              ...result.hits.map(passage),
              `${result.searched} sentences searched; receipt ${result.receipt}`,
            ].join("\n\n"),
          })),
        ),
    })

    editor.add({
      name: "search",
      description: "Paragraphs ranked by how well they match a query. Returns a receipt id a gap can cite.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({
        query: Schema.String,
        source: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
      output: SearchOutput,
      execute: (input, tool) =>
        run(tool, (call) => {
          const started = Receipt.now(call)
          const result = Find.search(store(), input)
          const written = Receipt.commit(store(), call, started, stored("library.search", input, result), [])
          return { ...result, receipt: written.receipt.objectId }
        }).pipe(
          Effect.map((result) => ({
            output: result,
            content: [
              ...result.hits.map(passage),
              `${result.searched} paragraphs searched; receipt ${result.receipt}`,
            ].join("\n\n"),
          })),
        ),
    })

    editor.add({
      name: "cites",
      description: "A work's reference list, as printed.",
      options: { namespace: "library", permission: "library" },
      input: Schema.Struct({ source: Schema.String }),
      output: CitesOutput,
      execute: (input, tool) =>
        run(tool, () => Find.cites(store(), input.source)).pipe(
          Effect.map((result) => ({
            output: result,
            content: [...result.entries.map(passage), result.note].filter((line) => line !== "").join("\n\n"),
          })),
        ),
    })

    editor.add({
      name: "quote",
      description:
        "Cut a quote by address: the addressed sentence and, with sentences, the ones after it in its paragraph. Returns the fragment id a claim cites.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        address: Schema.String,
        sentences: Schema.optional(Schema.Number.annotate({ description: "How many sentences, 1 to 20." })),
      }),
      output: QuoteOutput,
      execute: (input, tool) =>
        run(tool, (call) => Evidence.quote(store(), call, input)).pipe(
          Effect.map((result) => ({
            output: result,
            content: `fragment ${result.fragment} from ${result.title} at ${result.address}\n${passage({ address: result.address, text: result.quote })}`,
          })),
        ),
    })

    editor.add({
      name: "compute",
      description:
        "Compute a number from named inputs: + - * / ^, parentheses, min, max, abs, sqrt, round. Each input names the fragment this session cut that states it, exactly as written there (35 for 35%). The script and its result are recorded so replay can rerun it. Returns the computation id a claim cites.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        expression: Schema.String.annotate({ description: "Such as (before - after) / before * 100" }),
        inputs: Schema.Record(
          Schema.String,
          Schema.Struct({
            value: Schema.Number,
            fragment: Schema.String.annotate({ description: "The id of the fragment that states this number" }),
          }),
        ).annotate({
          description:
            "Each name in the expression with its number and fragment, such as { before: { value: 35, fragment: <id> } }",
        }),
      }),
      output: ComputeOutput,
      execute: (input, tool) =>
        run(tool, (call) => Evidence.compute(store(), call, input)).pipe(
          Effect.map((result) => ({ output: result, content: `computation ${result.computation}\n${result.result}` })),
        ),
    })

    editor.add({
      name: "claim",
      description:
        "Write a claim in your own words, citing fragments this session cut or computations it ran, each with its role. Name the sub-question it answers.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        text: Schema.String,
        evidence: Schema.Array(
          Schema.Struct({
            fragment: Schema.optional(Schema.String),
            computation: Schema.optional(Schema.String),
            role: Schema.Literals(["supports", "challenges", "qualifies", "contextualizes"]),
          }),
        ),
        subquestion: Schema.optional(Schema.String),
      }),
      output: ClaimOutput,
      execute: (input, tool) =>
        run(tool, (call) => Evidence.claim(store(), call, input)).pipe(
          Effect.map((result) => ({ output: result, content: `claim ${result.claim}` })),
        ),
    })

    editor.add({
      name: "gap",
      description:
        "Record that a sub-question could not be answered: what is missing, the receipt ids of the searches it rests on, and how to close it.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({
        subquestion: Schema.String,
        missing: Schema.String,
        searched: Schema.Array(Schema.String),
        close: Schema.String,
      }),
      output: GapOutput,
      execute: (input, tool) =>
        run(tool, (call) => Evidence.gap(store(), call, input)).pipe(
          Effect.map((result) => ({ output: result, content: `gap ${result.gap}` })),
        ),
    })

    editor.add({
      name: "check",
      description: "Recheck the whole record and replay this run's receipts.",
      options: { namespace: "evidence", permission: "evidence" },
      input: Schema.Struct({}),
      output: CheckOutput,
      execute: (_input, tool) =>
        run(tool, (call) => Evidence.check(store(), call.context.run === "none" ? undefined : call.context.run)).pipe(
          Effect.map((result) => ({
            output: result,
            content: [
              result.record.ok ? "the record verifies" : `${result.record.problems.length} problems in the record`,
              `replay: ${result.replay.entries.length} steps, ${result.replay.mismatches} mismatches, ${result.replay.unverifiable} unverifiable`,
            ].join("\n"),
          })),
        ),
    })

    editor.add({
      name: "protocol",
      description:
        "Start a run: the question, scope, sub-questions, criteria, plan and effort, written before searching.",
      options: { namespace: "research", permission: "research" },
      input: Schema.Struct({
        question: Schema.String,
        scope: Schema.Struct({ in: Schema.Array(Schema.String), out: Schema.Array(Schema.String) }),
        subquestions: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
        criteria: Schema.Array(Schema.String),
        plan: Schema.String,
        effort: Schema.Literals(["fast", "standard", "deep"]),
      }),
      output: ProtocolOutput,
      execute: (input, tool) =>
        run(tool, (call) => Evidence.protocol(store(), call, input)).pipe(
          Effect.map((result) => ({ output: result, content: `protocol ${result.protocol} starts ${result.run}` })),
        ),
    })

    editor.add({
      name: "status",
      description:
        "What this run still owes: sub-questions with neither a claim nor a gap, and claims with no evidence.",
      options: { namespace: "research", permission: "research" },
      input: Schema.Struct({}),
      output: StatusOutput,
      execute: (_input, tool) =>
        run(tool, (call) => Evidence.status(store().graph(), call.context.run)).pipe(
          Effect.map((result) => ({
            output: result,
            content:
              result.protocol === undefined
                ? "no protocol yet: write one with research_protocol"
                : [
                    `${result.question}: ${result.claims} claims, ${result.gaps} gaps`,
                    ...result.open.map((item) => `- ${item.detail}. To close: ${item.close}.`),
                    result.open.length === 0 ? "nothing is open" : "",
                  ]
                    .filter((line) => line !== "")
                    .join("\n"),
          })),
        ),
    })

    editor.add({
      name: "answer",
      description:
        "Compose the answer: each sentence with the claim id it rests on. The program numbers the citations.",
      options: { namespace: "research", permission: "research" },
      input: Schema.Struct({
        sentences: Schema.Array(Schema.Struct({ text: Schema.String, claim: Schema.optional(Schema.String) })),
      }),
      output: AnswerOutput,
      execute: (input, tool) =>
        run(tool, (call) => Evidence.answer(store(), call, input)).pipe(
          Effect.map((result) => ({ output: result, content: result.markdown })),
        ),
    })
  })
}

// What each tool returns to the program that called it. A tool that returns `output` must declare its schema, or core
// refuses the result after the record has already been written. Fields not named here are dropped on the way out.
// Enumerations owned by the library and the store are typed as strings here, so a new value there never fails a call.

const Passage = Schema.Struct({ address: Schema.String, text: Schema.String })

const Sentence = Schema.Struct({ ...Passage.fields, start: Schema.Number, end: Schema.Number })

const Located = { source: Ref.Exact, short: Schema.String, title: Schema.String }

const FindOutput = Schema.Struct({
  works: Schema.Array(
    Schema.Struct({ title: Schema.String, doi: Schema.optional(Schema.String), year: Schema.optional(Schema.Number) }),
  ),
  receipt: Schema.String,
})

const AddOutput = Schema.Struct({
  status: Schema.String,
  source: Ref.Exact,
  copy: Schema.optional(Ref.Exact),
  representation: Schema.optional(Ref.Exact),
  receipt: Ref.Exact,
  seq: Schema.Number,
  notes: Schema.Array(Schema.String),
})

const OutlineOutput = Schema.Struct({
  ...Located,
  representation: Schema.optional(Ref.Exact),
  sections: Schema.Array(
    Schema.Struct({
      section: Schema.Number,
      heading: Schema.String,
      path: Schema.Array(Schema.String),
      paragraphs: Schema.Number,
      sentences: Schema.Number,
    }),
  ),
  note: Schema.String,
})

const ReadOutput = Schema.Struct({
  source: Ref.Exact,
  short: Schema.String,
  representation: Ref.Exact,
  address: Schema.String,
  sentences: Schema.Array(Sentence),
  truncated: Schema.Boolean,
  note: Schema.String,
})

const GrepOutput = Schema.Struct({
  hits: Schema.Array(Schema.Struct({ ...Sentence.fields, ...Located })),
  truncated: Schema.Boolean,
  searched: Schema.Number,
  receipt: Schema.String,
})

const SearchOutput = Schema.Struct({
  hits: Schema.Array(Schema.Struct({ ...Passage.fields, ...Located, score: Schema.Number })),
  truncated: Schema.Boolean,
  searched: Schema.Number,
  receipt: Schema.String,
})

const CitesOutput = Schema.Struct({
  source: Ref.Exact,
  short: Schema.String,
  entries: Schema.Array(Passage),
  note: Schema.String,
})

const QuoteOutput = Schema.Struct({
  fragment: Schema.String,
  address: Schema.String,
  quote: Schema.String,
  before: Schema.String,
  after: Schema.String,
  title: Schema.String,
  receipt: Schema.String,
})

const ComputeOutput = Schema.Struct({
  computation: Schema.String,
  result: Schema.String,
  value: Schema.Number,
  receipt: Schema.String,
})

const ClaimOutput = Schema.Struct({
  claim: Schema.String,
  evidence: Schema.Array(Schema.String),
  receipt: Schema.String,
})

const GapOutput = Schema.Struct({ gap: Schema.String, receipt: Schema.String })

const CheckOutput = Schema.Struct({
  record: Schema.Struct({
    ok: Schema.Boolean,
    headSeq: Schema.Number,
    headDigest: Schema.String,
    problems: Schema.Array(
      Schema.Struct({
        reason: Schema.String,
        seq: Schema.optional(Schema.Number),
        revisionId: Schema.optional(Schema.String),
        digest: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    ),
  }),
  replay: Schema.Struct({
    ok: Schema.Boolean,
    entries: Schema.Array(
      Schema.Struct({
        seq: Schema.Number,
        receipt: Ref.Exact,
        step: Schema.String,
        status: Schema.String,
        detail: Schema.String,
      }),
    ),
    mismatches: Schema.Number,
    unverifiable: Schema.Number,
  }),
})

const ProtocolOutput = Schema.Struct({ protocol: Schema.String, run: Schema.String, receipt: Schema.String })

const StatusOutput = Schema.Struct({
  protocol: Schema.optional(Schema.String),
  question: Schema.optional(Schema.String),
  claims: Schema.Number,
  gaps: Schema.Number,
  open: Schema.Array(
    Schema.Struct({ subquestion: Schema.optional(Schema.String), detail: Schema.String, close: Schema.String }),
  ),
})

const AnswerOutput = Schema.Struct({ answer: Schema.String, receipt: Schema.String, markdown: Schema.String })

/**
 * The run a session works in: the newest protocol it wrote, or else its parent's run. A reader or writer runs in a
 * child session, so it joins the run of the session that sent it, never another run in the same project.
 */
export function resolveRun<E>(
  store: () => Store.Reader,
  sessionID: Session.ID,
  parentOf: (sessionID: Session.ID) => Effect.Effect<Session.ID | undefined, E>,
): Effect.Effect<string, E> {
  return Effect.gen(function* () {
    const own = store()
      .graph()
      .entries.findLast(
        (entry) =>
          entry.revision.kind === "protocol" &&
          entry.revision.context !== "none" &&
          entry.revision.context.session === sessionID,
      )
    if (own !== undefined && own.revision.context !== "none") return own.revision.context.run
    const parent = yield* parentOf(sessionID)
    return parent === undefined ? "none" : yield* resolveRun(store, parent, parentOf)
  })
}

function stored(tool: string, input: unknown, output: unknown): Receipt.Tool {
  return {
    tool,
    version: "1",
    replay: "stored",
    input,
    output,
    schema: { input: `${tool}-input@1`, output: `${tool}-output@1` },
  }
}

const OPENALEX = "https://api.openalex.org/works"

const Text = Schema.optional(Schema.NullOr(Schema.String))

/** The part of an OpenAlex works answer a search lists. OpenAlex sends null for a field it does not know. */
const OpenAlexAnswer = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ title: Text, doi: Text, publication_year: Schema.optional(Schema.NullOr(Schema.Number)) }),
  ),
})

const decodeOpenAlex = Schema.decodeUnknownOption(Schema.fromJsonString(OpenAlexAnswer))

/** Works on OpenAlex matching `query`. The request asks the session's rules first, like any fetch. */
async function scholar(query: string, limit: number, allow: Fetch.Options["allow"]) {
  const url = new URL(OPENALEX)
  url.searchParams.set("search", query)
  url.searchParams.set("per-page", String(Math.min(Math.max(limit, 1), 50)))
  const fetched = await Fetch.get(url, { allow, maxBytes: 5 * 1024 * 1024 })
  const answer = decodeOpenAlex(new TextDecoder().decode(fetched.bytes))
  if (Option.isNone(answer)) throw new Error("OpenAlex did not answer with a list of works")
  return answer.value.results.flatMap((work) =>
    work.title === undefined || work.title === null
      ? []
      : [
          {
            title: work.title,
            ...(typeof work.doi === "string" ? { doi: work.doi.replace(/^https:\/\/doi\.org\//, "") } : {}),
            ...(typeof work.publication_year === "number" ? { year: work.publication_year } : {}),
          },
        ],
  )
}
