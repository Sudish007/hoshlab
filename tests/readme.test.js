// README.md — the owner runbook (design.md §16, P1-21; review M15, N16, N21). Every sentence the acceptance
// items name must be there, the numbers must be the config's, and no secret-shaped value may appear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, read } from "./helpers.js";
import { CONSEQUENCES } from "../engine/commands/set-page.js";

const readme = read(join(ROOT, "README.md"));
const config = JSON.parse(readFileSync(join(ROOT, "company", "config.json"), "utf8"));
const has = (s, why = s) => assert.ok(readme.includes(s), `README lacks ${JSON.stringify(s)}${why === s ? "" : ` (${why})`}`);

test("P1-21: owner click-path to-dos in order — Meta app, professional accounts, testers, long-lived tokens, setup-secrets, Pages source, media branch, first engine run, admin token, throwaway post", () => {
  const order = [
    "## Owner to-do",
    "**My Apps**",
    "**Create app**",
    "**Other**",
    "**Business**",
    "**Instagram**",
    "API setup with Instagram login",
    "Switch to professional account",
    "Instagram tester",
    "long-lived tokens that expire after 60 days",
    "scripts\\setup-secrets.ps1",
    'git add company/config.json; git commit -m "config: instagram ids"',
    "Source **GitHub Actions**",
    "scripts\\init-media-branch.ps1",
    "git ls-remote --heads origin media",
    "**Hoshlab engine (daily)**",
    "**Run workflow**",
    "dry_run",
    "https://github.com/settings/personal-access-tokens/new",
    "**Only select repositories**",
    "**Contents: Read and write**",
    "**Actions: Read and write**",
    "https://sudish007.github.io/hoshlab/admin/",
    "**Throwaway post (before any Autopilot).**",
    "**exactly 100 characters**",
    "## Secrets",
  ];
  let pos = 0;
  for (const needle of order) {
    const at = readme.indexOf(needle, pos);
    assert.ok(at > pos, `README: expected ${JSON.stringify(needle)} after position ${pos}`);
    pos = at;
  }
  assert.equal(config.defaults.altTextMax, 100, "the throwaway-post alt text length is defaults.altTextMax (M15)");
  has("throwaway");
  has("Only after one such post per page may a page be switched to **Autopilot**", "the throwaway-post gate before Autopilot");
  has("Gemini's list price doubles on 2027-01-01", "FEAT-102: check-models + price update in January 2027");
});

test("secrets: the seven names, where they live, never a value; the PAT click path, the token-refresh behaviour and 'expiry not known yet' (FEAT-202, P2-09)", () => {
  for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "IG_TOKEN_RISHTAPATRA", "IG_TOKEN_KAATDO", "IG_TOKEN_JOB_REZ", "HOSHLAB_SECRETS_PAT"]) has(`\`${name}\``);
  has("Actions secrets");
  has("gitignored");
  has("names and lengths");
  assert.ok(!/sk-ant-|AIza[0-9A-Za-z_-]{10,}|sk-proj-|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|EAA[0-9A-Za-z]{40,}/.test(readme), "no secret-shaped literal in the README");
  // the PAT click path, in order
  const order = ["**Developer settings**", "**Personal access tokens**", "**Fine-grained tokens**", "**Generate new token**", "**Only select repositories**", "`Sudish007/hoshlab`", "**Repository permissions**", "**Secrets: Read and write**"];
  let pos = readme.indexOf("5. **Secrets.**");
  assert.ok(pos > 0);
  for (const needle of order) {
    const at = readme.indexOf(needle, pos);
    assert.ok(at > pos, `README: expected ${JSON.stringify(needle)} after position ${pos} in the PAT click path`);
    pos = at;
  }
  has("**Token refresh**");
  has("less than 20 days away or not known yet");
  has("gh secret set <NAME> --repo Sudish007/hoshlab");
  has("`GH_TOKEN` = `HOSHLAB_SECRETS_PAT`");
  has("Under **7 days**");
  has("expires in <n> days — run setup-secrets or wait for the weekly refresh");
  has('**"expiry not known yet."**');
  has("`expiresAt: null`");
  has("Without `HOSHLAB_SECRETS_PAT` nothing is refreshed");
  has("`token-refresh.yml`");
  has("cron `0 2 * * 1`");
  has("The weekly refresh has run **zero times** so far");
});

test("modes: both consequence sentence pairs verbatim (engine/commands/set-page.js CONSEQUENCES = the admin's dialog), labels not tokens", () => {
  for (const mode of Object.keys(CONSEQUENCES)) for (const sentence of CONSEQUENCES[mode]) has(sentence, `mode ${mode} consequence`);
  has("**Approve first**");
  has("**Autopilot**");
  has("set-page --page kaatdo --mode autopilot", "the owner CLI switch");
});

test("how a post happens, honesty rules, cadence sentences, limits (N16, N21), retention, API version, local development, phase 2", () => {
  has("## How a post happens");
  has("## Honesty rules");
  has("## Cadence");
  has("A 19:30 IST slot posts in the first publisher run at or after 19:30 IST");
  has("## Limits");
  has("public", "drafts are public");
  has("Drafts are public");
  has("top-of-hour");
  has("can be late by more than 30 minutes");
  has("100 API posts");
  // FEAT-202 (P2-09): the refresh job exists now; the Limits bullet names it, the day-count banner and the unknown-expiry case
  has("Long-lived Instagram tokens expire after 60 days; the weekly `token-refresh.yml` run refreshes them");
  assert.ok(!readme.includes("must be regenerated by hand until the phase-2 refresh job exists"), "the phase-1 'regenerate by hand' sentence is gone");
  assert.ok(!readme.includes("the refresh job is phase 2, not built yet"), "the owner to-do no longer calls the refresh job unbuilt");
  has("expire after 60 days");
  // R1-01: the token-replacement path names the engine-side probe and, for the local reset, status.json + pull-before-commit
  has("Every hourly publisher run then probes the paused page once with the stored secret", "the publisher re-probes a paused page (R1-01)");
  has("resets the token state in your local `company/state/status.json`", "the local reset names status.json");
  has("needs `git pull --ff-only` before `git add company/config.json company/state/status.json; git commit; git push`", "pull before committing both files");
  assert.ok(!readme.includes("a successful `GET /me` resets the page's token state so the next publisher run retries"), "the old sentence that implied the local reset reaches production is gone");
  // R2-02: with the local status.json modified, `git pull --ff-only` REFUSES (it never 'brings' a newer file) — step 5 and
  // the Limits bullet name that case and the recovery command, in the same words as scripts/setup-secrets.ps1
  const refusal = "If `git pull --ff-only` refuses because `company/state/status.json` changed upstream, run `git checkout -- company/state/status.json` and pull again; the publisher clears the pause itself on its next hourly run.";
  has(refusal, "R2-02: the pull-refusal case with the recovery command");
  const step5 = readme.slice(readme.indexOf("5. **Secrets.**"), readme.indexOf("6. **Pages source.**"));
  assert.ok(step5.includes(refusal), "R2-02: the sentence is in owner to-do step 5");
  const limits = readme.slice(readme.indexOf("## Limits"), readme.indexOf("## ", readme.indexOf("## Limits") + 1));
  assert.ok(limits.includes(refusal), "R2-02: the sentence is in the Limits 'Tokens expire' bullet too");
  assert.ok(!readme.includes("if the pull brings a newer status.json") && !readme.includes("brings a newer"), "R2-02: the misworded 'brings a newer status.json' claim appears nowhere");
  // R1-04: the admin's per-draft load and the quarterly archival until the phase-2 index exists
  has("**The admin reads every draft folder on each load.**");
  has("Archive or prune terminal drafts (`published`, `rejected`, `blocked`, `failed`, `expired`) under `company/state/drafts/` quarterly until the phase-2 live-draft index exists");
  has("live-draft index", "the Phase 2 list names the index");
  has("GitHub disables scheduled workflows after 60 days without repository activity");
  has("disables scheduled workflows after 60 days");
  has("## Media retention and compaction");
  has("**Weekly retention**");
  has("**Quarterly compaction**");
  has("node engine/index.js retention --commit");
  has("node scripts/compact-media.mjs --dry-run");
  has("`main` is never rewritten");
  assert.ok(!readme.includes("manual until the phase-2 `scripts/compact-media.mjs` exists"), "the manual procedure is replaced by the script");
  has("## Instagram API version");
  has(`**${config.ig.version}**`, "ig.version pinned value");
  has(config.ig.versionSource, "ig.versionSource (changelog URL)");
  has(config.ig.versionVerifiedAt, "ig.versionVerifiedAt");
  has("## Local development");
  for (const s of ["node --env-file=.env engine/index.js check-models", "daily --dry-run", "MOCK_LLM=1", "IG_DRY_RUN=1", "RENDER_TESTS=1", "npm run build:fonts", "npm run audit", "npm run audit:admin", "npm run dryrun", "BUILD_NOW", "PUBLIC_DIR", "node scripts/render-brand.mjs"]) has(s);
  has("## Phase 2 — not built yet");
  for (const s of ["not built yet", "not configured yet", "untested"]) has(`**${s}**`, "honesty label");
  has("`—` / `No runs yet`", "the launch-day empty state");
  // FEAT-203 (P2-04/P2-05): the Analyst step, its number rule, the insights metric names with their source and date, the
  // on-demand command and the honest first-report sentence
  has("8. **Sunday 05:30 IST — Analyst**");
  has("`GET /{igMediaId}/insights?metric=reach,views,likes,comments,saved,shares`");
  has("a metric Meta leaves out is never written as 0");
  has("\"report number not in metrics\"");
  has("**Reports quote only fetched numbers.**");
  has("https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights (verified 2026-10-11");
  has("`views` replaced `impressions`");
  has("node --env-file=.env engine/index.js analyst --dry-run");
  has('"Run analyst" dispatches `engine-daily.yml` with `agents: analyst`');
  has("the first real report appears after the first Sunday with a post that has been live for 48 hours");
  assert.ok(!readme.includes("Strategist and Analyst (phase 2)"), "the roster line no longer calls the Analyst phase 2");
  assert.ok(!readme.includes('as "not built yet (phase 2)": the Analyst'), "the Analyst left the unbuilt list");
  // FEAT-204 (P2-06): the HR step, its evidence rule, the qa/publisher guard, the admin's Apply / Dismiss through the decisions
  // log (N14), the on-demand command, and HR off the unbuilt list
  has("7a. **1st of the month 05:30 IST — HR**");
  has("\"evidence number not in stats\"");
  has("a proposal can never remove or disable QA or the Publisher");
  has("HR never edits `roster.json`");
  has("**Apply** writes the proposed values into `roster.json` (re-validated in the browser) and appends `company/state/hr/decisions.jsonl`; **Dismiss** appends the decision only; the proposal file is never modified");
  has("node --env-file=.env engine/index.js hr --dry-run");
  has("`roster: apply hr proposal <month>` + `hr: apply proposal <month>` / `hr: dismiss proposal <month>`");
  has("the first HR review on the 1st of the month after the first month with runs");
  assert.ok(!readme.includes("HR (monthly review, phase 2)"), "the roster line no longer calls HR phase 2");
  assert.ok(!readme.includes('"not built yet (phase 2)": HR\'s monthly review'), "HR left the unbuilt list");
});

test("numbers in the README are the config's", () => {
  has(`USD ${config.budget.monthlyUsd}`);
  has(`${config.budget.warnAtPct} %`);
  has(`≤ ${config.defaults.captionMax} code points`);
  has(`≤ ${config.defaults.hashtagCap} hashtags`);
  has(`alt text ≤ ${config.defaults.altTextMax} characters`);
  has(`${config.defaults.leadDays} days (\`leadDays\`)`);
  has(`\`minGapHours\` (${config.defaults.minGapHours})`);
  has(`at most ${config.defaults.maxReworkLoops} loops`);
  has(`more than ${config.defaults.expireAfterHours} hours ago expires`);
  has(`more than ${config.defaults.lateAfterHours} hours after its slot`);
  const slots = config.pages.reduce((n, p) => n + p.cadence.slots.length, 0);
  has(`${slots} slots a week`);
  has(`${config.pages.length === 3 ? "three" : config.pages.length} real products`);
  has(`\`${config.schedule.engineCron}\``);
  has(`\`${config.schedule.publisherCron}\``);
  for (const p of config.pages) has(`@${p.handle}`);
});
