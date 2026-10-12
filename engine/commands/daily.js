// daily — the engine-daily run (design.md §3.1, §3.5, §4.12, §4.14, §11; review M5.4, M9, M16; plan D6/D7/D9/D18):
//   node engine/index.js daily [--agents ceo,strategist,…] [--page <handle>] [--dry-run] [--commit] [--now <iso>]
//
//   1. loadCompany + status.json — any CompanyError/SchemaError/SyntaxError is fatal: the ONLY write is
//      runs/<IST month>.jsonl { ok:false, errors[] } and the command exits 1 (P1-24).
//   2. budget: used = Σ usage/<month>.jsonl; used ≥ monthlyUsd with hardStop → flag budget_exhausted and
//      every model-backed step (CEO, Strategist, Writer, QA) is recorded 'skipped: budget_exhausted' — no
//      drafts are created (M5.4); used ≥ warnAtPct → budget_warn.
//   3. CEO when Monday IST or this ISO week's memo is missing (with the latest Analyst report, whose forCeo items it must
//      answer, and the latest HR review + proposal status — FEAT-205);  4. HR on the 1st IST (reviews the previous month →
//      hr/<month>-review.md + hr/proposals/<month>.json; catches up a missing proposal once the month has data; `hr` command
//      forces it — FEAT-204);
//   5. Strategist per page;  6. Writer for slots within leadDays without a live draft + drafts in rework — both with the
//      owner-feedback digest for the page in their context block (engine/lib/feedback.js, P2-08);
//   7. Designer for `written` drafts (skipped: media_branch_missing when .media/.git is absent, M16); a
//      refused draft goes to `rework` like a failed QA check (R1-02); feedback tagged design/variant/palette steers
//      the variant and palette deterministically (plan D23);
//   8. QA for `rendered` drafts;  9. one inline rework loop (Writer → Designer → QA) for the drafts QA
//      or the Designer sent to rework in this run;  9b. Analyst (FEAT-203, design §3.1 step 8) on Sundays IST or
//      when --agents names it: Instagram insights for the posts live ≥ 48 h / ≥ 7 d and not measured yet →
//      metrics/<month>.jsonl (dry-run client under IG_DRY_RUN=1 / --dry-run: zeros labelled dryRun; a real run
//      neither counts nor reports a dryRun record — R2-01), then the weekly report reports/<week>.md (skipped:
//      no_metrics while nothing is measured; status.lastReport);
//      10. finish: status.json (queue/blocked counts, budget, pages, flags, lastRuns ≤ 20 — M9), calendar
//      slots re-linked to the drafts written today, runs/<month>.jsonl record, one scrubbed stdout line per agent.
//   An AllProvidersFailedError ends that agent's work (row ok:false, run still ok — design §11) and flags
//   provider_down:<name> for every provider that was actually attempted (R1-05).
//   --dry-run — or IG_DRY_RUN=1 alone (R2-01, as publish.js has done since R1-03) — copies the company dir (and
//   .media when present) to a temp dir, runs there and prints the path; nothing in the repo changes: the Analyst's
//   dry-run client writes zero insights labelled dryRun into metrics/, which must never land in the real company
//   dir. Commit + push happen only with CI=true or --commit (git.js), never after a dry run.
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CompanyError, loadCompany } from "../../src/lib/company.js";
import { monthHasFreeTierUsage, monthPaidEquivalentUsd, monthUsedUsd } from "../lib/budget.js";
import { readEnv } from "../lib/env.js";
import { commitAndPush, PushConflictError, repoRootFor, shouldCommit, writeGithubOutput } from "../lib/git.js";
import { runId as makeRunId } from "../lib/ids.js";
import { createLogger, scrub, stepLine } from "../lib/log.js";
import { mediaBranchPresent } from "../lib/media.js";
import { CALENDAR_SPEC, RUN_SPEC, STATUS_SPEC, SchemaError } from "../lib/schema.js";
import { createState, latestByKey } from "../lib/state.js";
import { istMonthKey, nowIst, parseIso } from "../lib/time.js";
import { AgentOutputError, AllProvidersFailedError, BudgetExhaustedError, createRouter } from "../llm/router.js";
import { MockFixtureError } from "../llm/mock.js";
import { createRenderer } from "../render/render.js";
import { createClient } from "../ig/client.js";
import { DRY_USER_ID, createDryRunClient, isDryRun } from "../ig/dry-run.js";
import { buildDigest } from "../lib/feedback.js";
import { readMemo, runCeo, shouldRun as ceoShouldRun } from "../agents/ceo.js";
import * as hr from "../agents/hr.js";
import { collectMetrics, latestReport, readMetrics, runAnalyst, shouldRun as analystShouldRun } from "../agents/analyst.js";
import { TERMINAL_SLOT_DRAFT_STATUSES, runStrategist, slotStatusFor } from "../agents/strategist.js";
import { runWriter } from "../agents/writer.js";
import { SKIP_MEDIA_BRANCH_MISSING, runDesigner } from "../agents/designer.js";
import { runQa } from "../agents/qa.js";
import { queueCounts, triggerFrom } from "./publish.js";

export const WORKFLOW = "engine-daily";
export const AGENT_ORDER = ["ceo", "hr", "strategist", "writer", "designer", "qa", "analyst"];
export const LLM_AGENTS = ["ceo", "hr", "strategist", "writer", "qa", "analyst"];
export const SKIP_BUDGET = "skipped: budget_exhausted";
export const FLAG_BUDGET_EXHAUSTED = "budget_exhausted";
export const FLAG_BUDGET_WARN = "budget_warn";
// Flags the daily run recomputes from scratch; every other flag (token_invalid:*, publish_failed:*,
// token_expiring:*) belongs to the publisher / token refresh and is kept unless its cause is gone.
const DAILY_FLAGS = new Set([FLAG_BUDGET_WARN, FLAG_BUDGET_EXHAUSTED, "render_failed", "media_branch_missing"]);
const MS_PER_DAY = 86400000;

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`daily: invalid date ${String(v)}`);
  return d;
}

const ms = (iso) => Date.parse(iso);

// parseAgents('ceo, writer') → Set | null (null = every agent). Unknown names throw.
export function parseAgents(csv) {
  if (csv === undefined || csv === null || csv === true || csv === "") return null;
  const names = String(csv)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) if (!AGENT_ORDER.includes(n)) throw new TypeError(`daily: unknown agent ${JSON.stringify(n)} (--agents takes ${AGENT_ORDER.join(",")})`);
  return new Set(names);
}

function seedStatus(config, state, now) {
  const pages = {};
  for (const p of config.pages) pages[p.handle] = { mode: p.mode, tokenState: "not_configured", tokenExpiresAt: null, lastPublishedAt: null };
  return { updatedAt: nowIst(now), lastRun: null, lastRuns: [], queue: {}, blocked: {}, budget: { month: istMonthKey(now), usedUsd: monthUsedUsd(state, now), limitUsd: config.budget.monthlyUsd, exhausted: false }, pages, flags: [] };
}

// A router error that ends the agent's work for this run (not a programming error).
function isRouterError(err) {
  return err instanceof BudgetExhaustedError || err instanceof AgentOutputError || err instanceof AllProvidersFailedError || err instanceof MockFixtureError;
}

// Live = may still move forward (not terminal, not published).
function isLive(draft) {
  return draft && !TERMINAL_SLOT_DRAFT_STATUSES.includes(draft.status) && draft.status !== "published";
}

// Slots of `page` that need a Writer: planned, with an idea, inside the lead window, no live draft.
export function slotsToWrite(calendar, drafts, page, now, leadDays) {
  const nowMs = toDate(now).getTime();
  const limit = nowMs + leadDays * MS_PER_DAY;
  const live = new Set(drafts.filter((d) => d.page === page.handle && isLive(d)).map((d) => d.slotId));
  const byId = new Map(drafts.map((d) => [d.id, d]));
  return ((calendar && calendar.slots) || []).filter((s) => {
    if (s.page !== page.handle || s.status === "dropped") return false;
    const at = ms(s.at);
    if (!(at >= nowMs && at <= limit)) return false;
    if (live.has(s.slotId)) return false;
    if (s.draftId && isLive(byId.get(s.draftId))) return false;
    return true;
  });
}

// Captions of the page's drafts, newest first (the Writer and QA read the last 10 / 30).
export function recentCaptionsFor(drafts, handle, exclude = null) {
  return drafts
    .filter((d) => d.page === handle && d.id !== exclude && typeof d.caption === "string")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id))
    .map((d) => d.caption);
}

// calendar.json after a run: slots point at the live draft written for them today and carry the
// draft's status (design §4.5 "derived at write time"). Returns the new document or null (unchanged).
export function relinkCalendar(calendar, drafts) {
  if (!calendar || !Array.isArray(calendar.slots)) return null;
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const liveBySlot = new Map();
  for (const d of drafts) {
    if (!d.slotId || !isLive(d)) continue;
    const prev = liveBySlot.get(d.slotId);
    if (!prev || String(d.createdAt) > String(prev.createdAt)) liveBySlot.set(d.slotId, d);
  }
  let changed = false;
  const slots = calendar.slots.map((s) => {
    const next = { ...s };
    if (!next.draftId && liveBySlot.has(next.slotId)) {
      const d = liveBySlot.get(next.slotId);
      next.draftId = d.id;
      if (!next.ideaId && d.ideaId) next.ideaId = d.ideaId;
    }
    const draft = next.draftId ? byId.get(next.draftId) || null : null;
    next.status = slotStatusFor(next, draft);
    if (JSON.stringify(next) !== JSON.stringify(s)) changed = true;
    return next;
  });
  return changed ? { ...calendar, slots } : null;
}

// runDaily({ companyDir, mediaRoot, now, processEnv, fetchImpl, flags: { agents, page, dryRun }, renderer, sleep, stdout, runId, trigger, clientFactory })
//   → { ok, changed, changedFiles, run, status, agents, errors, flags, summary, companyDir }
//   `sleep` reaches the router's retry backoff (tests stub it); the default is the router's own.
//   `clientFactory(page, token, { dryRun, fetchImpl, now, stdout })` → the Analyst's Instagram client for a page (tests
//   inject fakes); the default is createClient / createDryRunClient, as in publish.js.
export async function runDaily({ companyDir, mediaRoot, now, processEnv = process.env, fetchImpl = globalThis.fetch, flags: runFlags = {}, renderer, sleep, stdout = (s) => process.stdout.write(s + "\n"), runId, trigger = triggerFrom(processEnv), workflow = WORKFLOW, clientFactory = null } = {}) {
  if (!companyDir) throw new TypeError("daily: companyDir is required");
  const startedAt = toDate(now);
  const clock = () => startedAt;
  const id = runId || makeRunId(workflow, startedAt);
  const t0 = Date.now();
  const dryRun = runFlags.dryRun === true;
  const forced = runFlags.force === true; // the hr command: review the previous month even when it is not the 1st
  const selected = parseAgents(runFlags.agents);
  const pageFilter = typeof runFlags.page === "string" && runFlags.page ? runFlags.page : null;
  const wants = (agent) => !selected || selected.has(agent);
  const media = mediaRoot || resolve(companyDir, "..", ".media");

  // 1. load — fatal: the only write is the run record (design §11 row 1, P1-24)
  let company;
  let status;
  try {
    company = loadCompany({ companyDir, now: clock, warn: () => {} });
    const { state } = company;
    status = state.exists("state/status.json") ? state.readJson("state/status.json", STATUS_SPEC) : seedStatus(company.config, state, startedAt);
    if (state.exists("state/calendar.json")) state.readJson("state/calendar.json", CALENDAR_SPEC); // validates
    for (const did of state.listDrafts()) state.readDraft(did); // every draft must validate before the run
  } catch (err) {
    if (!(err instanceof CompanyError) && !(err instanceof SchemaError) && !(err instanceof SyntaxError)) throw err;
    const state = createState({ companyDir, now: clock });
    const errors = (err.errors || [err.message]).map((e) => scrub(String(e)));
    const elapsed = Date.now() - t0;
    const runsRel = state.monthLogPath("runs", startedAt);
    const run = { id, workflow, trigger, startedAt: nowIst(startedAt), endedAt: nowIst(new Date(startedAt.getTime() + elapsed)), ok: false, agents: [], changed: [`company/${runsRel}`], errors, budgetUsedUsd: 0 };
    if (dryRun) run.dryRun = true;
    state.appendLog("runs", run, RUN_SPEC, startedAt);
    for (const e of errors) stdout(`[daily] error: ${e}`);
    return { ok: false, fatal: true, changed: false, changedFiles: [runsRel], run, status: null, agents: [], errors, flags: [], summary: `daily: company failed to load (${errors.length} error${errors.length === 1 ? "" : "s"})`, companyDir };
  }
  const { config, roster, brands, charters, state } = company;
  if (pageFilter && !config.pages.some((p) => p.handle === pageFilter)) throw new TypeError(`daily: unknown page ${JSON.stringify(pageFilter)} (--page takes ${config.pages.map((p) => p.handle).join("|")})`);
  const pages = config.pages.filter((p) => !pageFilter || p.handle === pageFilter);
  const d = config.defaults;
  const routerOptions = { config, roster, state, fetchImpl, now: clock, runId: id, charters, processEnv };
  if (typeof sleep === "function") routerOptions.sleep = sleep;
  const router = createRouter(routerOptions);
  // every stdout line passes through scrub() with the provider keys and the page tokens (the router already scrubs
  // its errors; the Analyst's Instagram client scrubs its own)
  const env = readEnv([...Object.values(config.providers).map((p) => p.secret), ...config.pages.map((p) => p.tokenSecret)], processEnv);
  const logger = createLogger({ secrets: env.secrets(), stdout, stderr: stdout });
  const log = (s) => logger.info(s);
  const changedFiles = [];
  const errors = [];
  const flags = new Set();
  const addFlag = (f) => flags.add(f);
  const mediaCommits = [];
  // One line per model-backed agent with the chain the roster resolves to (provider/model, tier, fallbacks), so a run
  // log shows where every call would go — under MOCK_LLM=1 the mock adapter answers instead and the line says so.
  for (const a of roster.agents) {
    if (a.kind !== "llm" || a.enabled === false) continue;
    const [primary, ...fallbacks] = router.resolve(a.name).chain;
    const fb = fallbacks.length ? ` · fallback ${fallbacks.map((c) => c.provider).join(", ")}` : "";
    log(`[router] ${a.name}: provider ${primary.provider} (${primary.tier} tier) model ${primary.model}${fb}${router.isMock ? " · MOCK_LLM=1: the mock adapter answers, no provider is called" : ""}`);
  }

  // 2. budget (M5.4): the month's spend decides whether any model-backed step runs at all
  const limit = config.budget.monthlyUsd;
  let used = monthUsedUsd(state, startedAt);
  let exhausted = config.budget.hardStop === true && used >= limit;
  if (exhausted) addFlag(FLAG_BUDGET_EXHAUSTED);
  if (limit > 0 && (used / limit) * 100 >= config.budget.warnAtPct) addFlag(FLAG_BUDGET_WARN);

  // per-agent records (RUN_AGENT_SPEC), in the design's order
  const records = new Map(AGENT_ORDER.map((name) => [name, { name, ok: true, ms: 0, calls: 0, costUsd: 0, paidEquivalentUsd: 0, notes: [], skipped: null }]));
  const rec = (name) => records.get(name);
  const note = (name, text) => rec(name).notes.push(text);
  const skip = (name, reason, skipped) => {
    const r = rec(name);
    r.notes.push(reason);
    r.skipped = skipped || reason.replace(/^skipped: /, "");
  };
  const fail = (name, text) => {
    const r = rec(name);
    r.ok = false;
    r.notes.push(scrub(text));
  };
  // R1-05: when no provider answered, every provider that was actually called (attempts > 0 — not the ones
  // skipped for a missing secret or `enabled: false`) is flagged provider_down:<name>, so the Home page says
  // so even when the router raised no 401 flag of its own. Stale provider_down flags are dropped each run.
  const providersDown = (err) => {
    if (!(err instanceof AllProvidersFailedError)) return;
    for (const f of err.failures || []) if (f && f.attempts > 0 && config.providers[f.provider]) addFlag(`provider_down:${f.provider}`);
  };
  // Budget crossed mid-run (the router's gate throws before the call): the rest of the model steps skip.
  const budgetHit = (name) => {
    exhausted = true;
    addFlag(FLAG_BUDGET_EXHAUSTED);
    skip(name, SKIP_BUDGET, "budget_exhausted");
  };
  const timed = async (name, fn) => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      rec(name).ms += Date.now() - started;
    }
  };
  const settle = (name) => {
    const t = router.totalsFor(name);
    const r = rec(name);
    r.calls = t.calls;
    r.costUsd = Math.round(t.costUsd * 1e6) / 1e6;
    r.paidEquivalentUsd = Math.round(t.paidEquivalentUsd * 1e6) / 1e6;
  };
  const drafts = () => state.listDrafts().map((did) => state.readDraft(did));
  const ideasById = () => latestByKey(state.readJsonl("state/ideas.jsonl"), "id");
  const readCalendar = () => (state.exists("state/calendar.json") ? state.readJson("state/calendar.json", CALENDAR_SPEC) : null);
  // Owner feedback (admin-owned, read once per run) and the latest Analyst report feed the CEO, the Strategist's
  // and the Writer's context blocks (engine/lib/feedback.js digest, P2-08) and the Designer's preferences (D23).
  const feedbackRows = state.readJsonl("state/feedback.jsonl");
  const reportAtStart = latestReport(state);
  const digestFor = (handle) => buildDigest({ feedback: feedbackRows, page: handle, lastReport: reportAtStart ? reportAtStart.report : null, now: startedAt });

  // 3. CEO — Monday IST or this week's memo missing; company-wide, so a --page filter skips it. Inputs beyond the
  //    state it reads itself (P2-07): the latest Analyst report (every forCeo item must be answered) and the latest
  //    HR review with its proposal's status from hr/decisions.jsonl.
  if (!wants("ceo")) skip("ceo", "skipped: not selected (--agents)", "not_selected");
  else if (pageFilter && !(selected && selected.has("ceo"))) skip("ceo", "skipped: --page filter (company-wide agent)", "page_filter");
  else if (!ceoShouldRun(startedAt, state)) skip("ceo", `skipped: not Monday and ${readMemo(state, startedAt).rel} exists`, "not_due");
  else if (exhausted) skip("ceo", SKIP_BUDGET, "budget_exhausted");
  else {
    await timed("ceo", async () => {
      try {
        const hrReview = hr.latestReview(state);
        const hrDecision = hrReview ? hr.latestDecisions(hr.readDecisions(state)).get(hrReview.month) || null : null;
        const r = await runCeo({ config, brands, router, state, now: startedAt, runId: id, lastReport: reportAtStart, hrReview, hrDecision, flags: [...status.flags, ...flags] });
        changedFiles.push(r.rel);
        note("ceo", r.note);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) return budgetHit("ceo");
        if (!isRouterError(err)) throw err;
        fail("ceo", `${err.name}: ${err.message}`);
        providersDown(err);
      }
    });
    settle("ceo");
  }

  // 4. HR — the 1st of the month IST reviews the previous month (design §3.1 step 3, P2-06, FEAT-204); a missing proposal
  //    for that month is caught up once it has data; `node engine/index.js hr` forces it (flags.force). Company-wide, so a
  //    --page filter skips it unless --agents names it. Skips: not_due | already_decided | no_data (hr.dueStatus).
  if (!wants("hr")) skip("hr", "skipped: not selected (--agents)", "not_selected");
  else if (pageFilter && !(selected && selected.has("hr"))) skip("hr", "skipped: --page filter (company-wide agent)", "page_filter");
  else {
    const due = hr.dueStatus({ state, now: startedAt, forced });
    if (!due.run) skip("hr", `skipped: ${due.skipped} — ${due.note}`, due.skipped);
    else if (exhausted) skip("hr", SKIP_BUDGET, "budget_exhausted");
    else {
      await timed("hr", async () => {
        try {
          const r = await hr.runHr({ config, roster, router, state, now: startedAt, runId: id, log });
          changedFiles.push(r.reviewRel, r.proposalRel);
          note("hr", `${r.note}${due.note ? ` (${due.note})` : ""}`);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) return budgetHit("hr");
          if (!isRouterError(err)) throw err;
          fail("hr", `${err.name}: ${err.message}`);
          providersDown(err);
        }
      });
      settle("hr");
    }
  }

  // 5. Strategist per page
  if (!wants("strategist")) skip("strategist", "skipped: not selected (--agents)", "not_selected");
  else if (exhausted) skip("strategist", SKIP_BUDGET, "budget_exhausted");
  else {
    const memoDoc = readMemo(state, startedAt);
    const memo = memoDoc ? memoDoc.memo : null;
    let stop = false;
    for (const page of pages) {
      if (stop) break;
      await timed("strategist", async () => {
        try {
          const r = await runStrategist({ page, brand: brands[page.handle], memo, state, router, config, now: startedAt, runId: id, feedbackDigest: digestFor(page.handle) });
          changedFiles.push(r.calendarRel, "state/ideas.jsonl");
          note("strategist", `${page.handle}: ${r.note}`);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            budgetHit("strategist");
            stop = true;
            return;
          }
          if (!isRouterError(err)) throw err;
          fail("strategist", `${page.handle}: ${err.name}: ${err.message}`);
          providersDown(err);
          if (err instanceof AllProvidersFailedError) stop = true;
        }
      });
    }
    settle("strategist");
  }

  // 6. Writer — slots inside the lead window without a live draft, plus drafts in rework
  async function writerPass(targets, label) {
    const all = drafts();
    const ideas = ideasById();
    const cal = readCalendar();
    let written = 0;
    let reworked = 0;
    let invalid = 0;
    let stop = false;
    for (const t of targets) {
      if (stop) break;
      const page = t.page;
      const brand = brands[page.handle];
      let slot = t.slot;
      let existing = t.draft || null;
      if (existing) {
        slot = ((cal && cal.slots) || []).find((s) => s.slotId === existing.slotId) || { slotId: existing.slotId, page: page.handle, at: existing.slotAt, format: existing.format, status: existing.status, ideaId: existing.ideaId };
        if ((existing.reworkCount || 0) > d.maxReworkLoops) {
          // cannot happen through QA (it blocks at the cap) — kept so the loop bound holds whatever wrote the file
          changedFiles.push(state.writeDraft({ ...existing, status: "blocked", updatedAt: nowIst(startedAt) }));
          note("writer", `${existing.id}: blocked (reworkCount ${existing.reworkCount} > ${d.maxReworkLoops})`);
          continue;
        }
      }
      const idea = ideas.get(slot.ideaId);
      if (!idea) {
        note("writer", `${existing ? existing.id : slot.slotId}: idea ${slot.ideaId || "(none)"} missing, skipped`);
        continue;
      }
      await timed("writer", async () => {
        try {
          const r = await runWriter({ slot, idea, brand, page, config, state, router, draft: existing, recentCaptions: recentCaptionsFor(all, page.handle, existing ? existing.id : null), now: startedAt, runId: id, feedbackDigest: digestFor(page.handle) });
          if (r.ok) {
            changedFiles.push(`state/drafts/${r.draft.id}/draft.json`);
            if (r.created) written++;
            else reworked++;
            all.push(r.draft);
          } else {
            invalid++;
            if (r.draft) changedFiles.push(`state/drafts/${r.draft.id}/draft.json`);
            fail("writer", `${existing ? existing.id : slot.slotId}: invalid_output after one repair call (${r.error.provider}/${r.error.model})`);
          }
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            budgetHit("writer");
            stop = true;
            return;
          }
          if (!isRouterError(err)) throw err;
          fail("writer", `${existing ? existing.id : slot.slotId}: ${err.name}: ${err.message}`);
          providersDown(err);
          if (err instanceof AllProvidersFailedError) stop = true;
        }
      });
    }
    const parts = [`${written} written`, `${reworked} reworked`];
    if (invalid) parts.push(`${invalid} invalid_output`);
    note("writer", `${label}${parts.join(", ")}`);
    return { written, reworked, invalid };
  }
  const writerTargets = (reworkIds = null) => {
    const all = drafts();
    const cal = readCalendar();
    const out = [];
    for (const page of pages) {
      if (!reworkIds) for (const slot of slotsToWrite(cal, all, page, startedAt, d.leadDays)) out.push({ page, slot });
      for (const dr of all) if (dr.page === page.handle && dr.status === "rework" && (!reworkIds || reworkIds.has(dr.id))) out.push({ page, draft: dr });
    }
    return out;
  };
  if (!wants("writer")) skip("writer", "skipped: not selected (--agents)", "not_selected");
  else if (exhausted) skip("writer", SKIP_BUDGET, "budget_exhausted");
  else await writerPass(writerTargets(), "");
  settle("writer");

  // 7. Designer — every `written` draft; skipped cleanly without the media worktree (M16). A refused draft
  //    is in `rework` afterwards (R1-02) and joins the inline rework loop below like a QA failure.
  const mediaPresent = mediaBranchPresent(media);
  let ownRenderer = null;
  const theRenderer = () => renderer || (ownRenderer = ownRenderer || createRenderer());
  const designerReworked = [];
  async function designerPass(only = null, label = "") {
    if (!mediaPresent) {
      addFlag(SKIP_MEDIA_BRANCH_MISSING);
      skip("designer", `skipped: ${SKIP_MEDIA_BRANCH_MISSING} (${join(media, ".git")} absent — run scripts/init-media-branch.ps1; not configured yet)`, SKIP_MEDIA_BRANCH_MISSING);
      return null;
    }
    const queue = drafts().filter((x) => x.status === "written" && pages.some((p) => p.handle === x.page) && (!only || only.has(x.id)));
    const r = await timed("designer", () => runDesigner({ drafts: queue, brands, config, state, mediaRoot: media, renderer: theRenderer(), now: startedAt, runId: id, log, feedback: feedbackRows }));
    changedFiles.push(...r.changed);
    for (const f of r.flags) addFlag(f);
    for (const x of r.results) {
      if (x.status === "rendered") mediaCommits.push({ draftId: x.id, files: x.files });
      if (x.status === "rework" && !only) designerReworked.push(x.id);
    }
    if (!r.ok) fail("designer", `${label}${r.note}`);
    else note("designer", `${label}${r.note}`);
    return r;
  }
  if (!wants("designer")) skip("designer", "skipped: not selected (--agents)", "not_selected");
  else await designerPass();

  // 8. QA — every `rendered` draft (needs the media bytes, so it waits for the worktree too)
  async function qaPass(only = null, label = "") {
    if (!mediaPresent) {
      skip("qa", `skipped: ${SKIP_MEDIA_BRANCH_MISSING} (rendered files cannot be read)`, SKIP_MEDIA_BRANCH_MISSING);
      return { reworked: [] };
    }
    const all = drafts();
    const queue = all.filter((x) => x.status === "rendered" && pages.some((p) => p.handle === x.page) && (!only || only.has(x.id)));
    const counts = { queued: 0, rework: 0, blocked: 0 };
    const reworked = [];
    let stop = false;
    for (const draft of queue) {
      if (stop) break;
      await timed("qa", async () => {
        try {
          const r = await runQa({ draft, brand: brands[draft.page], config, router, state, recentCaptions: recentCaptionsFor(all, draft.page, draft.id), mediaRoot: media, runId: id, now: startedAt });
          changedFiles.push(`state/drafts/${draft.id}/draft.json`, `state/drafts/${draft.id}/qa.json`);
          counts[r.status] = (counts[r.status] || 0) + 1;
          if (r.status === "rework") reworked.push(draft.id);
          log(`[qa] ${draft.id} ${r.status}${r.reasons.length ? ` — ${r.reasons.slice(0, 2).join("; ")}` : ""}`);
        } catch (err) {
          if (err instanceof BudgetExhaustedError) {
            budgetHit("qa");
            stop = true;
            return;
          }
          if (!isRouterError(err)) throw err;
          fail("qa", `${draft.id}: ${err.name}: ${err.message}`);
          providersDown(err);
          if (err instanceof AllProvidersFailedError) stop = true;
        }
      });
    }
    note("qa", `${label}${counts.queued} queued, ${counts.rework} rework, ${counts.blocked} blocked`);
    return { reworked };
  }
  let qaResult = { reworked: [] };
  if (!wants("qa")) skip("qa", "skipped: not selected (--agents)", "not_selected");
  else if (exhausted) skip("qa", SKIP_BUDGET, "budget_exhausted");
  else qaResult = await qaPass();
  settle("qa");

  // 9. one inline rework loop so a first-pass QA failure — or a Designer refusal (R1-02) — does not cost a
  //    day (design §3.1 step 7)
  const reworkIds = new Set([...designerReworked, ...qaResult.reworked]);
  if (reworkIds.size && !exhausted && wants("writer") && wants("designer") && wants("qa")) {
    const w = await writerPass(writerTargets(reworkIds), "rework loop: ");
    settle("writer");
    if (w.reworked > 0) {
      await designerPass(reworkIds, "rework loop: ");
      await qaPass(reworkIds, "rework loop: ");
      settle("qa");
    }
  }
  if (ownRenderer) await ownRenderer.close();

  // 9b. Analyst — Sundays IST, or whenever --agents names it (design §3.1 step 8, P2-04, FEAT-203): insights for the
  //     posts live ≥ 48 h / ≥ 7 d and not measured yet → metrics/<month>.jsonl, then this week's report. Company-wide:
  //     a --page filter skips it unless --agents names it. The insights fetch costs no model budget, so it runs even
  //     when the month is spent; only the report (the model call) is skipped then.
  const analystSelected = Boolean(selected && selected.has("analyst"));
  if (!wants("analyst")) skip("analyst", "skipped: not selected (--agents)", "not_selected");
  else if (pageFilter && !analystSelected) skip("analyst", "skipped: --page filter (company-wide agent)", "page_filter");
  else if (!analystSelected && !analystShouldRun(startedAt)) skip("analyst", "skipped: not Sunday (the Analyst runs on Sundays or with --agents analyst)", "not_due");
  else {
    await timed("analyst", async () => {
      const igDry = isDryRun(processEnv, { dryRun });
      const clients = new Map();
      const clientFor = (handle) => {
        if (clients.has(handle)) return clients.get(handle);
        const page = config.pages.find((p) => p.handle === handle);
        let client = null;
        if (page) {
          const token = env.present[page.tokenSecret] && env.shape(page.tokenSecret).ok ? env.get(page.tokenSecret) : undefined;
          const effPage = igDry ? { ...page, igUserId: page.igUserId || DRY_USER_ID } : page;
          if (clientFactory) client = clientFactory(effPage, token, { dryRun: igDry, fetchImpl, now: clock, stdout: log });
          else if (igDry) client = createDryRunClient({ igUserId: effPage.igUserId, stdout: log, now: clock });
          else if (token) client = createClient({ config, token, igUserId: page.igUserId || "me", fetchImpl, now: clock });
        }
        clients.set(handle, client);
        return client;
      };
      const collected = await collectMetrics({ published: state.readJsonl("state/published.jsonl"), existing: readMetrics(state, startedAt), clientFor, now: startedAt, runId: id, state, log });
      changedFiles.push(...collected.changed);
      if (collected.errors.length) fail("analyst", `${collected.note} — ${collected.errors.slice(0, 3).join("; ")}`);
      else note("analyst", collected.note);
      if (exhausted) return skip("analyst", SKIP_BUDGET, "budget_exhausted");
      try {
        const memoDoc = readMemo(state, startedAt);
        // a real run reports on real posts and real insights only; a dry run may read its own dryRun records (R2-01)
        const r = await runAnalyst({ config, router, state, now: startedAt, runId: id, memo: memoDoc ? memoDoc.memo : null, log, includeDryRun: igDry });
        if (r.skipped) return skip("analyst", `skipped: ${r.skipped} — ${r.note}`, r.skipped);
        changedFiles.push(r.rel);
        status.lastReport = { week: r.week, path: r.path, at: r.at };
        note("analyst", r.note);
      } catch (err) {
        if (err instanceof BudgetExhaustedError) return budgetHit("analyst");
        if (!isRouterError(err)) throw err;
        fail("analyst", `${err.name}: ${err.message}`);
        providersDown(err);
      }
    });
    settle("analyst");
  }
  for (const f of router.flags) addFlag(f);

  // 10. finish — calendar re-link, status.json, run record
  try {
    const finalDrafts = drafts();
    const relinked = relinkCalendar(readCalendar(), finalDrafts);
    if (relinked) changedFiles.push(state.writeJson("state/calendar.json", relinked, CALENDAR_SPEC));
    // the engine-owned draft index the admin reads instead of listing state/drafts/ (R2-05); untouched when nothing moved
    const indexRel = state.writeDraftIndex(startedAt);
    if (indexRel) changedFiles.push(indexRel);

    used = monthUsedUsd(state, startedAt);
    const hasFreeTierUsage = monthHasFreeTierUsage(state, startedAt);
    const paidEquivalent = monthPaidEquivalentUsd(state, startedAt);
    exhausted = config.budget.hardStop === true && used >= limit;
    if (exhausted) addFlag(FLAG_BUDGET_EXHAUSTED);
    const warn = limit > 0 && (used / limit) * 100 >= config.budget.warnAtPct;
    if (warn) addFlag(FLAG_BUDGET_WARN);
    const kept = (status.flags || []).filter((f) => {
      if (DAILY_FLAGS.has(f) || f.startsWith("provider_down:")) return false;
      if (f.startsWith("token_invalid:")) return (status.pages[f.slice("token_invalid:".length)] || {}).tokenState === "invalid";
      if (f.startsWith("publish_failed:")) return finalDrafts.some((x) => x.id === f.slice("publish_failed:".length) && x.status === "failed");
      return true;
    });
    const finalFlags = [...new Set([...kept, ...flags])];
    const counts = queueCounts(finalDrafts, config);
    for (const p of config.pages) {
      const ps = status.pages[p.handle] || { mode: p.mode, tokenState: "not_configured", tokenExpiresAt: null, lastPublishedAt: null };
      ps.mode = p.mode;
      status.pages[p.handle] = ps;
    }
    const agents = AGENT_ORDER.map((name) => {
      const r = rec(name);
      const out = { name, ok: r.ok, ms: r.ms, calls: r.calls, costUsd: r.costUsd };
      if (router.totalsFor(name).freeTierCalls > 0) out.paidEquivalentUsd = r.paidEquivalentUsd;
      if (r.notes.length) out.note = r.notes.join(" | ");
      if (r.skipped) out.skipped = r.skipped;
      return out;
    });
    const elapsed = Date.now() - t0;
    const endedAt = new Date(startedAt.getTime() + elapsed);
    // run.ok is run-level (design §11: load failure, push conflict); a step that failed is recorded on its
    // own agents[] row (ok:false + note) and the run still completes — the publisher uses the same reading.
    const run = {
      id,
      workflow,
      trigger,
      startedAt: nowIst(startedAt),
      endedAt: nowIst(endedAt),
      ok: errors.length === 0,
      agents,
      changed: [],
      errors,
      budgetUsedUsd: used,
    };
    if (hasFreeTierUsage) run.budgetPaidEquivalentUsd = paidEquivalent;
    if (dryRun) run.dryRun = true;
    const unique = (arr) => [...new Set(arr)];
    run.changed = unique([...changedFiles, "state/status.json", state.monthLogPath("runs", startedAt)]).map((rel) => `company/${rel}`);
    status.updatedAt = nowIst(endedAt);
    status.lastRun = { id, workflow, ok: run.ok, at: run.endedAt };
    status.lastRuns = [run, ...(status.lastRuns || [])].slice(0, 20);
    status.queue = counts.queue;
    status.blocked = counts.blocked;
    status.budget = { month: istMonthKey(startedAt), usedUsd: used, limitUsd: limit, exhausted, warn };
    if (hasFreeTierUsage) status.budget.paidEquivalentUsd = paidEquivalent;
    status.flags = finalFlags;
    changedFiles.push(state.writeJson("state/status.json", status, STATUS_SPEC));
    changedFiles.push(state.appendLog("runs", run, RUN_SPEC, startedAt));
    for (const a of agents) log(stepLine(a.name, a.ok, a.ms, a.calls, a.costUsd, a.note));
    const failed = agents.filter((a) => !a.ok).map((a) => a.name);
    const summary = `[daily] ${run.ok ? "ok" : "FAIL"} ${unique(changedFiles).length} files changed, budget $${used.toFixed(2)} of $${limit}${finalFlags.length ? `, flags ${finalFlags.join(" ")}` : ""}${failed.length ? `, ${failed.length} agent step${failed.length === 1 ? "" : "s"} failed (${failed.join(", ")})` : ""}`;
    log(summary);
    return { ok: run.ok, changed: true, changedFiles: unique(changedFiles), run, status, agents, errors, flags: finalFlags, summary, mediaCommits, companyDir, config };
  } catch (err) {
    if (ownRenderer) await ownRenderer.close().catch(() => {});
    throw err;
  }
}

// CLI entry: ctx from engine/index.js → exit code (0 ok, 1 failed, 2 usage).
export async function run({ root, companyDir, processEnv = process.env, fetchImpl = globalThis.fetch, stdout = console.log, stderr = console.error, flags = {} } = {}) {
  const dryRunFlag = flags["dry-run"] === true;
  // R2-01: IG_DRY_RUN=1 without --dry-run is a dry run too — temp copy, no commit — exactly as publish.js treats it.
  const dryRun = isDryRun(processEnv, flags);
  let now;
  if (flags.now !== undefined) {
    if (!dryRun) {
      stderr("daily: --now <iso> is accepted only with --dry-run or IG_DRY_RUN=1 (a real run is never back-dated)");
      return 2;
    }
    try {
      now = parseIso(String(flags.now));
    } catch (err) {
      stderr(`daily: ${err.message}`);
      return 2;
    }
  }
  try {
    parseAgents(flags.agents);
  } catch (err) {
    stderr(err.message);
    return 2;
  }
  if (!existsSync(companyDir)) {
    stderr(`daily: company dir ${companyDir} does not exist`);
    return 1;
  }
  const repoRoot = root || resolve(companyDir, "..");
  const mediaDefault = processEnv.MEDIA_DIR ? resolve(repoRoot, processEnv.MEDIA_DIR) : join(repoRoot, ".media");
  let dir = companyDir;
  let mediaRoot = mediaDefault;
  if (dryRun) {
    const tmp = mkdtempSync(join(tmpdir(), "hoshlab-daily-dry-run-"));
    dir = join(tmp, "company");
    cpSync(companyDir, dir, { recursive: true });
    if (mediaBranchPresent(mediaDefault)) {
      mediaRoot = join(tmp, ".media");
      cpSync(mediaDefault, mediaRoot, { recursive: true });
    } else mediaRoot = join(tmp, ".media"); // absent → the Designer records media_branch_missing, as it would in the repo
    stdout(`daily: ${dryRunFlag ? "--dry-run" : "IG_DRY_RUN=1"} works on a temp copy ${dir} (the repo's company dir is untouched)`);
  }
  let result;
  try {
    result = await runDaily({ companyDir: dir, mediaRoot, now, processEnv, fetchImpl, flags: { agents: flags.agents, page: typeof flags.page === "string" ? flags.page : null, dryRun, force: flags.force === true }, stdout });
  } catch (err) {
    stderr(scrub(`daily: ${err && err.message ? err.message : String(err)}`));
    return 1;
  }
  if (dryRun) {
    stdout(`daily: dry run complete — state written under ${dir}; nothing committed`);
    return result.ok ? 0 : 1;
  }
  if (result.ok && shouldCommit(processEnv, flags)) {
    try {
      // commit into the repository that holds the company dir (the repo root in CI; a temp clone in tests)
      const gitRoot = repoRootFor(companyDir) || repoRoot;
      const message = `state: ${WORKFLOW} ${result.run.id}`;
      const paths = result.changedFiles.map((rel) => relative(gitRoot, join(companyDir, rel)));
      const g = await commitAndPush({ repoRoot: gitRoot, config: result.config, changedFiles: paths, message, mediaRoot, mediaCommits: result.mediaCommits || [], stdout });
      writeGithubOutput("changed", g.committed || g.mediaCommitted > 0, processEnv);
    } catch (err) {
      if (err instanceof PushConflictError) {
        stderr(scrub(`daily: ${err.message} — errors: push_conflict (the state stays in this checkout; the next run regenerates it)`));
        writeGithubOutput("changed", false, processEnv);
        return 1;
      }
      stderr(scrub(`daily: git step failed — ${err.message}`));
      return 1;
    }
  } else if (result.ok) {
    stdout(`daily: ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"} changed under ${companyDir}, not committed (pass --commit)`);
    writeGithubOutput("changed", false, processEnv);
  }
  return result.ok ? 0 : 1;
}
