// OF-7 / review M1 / P1-17: one set of cadence strings everywhere. The labels in company/config.json
// (schedule.engineLabel, publisherLabel, tokenRefreshLabel, actionsDelayNote) must appear byte-identically in
// README.md, in the built public HTML (Home status strip and Team rhythm strip at least) and in the comment line at
// the top of all five workflow files. Each label is the derivation of its cron (src/lib/labels.js cronLabel) and
// src/lib/company.js refuses a config whose label drifts. The fixture build that npm test makes has runs, so Home
// prints the strip; in the launch-day empty state Home prints '—' / 'No runs yet' (review M11) while About still
// carries all of them. 2026-10-12: the crons moved off the top of the hour (polish-cron) — the old strings
// ('Daily 05:30 IST', 'Hourly at :30 IST', 'Actions cron may start 10–30 min late') must be gone everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, DIST, htmlFiles, read } from "./helpers.js";
import { cronLabel } from "../src/lib/labels.js";
import { SCHEDULE_PAIRS, scheduleErrors } from "../src/lib/company.js";

const config = JSON.parse(readFileSync(join(ROOT, "company", "config.json"), "utf8"));
const { engineLabel, publisherLabel, tokenRefreshLabel, actionsDelayNote } = config.schedule;
const STRINGS = { engineLabel, publisherLabel, actionsDelayNote };
const WORKFLOWS = ["pages.yml", "ci.yml", "engine-daily.yml", "publisher-hourly.yml", "token-refresh.yml"];
// The strings of the top-of-hour cadence that was live until 2026-10-12; none may survive anywhere a reader sees.
const OLD = ["Daily 05:30 IST", "Hourly at :30 IST", "Actions cron may start 10–30 min late", "Actions cron may start 10-30 min late", "Mondays 07:30 IST"];

test("the pinned strings (plan D1, off-peak since 2026-10-12): 'Daily 05:53 IST', 'Hourly at :47 IST', 'Mondays 07:43 IST' and the honest delay note; each label is cronLabel(cron)", () => {
  assert.equal(config.schedule.engineCron, "23 0 * * *");
  assert.equal(engineLabel, "Daily 05:53 IST");
  assert.equal(config.schedule.publisherCron, "17 * * * *");
  assert.equal(publisherLabel, "Hourly at :47 IST");
  assert.equal(config.schedule.tokenRefreshCron, "13 2 * * 1");
  assert.equal(tokenRefreshLabel, "Mondays 07:43 IST");
  assert.equal(actionsDelayNote, "GitHub may delay or skip scheduled runs; a due slot posts at the next run that fires");
  for (const [cronKey, labelKey] of SCHEDULE_PAIRS) assert.equal(cronLabel(config.schedule[cronKey]), config.schedule[labelKey], `${labelKey} is derived from ${cronKey}`);
  assert.deepEqual(scheduleErrors(config.schedule), []);
  // no cron sits on the top of the hour any more (GitHub's documented high-load minute)
  for (const [cronKey] of SCHEDULE_PAIRS) assert.notEqual(config.schedule[cronKey].split(" ")[0], "0", `${cronKey} is off the top of the hour`);
  // the fixture configs the dist is built from carry the same schedule block
  for (const fx of ["company-populated", "company-empty"]) {
    const fixture = JSON.parse(read(join(ROOT, "tests", "fixtures", fx, "config.json")));
    assert.deepEqual(fixture.schedule, config.schedule, fx);
  }
});

test("README.md carries the labels and the delay note verbatim, the three crons, the observed first-day numbers, and none of the old strings", () => {
  const readme = read(join(ROOT, "README.md"));
  for (const [key, s] of Object.entries({ ...STRINGS, tokenRefreshLabel })) assert.ok(readme.includes(s), `README lacks ${key} ${JSON.stringify(s)}`);
  for (const [cronKey] of SCHEDULE_PAIRS) assert.ok(readme.includes(`\`${config.schedule[cronKey]}\``), `README lacks cron ${config.schedule[cronKey]}`);
  for (const s of OLD) assert.ok(!readme.includes(s), `README still says ${JSON.stringify(s)}`);
  assert.ok(!/\b05:30 IST\b/.test(readme), "README no longer names the 05:30 IST engine time");
  // the honest Limits paragraph: GitHub's documented behaviour, the observed numbers with their dates, the move, no promise
  const limits = readme.slice(readme.indexOf("- **Schedules drift.**"), readme.indexOf("\n- **", readme.indexOf("- **Schedules drift.**") + 5));
  for (const s of ["GitHub may delay or skip scheduled runs", "high load", "start of every hour", "dropped", "3 of ~20", "2026-10-11 10:00 UTC", "2026-10-12 06:52 UTC", "03:01 UTC", "3 hours late", "moved off the top of the hour", "`23 0 * * *`", "`17 * * * *`", "`13 2 * * 1`", "reduces the risk; it does not remove it", "never posted early"]) {
    assert.ok(limits.includes(s), `Limits → Schedules drift lacks ${JSON.stringify(s)}`);
  }
  assert.ok(!/fix(es|ed) (it|the (drops|delays))/.test(limits), "the paragraph promises no fix");
});

test("public HTML: Home status strip has the engine + publisher labels and the delay note, Team rhythm strip has the engine and publisher labels, About has all four; the union over every public page has each; no old string anywhere", () => {
  const home = read(join(DIST, "index.html"));
  for (const [key, s] of Object.entries(STRINGS)) assert.ok(home.includes(s), `Home lacks ${key} ${JSON.stringify(s)}`);
  const team = read(join(DIST, "team", "index.html"));
  assert.ok(team.includes(engineLabel), "Team rhythm strip lacks the engine label");
  assert.ok(team.includes(publisherLabel), "Team rhythm strip lacks the publisher label");
  const about = read(join(DIST, "about", "index.html"));
  for (const [key, s] of Object.entries({ ...STRINGS, tokenRefreshLabel })) assert.ok(about.includes(s), `About lacks ${key} ${JSON.stringify(s)}`);
  const admin = read(join(DIST, "admin", "index.html"));
  assert.ok(admin.includes(publisherLabel) && admin.includes(actionsDelayNote), "the admin lock help names the publisher cadence and the delay note");
  for (const s of OLD) assert.ok(!admin.includes(s), `admin still says ${JSON.stringify(s)}`);
  const seen = { engineLabel: [], publisherLabel: [], actionsDelayNote: [] };
  for (const f of htmlFiles()) {
    const rel = relative(DIST, f).replace(/\\/g, "/");
    if (rel.startsWith("admin/")) continue;
    const t = read(f);
    for (const [key, s] of Object.entries(STRINGS)) if (t.includes(s)) seen[key].push(rel);
    // no drifted variants and no old strings on the public surface
    assert.ok(!/Hourly at :\d\d(?! IST)/.test(t), `${rel}: publisher label without ' IST'`);
    assert.ok(!/Daily \d\d:\d\d(?! IST)/.test(t), `${rel}: engine label without ' IST'`);
    for (const s of OLD) assert.ok(!t.includes(s), `${rel}: still says ${JSON.stringify(s)}`);
    assert.ok(!/\b05:30 IST\b/.test(t), `${rel}: names the old 05:30 IST engine time`);
  }
  for (const [key, pages] of Object.entries(seen)) assert.ok(pages.length >= 2, `${key} appears on ${pages.length} public page(s): ${pages.join(", ")}`);
});

test("all five workflow files carry the strings in one comment line, verbatim, with both crons; the schedule: cron of each state workflow is the config's; no old string", () => {
  for (const f of WORKFLOWS) {
    const text = read(join(ROOT, ".github", "workflows", f));
    const line = text.split(/\r?\n/).find((l) => l.startsWith("#") && l.includes(engineLabel));
    assert.ok(line, `${f}: no comment line with the engine label`);
    for (const [key, s] of Object.entries(STRINGS)) assert.ok(line.includes(s), `${f}: cadence comment lacks ${key} ${JSON.stringify(s)}: ${line}`);
    assert.ok(line.includes(`cron ${config.schedule.engineCron}`) && line.includes(`cron ${config.schedule.publisherCron}`), `${f}: the comment names both crons: ${line}`);
    for (const s of OLD) assert.ok(!text.includes(s), `${f}: still says ${JSON.stringify(s)}`);
  }
  const cronOf = (f) => (read(join(ROOT, ".github", "workflows", f)).match(/^\s+- cron: "([^"]+)"$/m) || [])[1];
  assert.equal(cronOf("engine-daily.yml"), config.schedule.engineCron);
  assert.equal(cronOf("publisher-hourly.yml"), config.schedule.publisherCron);
  assert.equal(cronOf("token-refresh.yml"), config.schedule.tokenRefreshCron);
  assert.ok(read(join(ROOT, ".github", "workflows", "token-refresh.yml")).includes(`# Token refresh: ${tokenRefreshLabel} (cron ${config.schedule.tokenRefreshCron})`), "token-refresh.yml states its own cadence beside the shared line");
  // the Publisher's charter (shown in the admin's charter editor) names the same publisher minute and the honest note
  for (const dir of [join(ROOT, "company"), join(ROOT, "tests", "fixtures", "company-populated"), join(ROOT, "tests", "fixtures", "company-empty")]) {
    const charter = read(join(dir, "charters", "publisher.md"));
    assert.ok(charter.includes(`fires at ${publisherLabel.replace("Hourly at ", "")}`), `${dir}: publisher charter names ${publisherLabel}`);
    for (const s of [...OLD, "10–30 minutes late"]) assert.ok(!charter.includes(s), `${dir}: publisher charter still says ${JSON.stringify(s)}`);
  }
});
