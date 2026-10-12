// CEO agent (design.md §3.1 step 2, §5 row "CEO"; review N7 memo file name; plan D9; FEAT-205 P2-07).
// Runs on Monday (IST) or whenever the current ISO week has no memo yet, and writes
// company/state/memos/<YYYY-Www>.md = memoMarkdown + an 'Answers to the Analyst' section rendered from
// answers[] + a fenced ```json block with the whole JSON output (the Strategist reads the block back
// with parseMemo()). Inputs: the brand summaries, the latest Analyst report (reports/*.md JSON block),
// 30 days of owner feedback, the latest HR review with its proposal's status, 14 days of posts, the
// month's spend and the status flags. The CEO never publishes, never touches brand facts or modes, and
// may not allocate more than 100 % of the budget; it must answer every `forCeo` item of the report it
// was given — both are validated by the engine (semantic check → the router's single repair call →
// AgentOutputError).
import { WEEK_ID } from "../lib/schema.js";
import { usableFacts } from "../lib/brand.js";
import { memoPath } from "../lib/ids.js";
import { dowIst, isoWeekId, istDate, istMonthKey, nowIst, parseIso } from "../lib/time.js";

export const AGENT = "ceo";
export const DEFAULT_HANDLES = ["rishtapatra", "kaatdo", "job_rez"];
export const MAX_BUDGET_SPLIT_PCT = 100;
export const MEMO_JSON_FENCE = "```json";
export const ANSWERS_HEADING = "## Answers to the Analyst";
export const NO_REPORT_NOTE = "No Analyst report yet — the Analyst writes one on Sundays once a post has been live for 48 hours; plan on cadence and feedback alone and return an empty `answers` list.";
export const NO_HR_REVIEW_NOTE = "No HR review yet — the first one appears on the 1st of the month after the first month with runs.";
const MS_PER_DAY = 86400000;

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`ceo: invalid date ${String(v)}`);
  return d;
}

// The model's JSON output (design §5; FEAT-205 adds `answers`). budgetSplitPct names every page handle
// explicitly because a map spec ('*') cannot be expressed in the OpenAI strict dialect (review M7).
export function outputSpec(handles = DEFAULT_HANDLES) {
  const split = {};
  for (const h of handles) split[h] = "int[0..100]";
  return {
    week: WEEK_ID,
    priorities: [{ page: "handle", rank: "int[1..20]", theme: "str", why: "str", factIds: ["str"] }],
    pause: [{ page: "handle", what: "str", why: "str" }],
    budgetSplitPct: split,
    ownerQuestions: ["str"],
    answers: [{ forCeo: "str", answer: "str" }],
    memoMarkdown: "str",
  };
}
export const OUTPUT_SPEC = outputSpec();

// Whitespace-insensitive comparison of a report item with the model's quote of it.
function itemKey(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

// Semantic rules the shape cannot express: the week is the one asked for, every page is a known
// handle, every fact id is a usable fact of that page, the split never exceeds 100 %, and — when
// `forCeo` (the report's items) is given — every item has an answer that quotes it, no answer invents
// an item, and no answer is empty. `forCeo: null` skips the answers rule (a mock run without a report).
export function validateCeoOutput(json, { week, pages = [], forCeo = null } = {}) {
  const errors = [];
  const byHandle = new Map(pages.map((p) => [p.handle, p]));
  if (week && json.week !== week) errors.push(`$.week: expected ${week}, got ${JSON.stringify(json.week)}`);
  if (Array.isArray(forCeo)) {
    const answers = Array.isArray(json.answers) ? json.answers : [];
    const given = new Set(answers.map((a) => itemKey(a && a.forCeo)));
    const wanted = new Set(forCeo.map(itemKey));
    forCeo.forEach((item, i) => {
      if (!given.has(itemKey(item))) errors.push(`$.answers: no answer to the Analyst's item ${i + 1} (quote it verbatim in forCeo): ${JSON.stringify(item)}`);
    });
    answers.forEach((a, i) => {
      if (!wanted.has(itemKey(a && a.forCeo))) errors.push(`$.answers[${i}].forCeo: ${forCeo.length ? "not an item of the Analyst report" : "there is no Analyst report to answer"}: ${JSON.stringify(a && a.forCeo)}`);
      if (!itemKey(a && a.answer)) errors.push(`$.answers[${i}].answer: empty`);
    });
  }
  (json.priorities || []).forEach((p, i) => {
    const page = byHandle.get(p.page);
    if (!page) return void errors.push(`$.priorities[${i}].page: unknown page ${JSON.stringify(p.page)}`);
    const usable = page.factIds instanceof Set ? page.factIds : new Set(page.factIds || []);
    (p.factIds || []).forEach((id, j) => {
      if (!usable.has(id)) errors.push(`$.priorities[${i}].factIds[${j}]: ${id} is not a usable fact of @${p.page}`);
    });
  });
  (json.pause || []).forEach((p, i) => {
    if (!byHandle.has(p.page)) errors.push(`$.pause[${i}].page: unknown page ${JSON.stringify(p.page)}`);
  });
  const split = json.budgetSplitPct || {};
  const sum = Object.values(split).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
  if (sum > MAX_BUDGET_SPLIT_PCT) errors.push(`$.budgetSplitPct: sums to ${sum}, must not exceed ${MAX_BUDGET_SPLIT_PCT}`);
  return errors;
}

// Monday IST, or the current ISO week's memo is missing (design §3.1 step 2).
export function shouldRun(now, state) {
  const d = toDate(now);
  if (dowIst(d) === "mon") return true;
  return !state.exists(`state/${memoPath(d)}`);
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// '## Answers to the Analyst (report 2026-W41)' + one numbered item per answer, rendered by the engine from
// answers[] (P2-07) — the model does not repeat them in memoMarkdown. '' when there are no answers.
export function answersSection(answers, reportWeek = null) {
  if (!Array.isArray(answers) || !answers.length) return "";
  const head = reportWeek ? `${ANSWERS_HEADING} (report ${reportWeek})` : ANSWERS_HEADING;
  return [head, "", ...answers.map((a, i) => `${i + 1}. ${oneLine(a.forCeo)}\n   Answer: ${oneLine(a.answer)}`)].join("\n");
}

// memoMarkdown + the answers section + the JSON block the Strategist reads back (review N7 path via ids.memoPath).
export function renderMemo(json, { reportWeek = null } = {}) {
  const body = String(json.memoMarkdown || "").replace(/\s+$/, "");
  const answers = answersSection(json.answers, reportWeek);
  return `${body}\n\n${answers ? `${answers}\n\n` : ""}${MEMO_JSON_FENCE}\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`;
}

// parseMemo(markdown) → the object in the LAST fenced ```json block, or null when there is none.
export function parseMemo(markdown) {
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let last = null;
  for (const m of String(markdown || "").matchAll(re)) last = m[1];
  if (last === null) return null;
  return JSON.parse(last);
}

// readMemo(state, now) → { rel, markdown, memo } for the week of `now`, or null when no memo exists.
export function readMemo(state, now) {
  const rel = `state/${memoPath(toDate(now))}`;
  if (!state.exists(rel)) return null;
  const markdown = state.readText(rel);
  return { rel, markdown, memo: parseMemo(markdown) };
}

// The page's ranked priorities and pause entries from a memo JSON (empty lists when none).
export function prioritiesFor(memo, handle) {
  if (!memo || typeof memo !== "object") return { week: null, priorities: [], pause: [] };
  const priorities = (memo.priorities || []).filter((p) => p.page === handle).sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const pause = (memo.pause || []).filter((p) => p.page === handle);
  return { week: memo.week || null, priorities, pause };
}

// Markdown excerpt for the Strategist's context block (design §5 "the relevant memo excerpt").
export function memoExcerptFor(memo, handle) {
  const { week, priorities, pause } = prioritiesFor(memo, handle);
  if (!priorities.length && !pause.length) return "";
  const out = [`Memo ${week || "(week unknown)"} — priorities for @${handle}:`];
  for (const p of priorities) out.push(`${p.rank}. ${p.theme} — ${p.why}${p.factIds && p.factIds.length ? ` (facts: ${p.factIds.join(", ")})` : ""}`);
  if (pause.length) {
    out.push("Paused:");
    for (const p of pause) out.push(`- ${p.what} — ${p.why}`);
  }
  return out.join("\n");
}

function sinceMs(now, days) {
  return toDate(now).getTime() - days * MS_PER_DAY;
}

function atMs(record) {
  const t = Date.parse(record && (record.at || record.publishedAt));
  return Number.isNaN(t) ? null : t;
}

// Owner feedback of the last `days` days (feedback.jsonl is admin-owned; the engine only reads it).
export function feedbackSince(state, now, days = 30) {
  const from = sinceMs(now, days);
  return state.readJsonl("state/feedback.jsonl").filter((r) => {
    const t = atMs(r);
    return t !== null && t >= from;
  });
}

// published.jsonl records of the last `days` days.
export function publishedSince(state, now, days = 14) {
  const from = sinceMs(now, days);
  return state.readJsonl("state/published.jsonl").filter((r) => {
    const t = atMs(r);
    return t !== null && t >= from;
  });
}

// This IST month's spend from usage/<month>.jsonl: total, per agent, per page (design §4.13).
export function usageSummary(state, now, config) {
  const d = toDate(now);
  const rows = state.readJsonl(state.monthLogPath("usage", d));
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const byAgent = {};
  const byPage = {};
  let usedUsd = 0;
  let calls = 0;
  let failed = 0;
  for (const r of rows) {
    const cost = Number.isFinite(r.costUsd) ? r.costUsd : 0;
    usedUsd += cost;
    calls += 1;
    if (r.ok === false) failed += 1;
    byAgent[r.agent] = round((byAgent[r.agent] || 0) + cost);
    const page = r.page || "company";
    byPage[page] = round((byPage[page] || 0) + cost);
  }
  return { month: istMonthKey(d), usedUsd: round(usedUsd), limitUsd: config.budget.monthlyUsd, calls, failed, byAgent, byPage };
}

function allowedFormats(config, page) {
  return (page.formats || []).filter((f) => f !== "reel" || config.features.reels === true);
}

// One summary per page (charter "brands"): voice, usable facts, pricing, disclaimers, forbidden, cadence.
export function brandSummaries(config, brands) {
  return (config.pages || []).map((page) => {
    const b = brands[page.handle];
    const fm = (b && b.frontMatter) || {};
    return {
      handle: page.handle,
      name: fm.name || page.displayName,
      languages: page.languages,
      emoji: fm.emoji || null,
      mode: page.mode,
      formats: allowedFormats(config, page),
      cadence: (page.cadence && page.cadence.slots) || [],
      voice: (b && b.voice && b.voice.bullets) || [],
      facts: b ? usableFacts(b).map((f) => ({ id: f.id, fact: f.fact })) : [],
      pricing: ((b && b.pricing) || []).map((p) => ({ sku: p.sku, price: p.price })),
      disclaimers: (b && b.disclaimers) || [],
      forbidden: (b && b.forbidden) || [],
      allowedDomains: (b && b.allowedDomains) || [],
    };
  });
}

// The Analyst report as the task carries it (FEAT-205, P2-07): the JSON block of the latest reports/*.md without
// its Markdown (perPage, experiments and the forCeo items the memo must answer). Accepts analyst.latestReport()'s
// wrapper ({ week, path, report, engine }) or a bare report object ({ week, perPage, forCeo … }); null → null.
export function reportInput(latest) {
  if (!latest || typeof latest !== "object") return null;
  const report = latest.report && typeof latest.report === "object" ? latest.report : latest;
  return {
    week: latest.week || report.week || null,
    path: typeof latest.path === "string" ? latest.path : null,
    generatedAt: latest.engine && typeof latest.engine.generatedAt === "string" ? latest.engine.generatedAt : null,
    perPage: Array.isArray(report.perPage) ? report.perPage : [],
    experiments: Array.isArray(report.experiments) ? report.experiments : [],
    forCeo: Array.isArray(report.forCeo) ? report.forCeo.map(String) : [],
  };
}

// The derived status of an HR proposal from the latest decision record (hr/decisions.jsonl, admin-owned).
export function proposalStatus(decision) {
  if (!decision) return "proposed";
  if (decision.decision === "apply") return "applied";
  if (decision.decision === "dismiss") return "dismissed";
  return String(decision.decision);
}

// The latest HR review as the task carries it (FEAT-205, P2-07): hr.latestReview()'s { month, path, review } plus
// the proposal's status from the owner's decisions log. null → null.
export function hrReviewInput(latest, decision = null) {
  if (!latest || typeof latest !== "object") return null;
  const review = latest.review && typeof latest.review === "object" ? latest.review : {};
  const proposal = review.rosterProposal && typeof review.rosterProposal === "object" ? review.rosterProposal : {};
  return {
    month: latest.month || review.month || null,
    path: typeof latest.path === "string" ? latest.path : null,
    proposalStatus: proposalStatus(decision),
    decidedAt: decision && typeof decision.at === "string" ? decision.at : null,
    review: (Array.isArray(review.review) ? review.review : []).map((r) => ({ agent: r.agent, verdict: r.verdict, proposal: r.proposal })),
    changes: (Array.isArray(proposal.changes) ? proposal.changes : []).map((c) => ({ agent: c.agent, field: c.field, from: c.from, to: c.to, why: c.why })),
    reviewMarkdown: typeof review.reviewMarkdown === "string" ? review.reviewMarkdown : "",
  };
}

// The task JSON (charter "Inputs you receive in the task JSON").
export function buildTask({ config, brands, now, lastReport = null, feedback30d = [], published14d = [], usageMonth = null, flags = [], hrReview = null, hrDecision = null }) {
  const d = toDate(now);
  const report = reportInput(lastReport);
  const review = hrReviewInput(hrReview, hrDecision);
  const notes = [];
  if (!report) notes.push(NO_REPORT_NOTE);
  else notes.push(`Answer every one of the ${report.forCeo.length} item${report.forCeo.length === 1 ? "" : "s"} in lastReport.forCeo in \`answers\`, quoting each item verbatim as its forCeo; the engine renders them under "Answers to the Analyst" — do not repeat them in memoMarkdown.`);
  if (!review) notes.push(NO_HR_REVIEW_NOTE);
  return {
    week: isoWeekId(d),
    today: istDate(d),
    brands: brandSummaries(config, brands),
    lastReport: report,
    hrReview: review,
    feedback: feedback30d.map((r) => ({ at: r.at, kind: r.kind, page: r.page || null, draftId: r.draftId || null, text: r.text, tags: r.tags || [] })),
    published: published14d.map((r) => ({ draftId: r.draftId, page: r.page, format: r.format, publishedAt: r.publishedAt, late: r.late === true })),
    usage: usageMonth,
    flags: [...flags],
    notes,
  };
}

// runCeo({ config, brands, router, state, now, runId, lastReport, hrReview, hrDecision, feedback30d, published14d, usageMonth, flags })
//   → { week, path, rel, memo, markdown, modelCalled, mock, calls, costUsd, note }
//   lastReport: analyst.latestReport(state) (or null); hrReview: hr.latestReview(state) (or null) with hrDecision the
//   latest hr/decisions.jsonl record for that month (or null) — the caller (engine/commands/daily.js) reads them so
//   this module imports no other agent.
// Router errors (BudgetExhaustedError, AgentOutputError, AllProvidersFailedError) propagate and nothing is written.
export async function runCeo({ config, brands, router, state, now, runId, lastReport = null, hrReview = null, hrDecision = null, feedback30d, published14d, usageMonth, flags = [] } = {}) {
  if (!config || !brands || !router || !state) throw new TypeError("ceo: config, brands, router and state are required");
  const d = toDate(now === undefined ? state.now() : now);
  const week = isoWeekId(d);
  const task = buildTask({
    config,
    brands,
    now: d,
    lastReport,
    hrReview,
    hrDecision,
    feedback30d: feedback30d || feedbackSince(state, d, 30),
    published14d: published14d || publishedSince(state, d, 14),
    usageMonth: usageMonth || usageSummary(state, d, config),
    flags: flags instanceof Set ? [...flags] : flags,
  });
  const handles = config.pages.map((p) => p.handle);
  const pages = config.pages.map((p) => ({ handle: p.handle, factIds: new Set(brands[p.handle] ? usableFacts(brands[p.handle]).map((f) => f.id) : []) }));
  // The single mock fixture (tests/fixtures/llm/ceo.ok.json) is pinned to 2026-W42 and to the fixture report
  // 2026-W41, so a MOCK_LLM=1 dry run in any other week would fail the week rule twice and write no memo, and one
  // on a company without a report would fail the answers rule; the mock answers every other rule unchanged. Real
  // providers are always held to the week they were asked for and to the report they were given (an empty
  // `answers` when there is none).
  const report = task.lastReport;
  const weekRule = router.isMock === true ? null : week;
  const forCeoRule = report ? report.forCeo : router.isMock === true ? null : [];
  const res = await router.complete(AGENT, {
    task,
    spec: outputSpec(handles),
    context: { brand: null, page: null, todayIst: d },
    validate: (json) => validateCeoOutput(json, { week: weekRule, pages, forCeo: forCeoRule }),
  });
  const memo = res.json;
  const markdown = renderMemo(memo, { reportWeek: report ? report.week : null });
  const path = memoPath(d);
  const rel = `state/${path}`;
  state.writeText(rel, markdown);
  const id = runId || router.runId;
  const answers = Array.isArray(memo.answers) ? memo.answers.length : 0;
  const answersNote = report ? `${answers} answer${answers === 1 ? "" : "s"} to the Analyst (${report.week})` : "no Analyst report to answer";
  return {
    week,
    path,
    rel,
    memo,
    markdown,
    modelCalled: true,
    mock: res.mock === true,
    calls: res.calls,
    costUsd: res.costUsd,
    runId: id,
    at: nowIst(d),
    note: `${memo.priorities.length} priorities, ${memo.pause.length} paused, ${answersNote}, ${memo.ownerQuestions.length} owner questions → ${path}`,
  };
}
