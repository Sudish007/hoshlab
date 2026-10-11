// HR agent (design.md §3.1 step 3, §4.2 invariants, §5 row "HR"; review N14, P2-06; plan D13/D18; FEAT-204).
//
// Two deterministic halves around one model call, like the Analyst:
//   1. computeAgentStats(): per-agent numbers for the month under review, from that month's usage/<month>.jsonl and
//      runs/<month>.jsonl, the drafts written in the month with their qa.json, published.jsonl and feedback.jsonl —
//      calls, failed calls, cost, average latency, runs, failed runs, failures per provider; for the Writer the QA
//      rejection rate and the rework loops of its drafts; for Strategist / Writer / QA the studio's cost per approved
//      post. Every number is computed, none estimated; an agent that did nothing has zeros.
//   2. runHr(): the task JSON (roster, stats, the month's owner feedback, the enabled providers with their model
//      tables) goes to the model; the engine post-validates the answer — every roster agent reviewed exactly once,
//      every evidence number copied from `stats` (validateHrOutput → the router's single repair call →
//      AgentOutputError), changes only on model | provider | temperature | charterAppend, `from` = the current roster
//      value, provider enabled, model in that provider's table, temperature 0–1, verdicts consistent with the changes,
//      and the roster that results from applying the changes (schema.applyRosterChanges) still satisfies ROSTER_SPEC —
//      qa and publisher present and enabled, so the model can neither remove nor disable them. It then writes
//      hr/<month>-review.md (reviewMarkdown + one fenced JSON block with the output and the engine's provenance,
//      stats included) and hr/proposals/<month>.json (HR_PROPOSAL_SPEC, status proposed). HR never edits roster.json:
//      the owner applies or dismisses the proposal in the admin, which appends hr/decisions.jsonl (admin-owned, D13 /
//      N14); proposal files are never modified afterwards.
// Schedule: the 1st of the month (IST) reviews the previous month; a missing proposal for the previous month is caught
// up on the next daily run once that month has data; `node engine/index.js hr` forces the review (engine/commands/hr.js).
import { existsSync, readdirSync } from "node:fs";
import { AGENT as AGENT_ENUM, HR_PROPOSAL_SPEC, MONTH_KEY, ROSTER_SPEC, applyRosterChanges, validate } from "../lib/schema.js";
import { round6 } from "../lib/budget.js";
import { istDate, istMonthKey, istParts, nowIst, parseIso } from "../lib/time.js";

export const AGENT = "hr";
export const VERDICTS = ["keep", "tune", "swap"];
export const CHANGE_FIELDS = ["model", "provider", "temperature", "charterAppend"];
export const PROTECTED_AGENTS = ["qa", "publisher"]; // never removed or disabled (design §4.2) — re-checked by ROSTER_SPEC
export const STUDIO_AGENTS = ["strategist", "writer", "qa"]; // their combined spend is the cost of an approved post
export const TEMPERATURE_RANGE = { min: 0, max: 1 };
export const REVIEW_JSON_FENCE = "```json";
export const EVIDENCE_RULE = "evidence number not in stats";
export const SKIP_NOT_DUE = "not_due";
export const SKIP_NO_DATA = "no_data";
export const SKIP_DECIDED = "already_decided";
const RATE_DECIMALS = 4;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`hr: invalid date ${String(v)}`);
  return d;
}

// Failed model calls of an agent, per provider (usage lines with ok:false), sorted by provider name.
export const PROVIDER_FAILURE_SPEC = { provider: "str", failed: "int[0..100000]" };

// The stats fields the engine computes before the model is called (charter "stats") — and, with `feedback`, the only
// keys an agent's `evidence` may carry (M7: spelled out, no free object). Every field is optional so an agent whose
// stat does not apply (no drafts written, nothing published) carries fewer keys; the model copies values verbatim.
export const EVIDENCE_SPEC = {
  "calls?": "int[0..100000]",
  "failedCalls?": "int[0..100000]",
  "costUsd?": "num[0..100000]",
  "avgMs?": "int[0..86400000]",
  "runs?": "int[0..100000]",
  "failedRuns?": "int[0..100000]",
  "providerFailures?": [PROVIDER_FAILURE_SPEC],
  "qaRejectionRate?": "num[0..1]",
  "reworkLoops?": "int[0..100000]",
  "costPerApprovedPost?": "num[0..100000]",
  "feedback?": ["str"],
};
export const STAT_FIELDS = Object.keys(EVIDENCE_SPEC).map((k) => k.replace(/\?$/, "")).filter((k) => k !== "feedback");

// The model's JSON output (design §5). `from`/`to` are strings written exactly as the value would appear in
// roster.json ("0.8"): a free 'any' token is not representable in the OpenAI strict dialect (review M7), and
// applyRosterChanges converts numbers when a change is applied.
export const OUTPUT_SPEC = {
  month: MONTH_KEY,
  review: [{ agent: AGENT_ENUM, verdict: `enum[${VERDICTS.join("|")}]`, evidence: EVIDENCE_SPEC, proposal: "str" }],
  rosterProposal: { changes: [{ agent: AGENT_ENUM, field: `enum[${CHANGE_FIELDS.join("|")}]`, from: "str", to: "str", why: "str" }] },
  reviewMarkdown: "str",
};

// ---------------------------------------------------------------------------------------
// Months and paths

// The month a review covers: the IST month before `now` ('2026-11-01T05:31+05:30' → '2026-10').
export function reviewMonth(now = new Date()) {
  const p = istParts(toDate(now));
  const y = p.m === 1 ? p.y - 1 : p.y;
  const m = p.m === 1 ? 12 : p.m - 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function assertMonth(month) {
  if (!MONTH_RE.test(String(month))) throw new TypeError(`hr: month must be YYYY-MM, got ${JSON.stringify(month)}`);
  return String(month);
}

// Paths relative to company/state/ for the reviewed month (not the run date: the 1 November run writes 2026-10).
export function reviewPath(month) {
  return `hr/${assertMonth(month)}-review.md`;
}

export function proposalPath(month) {
  return `hr/proposals/${assertMonth(month)}.json`;
}

// A month has something to review when the engine logged runs or model calls for it.
export function hasData(state, month) {
  const m = assertMonth(month);
  return state.exists(`state/usage/${m}.jsonl`) || state.exists(`state/runs/${m}.jsonl`);
}

// shouldRun(now, state): the 1st of the month IST, or — with a state — the previous month's proposal is missing while
// that month has data (a 1st-of-month run that failed is caught up on the next day). Without a state only the day counts.
export function shouldRun(now = new Date(), state = null) {
  const d = toDate(now);
  if (istParts(d).d === 1) return true;
  if (!state) return false;
  const month = reviewMonth(d);
  return !state.exists(`state/${proposalPath(month)}`) && hasData(state, month);
}

// ---------------------------------------------------------------------------------------
// Decisions (hr/decisions.jsonl is admin-owned; the engine only reads it — design §12, D13)

// latestDecisions(records) → Map month → the latest decision record for that month (by `at`, then file order).
export function latestDecisions(records = []) {
  const out = new Map();
  for (const r of records) {
    if (!r || !r.month) continue;
    const prev = out.get(r.month);
    if (!prev || String(r.at) >= String(prev.at)) out.set(r.month, r);
  }
  return out;
}

export function readDecisions(state) {
  return state.readJsonl("state/hr/decisions.jsonl");
}

// dueStatus({ state, now, forced }) → { run, month, skipped, note }: why the review runs or is skipped this run.
//   not_due          not the 1st and nothing to catch up (the daily step; `forced` — the hr command — skips this rule)
//   already_decided  the owner applied or dismissed that month's proposal already (never reviewed twice after that)
//   no_data          the month has no runs/<month>.jsonl and no usage/<month>.jsonl (nothing to review; no model call)
export function dueStatus({ state, now, forced = false } = {}) {
  if (!state) throw new TypeError("hr: state is required");
  const d = toDate(now === undefined ? state.now() : now);
  const month = reviewMonth(d);
  const path = proposalPath(month);
  const exists = state.exists(`state/${path}`);
  if (!forced && !shouldRun(d, state)) {
    return { run: false, month, skipped: SKIP_NOT_DUE, note: `not the 1st of the month and ${exists ? `${path} exists` : `${month} has no runs or model calls to catch up on`} (the review runs on the 1st or with \`node engine/index.js hr\`)` };
  }
  const decision = latestDecisions(readDecisions(state)).get(month);
  if (decision) return { run: false, month, skipped: SKIP_DECIDED, note: `the owner already ${decision.decision === "apply" ? "applied" : "dismissed"} ${path} on ${decision.at} — not reviewed again` };
  if (!hasData(state, month)) return { run: false, month, skipped: SKIP_NO_DATA, note: `no runs or model calls logged for ${month} — nothing to review (the first review needs one month of runs)` };
  return { run: true, month, skipped: null, note: exists ? `${path} is replaced (no decision recorded for it yet)` : "" };
}

// ---------------------------------------------------------------------------------------
// Engine-computed stats

function monthOf(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : istMonthKey(new Date(t));
}

const roundRate = (n) => Math.round(n * 10 ** RATE_DECIMALS) / 10 ** RATE_DECIMALS;

// computeAgentStats({ month, agents, usageMonth, runs, drafts, qaFiles, published })
//   month      'YYYY-MM' (IST) under review; drafts count when createdAt falls in it, published when publishedAt does
//   agents     roster agent names (default: the eight of the schema)
//   usageMonth usage/<month>.jsonl rows; runs: runs/<month>.jsonl records
//   drafts     draft.json documents (any month); qaFiles: Map draftId → qa.json, or an array of qa.json documents
//   published  published.jsonl records (dry-run records are not approved posts and are left out)
//   → { <agent>: { calls, failedCalls, costUsd, avgMs, runs, failedRuns, providerFailures[, qaRejectionRate, reworkLoops]
//                  [, costPerApprovedPost] } }
//   calls/failedCalls/costUsd/avgMs: the agent's usage lines (avgMs = mean latency per call, 0 without calls);
//   runs/failedRuns: run records in which the agent's row was not skipped (ok:false → failed);
//   providerFailures: usage lines with ok:false grouped by provider;
//   writer: qaRejectionRate = drafts written in the month that failed QA at least once (latest qa.json passed:false, or
//   reworkCount > 0 — a Designer refusal bumps it too, R1-02) / drafts written; reworkLoops = Σ reworkCount of them;
//   strategist/writer/qa: costPerApprovedPost = (their three costs) / posts published in the month.
export function computeAgentStats({ month, agents = ["ceo", "hr", "strategist", "writer", "designer", "qa", "publisher", "analyst"], usageMonth = [], runs = [], drafts = [], qaFiles = new Map(), published = [] } = {}) {
  const m = month === undefined || month === null ? null : assertMonth(month);
  const inMonth = (iso) => m === null || monthOf(iso) === m;
  const qaByDraft = qaFiles instanceof Map ? qaFiles : new Map((qaFiles || []).filter((q) => q && q.draftId).map((q) => [q.draftId, q]));
  const stats = {};
  for (const name of agents) {
    const mine = usageMonth.filter((u) => u && u.agent === name && inMonth(u.at));
    const failed = mine.filter((u) => u.ok === false);
    const byProvider = new Map();
    for (const u of failed) byProvider.set(u.provider, (byProvider.get(u.provider) || 0) + 1);
    const rows = runs.filter((r) => r && inMonth(r.startedAt)).flatMap((r) => (r.agents || []).filter((a) => a.name === name && !a.skipped));
    stats[name] = {
      calls: mine.length,
      failedCalls: failed.length,
      costUsd: round6(mine.reduce((s, u) => s + (Number.isFinite(u.costUsd) ? u.costUsd : 0), 0)),
      avgMs: mine.length ? Math.round(mine.reduce((s, u) => s + (Number.isFinite(u.ms) ? u.ms : 0), 0) / mine.length) : 0,
      runs: rows.length,
      failedRuns: rows.filter((a) => a.ok === false).length,
      providerFailures: [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([provider, n]) => ({ provider, failed: n })),
    };
  }
  const written = drafts.filter((d) => d && inMonth(d.createdAt));
  if (stats.writer && written.length) {
    const failedOnce = written.filter((d) => {
      const qa = qaByDraft.get(d.id);
      return (qa && qa.passed === false) || (d.reworkCount || 0) > 0;
    });
    stats.writer.qaRejectionRate = roundRate(failedOnce.length / written.length);
    stats.writer.reworkLoops = written.reduce((s, d) => s + (d.reworkCount || 0), 0);
  }
  const approved = published.filter((p) => p && p.dryRun !== true && inMonth(p.publishedAt));
  if (approved.length) {
    const studio = STUDIO_AGENTS.filter((a) => stats[a]).reduce((s, a) => s + stats[a].costUsd, 0);
    for (const a of STUDIO_AGENTS) if (stats[a]) stats[a].costPerApprovedPost = round6(studio / approved.length);
  }
  return stats;
}

// Everything the stats are computed from, for one month, read through state.js.
export function readMonthData(state, month) {
  const m = assertMonth(month);
  const usage = state.exists(`state/usage/${m}.jsonl`) ? state.readJsonl(`state/usage/${m}.jsonl`) : [];
  const runs = state.exists(`state/runs/${m}.jsonl`) ? state.readJsonl(`state/runs/${m}.jsonl`) : [];
  const drafts = state.listDrafts().map((id) => state.readDraft(id));
  const qaFiles = new Map();
  for (const d of drafts) {
    const qa = state.readQa(d.id);
    if (qa) qaFiles.set(d.id, qa);
  }
  const published = state.readJsonl("state/published.jsonl");
  const feedback = state.readJsonl("state/feedback.jsonl").filter((r) => r && monthOf(r.at) === m);
  return { month: m, usage, runs, drafts, qaFiles, published, feedback };
}

// ---------------------------------------------------------------------------------------
// The model call

// Enabled providers with their model tables (prices, caps) — the only providers/models a change may name.
export function enabledProviders(config) {
  const out = {};
  for (const [name, p] of Object.entries((config && config.providers) || {})) {
    if (!p || p.enabled !== true) continue;
    out[name] = { models: Object.fromEntries(Object.entries(p.models || {}).map(([id, price]) => [id, { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok, maxOutputTokens: price.maxOutputTokens, acceptsTemperature: price.acceptsTemperature !== false }])) };
  }
  return out;
}

// The task JSON (charter "Inputs you receive in the task JSON").
export function buildTask({ config, roster, month, now, stats, feedback = [] } = {}) {
  const notes = [];
  const idle = (roster.agents || []).filter((a) => !(stats[a.name] && (stats[a.name].calls > 0 || stats[a.name].runs > 0))).map((a) => a.name);
  if (idle.length) notes.push(`No runs this month for ${idle.join(", ")}: verdict keep, evidence {} and proposal "no runs this month".`);
  if (!feedback.length) notes.push("No owner feedback this month.");
  notes.push("Quote only numbers from `stats`, copied exactly (same field name, same value). Propose a provider only from `providers` and a model only from that provider's table; temperature between 0 and 1; `qa` and `publisher` can never be removed or disabled; a `keep` verdict carries no change, a `tune` changes temperature or appends to the charter, a `swap` changes model or provider.");
  return {
    month,
    today: istDate(toDate(now)),
    roster: (roster.agents || []).map((a) => ({ name: a.name, title: a.title || a.name, group: a.group, kind: a.kind, provider: a.provider || null, model: a.model || null, fallback: a.fallback || [], temperature: a.temperature === undefined ? null : a.temperature, schedule: a.schedule, never: a.never, enabled: a.enabled !== false })),
    stats,
    feedback: feedback.map((r) => ({ at: r.at, kind: r.kind, page: r.page || null, draftId: r.draftId || null, text: r.text, tags: r.tags || [] })),
    providers: enabledProviders(config),
    rules: { fields: CHANGE_FIELDS, temperature: TEMPERATURE_RANGE, protectedAgents: PROTECTED_AGENTS },
    notes,
  };
}

// Semantic rules the shape cannot express (design §5 "never: edit roster.json; remove or disable QA/Publisher; propose
// providers that are not enabled"; charter): the month asked for (`month` null skips it — the mock fixture is pinned to
// one month); every roster agent reviewed exactly once; every evidence number is the engine's stat for that agent;
// each change names a roster agent, a field that applies to its kind, the current value as `from`, an enabled provider /
// a model from that provider's table / a temperature 0–1 / a non-empty paragraph as `to`, at most once per agent and
// field; verdicts match the changes (keep: none, tune: temperature or charterAppend, swap: model or provider); and the
// roster after applyRosterChanges() still satisfies ROSTER_SPEC against the config (qa/publisher present and enabled).
export function validateHrOutput(json, { month = null, roster, config, stats = {} } = {}) {
  const errors = [];
  const agents = new Map(((roster && roster.agents) || []).map((a) => [a.name, a]));
  if (month && json.month !== month) errors.push(`$.month: expected ${month}, got ${JSON.stringify(json.month)}`);
  const seen = new Map();
  const verdicts = new Map();
  (json.review || []).forEach((r, i) => {
    if (!agents.has(r.agent)) return void errors.push(`$.review[${i}].agent: ${JSON.stringify(r.agent)} is not in the roster`);
    seen.set(r.agent, (seen.get(r.agent) || 0) + 1);
    verdicts.set(r.agent, r.verdict);
    const mine = stats[r.agent] || {};
    for (const [k, v] of Object.entries(r.evidence || {})) {
      if (k === "feedback") continue;
      if (!(k in mine)) errors.push(`$.review[${i}].evidence.${k}: ${EVIDENCE_RULE} for ${r.agent} (available: ${Object.keys(mine).join(", ") || "none"})`);
      else if (JSON.stringify(v) !== JSON.stringify(mine[k])) errors.push(`$.review[${i}].evidence.${k}: ${EVIDENCE_RULE}: ${JSON.stringify(v)} (the engine computed ${JSON.stringify(mine[k])})`);
    }
  });
  for (const name of agents.keys()) {
    const n = seen.get(name) || 0;
    if (n !== 1) errors.push(`$.review: ${name} reviewed ${n} time${n === 1 ? "" : "s"} (review every agent exactly once)`);
  }
  const changes = (json.rosterProposal && json.rosterProposal.changes) || [];
  const enabled = Object.entries((config && config.providers) || {}).filter(([, p]) => p && p.enabled === true).map(([n]) => n);
  const keys = new Set();
  const fieldsByAgent = new Map();
  changes.forEach((c, i) => {
    const p = `$.rosterProposal.changes[${i}]`;
    const a = agents.get(c.agent);
    if (!a) return void errors.push(`${p}.agent: ${JSON.stringify(c.agent)} is not in the roster`);
    const key = `${c.agent}|${c.field}`;
    if (keys.has(key)) errors.push(`${p}: a second ${c.field} change for ${c.agent}`);
    keys.add(key);
    fieldsByAgent.set(c.agent, [...(fieldsByAgent.get(c.agent) || []), c.field]);
    if (c.field !== "charterAppend" && a.kind !== "llm") errors.push(`${p}: ${c.agent} is deterministic (kind ${a.kind}) and has no ${c.field}; only charterAppend applies`);
    const from = String(c.from);
    const to = String(c.to);
    const expectFrom = (current) => {
      if (from !== current) errors.push(`${p}.from: expected ${JSON.stringify(current)} (the current ${c.agent} ${c.field}), got ${JSON.stringify(c.from)}`);
    };
    switch (c.field) {
      case "temperature": {
        expectFrom(a.temperature === undefined ? "" : String(a.temperature));
        const n = /^\d+(?:\.\d+)?$/.test(to) ? Number(to) : NaN;
        if (!(n >= TEMPERATURE_RANGE.min && n <= TEMPERATURE_RANGE.max)) errors.push(`${p}.to: temperature must be a number between ${TEMPERATURE_RANGE.min} and ${TEMPERATURE_RANGE.max}, got ${JSON.stringify(c.to)}`);
        else if (n === a.temperature) errors.push(`${p}.to: ${to} is already the ${c.agent} temperature`);
        break;
      }
      case "provider": {
        expectFrom(String(a.provider || ""));
        if (!enabled.includes(to)) errors.push(`${p}.to: ${JSON.stringify(c.to)} is not an enabled provider (${enabled.join(", ") || "none"})`);
        break;
      }
      case "model": {
        expectFrom(String(a.model || ""));
        const providerChange = changes.find((x) => x && x.agent === c.agent && x.field === "provider");
        const providerName = providerChange ? String(providerChange.to) : a.provider;
        const table = ((config && config.providers && config.providers[providerName]) || {}).models || {};
        if (!(to in table)) errors.push(`${p}.to: ${JSON.stringify(c.to)} is not in providers.${providerName}.models (${Object.keys(table).join(", ") || "none"})`);
        break;
      }
      case "charterAppend": {
        if (from !== "") errors.push(`${p}.from: must be "" for charterAppend, got ${JSON.stringify(c.from)}`);
        if (!to.trim()) errors.push(`${p}.to: the paragraph to append is empty`);
        break;
      }
      default:
        errors.push(`${p}.field: unknown field ${JSON.stringify(c.field)}`);
    }
  });
  for (const [name, verdict] of verdicts) {
    const fields = fieldsByAgent.get(name) || [];
    const swapLike = fields.some((f) => f === "model" || f === "provider");
    if (verdict === "keep" && fields.length) errors.push(`$.rosterProposal: ${name} has verdict keep but ${fields.length} change${fields.length === 1 ? "" : "s"} (keep means no change)`);
    if (verdict === "swap" && !swapLike) errors.push(`$.rosterProposal: ${name} has verdict swap but no model or provider change`);
    if (verdict === "tune" && (!fields.length || swapLike)) errors.push(`$.rosterProposal: ${name} has verdict tune but ${fields.length ? "a model or provider change (that is a swap)" : "no change"}`);
  }
  if (!errors.length && roster) {
    const r = validate(applyRosterChanges(roster, changes), ROSTER_SPEC, config);
    for (const e of r.errors) errors.push(`$.rosterProposal: ${e}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------------------
// Review files

// reviewMarkdown + the JSON block (validated output + the engine's provenance, stats included) the site reads back.
export function renderReview(json, engine = {}) {
  const body = String(json.reviewMarkdown || "").replace(/\s+$/, "");
  return `${body}\n\n${REVIEW_JSON_FENCE}\n${JSON.stringify({ ...json, engine }, null, 2)}\n\`\`\`\n`;
}

// parseReview(markdown) → { review (the model output), engine (provenance or null), body } or null without a block.
export function parseReview(markdown) {
  const text = String(markdown || "");
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let last = null;
  for (const m of text.matchAll(re)) last = m;
  if (last === null) return null;
  const parsed = JSON.parse(last[1]);
  const { engine = null, ...review } = parsed;
  return { review, engine, body: text.slice(0, last.index).replace(/\s+$/, "") };
}

// listReviews(state) → [{ month, rel, path }] newest month first.
export function listReviews(state) {
  const dir = state.resolve("state/hr");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-review\.md$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ month: name.slice(0, 7), path: `hr/${name}`, rel: `state/hr/${name}` }));
}

// listProposals(state) → [{ month, rel, path }] newest month first.
export function listProposals(state) {
  const dir = state.resolve("state/hr/proposals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
    .sort()
    .reverse()
    .map((name) => ({ month: name.slice(0, 7), path: `hr/proposals/${name}`, rel: `state/hr/proposals/${name}` }));
}

// The newest review → { month, rel, path, markdown, review, engine } or null.
export function latestReview(state) {
  const [first] = listReviews(state);
  if (!first) return null;
  const markdown = state.readText(first.rel);
  const parsed = parseReview(markdown);
  return { ...first, markdown, review: parsed ? parsed.review : null, engine: parsed ? parsed.engine : null };
}

// runHr({ config, roster, router, state, now, runId, month, stats, feedbackMonth, log })
//   → { month, reviewPath, proposalPath, reviewRel, proposalRel, review, proposal, stats, engine, markdown, modelCalled,
//       mock, calls, costUsd, runId, at, note }
// `month` defaults to the month before `now`; `stats` / `feedbackMonth` default to the engine's own reading of that month.
// Router errors (BudgetExhaustedError, AgentOutputError, AllProvidersFailedError) propagate and nothing is written.
export async function runHr({ config, roster, router, state, now, runId, month, stats, feedbackMonth, log = () => {} } = {}) {
  if (!config || !roster || !router || !state) throw new TypeError("hr: config, roster, router and state are required");
  const d = toDate(now === undefined ? state.now() : now);
  const m = month ? assertMonth(month) : reviewMonth(d);
  const data = readMonthData(state, m);
  const names = (roster.agents || []).map((a) => a.name);
  const computed = stats || computeAgentStats({ month: m, agents: names, usageMonth: data.usage, runs: data.runs, drafts: data.drafts, qaFiles: data.qaFiles, published: data.published });
  const feedback = feedbackMonth || data.feedback;
  const task = buildTask({ config, roster, month: m, now: d, stats: computed, feedback });
  // The mock fixture (tests/fixtures/llm/hr.ok.json) is pinned to one month, as the CEO's and the Analyst's are: under
  // MOCK_LLM=1 the month rule is waived; the evidence rule never is (a mock review whose numbers are not THIS company's
  // stats must fail, or a mock_llm dispatch could commit invented evidence).
  const monthRule = router.isMock === true ? null : m;
  const res = await router.complete(AGENT, {
    task,
    spec: OUTPUT_SPEC,
    context: { brand: null, page: null, todayIst: d },
    validate: (json) => validateHrOutput(json, { month: monthRule, roster, config, stats: computed }),
  });
  const output = res.json;
  const at = nowIst(d);
  const id = runId || router.runId;
  const written = data.drafts.filter((x) => monthOf(x.createdAt) === m).length;
  const approved = data.published.filter((p) => p.dryRun !== true && monthOf(p.publishedAt) === m).length;
  const engine = { generatedAt: at, runId: id, month: m, stats: computed, data: { usageRows: data.usage.length, runs: data.runs.length, draftsWritten: written, published: approved, feedback: feedback.length }, mock: res.mock === true };
  const markdown = renderReview(output, engine);
  const reviewRel = `state/${reviewPath(m)}`;
  const proposalRel = `state/${proposalPath(m)}`;
  const proposal = { month: m, at, runId: id, status: "proposed", reviewPath: reviewPath(m), review: output.review, changes: output.rosterProposal.changes };
  state.writeText(reviewRel, markdown);
  state.writeJson(proposalRel, proposal, HR_PROPOSAL_SPEC);
  const n = output.review.length;
  const c = proposal.changes.length;
  const note = `${n} agents reviewed, ${c} change${c === 1 ? "" : "s"} proposed → ${proposalPath(m)}`;
  log(`[hr] ${m}: ${note}`);
  return {
    month: m,
    reviewPath: reviewPath(m),
    proposalPath: proposalPath(m),
    reviewRel,
    proposalRel,
    review: output,
    proposal,
    stats: computed,
    engine,
    markdown,
    modelCalled: true,
    mock: res.mock === true,
    calls: res.calls,
    costUsd: res.costUsd,
    runId: id,
    at,
    note,
  };
}
