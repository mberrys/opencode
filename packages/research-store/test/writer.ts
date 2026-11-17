// A separate process that commits to a shared store, for the concurrent writer test.
import { makeRecord } from "@opencode/research-record"
import { Store } from "../src/store.js"

const [directory, name, count] = process.argv.slice(2)
const store = Store.open(directory!)
for (let index = 0; index < Number(count); index++) {
  const claim = makeRecord({
    kind: "claim",
    at: "2026-11-10T00:00:00.000Z",
    author: { voice: "agent", id: name! },
    session: `ses_${name}`,
    body: { text: `Claim ${index} from ${name}.` },
  })
  store.commit([claim])
}
store.close()
