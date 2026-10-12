// engine/agents/analyst.js + engine/ig/client.js insights() + engine/commands/{daily,analyst}.js step 8 (design §3.1
// step 8, §4.10, §5 row "Analyst"; P2-04; FEAT-203): insights requested only for posts ≥ 48 h / ≥ 7 d that are not
// measured yet and appended to the month file of the fetch; the report for a fixed Sunday from analyst.ok equals the
// fixture report; analyst.bad (a number absent from metrics) → one repair call → AgentOutputError; forCeo ≥ 1; the
// number cross-check re-run independently here; the dry-run client never fabricates values; the daily step and the
// admin's dispatch path (`--agents analyst`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir, walk } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { reportPath } from "../engine/lib/ids.js";
import { METRIC_SPEC, PUBLISHED_SPEC, STATUS_SPEC, USAGE_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { AgentOutputError, createRouter } from "../engine/llm/router.js";
import { IgError, INSIGHT_METRICS, INSIGHTS_DOC, createClient, parseInsights } from "../engine/ig/client.js";
import { createDryRunClient } from "../engine/ig/dry-run.js";
import { AGENT, FETCH_MAX_DAYS, METRIC_NAMES, NUMBER_RULE, OUTPUT_SPEC, REPORT_DAYS, SKIP_NO_METRICS, WINDOWS, aggregate, allowedNumbers, calendarNumbers, collectMetrics, dueWindows, latestReport, listReports, numberTokens, parseReport, publishedWithin, readMetrics, renderReport, runAnalyst, shouldRun, validateAnalystOutput } from "../engine/agents/analyst.js";
import { AGENT_ORDER, LLM_AGENTS, parseAgents, runDaily } from "../engine/commands/daily.js";
import { run as runAnalystCommand } from "../engine/commands/analyst.js";
import { EXIT, main } from "../engine/index.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster, charters } = company;
const SECRET_NAMES = Object.values(config.providers).map((p) => p.secret);
const SUNDAY = "2026-10-11T21:03:30+05:30"; // the fixture report's generatedAt (W41)
const NEXT_SUNDAY = "2026-10-18T05:31:00+05:30"; // kd 11.9 d old, rp 8.4 d old → both due for 7d
const MONDAY = "2026-10-12T05:31:00+05:30";
const KD = "kd-2026-10-06-reconnect-every-trading-morning";
const RP = "rp-2026-10-09-your-biodata-on-your-device";
const RUN_ID = "engine-daily-20261011-2100-5e4d3c";
const TOKEN = "IGQWRPfakeTokenForTests0123456789abcdefghijklmnopqrstuvwxyz0123456789";
const MOCK = { MOCK_LLM: "1" };
const llm = (name) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "llm", `${name}.json`), "utf8"));
const fixtureReport = () => readFileSync(join(COMPANY_DIR, "state", "reports", "2026-W41.md"), "utf8");

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

// A temp copy of the populated fixture (+ an empty media marker so the Designer would not create anything).
function copyFixture() {
  const base = tmpDir("hoshlab-analyst-");
  const dir = join(base, "company");
  cpSync(COMPANY_DIR, dir, { recursive: true });
  const mediaRoot = join(base, ".media");
  mkdirSync(mediaRoot, { recursive: true });
  writeFileSync(join(mediaRoot, ".git"), "gitdir: ../.git/worktrees/media\n");
  const state = createState({ companyDir: dir, now: SUNDAY });
  return {
    base,
    dir,
    mediaRoot,
    state,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    metrics: (month = "2026-10") => (existsSync(join(dir, "state", "metrics", `${month}.jsonl`)) ? state.readJsonl(`state/metrics/${month}.jsonl`) : []),
    status: () => JSON.parse(readFileSync(join(dir, "state", "status.json"), "utf8")),
    appendPublished: (rec) => state.appendJsonl("state/published.jsonl", rec, PUBLISHED_SPEC),
  };
}

function router(state, processEnv = MOCK, now = SUNDAY) {
  return createRouter({ config, roster, state, env: readEnv(SECRET_NAMES, {}), fetchImpl: () => Promise.reject(new Error("no network in tests")), now, runId: RUN_ID, charters, processEnv });
}

// Meta's insights answer for a media id: { data: [{ name, period, values: [{ value }], title, description, id }] }.
function insightsBody(values, { drop = [] } = {}) {
  return { data: Object.entries(values).filter(([name]) => !drop.includes(name)).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }], title: name, description: `${name} desc`, id: `17900/insights/${name}/lifetime` })) };
}
const VALUES = { reach: 100, views: 120, likes: 7, comments: 1, saved: 3, shares: 2 };

// A fake Instagram client with insights(): answers from `byId` (a value map, an IgError to throw, or { missing }).
function fakeClient(byId = {}, { dryRun = false } = {}) {
  const calls = [];
  return {
    calls,
    dryRun,
    async insights(igMediaId, metrics) {
      calls.push({ igMediaId, metrics });
      const a = byId[igMediaId];
      if (a instanceof Error) throw a;
      if (!a) throw new IgError({ code: 100, message: `Unsupported get request. Object with ID '${igMediaId}' does not exist`, stage: "insights", status: 400 });
      const values = { ...VALUES, ...(a.values || {}) };
      const out = {};
      const missing = [];
      for (const name of metrics) {
        if ((a.missing || []).includes(name)) {
          out[name] = null;
          missing.push(name);
        } else out[name] = values[name];
      }
      return { metrics: out, missing, raw: { data: metrics.map((name) => ({ name, period: "lifetime", value: out[name] })) } };
    },
  };
}

test("INSIGHT_METRICS are Meta's six FEED+REELS media metrics for the pinned version, documented with URL and date; the agent uses the same list and windows", () => {
  assert.deepEqual(INSIGHT_METRICS, ["reach", "views", "likes", "comments", "saved", "shares"]);
  assert.equal(METRIC_NAMES, INSIGHT_METRICS);
  assert.deepEqual(Object.keys(METRIC_SPEC.metrics), INSIGHT_METRICS, "the schema names the same six");
  assert.equal(INSIGHTS_DOC.version, config.ig.version, "verified for the version config.json pins");
  assert.match(INSIGHTS_DOC.url, /^https:\/\/developers\.facebook\.com\/docs\/instagram-platform\/reference\/instagram-media\/insights$/);
  assert.match(INSIGHTS_DOC.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(WINDOWS.map((w) => [w.id, w.hours]), [["48h", 48], ["7d", 168]]);
  assert.equal(REPORT_DAYS, 28);
  assert.equal(FETCH_MAX_DAYS, 35);
  assert.equal(shouldRun(SUNDAY), true);
  assert.equal(shouldRun(MONDAY), false);
  assert.equal(shouldRun(new Date("2026-10-17T19:00:00Z")), true, "Saturday 19:00 UTC is Sunday 00:30 IST");
  assert.ok(AGENT_ORDER.includes("analyst") && LLM_AGENTS.includes("analyst"), "daily knows the analyst");
  assert.deepEqual([...parseAgents("analyst")], ["analyst"]);
});

test("client.insights(): GET /{id}/insights?metric=<csv> with the token only in the query; Meta's data[] shape is parsed, an absent metric stays null (never 0) and is listed in `missing`; an error envelope is an IgError without the token", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const u = new URL(url);
    if (u.pathname.endsWith("/17900000000000001/insights")) return new Response(JSON.stringify(insightsBody(VALUES)), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/17900000000000002/insights")) return new Response(JSON.stringify(insightsBody(VALUES, { drop: ["views"] })), { status: 200 });
    return new Response(JSON.stringify({ error: { message: `Invalid OAuth 2.0 Access Token ${TOKEN}`, type: "OAuthException", code: 190, fbtrace_id: "A1" } }), { status: 400 });
  };
  const client = createClient({ config, token: TOKEN, igUserId: "17841400000000001", fetchImpl, now: () => new Date(SUNDAY) });
  const r1 = await client.insights("17900000000000001", INSIGHT_METRICS);
  assert.deepEqual(r1.metrics, VALUES);
  assert.deepEqual(r1.missing, []);
  assert.deepEqual(r1.raw, { data: Object.entries(VALUES).map(([name, value]) => ({ name, period: "lifetime", value })) }, "raw is trimmed to name/period/value");
  const u = new URL(requests[0].url);
  assert.equal(u.origin + u.pathname, `${config.ig.host}/${config.ig.version}/17900000000000001/insights`);
  assert.equal(u.searchParams.get("metric"), "reach,views,likes,comments,saved,shares");
  assert.equal(u.searchParams.get("access_token"), TOKEN, "token travels as the query parameter only");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.deepEqual(client.calls.at(-1), { method: "GET", path: "/17900000000000001/insights", fields: { metric: "reach,views,likes,comments,saved,shares" }, at: new Date(SUNDAY).toISOString() }, "calls[] carries no token");
  const r2 = await client.insights("17900000000000002");
  assert.equal(r2.metrics.views, null);
  assert.deepEqual(r2.missing, ["views"]);
  assert.equal(r2.metrics.reach, 100);
  await assert.rejects(client.insights("17900000000000003"), (e) => {
    assert.ok(e instanceof IgError);
    assert.equal(e.code, 190);
    assert.equal(e.tokenInvalid, true);
    assert.equal(e.stage, "insights");
    assert.ok(!e.message.includes(TOKEN), "scrubbed");
    return true;
  });
  await assert.rejects(client.insights(""), TypeError);
  await assert.rejects(client.insights("1", []), TypeError);
  // parseInsights alone: total_value fallback, digit strings, empty data set
  assert.deepEqual(parseInsights({ data: [{ name: "reach", total_value: { value: "42" } }] }, ["reach", "views"]), { metrics: { reach: 42, views: null }, missing: ["views"], raw: { data: [{ name: "reach", period: null, value: 42 }] } });
  assert.deepEqual(parseInsights({ data: [] }, ["reach"]).missing, ["reach"]);
  assert.deepEqual(parseInsights(null, ["reach"]).metrics, { reach: null });
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("dry-run client insights(): the call is recorded and every metric is 0, labelled dryRun:true — deterministic, never a plausible number", async () => {
  const out = sink();
  const client = createDryRunClient({ igUserId: "dry-user", stdout: out, now: () => new Date(SUNDAY) });
  const r = await client.insights("17900000000000001", INSIGHT_METRICS);
  assert.deepEqual(r.metrics, { reach: 0, views: 0, likes: 0, comments: 0, saved: 0, shares: 0 });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.raw.dryRun, true);
  assert.deepEqual(client.calls.at(-1).path, "/17900000000000001/insights");
  assert.deepEqual(client.calls.at(-1).fields, { metric: "reach,views,likes,comments,saved,shares" });
  assert.equal(out.lines.at(-1), "[ig dry-run] GET /17900000000000001/insights metric=reach,views,likes,comments,saved,shares");
  const again = await client.insights("17900000000000001");
  assert.deepEqual(again.metrics, r.metrics, "same answer every time");
});

test("dueWindows / publishedWithin: 48h from 48 hours, 7d from 168 hours, never a window that is already measured; dry-run records are filtered unless asked for; the 35-day fetch horizon", () => {
  const published = createState({ companyDir: COMPANY_DIR }).readJsonl("state/published.jsonl");
  const kd = published.find((p) => p.draftId === KD);
  assert.deepEqual(dueWindows(kd, "2026-10-07T05:31:00+05:30"), [], "21 h old");
  assert.deepEqual(dueWindows(kd, "2026-10-08T08:31:12+05:30"), ["48h"], "exactly 48 h");
  assert.deepEqual(dueWindows(kd, "2026-10-11T05:31:00+05:30"), ["48h"]);
  assert.deepEqual(dueWindows(kd, "2026-10-13T08:31:12+05:30"), ["48h", "7d"], "exactly 7 d, nothing measured yet → both");
  assert.deepEqual(dueWindows(kd, NEXT_SUNDAY, new Set([`${KD}|48h`])), ["7d"]);
  assert.deepEqual(dueWindows(kd, NEXT_SUNDAY, new Set([`${KD}|48h`, `${KD}|7d`])), []);
  const dry = { ...kd, draftId: "dry-x", igMediaId: "dry-1", dryRun: true, publishedAt: "2026-10-10T08:31:12+05:30" };
  const future = { ...kd, draftId: "future", publishedAt: "2026-10-20T08:31:12+05:30" };
  const old = { ...kd, draftId: "old", publishedAt: "2026-08-20T08:31:12+05:30" };
  const all = [...published, dry, future, old];
  assert.deepEqual(publishedWithin(all, NEXT_SUNDAY, FETCH_MAX_DAYS).map((p) => p.draftId), [KD, RP], "oldest first; dry-run, future and 59-day-old records excluded");
  assert.deepEqual(publishedWithin(all, NEXT_SUNDAY, FETCH_MAX_DAYS, { includeDryRun: true }).map((p) => p.draftId), [KD, RP, "dry-x"]);
  assert.deepEqual(publishedWithin(all, "2026-09-01T00:00:00+05:30", 28).map((p) => p.draftId), ["old"]);
});

test("collectMetrics: one GET per post with a due, unmeasured window; a record per due window appended to the month file of the FETCH; nothing twice; page without a client → page_not_configured; incomplete answers are not written; an IgError skips the post, a 190 stops the page", async () => {
  const fx = copyFixture();
  try {
    const out = sink();
    // a third post for @job_rez, 2.7 days old at NEXT_SUNDAY (48h due only), and a fresh one (nothing due)
    const jr = { draftId: "jr-2026-10-15-templates-live", page: "job_rez", igMediaId: "17900000000000003", permalink: "https://www.instagram.com/p/FIXTUREjr03/", publishedAt: "2026-10-15T12:31:00+05:30", slotAt: "2026-10-15T12:30:00+05:30", late: false, mode: "approve_first", qaRevision: 1, format: "carousel", mediaUrlUsed: "raw", runId: "publisher-hourly-20261015-1230-aaaaaa" };
    const fresh = { ...jr, draftId: "jr-2026-10-17-fresh", igMediaId: "17900000000000004", publishedAt: "2026-10-17T12:31:00+05:30", slotAt: "2026-10-17T12:30:00+05:30" };
    fx.appendPublished(jr);
    fx.appendPublished(fresh);
    const published = fx.state.readJsonl("state/published.jsonl");
    const existing = readMetrics(fx.state, NEXT_SUNDAY);
    assert.equal(existing.length, 2, "the fixture's two 48h records");
    const client = fakeClient({ "17900000000000001": { values: { reach: 500, views: 640, likes: 40, comments: 5, saved: 21, shares: 8 } }, "17900000000000002": { values: { reach: 801, views: 950, likes: 70, comments: 11, saved: 29, shares: 14 } }, "17900000000000003": { values: { reach: 90, views: 100, likes: 6, comments: 0, saved: 4, shares: 1 } } });
    const r = await collectMetrics({ published, existing, clientFor: () => client, now: NEXT_SUNDAY, runId: "engine-daily-20261018-0531-abcdef", state: fx.state, log: out });
    assert.deepEqual(client.calls.map((c) => c.igMediaId), ["17900000000000001", "17900000000000002", "17900000000000003"], "oldest first; the fresh post is not requested");
    assert.ok(client.calls.every((c) => c.metrics === METRIC_NAMES));
    assert.deepEqual(r.requested.map((q) => [q.draftId, q.windows]), [[KD, ["7d"]], [RP, ["7d"]], [jr.draftId, ["48h"]]], "48h already on file for kd/rp → 7d only; jr → 48h only");
    assert.deepEqual(r.skipped, [{ draftId: fresh.draftId, reason: "not_due" }]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.changed, ["state/metrics/2026-10.jsonl"]);
    assert.equal(r.records.length, 3);
    const rows = fx.metrics();
    assert.equal(rows.length, 5);
    for (const row of rows.slice(2)) {
      assertShape(row, METRIC_SPEC);
      assert.equal(row.at, "2026-10-18T05:31:00+05:30");
      assert.equal(row.source, "ig-insights");
      assert.equal(row.runId, "engine-daily-20261018-0531-abcdef");
      assert.equal(row.dryRun, undefined, "a real client's record carries no dryRun label");
    }
    assert.deepEqual(rows[2], { draftId: KD, igMediaId: "17900000000000001", page: "kaatdo", at: "2026-10-18T05:31:00+05:30", window: "7d", metrics: { reach: 500, views: 640, likes: 40, comments: 5, saved: 21, shares: 8 }, source: "ig-insights", raw: { data: METRIC_NAMES.map((name) => ({ name, period: "lifetime", value: { reach: 500, views: 640, likes: 40, comments: 5, saved: 21, shares: 8 }[name] })) }, runId: "engine-daily-20261018-0531-abcdef" });
    assert.equal(rows[4].window, "48h");
    assert.equal(rows[4].page, "job_rez");
    assert.match(r.note, /^insights: 3 posts measured \(3 records\), 1 not_due$/);
    assert.ok(out.lines.some((l) => l === `[analyst] ${KD}: insights fetched (7d)`), out.text());

    // second pass an hour later: everything measured → no request at all
    const again = fakeClient();
    const r2 = await collectMetrics({ published, existing: readMetrics(fx.state, "2026-10-18T06:31:00+05:30"), clientFor: () => again, now: "2026-10-18T06:31:00+05:30", state: fx.state });
    assert.equal(again.calls.length, 0);
    assert.deepEqual(r2.requested, []);
    assert.equal(fx.metrics().length, 5);
    assert.deepEqual(r2.changed, []);
    assert.match(r2.note, /0 posts measured \(0 records\), 4 not_due/);

    // two weeks later, just past midnight IST on 1 November: a 10-day-old post with NOTHING on file gets both windows from
    // ONE request; jr (7d now due) and the once-fresh post (both windows) are measured too; the records land in the month
    // file of the FETCH (2026-11), the October file is untouched, and readMetrics spans both months (M9)
    const late = { ...jr, draftId: "rp-2026-10-22-late", page: "rishtapatra", igMediaId: "17900000000000005", publishedAt: "2026-10-22T19:31:00+05:30", slotAt: "2026-10-22T19:30:00+05:30", format: "image" };
    fx.appendPublished(late);
    const nov = "2026-11-01T00:10:00+05:30";
    const c3 = fakeClient({ "17900000000000003": { values: VALUES }, "17900000000000004": { values: VALUES }, "17900000000000005": { values: VALUES } });
    const r3 = await collectMetrics({ published: fx.state.readJsonl("state/published.jsonl"), existing: readMetrics(fx.state, nov), clientFor: () => c3, now: nov, state: fx.state });
    assert.deepEqual(c3.calls.map((c) => c.igMediaId), ["17900000000000003", "17900000000000004", "17900000000000005"], "one request per post, even when both windows fall due");
    assert.deepEqual(r3.requested.map((q) => [q.draftId, q.windows]), [[jr.draftId, ["7d"]], [fresh.draftId, ["48h", "7d"]], [late.draftId, ["48h", "7d"]]]);
    assert.deepEqual(r3.skipped.map((s) => [s.draftId, s.reason]), [[KD, "not_due"], [RP, "not_due"]], "both fixture posts fully measured");
    assert.deepEqual(r3.changed, ["state/metrics/2026-11.jsonl"]);
    assert.deepEqual(fx.metrics("2026-11").map((m) => [m.draftId, m.window, m.at]), [[jr.draftId, "7d", nov], [fresh.draftId, "48h", nov], [fresh.draftId, "7d", nov], [late.draftId, "48h", nov], [late.draftId, "7d", nov]]);
    assert.equal(fx.metrics().length, 5, "October's file untouched");
    assert.equal(readMetrics(fx.state, nov).length, 10, "current + previous month");

    // no client for a page → page_not_configured (nothing fetched); incomplete answer → not written; errors continue; 190 stops the page
    const fx2 = copyFixture();
    try {
      fx2.appendPublished(jr);
      const kd2 = { ...jr, draftId: "kd-2026-10-15-second", page: "kaatdo", igMediaId: "17900000000000006", format: "image" };
      const kd3 = { ...jr, draftId: "kd-2026-10-15-third", page: "kaatdo", igMediaId: "17900000000000007", format: "image", publishedAt: "2026-10-15T12:32:00+05:30" };
      fx2.appendPublished(kd2);
      fx2.appendPublished(kd3);
      const dead = new IgError({ code: 190, message: `Invalid OAuth 2.0 Access Token ${TOKEN}`, stage: "insights", status: 400, secrets: [TOKEN] });
      const kdClient = fakeClient({ "17900000000000001": new IgError({ code: 4, message: "Application request limit reached", stage: "insights", status: 400 }), "17900000000000006": dead, "17900000000000007": { values: VALUES } });
      const jrClient = fakeClient({ "17900000000000003": { missing: ["views"] } });
      const clients = { kaatdo: kdClient, job_rez: jrClient, rishtapatra: null };
      const out2 = sink();
      const r4 = await collectMetrics({ published: fx2.state.readJsonl("state/published.jsonl"), existing: readMetrics(fx2.state, NEXT_SUNDAY), clientFor: (h) => clients[h], now: NEXT_SUNDAY, state: fx2.state, log: out2 });
      assert.deepEqual(r4.notConfigured, ["rishtapatra"]);
      assert.deepEqual(r4.skipped.map((s) => [s.draftId, s.reason]), [[RP, "page_not_configured"], [jr.draftId, "insights_incomplete: views"], [kd3.draftId, "token_invalid"]]);
      assert.equal(r4.errors.length, 2);
      assert.equal(r4.errors[0], `${KD}: Application request limit reached`);
      assert.ok(r4.errors[1].startsWith(`${kd2.draftId}: Invalid OAuth 2.0 Access Token`), r4.errors[1]);
      assert.ok(!r4.errors[1].includes(TOKEN), "scrubbed");
      assert.deepEqual(kdClient.calls.map((c) => c.igMediaId), ["17900000000000001", "17900000000000006"], "the third kaatdo post is not tried after the 190");
      assert.deepEqual(r4.records, []);
      assert.equal(fx2.metrics().length, 2, "nothing written: the incomplete answer is not read as 0");
      assert.ok(out2.lines.some((l) => l.includes(`${jr.draftId}: insights answer without views — not recorded`)), out2.text());
      assert.match(r4.note, /2 fetch errors, token not configured yet: rishtapatra/);
    } finally {
      fx2.cleanup();
    }
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("aggregate / allowedNumbers / numberTokens / calendarNumbers: per-page counts and sums, the ranking window, every allowed number, and the tokens that are and are not counted", () => {
  const state = createState({ companyDir: COMPANY_DIR });
  const published = state.readJsonl("state/published.jsonl");
  const metrics = state.readJsonl("state/metrics/2026-10.jsonl");
  const agg = aggregate({ pages: config.pages, published, metrics });
  assert.deepEqual(agg.perPage.map((p) => [p.page, p.posts, p.window, p.topDraftId, p.bottomDraftId]), [["rishtapatra", 1, "48h", RP, RP], ["kaatdo", 1, "48h", KD, KD], ["job_rez", 0, "48h", "", ""]]);
  assert.deepEqual(agg.perPage[1].byWindow["48h"], { measured: 1, reach: 412, views: 538, likes: 31, comments: 4, saved: 17, shares: 6 });
  assert.deepEqual(agg.perPage[1].byWindow["7d"], { measured: 0, reach: 0, views: 0, likes: 0, comments: 0, saved: 0, shares: 0 });
  assert.deepEqual(agg.totals.byWindow["48h"], { measured: 2, reach: 1067, views: 1328, likes: 89, comments: 13, saved: 40, shares: 18 });
  assert.deepEqual([agg.totals.posts, agg.totals.measuredPosts, agg.unmeasured], [2, 2, []]);
  // a 7d record ranks the page on 7d; the latest record per draft+window wins
  const later = [...metrics, { ...metrics[0], window: "7d", at: "2026-10-13T09:00:00+05:30", metrics: { ...metrics[0].metrics, reach: 450 } }, { ...metrics[0], at: "2026-10-12T09:00:00+05:30", metrics: { ...metrics[0].metrics, reach: 413 } }];
  const agg2 = aggregate({ pages: config.pages, published, metrics: later });
  assert.equal(agg2.perPage[1].window, "7d");
  assert.equal(agg2.perPage[1].byWindow["7d"].reach, 450);
  assert.equal(agg2.perPage[1].byWindow["48h"].reach, 413, "the re-fetch supersedes the earlier 48h record");
  const allowed = allowedNumbers({ metrics, aggregates: agg, published, now: SUNDAY });
  for (const n of ["412", "538", "31", "4", "17", "6", "655", "790", "58", "9", "23", "12", "1067", "1328", "89", "13", "40", "18", "1", "2", "0", "3", "48", "7", "168", "28", "2026", "41", "5", "11", "6", "9", "13", "16", "17900000000000001"]) assert.ok(allowed.has(n), `allowed ${n}`);
  for (const n of ["999", "2.1", "35", "100", "14", "15"]) assert.ok(!allowed.has(n), `not allowed ${n}`);
  assert.deepEqual([...calendarNumbers({ now: "2026-10-14T12:00:00+05:30" })].sort((a, b) => a - b), ["12", "13", "14", "15", "16", "17", "18", "42", "2026"], "W42: the week's seven days, the week number, the year");
  assert.deepEqual(numberTokens("Week 5–11 October 2026 (2026-W41): reach 412, 2,150 views, 1,00,000, 2.1× more, 35%, 48h, 7 d, rp-f05, kd-i0003, v26.0, W41, #tag1, https://x/p/ab01/, 08:31, 2026-10-06T08:31:12+05:30\n1. first\n## 2. heading\n| 655 |"), ["5", "11", "2026", "412", "2150", "100000", "2.1", "35", "48", "7", "655"]);
  assert.deepEqual(numberTokens(""), []);
  assert.deepEqual(numberTokens("no digits here"), []);
});

test("validateAnalystOutput: the ok fixture passes; week mismatch, unknown/duplicate/missing page, posts ≠ engine count, ids rules, and every number not in metrics (perPage, observations, experiments, forCeo, reportMarkdown) are errors naming the rule", () => {
  const state = createState({ companyDir: COMPANY_DIR });
  const published = state.readJsonl("state/published.jsonl");
  const metrics = state.readJsonl("state/metrics/2026-10.jsonl");
  const aggregates = aggregate({ pages: config.pages, published, metrics });
  const allowed = allowedNumbers({ metrics, aggregates, published, now: SUNDAY });
  const ctx = { week: "2026-W41", pages: config.pages, aggregates, allowed };
  const ok = llm("analyst.ok").output;
  assertShape(ok, OUTPUT_SPEC);
  assert.deepEqual(validateAnalystOutput(ok, ctx), []);
  assert.deepEqual(validateAnalystOutput(ok, { ...ctx, week: "2026-W42" }), ['$.week: expected 2026-W42, got "2026-W41"']);
  assert.deepEqual(validateAnalystOutput(ok, { ...ctx, week: null }), [], "week rule waived (mock)");
  const bad = llm("analyst.bad").output;
  assert.deepEqual(validateAnalystOutput(bad, ctx), [`$.perPage[1].reach: ${NUMBER_RULE}: 999`, `$.perPage[1].observations[0]: ${NUMBER_RULE}: 999`, `$.reportMarkdown: ${NUMBER_RULE}: 999`]);
  const unknown = { ...ok, perPage: [...ok.perPage, { ...ok.perPage[2], page: "nobody" }] };
  assert.deepEqual(validateAnalystOutput(unknown, ctx), ['$.perPage[3].page: unknown page "nobody"']);
  const dup = { ...ok, perPage: [...ok.perPage, ok.perPage[2]] };
  assert.deepEqual(validateAnalystOutput(dup, ctx), ["$.perPage[3].page: @job_rez listed twice"]);
  const missing = { ...ok, perPage: ok.perPage.slice(0, 2) };
  assert.deepEqual(validateAnalystOutput(missing, ctx), ["$.perPage: page @job_rez is missing (list every page, posts: 0 when it published nothing)"]);
  const posts = { ...ok, perPage: [{ ...ok.perPage[0], posts: 2 }, ...ok.perPage.slice(1)] };
  assert.deepEqual(validateAnalystOutput(posts, ctx), ["$.perPage[0].posts: @rishtapatra published 1 post in the window, got 2"]);
  const ids = { ...ok, perPage: [{ ...ok.perPage[0], topDraftId: KD }, ok.perPage[1], { ...ok.perPage[2], bottomDraftId: RP }] };
  assert.deepEqual(validateAnalystOutput(ids, ctx), [`$.perPage[0].topDraftId: "${KD}" is not a post @rishtapatra published in the window`, '$.perPage[2].bottomDraftId: must be "" for a page without posts']);
  const texts = { ...ok, experiments: [{ page: "kaatdo", hypothesis: "Reach will grow 35%.", test: "x", measure: "reach at 7 days vs 2.1x" }], forCeo: ["Spend 14 more on kaatdo"] };
  assert.deepEqual(validateAnalystOutput(texts, ctx), [`$.experiments[0].hypothesis: ${NUMBER_RULE}: 35`, `$.experiments[0].measure: ${NUMBER_RULE}: 2.1`, `$.forCeo[0]: ${NUMBER_RULE}: 14`]);
  const expPage = { ...ok, experiments: [{ page: "nobody", hypothesis: "x", test: "y", measure: "z" }] };
  assert.deepEqual(validateAnalystOutput(expPage, ctx), ['$.experiments[0].page: unknown page "nobody"']);
  // the Markdown rule caps its list at 10 distinct numbers
  const many = { ...ok, reportMarkdown: `${ok.reportMarkdown}\n\n${Array.from({ length: 12 }, (_, i) => 9001 + i).join(" ")}` };
  const errors = validateAnalystOutput(many, ctx);
  assert.equal(errors.length, 11);
  assert.equal(errors.at(-1), "$.reportMarkdown: 2 more numbers not in metrics");
});

test("runAnalyst (MOCK_LLM, fixed Sunday 2026-10-11 21:03 IST): writes reports/2026-W41.md = reportMarkdown + JSON block (output + engine provenance) matching the fixture report; forCeo ≥ 1; one usage line mock:true; parse/list/latest read it back; every number in the file exists in the metrics", async () => {
  const fx = copyFixture();
  try {
    rmSync(join(fx.dir, "state", "reports"), { recursive: true, force: true });
    const out = sink();
    const res = await runAnalyst({ config, router: router(fx.state), state: fx.state, now: SUNDAY, runId: RUN_ID, memo: null, log: out });
    assert.equal(res.skipped, undefined);
    assert.equal(res.week, "2026-W41");
    assert.equal(res.path, "reports/2026-W41.md");
    assert.equal(res.rel, "state/reports/2026-W41.md");
    assert.equal(reportPath(SUNDAY), res.path);
    assert.equal(res.mock, true);
    assert.equal(res.calls, 1);
    assert.equal(res.costUsd, 0);
    assert.equal(res.at, SUNDAY);
    assert.ok(res.report.forCeo.length >= 1);
    assert.match(res.note, /^report reports\/2026-W41\.md: 2 posts in 28 days, 2 metrics records, 0 unmeasured, 1 experiment, 2 for the CEO$/);
    const text = fx.state.readText(res.rel);
    assert.equal(Buffer.from(text, "utf8")[0] !== 0xef, true, "no BOM");
    assert.ok(text.startsWith("# Weekly report 2026-W41\n"));
    assert.ok(text.includes("\n\n```json\n") && text.endsWith("\n```\n"));
    const parsed = parseReport(text);
    assert.deepEqual(parsed.report, llm("analyst.ok").output, "the block holds the whole validated output");
    assert.equal(parsed.engine.generatedAt, SUNDAY);
    assert.equal(parsed.engine.runId, RUN_ID);
    assert.equal(parsed.engine.week, "2026-W41");
    assert.equal(parsed.engine.mock, true, "a mock run is labelled in the file");
    assert.deepEqual(parsed.engine.windows, ["48h", "7d"]);
    assert.equal(parsed.engine.publishedInWindow, 2);
    assert.deepEqual(parsed.engine.unmeasured, []);
    assert.deepEqual(parsed.engine.insightsDoc, INSIGHTS_DOC);
    assert.deepEqual(parsed.engine.metricsUsed.map((m) => [m.draftId, m.window, m.dryRun]), [[KD, "48h", false], [RP, "48h", false]]);
    // the committed fixture report is this file with mock:false (written by a real run in the fixture's story)
    const fixture = parseReport(fixtureReport());
    assert.deepEqual(parsed.report, fixture.report);
    assert.deepEqual({ ...parsed.engine, mock: false }, fixture.engine);
    assert.equal(renderReport(parsed.report, fixture.engine), fixtureReport());
    assert.equal(parsed.body, fixture.body);
    assert.deepEqual(listReports(fx.state), [{ week: "2026-W41", path: "reports/2026-W41.md", rel: "state/reports/2026-W41.md" }]);
    assert.deepEqual(latestReport(fx.state).report, parsed.report);
    // the cross-check, independently: every number token of the whole file (body + block) is a metrics value, an engine
    // count or a calendar/window number of this week — and the metrics values really appear
    const metrics = fx.metrics();
    const values = new Set(metrics.flatMap((m) => Object.values(m.metrics).map(String)).concat(metrics.map((m) => m.igMediaId)));
    const counts = new Set(["0", "1", "2", "3", "28", "48", "7", "168", "2026", "41", "5", "6", "8", "9", "10", "11", "13", "16", "1067", "1328", "89", "13", "40", "18"]);
    const tokens = [...new Set(numberTokens(parsed.body + "\n" + JSON.stringify(parsed.report, null, 2)))];
    assert.deepEqual(tokens.filter((t) => !values.has(t) && !counts.has(t)), []);
    assert.ok(["412", "655", "538", "790", "17", "23"].every((v) => tokens.includes(v)));
    const usage = fx.state.readJsonl(fx.state.monthLogPath("usage", SUNDAY)).filter((u) => u.runId === RUN_ID);
    assert.equal(usage.length, 1);
    assert.equal(validate(usage[0], USAGE_SPEC).ok, true);
    assert.equal(usage[0].agent, AGENT);
    assert.equal(usage[0].mock, true);
    assert.equal(usage[0].page, undefined, "company-wide call");
    assert.ok(out.lines.some((l) => l.startsWith("[analyst] report reports/2026-W41.md: 3 pages, 2 for the CEO, 2 metrics records used")), out.text());
    // the model's task carried only metrics numbers: the router envelope is inspectable
    const rt = router(fx.state);
    const task = (await import("../engine/agents/analyst.js")).buildTask({ config, now: SUNDAY, published: fx.state.readJsonl("state/published.jsonl"), metrics, aggregates: aggregate({ pages: config.pages, published: fx.state.readJsonl("state/published.jsonl"), metrics }), allowed: allowedNumbers({ metrics, now: SUNDAY }) });
    assert.equal(task.week, "2026-W41");
    assert.deepEqual(task.metrics.map((m) => [m.draftId, m.window, m.reach]), [[KD, "48h", 412], [RP, "48h", 655]]);
    assert.ok(task.allowedNumbers.includes(412) && !task.allowedNumbers.includes(999));
    assert.deepEqual(task.windows, WINDOWS.map((w) => ({ id: w.id, hours: w.hours, label: w.label })));
    assert.ok(task.notes.some((n) => /No CEO memo/.test(n)));
    assert.ok(rt.envelope(AGENT, { task, context: { brand: null, page: null, todayIst: SUNDAY } }).system.includes("## Identity"), "the Analyst's charter heads the envelope");
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("analyst.bad (a 999 that no metrics record holds) → exactly one repair call → AgentOutputError 'report number not in metrics'; nothing is written", async () => {
  const fx = copyFixture();
  try {
    rmSync(join(fx.dir, "state", "reports"), { recursive: true, force: true });
    await assert.rejects(runAnalyst({ config, router: router(fx.state, { MOCK_LLM: "1", MOCK_LLM_CASE_ANALYST: "bad" }), state: fx.state, now: SUNDAY, runId: RUN_ID }), (e) => {
      assert.ok(e instanceof AgentOutputError, e.message);
      assert.equal(e.agent, AGENT);
      assert.equal(e.calls, 2, "first answer + one repair");
      assert.ok(e.errors.includes(`$.perPage[1].reach: ${NUMBER_RULE}: 999`), e.errors.join("; "));
      assert.ok(e.repairErrors.includes(`$.reportMarkdown: ${NUMBER_RULE}: 999`));
      assert.match(e.message, /report number not in metrics: 999/);
      return true;
    });
    assert.equal(fx.state.exists("state/reports/2026-W41.md"), false);
    assert.equal(listReports(fx.state).length, 0);
    assert.equal(fx.state.readJsonl(fx.state.monthLogPath("usage", SUNDAY)).filter((u) => u.runId === RUN_ID).length, 2, "both attempts are usage lines");
  } finally {
    fx.cleanup();
  }
});

test("no metrics yet → skipped: no_metrics, no model call, no file (the honest first-Sunday case); a report in the same week is not its own previousReport", async () => {
  const fx = copyFixture();
  try {
    rmSync(join(fx.dir, "state", "metrics"), { recursive: true, force: true });
    rmSync(join(fx.dir, "state", "reports"), { recursive: true, force: true });
    const r = await runAnalyst({ config, router: router(fx.state), state: fx.state, now: SUNDAY, runId: RUN_ID });
    assert.equal(r.skipped, SKIP_NO_METRICS);
    assert.equal(r.week, "2026-W41");
    assert.match(r.note, /^no insights yet for the 2 posts of the last 28 days — no report written/);
    assert.equal(fx.state.exists("state/reports/2026-W41.md"), false);
    assert.equal(fx.state.readJsonl(fx.state.monthLogPath("usage", SUNDAY)).filter((u) => u.runId === RUN_ID).length, 0, "no model call");
  } finally {
    fx.cleanup();
  }
  // the fixture company itself: a Sunday re-run of W41 sees no previous report (the only report IS this week's)
  const fx2 = copyFixture();
  try {
    const calls = [];
    // a router stand-in that records the task and the validator's verdict, and answers the ok fixture unvalidated
    const fake = { isMock: true, runId: RUN_ID, async complete(agent, args) { const output = llm("analyst.ok").output; calls.push({ task: args.task, errors: args.validate(output) }); return { json: output, text: JSON.stringify(output), usage: {}, costUsd: 0, provider: "mock", model: "mock", ms: 1, mock: true, calls: 1, repaired: false, raw: {}, failures: [] }; } };
    await runAnalyst({ config, router: fake, state: fx2.state, now: SUNDAY, runId: RUN_ID });
    assert.deepEqual(calls[0].errors, [], "in its own week the fixture passes every rule");
    assert.equal(calls[0].task.previousReport, null);
    assert.equal(calls[0].task.memo, null);
    assert.deepEqual(calls[0].task.published.map((p) => [p.draftId, p.title]), [[KD, "Reconnect every trading morning"], [RP, "Your biodata, on your device"]], "titles from the ideas the drafts cite");
    // next week's run reads W41 back as previousReport; the W41-pinned numbers no longer pass the calendar rule there
    await runAnalyst({ config, router: fake, state: fx2.state, now: NEXT_SUNDAY, runId: RUN_ID });
    assert.equal(calls[1].task.week, "2026-W42");
    assert.equal(calls[1].task.previousReport.week, "2026-W41");
    assert.deepEqual(calls[1].task.previousReport.forCeo, llm("analyst.ok").output.forCeo);
    assert.deepEqual(calls[1].errors, [`$.reportMarkdown: ${NUMBER_RULE}: 5`], "'5–11 October' names W41's Monday, not a date of W42 — the real router would repair then refuse");
    assert.ok(fx2.state.exists("state/reports/2026-W42.md"), "the stand-in bypassed validation: written under the week of `now`");
  } finally {
    fx2.cleanup();
  }
});

test("daily step 8: Sunday → the Analyst runs (insights with the injected client, report written, status.lastReport set, run record row); weekdays → skipped not_due; --agents analyst runs it any day with the others not_selected; --page skips it unless named; budget exhausted → metrics still collected, report skipped", async () => {
  const fx = copyFixture();
  try {
    rmSync(join(fx.dir, "state", "reports"), { recursive: true, force: true });
    const out = sink();
    const client = fakeClient();
    let factoryCalls = 0;
    const clientFactory = (page, token, ctx) => (factoryCalls++, { page: page.handle, token, dryRun: ctx.dryRun, ...client });
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: SUNDAY, processEnv: { ...MOCK, IG_TOKEN_KAATDO: TOKEN, IG_TOKEN_RISHTAPATRA: TOKEN }, flags: { agents: "analyst" }, stdout: out, clientFactory });
    assert.equal(r.ok, true, out.text());
    const row = r.agents.find((a) => a.name === "analyst");
    assert.deepEqual(r.agents.map((a) => a.name), AGENT_ORDER);
    assert.equal(row.ok, true);
    assert.equal(row.skipped, undefined);
    assert.equal(row.calls, 1);
    assert.match(row.note, /^insights: 0 posts measured \(0 records\), 2 not_due \| report reports\/2026-W41\.md: 2 posts in 28 days, 2 metrics records/);
    assert.equal(client.calls.length, 0, "both fixture posts are measured for 48h and younger than 7 d → nothing to fetch");
    assert.equal(factoryCalls, 0, "no client is even built when no post is due");
    for (const name of AGENT_ORDER) if (name !== "analyst") assert.equal(r.agents.find((a) => a.name === name).skipped, "not_selected", name);
    assert.ok(fx.state.exists("state/reports/2026-W41.md"));
    assert.ok(r.run.changed.includes("company/state/reports/2026-W41.md"));
    const status = fx.status();
    assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
    assert.deepEqual(status.lastReport, { week: "2026-W41", path: "reports/2026-W41.md", at: SUNDAY });
    assert.ok(out.lines.some((l) => l.startsWith("[analyst] ok ")), out.text());
    assert.ok(out.lines.some((l) => l.includes("[analyst] report reports/2026-W41.md")));

    // a selection without the analyst: not selected; lastReport survives
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { agents: "hr" }, stdout: () => {} });
    assert.equal(r2.agents.find((a) => a.name === "analyst").skipped, "not_selected");
    assert.equal(fx.status().lastReport.week, "2026-W41");
    // Monday (W42) with --agents analyst --page kaatdo: company-wide, so the page filter is ignored and it RUNS — and the
    // mock answer, pinned to W41 ("Week of 5–11 October"), fails the number rule under W42's calendar: the week rule is
    // waived under MOCK_LLM, the number rule never is, so nothing is written and lastReport stays W41
    const out3 = sink();
    const r3 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { agents: "hr,analyst", page: "kaatdo" }, stdout: out3, clientFactory });
    const row3 = r3.agents.find((a) => a.name === "analyst");
    assert.equal(row3.skipped, undefined, "--page with --agents analyst still runs it");
    assert.equal(row3.ok, false);
    assert.equal(row3.calls, 2, "answer + one repair");
    assert.match(row3.note, /AgentOutputError: .*report number not in metrics: 5/);
    assert.equal(r3.ok, true, "a failed agent step does not fail the run");
    assert.equal(fx.state.exists("state/reports/2026-W42.md"), false);
    assert.deepEqual(listReports(fx.state).map((x) => x.week), ["2026-W41"]);
    const r4 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { agents: "hr,ceo", page: "kaatdo" }, stdout: () => {} });
    assert.equal(r4.agents.find((a) => a.name === "analyst").skipped, "not_selected");
    assert.deepEqual(fx.status().lastReport, { week: "2026-W41", path: "reports/2026-W41.md", at: SUNDAY });
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

// Renderer double for full daily runs (as in tests/daily.test.js): a 2-byte file per media item, fixture-shaped rows.
function fakeRenderer() {
  const SHA = "7cfbae6d41f17cb1b34897046134304f36529e6e223ea96756052d2a70958af1";
  return {
    async renderDraft(draft, brand, { outDir, relDir }) {
      const n = draft.format === "carousel" ? draft.slides.length : 1;
      const media = Array.from({ length: n }, (_, i) => {
        const file = `${draft.format === "carousel" ? "slide" : "image"}-${i + 1}-${SHA.slice(0, 8)}.jpg`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, file), Buffer.from([0xff, 0xd8]));
        return { kind: "image", file, path: `${relDir}${file}`, bytes: 9432, width: 1080, height: 1350, sha256: SHA, variant: "A", palette: "test", minTextU: 30, minContrast: 4.6 };
      });
      return { media, variant: "A", palette: "test" };
    },
    async close() {},
  };
}

test("daily step 8 on a plain weekday run: skipped not_due with the Sunday sentence; with --page alone: page_filter; budget exhausted: insights collected, report skipped", async () => {
  const fx = copyFixture();
  try {
    const tue = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-10-13T05:31:00+05:30", processEnv: MOCK, flags: {}, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(tue.ok, true);
    const row = tue.agents.find((a) => a.name === "analyst");
    assert.equal(row.skipped, "not_due");
    assert.equal(row.note, "skipped: not Sunday (the Analyst runs on Sundays or with --agents analyst)");
    assert.equal(row.calls, 0);
    const paged = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { page: "job_rez" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(paged.agents.find((a) => a.name === "analyst").skipped, "page_filter");
    assert.match(paged.agents.find((a) => a.name === "analyst").note, /--page filter \(company-wide agent\)/);
    // budget exhausted (M5.4): the insights fetch costs no budget and still runs; the report (a model call) is skipped
    const usagePath = join(fx.dir, "state", "usage", "2026-10.jsonl");
    writeFileSync(usagePath, readFileSync(usagePath, "utf8") + JSON.stringify({ at: "2026-10-10T06:00:00+05:30", runId: "engine-daily-20261010-0531-c4d5e6", agent: "writer", page: "kaatdo", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1000000, outputTokens: 2300000, costUsd: 25, ms: 1000, ok: true, mock: false }) + "\n", "utf8");
    rmSync(join(fx.dir, "state", "reports"), { recursive: true, force: true });
    const client = fakeClient({ "17900000000000001": { values: VALUES }, "17900000000000002": { values: VALUES } });
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: NEXT_SUNDAY, processEnv: { ...MOCK, IG_TOKEN_KAATDO: TOKEN, IG_TOKEN_RISHTAPATRA: TOKEN, IG_TOKEN_JOB_REZ: TOKEN }, flags: { agents: "analyst" }, stdout: () => {}, clientFactory: () => client });
    const row2 = r2.agents.find((a) => a.name === "analyst");
    assert.equal(row2.skipped, "budget_exhausted");
    assert.equal(row2.calls, 0);
    assert.match(row2.note, /^insights: 2 posts measured \(2 records\) \| skipped: budget_exhausted$/);
    assert.deepEqual(client.calls.map((c) => c.igMediaId), ["17900000000000001", "17900000000000002"]);
    assert.equal(fx.metrics().length, 4, "the two 7d records were appended");
    assert.ok(fx.metrics().slice(2).every((m) => m.window === "7d" && m.at === "2026-10-18T05:31:00+05:30"));
    assert.equal(fx.state.exists("state/reports/2026-W42.md"), false);
    assert.ok(r2.flags.includes("budget_exhausted"));
    assert.ok(r2.run.changed.includes("company/state/metrics/2026-10.jsonl"));
  } finally {
    fx.cleanup();
  }
});

test("dry run on a Sunday (IG_DRY_RUN=1 / --dry-run): the dry-run client's zeros are appended labelled dryRun:true; the mock report's fixture numbers are NOT in this company's metrics, so the number rule rejects it (row ok:false, nothing written, run still ok) — a mock can never commit invented numbers", async () => {
  const fx = copyFixture();
  try {
    rmSync(join(fx.dir, "state", "metrics"), { recursive: true, force: true });
    rmSync(join(fx.dir, "state", "reports"), { recursive: true, force: true });
    const out = sink();
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: NEXT_SUNDAY, processEnv: { ...MOCK, IG_DRY_RUN: "1" }, flags: { agents: "analyst", dryRun: true }, stdout: out });
    assert.equal(r.ok, true, "a failed agent step does not fail the run (design §11)");
    const row = r.agents.find((a) => a.name === "analyst");
    assert.equal(row.ok, false);
    assert.equal(row.calls, 2, "answer + repair");
    assert.match(row.note, /^insights: 2 posts measured \(4 records\) \| AgentOutputError: analyst: output failed validation after one repair call \(mock\/mock\) — .*report number not in metrics/);
    const rows = fx.metrics();
    assert.equal(rows.length, 4, "48h and 7d for both posts");
    for (const m of rows) {
      assertShape(m, METRIC_SPEC);
      assert.equal(m.dryRun, true);
      assert.deepEqual(m.metrics, { reach: 0, views: 0, likes: 0, comments: 0, saved: 0, shares: 0 });
      assert.equal(m.raw.dryRun, true);
    }
    assert.equal(fx.state.exists("state/reports/2026-W42.md"), false);
    assert.equal(fx.status().lastReport.week, "2026-W41", "the fixture's lastReport is untouched");
    assert.ok(out.lines.some((l) => l.startsWith("[ig dry-run] GET /17900000000000001/insights metric=")), out.text());
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("engine/index.js analyst: the admin's dispatch path (= daily --agents analyst) — --dry-run on a temp copy exits 0 and prints the analyst line; --page is refused (exit 2); the registry no longer says not built yet", async () => {
  const out = sink();
  const err = sink();
  const code = await main(["analyst", "--dry-run", "--now", SUNDAY], { stdout: out, stderr: err, processEnv: { ...MOCK, IG_DRY_RUN: "1" }, companyDir: COMPANY_DIR });
  assert.equal(code, EXIT.ok, err.text() + out.text());
  assert.ok(out.lines.some((l) => l.startsWith("daily: --dry-run works on a temp copy")));
  assert.ok(out.lines.some((l) => l.startsWith("[analyst] ok ") && l.includes("report reports/2026-W41.md")), out.text());
  for (const name of AGENT_ORDER) if (name !== "analyst") assert.ok(out.lines.some((l) => l.startsWith(`[${name}] ok`) && l.includes("not selected")), name);
  assert.ok(out.lines.at(-1).startsWith("daily: dry run complete"));
  const e2 = sink();
  assert.equal(await runAnalystCommand({ companyDir: COMPANY_DIR, flags: { page: "kaatdo", "dry-run": true }, stdout: sink(), stderr: e2, processEnv: MOCK }), EXIT.usage);
  assert.match(e2.text(), /--page is not accepted/);
  const e3 = sink();
  assert.equal(await runAnalystCommand({ companyDir: COMPANY_DIR, flags: { agents: "ceo", "dry-run": true }, stdout: sink(), stderr: e3, processEnv: MOCK }), EXIT.usage);
  assert.match(e3.text(), /--agents is fixed to analyst/);
  assert.equal(fixtureReport(), readFileSync(join(COMPANY_DIR, "state", "reports", "2026-W41.md"), "utf8"), "the repo fixture is untouched");
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

function treeHash(dir) {
  const h = createHash("sha256");
  for (const p of walk(dir).sort()) {
    h.update(relative(dir, p).replace(/\\/g, "/"));
    h.update(readFileSync(p));
  }
  return h.digest("hex");
}

test("R2-01: `analyst` under IG_DRY_RUN=1 WITHOUT --dry-run works on a temp copy like publish — the given company dir is byte-identical, the dry-run zeros land in the copy's metrics/ and stdout names the copy; collectMetrics with a real client ignores a stray dryRun:true record (the window is fetched, a real record written) while the dry-run client still treats it as measured; runAnalyst reports dry-run metrics only when includeDryRun is set", async () => {
  // 1. the CLI path (= engine-daily's `daily --agents analyst`): a 7d window falls due at MONDAY once kd's publish is back-dated
  const fx = copyFixture();
  try {
    const rows = fx.state.readJsonl("state/published.jsonl").map((r) => (r.draftId === KD ? { ...r, publishedAt: "2026-10-01T19:31:00+05:30", slotAt: "2026-10-01T19:30:00+05:30" } : r));
    writeFileSync(join(fx.dir, "state", "published.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    assert.equal(fx.metrics().length, 2, "the fixture's two 48h records");
    const before = treeHash(fx.dir);
    const out = sink();
    const err = sink();
    const code = await main(["analyst", "--now", MONDAY], { stdout: out, stderr: err, processEnv: { ...MOCK, IG_DRY_RUN: "1", MEDIA_DIR: fx.mediaRoot }, companyDir: fx.dir });
    assert.equal(code, EXIT.ok, err.text() + out.text());
    assert.equal(treeHash(fx.dir), before, "the given company dir is byte-identical afterwards (no metrics, no run record, no status.json)");
    assert.equal(fx.metrics().length, 2, "no dry-run record in the given dir");
    const m = out.lines[0].match(/^daily: IG_DRY_RUN=1 works on a temp copy (.+hoshlab-daily-dry-run-.+) \(the repo's company dir is untouched\)$/);
    assert.ok(m, out.lines[0]);
    const copy = m[1];
    try {
      assert.ok(out.lines.some((l) => l === `[analyst] ${KD}: insights fetched (7d) — dry run, zeros`), out.text());
      assert.ok(out.lines.some((l) => l.startsWith("[analyst] ") && l.includes("insights: 1 post measured (1 record), 1 not_due")), out.text());
      assert.match(out.lines.at(-1), /^daily: dry run complete — state written under .+; nothing committed$/);
      const copyState = createState({ companyDir: copy, now: MONDAY });
      const copyRows = copyState.readJsonl("state/metrics/2026-10.jsonl");
      assert.equal(copyRows.length, 3, "the dry-run record went to the copy");
      assert.equal(copyRows[2].draftId, KD);
      assert.equal(copyRows[2].window, "7d");
      assert.equal(copyRows[2].dryRun, true);
      assert.deepEqual(copyRows[2].metrics, { reach: 0, views: 0, likes: 0, comments: 0, saved: 0, shares: 0 });
      assert.equal(copyState.readJsonl("state/runs/2026-10.jsonl").at(-1).dryRun, true, "the copy's run record is labelled a dry run");
    } finally {
      rmSync(join(copy, ".."), { recursive: true, force: true });
    }
    // the same flags with no dry-run trigger at all are refused: --now needs a dry run
    const e2 = sink();
    assert.equal(await main(["analyst", "--now", MONDAY], { stdout: sink(), stderr: e2, processEnv: { ...MOCK, MEDIA_DIR: fx.mediaRoot }, companyDir: fx.dir }), EXIT.usage);
    assert.match(e2.text(), /--now <iso> is accepted only with --dry-run or IG_DRY_RUN=1/);
    assert.equal(treeHash(fx.dir), before);
  } finally {
    fx.cleanup();
  }

  // 2. collectMetrics: a stray dryRun:true record for kd's 7d window (what a pre-R2-01 run would have left behind)
  const fx2 = copyFixture();
  try {
    const zeros = { reach: 0, views: 0, likes: 0, comments: 0, saved: 0, shares: 0 };
    fx2.state.appendJsonl("state/metrics/2026-10.jsonl", { draftId: KD, igMediaId: "17900000000000001", page: "kaatdo", at: "2026-10-13T05:31:00+05:30", window: "7d", metrics: zeros, source: "ig-insights", raw: { dryRun: true }, dryRun: true }, METRIC_SPEC);
    const published = fx2.state.readJsonl("state/published.jsonl");
    // the dry-run client sees it as measured: only rp's 7d is fetched (a dry run never fetches a window twice)
    const dry = fakeClient({ "17900000000000001": { values: VALUES }, "17900000000000002": { values: VALUES } }, { dryRun: true });
    const r0 = await collectMetrics({ published, existing: readMetrics(fx2.state, NEXT_SUNDAY), clientFor: () => dry, now: NEXT_SUNDAY, state: fx2.state });
    assert.deepEqual(r0.requested.map((q) => [q.draftId, q.windows]), [[RP, ["7d"]]]);
    assert.deepEqual(r0.skipped, [{ draftId: KD, reason: "not_due" }]);
    assert.equal(fx2.metrics().length, 4, "2 real 48h + 2 dry-run 7d");
    assert.ok(fx2.metrics().slice(2).every((row) => row.dryRun === true));
    // the real client ignores both dry-run records: kd's and rp's 7d windows are fetched and written as real records
    const real = fakeClient({ "17900000000000001": { values: { ...VALUES, reach: 555 } }, "17900000000000002": { values: { ...VALUES, reach: 777 } } });
    const r = await collectMetrics({ published, existing: readMetrics(fx2.state, NEXT_SUNDAY), clientFor: () => real, now: NEXT_SUNDAY, runId: "engine-daily-20261018-0531-abcdef", state: fx2.state });
    assert.deepEqual(real.calls.map((c) => c.igMediaId), ["17900000000000001", "17900000000000002"]);
    assert.deepEqual(r.requested.map((q) => [q.draftId, q.windows]), [[KD, ["7d"]], [RP, ["7d"]]], "a dry-run record does not count as a measurement for a real client");
    assert.deepEqual(r.skipped, []);
    const rows = fx2.metrics();
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.slice(4).map((m) => [m.draftId, m.window, m.dryRun, m.metrics.reach]), [[KD, "7d", undefined, 555], [RP, "7d", undefined, 777]]);
    for (const row of rows.slice(4)) assertShape(row, METRIC_SPEC);
    // and once real records exist, the real client is done (the dry-run lines change nothing)
    const again = fakeClient();
    const r2 = await collectMetrics({ published, existing: readMetrics(fx2.state, NEXT_SUNDAY), clientFor: () => again, now: NEXT_SUNDAY, state: fx2.state });
    assert.equal(again.calls.length, 0);
    assert.deepEqual(r2.skipped.map((s) => s.reason), ["not_due", "not_due"]);

    // 3. runAnalyst: with the real records removed, only dry-run metrics remain → a real run has nothing to report on
    writeFileSync(join(fx2.dir, "state", "metrics", "2026-10.jsonl"), rows.filter((m) => m.dryRun === true).map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
    assert.equal(fx2.metrics().length, 2, "dry-run records only");
    const rReal = await runAnalyst({ config, router: router(fx2.state, MOCK, NEXT_SUNDAY), state: fx2.state, now: NEXT_SUNDAY, runId: RUN_ID });
    assert.equal(rReal.skipped, SKIP_NO_METRICS, "a real run neither counts nor reports dryRun records");
    assert.match(rReal.note, /^no insights yet for the 2 posts of the last 28 days/);
    // a dry run (includeDryRun, as daily.js passes for the dry-run client) reads them — and the mock's fixture numbers then fail the number rule
    await assert.rejects(runAnalyst({ config, router: router(fx2.state, MOCK, NEXT_SUNDAY), state: fx2.state, now: NEXT_SUNDAY, runId: RUN_ID, includeDryRun: true }), (e) => e instanceof AgentOutputError && /report number not in metrics/.test(e.message));
    assert.equal(fx2.state.exists("state/reports/2026-W42.md"), false);
  } finally {
    fx2.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});
