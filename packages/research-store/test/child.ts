// A child process for the kill and concurrency tests.
//   kill <directory> <failpoint> <hit> <marker>: admits and commits papers k0, k1, ... until the failpoint kills it.
//   claims <directory> <writer> <count>: commits `count` claims of its own, one per commit.
import { Failpoint } from "../src/failpoint.js"
import { Store } from "../src/store.js"
import { PROJECT, claim, paper } from "./fixture.js"

const [mode, directory, ...rest] = process.argv.slice(2)

if (mode === "kill") {
  const [name, afterHits, markerFile] = rest
  Failpoint.configure({ name: name as Failpoint.Name, afterHits: Number(afterHits), markerFile })
  const store = Store.open(directory, { projectId: PROJECT })
  console.log(`ready ${process.pid}`)
  for (let index = 0; ; index += 1) {
    const { bytes, revisions } = paper(`k${index}`)
    store.admit(bytes)
    store.commit({ key: `k${index}`, revisions })
  }
}

if (mode === "claims") {
  const [writer, count] = rest
  const store = Store.open(directory, { projectId: PROJECT, busyTimeoutMs: 30_000 })
  for (let index = 0; index < Number(count); index += 1)
    store.commit({ revisions: [claim(`claim-${writer}-${index}`, `Claim ${index} of writer ${writer}.`)] })
  store.close()
  console.log("done")
}
