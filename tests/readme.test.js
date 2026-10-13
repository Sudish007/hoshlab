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
// 'Daily 05:53 IST' → '05:53 IST': the engine time the step headings of "How a post happens" carry
const engineTime = config.schedule.engineLabel.replace(/^Daily /, "");
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
  has("Gemini remains free of charge within the free tier, but its paid-equivalent list price doubles on 2027-01-01", "free-tier billing + paid-equivalent price update in January 2027");
});

test("secrets: the seven names, where they live, never a value; the PAT click path, the token-refresh behaviour and 'expiry not known yet' (FEAT-202, P2-09)", () => {
  for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "IG_TOKEN_RISHTAPATRA", "IG_TOKEN_KAATDO", "IG_TOKEN_JOB_REZ", "HOSHLAB_SECRETS_PAT"]) has(`\`${name}\``);
  has("`GEMINI_API_KEY` is the only required provider key");
  has("| `GEMINI_API_KEY` | **Required model key** | all six LLM agents | Google AI Studio, free tier, no card |");
  has("| `ANTHROPIC_API_KEY` | Optional paid fallback |");
  has("| `OPENAI_API_KEY` | Optional paid fallback |");
  has("Anthropic has no free API tier");
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
  has(`cron \`${config.schedule.tokenRefreshCron}\``);
  has(`${config.schedule.tokenRefreshLabel}, cron \`${config.schedule.tokenRefreshCron}\` UTC`, "the Token refresh paragraph names the config's label and cron");
  assert.equal(config.schedule.tokenRefreshCron, "13 2 * * 1", "off the top of the hour since 2026-10-12");
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
  has("[official Gemini models catalog](https://ai.google.dev/gemini-api/docs/models)");
  has("[Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)");
  has("[Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)");
  has("[Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing)");
  has("free-tier content may be used to improve Google's products");
  has("Rate limits are applied per project, not per API key");
  has("shown in Google AI Studio");
  has("at most one HTTP attempt on each configured free model");
  has("A server `Retry-After` or Gemini `retryDelay` is honoured but capped at 60 seconds");
  has("Only after the free ladder is exhausted are Anthropic and OpenAI considered");
  has("**5–9 model calls per steady-state day**");
  has("**13–17 model calls before rework or retries**");
  const callsByDay = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((day) => [day, config.pages.reduce((n, p) => n + p.cadence.slots.filter((s) => s.dow === day).length, 0)]));
  assert.deepEqual(callsByDay, { sun: 1, mon: 2, tue: 2, wed: 2, thu: 2, fri: 2, sat: 2 });
  assert.equal(3 + 2 * Math.min(...Object.values(callsByDay)), 5, "three Strategists + Writer/QA for Sunday's one slot");
  assert.equal(3 + 2 * Math.max(...Object.values(callsByDay)) + 1 + 1, 9, "two-slot steady day + CEO + monthly HR maximum");
  const ordered = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((day) => callsByDay[day]);
  const leadWindowDrafts = ordered.map((_, i) => ordered[i] + ordered[(i + 1) % 7] + ordered[(i + 2) % 7]);
  assert.deepEqual([Math.min(...leadWindowDrafts), Math.max(...leadWindowDrafts)], [5, 6]);
  assert.equal(3 + 2 * Math.min(...leadWindowDrafts), 13, "catch-up lower bound before due weekly/monthly agents");
  assert.equal(3 + 2 * Math.max(...leadWindowDrafts) + 2, 17, "catch-up upper bound with two due weekly/monthly agents");
  has("public", "drafts are public");
  has("Drafts are public");
  // polish-cron (2026-10-12): the drift bullet states GitHub's documented behaviour, the observed first-day numbers and the move
  has("**Schedules drift.** GitHub may delay or skip scheduled runs; a due slot posts at the next run that fires.");
  has("only **3 of ~20** hourly publisher ticks fired");
  has("started at 03:01 UTC, 3 hours late");
  has("moved off the top of the hour");
  assert.ok(!readme.includes("Actions cron may start 10–30 min late") && !readme.includes("can be late by more than 30 minutes"), "the understated drift wording is gone");
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
  // R1-04 → R2-05: the engine-owned draft index is built (the admin fetches live drafts only, terminal ones on demand, the
  // folder listing only while no index exists); the quarterly archival is still honestly unbuilt, with the growth numbers
  has("**The admin reads the draft index, not every draft folder.**");
  has("`company/state/drafts/index.json`");
  has("then `draft.json` and `qa.json` only for the live drafts");
  has("loads blocked, failed, expired and rejected drafts when you open **Blocked, failed, expired**");
  has("published drafts are never fetched");
  has("the admin lists the folder and reads every draft, as it did before", "the no-index fallback is stated");
  has("Nothing archives terminal drafts yet (**not built yet**: the quarterly move of `published`, `rejected`, `blocked`, `failed` and `expired` drafts older than 90 days under `company/state/archive/drafts/` by the `retention` command)");
  const slotsPerWeek = config.pages.reduce((n, p) => n + p.cadence.slots.length, 0);
  has(`at ${slotsPerWeek} slots a week the folder grows by about ${slotsPerWeek} drafts a week — roughly ${Math.round((slotsPerWeek * 52) / 10) * 10} folders after a year`, "the growth numbers are computed from the cadence");
  has(`reached after roughly ${Math.round((1000 / slotsPerWeek / 52) * 12)} months`, "the 1,000-entry listing cap in months, from the cadence");
  has("GitHub's Contents API lists at most 1,000 entries per directory");
  has(`the drafts written for the next ${config.defaults.leadDays} days (\`leadDays\`)`);
  assert.ok(!readme.includes("**The admin reads every draft folder on each load.**"), "the phase-1 sentence is gone");
  assert.ok(!readme.includes("until the phase-2 live-draft index exists"), "the index is no longer 'not built yet'");
  has("Also built: the engine-owned draft index `company/state/drafts/index.json`", "the Phase 2 list moves the index to built");
  has("Still **not built yet**: the quarterly archival of terminal drafts by the `retention` command", "and keeps the archival honestly unbuilt");
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
  // R2-02 + Gemini ladder: the status paragraph describes the live site, existing media/workflows,
  // configured required model key, and the two honest 503-only runs that motivated this change.
  const status = readme.slice(readme.indexOf("**Status of this repository at the time of writing:**"), readme.indexOf("## Owner to-do"));
  assert.ok(status.length > 100, "the status paragraph exists before the owner to-do");
  assert.ok(!status.includes("GitHub Pages is **not configured yet**"), "Pages is live");
  assert.ok(!status.includes("the `media` branch is **not configured yet**"), "the media branch exists");
  assert.ok(status.includes("https://sudish007.github.io/hoshlab/"), "names the live site");
  assert.ok(status.includes("`media` branch exists") && status.includes("`sample: true`"), "the media branch carries fixture samples");
  assert.ok(status.includes("`engine-daily.yml` and `publisher-hourly.yml` run on their schedules"), "the state workflows are live");
  assert.ok(status.includes("`GEMINI_API_KEY` is stored as a GitHub Actions secret"), "the required model key is configured without exposing it");
  assert.ok(status.includes("run 38426296275") && status.includes("run 38426835639"), "the two honest failed runs remain linked");
  assert.ok(status.includes("HTTP 503 at high demand") && status.includes("created no drafts"), "the confirmed production failure is recorded");
  assert.ok(/Still \*\*not configured yet\*\*: the Instagram tokens/.test(status), "only Instagram tokens keep the not-configured label");
  assert.ok(status.includes("the real Instagram publishing path, until the throwaway post"), "the publishing path keeps the label");
  // R2-01: IG_DRY_RUN=1 alone is a dry run for daily/analyst/hr too (temp copy, no commit), and a real Analyst run ignores dryRun records
  has("makes `publish`, `daily`, `analyst` and `hr` work on a temp copy of `company/` and commit nothing", "R2-01: the env var alone implies the temp copy for every state-writing command");
  has("a real Analyst run ignores any `dryRun: true` record it finds", "R2-01: stray dry-run metrics neither block nor feed a real run");
  assert.ok(!readme.includes("`--dry-run` works on a temp copy for `daily` too"), "R2-01: the sentence that implied daily differs from publish is gone");
  // R2-06: refresh-tokens honours IG_DRY_RUN=1 like the other four — temp copy, no refresh call, no gh, nothing written — and never the fake token
  has("`IG_DRY_RUN=1` makes `refresh-tokens` a dry run too, exactly as its `--dry-run` does: a temp copy of `company/`, no `refresh_access_token` call, no `gh secret set`", "R2-06: the IG_DRY_RUN sentence names refresh-tokens");
  has("no fake value may ever be piped into `gh secret set`");
  assert.ok(!readme.includes("not needed in phase 1"), "R2-02: the phase-1 ffmpeg sentence is gone");
  has("`ffmpeg`/`ffprobe` are needed to render reels locally (see Reels)", "R2-02: the Local development note matches the Reels section");
  // R2-03: Instagram's acceptance of a silent reel is an unverified assumption until the first reel publish
  assert.ok(!readme.includes("Instagram accepts silent reels"), "R2-03: no Meta behaviour asserted as fact");
  const reels = readme.slice(readme.indexOf("## Reels"), readme.indexOf("## Limits"));
  assert.ok(reels.includes("- **Silent reels.** No audio track is produced or uploaded (`-an`); Instagram's acceptance of a silent reel is **untested until the first reel publish**."), "R2-03: the silent-reel bullet is labelled untested");
  // FEAT-203 (P2-04/P2-05): the Analyst step, its number rule, the insights metric names with their source and date, the
  // on-demand command and the honest first-report sentence
  has(`8. **Sunday ${engineTime} — Analyst**`);
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
  has(`7a. **1st of the month ${engineTime} — HR**`);
  has(`1. **Monday ${engineTime} — CEO.**`);
  has(`2. **${config.schedule.engineLabel} — Strategist**`);
  has(`7. **${config.schedule.publisherLabel} — Publisher**`);
  has(`Wait for the next publisher run (${config.schedule.publisherLabel})`, "the throwaway-post step names the publisher cadence");
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
