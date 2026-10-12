// The REAL company/ built into a temp DIST_DIR with the real clock (exactly what `npm run build` and pages.yml do):
// the Activity page may name only the run-log month files that exist under company/state/runs/. On 2026-10-12 the live
// page said "(October 2026 and September 2026)" while no September file existed (polish-cron, defect 2); this test
// computes the expected words from the files on disk, so it stays true as the bot adds months.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, read, tmpDir } from "./helpers.js";
import { istMonthKey } from "../engine/lib/time.js";
import { monthName, previousMonth } from "../src/lib/dates.js";
import { monthFilesWords } from "../src/templates/activity.js";

const REAL = join(ROOT, "company");
let dist;
let build;
let startedAt;

before(() => {
  dist = join(tmpDir("hoshlab-dist-real-"), "dist");
  startedAt = new Date();
  build = spawnSync(process.execPath, [join(ROOT, "src", "build.js")], {
    cwd: ROOT,
    encoding: "utf8",
    // BUILD_NOW empty → the real clock (scripts/test.mjs pins it for the fixture build only); no media copy needed here
    env: { ...process.env, COMPANY_DIR: REAL, MEDIA_DIR: join(dist, "..", "no-media"), DIST_DIR: dist, BUILD_NOW: "" },
  });
});

// The month keys the build reads (current + previous, IST) that have a file, newest first — the same rule as src/build.js loadState.
function existingRunMonths(now) {
  const monthKey = istMonthKey(now);
  return [monthKey, previousMonth(monthKey)].filter((k) => existsSync(join(REAL, "state", "runs", `${k}.jsonl`)));
}

test("the real company/ builds with the real clock", () => {
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.ok(existsSync(join(dist, "activity", "index.html")));
});

test("Activity names only the run-log month files that exist (singular with one file, both with two, none with none)", () => {
  const html = read(join(dist, "activity", "index.html"));
  const months = existingRunMonths(startedAt);
  // the build's own clock is a few seconds later; both agree unless the test straddles an IST month boundary
  assert.deepEqual(existingRunMonths(new Date()), months, "the test did not straddle a month boundary");
  const words = monthFilesWords(months);
  assert.ok(html.includes(`One record per engine or publisher run from the run log${words.list}, newest first.`), `lede with ${JSON.stringify(words.list)}`);
  if (months.length === 0) assert.ok(html.includes("The run log has no month file yet."));
  else assert.ok(html.includes(`Counted over ${words.files} of the run log${words.list}.`), `summary note: ${words.files}`);
  // every month file on disk that the build reads is named; every month it names has a file
  const named = [...html.matchAll(/run log \(([^)]+)\)/g)].flatMap((m) => m[1].split(" and "));
  assert.deepEqual([...new Set(named)], months.map(monthName), "named months = existing files");
  assert.ok(!html.includes("two most recent month files") || months.length === 2, "the plural only with two files");
  assert.ok(!html.includes("the most recent month file") || months.length === 1, "the singular only with one file");
  // the files on disk are what the sentence counts
  const onDisk = existsSync(join(REAL, "state", "runs")) ? readdirSync(join(REAL, "state", "runs")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, 7)) : [];
  for (const k of months) assert.ok(onDisk.includes(k), `${k}.jsonl exists`);
});
