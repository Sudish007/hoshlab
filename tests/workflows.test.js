// The four GitHub Actions workflows (design.md §3.1–3.3; review M10, N16, N17; plan D16/D19; P1-10).
// Regex assertions on the YAML text — no YAML dependency (exact pins only, nothing approved for it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.js";
import { WORKFLOWS } from "../src/templates/admin.js";

const DIR = join(ROOT, ".github", "workflows");
const FILES = ["pages.yml", "ci.yml", "engine-daily.yml", "publisher-hourly.yml"];
const SECRETS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "IG_TOKEN_RISHTAPATRA", "IG_TOKEN_KAATDO", "IG_TOKEN_JOB_REZ"];
const config = JSON.parse(readFileSync(join(ROOT, "company", "config.json"), "utf8"));
const read = (f) => readFileSync(join(DIR, f), "utf8");

// The deploy job the two state workflows share (N17): needs the state job, runs only when it reported
// changed=true, grants pages.yml what it needs, holds the `pages` group on the caller side.
function assertDeployJob(text, stateJob, file) {
  const deploy = text.slice(text.indexOf("\n  deploy:"));
  assert.ok(deploy.length > 10, `${file}: has a deploy job`);
  assert.match(deploy, new RegExp(`needs: ${stateJob}\\b`), `${file}: deploy needs ${stateJob}`);
  assert.match(deploy, new RegExp(`if: needs\\.${stateJob}\\.outputs\\.changed == 'true'`), `${file}: deploy only when the engine reported changed=true`);
  assert.match(deploy, /uses: \.\/\.github\/workflows\/pages\.yml/, `${file}: deploy calls pages.yml (workflow_call)`);
  assert.match(deploy, /permissions:\s*\n\s+contents: read\s*\n\s+pages: write\s*\n\s+id-token: write/, `${file}: caller grants pages.yml its permissions`);
  assert.match(deploy, /concurrency:\s*\n\s+group: pages\s*\n\s+cancel-in-progress: false/, `${file}: caller-side concurrency pages (N17)`);
  assert.ok(!/\n\s+runs-on:/.test(deploy) && !/\n\s+steps:/.test(deploy), `${file}: the deploy job has no steps of its own`);
}

function assertStateJob(text, file, { cron, jobId, stepId }) {
  assert.match(text, new RegExp(`cron: "${cron.replace(/\*/g, "\\*")}"`), `${file}: cron ${cron}`);
  assert.match(text, /permissions:\s*\n\s+contents: write\s*\n\s+actions: read/, `${file}: permissions contents write + actions read`);
  assert.match(text, /^concurrency:\s*\n\s+group: hoshlab-state\s*\n\s+cancel-in-progress: false/m, `${file}: concurrency hoshlab-state, never cancelled`);
  assert.match(text, /uses: actions\/checkout@v7\s*\n\s+with:\s*\n\s+ref: main\s*\n\s+fetch-depth: 0/, `${file}: checkout main with full history (rebase-retry)`);
  assert.match(text, /uses: actions\/setup-node@v7\s*\n\s+with:\s*\n\s+node-version: 24/, `${file}: Node 24`);
  assert.match(text, /- run: npm ci\b/, `${file}: npm ci`);
  assert.match(text, /git config user\.name hoshlab-bot\s*\n\s+git config user\.email hoshlab-bot@users\.noreply\.github\.com/, `${file}: bot identity (N16)`);
  for (const name of SECRETS) assert.match(text, new RegExp(`^\\s+${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, "m"), `${file}: env maps ${name} from secrets`);
  assert.match(text, /^\s+CI: "true"$/m, `${file}: CI=true makes the engine commit + push itself`);
  assert.match(text, new RegExp(`^\\s+changed: \\$\\{\\{ steps\\.${stepId}\\.outputs\\.changed \\}\\}$`, "m"), `${file}: job output changed from the engine step`);
  assert.match(text, new RegExp(`^\\s+- id: ${stepId}$`, "m"), `${file}: the engine step carries id ${stepId}`);
  assert.match(text, /dry_run:\s*\n\s+description: .+\n\s+type: boolean\s*\n\s+default: false/, `${file}: workflow_dispatch input dry_run is a boolean (the admin dispatches inputs: { dry_run: 'false' })`);
  assert.match(text, /args\+=\(--dry-run\)/, `${file}: dry_run → --dry-run`);
  assert.match(text, /node engine\/index\.js "\$\{args\[@\]\}"/, `${file}: runs the engine with the built argument list`);
  assert.ok(!/MEDIA_DIR|BUILD_NOW|PUBLIC_DIR/.test(text), `${file}: never sets the test-only knobs in CI`);
  assertDeployJob(text, jobId, file);
}

test("every workflow exists, is workflow_dispatch-able, carries the cadence comment line and uses the Node-24 generation of the actions", () => {
  for (const f of FILES) {
    assert.ok(existsSync(join(DIR, f)), `${f} exists`);
    const text = read(f);
    assert.match(text, /^on:\s*\n(?:.*\n)*?\s+workflow_dispatch:/m, `${f}: has workflow_dispatch`);
    assert.match(text, /^concurrency:\s*\n\s+group: /m, `${f}: declares a concurrency group`);
    assert.match(text, /^# Engine: Daily 05:30 IST \(cron 0 0 \* \* \*\) · Publisher: Hourly at :30 IST \(cron 0 \* \* \* \*\) · Actions cron may start 10–30 min late$/m, `${f}: cadence comment line verbatim (OF-7, P1-17)`);
    assert.match(text, /actions\/checkout@v7/, `${f}: checkout@v7`);
    assert.match(text, /actions\/setup-node@v7\s*\n\s+with:\s*\n\s+node-version: 24\s*\n\s+cache: npm/, `${f}: setup-node@v7 node 24 with npm cache`);
    assert.ok(!/\$\{\{\s*secrets\.GITHUB_TOKEN/.test(text), `${f}: never passes GITHUB_TOKEN explicitly (actions/checkout persists it)`);
    assert.ok(!/ghp_|sk-ant-|AIza|sk-proj-/.test(text), `${f}: no secret-shaped literal`);
  }
});

test("the admin's dispatch targets are exactly these files (src/templates/admin.js WORKFLOWS)", () => {
  assert.deepEqual(Object.values(WORKFLOWS).sort(), ["engine-daily.yml", "pages.yml", "publisher-hourly.yml"]);
  for (const f of Object.values(WORKFLOWS)) assert.ok(existsSync(join(DIR, f)), `${f} exists for the admin's Run now / deploy line`);
});

test("pages.yml (design §3.3): push main + dispatch + workflow_call; checkout ref main; optional media checkout; npm ci/test/build; configure-pages@v6 → upload-pages-artifact@v5 → deploy-pages@v5; concurrency pages", () => {
  const text = read("pages.yml");
  assert.match(text, /^name: Deploy to GitHub Pages$/m);
  assert.match(text, /^on:\s*\n\s+push:\s*\n\s+branches: \[main\]\s*\n\s+workflow_dispatch:\s*\n\s+workflow_call:/m, "triggers in order");
  assert.match(text, /^permissions:\s*\n\s+contents: read\s*\n\s+pages: write\s*\n\s+id-token: write/m);
  // group is `pages` for a standalone run; when called, the caller's deploy job already holds `pages` (N17) and
  // GitHub would cancel a second claim as a deadlock, so the called run gets a per-run group.
  assert.match(text, /^concurrency:\s*\n\s+group: \$\{\{ github\.workflow == 'Deploy to GitHub Pages' && 'pages' \|\| format\('pages-call-\{0\}', github\.run_id\) \}\}\s*\n\s+cancel-in-progress: false/m, "concurrency pages (standalone) / per-run group (called)");
  assert.match(text, /uses: actions\/checkout@v7\s*\n\s+with:\s*\n\s+ref: main\s*\n/, "checkout ref: main (builds the commit the engine just pushed)");
  assert.match(text, /uses: actions\/checkout@v7\s*\n\s+with:\s*\n\s+ref: media\s*\n\s+path: \.media\s*\n\s+continue-on-error: true/, "media checkout into .media with continue-on-error");
  const order = ["- run: npm ci", "- run: npm test", "- run: npm run build", "actions/configure-pages@v6", "actions/upload-pages-artifact@v5", "path: dist", "environment:", "name: github-pages", "actions/deploy-pages@v5"];
  let pos = 0;
  for (const needle of order) {
    const at = text.indexOf(needle, pos);
    assert.ok(at > pos, `pages.yml: expected ${needle} after position ${pos}`);
    pos = at;
  }
  assert.ok(!/MOCK_LLM|IG_DRY_RUN|secrets\./.test(text), "pages.yml needs no secrets and no engine env");
});

test("ci.yml (M10): Chromium with deps, fonts, RENDER_TESTS=1 MOCK_LLM=1 IG_DRY_RUN=1 npm test, build, both audits into audit-out, dry-run-publish, artifact upload even on failure", () => {
  const text = read("ci.yml");
  assert.match(text, /^name: CI$/m);
  assert.match(text, /^on:\s*\n\s+push:\s*\n\s+pull_request:\s*\n\s+workflow_dispatch:/m);
  assert.match(text, /^permissions:\s*\n\s+contents: read\s*$/m, "read-only token");
  const order = ["- run: npm ci", "- run: npx playwright install --with-deps chromium", "- run: npm run build:fonts", "run: RENDER_TESTS=1 MOCK_LLM=1 IG_DRY_RUN=1 npm test", "run: npm run build", "run: AUDIT_OUT=audit-out npm run audit\n", "run: AUDIT_OUT=audit-out npm run audit:admin", "run: node scripts/dry-run-publish.mjs", "uses: actions/upload-artifact@v", "if: always()", "name: audit-out", "path: audit-out/"];
  let pos = 0;
  for (const needle of order) {
    const at = text.indexOf(needle, pos);
    assert.ok(at > pos, `ci.yml: expected ${needle} after position ${pos}`);
    pos = at;
  }
  assert.ok(!/secrets\./.test(text), "CI uses no secrets");
});

test("engine-daily.yml (design §3.1): cron 0 0 * * * = Daily 05:30 IST; inputs agents/page/dry_run/mock_llm; media checkout guarded (M16); Chromium + fonts; six secrets; bot; MOCK_LLM from the input; deploy via pages.yml (N17)", () => {
  const text = read("engine-daily.yml");
  assert.match(text, /^name: Hoshlab engine \(daily\)$/m, "the name the README's owner to-do and the admin point at");
  assert.equal(config.schedule.engineCron, "0 0 * * *");
  assertStateJob(text, "engine-daily.yml", { cron: config.schedule.engineCron, jobId: "engine", stepId: "engine" });
  for (const input of ["agents", "page"]) assert.match(text, new RegExp(`${input}:\\s*\\n\\s+description: .+\\n\\s+type: string\\s*\\n\\s+default: ""`), `input ${input} (string, default empty)`);
  assert.match(text, /mock_llm:\s*\n\s+description: .+\n\s+type: boolean\s*\n\s+default: false/, "input mock_llm");
  assert.match(text, /^\s+MOCK_LLM: \$\{\{ inputs\.mock_llm == true && '1' \|\| '' \}\}$/m, "MOCK_LLM = inputs.mock_llm ? '1' : '' (N16)");
  assert.match(text, /uses: actions\/checkout@v7\s*\n\s+with:\s*\n\s+ref: media\s*\n\s+path: \.media\s*\n\s+continue-on-error: true/, "media checkout with continue-on-error");
  assert.match(text, /rm -rf \.media/, "M16: a half-initialised .media from a failed checkout is removed so the Designer skips instead of creating the branch");
  assert.match(text, /- run: npx playwright install --with-deps chromium/, "Chromium for the Designer");
  assert.match(text, /- run: npm run build:fonts/, "fonts for the renderer");
  assert.match(text, /args=\(daily --commit\)/, "daily --commit");
  assert.match(text, /args\+=\(--agents "\$INPUT_AGENTS"\)/, "agents → --agents");
  assert.match(text, /args\+=\(--page "\$INPUT_PAGE"\)/, "page → --page");
});

test("publisher-hourly.yml (design §3.2, M1): cron 0 * * * * = Hourly at :30 IST; same concurrency, secrets, bot and deploy job; no Chromium, no media checkout", () => {
  const text = read("publisher-hourly.yml");
  assert.match(text, /^name: Hoshlab publisher \(hourly\)$/m);
  assert.equal(config.schedule.publisherCron, "0 * * * *");
  assertStateJob(text, "publisher-hourly.yml", { cron: config.schedule.publisherCron, jobId: "publisher", stepId: "publish" });
  assert.match(text, /args=\(publish --commit\)/, "publish --commit");
  assert.ok(!/playwright install|build:fonts|ref: media/.test(text), "the publisher renders nothing");
  const engine = read("engine-daily.yml");
  const deployOf = (t) => t.slice(t.indexOf("\n  deploy:")).replace(/needs: \w+|needs\.\w+\./g, "").replace(/^\s*#.*$/gm, "").trim();
  assert.equal(deployOf(text), deployOf(engine), "the deploy job is identical to engine-daily's apart from the job it needs");
});
