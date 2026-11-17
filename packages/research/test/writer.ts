// A separate process that writes receipts into a shared run, for the concurrency and crash tests.
import { makeRecord } from "@opencode/research-record"
import { Store } from "@opencode/research-store"
import { record } from "../src/evidence.js"

const [directory, name, count, withClaim] = process.argv.slice(2)
const store = Store.open(directory!)
const session = { store, session: `ses_${name}`, run: `ses_${name}`, actor: { voice: "agent" as const, id: name! } }
for (let index = 0; index < Number(count); index++) {
  const claims =
    withClaim === "claim"
      ? [
          makeRecord({
            kind: "claim",
            at: "2026-11-10T00:00:00.000Z",
            author: session.actor,
            session: session.session,
            body: { text: `Claim ${index} from ${name}.` },
          }),
        ]
      : []
  record(session, "library.grep", { pattern: `${name} ${index}` }, claims, () => ({ name: name!, index }))
}
store.close()
