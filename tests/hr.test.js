// engine/agents/hr.js (FEAT-204; design §3.1 step 3, §4.2, §5 row "HR"; P2-06; N14 / D13): the per-agent stats are
// re-derived here from the fixture files with plain arithmetic and must equal computeAgentStats(); hr.bad.json is
// rejected after the single repair call (every agent once, evidence = the engine's numbers, provider/model/temperature
// rules, qa/publisher can never be removed or disabled); hr.ok.json writes hr/<month>-review.md + hr/proposals/<month>.json
// on a temp copy of the populated fixture run on 1 November 2026; shouldRun / dueStatus follow the 1st-of-month rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { HR_DECISION_SPEC, HR_PROPOSAL_SPEC, ROSTER_SPEC, applyRosterChanges, assertShape, toJsonSchema, validate } from "../engine/lib/schema.js";
import { createState, validateTree } from "../engine/lib/state.js";
import { round6 } from "../engine/lib/budget.js";
import { createRouter, AgentOutputError } from "../engine/llm/router.js";
import { AGENT_ORDER, LLM_AGENTS, runDaily } from "../engine/commands/daily.js";
import { run as runHrCommand } from "../engine/commands/hr.js";
import { EXIT, main } from "../engine/index.js";
import {
  AGENT,
  CHANGE_FIELDS,
  EVIDENCE_RULE,
  EVIDENCE_SPEC,
  OUTPUT_SPEC,
  SKIP_DECIDED,
  SKIP_NO_DATA,
  SKIP_NOT_DUE,
  STAT_FIELDS,
  VERDICTS,
  buildTask,
  computeAgentStats,
  dueStatus,
  enabledProviders,
  latestDecisions,
  latestReview,
  listProposals,
  listReviews,
  parseReview,
  proposalPath,
  readMonthData,
  renderReview,
  reviewMonth,
  reviewPath,
  runHr,
  shouldRun,
  validateHrOutput,
} from "../engine/agents/hr.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster } = company;
const NAMES = roster.agents.map((a) => a.name);
const NOV_1 = "2026-11-01T05:31:00+05:30"; // the 1st: reviews October 2026, the month the fixture logs cover
const OCT_12 = "2026-10-12T05:31:00+05:30"; // the fixture's build day (Monday)
const MOCK = { MOCK_LLM: "1" };
const fixtureState = createState({ companyDir: COMPANY_DIR, now: OCT_12 });
const okFixture = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "llm", "hr.ok.json"), "utf8"));

// A temp copy of the populated fixture (+ a media worktree marker so the Designer would not skip for that reason).
function copyFixture() {
  const base = tmpDir("hoshlab-hr-");
  const dir = join(base, "company");
  cpSync(COMPANY_DIR, dir, { recursive: true });
  const mediaRoot = join(base, ".media");
  cpSync(join(ROOT, "tests", "fixtures", "media"), mediaRoot, { recursive: true });
  writeFileSync(join(mediaRoot, ".git"), "gitdir: ../.git/worktrees/media\n");
  return { base, dir, mediaRoot, state: createState({ companyDir: dir, now: NOV_1 }), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

const agentRow = (r, name) => r.agents.find((a) => a.name === name);

// The fixture's October numbers, worked out here with nothing but the files (the proof that computeAgentStats computes).
function expectedOctoberStats() {
  const usage = fixtureState.readJsonl("state/usage/2026-10.jsonl");
  const runs = fixtureState.readJsonl("state/runs/2026-10.jsonl");
  const drafts = fixtureState.listDrafts().map((id) => fixtureState.readDraft(id));
  const published = fixtureState.readJsonl("state/published.jsonl");
  const out = {};
  for (const name of NAMES) {
    const mine = usage.filter((u) => u.agent === name);
    const failed = mine.filter((u) => u.ok === false);
    const providers = {};
    for (const u of failed) providers[u.provider] = (providers[u.provider] || 0) + 1;
    const rows = runs.flatMap((r) => r.agents.filter((a) => a.name === name && !a.skipped));
    out[name] = {
      calls: mine.length,
      failedCalls: failed.length,
      costUsd: round6(mine.reduce((s, u) => s + u.costUsd, 0)),
      avgMs: mine.length ? Math.round(mine.reduce((s, u) => s + u.ms, 0) / mine.length) : 0,
      runs: rows.length,
      failedRuns: rows.filter((a) => a.ok === false).length,
      providerFailures: Object.keys(providers).sort().map((provider) => ({ provider, failed: providers[provider] })),
    };
  }
  const written = drafts.filter((d) => d.createdAt.startsWith("2026-10"));
  const failedOnce = written.filter((d) => {
    const qa = fixtureState.readQa(d.id);
    return (qa && qa.passed === false) || d.reworkCount > 0;
  });
  out.writer.qaRejectionRate = Math.round((failedOnce.length / written.length) * 1e4) / 1e4;
  out.writer.reworkLoops = written.reduce((s, d) => s + d.reworkCount, 0);
  const approved = published.filter((p) => !p.dryRun && p.publishedAt.startsWith("2026-10"));
  const studio = out.strategist.costUsd + out.writer.costUsd + out.qa.costUsd;
  for (const a of ["strategist", "writer", "qa"]) out[a].costPerApprovedPost = round6(studio / approved.length);
  return { out, written, failedOnce, approved, usage };
}

test("computeAgentStats on the populated fixture equals the numbers worked out independently from usage, runs, drafts, qa and published (none estimated)", () => {
  const data = readMonthData(fixtureState, "2026-10");
  const stats = computeAgentStats({ month: "2026-10", agents: NAMES, usageMonth: data.usage, runs: data.runs, drafts: data.drafts, qaFiles: data.qaFiles, published: data.published });
  const { out, written, failedOnce, approved, usage } = expectedOctoberStats();
  assert.deepEqual(stats, out);
  // the fixture's concrete numbers, so a change in either file is noticed
  assert.equal(written.length, 5, "five drafts written in October");
  assert.deepEqual(failedOnce.map((d) => d.id), ["jr-2026-10-15-templates"], "one draft failed QA (blocked after two rework loops)");
  assert.equal(approved.length, 2);
  assert.equal(usage.length, 6);
  assert.equal(stats.writer.qaRejectionRate, 0.2);
  assert.equal(stats.writer.reworkLoops, 2);
  assert.equal(stats.writer.calls, 3);
  assert.equal(stats.writer.costUsd, round6(0.0198 + 0 + 0.022));
  assert.equal(stats.writer.avgMs, Math.round((9870 + 2 + 11240) / 3));
  assert.equal(stats.qa.calls, 2);
  assert.equal(stats.qa.avgMs, Math.round((3310 + 3580) / 2));
  assert.equal(stats.strategist.costPerApprovedPost, round6((0.00068 + 0.0198 + 0.022 + 0.005475 + 0.005663) / 2));
  assert.equal(stats.writer.costPerApprovedPost, stats.qa.costPerApprovedPost);
  assert.deepEqual(stats.designer, { calls: 0, failedCalls: 0, costUsd: 0, avgMs: 0, runs: 2, failedRuns: 0, providerFailures: [] });
  assert.deepEqual(stats.publisher, { calls: 0, failedCalls: 0, costUsd: 0, avgMs: 0, runs: 1, failedRuns: 0, providerFailures: [] });
  for (const name of ["ceo", "hr", "analyst"]) assert.deepEqual(stats[name], { calls: 0, failedCalls: 0, costUsd: 0, avgMs: 0, runs: 0, failedRuns: 0, providerFailures: [] }, name);
  // every stats object is a valid evidence object (the model copies from it), and every key is a stat field
  for (const name of NAMES) {
    assert.doesNotThrow(() => assertShape(stats[name], EVIDENCE_SPEC), name);
    for (const k of Object.keys(stats[name])) assert.ok(STAT_FIELDS.includes(k), `${name}.${k}`);
  }
  // a month without logs → zeros for everyone, no writer/studio ratios (nothing to divide)
  const sept = computeAgentStats({ month: "2026-09", agents: NAMES, usageMonth: data.usage, runs: data.runs, drafts: data.drafts, qaFiles: data.qaFiles, published: data.published });
  for (const name of NAMES) assert.deepEqual(sept[name], { calls: 0, failedCalls: 0, costUsd: 0, avgMs: 0, runs: 0, failedRuns: 0, providerFailures: [] }, name);
  // failed calls are grouped per provider, dry-run posts are not approved posts, a skipped row is not a run
  const synthetic = computeAgentStats({
    month: "2026-10",
    agents: ["writer", "qa", "strategist"],
    usageMonth: [
      { at: "2026-10-03T05:31:00+05:30", agent: "writer", provider: "anthropic", costUsd: 0.01, ms: 1000, ok: false },
      { at: "2026-10-03T05:32:00+05:30", agent: "writer", provider: "anthropic", costUsd: 0, ms: 3000, ok: false },
      { at: "2026-10-03T05:33:00+05:30", agent: "writer", provider: "gemini", costUsd: 0.02, ms: 2000, ok: true },
      { at: "2026-09-30T23:59:00+05:30", agent: "writer", provider: "gemini", costUsd: 5, ms: 1, ok: true },
    ],
    runs: [
      { startedAt: "2026-10-03T05:31:00+05:30", agents: [{ name: "writer", ok: false }, { name: "qa", ok: true, skipped: "budget_exhausted" }] },
      { startedAt: "2026-09-30T05:31:00+05:30", agents: [{ name: "writer", ok: true }] },
    ],
    drafts: [],
    qaFiles: [],
    published: [{ publishedAt: "2026-10-05T08:31:00+05:30", dryRun: true }],
  });
  assert.deepEqual(synthetic.writer, { calls: 3, failedCalls: 2, costUsd: 0.03, avgMs: 2000, runs: 1, failedRuns: 1, providerFailures: [{ provider: "anthropic", failed: 2 }] }, "the September usage line and run are outside the month");
  assert.deepEqual(synthetic.qa, { calls: 0, failedCalls: 0, costUsd: 0, avgMs: 0, runs: 0, failedRuns: 0, providerFailures: [] });
  assert.equal("costPerApprovedPost" in synthetic.writer, false, "a dry-run record is not an approved post");
});

test("reviewMonth / reviewPath / proposalPath name the month BEFORE the run; shouldRun is the 1st IST or a missing proposal for a month that has data", () => {
  assert.equal(reviewMonth(NOV_1), "2026-10");
  assert.equal(reviewMonth("2026-01-01T00:10:00+05:30"), "2025-12");
  assert.equal(reviewMonth(new Date("2026-10-31T19:00:00Z")), "2026-10", "31 Oct 19:00 UTC is 1 Nov 00:30 IST");
  assert.equal(reviewPath("2026-10"), "hr/2026-10-review.md");
  assert.equal(proposalPath("2026-10"), "hr/proposals/2026-10.json");
  assert.throws(() => proposalPath("2026-13"), TypeError);
  assert.equal(shouldRun(NOV_1), true);
  assert.equal(shouldRun(OCT_12), false);
  assert.equal(shouldRun(new Date("2026-10-31T19:00:00Z")), true);
  assert.equal(shouldRun(new Date("2026-10-31T18:00:00Z")), false);
  // with a state: the fixture has September's proposal → not due on 12 Oct; its September has no data either way
  assert.equal(shouldRun(OCT_12, fixtureState), false);
  const fx = copyFixture();
  try {
    // 2 November, October reviewed by nobody yet, October has data → catch-up
    assert.equal(shouldRun("2026-11-02T05:31:00+05:30", fx.state), true);
    // 2 December, November has no logs → nothing to catch up
    assert.equal(shouldRun("2026-12-02T05:31:00+05:30", fx.state), false);
    const due = dueStatus({ state: fx.state, now: "2026-11-02T05:31:00+05:30" });
    assert.deepEqual([due.run, due.month, due.skipped], [true, "2026-10", null]);
    const notDue = dueStatus({ state: fx.state, now: OCT_12 });
    assert.deepEqual([notDue.run, notDue.month, notDue.skipped], [false, "2026-09", SKIP_NOT_DUE]);
    assert.match(notDue.note, /hr\/proposals\/2026-09\.json exists/);
    const noData = dueStatus({ state: fx.state, now: "2026-12-01T05:31:00+05:30" });
    assert.deepEqual([noData.run, noData.month, noData.skipped], [false, "2026-11", SKIP_NO_DATA]);
    // forced (the hr command): the 1st-of-month rule is waived, no_data and already_decided are not
    assert.equal(dueStatus({ state: fx.state, now: OCT_12, forced: true }).skipped, SKIP_NO_DATA, "September has no logs in the fixture");
    assert.equal(dueStatus({ state: fx.state, now: "2026-11-15T05:31:00+05:30", forced: true }).run, true);
    fx.state.writeJson("state/hr/proposals/2026-10.json", { month: "2026-10", at: NOV_1, runId: "engine-daily-20261101-0531-aaaaaa", status: "proposed", reviewPath: "hr/2026-10-review.md", review: [], changes: [] }, HR_PROPOSAL_SPEC);
    assert.equal(shouldRun("2026-11-02T05:31:00+05:30", fx.state), false, "the proposal exists now");
    assert.equal(dueStatus({ state: fx.state, now: "2026-11-15T05:31:00+05:30", forced: true }).run, true, "forced re-review replaces an undecided proposal");
    // a decision for the month (admin-owned log, written here as the admin would) ends the matter
    const decision = { month: "2026-10", proposal: "hr/proposals/2026-10.json", decision: "dismiss", at: "2026-11-03T10:00:00+05:30", by: "owner" };
    assertShape(decision, HR_DECISION_SPEC);
    writeFileSync(join(fx.dir, "state", "hr", "decisions.jsonl"), JSON.stringify(decision) + "\n", "utf8");
    const decided = dueStatus({ state: fx.state, now: "2026-11-15T05:31:00+05:30", forced: true });
    assert.deepEqual([decided.run, decided.skipped], [false, SKIP_DECIDED]);
    assert.match(decided.note, /already dismissed hr\/proposals\/2026-10\.json/);
    assert.equal(latestDecisions([decision, { ...decision, decision: "apply", at: "2026-11-04T10:00:00+05:30" }]).get("2026-10").decision, "apply", "the latest decision wins");
  } finally {
    fx.cleanup();
  }
  assert.ok(AGENT_ORDER.includes("hr") && LLM_AGENTS.includes("hr"), "daily knows HR as a model-backed agent");
});

test("OUTPUT_SPEC matches design §5, converts to both dialects, and its enums match the state spec (M7)", () => {
  assert.equal(AGENT, "hr");
  assert.deepEqual(Object.keys(OUTPUT_SPEC), ["month", "review", "rosterProposal", "reviewMarkdown"]);
  assert.deepEqual(VERDICTS, ["keep", "tune", "swap"]);
  assert.deepEqual(CHANGE_FIELDS, ["model", "provider", "temperature", "charterAppend"]);
  assert.equal(OUTPUT_SPEC.review[0].verdict, "enum[keep|tune|swap]");
  assert.equal(OUTPUT_SPEC.rosterProposal.changes[0].field, HR_PROPOSAL_SPEC.changes[0].field);
  assert.equal(OUTPUT_SPEC.review[0].verdict, HR_PROPOSAL_SPEC.review[0].verdict);
  assert.equal(OUTPUT_SPEC.review[0].evidence, EVIDENCE_SPEC, "evidence is spelled out (no free 'obj' in an output spec, M7)");
  assert.deepEqual(STAT_FIELDS, ["calls", "failedCalls", "costUsd", "avgMs", "runs", "failedRuns", "providerFailures", "qaRejectionRate", "reworkLoops", "costPerApprovedPost"]);
  assert.equal(OUTPUT_SPEC.rosterProposal.changes[0].from, "str");
  assert.equal(OUTPUT_SPEC.rosterProposal.changes[0].to, "str");
  assert.equal(JSON.stringify(toJsonSchema(OUTPUT_SPEC, "gemini")).includes("additionalProperties"), false);
  assert.equal(toJsonSchema(OUTPUT_SPEC, "openai").additionalProperties, false);
  assert.doesNotThrow(() => assertShape(okFixture.output, OUTPUT_SPEC));
  assert.throws(() => assertShape({ ...okFixture.output, rosterProposal: { changes: [{ ...okFixture.output.rosterProposal.changes[0], from: 0.8 }] } }, OUTPUT_SPEC), /from: expected string/);
  assert.throws(() => assertShape({ ...okFixture.output, review: [{ ...okFixture.output.review[0], verdict: "fire" }] }, OUTPUT_SPEC), /verdict: expected one of keep\|tune\|swap/);
  assert.throws(() => assertShape({ ...okFixture.output, review: [{ ...okFixture.output.review[0], evidence: { invented: 1 } }] }, OUTPUT_SPEC), /evidence/);
});

test("validateHrOutput: every agent once, evidence = the engine's numbers, provider enabled, model in table, temperature 0–1, from = current, deterministic agents take only charterAppend, verdicts match changes, qa/publisher never removed or disabled", () => {
  const stats = computeAgentStats({ month: "2026-10", agents: NAMES, ...readMonthData(fixtureState, "2026-10"), usageMonth: readMonthData(fixtureState, "2026-10").usage });
  const ok = okFixture.output;
  const ctx = { month: "2026-10", roster, config, stats };
  assert.deepEqual(validateHrOutput(ok, ctx), []);
  assert.deepEqual(validateHrOutput(ok, { ...ctx, month: null }), [], "month rule waived (mock)");
  assert.deepEqual(validateHrOutput(ok, { ...ctx, month: "2026-11" }), ["$.month: expected 2026-11, got \"2026-10\""]);
  const withChange = (change, verdict = "tune") => ({ ...ok, review: ok.review.map((r) => (r.agent === change.agent ? { ...r, verdict } : r.agent === "writer" ? { ...r, verdict: "keep" } : r)), rosterProposal: { changes: [change] } });
  const errs = (json, c = ctx) => validateHrOutput(json, c);
  // evidence
  const invented = { ...ok, review: ok.review.map((r) => (r.agent === "qa" ? { ...r, evidence: { ...r.evidence, calls: 7 } } : r)) };
  assert.match(errs(invented).join("\n"), new RegExp(`\\$\\.review\\[5\\]\\.evidence\\.calls: ${EVIDENCE_RULE}: 7 \\(the engine computed 2\\)`));
  const foreign = { ...ok, review: ok.review.map((r) => (r.agent === "ceo" ? { ...r, evidence: { qaRejectionRate: 0.2 } } : r)) };
  assert.match(errs(foreign).join("\n"), /\$\.review\[0\]\.evidence\.qaRejectionRate: evidence number not in stats for ceo/);
  const feedbackOnly = { ...ok, review: ok.review.map((r) => (r.agent === "ceo" ? { ...r, evidence: { feedback: ["note: Keep RishtaPatra Hindi-first"] } } : r)) };
  assert.deepEqual(errs(feedbackOnly), [], "feedback strings are not numbers");
  // every agent exactly once
  assert.deepEqual(errs({ ...ok, review: ok.review.filter((r) => r.agent !== "qa"), rosterProposal: { changes: ok.rosterProposal.changes } }), ["$.review: qa reviewed 0 times (review every agent exactly once)"]);
  assert.match(errs({ ...ok, review: [...ok.review, ok.review[0]] }).join(), /ceo reviewed 2 times/);
  // changes
  assert.match(errs(withChange({ agent: "writer", field: "provider", from: "anthropic", to: "mistral", why: "x" }, "swap")).join("\n"), /changes\[0\]\.to: "mistral" is not an enabled provider \(anthropic, gemini, openai\)/);
  const disabled = JSON.parse(JSON.stringify(config));
  disabled.providers.openai.enabled = false;
  assert.match(errs(withChange({ agent: "writer", field: "provider", from: "anthropic", to: "openai", why: "x" }, "swap"), { ...ctx, config: disabled }).join("\n"), /"openai" is not an enabled provider \(anthropic, gemini\)/);
  assert.match(errs(withChange({ agent: "writer", field: "model", from: "claude-sonnet-5-5", to: "gpt-6-luna", why: "x" }, "swap")).join("\n"), /changes\[0\]\.to: "gpt-6-luna" is not in providers\.anthropic\.models/);
  assert.deepEqual(errs({ ...withChange({ agent: "writer", field: "provider", from: "anthropic", to: "openai", why: "x" }, "swap"), rosterProposal: { changes: [{ agent: "writer", field: "provider", from: "anthropic", to: "openai", why: "x" }, { agent: "writer", field: "model", from: "claude-sonnet-5-5", to: "gpt-6-luna", why: "x" }] } }), [], "provider + model together: the model is checked against the NEW provider's table");
  assert.match(errs(withChange({ agent: "writer", field: "provider", from: "anthropic", to: "openai", why: "x" }, "swap")).join("\n"), /\$\.rosterProposal: \$\.agents\[3\]\.model: claude-sonnet-5-5 not in providers\.openai\.models/, "a provider change alone leaves the model outside the new table");
  assert.match(errs(withChange({ agent: "writer", field: "temperature", from: "0.8", to: "1.5", why: "x" })).join("\n"), /temperature must be a number between 0 and 1, got "1\.5"/);
  assert.match(errs(withChange({ agent: "writer", field: "temperature", from: "0.8", to: "warm", why: "x" })).join("\n"), /temperature must be a number between 0 and 1, got "warm"/);
  assert.match(errs(withChange({ agent: "writer", field: "temperature", from: "0.8", to: "0.8", why: "x" })).join("\n"), /0\.8 is already the writer temperature/);
  assert.match(errs(withChange({ agent: "writer", field: "temperature", from: "0.9", to: "0.7", why: "x" })).join("\n"), /changes\[0\]\.from: expected "0\.8" \(the current writer temperature\), got "0\.9"/);
  assert.match(errs(withChange({ agent: "designer", field: "temperature", from: "", to: "0.5", why: "x" })).join("\n"), /designer is deterministic \(kind deterministic\) and has no temperature; only charterAppend applies/);
  assert.deepEqual(errs(withChange({ agent: "designer", field: "charterAppend", from: "", to: "Prefer the A variant when the headline fits.", why: "x" })), []);
  assert.match(errs(withChange({ agent: "designer", field: "charterAppend", from: "", to: "   ", why: "x" })).join("\n"), /the paragraph to append is empty/);
  assert.match(errs(withChange({ agent: "designer", field: "charterAppend", from: "old", to: "new", why: "x" })).join("\n"), /from: must be "" for charterAppend/);
  assert.match(errs({ ...ok, rosterProposal: { changes: [ok.rosterProposal.changes[0], ok.rosterProposal.changes[0]] } }).join("\n"), /a second temperature change for writer/);
  assert.match(errs({ ...ok, rosterProposal: { changes: [{ ...ok.rosterProposal.changes[0], agent: "intern" }] } }).join("\n"), /changes\[0\]\.agent: "intern" is not in the roster/);
  // verdict ↔ change consistency
  assert.match(errs({ ...ok, review: ok.review.map((r) => (r.agent === "writer" ? { ...r, verdict: "keep" } : r)) }).join("\n"), /writer has verdict keep but 1 change \(keep means no change\)/);
  assert.match(errs({ ...ok, rosterProposal: { changes: [] } }).join("\n"), /writer has verdict tune but no change/);
  assert.match(errs({ ...ok, review: ok.review.map((r) => (r.agent === "writer" ? { ...r, verdict: "swap" } : r)) }).join("\n"), /writer has verdict swap but no model or provider change/);
  assert.match(errs(withChange({ agent: "writer", field: "model", from: "claude-sonnet-5-5", to: "claude-sonnet-5-5", why: "x" }, "tune")).join("\n"), /writer has verdict tune but a model or provider change \(that is a swap\)/);
  // qa / publisher: the change fields cannot remove or disable them, and the resulting roster is re-validated
  for (const field of CHANGE_FIELDS) assert.ok(!["enabled", "kind", "name"].includes(field));
  const qaSwap = { ...ok, review: ok.review.map((r) => (r.agent === "qa" ? { ...r, verdict: "swap" } : r.agent === "writer" ? { ...r, verdict: "keep" } : r)), rosterProposal: { changes: [{ agent: "qa", field: "provider", from: "gemini", to: "openai", why: "x" }] } };
  assert.match(errs(qaSwap).join("\n"), /\$\.rosterProposal: \$\.agents\[5\]\.model: gemini-3\.8-flash not in providers\.openai\.models/);
  const noPublisher = { ...roster, agents: roster.agents.filter((a) => a.name !== "publisher") };
  assert.match(validateHrOutput({ ...ok, review: ok.review.filter((r) => r.agent !== "publisher") }, { ...ctx, roster: noPublisher }).join("\n"), /\$\.rosterProposal: \$\.agents: expected at least 8 items \(7\)/, "a roster without the publisher never validates, proposal or not (the shape rule fires before the by-name rule)");
  const publisherOff = { ...roster, agents: roster.agents.map((a) => (a.name === "publisher" ? { ...a, enabled: false } : a)) };
  assert.match(validateHrOutput(ok, { ...ctx, roster: publisherOff }).join("\n"), /\$\.rosterProposal: \$\.agents: publisher cannot be disabled/, "a disabled publisher never validates either");
  // applyRosterChanges: pure, never adds/removes, converts the temperature, drops the new provider from fallback
  const applied = applyRosterChanges(roster, [{ agent: "writer", field: "temperature", from: "0.8", to: "0.7" }, { agent: "writer", field: "provider", from: "anthropic", to: "gemini" }, { agent: "writer", field: "model", from: "claude-sonnet-5-5", to: "gemini-3.8-flash" }, { agent: "designer", field: "charterAppend", from: "", to: "p" }]);
  const w = applied.agents.find((a) => a.name === "writer");
  assert.deepEqual([w.temperature, w.provider, w.model, w.fallback], [0.7, "gemini", "gemini-3.8-flash", ["openai"]]);
  assert.equal(roster.agents.find((a) => a.name === "writer").temperature, 0.8, "the input roster is untouched");
  assert.equal(applied.agents.length, 8);
  assert.deepEqual(validate(applied, ROSTER_SPEC, config).errors, []);
  assert.throws(() => applyRosterChanges(roster, [{ agent: "intern", field: "model", to: "x" }]), RangeError);
  assert.throws(() => applyRosterChanges(roster, [{ agent: "qa", field: "enabled", to: "false" }]), /unknown field "enabled"/);
});

test("buildTask carries the roster, the stats, the month's feedback and ONLY the enabled providers with their model tables", () => {
  const data = readMonthData(fixtureState, "2026-10");
  const stats = computeAgentStats({ month: "2026-10", agents: NAMES, usageMonth: data.usage, runs: data.runs, drafts: data.drafts, qaFiles: data.qaFiles, published: data.published });
  const task = buildTask({ config, roster, month: "2026-10", now: NOV_1, stats, feedback: data.feedback });
  assert.equal(task.month, "2026-10");
  assert.equal(task.today, "2026-11-01");
  assert.deepEqual(task.roster.map((a) => a.name), NAMES);
  assert.equal(task.roster.find((a) => a.name === "designer").provider, null);
  assert.deepEqual(task.stats, stats);
  assert.equal(task.feedback.length, 2, "both fixture feedback lines are from October");
  assert.deepEqual(Object.keys(task.providers), ["anthropic", "gemini", "openai"]);
  assert.ok("claude-sonnet-5-5" in task.providers.anthropic.models);
  assert.equal(task.providers.anthropic.models["claude-sonnet-5-5"].acceptsTemperature, false);
  const disabled = JSON.parse(JSON.stringify(config));
  disabled.providers.openai.enabled = false;
  assert.deepEqual(Object.keys(enabledProviders(disabled)), ["anthropic", "gemini"]);
  assert.deepEqual(task.rules, { fields: CHANGE_FIELDS, temperature: { min: 0, max: 1 }, protectedAgents: ["qa", "publisher"] });
  assert.ok(task.notes.some((n) => n.startsWith("No runs this month for ceo, hr, analyst")));
  for (const line of JSON.stringify(task).split("\n")) assert.ok(!/sk-|ghp_|EAA/.test(line));
});

test("hr.bad.json → AgentOutputError after exactly one repair call; nothing written", async () => {
  const fx = copyFixture();
  try {
    const router = createRouter({ config, roster, state: fx.state, processEnv: { ...MOCK, MOCK_LLM_CASE_HR: "bad" }, now: NOV_1, charters: company.charters });
    await assert.rejects(runHr({ config, roster, router, state: fx.state, now: NOV_1, runId: "engine-daily-20261101-0531-bad000" }), (err) => {
      assert.ok(err instanceof AgentOutputError, String(err));
      assert.equal(err.calls, 2, "one call + one repair");
      assert.match(err.message, /qa reviewed 0 times/);
      assert.match(err.message, new RegExp(EVIDENCE_RULE));
      return true;
    });
    assert.equal(fx.state.exists("state/hr/2026-10-review.md"), false);
    assert.equal(fx.state.exists("state/hr/proposals/2026-10.json"), false);
    assert.equal(fx.state.readJsonl("state/usage/2026-10.jsonl").filter((u) => u.agent === "hr").length, 0, "the 1 November calls land in November's usage file");
    assert.equal(fx.state.readJsonl("state/usage/2026-11.jsonl").filter((u) => u.agent === "hr").length, 2);
  } finally {
    fx.cleanup();
  }
});

test("hr.ok.json on 1 November → hr/2026-10-review.md (Markdown + JSON block with the stats) and hr/proposals/2026-10.json (status proposed, HR_PROPOSAL_SPEC); the review is re-readable and the tree validates", async () => {
  const fx = copyFixture();
  try {
    const router = createRouter({ config, roster, state: fx.state, processEnv: MOCK, now: NOV_1, charters: company.charters });
    const r = await runHr({ config, roster, router, state: fx.state, now: NOV_1, runId: "engine-daily-20261101-0531-0ca11e" });
    assert.equal(r.month, "2026-10");
    assert.equal(r.reviewRel, "state/hr/2026-10-review.md");
    assert.equal(r.proposalRel, "state/hr/proposals/2026-10.json");
    assert.equal(r.calls, 1);
    assert.equal(r.mock, true);
    assert.equal(r.note, "8 agents reviewed, 1 change proposed → hr/proposals/2026-10.json");
    assert.ok(fx.state.exists(r.reviewRel) && fx.state.exists(r.proposalRel));
    const proposal = fx.state.readJson(r.proposalRel, HR_PROPOSAL_SPEC);
    assert.deepEqual(proposal, { month: "2026-10", at: "2026-11-01T05:31:00+05:30", runId: "engine-daily-20261101-0531-0ca11e", status: "proposed", reviewPath: "hr/2026-10-review.md", review: okFixture.output.review, changes: okFixture.output.rosterProposal.changes });
    assert.deepEqual(proposal.changes, [{ agent: "writer", field: "temperature", from: "0.8", to: "0.7", why: proposal.changes[0].why }]);
    const markdown = fx.state.readText(r.reviewRel);
    assert.ok(markdown.startsWith("# HR review 2026-10\n"));
    const parsed = parseReview(markdown);
    assert.deepEqual(parsed.review, okFixture.output, "the block is the model output");
    assert.deepEqual(parsed.engine.stats, r.stats);
    assert.deepEqual(parsed.engine.stats, computeAgentStats({ month: "2026-10", agents: NAMES, ...readMonthData(fx.state, "2026-10"), usageMonth: readMonthData(fx.state, "2026-10").usage }), "the provenance holds the stats the evidence was checked against");
    assert.deepEqual(parsed.engine.data, { usageRows: 6, runs: 3, draftsWritten: 5, published: 2, feedback: 2 });
    assert.equal(parsed.engine.mock, true);
    assert.equal(renderReview(okFixture.output, parsed.engine), markdown);
    assert.equal(parsed.body, okFixture.output.reviewMarkdown.trimEnd());
    assert.deepEqual(listReviews(fx.state).map((x) => x.month), ["2026-10", "2026-09"], "newest first; the fixture's September review stays");
    assert.deepEqual(listProposals(fx.state).map((x) => x.month), ["2026-10", "2026-09"]);
    assert.equal(latestReview(fx.state).month, "2026-10");
    assert.deepEqual(validateTree(fx.dir).errors, []);
    // roster.json is untouched: HR proposes, the owner applies (D13)
    assert.equal(JSON.parse(readFileSync(join(fx.dir, "roster.json"), "utf8")).agents.find((a) => a.name === "writer").temperature, 0.8);
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("daily on the 1st (MOCK_LLM): the HR row has one call and the note '8 agents reviewed, 1 change proposed'; the run record lists both files; on 12 October it is 'skipped: not_due'; `hr` command = forced daily --agents hr; --page refused", async () => {
  const fx = copyFixture();
  try {
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: NOV_1, processEnv: MOCK, flags: { agents: "hr" }, stdout: () => {} });
    assert.equal(r.ok, true);
    const row = agentRow(r, "hr");
    assert.equal(row.ok, true);
    assert.equal(row.calls, 1);
    assert.equal(row.skipped, undefined);
    assert.match(row.note, /^8 agents reviewed, 1 change proposed → hr\/proposals\/2026-10\.json/);
    assert.ok(r.run.changed.includes("company/state/hr/2026-10-review.md") && r.run.changed.includes("company/state/hr/proposals/2026-10.json"), r.run.changed.join());
    for (const name of AGENT_ORDER) if (name !== "hr") assert.equal(agentRow(r, name).skipped, "not_selected", name);
    // the same day again: the proposal is replaced (no decision yet), noted on the row
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-11-01T09:00:00+05:30", processEnv: MOCK, flags: { agents: "hr" }, stdout: () => {} });
    assert.match(agentRow(r2, "hr").note, /hr\/proposals\/2026-10\.json is replaced \(no decision recorded for it yet\)/);
    // an ordinary day with the proposal on file → not_due, no call
    const r3 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-11-05T05:31:00+05:30", processEnv: MOCK, flags: { agents: "hr" }, stdout: () => {} });
    assert.equal(agentRow(r3, "hr").skipped, SKIP_NOT_DUE);
    assert.equal(agentRow(r3, "hr").calls, 0);
    // --page filters HR out unless --agents names it
    const r4 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: NOV_1, processEnv: MOCK, flags: { agents: "hr,strategist", page: "kaatdo" }, stdout: () => {} });
    assert.equal(agentRow(r4, "hr").skipped, undefined, "named by --agents, so the page filter does not skip it");
    const r5 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: NOV_1, processEnv: MOCK, flags: { agents: "strategist", page: "kaatdo" }, stdout: () => {} });
    assert.equal(agentRow(r5, "hr").skipped, "not_selected");
    // the fixture's own day: September's proposal is on file → not_due
    const r6 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: OCT_12, processEnv: MOCK, flags: { agents: "hr" }, stdout: () => {} });
    assert.equal(agentRow(r6, "hr").skipped, SKIP_NOT_DUE);
    assert.match(agentRow(r6, "hr").note, /^skipped: not_due — not the 1st of the month and hr\/proposals\/2026-09\.json exists/);
  } finally {
    fx.cleanup();
  }
  // the hr command forces the review on an ordinary day (temp copy, --dry-run --now)
  const out = sink();
  const err = sink();
  const code = await main(["hr", "--dry-run", "--now", "2026-11-15T10:00:00+05:30"], { stdout: out, stderr: err, processEnv: { ...MOCK, MEDIA_DIR: "tests/fixtures/media" }, companyDir: COMPANY_DIR });
  assert.equal(code, EXIT.ok, out.text() + err.text());
  assert.ok(out.lines.some((l) => l.startsWith("[hr] ok ") && l.includes("8 agents reviewed, 1 change proposed")), out.text());
  assert.ok(out.lines.some((l) => l.startsWith("[strategist] ok ") && l.includes("skipped: not selected")), out.text());
  const tmp = out.lines[0].match(/temp copy (.+) \(the repo/)[1];
  assert.ok(existsSync(join(tmp, "state", "hr", "proposals", "2026-10.json")));
  assert.equal(existsSync(join(COMPANY_DIR, "state", "hr", "proposals", "2026-10.json")), false, "the fixture company is untouched");
  rmSync(join(tmp, ".."), { recursive: true, force: true });
  // without data for the previous month even the forced review skips (no model call)
  const out2 = sink();
  assert.equal(await main(["hr", "--dry-run", "--now", "2026-12-15T10:00:00+05:30"], { stdout: out2, stderr: sink(), processEnv: { ...MOCK, MEDIA_DIR: "tests/fixtures/media" }, companyDir: COMPANY_DIR }), EXIT.ok);
  assert.ok(out2.lines.some((l) => l.startsWith("[hr] ok ") && l.includes(`skipped: ${SKIP_NO_DATA}`)), out2.text());
  const tmp2 = out2.lines[0].match(/temp copy (.+) \(the repo/)[1];
  rmSync(join(tmp2, ".."), { recursive: true, force: true });
  const e3 = sink();
  assert.equal(await runHrCommand({ flags: { page: "kaatdo" }, stderr: e3 }), 2);
  assert.match(e3.text(), /--page is not accepted/);
  const e4 = sink();
  assert.equal(await runHrCommand({ flags: { agents: "writer" }, stderr: e4 }), 2);
  assert.match(e4.text(), /--agents is fixed to hr/);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("the HR charter describes the built review (stats fields, the 1st, the four fields, the decisions log) and the roster schedules it monthly", () => {
  const charter = company.charters.hr.text;
  for (const s of ["`calls`, `failedCalls`, `costUsd`, `avgMs`", "`qaRejectionRate`", "`reworkLoops`", "`costPerApprovedPost`", "`providerFailures`", "runs on the 1st of each month", "hr/decisions.jsonl", "Built in phase 2"]) assert.ok(charter.includes(s), s);
  assert.ok(!charter.includes("not built yet"), "the charter no longer calls the review unbuilt");
  assert.ok(charter.includes('"from": "0.8", "to": "0.7"'), "the example writes from/to as strings, like OUTPUT_SPEC");
  const hr = roster.agents.find((a) => a.name === "hr");
  assert.equal(hr.schedule, "monthly-1st");
  assert.equal(hr.kind, "llm");
  assert.equal(readFileSync(join(ROOT, "company", "charters", "hr.md"), "utf8"), readFileSync(join(COMPANY_DIR, "charters", "hr.md"), "utf8"), "the fixture charter is the real one, byte for byte");
});
