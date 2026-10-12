// analyst — the Analyst on demand (design.md §2 CLI, §3.1 step 8; P2-04; FEAT-203):
//   node engine/index.js analyst [--dry-run] [--commit] [--now <iso>, dry-run only]
//
// Exactly the code path the admin's "Run analyst" button dispatches (engine-daily.yml with inputs.agents = analyst)
// and the Sunday step of the daily run: `daily --agents analyst`. The other agents are recorded `skipped:
// not_selected`; the Analyst fetches Instagram insights for the posts live ≥ 48 h / ≥ 7 d that are not measured yet
// (metrics/<month>.jsonl) and writes this ISO week's report (reports/<YYYY-Www>.md) — or records `skipped:
// no_metrics` while no post has insights yet. --dry-run (or IG_DRY_RUN=1 alone — R2-01) runs on a temp copy with the
// dry-run Instagram client (zeros labelled dryRun) and commits nothing; the run record, status.json (lastReport) and
// the git step are daily.js's own. The Analyst is company-wide, so --page is not accepted here.
import { run as runDailyCommand } from "./daily.js";

export const AGENTS = "analyst";

// CLI entry: ctx from engine/index.js → exit code (0 ok, 1 failed, 2 usage).
export async function run(ctx = {}) {
  const flags = { ...(ctx.flags || {}) };
  if (flags.page !== undefined) {
    (ctx.stderr || console.error)("analyst: --page is not accepted (the Analyst reports on every page; use daily --agents analyst --page <handle> only to filter the other agents)");
    return 2;
  }
  if (flags.agents !== undefined && flags.agents !== AGENTS) {
    (ctx.stderr || console.error)(`analyst: --agents is fixed to ${AGENTS} here (use daily --agents … for other agents)`);
    return 2;
  }
  return runDailyCommand({ ...ctx, flags: { ...flags, agents: AGENTS } });
}
