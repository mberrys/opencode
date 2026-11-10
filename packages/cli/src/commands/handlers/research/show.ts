import { Effect, Option } from "effect"
import { formatRef, verifyFragment } from "@opencode/research-record"
import { tierOf } from "@opencode/research"
import { cardOf } from "@opencode/research"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { open, print } from "./shared"

export default Runtime.handler(
  Commands.commands.research.commands.show,
  Effect.fn("cli.research.show")(function* (input) {
    const { store } = open(Option.getOrUndefined(input.directory))
    const ref = yield* Effect.try({ try: () => store.resolve(input.ref), catch: (error) => new Error((error as Error).message) })
    const record = store.get(ref)

    if (record.kind === "fragment") {
      const card = cardOf(store, ref)
      const representation = store.find(record.body.representation)
      const bytes =
        representation?.kind === "representation" && store.blobs.has(representation.body.text)
          ? store.blobs.get(representation.body.text)
          : undefined
      const check = bytes
        ? verifyFragment(record.body, bytes)
        : { ok: false, failure: { detail: "the representation is missing" } }
      print(
        [
          `fragment   ${formatRef(ref)}`,
          `address    ${card.address}`,
          `source     ${card.title} (${card.citation})`,
          check.ok
            ? "bytes      the quote is the stored bytes"
            : `bytes      ${check.failure?.detail ?? "the quote does not match"}`,
          card.flags.length ? `flags      ${card.flags.join(", ")}` : "",
          "",
          `${card.before}[${card.quote}]${card.after}`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
      )
      store.close()
      return
    }

    if (record.kind === "claim") {
      const tier = tierOf(store, record)
      print(
        [
          `claim      ${formatRef(ref)}`,
          `tier       ${tier.tier}${tier.rejected ? " (rejected)" : ""}`,
          tier.flags.length ? `flags      ${tier.flags.join(", ")}` : "",
          `text       ${record.body.text}`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      store.close()
      return
    }

    print(JSON.stringify(record, null, 2))
    store.close()
  }),
)
