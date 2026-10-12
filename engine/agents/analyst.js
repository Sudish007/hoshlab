// Analyst agent (design.md §3.1 step 8, §4.10, §5 row "Analyst"; P2-04; FEAT-203).
//
// Two deterministic halves around one model call:
//   1. collectMetrics(): for every published post that has been live ≥ 48 h ("48h") and ≥ 7 d ("7d") and has no
//      record for that window yet, GET /{igMediaId}/insights once and append one METRIC_SPEC record per due window
//      to metrics/<IST month of the fetch>.jsonl (review M9). A metric Meta leaves out is never read as 0: the post
//      stays unmeasured (insights_incomplete) and is retried next run. The dry-run client answers zeros labelled
//      dryRun:true, and the record carries the same label; a real client neither counts such a record as measured
//      nor reports on it (R2-01 — dry runs work on a temp copy, so one is only ever a stray).
//   2. runAnalyst(): the task JSON is built from the metrics records of the last 28 days (plus the engine's own
//      counts and sums over them), the model writes perPage / experiments / forCeo / reportMarkdown, and the
//      engine post-validates that EVERY number token in the output exists among the metrics values or the
//      engine-computed counts (validateAnalystOutput → the router's single repair call → AgentOutputError
//      "report number not in metrics"). The report is written to reports/<YYYY-Www>.md = reportMarkdown + one
//      fenced JSON block holding the validated output plus an `engine` object (generatedAt, runId, metricsUsed…)
//      that the Reports page and the CEO read back with parseReport(). Nothing is written when no post has
//      metrics yet (skipped: no_metrics) — the first report appears after the first Sunday with a 48 h-old post.
// Runs on Sunday IST (shouldRun) or whenever `--agents analyst` names it (engine/commands/daily.js step 8).
import { existsSync, readdirSync } from "node:fs";
import { METRIC_SPEC, METRIC_WINDOWS, WEEK_ID } from "../lib/schema.js";
import { reportPath } from "../lib/ids.js";
import { dowIst, hoursBetween, isoWeekId, istDate, istParts, nowIst, parseIso } from "../lib/time.js";
import { IgError, INSIGHT_METRICS, INSIGHTS_DOC } from "../ig/client.js";
import { prioritiesFor } from "./ceo.js";

export const AGENT = "analyst";
export const METRIC_NAMES = INSIGHT_METRICS;
export { INSIGHTS_DOC };
// The two measurement windows (design §4.10): a post is due for a window once it has been live that long.
export const WINDOWS = [
  { id: "48h", hours: 48, days: 2, label: "48 hours" },
  { id: "7d", hours: 168, days: 7, label: "7 days" },
];
export const REPORT_DAYS = 28; // the report covers the posts of the last 28 days (design §5 "published 28 d")
export const FETCH_MAX_DAYS = 35; // posts older than this are never (re)measured — both windows closed long ago
export const MAX_EXPERIMENTS = 3;
export const REPORT_JSON_FENCE = "```json";
export const SKIP_NO_METRICS = "no_metrics";
export const NUMBER_RULE = "report number not in metrics";
export const SKIP_REASONS = ["page_not_configured", "dry_run_record", "not_due", "too_old", "insights_incomplete", "token_invalid"];
const MS_PER_DAY = 86400000;
const WINDOW_IDS = WINDOWS.map((w) => w.id);
if (WINDOW_IDS.join() !== METRIC_WINDOWS.join()) throw new Error("analyst: WINDOWS must match schema METRIC_WINDOWS");

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`analyst: invalid date ${String(v)}`);
  return d;
}

// The model's JSON output (design §5). topDraftId / bottomDraftId are "" for a page without posts (charter).
export const PER_PAGE_SPEC = { page: "handle", posts: "int[0..100000]", reach: "int", views: "int", saved: "int", topDraftId: "str", bottomDraftId: "str", observations: ["str"] };
export const EXPERIMENT_SPEC = { page: "handle", hypothesis: "str", test: "str", measure: "str" };
export const OUTPUT_SPEC = {
  week: WEEK_ID,
  perPage: [PER_PAGE_SPEC],
  experiments: [EXPERIMENT_SPEC, { max: MAX_EXPERIMENTS }],
  forCeo: ["str", { min: 1 }],
  reportMarkdown: "str",
};

// Sunday IST (design §3.1 step 8).
export function shouldRun(now = new Date()) {
  return dowIst(toDate(now)) === "sun";
}

// ---------------------------------------------------------------------------------------
// Metrics files

function previousMonthKey(d) {
  const p = istParts(d);
  const y = p.m === 1 ? p.y - 1 : p.y;
  const m = p.m === 1 ? 12 : p.m - 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Every metrics record of the current and the previous IST month (35 days span at most two month files).
export function readMetrics(state, now) {
  const d = toDate(now);
  const rels = [...new Set([`state/metrics/${previousMonthKey(d)}.jsonl`, state.monthLogPath("metrics", d)])];
  const out = [];
  for (const rel of rels) if (state.exists(rel)) out.push(...state.readJsonl(rel));
  return out;
}

export function measuredKey(draftId, window) {
  return `${draftId}|${window}`;
}

// Windows a published record is due for at `now` and has no record for yet (`measured` = Set of measuredKey()).
export function dueWindows(record, now, measured = new Set()) {
  const hours = hoursBetween(record.publishedAt, toDate(now));
  return WINDOWS.filter((w) => hours >= w.hours && !measured.has(measuredKey(record.draftId, w.id))).map((w) => w.id);
}

// published.jsonl records published within `days` of `now` (newest last), dry-run records included or not.
export function publishedWithin(published, now, days, { includeDryRun = false } = {}) {
  const to = toDate(now).getTime();
  const from = to - days * MS_PER_DAY;
  return published
    .filter((r) => r && (includeDryRun || r.dryRun !== true))
    .filter((r) => {
      const t = Date.parse(r.publishedAt);
      return !Number.isNaN(t) && t >= from && t <= to;
    })
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)) || a.draftId.localeCompare(b.draftId));
}

// collectMetrics({ published, existing, clientFor, now, runId, state, log })
//   published  every published.jsonl record (dry-run records are measured only by a dry-run client)
//   existing   metrics records already on file (readMetrics)
//   clientFor  (handle) → an Instagram client with insights(), or null when the page is not configured yet
//   → { records, requested: [{ draftId, igMediaId, page, windows }], skipped: [{ draftId, reason }], errors: [str],
//       changed: [rel], notConfigured: [handles], note }
// One GET per post per run (both windows read from the same answer when both fall due in one run); a record is
// written only when every metric has a value. An IgError for one post is recorded and the next post is tried; a
// token error (code 190) stops that page for this run.
// R2-01: a dryRun:true record (the dry-run client's zeros) never counts as a measurement for a REAL client — a stray
// line cannot block the real fetch of that window; the dry-run client sees every record (a dry run fetches nothing twice).
export async function collectMetrics({ published = [], existing = [], clientFor, now, runId, state, log = () => {} } = {}) {
  if (typeof clientFor !== "function" || !state) throw new TypeError("analyst: clientFor and state are required");
  const d = toDate(now);
  const at = nowIst(d);
  const measuredReal = new Set(existing.filter((r) => r && r.dryRun !== true).map((r) => measuredKey(r.draftId, r.window)));
  const measuredAll = new Set(existing.filter((r) => r).map((r) => measuredKey(r.draftId, r.window)));
  const records = [];
  const requested = [];
  const skipped = [];
  const errors = [];
  const changed = new Set();
  const notConfigured = new Set();
  const deadPages = new Set();
  const candidates = publishedWithin(published, d, FETCH_MAX_DAYS, { includeDryRun: true });
  for (const rec of candidates) {
    let windows = dueWindows(rec, d, measuredReal); // the dry-run client's view (every record) is a subset of this
    if (!windows.length) {
      skipped.push({ draftId: rec.draftId, reason: "not_due" });
      continue;
    }
    if (deadPages.has(rec.page)) {
      skipped.push({ draftId: rec.draftId, reason: "token_invalid" });
      continue;
    }
    const client = clientFor(rec.page); // built only when a post is due (no token read, no client, otherwise)
    if (!client) {
      notConfigured.add(rec.page);
      skipped.push({ draftId: rec.draftId, reason: "page_not_configured" });
      continue;
    }
    if (rec.dryRun === true && client.dryRun !== true) {
      skipped.push({ draftId: rec.draftId, reason: "dry_run_record" });
      continue;
    }
    if (client.dryRun === true) {
      windows = dueWindows(rec, d, measuredAll);
      if (!windows.length) {
        skipped.push({ draftId: rec.draftId, reason: "not_due" });
        continue;
      }
    }
    let answer;
    try {
      answer = await client.insights(rec.igMediaId, METRIC_NAMES);
    } catch (err) {
      if (!(err instanceof IgError)) throw err;
      errors.push(`${rec.draftId}: ${err.message}`);
      if (err.tokenInvalid) deadPages.add(rec.page);
      continue;
    }
    if (answer.missing && answer.missing.length) {
      skipped.push({ draftId: rec.draftId, reason: `insights_incomplete: ${answer.missing.join(",")}` });
      log(`[analyst] ${rec.draftId}: insights answer without ${answer.missing.join(", ")} — not recorded (no value is read as 0); retried next run`);
      continue;
    }
    const metrics = {};
    for (const name of METRIC_NAMES) metrics[name] = answer.metrics[name];
    for (const window of windows) {
      const record = { draftId: rec.draftId, igMediaId: rec.igMediaId, page: rec.page, at, window, metrics, source: "ig-insights", raw: answer.raw && typeof answer.raw === "object" ? answer.raw : {} };
      if (runId) record.runId = runId;
      if (answer.dryRun === true || client.dryRun === true) record.dryRun = true;
      changed.add(state.appendLog("metrics", record, METRIC_SPEC, d));
      measuredAll.add(measuredKey(rec.draftId, window));
      if (record.dryRun !== true) measuredReal.add(measuredKey(rec.draftId, window));
      records.push(record);
    }
    requested.push({ draftId: rec.draftId, igMediaId: rec.igMediaId, page: rec.page, windows });
    log(`[analyst] ${rec.draftId}: insights fetched (${windows.join(", ")})${answer.dryRun === true ? " — dry run, zeros" : ""}`);
  }
  // posts beyond FETCH_MAX_DAYS are out of scope (both windows closed weeks ago); a publish time after `now` is not due
  for (const r of published) {
    if (!r || candidates.includes(r)) continue;
    skipped.push({ draftId: r.draftId, reason: Date.parse(r.publishedAt) > d.getTime() ? "not_due" : "too_old" });
  }
  const counts = {};
  for (const s of skipped) counts[s.reason.split(":")[0]] = (counts[s.reason.split(":")[0]] || 0) + 1;
  const parts = [`${requested.length} post${requested.length === 1 ? "" : "s"} measured (${records.length} record${records.length === 1 ? "" : "s"})`];
  for (const [reason, n] of Object.entries(counts)) parts.push(`${n} ${reason}`);
  if (errors.length) parts.push(`${errors.length} fetch error${errors.length === 1 ? "" : "s"}`);
  if (notConfigured.size) parts.push(`token not configured yet: ${[...notConfigured].join(", ")}`);
  return { records, requested, skipped, errors, changed: [...changed], notConfigured: [...notConfigured], note: `insights: ${parts.join(", ")}` };
}

// ---------------------------------------------------------------------------------------
// Engine-computed numbers

const zeroSums = () => Object.fromEntries(METRIC_NAMES.map((n) => [n, 0]));

// aggregate({ pages, published, metrics }) → everything the engine counts or sums for the model and the number rule:
//   perPage[]: { page, posts, byWindow: { <window>: { measured, ...sums } }, perPost: [{ draftId, publishedAt, format, late,
//              windows: { <window>: metrics|null } }], window (the window top/bottom are ranked on: 7d when any post has it,
//              else 48h), topDraftId, bottomDraftId (by reach in that window; "" when nothing is measured) }
//   totals: { posts, measuredPosts, byWindow: { <window>: { measured, ...sums } } }, unmeasured: [draftIds]
export function aggregate({ pages = [], published = [], metrics = [] } = {}) {
  const handles = pages.map((p) => (typeof p === "string" ? p : p.handle));
  const latest = new Map(); // draftId|window → the latest record (a re-fetch supersedes)
  for (const m of metrics) {
    const key = measuredKey(m.draftId, m.window);
    const prev = latest.get(key);
    if (!prev || String(m.at) >= String(prev.at)) latest.set(key, m);
  }
  const perPage = [];
  const totals = { posts: published.length, measuredPosts: 0, byWindow: Object.fromEntries(WINDOW_IDS.map((w) => [w, { measured: 0, ...zeroSums() }])) };
  const unmeasured = [];
  for (const handle of handles) {
    const mine = published.filter((p) => p.page === handle);
    const byWindow = Object.fromEntries(WINDOW_IDS.map((w) => [w, { measured: 0, ...zeroSums() }]));
    const perPost = mine.map((p) => {
      const windows = {};
      for (const w of WINDOW_IDS) {
        const rec = latest.get(measuredKey(p.draftId, w));
        windows[w] = rec ? { ...rec.metrics } : null;
        if (rec) {
          byWindow[w].measured += 1;
          totals.byWindow[w].measured += 1;
          for (const n of METRIC_NAMES) {
            byWindow[w][n] += rec.metrics[n];
            totals.byWindow[w][n] += rec.metrics[n];
          }
        }
      }
      if (!WINDOW_IDS.some((w) => windows[w])) unmeasured.push(p.draftId);
      else totals.measuredPosts += 1;
      return { draftId: p.draftId, publishedAt: p.publishedAt, format: p.format, late: p.late === true, windows };
    });
    const window = byWindow["7d"].measured > 0 ? "7d" : "48h";
    const ranked = perPost.filter((p) => p.windows[window]).sort((a, b) => b.windows[window].reach - a.windows[window].reach || a.draftId.localeCompare(b.draftId));
    perPage.push({ page: handle, posts: mine.length, byWindow, perPost, window, topDraftId: ranked.length ? ranked[0].draftId : "", bottomDraftId: ranked.length ? ranked[ranked.length - 1].draftId : "" });
  }
  return { perPage, totals, unmeasured };
}

// Canonical form of a number token: digits only, thousands separators removed ("2,150" → "2150").
function canon(token) {
  return String(token).replace(/,/g, "");
}

// Calendar numbers a weekly report names in prose ("5–11 October 2026", "week 41", "7-day insights due on the 13th"):
// the year, the ISO week number and the days of month of the report week, of every post's publish date, of every
// fetch and of every window's due date (publishedAt + the window's hours). All engine-known dates — never a metric.
export function calendarNumbers({ now, published = [], metrics = [] } = {}) {
  const out = new Set();
  const add = (d) => {
    const p = istParts(d);
    out.add(String(p.y));
    out.add(String(p.d));
  };
  if (now !== undefined && now !== null) {
    const d = toDate(now);
    const p = istParts(d);
    out.add(String(Number(isoWeekId(d).slice(-2))));
    const monday = new Date(d.getTime() - ((p.dow + 6) % 7) * MS_PER_DAY);
    for (let i = 0; i < 7; i++) add(new Date(monday.getTime() + i * MS_PER_DAY));
  }
  for (const r of published) {
    if (!r || !r.publishedAt) continue;
    const t = parseIso(r.publishedAt);
    add(t);
    for (const w of WINDOWS) add(new Date(t.getTime() + w.hours * 3600000));
  }
  for (const m of metrics) if (m && m.at) add(parseIso(m.at));
  return out;
}

// Every number the output may contain: metrics values, media ids, engine counts and sums, the window constants and
// the calendar numbers of the week (calendarNumbers). Nothing else — no ratio, percentage or average the model works
// out itself.
export function allowedNumbers({ metrics = [], aggregates = null, published = [], now } = {}) {
  const out = new Set(["0", ...calendarNumbers({ now, published, metrics })]);
  const add = (v) => {
    if (Number.isInteger(v)) out.add(String(v));
    else if (typeof v === "string" && /^\d+$/.test(v)) out.add(v);
  };
  for (const m of metrics) {
    for (const n of METRIC_NAMES) add(m.metrics && m.metrics[n]);
    add(m.igMediaId);
  }
  for (const p of published) add(p.igMediaId);
  if (aggregates) {
    add(aggregates.totals.posts);
    add(aggregates.totals.measuredPosts);
    add(aggregates.unmeasured.length);
    add(aggregates.perPage.length);
    for (const w of Object.values(aggregates.totals.byWindow)) for (const v of Object.values(w)) add(v);
    for (const page of aggregates.perPage) {
      add(page.posts);
      add(page.perPost.filter((p) => WINDOW_IDS.some((w) => p.windows[w])).length);
      for (const w of Object.values(page.byWindow)) for (const v of Object.values(w)) add(v);
    }
  }
  for (const w of WINDOWS) {
    add(w.hours);
    add(w.days);
  }
  add(REPORT_DAYS);
  return out;
}

// Number tokens of free text that must be accounted for. Not counted: ISO dates / datetimes, week ids, clock times,
// Markdown list markers ("1. ") and digits that continue a word, id or path (fact ids rp-f05, idea ids kd-i0003,
// "v26.0", "W41", hashtags, URLs). A number that starts on its own counts whatever follows it: "48h" → 48, "7d" → 7,
// "2.1×" → 2.1 (a ratio the model worked out), "35%" → 35. "2,150" and "1,00,000" are one token each.
export function numberTokens(text) {
  let s = String(text ?? "");
  s = s.replace(/\d{4}-W\d{2}/g, " ");
  s = s.replace(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/g, " ");
  s = s.replace(/\b\d{1,2}:\d{2}\b/g, " ");
  s = s.replace(/^(\s{0,3}|#{1,6}\s+)\d+\.\s/gm, "$1");
  const out = [];
  for (const m of s.matchAll(/(?<![\w#.\-/])(\d+(?:,\d+)*(?:\.\d+)?)(?!\.\d)/g)) out.push(canon(m[1]));
  return out;
}

function offending(text, allowed) {
  return numberTokens(text).filter((t) => !allowed.has(t) && !allowed.has(canon(t)));
}

// Semantic rules the shape cannot express (design §5 "never: report a number not present in metrics"):
//   - the week is the one asked for (`week` null skips the rule — the mock fixture is pinned to one week);
//   - perPage names every configured page exactly once; `posts` equals the engine's count; a page without posts
//     carries empty ids; top/bottom ids are published posts of that page;
//   - every number token in reportMarkdown, observations, experiments and forCeo — and perPage reach/views/saved —
//     is among `allowed` (allowedNumbers()).
export function validateAnalystOutput(json, { week = null, pages = [], aggregates = null, allowed = new Set() } = {}) {
  const errors = [];
  const handles = pages.map((p) => (typeof p === "string" ? p : p.handle));
  if (week && json.week !== week) errors.push(`$.week: expected ${week}, got ${JSON.stringify(json.week)}`);
  const seen = new Set();
  (json.perPage || []).forEach((p, i) => {
    if (!handles.includes(p.page)) return void errors.push(`$.perPage[${i}].page: unknown page ${JSON.stringify(p.page)}`);
    if (seen.has(p.page)) errors.push(`$.perPage[${i}].page: @${p.page} listed twice`);
    seen.add(p.page);
    const agg = aggregates ? aggregates.perPage.find((x) => x.page === p.page) : null;
    if (agg && p.posts !== agg.posts) errors.push(`$.perPage[${i}].posts: @${p.page} published ${agg.posts} post${agg.posts === 1 ? "" : "s"} in the window, got ${p.posts}`);
    for (const k of ["reach", "views", "saved"]) if (!allowed.has(String(p[k]))) errors.push(`$.perPage[${i}].${k}: ${NUMBER_RULE}: ${p[k]}`);
    const ids = agg ? agg.perPost.map((x) => x.draftId) : null;
    for (const k of ["topDraftId", "bottomDraftId"]) {
      const v = p[k];
      if (p.posts === 0 && v !== "") errors.push(`$.perPage[${i}].${k}: must be "" for a page without posts`);
      else if (v !== "" && ids && !ids.includes(v)) errors.push(`$.perPage[${i}].${k}: ${JSON.stringify(v)} is not a post @${p.page} published in the window`);
    }
    (p.observations || []).forEach((o, j) => {
      for (const t of offending(o, allowed)) errors.push(`$.perPage[${i}].observations[${j}]: ${NUMBER_RULE}: ${t}`);
    });
  });
  for (const h of handles) if (!seen.has(h)) errors.push(`$.perPage: page @${h} is missing (list every page, posts: 0 when it published nothing)`);
  (json.experiments || []).forEach((e, i) => {
    if (!handles.includes(e.page)) errors.push(`$.experiments[${i}].page: unknown page ${JSON.stringify(e.page)}`);
    for (const k of ["hypothesis", "test", "measure"]) for (const t of offending(e[k], allowed)) errors.push(`$.experiments[${i}].${k}: ${NUMBER_RULE}: ${t}`);
  });
  (json.forCeo || []).forEach((f, i) => {
    for (const t of offending(f, allowed)) errors.push(`$.forCeo[${i}]: ${NUMBER_RULE}: ${t}`);
  });
  const bad = [...new Set(offending(json.reportMarkdown, allowed))];
  for (const t of bad.slice(0, 10)) errors.push(`$.reportMarkdown: ${NUMBER_RULE}: ${t}`);
  if (bad.length > 10) errors.push(`$.reportMarkdown: ${bad.length - 10} more numbers not in metrics`);
  return errors;
}

// ---------------------------------------------------------------------------------------
// Report files

// reportMarkdown + the JSON block (validated output + the engine's provenance) the site and the CEO read back.
export function renderReport(json, engine = {}) {
  const body = String(json.reportMarkdown || "").replace(/\s+$/, "");
  return `${body}\n\n${REPORT_JSON_FENCE}\n${JSON.stringify({ ...json, engine }, null, 2)}\n\`\`\`\n`;
}

// parseReport(markdown) → { report (the model output), engine (provenance or null), body (markdown without the block) }
// or null when there is no JSON block.
export function parseReport(markdown) {
  const text = String(markdown || "");
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let last = null;
  for (const m of text.matchAll(re)) last = m;
  if (last === null) return null;
  const parsed = JSON.parse(last[1]);
  const { engine = null, ...report } = parsed;
  return { report, engine, body: text.slice(0, last.index).replace(/\s+$/, "") };
}

// listReports(state) → [{ week, rel, path }] newest week first.
export function listReports(state) {
  const dir = state.resolve("state/reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-W\d{2}\.md$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ week: name.replace(/\.md$/, ""), path: `reports/${name}`, rel: `state/reports/${name}` }));
}

// The newest report → { week, rel, path, markdown, report, engine } or null.
export function latestReport(state) {
  const [first] = listReports(state);
  if (!first) return null;
  const markdown = state.readText(first.rel);
  const parsed = parseReport(markdown);
  return { ...first, markdown, report: parsed ? parsed.report : null, engine: parsed ? parsed.engine : null };
}

// ---------------------------------------------------------------------------------------
// The model call

function titleOf(record, { drafts = new Map(), ideas = new Map() } = {}) {
  const draft = drafts.get(record.draftId);
  const idea = draft && draft.ideaId ? ideas.get(draft.ideaId) : null;
  if (idea && idea.title) return idea.title;
  if (draft && typeof draft.caption === "string") return draft.caption.split(/\r?\n/).find((l) => l.trim()) || null;
  return null;
}

// The task JSON (charter "Inputs you receive in the task JSON") — numbers come ONLY from metrics records and the
// engine's counts over them; `allowedNumbers` tells the model which numbers it may quote.
export function buildTask({ config, now, published = [], metrics = [], aggregates, memo = null, previousReport = null, allowed = new Set(), drafts, ideas } = {}) {
  const d = toDate(now);
  const notes = [];
  if (aggregates && aggregates.unmeasured.length) notes.push(`${aggregates.unmeasured.length} post${aggregates.unmeasured.length === 1 ? "" : "s"} published in the window ${aggregates.unmeasured.length === 1 ? "has" : "have"} no insights yet (not 48 hours old at the last fetch, or the fetch failed); list them under "Missing data".`);
  if (!memo) notes.push("No CEO memo for this week; report the numbers without judging priorities.");
  notes.push("Quote only numbers from `metrics`, `aggregates` and `allowedNumbers`; ratios, percentages and averages you compute yourself are not allowed — describe comparisons in words.");
  return {
    week: isoWeekId(d),
    today: istDate(d),
    reportDays: REPORT_DAYS,
    windows: WINDOWS.map((w) => ({ id: w.id, hours: w.hours, label: w.label })),
    metricNames: [...METRIC_NAMES],
    pages: (config.pages || []).map((p) => ({ handle: p.handle, name: p.displayName, languages: p.languages, formats: p.formats })),
    published: published.map((r) => ({ draftId: r.draftId, page: r.page, format: r.format, title: titleOf(r, { drafts, ideas }), publishedAt: r.publishedAt, slotAt: r.slotAt, late: r.late === true })),
    metrics: metrics.map((m) => ({ draftId: m.draftId, page: m.page, window: m.window, at: m.at, ...Object.fromEntries(METRIC_NAMES.map((n) => [n, m.metrics[n]])), dryRun: m.dryRun === true })),
    aggregates,
    memo: memo ? { week: memo.week || null, priorities: (config.pages || []).map((p) => ({ page: p.handle, ...prioritiesFor(memo, p.handle) })).map(({ page, priorities, pause }) => ({ page, priorities: priorities.map((x) => ({ rank: x.rank, theme: x.theme, why: x.why })), pause: pause.map((x) => ({ what: x.what, why: x.why })) })) } : null,
    previousReport: previousReport ? { week: previousReport.week, perPage: previousReport.perPage, forCeo: previousReport.forCeo, experiments: previousReport.experiments } : null,
    allowedNumbers: [...allowed].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b),
    notes,
  };
}

// runAnalyst({ config, router, state, now, runId, memo, log, includeDryRun })
//   → { skipped, note } when no post of the last 28 days has metrics yet, else
//     { week, path, rel, report, markdown, engine, modelCalled, mock, calls, costUsd, runId, at, note }
// Router errors (BudgetExhaustedError, AgentOutputError, AllProvidersFailedError) propagate and nothing is written.
// includeDryRun (default false — a real run): whether dry-run published records (dry- ids) and dryRun:true metrics
// take part in the report; daily.js passes true only when the Instagram client itself is the dry-run one (R2-01), so
// a stray dry-run line can never feed a real report's numbers.
export async function runAnalyst({ config, router, state, now, runId, memo = null, log = () => {}, includeDryRun = false } = {}) {
  if (!config || !router || !state) throw new TypeError("analyst: config, router and state are required");
  const d = toDate(now === undefined ? state.now() : now);
  const week = isoWeekId(d);
  const dry = includeDryRun === true;
  const published = publishedWithin(state.readJsonl("state/published.jsonl"), d, REPORT_DAYS, { includeDryRun: dry });
  const ids = new Set(published.map((p) => p.draftId));
  const metrics = readMetrics(state, d).filter((m) => ids.has(m.draftId) && (dry || m.dryRun !== true));
  if (!metrics.length) {
    return { skipped: SKIP_NO_METRICS, week, note: `no insights yet for the ${published.length} post${published.length === 1 ? "" : "s"} of the last ${REPORT_DAYS} days — no report written (the first report needs a post that has been live for 48 hours)` };
  }
  const aggregates = aggregate({ pages: config.pages, published, metrics });
  const allowed = allowedNumbers({ metrics, aggregates, published, now: d });
  const drafts = new Map();
  for (const did of state.listDrafts()) if (ids.has(did)) drafts.set(did, state.readDraft(did));
  const ideas = new Map();
  for (const idea of state.readJsonl("state/ideas.jsonl")) if (idea && idea.id) ideas.set(idea.id, idea);
  // last week's report for deltas (a re-run in the same week does not compare the report with itself)
  const previousEntry = listReports(state).find((r) => r.week !== week);
  const previousParsed = previousEntry ? parseReport(state.readText(previousEntry.rel)) : null;
  const previousReport = previousParsed ? previousParsed.report : null;
  const task = buildTask({ config, now: d, published, metrics, aggregates, memo, previousReport, allowed, drafts, ideas });
  // The mock fixture (tests/fixtures/llm/analyst.ok.json) is pinned to one week, as the CEO's is: under MOCK_LLM=1
  // the week rule is waived; the number rule never is (a mock report with numbers absent from THIS company's
  // metrics must fail, or a mock_llm dispatch could commit invented numbers).
  const weekRule = router.isMock === true ? null : week;
  const res = await router.complete(AGENT, {
    task,
    spec: OUTPUT_SPEC,
    context: { brand: null, page: null, todayIst: d },
    validate: (json) => validateAnalystOutput(json, { week: weekRule, pages: config.pages, aggregates, allowed }),
  });
  const report = res.json;
  const engine = {
    generatedAt: nowIst(d),
    runId: runId || router.runId,
    week,
    reportDays: REPORT_DAYS,
    windows: WINDOW_IDS,
    publishedInWindow: published.length,
    metricsUsed: metrics.map((m) => ({ draftId: m.draftId, page: m.page, window: m.window, at: m.at, dryRun: m.dryRun === true })),
    unmeasured: aggregates.unmeasured,
    insightsDoc: INSIGHTS_DOC,
    mock: res.mock === true,
  };
  const markdown = renderReport(report, engine);
  const path = reportPath(d);
  const rel = `state/${path}`;
  state.writeText(rel, markdown);
  log(`[analyst] report ${path}: ${report.perPage.length} pages, ${report.forCeo.length} for the CEO, ${metrics.length} metrics record${metrics.length === 1 ? "" : "s"} used`);
  return {
    week,
    path,
    rel,
    report,
    markdown,
    engine,
    modelCalled: true,
    mock: res.mock === true,
    calls: res.calls,
    costUsd: res.costUsd,
    runId: engine.runId,
    at: engine.generatedAt,
    note: `report ${path}: ${published.length} post${published.length === 1 ? "" : "s"} in ${REPORT_DAYS} days, ${metrics.length} metrics record${metrics.length === 1 ? "" : "s"}, ${aggregates.unmeasured.length} unmeasured, ${report.experiments.length} experiment${report.experiments.length === 1 ? "" : "s"}, ${report.forCeo.length} for the CEO`,
  };
}
