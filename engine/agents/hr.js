// HR agent — module skeleton (design.md §5 row "HR", §3.1 step 3; plan D18).
// HR exists in Phase 1 as a roster member, a charter, a Team card and this module (OUTPUT_SPEC for
// the M7 dialect test), but its monthly review is NOT built yet: run() records `skipped: phase2`
// and the Team page says "Monthly review: not built yet (phase 2)". Phase 2 adds the deterministic
// per-agent stats, the model call and the hr/<month>-review.md + hr/proposals/<month>.json writes.
import { AGENT as AGENT_ENUM, MONTH_KEY } from "../lib/schema.js";
import { istParts } from "../lib/time.js";

export const AGENT = "hr";
export const SKIP_REASON = "phase2";
export const SKIP_NOTE = "HR monthly review: not built yet (phase 2)";
export const VERDICTS = ["keep", "tune", "swap"];
export const CHANGE_FIELDS = ["model", "provider", "temperature", "charterAppend"];

// The stats fields the engine computes deterministically before the model is called (charter
// "stats"); every one is optional so an agent with no runs can carry {} as evidence.
export const EVIDENCE_SPEC = {
  "qaRejectRate?": "num[0..1]",
  "reworkLoopsPerDraft?": "num[0..100]",
  "costPerApprovedPostUsd?": "num[0..100000]",
  "failedCalls?": "int[0..100000]",
  "medianLatencyMs?": "int[0..86400000]",
  "calls?": "int[0..100000]",
  "feedback?": ["str"],
};

// The model's JSON output (design §5). `from`/`to` are strings written exactly as the value would
// appear in roster.json ("0.8"); a free 'any' token is not representable in the OpenAI strict
// dialect (review M7), and the Phase 2 applier converts numbers when it applies a change.
export const OUTPUT_SPEC = {
  month: MONTH_KEY,
  review: [{ agent: AGENT_ENUM, verdict: `enum[${VERDICTS.join("|")}]`, evidence: EVIDENCE_SPEC, proposal: "str" }],
  rosterProposal: { changes: [{ agent: AGENT_ENUM, field: `enum[${CHANGE_FIELDS.join("|")}]`, from: "str", to: "str", why: "str" }] },
  reviewMarkdown: "str",
};

// The monthly review is scheduled for the 1st of the month (IST); Phase 1 skips it regardless.
export function shouldRun(now = new Date()) {
  return istParts(now).d === 1;
}

// Phase 1: nothing is computed, nothing is written, no model is called (plan D18).
export function run() {
  return { skipped: SKIP_REASON, note: SKIP_NOTE };
}
