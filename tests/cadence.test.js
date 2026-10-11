// OF-7 / review M1 / P1-17: one set of cadence strings everywhere. The three labels in company/config.json
// (schedule.engineLabel, publisherLabel, actionsDelayNote) must appear byte-identically in README.md, in
// the built public HTML (Home status strip and Team rhythm strip at least) and in the comment line at the
// top of all four workflow files. The fixture build that npm test makes has runs, so Home prints the strip;
// in the launch-day empty state Home prints '—' / 'No runs yet' (review M11) while About still carries all three.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, DIST, htmlFiles, read } from "./helpers.js";

const config = JSON.parse(readFileSync(join(ROOT, "company", "config.json"), "utf8"));
const { engineLabel, publisherLabel, actionsDelayNote } = config.schedule;
const STRINGS = { engineLabel, publisherLabel, actionsDelayNote };
const WORKFLOWS = ["pages.yml", "ci.yml", "engine-daily.yml", "publisher-hourly.yml"];

test("the pinned strings (plan D1): 'Daily 05:30 IST', 'Hourly at :30 IST', 'Actions cron may start 10–30 min late' with the en dash", () => {
  assert.equal(engineLabel, "Daily 05:30 IST");
  assert.equal(publisherLabel, "Hourly at :30 IST");
  assert.equal(actionsDelayNote, "Actions cron may start 10\u201330 min late");
  // the fixture config the dist was built from carries the same schedule block
  const fixture = JSON.parse(read(join(ROOT, "tests", "fixtures", "company-populated", "config.json")));
  assert.deepEqual(fixture.schedule, config.schedule);
});

test("README.md carries all three strings verbatim", () => {
  const readme = read(join(ROOT, "README.md"));
  for (const [key, s] of Object.entries(STRINGS)) assert.ok(readme.includes(s), `README lacks ${key} ${JSON.stringify(s)}`);
  assert.ok(!/Actions cron may start 10-30 min late/.test(readme), "README must use the en dash of the config string, not a hyphen");
});

test("public HTML: Home status strip has all three, Team rhythm strip has the engine and publisher labels, About has all three; the union over every public page has all three", () => {
  const home = read(join(DIST, "index.html"));
  for (const [key, s] of Object.entries(STRINGS)) assert.ok(home.includes(s), `Home lacks ${key} ${JSON.stringify(s)}`);
  const team = read(join(DIST, "team", "index.html"));
  assert.ok(team.includes(engineLabel), "Team rhythm strip lacks the engine label");
  assert.ok(team.includes(publisherLabel), "Team rhythm strip lacks the publisher label");
  const about = read(join(DIST, "about", "index.html"));
  for (const [key, s] of Object.entries(STRINGS)) assert.ok(about.includes(s), `About lacks ${key} ${JSON.stringify(s)}`);
  const admin = read(join(DIST, "admin", "index.html"));
  assert.ok(admin.includes(publisherLabel) && admin.includes(actionsDelayNote), "the admin lock help names the publisher cadence and the delay note");
  const seen = { engineLabel: [], publisherLabel: [], actionsDelayNote: [] };
  for (const f of htmlFiles()) {
    const rel = relative(DIST, f).replace(/\\/g, "/");
    if (rel.startsWith("admin/")) continue;
    const t = read(f);
    for (const [key, s] of Object.entries(STRINGS)) if (t.includes(s)) seen[key].push(rel);
    // no drifted variants on the public surface
    assert.ok(!/Hourly at :30(?! IST)/.test(t), `${rel}: publisher label without ' IST'`);
    assert.ok(!/Daily 05:30(?! IST)/.test(t), `${rel}: engine label without ' IST'`);
    assert.ok(!/10-30 min late/.test(t), `${rel}: delay note with a hyphen instead of the en dash`);
  }
  for (const [key, pages] of Object.entries(seen)) assert.ok(pages.length >= 2, `${key} appears on ${pages.length} public page(s): ${pages.join(", ")}`);
});

test("all four workflow files carry the three strings in one comment line, verbatim", () => {
  for (const f of WORKFLOWS) {
    const text = read(join(ROOT, ".github", "workflows", f));
    const line = text.split(/\r?\n/).find((l) => l.startsWith("#") && l.includes(engineLabel));
    assert.ok(line, `${f}: no comment line with the engine label`);
    for (const [key, s] of Object.entries(STRINGS)) assert.ok(line.includes(s), `${f}: cadence comment lacks ${key} ${JSON.stringify(s)}: ${line}`);
    assert.ok(line.includes(`cron ${config.schedule.engineCron}`) && line.includes(`cron ${config.schedule.publisherCron}`), `${f}: the comment names both crons: ${line}`);
  }
});
