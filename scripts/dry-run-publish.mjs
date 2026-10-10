// dry-run-publish — the whole pipeline end to end on a TEMP COPY of the populated fixture (design.md
// §3.5, §15 "Integration", P1-22): mock LLM → Strategist/Writer → Designer (real Chromium when it
// launches) → QA → dry-run Instagram client → published.jsonl lines with dry- ids → every state file
// re-validated against its spec. The repo's company/ and tests/fixtures/ are never touched.
//
//   node scripts/dry-run-publish.mjs            (exit 0 = every state file validates; 1 = a problem)
//
// Honest by construction: the Writer's mock drafts carry mock:true, so QA fails them with mock_output
// (they never reach the queue — M5.4); the publish step therefore posts the fixture's two QUEUED drafts
// (one already approved, one approved by this script with a revision-matched record), as a real
// owner would. Without Chromium the Designer step says so and the run continues.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createState, validateTree } from "../engine/lib/state.js";
import { parseMemo } from "../engine/agents/ceo.js";
import { runDaily } from "../engine/commands/daily.js";
import { runPublish } from "../engine/commands/publish.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = join(ROOT, "tests", "fixtures", "company-populated");
const FIXTURE_MEDIA = join(ROOT, "tests", "fixtures", "media");
// Monday 05:31 IST so the CEO runs (design §3.1 step 2) and the strategist fixtures' slot assignments match.
const DAILY_NOW = "2026-10-12T05:31:00+05:30";
// Both fixture slots (Tue 13th 08:15, Wed 14th 19:30) are due and inside expireAfterHours (48 h) at this clock.
const PUBLISH_NOW = "2026-10-14T20:00:00+05:30";
const RP = "rp-2026-10-14-kundali-free";

const out = (s) => process.stdout.write(s + "\n");
const problems = [];
const expect = (ok, what) => {
  out(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};

function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        h.update(relative(dir, p).replace(/\\/g, "/"));
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

// --- 1. temp copy + a real git repo as the media worktree (an empty .media/.git directory is not acceptable:
//        the Designer checks for a git checkout, so we `git init` one)
const fixtureBefore = treeHash(FIXTURE);
const tmp = mkdtempSync(join(tmpdir(), "hoshlab-dry-run-"));
const companyDir = join(tmp, "company");
const mediaRoot = join(tmp, ".media");
cpSync(FIXTURE, companyDir, { recursive: true });
mkdirSync(mediaRoot, { recursive: true });
const init = spawnSync("git", ["init", "-q", mediaRoot], { encoding: "utf8", shell: false, windowsHide: true });
if (init.status !== 0) {
  out(`FAIL git init for the media worktree: ${init.stderr || init.stdout}`);
  process.exit(1);
}
// the fixture's rendered files, so QA can read the bytes of drafts that were rendered before this run
for (const id of readdirSync(FIXTURE_MEDIA)) {
  const src = join(FIXTURE_MEDIA, id);
  if (statSync(src).isDirectory()) cpSync(src, join(mediaRoot, "media", id), { recursive: true });
}
out(`dry-run-publish: temp copy ${companyDir}`);
out(`dry-run-publish: media worktree ${mediaRoot} (git init; .media/.git present = ${existsSync(join(mediaRoot, ".git"))})`);
const processEnv = { ...process.env, MOCK_LLM: "1", IG_DRY_RUN: "1" };
const quiet = () => {};

// --- 2. the daily run (CEO → Strategist → Writer → Designer → QA → inline rework loop)
const state0 = createState({ companyDir, now: DAILY_NOW });
const draftsBefore = new Set(state0.listDrafts());
const ideasBefore = state0.readJsonl("state/ideas.jsonl").length;
out("");
out(`== daily  (now ${DAILY_NOW}, MOCK_LLM=1)`);
const daily = await runDaily({ companyDir, mediaRoot, now: DAILY_NOW, processEnv, flags: {}, stdout: out });
const state = createState({ companyDir, now: DAILY_NOW });
const byName = Object.fromEntries(daily.agents.map((a) => [a.name, a]));
expect(daily.ok, `daily run ok (${daily.run.id})`);
expect(state.exists("state/memos/2026-W42.md") && parseMemo(state.readText("state/memos/2026-W42.md")) !== null, "CEO memo state/memos/2026-W42.md with a JSON block");
expect(state.readJsonl("state/ideas.jsonl").length > ideasBefore, `Strategist appended ideas (${ideasBefore} → ${state.readJsonl("state/ideas.jsonl").length} records)`);
const calendar = state.readJson("state/calendar.json");
expect(calendar.slots.length >= 14, `calendar.json has ${calendar.slots.length} slots (horizon ${calendar.horizonDays} days)`);
const newDrafts = state.listDrafts().filter((id) => !draftsBefore.has(id));
expect(newDrafts.length > 0, `Writer created ${newDrafts.length} drafts: ${newDrafts.join(", ")}`);
const designer = byName.designer;
const chromiumMissing = designer.skipped === undefined && !designer.ok && /Chromium|launch|browser/i.test(designer.note || "");
if (chromiumMissing) out("Designer: skipped — Chromium not available (drafts stay written; run `npx playwright install chromium` to render here)");
else expect(designer.ok && designer.skipped === undefined, `Designer rendered with Chromium: ${designer.note}`);
const statuses = newDrafts.map((id) => [id, state.readDraft(id).status]);
for (const [id, status] of statuses) out(`      ${id}: ${status}${state.readDraft(id).mock ? " (mock:true → QA fails it with mock_output, by design)" : ""}`);
if (!chromiumMissing) {
  expect(statuses.every(([, s]) => s === "rework" || s === "blocked"), "every mock draft failed QA with mock_output (none queued — M5.4)");
  expect(newDrafts.every((id) => state.readQa(id) && state.readQa(id).reasons.includes("mock_output")), "qa.json of every mock draft lists mock_output");
  const rendered = newDrafts.flatMap((id) => state.readDraft(id).media.map((m) => join(mediaRoot, m.path)));
  expect(rendered.length > 0 && rendered.every((p) => existsSync(p)), `${rendered.length} rendered files exist under the media worktree`);
}

// --- 3. the owner approves the queued rp draft (revision-matched; admin-owned file written as the admin would)
const rp = state.readDraft(RP);
const approval = { draftId: RP, decision: "approve", revision: rp.revision, at: "2026-10-14T19:40:00+05:30", by: "owner" };
writeFileSync(join(companyDir, "state", "approvals.jsonl"), readFileSync(join(companyDir, "state", "approvals.jsonl"), "utf8") + JSON.stringify(approval) + "\n", "utf8");
out("");
out(`== approve ${RP} revision ${rp.revision} (owner, 2026-10-14T19:40 IST)`);

// --- 4. the hourly publisher with the dry-run client
out("");
out(`== publish (now ${PUBLISH_NOW}, IG_DRY_RUN=1)`);
const publishedBefore = state.readJsonl("state/published.jsonl").length;
const pub = await runPublish({ companyDir, now: PUBLISH_NOW, processEnv, dryRun: true, stdout: out });
expect(pub.ok, `publish run ok (${pub.run.id})`);
const published = state.readJsonl("state/published.jsonl");
const mine = published.filter((p) => p.runId === pub.run.id);
expect(mine.length === 2, `2 published.jsonl lines from this run (${mine.map((p) => p.draftId).join(", ")}); ${publishedBefore} fixture lines before`);
expect(mine.every((p) => /^dry-[0-9a-f]{8}$/.test(p.igMediaId) && p.dryRun === true), "every new record has a dry- id and dryRun:true");
expect(mine.every((p) => /^https:\/\/www\.instagram\.com\/p\/DRYRUN[0-9a-f]{8}\/$/.test(p.permalink)), "every new record has a DRYRUN permalink");
for (const p of mine) out(`      ${p.draftId} → ${p.igMediaId} ${p.permalink} late=${p.late} mode=${p.mode}`);
if (pub.expired.length) out(`      expired by the publisher (slot more than 48 h ago): ${pub.expired.join(", ")}`);

// --- 5. every state file validates against its spec
out("");
out("== validate");
const tree = validateTree(companyDir);
expect(tree.ok, `${tree.files.length} state files validate against their specs${tree.ok ? "" : `: ${tree.errors.join(" | ")}`}`);
for (const e of tree.errors) out(`      ${e}`);
expect(treeHash(FIXTURE) === fixtureBefore, "the repo's fixture company is byte-identical (nothing in the repo changed)");

// --- 6. summary table
out("");
out("== summary");
const rows = [["step", "result"]];
for (const a of daily.agents) rows.push([`daily/${a.name}`, `${a.ok ? "ok" : "FAIL"} ${a.calls} calls $${a.costUsd.toFixed(4)}${a.skipped ? ` skipped:${a.skipped}` : ""} — ${a.note || ""}`]);
rows.push(["publish", pub.summary]);
rows.push(["drafts", `${draftsBefore.size} before → ${state.listDrafts().length} after (${newDrafts.length} new, mock:true)`]);
rows.push(["published", `${publishedBefore} fixture + ${mine.length} dry-run = ${published.length}`]);
rows.push(["state files", `${tree.files.length} validated, ${tree.errors.length} errors`]);
rows.push(["temp copy", companyDir]);
const w = Math.max(...rows.map((r) => r[0].length));
for (const [k, v] of rows) out(`  ${k.padEnd(w)}  ${v}`);
out("");
if (problems.length) {
  out(`dry-run-publish: FAILED — ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) out(`  - ${p}`);
  process.exit(1);
}
out("dry-run-publish: ok");
