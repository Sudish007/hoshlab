// engine/agents/ceo.js — Monday / missing-memo trigger, the weekly memo with its fenced JSON block
// (design §3.1 step 2, §5; review N7; P1-07), the ≤ 100 % budget split (repair → AgentOutputError).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { memoPath } from "../engine/lib/ids.js";
import { FEEDBACK_SPEC, PUBLISHED_SPEC, USAGE_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { AgentOutputError, createRouter } from "../engine/llm/router.js";
import { latestReport } from "../engine/agents/analyst.js";
import { latestDecisions, latestReview, readDecisions } from "../engine/agents/hr.js";
import { AGENT, ANSWERS_HEADING, DEFAULT_HANDLES, MAX_BUDGET_SPLIT_PCT, NO_HR_REVIEW_NOTE, NO_REPORT_NOTE, OUTPUT_SPEC, answersSection, buildTask, feedbackSince, hrReviewInput, memoExcerptFor, outputSpec, parseMemo, prioritiesFor, proposalStatus, publishedSince, readMemo, renderMemo, reportInput, runCeo, shouldRun, usageSummary, validateCeoOutput } from "../engine/agents/ceo.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster, brands, charters } = company;
const MONDAY = "2026-10-12T05:31:00+05:30";
const TUESDAY = "2026-10-13T05:31:00+05:30";
const RUN_ID = "engine-daily-20261012-0531-abc123";
const SECRET_NAMES = Object.values(config.providers).map((p) => p.secret);
const llm = (name) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "llm", `${name}.json`), "utf8"));
// The populated fixture's latest Analyst report (2026-W41) and HR review (2026-09) — the CEO's phase-2 inputs (P2-07).
const fixtureState = createState({ companyDir: COMPANY_DIR, now: MONDAY });
const FIXTURE_REPORT = latestReport(fixtureState);
const FIXTURE_REVIEW = latestReview(fixtureState);

function harness(now = MONDAY, processEnv = { MOCK_LLM: "1" }) {
  const dir = tmpDir("hoshlab-ceo-");
  const state = createState({ companyDir: dir, now });
  const router = createRouter({ config, roster, state, env: readEnv(SECRET_NAMES, {}), fetchImpl: () => Promise.reject(new Error("no network in tests")), now, runId: RUN_ID, charters, processEnv });
  return { dir, state, router, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A router stand-in that answers from a fixture and records the call (isMock, like the real router under MOCK_LLM=1:
// the fixture answers are pinned to one week and one report, so those two rules are waived for it — never for a provider).
function fakeRouter(fixtureName) {
  const calls = [];
  return {
    calls,
    runId: RUN_ID,
    isMock: true,
    async complete(agent, args) {
      calls.push({ agent, args });
      const fx = llm(fixtureName);
      const errors = args.validate ? args.validate(fx.output) : [];
      if (errors.length) throw new AgentOutputError({ agent, provider: "mock", model: "mock", errors, repairErrors: errors, text: JSON.stringify(fx.output), calls: 2 });
      return { json: structuredClone(fx.output), text: JSON.stringify(fx.output), usage: fx.usage, costUsd: 0, provider: "mock", model: "mock", ms: 1, mock: true, calls: 1, repaired: false, raw: {}, failures: [] };
    },
  };
}

test("memoPath for 2026-10-12+05:30 is memos/2026-W42.md (N7) and shouldRun: Monday IST → true even with a memo; other days only while the week's memo is missing", () => {
  assert.equal(memoPath(MONDAY), "memos/2026-W42.md");
  const h = harness();
  try {
    assert.equal(shouldRun(MONDAY, h.state), true, "Monday, no memo");
    assert.equal(shouldRun(TUESDAY, h.state), true, "Tuesday, memo missing");
    h.state.writeText("state/memos/2026-W42.md", "# memo\n");
    assert.equal(shouldRun(MONDAY, h.state), true, "Monday always runs");
    assert.equal(shouldRun(TUESDAY, h.state), false, "Tuesday with the week's memo present");
    assert.equal(shouldRun("2026-10-19T05:31:00+05:30", h.state), true, "next Monday");
    assert.equal(shouldRun("2026-10-20T05:31:00+05:30", h.state), true, "next Tuesday: W43 memo missing");
    // Sunday 23:00 UTC is Monday 04:30 IST
    assert.equal(shouldRun(new Date("2026-10-18T23:00:00Z"), h.state), true);
  } finally {
    h.cleanup();
  }
});

test("runCeo under MOCK_LLM=1 writes memos/2026-W42.md = memoMarkdown + a fenced JSON block that parseMemo reads back (P1-07); one usage line mock:true; no network", async () => {
  const h = harness();
  try {
    const res = await runCeo({ config, brands, router: h.router, state: h.state, now: MONDAY, runId: RUN_ID, flags: ["budget_warn"] });
    assert.equal(res.week, "2026-W42");
    assert.equal(res.path, "memos/2026-W42.md");
    assert.equal(res.rel, "state/memos/2026-W42.md");
    assert.equal(res.modelCalled, true);
    assert.equal(res.mock, true);
    assert.equal(res.calls, 1);
    assert.equal(res.costUsd, 0);
    assert.match(res.note, /^6 priorities, 0 paused, no Analyst report to answer, 1 owner questions → memos\/2026-W42\.md$/);
    assert.ok(h.state.exists("state/memos/2026-W42.md"));
    const text = h.state.readText("state/memos/2026-W42.md");
    assert.ok(text.startsWith("# Memo 2026-W42\n"), "memoMarkdown first");
    assert.ok(text.includes("\n\n```json\n"), "fenced json block");
    assert.ok(text.endsWith("\n```\n"));
    assert.equal(Buffer.from(text, "utf8")[0] !== 0xef, true, "no BOM");
    const memo = parseMemo(text);
    assert.equal(memo.week, "2026-W42");
    assert.deepEqual(memo.budgetSplitPct, { rishtapatra: 35, kaatdo: 30, job_rez: 35 });
    assert.equal(Object.values(memo.budgetSplitPct).reduce((a, b) => a + b, 0), 100);
    assert.deepEqual(memo, llm("ceo.ok").output, "the block is the whole validated output");
    assertShape(memo, OUTPUT_SPEC);
    assert.equal(renderMemo(memo), text);
    // the mock's answers are rendered even without a report (the answers rule is waived under MOCK_LLM, like the week)
    assert.ok(text.includes(`\n\n${ANSWERS_HEADING}\n\n1. `), "answers section rendered from answers[] before the JSON block");
    assert.ok(text.indexOf(ANSWERS_HEADING) < text.indexOf("```json"));
    assert.deepEqual(readMemo(h.state, TUESDAY), { rel: "state/memos/2026-W42.md", markdown: text, memo });
    assert.equal(readMemo(h.state, "2026-10-19T05:31:00+05:30"), null, "next week has no memo yet");
    assert.equal(shouldRun(TUESDAY, h.state), false);
    const usage = h.state.readJsonl(h.state.monthLogPath("usage"));
    assert.equal(usage.length, 1);
    assert.equal(validate(usage[0], USAGE_SPEC).ok, true);
    assert.equal(usage[0].agent, AGENT);
    assert.equal(usage[0].page, undefined, "company-wide call carries no page");
    assert.equal(usage[0].mock, true);
    assert.equal(usage[0].runId, RUN_ID);
  } finally {
    h.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("ceo.bad (split 120 %) fails the semantic validation → exactly one repair call → AgentOutputError; nothing is written", async () => {
  const h = harness(MONDAY, { MOCK_LLM: "1", MOCK_LLM_CASE_CEO: "bad" });
  try {
    await assert.rejects(runCeo({ config, brands, router: h.router, state: h.state, now: MONDAY }), (e) => {
      assert.ok(e instanceof AgentOutputError, e.message);
      assert.equal(e.agent, AGENT);
      assert.equal(e.calls, 2, "first answer + one repair");
      assert.ok(e.errors.some((x) => /budgetSplitPct: sums to 120, must not exceed 100/.test(x)), e.errors.join("; "));
      assert.ok(e.repairErrors.some((x) => /sums to 120/.test(x)));
      return true;
    });
    assert.equal(h.state.exists("state/memos/2026-W42.md"), false);
    assert.equal(h.state.readJsonl(h.state.monthLogPath("usage")).length, 2, "both attempts are usage lines");
  } finally {
    h.cleanup();
  }
});

test("validateCeoOutput: week mismatch, unknown page, disputed/foreign fact id, pause page and the > 100 % split are errors; the ok fixture has none", () => {
  const pages = config.pages.map((p) => ({ handle: p.handle, factIds: new Set(brands[p.handle].usableFacts().map((f) => f.id)) }));
  const ok = llm("ceo.ok").output;
  assert.deepEqual(validateCeoOutput(ok, { week: "2026-W42", pages }), []);
  assert.deepEqual(validateCeoOutput(ok, { week: "2026-W43", pages }), ['$.week: expected 2026-W43, got "2026-W42"']);
  const disputed = { ...ok, priorities: [{ page: "rishtapatra", rank: 1, theme: "x", why: "y", factIds: ["rp-f12"] }] };
  assert.deepEqual(validateCeoOutput(disputed, { week: "2026-W42", pages }), ["$.priorities[0].factIds[0]: rp-f12 is not a usable fact of @rishtapatra"]);
  const foreign = { ...ok, priorities: [{ page: "kaatdo", rank: 1, theme: "x", why: "y", factIds: ["rp-f04"] }] };
  assert.deepEqual(validateCeoOutput(foreign, { week: "2026-W42", pages }), ["$.priorities[0].factIds[0]: rp-f04 is not a usable fact of @kaatdo"]);
  const unknown = { ...ok, priorities: [{ page: "nobody", rank: 1, theme: "x", why: "y", factIds: [] }], pause: [{ page: "nobody", what: "x", why: "y" }] };
  assert.deepEqual(validateCeoOutput(unknown, { week: "2026-W42", pages }), ['$.priorities[0].page: unknown page "nobody"', '$.pause[0].page: unknown page "nobody"']);
  const over = { ...ok, budgetSplitPct: { rishtapatra: 50, kaatdo: 40, job_rez: 30 } };
  assert.deepEqual(validateCeoOutput(over, { week: "2026-W42", pages }), ["$.budgetSplitPct: sums to 120, must not exceed 100"]);
  const under = { ...ok, budgetSplitPct: { rishtapatra: 30, kaatdo: 30, job_rez: 30 } };
  assert.deepEqual(validateCeoOutput(under, { week: "2026-W42", pages }), [], "≤ 100 is accepted (the roster never-list forbids more than 100 %)");
  assert.equal(MAX_BUDGET_SPLIT_PCT, 100);
  // the spec names the page handles explicitly (M7: no map keys in the OpenAI strict dialect)
  assert.deepEqual(Object.keys(OUTPUT_SPEC.budgetSplitPct), DEFAULT_HANDLES);
  assert.deepEqual(Object.keys(outputSpec(["a", "b"]).budgetSplitPct), ["a", "b"]);
  assert.deepEqual(DEFAULT_HANDLES, config.pages.map((p) => p.handle));
});

test("task JSON: brand summaries carry usable facts only (no rp-f12), cadence, pricing, disclaimers; lastReport null → an honest note; feedback/published/usage windows and flags are passed through", async () => {
  const h = harness();
  try {
    const feedback = [
      { at: "2026-10-01T10:00:00+05:30", by: "owner", kind: "note", page: "job_rez", text: "Too salesy; keep to the six layout rules.", tags: ["tone"] },
      { at: "2026-09-01T10:00:00+05:30", by: "owner", kind: "praise", page: "kaatdo", text: "old praise", tags: [] },
    ];
    for (const f of feedback) assertShape(f, FEEDBACK_SPEC);
    const published = [
      { draftId: "kd-2026-10-06-six-rules", page: "kaatdo", igMediaId: "1", permalink: "https://www.instagram.com/p/x/", publishedAt: "2026-10-06T08:16:00+05:30", slotAt: "2026-10-06T08:15:00+05:30", late: false, mode: "approve_first", qaRevision: 1, format: "image", mediaUrlUsed: "raw", runId: "publisher-hourly-20261006-0816-aaaaaa" },
      { draftId: "kd-2026-09-20-old", page: "kaatdo", igMediaId: "2", permalink: "https://www.instagram.com/p/y/", publishedAt: "2026-09-20T08:16:00+05:30", slotAt: "2026-09-20T08:15:00+05:30", late: false, mode: "approve_first", qaRevision: 1, format: "image", mediaUrlUsed: "raw", runId: "publisher-hourly-20260920-0816-aaaaaa" },
    ];
    for (const p of published) assertShape(p, PUBLISHED_SPEC);
    // feedback.jsonl is admin-owned: seed it with plain fs, as the admin would
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(h.dir, "state"), { recursive: true });
    writeFileSync(join(h.dir, "state", "feedback.jsonl"), feedback.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
    for (const p of published) h.state.appendJsonl("state/published.jsonl", p, PUBLISHED_SPEC);
    h.state.appendLog("usage", { at: "2026-10-05T05:31:00+05:30", runId: "engine-daily-20261005-0531-aaaaaa", agent: "writer", page: "kaatdo", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 5000, outputTokens: 900, costUsd: 0.019, ms: 4000, ok: true, mock: false }, USAGE_SPEC);
    h.state.appendLog("usage", { at: "2026-10-05T05:32:00+05:30", runId: "engine-daily-20261005-0531-aaaaaa", agent: "qa", page: "kaatdo", provider: "gemini", model: "gemini-3.8-flash", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 100, ok: false, error: "429 rate limited", mock: false }, USAGE_SPEC);

    assert.deepEqual(feedbackSince(h.state, MONDAY, 30).map((f) => f.text), ["Too salesy; keep to the six layout rules."]);
    assert.deepEqual(publishedSince(h.state, MONDAY, 14).map((p) => p.draftId), ["kd-2026-10-06-six-rules"]);
    const usage = usageSummary(h.state, MONDAY, config);
    assert.deepEqual(usage, { month: "2026-10", usedUsd: 0.019, limitUsd: 25, calls: 2, failed: 1, byAgent: { writer: 0.019, qa: 0 }, byPage: { kaatdo: 0.019 } });

    const router = fakeRouter("ceo.ok");
    const res = await runCeo({ config, brands, router, state: h.state, now: MONDAY, flags: new Set(["budget_warn"]) });
    assert.equal(res.modelCalled, true);
    const [{ agent, args }] = router.calls;
    assert.equal(agent, AGENT);
    assert.deepEqual(args.spec, outputSpec(config.pages.map((p) => p.handle)));
    assert.equal(args.context.brand, null);
    assert.equal(args.context.page, null);
    const task = args.task;
    assert.equal(task.week, "2026-W42");
    assert.equal(task.today, "2026-10-12");
    assert.deepEqual(task.brands.map((b) => b.handle), ["rishtapatra", "kaatdo", "job_rez"]);
    const rp = task.brands[0];
    assert.ok(rp.facts.some((f) => f.id === "rp-f08"));
    assert.ok(!rp.facts.some((f) => f.id === "rp-f12"), "disputed fact excluded (P1-04)");
    assert.deepEqual(rp.formats, ["image", "carousel", "reel"], "reel offered now that features.reels is true (FEAT-201)");
    assert.equal(rp.cadence.length, 4, "three feed slots plus the Saturday reel slot (plan D22)");
    assert.equal(rp.mode, "approve_first");
    assert.ok(rp.pricing.some((p) => p.sku === "shubh-pass"));
    assert.equal(rp.disclaimers.length, 1);
    assert.equal(task.lastReport, null);
    assert.equal(task.hrReview, null);
    assert.deepEqual(task.notes, [NO_REPORT_NOTE, NO_HR_REVIEW_NOTE]);
    assert.ok(!task.notes.join(" ").includes("phase 2"), "the Analyst is built: the note explains when a report appears, not a phase");
    assert.deepEqual(task.feedback.map((f) => f.text), ["Too salesy; keep to the six layout rules."]);
    assert.deepEqual(task.published.map((p) => p.draftId), ["kd-2026-10-06-six-rules"]);
    assert.deepEqual(task.usage, usage);
    assert.deepEqual(task.flags, ["budget_warn"]);
    const withReport = buildTask({ config, brands, now: MONDAY, lastReport: { week: "2026-W41", forCeo: ["a", "b"] }, hrReview: FIXTURE_REVIEW });
    assert.deepEqual(withReport.notes, ["Answer every one of the 2 items in lastReport.forCeo in `answers`, quoting each item verbatim as its forCeo; the engine renders them under \"Answers to the Analyst\" — do not repeat them in memoMarkdown."]);
  } finally {
    h.cleanup();
  }
});

// FEAT-205 (P2-07): the CEO consumes the latest Analyst report, 30 days of feedback and the latest HR review, and the
// memo answers every forCeo item — the fixture report has two; ceo.ok answers both, ceo.bad2 only the first.
test("P2-07: with the fixture report + HR review the task carries both (forCeo items, verdicts, proposal status) and the memo's answers[] references every forCeo item; the file renders an 'Answers to the Analyst (report 2026-W41)' section", async () => {
  assert.ok(FIXTURE_REPORT && FIXTURE_REPORT.week === "2026-W41", "the populated fixture has the W41 report");
  assert.ok(FIXTURE_REVIEW && FIXTURE_REVIEW.month === "2026-09", "the populated fixture has the September HR review");
  const decision = latestDecisions(readDecisions(fixtureState)).get(FIXTURE_REVIEW.month) || null;
  assert.equal(decision, null, "no decisions.jsonl in the fixture → awaiting the owner");
  const h = harness();
  try {
    const router = fakeRouter("ceo.ok");
    const res = await runCeo({ config, brands, router, state: h.state, now: MONDAY, runId: RUN_ID, lastReport: FIXTURE_REPORT, hrReview: FIXTURE_REVIEW, hrDecision: decision });
    const task = router.calls[0].args.task;
    // the report as the model sees it: the JSON block without its Markdown
    assert.deepEqual(task.lastReport, reportInput(FIXTURE_REPORT));
    assert.equal(task.lastReport.week, "2026-W41");
    assert.equal(task.lastReport.path, "reports/2026-W41.md");
    assert.equal(task.lastReport.generatedAt, "2026-10-11T21:03:30+05:30");
    assert.deepEqual(task.lastReport.forCeo, FIXTURE_REPORT.report.forCeo);
    assert.equal(task.lastReport.forCeo.length, 2);
    assert.deepEqual(task.lastReport.perPage.map((p) => p.page), ["rishtapatra", "kaatdo", "job_rez"]);
    assert.equal(task.lastReport.reportMarkdown, undefined, "the Markdown stays out of the task (the JSON carries every number)");
    // the HR review with the proposal's status derived from the (absent) decisions log
    assert.deepEqual(task.hrReview, hrReviewInput(FIXTURE_REVIEW, null));
    assert.equal(task.hrReview.month, "2026-09");
    assert.equal(task.hrReview.proposalStatus, "proposed");
    assert.equal(task.hrReview.decidedAt, null);
    assert.equal(task.hrReview.review.length, 8);
    assert.deepEqual(task.hrReview.changes, [{ agent: "writer", field: "temperature", from: "0.8", to: "0.7", why: task.hrReview.changes[0].why }]);
    assert.ok(task.hrReview.reviewMarkdown.length > 0);
    assert.deepEqual(task.notes, ['Answer every one of the 2 items in lastReport.forCeo in `answers`, quoting each item verbatim as its forCeo; the engine renders them under "Answers to the Analyst" — do not repeat them in memoMarkdown.']);
    assert.equal(task.feedback.length, 0, "the temp state has no feedback.jsonl");
    // the validate hook enforces the answers rule against the report's items
    const ok = llm("ceo.ok").output;
    assert.deepEqual(router.calls[0].args.validate(ok), []);
    assert.deepEqual(router.calls[0].args.validate(llm("ceo.bad2").output), ['$.answers: no answer to the Analyst\'s item 2 (quote it verbatim in forCeo): "@job_rez has published nothing yet; the first JobRez post is the one to watch next week."']);
    // the memo references each forCeo item
    assert.deepEqual(res.memo.answers.map((a) => a.forCeo), FIXTURE_REPORT.report.forCeo);
    assert.match(res.note, /^6 priorities, 0 paused, 2 answers to the Analyst \(2026-W41\), 1 owner questions → memos\/2026-W42\.md$/);
    const text = h.state.readText("state/memos/2026-W42.md");
    assert.ok(text.includes(`\n\n${ANSWERS_HEADING} (report 2026-W41)\n\n1. ${FIXTURE_REPORT.report.forCeo[0]}\n   Answer: ${ok.answers[0].answer}\n2. ${FIXTURE_REPORT.report.forCeo[1]}\n   Answer: ${ok.answers[1].answer}\n\n\`\`\`json\n`), text);
    assert.equal(renderMemo(ok, { reportWeek: "2026-W41" }), text);
    assert.deepEqual(parseMemo(text).answers, ok.answers, "the JSON block carries the answers");
    assert.equal(answersSection([], "2026-W41"), "");
    assert.equal(answersSection([{ forCeo: "a  b", answer: " c\nd " }]), `${ANSWERS_HEADING}\n\n1. a b\n   Answer: c d`);
  } finally {
    h.cleanup();
  }
});

test("P2-07: ceo.bad2 (one forCeo item unanswered) fails the answers rule → exactly one repair call → AgentOutputError, nothing written; without a report a real provider may not answer anything, the mock is not held to it", async () => {
  const h = harness(MONDAY, { MOCK_LLM: "1", MOCK_LLM_CASE_CEO: "bad2" });
  try {
    await assert.rejects(runCeo({ config, brands, router: h.router, state: h.state, now: MONDAY, lastReport: FIXTURE_REPORT }), (e) => {
      assert.ok(e instanceof AgentOutputError, e.message);
      assert.equal(e.calls, 2, "first answer + one repair");
      assert.ok(e.errors.some((x) => /no answer to the Analyst's item 2/.test(x)), e.errors.join("; "));
      assert.ok(e.repairErrors.some((x) => /no answer to the Analyst's item 2/.test(x)));
      return true;
    });
    assert.equal(h.state.exists("state/memos/2026-W42.md"), false);
    assert.equal(h.state.readJsonl(h.state.monthLogPath("usage")).length, 2);
  } finally {
    h.cleanup();
  }
  // the rule itself
  const pages = config.pages.map((p) => ({ handle: p.handle, factIds: new Set(brands[p.handle].usableFacts().map((f) => f.id)) }));
  const ok = llm("ceo.ok").output;
  const items = FIXTURE_REPORT.report.forCeo;
  assert.deepEqual(validateCeoOutput(ok, { week: "2026-W42", pages, forCeo: items }), []);
  assert.deepEqual(validateCeoOutput(ok, { week: "2026-W42", pages, forCeo: null }), [], "null = not checked (mock without a report)");
  assert.deepEqual(validateCeoOutput(ok, { week: "2026-W42", pages, forCeo: [] }), [
    `$.answers[0].forCeo: there is no Analyst report to answer: ${JSON.stringify(ok.answers[0].forCeo)}`,
    `$.answers[1].forCeo: there is no Analyst report to answer: ${JSON.stringify(ok.answers[1].forCeo)}`,
  ]);
  assert.deepEqual(validateCeoOutput({ ...ok, answers: [] }, { week: "2026-W42", pages, forCeo: [] }), [], "no report, no answers");
  const spaced = { ...ok, answers: ok.answers.map((a) => ({ ...a, forCeo: `  ${a.forCeo.replace(/ /g, "  ")} ` })) };
  assert.deepEqual(validateCeoOutput(spaced, { week: "2026-W42", pages, forCeo: items }), [], "whitespace differences do not count");
  const invented = { ...ok, answers: [...ok.answers, { forCeo: "Post more reels.", answer: "No." }] };
  assert.deepEqual(validateCeoOutput(invented, { week: "2026-W42", pages, forCeo: items }), ['$.answers[2].forCeo: not an item of the Analyst report: "Post more reels."']);
  const empty = { ...ok, answers: ok.answers.map((a, i) => (i === 0 ? { ...a, answer: "  " } : a)) };
  assert.deepEqual(validateCeoOutput(empty, { week: "2026-W42", pages, forCeo: items }), ["$.answers[0].answer: empty"]);
  // input shaping helpers
  assert.equal(reportInput(null), null);
  assert.deepEqual(reportInput({ week: "2026-W41", forCeo: ["x"] }), { week: "2026-W41", path: null, generatedAt: null, perPage: [], experiments: [], forCeo: ["x"] });
  assert.equal(hrReviewInput(null), null);
  assert.equal(proposalStatus(null), "proposed");
  assert.equal(proposalStatus({ decision: "apply", at: "2026-10-02T09:00:00+05:30" }), "applied");
  assert.equal(proposalStatus({ decision: "dismiss" }), "dismissed");
  const applied = hrReviewInput(FIXTURE_REVIEW, { month: "2026-09", proposal: "hr/proposals/2026-09.json", decision: "apply", at: "2026-10-02T09:00:00+05:30", by: "owner" });
  assert.equal(applied.proposalStatus, "applied");
  assert.equal(applied.decidedAt, "2026-10-02T09:00:00+05:30");
  assert.ok(OUTPUT_SPEC.answers, "the spec carries answers");
  assert.deepEqual(OUTPUT_SPEC.answers, [{ forCeo: "str", answer: "str" }]);
});

test("parseMemo / prioritiesFor / memoExcerptFor: last json block wins, ranks sorted per page, empty excerpt for a page without priorities", () => {
  assert.equal(parseMemo("# no block\n"), null);
  assert.equal(parseMemo(""), null);
  const two = "# memo\n\n```json\n{\"week\":\"2026-W41\"}\n```\n\ntext\n\n```json\n{\"week\":\"2026-W42\",\"priorities\":[{\"page\":\"kaatdo\",\"rank\":2,\"theme\":\"b\",\"why\":\"B\",\"factIds\":[]},{\"page\":\"kaatdo\",\"rank\":1,\"theme\":\"a\",\"why\":\"A\",\"factIds\":[\"kd-f04\"]}],\"pause\":[{\"page\":\"kaatdo\",\"what\":\"sat carousel\",\"why\":\"budget\"}]}\n```\n";
  const memo = parseMemo(two);
  assert.equal(memo.week, "2026-W42");
  const kd = prioritiesFor(memo, "kaatdo");
  assert.deepEqual(kd.priorities.map((p) => p.rank), [1, 2]);
  assert.equal(kd.pause.length, 1);
  assert.equal(kd.week, "2026-W42");
  assert.deepEqual(prioritiesFor(memo, "job_rez"), { week: "2026-W42", priorities: [], pause: [] });
  assert.deepEqual(prioritiesFor(null, "job_rez"), { week: null, priorities: [], pause: [] });
  assert.equal(memoExcerptFor(memo, "job_rez"), "");
  assert.equal(memoExcerptFor(null, "kaatdo"), "");
  const excerpt = memoExcerptFor(memo, "kaatdo");
  assert.ok(excerpt.startsWith("Memo 2026-W42 — priorities for @kaatdo:\n1. a — A (facts: kd-f04)\n2. b — B\nPaused:\n- sat carousel — budget"), excerpt);
  assert.throws(() => parseMemo("```json\n{not json}\n```\n"), SyntaxError);
});
