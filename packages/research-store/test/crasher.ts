// A separate process that commits one claim or stores one blob, so a test can kill it part way through.
import { makeRecord } from "@opencode/research-record"
import { Store } from "../src/store.js"

const [directory, action] = process.argv.slice(2)
const store = Store.open(directory!)
if (action === "blob") store.put(new TextEncoder().encode("bytes written by the crasher"))
if (action === "commit")
  store.commit([
    makeRecord({
      kind: "claim",
      at: "2026-11-10T00:00:00.000Z",
      author: { voice: "agent", id: "crasher" },
      session: "ses_crasher",
      body: { text: "A claim the crasher commits." },
    }),
  ])
store.close()
