// refresh-tokens — the weekly Instagram token job (design.md §3.4, §4.12 flags, §11 row "Token refresh";
// P2-09; FEAT-202). Runs from .github/workflows/token-refresh.yml (config.schedule.tokenRefreshCron, Mondays 02:13 UTC = 07:43 IST):
//   node engine/index.js refresh-tokens [--dry-run] [--commit] [--page <handle>] [--now <iso>, dry-run only]
//   IG_DRY_RUN=1 in the environment is a dry run too (R2-06): temp copy, no refresh call, no gh, nothing committed.
//
//   For every page whose secret (process.env[page.tokenSecret]) is present and well-formed:
//     1. tokens.json entry ({ username, expiresAt|null, refreshedAt, state } per handle) — none yet means the
//        expiry is 'not known yet' (the token came from the owner's Meta panel, which prints no expiry).
//     2. expiresAt null or < REFRESH_WHEN_DAYS_LEFT (20) days away → GET /refresh_access_token (the token must be
//        ≥ 24 h old and unexpired; Meta answers { access_token, expires_in }). The new value stays in memory:
//        it is piped to `gh secret set <tokenSecret> --repo <owner>/<name>` on STDIN (never an argument, never a
//        log line) with GH_TOKEN = process.env.HOSHLAB_SECRETS_PAT (a fine-grained PAT, this repository only,
//        Secrets: Read and write). Without the PAT nothing is refreshed — a refreshed token that cannot be
//        stored would be lost — and the page keeps its stored expiry.
//     3. tokens.json records { username, expiresAt: now + expires_in, refreshedAt } (no secret material);
//        status.json pages[h].tokenExpiresAt mirrors it; < EXPIRING_DAYS (7) days left → tokenState 'expiring'
//        + flag token_expiring:<page> (Home + admin banner); a refreshed token clears both. A refresh failure
//        keeps the old expiry (flag when < 7 days; retried next week); a code 190 → tokenState 'invalid' +
//        token_invalid:<page> (the hourly publisher re-probes and clears it once a replaced secret works, R1-01).
//   Writes (through state.js, validated): state/tokens.json, state/status.json, runs/<month>.jsonl. --dry-run
//   makes no network call and writes nothing; it prints what would happen. `changed` (→ $GITHUB_OUTPUT) is true
//   when an expiry, a token state or a flag changed, so the deploy job rebuilds the Home banner only then.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CompanyError, loadCompany } from "../../src/lib/company.js";
import { monthHasFreeTierUsage, monthPaidEquivalentUsd, monthUsedUsd } from "../lib/budget.js";
import { readEnv } from "../lib/env.js";
import { commitAndPush, PushConflictError, repoRootFor, shouldCommit, writeGithubOutput } from "../lib/git.js";
import { runId as makeRunId } from "../lib/ids.js";
import { createLogger, scrub, stepLine } from "../lib/log.js";
import { RUN_SPEC, STATUS_SPEC, SchemaError, TOKENS_SPEC } from "../lib/schema.js";
import { createState } from "../lib/state.js";
import { nowIst, parseIso } from "../lib/time.js";
import { IgError, createClient } from "../ig/client.js";
import { isDryRun } from "../ig/dry-run.js";
import { AGENT } from "../agents/publisher.js";
import { seedStatus, triggerFrom } from "./publish.js";

export const WORKFLOW = "token-refresh";
export const PAT_NAME = "HOSHLAB_SECRETS_PAT";
export const PAT_FALLBACK = "GH_TOKEN";
export const REFRESH_WHEN_DAYS_LEFT = 20;
export const EXPIRING_DAYS = 7;
export const EXPIRY_UNKNOWN = "expiry not known yet";
export const OUTCOMES = ["refreshed", "fresh", "would_refresh", "pat_not_configured", "refresh_failed", "store_failed", "token_invalid", "not_configured", "filtered"];
const MS_PER_DAY = 86400000;

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`refresh-tokens: invalid date ${String(v)}`);
  return d;
}

// Real-valued days from `now` to `expiresAt`; null when the expiry is not known.
export function daysLeft(expiresAt, now) {
  if (!expiresAt) return null;
  return (toDate(expiresAt).getTime() - toDate(now).getTime()) / MS_PER_DAY;
}

// Whole days for a sentence ('expires in 5 days'): floor of the real value; null stays null.
export function wholeDaysLeft(expiresAt, now) {
  const d = daysLeft(expiresAt, now);
  return d === null ? null : Math.floor(d);
}

export function needsRefresh(expiresAt, now, threshold = REFRESH_WHEN_DAYS_LEFT) {
  const d = daysLeft(expiresAt, now);
  return d === null || d < threshold;
}

export function isExpiring(expiresAt, now, threshold = EXPIRING_DAYS) {
  const d = daysLeft(expiresAt, now);
  return d !== null && d < threshold;
}

// Default process spawner: no shell, captured output. Tests inject a fake that records { cmd, args, input, env }.
export function spawnGh(cmd, args, { input, env } = {}) {
  const r = spawnSync(cmd, args, { input, env, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: "", stderr: `${r.error.name}: ${r.error.message}` };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// storeSecret({ name, value, repo, pat, processEnv, run }) → { ok, detail }
//   `gh secret set <name> --repo <owner>/<repo>` with the VALUE ON STDIN (never --body, never argv) and
//   GH_TOKEN = the PAT in the child's environment only. `detail` is scrubbed of both secrets.
export function storeSecret({ name, value, repo, pat, processEnv = process.env, run = spawnGh } = {}) {
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(String(name))) throw new TypeError(`refresh-tokens: bad secret name ${JSON.stringify(name)}`);
  if (typeof value !== "string" || !value) throw new TypeError("refresh-tokens: a secret value is required");
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new TypeError(`refresh-tokens: repo must be owner/name, got ${JSON.stringify(repo)}`);
  if (typeof pat !== "string" || !pat) throw new TypeError("refresh-tokens: the PAT is required to store a secret");
  const args = ["secret", "set", name, "--repo", repo];
  const r = run("gh", args, { input: value, env: { ...processEnv, GH_TOKEN: pat } });
  const detail = scrub(String((r.stderr || r.stdout || "")).trim(), [value, pat]);
  if (r.status !== 0) return { ok: false, detail: `gh ${args.join(" ")} failed (exit ${r.status === null ? "spawn" : r.status})${detail ? `: ${detail}` : ""}` };
  return { ok: true, detail: `gh ${args.join(" ")} ok` };
}

function emptyTokens(now) {
  return { updatedAt: nowIst(now), pages: {} };
}

function addFlag(flags, flag) {
  if (!flags.includes(flag)) flags.push(flag);
}
function dropFlag(flags, flag) {
  const i = flags.indexOf(flag);
  if (i >= 0) flags.splice(i, 1);
}

// runRefreshTokens({ companyDir, now, processEnv, fetchImpl, dryRun, page, clientFactory, ghRun, stdout, runId, trigger })
//   clientFactory(page, token, ctx) → client (tests inject fakes); ghRun(cmd, args, { input, env }) → { status, stdout, stderr }.
//   → { ok, changed, changedFiles, run, status, tokens, pages: { handle: { outcome, daysLeft, expiresAt } }, summary, errors, config }
export async function runRefreshTokens({ companyDir, now, processEnv = process.env, fetchImpl = globalThis.fetch, dryRun = false, page: pageFilter = null, clientFactory = null, ghRun = spawnGh, stdout = (s) => process.stdout.write(s + "\n"), runId, trigger = triggerFrom(processEnv), workflow = WORKFLOW } = {}) {
  const startedAt = toDate(now);
  const clock = () => startedAt;
  const id = runId || makeRunId(workflow, startedAt);
  const t0 = Date.now();

  // 1. load — fatal: the only write is the run record (design §11 row 1)
  let company;
  let status;
  let tokens;
  try {
    company = loadCompany({ companyDir, now: clock, warn: () => {} });
    const { config, state } = company;
    status = state.exists("state/status.json") ? state.readJson("state/status.json", STATUS_SPEC) : seedStatus(config, state, startedAt);
    tokens = state.exists("state/tokens.json") ? state.readJson("state/tokens.json", TOKENS_SPEC) : emptyTokens(startedAt);
  } catch (err) {
    if (!(err instanceof CompanyError) && !(err instanceof SchemaError) && !(err instanceof SyntaxError)) throw err;
    const state = createState({ companyDir, now: clock });
    const errors = (err.errors || [err.message]).map((e) => scrub(String(e)));
    const ms = Date.now() - t0;
    const run = { id, workflow, trigger, startedAt: nowIst(startedAt), endedAt: nowIst(new Date(startedAt.getTime() + ms)), ok: false, agents: [{ name: AGENT, ok: false, ms, calls: 0, costUsd: 0, note: "company failed to load" }], changed: [`company/${state.monthLogPath("runs", startedAt)}`], errors, budgetUsedUsd: 0 };
    if (dryRun) run.dryRun = true;
    const rel = dryRun ? null : state.appendLog("runs", run, RUN_SPEC, startedAt);
    for (const e of errors) stdout(`[refresh-tokens] error: ${e}`);
    return { ok: false, changed: false, changedFiles: rel ? [rel] : [], summary: `refresh-tokens: company failed to load (${errors.length} error${errors.length === 1 ? "" : "s"})`, run, errors };
  }
  const { config, state } = company;
  const secretNames = [...config.pages.map((p) => p.tokenSecret), PAT_NAME, PAT_FALLBACK];
  const env = readEnv(secretNames, processEnv);
  const logger = createLogger({ secrets: env.secrets(), stdout, stderr: stdout });
  const log = (s) => logger.info(s);
  const errors = [];
  const flags = [...(status.flags || [])];
  const repo = `${config.repo.owner}/${config.repo.name}`;
  // the PAT: HOSHLAB_SECRETS_PAT, or GH_TOKEN when the workflow mapped the same secret there for gh itself
  const patName = env.present[PAT_NAME] ? PAT_NAME : env.present[PAT_FALLBACK] ? PAT_FALLBACK : PAT_NAME;
  const pat = env.present[patName] ? env.get(patName) : undefined;
  const patOk = pat !== undefined && env.shape(patName).ok;
  const before = JSON.stringify({ tokens: tokens.pages, pages: Object.fromEntries(Object.entries(status.pages || {}).map(([h, p]) => [h, [p.tokenState, p.tokenExpiresAt || null]])), flags: [...flags].sort() });
  const pages = {};
  let refreshed = 0;
  let unknown = 0;
  let expiring = 0;

  for (const page of config.pages) {
    const h = page.handle;
    const pageState = status.pages[h] || { mode: page.mode, tokenState: "not_configured", tokenExpiresAt: null, lastPublishedAt: null };
    pageState.mode = page.mode;
    status.pages[h] = pageState;
    const entry = { ...(tokens.pages[h] || {}) };
    if (pageFilter && h !== pageFilter) {
      pages[h] = { outcome: "filtered", daysLeft: wholeDaysLeft(entry.expiresAt, startedAt), expiresAt: entry.expiresAt || null };
      continue;
    }
    const tokenPresent = env.present[page.tokenSecret] && env.shape(page.tokenSecret).ok;
    const token = tokenPresent ? env.get(page.tokenSecret) : undefined;
    // same derivation as the publisher: a well-formed secret makes a 'not_configured' page 'unknown' until a call is accepted
    if (tokenPresent && pageState.tokenState === "not_configured") pageState.tokenState = "unknown";
    let outcome;
    if (!tokenPresent) {
      outcome = "not_configured";
      entry.state = "not_configured";
      pageState.tokenState = "not_configured";
      log(`[refresh-tokens] ${h}: ${page.tokenSecret} not configured yet — nothing to refresh`);
    } else if (pageState.tokenState === "invalid") {
      outcome = "token_invalid";
      entry.state = "invalid";
      log(`[refresh-tokens] ${h}: token is marked invalid (code 190 earlier) — run setup-secrets with a new token; the hourly publisher re-probes it`);
    } else if (!needsRefresh(entry.expiresAt, startedAt)) {
      outcome = "fresh";
      log(`[refresh-tokens] ${h}: ${wholeDaysLeft(entry.expiresAt, startedAt)} days left (expires ${entry.expiresAt}) — no refresh before ${REFRESH_WHEN_DAYS_LEFT} days`);
    } else if (dryRun) {
      outcome = "would_refresh";
      log(`[refresh-tokens] ${h}: would refresh (${entry.expiresAt ? `${wholeDaysLeft(entry.expiresAt, startedAt)} days left` : EXPIRY_UNKNOWN}) — dry run, no call made`);
    } else if (!patOk) {
      outcome = "pat_not_configured";
      log(`[refresh-tokens] ${h}: ${PAT_NAME} not configured yet — refresh skipped (a refreshed token could not be stored); ${entry.expiresAt ? `${wholeDaysLeft(entry.expiresAt, startedAt)} days left` : EXPIRY_UNKNOWN}`);
    } else {
      // refresh_access_token with the stored token (igUserId is not part of this call; "me" stands in when the page has none yet)
      const client = clientFactory ? clientFactory(page, token, { fetchImpl, now: clock, stdout }) : createClient({ config, token, igUserId: page.igUserId || "me", fetchImpl, now: clock });
      try {
        if (!entry.username) {
          try {
            const me = await client.getMe();
            if (me.username) entry.username = me.username;
          } catch (err) {
            if (!(err instanceof IgError)) throw err;
            if (err.tokenInvalid) throw err;
            log(`[refresh-tokens] ${h}: GET /me failed — ${err.message} (username not recorded)`);
          }
        }
        const r = await client.refreshToken();
        logger.addSecret(r.accessToken);
        const stored = storeSecret({ name: page.tokenSecret, value: r.accessToken, repo, pat, processEnv, run: ghRun });
        if (!stored.ok) {
          outcome = "store_failed";
          errors.push(scrub(`${h}: refreshed but ${stored.detail}`, [r.accessToken, pat]));
          log(`[refresh-tokens] ${h}: refresh answered (expires_in ${r.expiresIn} s) but the secret could not be stored — ${stored.detail}; the stored expiry is kept and the job retries next week`);
        } else {
          outcome = "refreshed";
          refreshed++;
          entry.expiresAt = nowIst(new Date(startedAt.getTime() + r.expiresIn * 1000));
          entry.refreshedAt = nowIst(startedAt);
          entry.state = "ok";
          pageState.tokenState = "ok";
          log(`[refresh-tokens] ${h}: refreshed — ${page.tokenSecret} replaced in ${repo} (${stored.detail}); new expiry ${entry.expiresAt} (${wholeDaysLeft(entry.expiresAt, startedAt)} days)`);
        }
      } catch (err) {
        if (!(err instanceof IgError)) throw err;
        if (err.tokenInvalid) {
          outcome = "token_invalid";
          entry.state = "invalid";
          pageState.tokenState = "invalid";
          addFlag(flags, `token_invalid:${h}`);
          log(`[refresh-tokens] ${h}: code ${err.code} during refresh — token invalid, page paused (run setup-secrets with a new token; the publisher re-probes it hourly)`);
        } else {
          outcome = "refresh_failed";
          errors.push(scrub(`${h}: refresh failed — ${err.message}`, [pat]));
          log(`[refresh-tokens] ${h}: refresh failed — ${err.message}; the stored expiry is kept and the job retries next week`);
        }
      }
    }

    // state for status.json and the flags, from whatever expiry we now hold
    if (pageState.tokenState !== "invalid" && pageState.tokenState !== "not_configured") {
      if (isExpiring(entry.expiresAt, startedAt)) {
        pageState.tokenState = "expiring";
        addFlag(flags, `token_expiring:${h}`);
        expiring++;
        log(`[refresh-tokens] ${h}: ${wholeDaysLeft(entry.expiresAt, startedAt)} days left — token_expiring flag set (run setup-secrets or let next week's refresh try again)`);
      } else {
        if (pageState.tokenState === "expiring") pageState.tokenState = "ok";
        dropFlag(flags, `token_expiring:${h}`);
      }
      if (!entry.expiresAt) {
        unknown++;
        if (outcome !== "would_refresh") log(`[refresh-tokens] ${h}: ${EXPIRY_UNKNOWN} (recorded as expiresAt null; the next successful refresh sets it)`);
      }
    } else dropFlag(flags, `token_expiring:${h}`);
    if (pageState.tokenState !== "invalid") dropFlag(flags, `token_invalid:${h}`);
    pageState.tokenExpiresAt = entry.expiresAt || null;
    entry.state = pageState.tokenState;
    if (!entry.expiresAt) entry.expiresAt = null;
    tokens.pages[h] = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
    pages[h] = { outcome, daysLeft: wholeDaysLeft(entry.expiresAt, startedAt), expiresAt: entry.expiresAt };
  }

  // 2. records
  status.flags = flags;
  const after = JSON.stringify({ tokens: tokens.pages, pages: Object.fromEntries(Object.entries(status.pages).map(([h, p]) => [h, [p.tokenState, p.tokenExpiresAt || null]])), flags: [...flags].sort() });
  const changed = before !== after;
  const ms = Date.now() - t0;
  const endedAt = new Date(startedAt.getTime() + ms);
  const counted = Object.values(pages).filter((p) => p.outcome !== "filtered");
  const notConfigured = counted.filter((p) => p.outcome === "not_configured").length;
  const parts = [`${refreshed} refreshed`, `${expiring} expiring`, `${unknown} ${EXPIRY_UNKNOWN}`];
  if (notConfigured) parts.push(`${notConfigured} not configured`);
  if (errors.length) parts.push(`${errors.length} error${errors.length === 1 ? "" : "s"}`);
  const note = `tokens: ${parts.join(", ")}`;
  const changedFiles = [];
  const run = { id, workflow, trigger, startedAt: nowIst(startedAt), endedAt: nowIst(endedAt), ok: errors.length === 0, agents: [{ name: AGENT, ok: errors.length === 0, ms, calls: 0, costUsd: 0, note }], changed: [], errors, budgetUsedUsd: monthUsedUsd(state, startedAt), tokens: pages };
  if (monthHasFreeTierUsage(state, startedAt)) run.budgetPaidEquivalentUsd = monthPaidEquivalentUsd(state, startedAt);
  if (dryRun) run.dryRun = true;
  if (!dryRun) {
    tokens.updatedAt = nowIst(endedAt);
    status.updatedAt = nowIst(endedAt);
    status.lastRun = { id, workflow, ok: run.ok, at: run.endedAt };
    run.changed = ["company/state/tokens.json", "company/state/status.json", `company/${state.monthLogPath("runs", startedAt)}`];
    status.lastRuns = [run, ...(status.lastRuns || [])].slice(0, 20);
    changedFiles.push(state.writeJson("state/tokens.json", tokens, TOKENS_SPEC));
    changedFiles.push(state.writeJson("state/status.json", status, STATUS_SPEC));
    changedFiles.push(state.appendLog("runs", run, RUN_SPEC, startedAt));
  }
  const summary = stepLine(AGENT, run.ok, ms, 0, 0, note + (dryRun ? " (dry run, nothing written)" : ""));
  log(summary);
  return { ok: run.ok, changed: !dryRun && changed, changedFiles, run, status, tokens, pages, summary, errors, config };
}

// CLI entry: ctx from engine/index.js → exit code (0 ok, 1 failed, 2 usage).
// A dry run — --dry-run or IG_DRY_RUN=1 alone (review R2-06, as publish/daily/analyst/hr treat the variable) — works on
// a temp copy of the company dir, makes no refresh call, spawns no `gh`, logs what it WOULD refresh and commits nothing;
// the dry-run Instagram client is never used here, because its fake token must never reach `gh secret set`.
// `ghRun` is the process spawner (tests inject a recorder); engine/index.js passes none, so the real `gh` is used.
export async function run({ root, companyDir, processEnv = process.env, fetchImpl = globalThis.fetch, stdout = console.log, stderr = console.error, flags = {}, ghRun = spawnGh } = {}) {
  const dryRunFlag = flags["dry-run"] === true;
  const dryRun = isDryRun(processEnv, flags);
  let now;
  if (flags.now !== undefined) {
    if (!dryRun) {
      stderr("refresh-tokens: --now <iso> is accepted only with --dry-run or IG_DRY_RUN=1");
      return 2;
    }
    try {
      now = parseIso(String(flags.now));
    } catch (err) {
      stderr(`refresh-tokens: ${err.message}`);
      return 2;
    }
  }
  if (!existsSync(companyDir)) {
    stderr(`refresh-tokens: company dir ${companyDir} does not exist`);
    return 1;
  }
  const page = typeof flags.page === "string" ? flags.page : null;
  let dir = companyDir;
  if (dryRun) {
    dir = join(mkdtempSync(join(tmpdir(), "hoshlab-refresh-tokens-dry-run-")), "company");
    cpSync(companyDir, dir, { recursive: true });
    stdout(`refresh-tokens: ${dryRunFlag ? "--dry-run" : "IG_DRY_RUN=1"} works on a temp copy ${dir} (the repo's company dir is untouched; no refresh call, no gh secret set)`);
  }
  let result;
  try {
    result = await runRefreshTokens({ companyDir: dir, now, processEnv, fetchImpl, dryRun, page, ghRun, stdout });
  } catch (err) {
    stderr(scrub(`refresh-tokens: ${err && err.message ? err.message : String(err)}`));
    return 1;
  }
  if (dryRun) {
    stdout("refresh-tokens: dry run complete — no call made, nothing written");
    return result.ok ? 0 : 1;
  }
  if (shouldCommit(processEnv, flags)) {
    const repoRoot = repoRootFor(companyDir) || root || resolve(companyDir, "..");
    try {
      const paths = result.changedFiles.map((rel) => relative(repoRoot, join(companyDir, rel)));
      await commitAndPush({ repoRoot, config: result.config, changedFiles: paths, message: `state: ${WORKFLOW} ${result.run.id}`, stdout });
      writeGithubOutput("changed", result.changed, processEnv);
    } catch (err) {
      if (err instanceof PushConflictError) {
        stderr(scrub(`refresh-tokens: ${err.message} — errors: push_conflict (the state stays in this checkout; the next run regenerates it)`));
        writeGithubOutput("changed", false, processEnv);
        return 1;
      }
      stderr(scrub(`refresh-tokens: git step failed — ${err.message}`));
      return 1;
    }
  } else {
    stdout(`refresh-tokens: ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"} changed under ${companyDir}, not committed (pass --commit)`);
    writeGithubOutput("changed", false, processEnv);
  }
  return result.ok ? 0 : 1;
}
