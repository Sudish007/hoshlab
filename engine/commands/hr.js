// hr — the monthly roster review on demand (design.md §2 CLI, §3.1 step 3; P2-06; FEAT-204):
//   node engine/index.js hr [--dry-run] [--commit] [--now <iso>, dry-run only]
//
// = `daily --agents hr` with the review FORCED for the previous IST month: the daily run itself reviews only on the 1st
// (or catches up a missing proposal once that month has data). The other agents are recorded `skipped: not_selected`;
// HR computes the month's per-agent stats, calls the model once, and writes hr/<month>-review.md + hr/proposals/<month>.json
// (status proposed — the owner applies or dismisses it in the admin, which appends hr/decisions.jsonl). Still skipped
// when the month has no runs or model calls (no_data) or when the owner already decided on that month's proposal
// (already_decided). --dry-run runs on a temp copy and commits nothing; the run record, status.json and the git step
// are daily.js's own. Company-wide: --page is not accepted here.
import { run as runDailyCommand } from "./daily.js";

export const AGENTS = "hr";

// CLI entry: ctx from engine/index.js → exit code (0 ok, 1 failed, 2 usage).
export async function run(ctx = {}) {
  const flags = { ...(ctx.flags || {}) };
  if (flags.page !== undefined) {
    (ctx.stderr || console.error)("hr: --page is not accepted (HR reviews the whole roster; use daily --agents hr --page <handle> only to filter the other agents)");
    return 2;
  }
  if (flags.agents !== undefined && flags.agents !== AGENTS) {
    (ctx.stderr || console.error)(`hr: --agents is fixed to ${AGENTS} here (use daily --agents … for other agents)`);
    return 2;
  }
  return runDailyCommand({ ...ctx, flags: { ...flags, agents: AGENTS, force: true } });
}
