// publish — the hourly Publisher run (design.md §3.2, §9, §11; review M5; plan D7/D9):
//   node engine/index.js publish [--page <handle>] [--dry-run] [--now <iso>]
//
//   1. loadCompany; apply edits/<id>.json over drafts when edit.baseRevision === draft.revision (stale
//      edits are ignored and listed as staleEdits[]); apply the latest overrides.jsonl slotAt per draft.
//   2. Live drafts whose latest approvals.jsonl decision is a reject → status 'rejected' (M5, R1-06); the
//      others whose effective slot passed more than expireAfterHours ago → status 'expired' (M5.1).
//   3. Per page: a page paused by a code 190 (tokenState 'invalid') whose secret and igUserId are present is
//      probed once with content_publishing_limit (R1-01) — an answer means the replaced token works, so the
//      page resumes in the same run; a 190 keeps the pause; then queued drafts sorted by slotAt,
//      publisher.decide() for each, at most ONE publish attempt per page per run (minGapHours, spreads load).
//   4. status.json pages[h].lastPublishedAt / tokenState / mode, flags, queue counts, lastRuns (M9);
//      run record appended to runs/<IST month>.jsonl with the publisher block (decisions, staleEdits,
//      expired, rejected, pages).
//   Returns { ok, changed, changedFiles, summary, run } — `changed` is true only when published.jsonl or a
//   draft changed, or when the public token status changed (a page's tokenState or status.flags differ from
//   what was loaded — R2-01: the probe above resuming a page with nothing queued must deploy too, otherwise
//   Home keeps "Token for @x is invalid" until the next engine-daily deploy). That is what triggers the Pages
//   deploy (git commit/push wiring is FEAT-108); an idle run still reports changed: false.
//
// Tokens: process.env[page.tokenSecret] is read into a variable and handed to createClient only; a missing
// or malformed token makes the page 'page_not_configured'. IG_DRY_RUN=1 or --dry-run selects the dry-run
// client (logs the exact call sequence, sends nothing; pages without an igUserId use 'dry-user') AND makes
// the CLI run on a temp copy of the company dir, so nothing in the repo changes (R1-03: the env var alone
// used to write dry- ids into the real queue).
// --now <iso> fixes the clock and is accepted only together with a dry-run client.
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CompanyError, loadCompany } from "../../src/lib/company.js";
import { monthUsedUsd } from "../lib/budget.js";
import { readEnv } from "../lib/env.js";
import { commitAndPush, PushConflictError, repoRootFor, shouldCommit, writeGithubOutput } from "../lib/git.js";
import { runId as makeRunId } from "../lib/ids.js";
import { createLogger, scrub, stepLine } from "../lib/log.js";
import { EDIT_SPEC, RUN_SPEC, STATUS_SPEC, SchemaError } from "../lib/schema.js";
import { createState, latestByKey } from "../lib/state.js";
import { hoursBetween, istMonthKey, nowIst, parseIso } from "../lib/time.js";
import { IgError, createClient } from "../ig/client.js";
import { DRY_USER_ID, createDryRunClient, isDryRun } from "../ig/dry-run.js";
import { AGENT, completePermalinks, decide, latestApprovals, publishDraft } from "../agents/publisher.js";

export const WORKFLOW = "publisher-hourly";
export const LIVE_STATUSES = ["written", "rendered", "queued", "rework"];
export const PAGE_OUTCOMES = ["published", "failed", "retry_next_hour", "token_invalid", "page_not_configured", "quota", "quota_check_failed", "idle", "filtered"];

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`publish: invalid date ${String(v)}`);
  return d;
}

// GitHub Actions sets GITHUB_EVENT_NAME; anything else is a local run.
export function triggerFrom(processEnv = {}) {
  const ev = processEnv.GITHUB_EVENT_NAME;
  if (ev === "schedule") return "schedule";
  if (ev === "workflow_dispatch" || ev === "workflow_call") return "dispatch";
  return "local";
}

// Latest overrides.jsonl slotAt per draftId (by `at`, then file order) → Map<draftId, slotAt>.
export function latestOverrides(records) {
  const sorted = [...(records || [])].filter((r) => r && r.draftId && r.slotAt).sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  const out = new Map();
  for (const [id, r] of latestByKey(sorted, "draftId")) out.set(id, r.slotAt);
  return out;
}

// applyEdit(draft, edit) → the draft with the owner's caption/hashtags/altText(s) merged (design §4.8).
export function applyEdit(draft, edit) {
  const next = { ...draft, caption: edit.caption, hashtags: edit.hashtags, altText: edit.altText };
  if (Array.isArray(edit.altTexts)) next.altTexts = edit.altTexts;
  return next;
}

// queueCounts(drafts, config) → { queue: { handle: n }, blocked: { handle: n (only > 0) } } (status.json §4.12).
export function queueCounts(drafts, config) {
  const queue = {};
  const blocked = {};
  for (const page of config.pages) queue[page.handle] = 0;
  for (const d of drafts) {
    if (d.status === "queued") queue[d.page] = (queue[d.page] || 0) + 1;
    if (d.status === "blocked") blocked[d.page] = (blocked[d.page] || 0) + 1;
  }
  return { queue, blocked };
}

// The first status.json, before any run wrote one (also used by refresh-tokens.js when it runs first).
export function seedStatus(config, state, now) {
  const pages = {};
  for (const p of config.pages) pages[p.handle] = { mode: p.mode, tokenState: "not_configured", tokenExpiresAt: null, lastPublishedAt: null };
  return { updatedAt: nowIst(now), lastRun: null, lastRuns: [], queue: {}, blocked: {}, budget: { month: istMonthKey(now), usedUsd: monthUsedUsd(state, now), limitUsd: config.budget.monthlyUsd, exhausted: false }, pages, flags: [] };
}

function addFlag(flags, flag) {
  if (!flags.includes(flag)) flags.push(flag);
}

// runPublish({ companyDir, now, processEnv, fetchImpl, dryRun, page, clientFactory, stdout, runId, trigger })
//   clientFactory(page, token, ctx) → client (tests inject fakes); default: createClient / createDryRunClient.
export async function runPublish({ companyDir, now, processEnv = process.env, fetchImpl = globalThis.fetch, dryRun = false, page: pageFilter = null, clientFactory = null, stdout = (s) => process.stdout.write(s + "\n"), runId, trigger = triggerFrom(processEnv), workflow = WORKFLOW } = {}) {
  const startedAt = toDate(now);
  const clock = () => startedAt;
  const id = runId || makeRunId(workflow, startedAt);
  const t0 = Date.now();

  // 1. load — an invalid company or state file is fatal for the run: the only write is the run record
  //    with errors[] (design §11 row 1)
  let company;
  let status;
  let approvals;
  let overrides;
  let published;
  let drafts;
  try {
    company = loadCompany({ companyDir, now: clock, warn: () => {} });
    const { config, state } = company;
    status = state.exists("state/status.json") ? state.readJson("state/status.json", STATUS_SPEC) : seedStatus(config, state, startedAt);
    approvals = latestApprovals(state.readJsonl("state/approvals.jsonl"));
    overrides = latestOverrides(state.readJsonl("state/overrides.jsonl"));
    published = state.readJsonl("state/published.jsonl");
    drafts = state.listDrafts().map((did) => state.readDraft(did));
  } catch (err) {
    if (!(err instanceof CompanyError) && !(err instanceof SchemaError) && !(err instanceof SyntaxError)) throw err;
    const state = createState({ companyDir, now: clock });
    const errors = (err.errors || [err.message]).map((e) => scrub(String(e)));
    const ms = Date.now() - t0;
    const runsRel = state.monthLogPath("runs", startedAt);
    const run = { id, workflow, trigger, startedAt: nowIst(startedAt), endedAt: nowIst(new Date(startedAt.getTime() + ms)), ok: false, agents: [{ name: AGENT, ok: false, ms, calls: 0, costUsd: 0, note: "company failed to load" }], changed: [`company/${runsRel}`], errors, budgetUsedUsd: 0 };
    if (dryRun) run.dryRun = true;
    const rel = state.appendLog("runs", run, RUN_SPEC, startedAt);
    for (const e of errors) stdout(`[publisher] error: ${e}`);
    return { ok: false, changed: false, changedFiles: [rel], summary: `publisher: company failed to load (${errors.length} error${errors.length === 1 ? "" : "s"})`, run, errors };
  }
  const { config, state } = company;
  const d = config.defaults;
  const secretNames = config.pages.map((p) => p.tokenSecret);
  const env = readEnv(secretNames, processEnv);
  const logger = createLogger({ secrets: env.secrets(), stdout, stderr: stdout });
  const log = (s) => logger.info(s);
  const changedFiles = [];
  const errors = [];
  const flags = [...(status.flags || [])];
  // R2-01: what Home prints about tokens, as loaded — pages[h].tokenState per configured page and the flags.
  // `flags` and status.pages[h] are mutated in place below, so the same snapshot taken in step 4 tells
  // whether a status-only change (probe resumed a page, token first configured, flag raised or dropped)
  // happened without any draft or published.jsonl change.
  const statusSnapshot = () => JSON.stringify({ flags: [...flags].sort(), tokens: config.pages.map((p) => [p.handle, status.pages[p.handle] ? status.pages[p.handle].tokenState : null]) });
  const statusBefore = statusSnapshot();

  // effective slot time (owner moves) + owner edits (by baseRevision)
  const staleEdits = [];
  const effective = new Map();
  for (const draft of drafts) {
    let eff = { ...draft };
    if (overrides.has(draft.id)) eff.slotAt = overrides.get(draft.id);
    const editRel = `state/edits/${draft.id}.json`;
    if (state.exists(editRel)) {
      try {
        const edit = state.readJson(editRel, EDIT_SPEC);
        if (edit.baseRevision === draft.revision) eff = applyEdit(eff, edit);
        else {
          staleEdits.push(draft.id);
          log(`[publisher] ${draft.id}: edit for revision ${edit.baseRevision} ignored (draft is revision ${draft.revision})`);
        }
      } catch (err) {
        staleEdits.push(draft.id);
        log(`[publisher] ${draft.id}: edit file ignored — ${err.message}`);
      }
    }
    effective.set(draft.id, eff);
  }

  // 2. terminal stamps (M5): a live draft whose latest approval is a reject becomes 'rejected' (R1-06 — the
  //    owner's decision was already final for decide(), the admin and the Strategist; now the draft file and
  //    status.json.queue say so too); otherwise a live draft whose effective slot passed more than
  //    expireAfterHours ago becomes 'expired' (M5.1).
  const expired = [];
  const rejected = [];
  for (const draft of drafts) {
    const eff = effective.get(draft.id);
    if (!LIVE_STATUSES.includes(draft.status)) continue;
    const approval = approvals.get(draft.id);
    if (approval && approval.decision === "reject") {
      const next = { ...draft, status: "rejected", updatedAt: nowIst(startedAt) };
      changedFiles.push(state.writeDraft(next));
      draft.status = "rejected";
      eff.status = "rejected";
      rejected.push(draft.id);
      log(`[publisher] ${draft.id} rejected (owner's reject record for revision ${approval.revision}, ${approval.at})`);
      continue;
    }
    if (hoursBetween(eff.slotAt, startedAt) > d.expireAfterHours) {
      const next = { ...draft, status: "expired", updatedAt: nowIst(startedAt) };
      changedFiles.push(state.writeDraft(next));
      draft.status = "expired";
      eff.status = "expired";
      expired.push(draft.id);
      log(`[publisher] ${draft.id} expired (slot ${eff.slotAt}, more than ${d.expireAfterHours} h ago)`);
    }
  }

  // 3. per page
  const decisions = [];
  const pages = {};
  let publishedCount = 0;
  let failedCount = 0;
  let waiting = 0;
  let publishedChanged = false;
  let draftsChanged = expired.length > 0 || rejected.length > 0;
  const WAITING = new Set(["awaiting_approval", "not_due", "approval_stale", "min_gap"]);
  for (const page of config.pages) {
    const h = page.handle;
    const pageState = status.pages[h] || { mode: page.mode, tokenState: "not_configured", tokenExpiresAt: null, lastPublishedAt: null };
    pageState.mode = page.mode;
    status.pages[h] = pageState;
    if (pageFilter && h !== pageFilter) {
      pages[h] = { outcome: "filtered" };
      continue;
    }
    // token presence is derived every run: secret + igUserId present → configured ('unknown' until a call
    // succeeds, then 'ok'); either missing → 'not_configured'; a stored 'invalid' is cleared by the probe
    // below once a call with the (replaced) secret is accepted — or locally by setup-secrets.ps1.
    const token = env.present[page.tokenSecret] ? env.get(page.tokenSecret) : undefined;
    const tokenOk = token !== undefined && env.shape(page.tokenSecret).ok;
    const configured = dryRun || (tokenOk && Boolean(page.igUserId));
    if (!dryRun) {
      if (!configured) pageState.tokenState = "not_configured";
      else if (pageState.tokenState === "not_configured") pageState.tokenState = "unknown";
    }
    const effPage = dryRun ? { ...page, igUserId: page.igUserId || DRY_USER_ID } : page;
    const effPageState = dryRun && pageState.tokenState !== "invalid" ? { ...pageState, tokenState: "ok" } : pageState;
    const recent = published.filter((p) => p && p.page === h);
    if (pageState.lastPublishedAt) recent.push({ publishedAt: pageState.lastPublishedAt });
    const candidates = drafts
      .filter((x) => x.page === h && x.status === "queued")
      .map((x) => effective.get(x.id))
      .sort((a, b) => toDate(a.slotAt) - toDate(b.slotAt) || a.id.localeCompare(b.id));
    let outcome = { outcome: "idle" };
    let client = null;
    const makeClient = () => {
      if (clientFactory) return clientFactory(effPage, token, { dryRun, fetchImpl, now: clock, stdout });
      return dryRun ? createDryRunClient({ igUserId: effPage.igUserId, stdout, now: clock }) : createClient({ config, token, igUserId: effPage.igUserId, fetchImpl, now: clock });
    };
    // 'expiring' is set by refresh-tokens (FEAT-202) from the stored expiry, which only that job knows: an accepted
    // call confirms the token works today, so 'invalid'/'unknown' become 'ok' but 'expiring' is left for the
    // weekly refresh to clear (status.flags token_expiring:<page> is cleared there too).
    const tokenWorked = () => {
      if (!dryRun && pageState.tokenState !== "expiring") pageState.tokenState = "ok";
    };
    const tokenDied = () => {
      pageState.tokenState = "invalid";
      addFlag(flags, `token_invalid:${h}`);
    };
    // R1-01: a page paused by a code 190 is probed once per run while a well-formed secret is present. The
    // content_publishing_limit call carries no draft: an answer means Instagram accepts the (replaced) token,
    // so the pause ends here and the normal loop below runs in the same hour; a 190 keeps the pause with no
    // draft attempt; any other error leaves the stored state untouched (the next hour probes again).
    // decide() stays pure — it reads pageState.tokenState after the probe. One GET per hour per paused page.
    if (!dryRun && configured && pageState.tokenState === "invalid") {
      client = client || makeClient();
      try {
        await client.publishingLimit();
        tokenWorked();
        const i = flags.indexOf(`token_invalid:${h}`);
        if (i >= 0) flags.splice(i, 1);
        log(`[publisher] ${h}: the token is accepted again (content_publishing_limit answered) — page resumed`);
      } catch (err) {
        if (!(err instanceof IgError)) throw err;
        log(err.tokenInvalid ? `[publisher] ${h}: token probe failed with code ${err.code} — page stays paused (run setup-secrets with a new token)` : `[publisher] ${h}: token probe failed — ${err.message}; page stays paused until a later probe answers`);
      }
    }
    for (const eff of candidates) {
      const decision = decide(eff, approvals, effPage, startedAt, config, effPageState, recent);
      const entry = { draftId: eff.id, page: h, publish: decision.publish, reason: decision.reason };
      if (!decision.publish) {
        decisions.push(entry);
        if (WAITING.has(decision.reason)) waiting++;
        if (decision.reason === "token_invalid" || decision.reason === "page_not_configured") outcome = { outcome: decision.reason };
        continue;
      }
      client = client || makeClient();
      const original = drafts.find((x) => x.id === eff.id);
      const approval = approvals.get(eff.id) || null;
      const r = await publishDraft({ draft: eff, page: effPage, client, state, config, now: startedAt, runId: id, mode: page.mode, approval, fetchImpl, log });
      if (r.quota) tokenWorked(); // content_publishing_limit answered → the token is accepted
      if (r.ok) {
        publishedCount++;
        publishedChanged = true;
        draftsChanged = true;
        changedFiles.push("state/published.jsonl", `state/drafts/${eff.id}/draft.json`);
        pageState.lastPublishedAt = r.record.publishedAt;
        outcome = { outcome: "published", draftId: eff.id, quotaUsage: r.quota.quotaUsage, quotaTotal: r.quota.quotaTotal };
        decisions.push({ ...entry, igMediaId: r.record.igMediaId });
        Object.assign(original, r.draft);
      } else if (r.skipped) {
        // page-level skip: no attempt on the draft, it is tried again next hour
        waiting++;
        if (r.tokenInvalid) {
          tokenDied();
          outcome = { outcome: "token_invalid" };
        } else {
          outcome = { outcome: r.skipped };
          if (r.quota && Number.isInteger(r.quota.quotaTotal)) Object.assign(outcome, { quotaUsage: r.quota.quotaUsage, quotaTotal: r.quota.quotaTotal });
        }
        const skipped = { ...entry, publish: false, reason: outcome.outcome };
        if (Number.isInteger(r.code)) skipped.code = r.code;
        decisions.push(skipped);
      } else {
        // attempt recorded on the draft
        draftsChanged = true;
        changedFiles.push(`state/drafts/${eff.id}/draft.json`);
        Object.assign(original, r.draft);
        for (const f of r.flags || []) addFlag(flags, f);
        if (r.tokenInvalid) {
          tokenDied();
          outcome = { outcome: "token_invalid", draftId: eff.id };
        } else if (r.failed) {
          failedCount++;
          outcome = { outcome: "failed", draftId: eff.id };
        } else {
          waiting++;
          outcome = { outcome: "retry_next_hour", draftId: eff.id };
        }
        const failedEntry = { ...entry, publish: false, reason: `attempt_failed:${r.stage}`, stage: r.stage };
        if (Number.isInteger(r.code)) failedEntry.code = r.code;
        decisions.push(failedEntry);
      }
      break; // one publish attempt per page per run
    }
    pages[h] = outcome;
    // permalinks left null by an earlier run (design §11 "IG publish ok, permalink fetch fails")
    if (!dryRun && configured && pageState.tokenState !== "invalid" && recent.some((p) => p && p.igMediaId && !p.permalink)) {
      client = client || makeClient();
      try {
        const n = await completePermalinks({ state, client, page: effPage, log });
        if (n > 0) {
          publishedChanged = true;
          changedFiles.push("state/published.jsonl");
        }
      } catch (err) {
        errors.push(scrub(`permalink completion for ${h}: ${err.message}`, env.secrets()));
      }
    }
    const line = outcome.draftId ? `${outcome.outcome} ${outcome.draftId}` : outcome.outcome;
    const why = decisions.filter((x) => x.page === h && !x.publish && !x.reason.startsWith("attempt_failed")).map((x) => `${x.draftId} ${x.reason}`);
    log(`[publisher] ${h}: ${line}${why.length ? ` (${why.join("; ")})` : candidates.length === 0 ? " (no queued drafts)" : ""}`);
  }

  // 4. status.json + run record (the clock may be fixed by --now, so endedAt = startedAt + elapsed)
  const counts = queueCounts(drafts, config);
  status.queue = counts.queue;
  status.blocked = counts.blocked;
  status.flags = flags;
  const statusChanged = statusSnapshot() !== statusBefore;
  const ms = Date.now() - t0;
  const endedAt = new Date(startedAt.getTime() + ms);
  const note = `${publishedCount} published, ${waiting} waiting, ${failedCount} failed, ${expired.length} expired${rejected.length ? `, ${rejected.length} rejected` : ""}${staleEdits.length ? `, ${staleEdits.length} stale edit${staleEdits.length === 1 ? "" : "s"}` : ""}`;
  const run = {
    id,
    workflow,
    trigger,
    startedAt: nowIst(startedAt),
    endedAt: nowIst(endedAt),
    ok: errors.length === 0,
    agents: [{ name: AGENT, ok: errors.length === 0, ms, calls: 0, costUsd: 0, note }],
    changed: [],
    errors,
    budgetUsedUsd: monthUsedUsd(state, startedAt),
    publisher: { decisions, staleEdits, expired, rejected, pages },
  };
  if (dryRun) run.dryRun = true;
  // the engine-owned draft index the admin reads instead of listing state/drafts/ (R2-05); untouched on an idle hour
  const indexRel = state.writeDraftIndex(startedAt);
  if (indexRel) changedFiles.push(indexRel);
  const unique = (arr) => [...new Set(arr)];
  run.changed = unique([...changedFiles, "state/status.json", state.monthLogPath("runs", startedAt)]).map((rel) => `company/${rel}`);
  status.updatedAt = nowIst(endedAt);
  status.lastRun = { id, workflow, ok: run.ok, at: run.endedAt };
  status.lastRuns = [run, ...(status.lastRuns || [])].slice(0, 20);
  changedFiles.push(state.writeJson("state/status.json", status, STATUS_SPEC));
  changedFiles.push(state.appendLog("runs", run, RUN_SPEC, startedAt));
  const summary = stepLine(AGENT, run.ok, ms, 0, 0, note);
  log(summary);
  return { ok: run.ok, changed: publishedChanged || draftsChanged || statusChanged, statusChanged, changedFiles: unique(changedFiles), summary, run, decisions, staleEdits, expired, rejected, pages, status, errors, config };
}

// CLI entry: ctx from engine/index.js → exit code (0 ok, 1 failed, 2 usage).
// Commit + push (design §3.2 step 5) happen only with CI=true or --commit; `changed` reaches
// $GITHUB_OUTPUT so the deploy job runs only when published.jsonl, a draft or the public token status
// (tokenState / flags, R2-01) changed.
// A dry run — --dry-run or IG_DRY_RUN=1 (R1-03) — always works on a temp copy: the dry-run client writes
// dry- ids and status 'published' into drafts, which must never land in the repo's queue.
export async function run({ root, companyDir, processEnv = process.env, fetchImpl = globalThis.fetch, stdout = console.log, stderr = console.error, flags = {} } = {}) {
  const dryRunFlag = flags["dry-run"] === true;
  const dryRun = isDryRun(processEnv, flags);
  let now;
  if (flags.now !== undefined) {
    if (!dryRun) {
      stderr("publish: --now <iso> is accepted only with --dry-run or IG_DRY_RUN=1");
      return 2;
    }
    try {
      now = parseIso(String(flags.now));
    } catch (err) {
      stderr(`publish: ${err.message}`);
      return 2;
    }
  }
  const page = typeof flags.page === "string" ? flags.page : null;
  let dir = companyDir;
  if (dryRun) {
    if (!existsSync(companyDir)) {
      stderr(`publish: company dir ${companyDir} does not exist`);
      return 1;
    }
    dir = join(mkdtempSync(join(tmpdir(), "hoshlab-publish-dry-run-")), "company");
    cpSync(companyDir, dir, { recursive: true });
    stdout(`publish: ${dryRunFlag ? "--dry-run" : "IG_DRY_RUN=1"} works on a temp copy ${dir} (the repo's company dir is untouched)`);
  }
  let result;
  try {
    result = await runPublish({ companyDir: dir, now, processEnv, fetchImpl, dryRun, page, stdout });
  } catch (err) {
    stderr(scrub(`publish: ${err && err.message ? err.message : String(err)}`));
    return 1;
  }
  if (dryRun) {
    stdout(`publish: dry run complete — state written under ${dir}; nothing committed`);
    return result.ok ? 0 : 1;
  }
  if (result.ok && shouldCommit(processEnv, flags)) {
    // commit into the repository that holds the company dir (the repo root in CI; a temp clone in tests)
    const repoRoot = repoRootFor(companyDir) || root || resolve(companyDir, "..");
    try {
      const paths = result.changedFiles.map((rel) => relative(repoRoot, join(companyDir, rel)));
      await commitAndPush({ repoRoot, config: result.config, changedFiles: paths, message: `state: ${WORKFLOW} ${result.run.id}`, stdout });
      writeGithubOutput("changed", result.changed, processEnv);
    } catch (err) {
      if (err instanceof PushConflictError) {
        stderr(scrub(`publish: ${err.message} — errors: push_conflict (the state stays in this checkout; the next run regenerates it)`));
        writeGithubOutput("changed", false, processEnv);
        return 1;
      }
      stderr(scrub(`publish: git step failed — ${err.message}`));
      return 1;
    }
  } else if (result.ok) {
    stdout(`publish: ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"} changed under ${companyDir}, not committed (pass --commit)`);
    writeGithubOutput("changed", false, processEnv);
  }
  return result.ok ? 0 : 1;
}
