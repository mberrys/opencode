/**
 * Crash points for the kill tests. Setting OPENCODE_RESEARCH_FAILPOINT to a name kills this process with SIGKILL
 * at that point, so no finalizer, rollback or flush runs: the store must survive exactly what a power cut leaves.
 * Unset, which is always the case outside those tests, a failpoint is one environment read.
 */
export function failpoint(
  name: "blob.before-rename" | "commit.before-commit" | "commit.after-commit" | "record.before-receipt",
) {
  if (process.env.OPENCODE_RESEARCH_FAILPOINT === name) process.kill(process.pid, "SIGKILL")
}
