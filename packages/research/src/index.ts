import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

// The research harness. Core registers it only when the `research` flag is on. It adds nothing yet.
export default Plugin.define({
  id: "opencode.research",
  effect: () => Effect.void,
})
