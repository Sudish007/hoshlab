// engine/agents/hr.js — Phase 1 skeleton (plan D18): OUTPUT_SPEC exists for the M7 dialect test, run()
// records `skipped: phase2` and never calls a model or writes a file; the charter and roster describe HR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANY_DIR } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { HR_PROPOSAL_SPEC, assertShape, toJsonSchema } from "../engine/lib/schema.js";
import { AGENT, CHANGE_FIELDS, EVIDENCE_SPEC, OUTPUT_SPEC, SKIP_NOTE, SKIP_REASON, VERDICTS, run, shouldRun } from "../engine/agents/hr.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });

test("run() → { skipped: 'phase2', note: 'HR monthly review: not built yet (phase 2)' } with no model call and no side effects (D18)", () => {
  assert.deepEqual(run(), { skipped: "phase2", note: "HR monthly review: not built yet (phase 2)" });
  assert.equal(SKIP_REASON, "phase2");
  assert.equal(SKIP_NOTE, "HR monthly review: not built yet (phase 2)");
  assert.equal(AGENT, "hr");
  assert.deepEqual(run({ anything: true }), run(), "arguments are ignored in Phase 1");
});

test("shouldRun is the 1st of the month in IST (the Phase 2 schedule; Phase 1 skips regardless)", () => {
  assert.equal(shouldRun("2026-11-01T05:31:00+05:30"), true);
  assert.equal(shouldRun("2026-10-12T05:31:00+05:30"), false);
  // 2026-10-31 19:00 UTC is 2026-11-01 00:30 IST
  assert.equal(shouldRun(new Date("2026-10-31T19:00:00Z")), true);
  assert.equal(shouldRun(new Date("2026-10-31T18:00:00Z")), false);
});

test("OUTPUT_SPEC matches design §5 (month, review[], rosterProposal.changes[], reviewMarkdown), converts to both dialects, and its enums match the state spec", () => {
  assert.deepEqual(Object.keys(OUTPUT_SPEC), ["month", "review", "rosterProposal", "reviewMarkdown"]);
  assert.deepEqual(VERDICTS, ["keep", "tune", "swap"]);
  assert.deepEqual(CHANGE_FIELDS, ["model", "provider", "temperature", "charterAppend"]);
  assert.equal(OUTPUT_SPEC.review[0].verdict, "enum[keep|tune|swap]");
  assert.equal(OUTPUT_SPEC.rosterProposal.changes[0].field, HR_PROPOSAL_SPEC.changes[0].field);
  assert.equal(OUTPUT_SPEC.review[0].verdict, HR_PROPOSAL_SPEC.review[0].verdict);
  assert.equal(OUTPUT_SPEC.review[0].evidence, EVIDENCE_SPEC, "evidence is spelled out (no free 'obj' in an output spec, M7)");
  assert.equal(OUTPUT_SPEC.rosterProposal.changes[0].from, "str");
  assert.equal(OUTPUT_SPEC.rosterProposal.changes[0].to, "str");
  assert.equal(JSON.stringify(toJsonSchema(OUTPUT_SPEC, "gemini")).includes("additionalProperties"), false);
  assert.equal(toJsonSchema(OUTPUT_SPEC, "openai").additionalProperties, false);
  const sample = {
    month: "2026-10",
    review: [{ agent: "writer", verdict: "tune", evidence: { qaRejectRate: 0.12, reworkLoopsPerDraft: 0.3, costPerApprovedPostUsd: 0.04, feedback: ["owner: too salesy"] }, proposal: "lower the temperature" }],
    rosterProposal: { changes: [{ agent: "writer", field: "temperature", from: "0.8", to: "0.7", why: "two rejects on tone" }] },
    reviewMarkdown: "# HR review 2026-10",
  };
  assert.doesNotThrow(() => assertShape(sample, OUTPUT_SPEC));
  assert.throws(() => assertShape({ ...sample, rosterProposal: { changes: [{ ...sample.rosterProposal.changes[0], from: 0.8 }] } }, OUTPUT_SPEC), /from: expected string/);
  assert.throws(() => assertShape({ ...sample, review: [{ ...sample.review[0], verdict: "fire" }] }, OUTPUT_SPEC), /verdict: expected one of keep\|tune\|swap/);
});

test("the HR charter and roster describe the Phase 1 state honestly", () => {
  const charter = company.charters.hr.text;
  assert.ok(charter.includes("skipped: phase2"));
  assert.ok(charter.includes("Monthly review: not built yet (phase 2)"));
  assert.ok(charter.includes('"from": "0.8", "to": "0.7"'), "the example writes from/to as strings, like OUTPUT_SPEC");
  const hr = company.roster.agents.find((a) => a.name === "hr");
  assert.equal(hr.schedule, "monthly-1st");
  assert.equal(hr.kind, "llm");
});
