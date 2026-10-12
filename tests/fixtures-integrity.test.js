// tests/fixtures/company-populated is the company the site and admin build from, so every number in it
// must be computed, not typed (coder rule 7): media rows match the committed JPEGs byte for byte,
// budget.usedUsd is the sum of the usage lines, queue/blocked counts come from the drafts, and every
// state file validates against its spec (engine/lib/state.js validateTree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, ROOT } from "./helpers.js";
import { createState, validateTree } from "../engine/lib/state.js";
import { round6 } from "../engine/lib/budget.js";
import { jpegSize } from "../engine/lib/checks.js";
import { MAX_MEDIA_BYTES } from "../engine/lib/checks.js";
import { pagesUrl, rawUrl } from "../engine/lib/media.js";
import { parseMemo, outputSpec, renderMemo, validateCeoOutput } from "../engine/agents/ceo.js";
import { OUTPUT_SPEC as ANALYST_OUTPUT_SPEC, aggregate, allowedNumbers, numberTokens, parseReport, renderReport, validateAnalystOutput } from "../engine/agents/analyst.js";
import { OUTPUT_SPEC as HR_OUTPUT_SPEC, computeAgentStats, listProposals, listReviews, parseReview, readMonthData, renderReview, validateHrOutput } from "../engine/agents/hr.js";
import { HR_PROPOSAL_SPEC, METRIC_SPEC, assertShape } from "../engine/lib/schema.js";
import { loadCompany } from "../src/lib/company.js";
import { usableFacts } from "../engine/lib/brand.js";
import { queueCounts } from "../engine/commands/publish.js";

const MEDIA = join(ROOT, "tests", "fixtures", "media");
const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, brands } = company;
const state = createState({ companyDir: COMPANY_DIR, now: "2026-10-12T09:04:40+05:30" });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const drafts = state.listDrafts().map((id) => state.readDraft(id));

test("every fixture draft's media[] names an existing file under tests/fixtures/media/<draftId>/ with matching bytes, sha256, sha8 file name, 1080×1350 SOF and the config's raw/pages URLs", () => {
  assert.ok(drafts.length >= 5, drafts.map((d) => d.id).join());
  let files = 0;
  for (const d of drafts) {
    assert.ok(d.media.length >= 1, `${d.id}: no media`);
    assert.equal(d.media.length, d.format === "carousel" ? d.slides.length : 1, `${d.id}: one file per slide / one image`);
    for (const [i, m] of d.media.entries()) {
      const file = m.path.split("/").pop();
      assert.equal(m.path, `media/${d.id}/${file}`);
      const abs = join(MEDIA, d.id, file);
      assert.ok(existsSync(abs), `${abs} missing`);
      const buf = readFileSync(abs);
      assert.equal(m.bytes, buf.length, `${d.id} ${file}: bytes`);
      assert.equal(m.sha256, sha256(buf), `${d.id} ${file}: sha256`);
      assert.equal(file, `${d.format === "carousel" ? "slide" : "image"}-${i + 1}-${m.sha256.slice(0, 8)}.jpg`, "sha8-named");
      assert.deepEqual(jpegSize(buf), { width: 1080, height: 1350 });
      assert.deepEqual([m.width, m.height], [1080, 1350]);
      assert.ok(buf.length <= MAX_MEDIA_BYTES);
      assert.equal(m.rawUrl, rawUrl(config, m.path));
      assert.equal(m.pagesUrl, pagesUrl(config, m.path));
      files++;
    }
  }
  // and nothing under tests/fixtures/media/<id>/ is orphaned (the flat fixture-1080x1350.jpg at the root is the QA unit fixture)
  const onDisk = readdirSync(MEDIA)
    .filter((n) => statSync(join(MEDIA, n)).isDirectory())
    .flatMap((id) => readdirSync(join(MEDIA, id)).map((f) => `media/${id}/${f}`))
    .sort();
  assert.deepEqual(onDisk, drafts.flatMap((d) => d.media.map((m) => m.path)).sort());
  assert.equal(files, onDisk.length);
});

test("status.json: budget.usedUsd equals the sum of usage/2026-10.jsonl costUsd (6 decimals), queue/blocked equal the draft counts, lastRuns mirror runs/2026-10.jsonl newest first, lastPublishedAt matches published.jsonl", () => {
  const status = state.readJson("state/status.json");
  const usage = state.readJsonl("state/usage/2026-10.jsonl");
  assert.ok(usage.length >= 6, `${usage.length} usage lines`);
  assert.equal(status.budget.usedUsd, round6(usage.reduce((s, u) => s + u.costUsd, 0)));
  assert.equal(status.budget.month, "2026-10");
  assert.equal(status.budget.limitUsd, config.budget.monthlyUsd);
  assert.equal(status.budget.exhausted, false);
  // every costUsd is the price-table arithmetic for its tokens; the mock line costs nothing
  for (const u of usage) {
    if (u.mock) {
      assert.equal(u.costUsd, 0);
      assert.equal(u.provider, "mock");
      continue;
    }
    const price = config.providers[u.provider].models[u.model];
    assert.ok(price, `${u.provider}/${u.model} has a price row`);
    assert.equal(u.costUsd, round6((u.inputTokens * price.inputPerMTok) / 1e6 + (u.outputTokens * price.outputPerMTok) / 1e6), `${u.agent} ${u.at}`);
  }
  assert.deepEqual(new Set(usage.map((u) => u.provider)), new Set(["anthropic", "gemini", "openai", "mock"]), "all providers + one mock line");
  assert.equal(usage.filter((u) => u.mock).length, 1);
  const counts = queueCounts(drafts, config);
  assert.deepEqual(status.queue, counts.queue);
  assert.deepEqual(status.blocked, counts.blocked);
  assert.deepEqual(status.queue, { rishtapatra: 1, kaatdo: 1, job_rez: 0 });
  assert.deepEqual(status.blocked, { job_rez: 1 });
  const runs = state.readJsonl("state/runs/2026-10.jsonl");
  assert.equal(runs.length, 3);
  assert.deepEqual(new Set(runs.map((r) => r.workflow)), new Set(["engine-daily", "publisher-hourly"]));
  assert.deepEqual(status.lastRuns, [...runs].sort((a, b) => b.endedAt.localeCompare(a.endedAt)), "newest first");
  assert.deepEqual(status.lastRun, { id: status.lastRuns[0].id, workflow: status.lastRuns[0].workflow, ok: status.lastRuns[0].ok, at: status.lastRuns[0].endedAt });
  for (const r of runs) {
    for (const a of r.agents) assert.ok(typeof a.note === "string" && a.note.length > 0, `${r.id} ${a.name}: note`);
    // agents' calls / costUsd are the usage lines of that run
    for (const a of r.agents) {
      const rows = usage.filter((u) => u.runId === r.id && u.agent === a.name);
      assert.equal(a.calls, rows.length, `${r.id} ${a.name}: calls`);
      assert.equal(a.costUsd, round6(rows.reduce((s, u) => s + u.costUsd, 0)), `${r.id} ${a.name}: costUsd`);
    }
    assert.equal(r.budgetUsedUsd, round6(usage.filter((u) => u.at <= r.endedAt).reduce((s, u) => s + u.costUsd, 0)), `${r.id}: budgetUsedUsd is the spend up to its end`);
  }
  const published = state.readJsonl("state/published.jsonl");
  assert.equal(published.length, 2);
  assert.deepEqual(new Set(published.map((p) => p.page)), new Set(["rishtapatra", "kaatdo"]));
  for (const p of published) {
    assert.equal(p.mediaUrlUsed, "raw");
    assert.match(p.permalink, /^https:\/\/www\.instagram\.com\/p\/FIXTURE/, "visibly fixture permalinks");
    const d = drafts.find((x) => x.id === p.draftId);
    assert.ok(d, `${p.draftId} has a draft dir`);
    assert.equal(d.status, "published");
    assert.equal(d.publishAttempts.at(-1).ok, true);
    assert.equal(d.publishAttempts.at(-1).runId, p.runId);
    assert.equal(status.pages[p.page].lastPublishedAt, p.publishedAt);
    assert.ok(state.readQa(p.draftId).passed);
  }
  assert.equal(status.pages.job_rez.lastPublishedAt, null);
  const feedback = state.readJsonl("state/feedback.jsonl");
  assert.equal(feedback.length, 4, "two rejects (kaatdo, job_rez), a design note (kaatdo) and a language note (rishtapatra) — FEAT-205");
  assert.ok(feedback.some((f) => f.kind === "reject" && f.tags.includes("tone")));
  assert.ok(feedback.some((f) => f.kind === "note"));
  const rejects = feedback.filter((f) => f.kind === "reject");
  assert.deepEqual(rejects.map((f) => f.page), ["kaatdo", "job_rez"]);
  for (const reject of rejects) assert.ok(state.readJsonl("state/approvals.jsonl").some((a) => a.decision === "reject" && a.draftId === reject.draftId && a.reason === reject.text && a.at === reject.at), `${reject.draftId}: the reject has its approvals record`);
  assert.ok(rejects.some((f) => f.page === "job_rez" && f.text === "Too salesy; keep to the six layout rules."), "the P2-08 phrase (design §4.11) is a job_rez rejection reason");
  const design = feedback.filter((f) => f.tags.some((t) => ["design", "variant", "palette"].includes(t)));
  assert.deepEqual(design.map((f) => [f.page, f.kind, f.tags]), [["kaatdo", "note", ["design", "variant"]]], "exactly one design-tagged entry, for @kaatdo");
  assert.match(design[0].text, /variant B/);
  assert.deepEqual([...feedback].sort((a, b) => a.at.localeCompare(b.at)), feedback, "feedback.jsonl is in time order");
  assert.ok(feedback.every((f) => Date.parse(f.at) < Date.parse("2026-10-12T05:31:00+05:30")), "every entry predates the Monday run the fixture's W42 memo came from");
  assert.equal(state.readJsonl("state/overrides.jsonl").length, 1);
});

test("every fixture state file validates against its spec; memos carry a CEO JSON block that validates; the fixture tree is exactly what validateTree knows", () => {
  const tree = validateTree(COMPANY_DIR);
  assert.deepEqual(tree.errors, []);
  assert.ok(tree.files.length >= 25, `${tree.files.length} files`);
  const kinds = new Set(tree.files.map((f) => f.kind));
  for (const k of ["config", "roster", "status", "calendar", "idea", "approval", "override", "feedback", "published", "run", "usage", "draft", "qa", "memo", "metric", "report", "hrReview", "hrProposal"]) assert.ok(kinds.has(k), k);
  const memos = tree.files.filter((f) => f.kind === "memo").map((f) => f.rel);
  assert.deepEqual(memos, ["state/memos/2026-W41.md", "state/memos/2026-W42.md"]);
  const handles = config.pages.map((p) => p.handle);
  const pages = config.pages.map((p) => ({ handle: p.handle, factIds: new Set(usableFacts(brands[p.handle]).map((f) => f.id)) }));
  // FEAT-205 (P2-07): the W41 memo predates any report (answers []), the W42 memo (Monday 12 Oct 05:31) answers both
  // forCeo items of the W41 report written the Sunday before, and each file is exactly what renderMemo writes.
  const reportItems = parseReport(state.readText("state/reports/2026-W41.md")).report.forCeo;
  for (const rel of memos) {
    const text = state.readText(rel);
    const json = parseMemo(text);
    assert.ok(json, `${rel}: JSON block`);
    assertShape(json, outputSpec(handles));
    const week = rel.match(/(\d{4}-W\d{2})/)[1];
    const forCeo = week === "2026-W42" ? reportItems : [];
    assert.deepEqual(validateCeoOutput(json, { week, pages, forCeo }), []);
    assert.equal(json.answers.length, forCeo.length);
    assert.equal(renderMemo(json, { reportWeek: forCeo.length ? "2026-W41" : null }), text, `${rel} is exactly what renderMemo writes`);
    if (forCeo.length) assert.ok(text.includes("## Answers to the Analyst (report 2026-W41)"));
    else assert.ok(!text.includes("## Answers to the Analyst"));
  }
  // the calendar links every live draft to its slot with the draft's status
  const calendar = state.readJson("state/calendar.json");
  for (const d of drafts) {
    const slot = calendar.slots.find((s) => s.draftId === d.id);
    assert.ok(slot, `${d.id} has a calendar slot`);
    assert.equal(slot.status, d.status);
    assert.equal(slot.slotId, d.slotId);
  }
});

// FEAT-203 (P2-04): the metrics fixture holds one 48 h record per published post, each fetched ≥ 48 h after the post
// (no 7 d record can exist before the build clock: both posts are younger than 7 days then), and the report fixture
// is byte-for-byte what the engine writes from tests/fixtures/llm/analyst.ok.json with every number in it accounted for.
test("metrics/2026-10.jsonl + reports/2026-W41.md: records are due-window fetches of the published posts; the report is renderReport(analyst.ok) and every number in it exists in the metrics (or is an engine count); status.lastReport points at it", () => {
  const published = state.readJsonl("state/published.jsonl");
  const metrics = state.readJsonl("state/metrics/2026-10.jsonl");
  assert.equal(metrics.length, published.length, "one record per published post");
  for (const m of metrics) {
    assertShape(m, METRIC_SPEC);
    const p = published.find((x) => x.draftId === m.draftId);
    assert.ok(p, `${m.draftId} is a published post`);
    assert.equal(m.igMediaId, p.igMediaId);
    assert.equal(m.page, p.page);
    assert.equal(m.window, "48h");
    const hours = (Date.parse(m.at) - Date.parse(p.publishedAt)) / 3600000;
    assert.ok(hours >= 48 && hours < 168, `${m.draftId}: fetched ${hours.toFixed(1)} h after publishing (48 h window, not yet 7 d)`);
    assert.ok(!m.dryRun, "fixture insights are not dry-run zeros");
    assert.deepEqual(m.raw.data.map((r) => [r.name, r.value]), Object.entries(m.metrics), "raw mirrors the recorded values");
    assert.ok(Object.values(m.metrics).every((v) => Number.isInteger(v) && v >= 0));
  }
  const markdown = state.readText("state/reports/2026-W41.md");
  const parsed = parseReport(markdown);
  assert.ok(parsed, "JSON block present");
  assertShape(parsed.report, ANALYST_OUTPUT_SPEC);
  const ok = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "llm", "analyst.ok.json"), "utf8")).output;
  assert.deepEqual(parsed.report, ok, "the block is the analyst.ok output");
  assert.equal(renderReport(ok, parsed.engine), markdown, "the file is exactly what renderReport writes");
  assert.equal(parsed.engine.week, "2026-W41");
  assert.deepEqual(parsed.engine.metricsUsed.map((m) => [m.draftId, m.window, m.at]), metrics.map((m) => [m.draftId, m.window, m.at]), "provenance names every metrics record");
  assert.ok(Date.parse(parsed.engine.generatedAt) >= Math.max(...metrics.map((m) => Date.parse(m.at))), "written after the last fetch");
  // the engine's own rule, run here against the fixture
  const aggregates = aggregate({ pages: config.pages, published, metrics });
  const allowed = allowedNumbers({ metrics, aggregates, published, now: parsed.engine.generatedAt });
  assert.deepEqual(validateAnalystOutput(ok, { week: "2026-W41", pages: config.pages, aggregates, allowed }), []);
  // and an independent one: every number token of the Markdown body is a metrics value, a count/sum the engine computes,
  // a window constant or a calendar number of the week
  const values = new Set(metrics.flatMap((m) => Object.values(m.metrics).map(String)));
  const sums = new Set();
  for (const page of config.pages) {
    const mine = metrics.filter((m) => m.page === page.handle);
    sums.add(String(mine.length));
    for (const name of Object.keys(metrics[0].metrics)) sums.add(String(mine.reduce((s, m) => s + m.metrics[name], 0)));
  }
  const calendar = new Set(["2026", "41", "5", "6", "7", "8", "9", "10", "11", "13", "16", "48", "7", "2", "28", "0"]);
  const tokens = [...new Set(numberTokens(parsed.body))];
  const unexplained = tokens.filter((t) => !values.has(t) && !sums.has(t) && !calendar.has(t));
  assert.deepEqual(unexplained, [], `numbers in the report body not traceable: ${unexplained.join(", ")}`);
  assert.ok(tokens.some((t) => values.has(t)), "the body quotes metrics values");
  assert.ok(ok.forCeo.length >= 1);
  const status = state.readJson("state/status.json");
  assert.deepEqual(status.lastReport, { week: "2026-W41", path: "reports/2026-W41.md", at: parsed.engine.generatedAt });
});

// FEAT-204 (P2-06, N14): the fixture's September review + proposal are what the engine writes from one HR output — the
// review file is renderReview(output, engine) byte for byte, the proposal file is that output's review/changes with status
// proposed, the engine's stats in the block equal computeAgentStats over the fixture's (empty) September, the output passes
// the engine's own validation against those stats, and no decisions log exists (the Team card says "awaiting the owner").
test("hr/2026-09-review.md + hr/proposals/2026-09.json: one HR output, re-derived; evidence rule holds; no decisions.jsonl", () => {
  const markdown = state.readText("state/hr/2026-09-review.md");
  const parsed = parseReview(markdown);
  assert.ok(parsed, "JSON block present");
  assertShape(parsed.review, HR_OUTPUT_SPEC);
  assert.equal(parsed.review.month, "2026-09");
  assert.equal(renderReview(parsed.review, parsed.engine), markdown, "the file is exactly what renderReview writes");
  assert.equal(parsed.body, parsed.review.reviewMarkdown.trimEnd());
  const proposal = state.readJson("state/hr/proposals/2026-09.json", HR_PROPOSAL_SPEC);
  assert.deepEqual(proposal, { month: "2026-09", at: parsed.engine.generatedAt, runId: parsed.engine.runId, status: "proposed", reviewPath: "hr/2026-09-review.md", review: parsed.review.review, changes: parsed.review.rosterProposal.changes });
  assert.deepEqual(proposal.changes, [{ ...proposal.changes[0], agent: "writer", field: "temperature", from: "0.8", to: "0.7" }], "one change: writer temperature 0.8 → 0.7");
  assert.equal(company.roster.agents.find((a) => a.name === "writer").temperature, 0.8, "`from` is the fixture roster's value");
  assert.deepEqual(proposal.review.map((r) => r.agent), company.roster.agents.map((a) => a.name), "all eight agents, roster order");
  assert.ok(proposal.review.every((r) => (r.agent === "writer" ? r.verdict === "tune" : r.verdict === "keep")));
  assert.match(proposal.at, /^2026-10-01T/, "written by the 1 October run");
  assert.match(proposal.runId, /^engine-daily-20261001-/);
  // the stats in the block are the engine's for September (the fixture has no September logs: all zeros), and the output
  // passes the engine's validation against them — a review that quoted a number would fail here
  const sept = readMonthData(state, "2026-09");
  const stats = computeAgentStats({ month: "2026-09", agents: company.roster.agents.map((a) => a.name), usageMonth: sept.usage, runs: sept.runs, drafts: sept.drafts, qaFiles: sept.qaFiles, published: sept.published });
  assert.deepEqual(parsed.engine.stats, stats);
  assert.deepEqual(parsed.engine.data, { usageRows: 0, runs: 0, draftsWritten: 0, published: 0, feedback: 0 });
  assert.equal(parsed.engine.mock, false);
  assert.deepEqual(validateHrOutput(parsed.review, { month: "2026-09", roster: company.roster, config, stats }), []);
  assert.ok(proposal.review.every((r) => Object.keys(r.evidence).length === 0), "nothing to quote: every evidence is {}");
  assert.equal(existsSync(join(COMPANY_DIR, "state", "hr", "decisions.jsonl")), false, "no decision yet → status proposed");
  assert.deepEqual(listReviews(state).map((r) => r.month), ["2026-09"]);
  assert.deepEqual(listProposals(state).map((r) => r.month), ["2026-09"]);
  // the review and proposal count among validateTree's kinds (the tree test above already requires zero errors)
  const kinds = new Set(validateTree(COMPANY_DIR).files.map((f) => f.kind));
  assert.ok(kinds.has("hrReview") && kinds.has("hrProposal"));
});
