import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, COMPANY_DIR } from "./helpers.js";
import { CONFIG_SPEC, validate } from "../engine/lib/schema.js";
import { cronMinuteToIst, cronTimeToIst } from "../engine/lib/time.js";

const real = JSON.parse(readFileSync(join(ROOT, "company", "config.json"), "utf8"));
const fixture = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
const configs = { "company/config.json": real, "fixture config.json": fixture };

for (const [label, config] of Object.entries(configs)) {
  test(`${label} validates against CONFIG_SPEC (with cross-field rules)`, () => {
    const r = validate(config, CONFIG_SPEC);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  test(`${label}: M1 — the publisher cron minute converted to IST appears in publisherLabel; engine label matches engineCron`, () => {
    const minute = cronMinuteToIst(config.schedule.publisherCron);
    assert.equal(minute, 30);
    assert.ok(config.schedule.publisherLabel.includes(`:${String(minute).padStart(2, "0")}`), `${config.schedule.publisherLabel} contains :${minute}`);
    assert.equal(config.schedule.publisherLabel, "Hourly at :30 IST");
    assert.equal(config.schedule.publisherCron, "0 * * * *");
    assert.equal(config.schedule.engineCron, "0 0 * * *");
    assert.ok(config.schedule.engineLabel.includes(cronTimeToIst(config.schedule.engineCron)), `${config.schedule.engineLabel} contains ${cronTimeToIst(config.schedule.engineCron)}`);
    assert.equal(config.schedule.engineLabel, "Daily 05:30 IST");
    assert.equal(config.schedule.actionsDelayNote, "Actions cron may start 10–30 min late");
  });

  test(`${label}: N3 features.reels present and false; D9/M15 defaults; ig.version pinned with its source (D5)`, () => {
    assert.equal(config.features.reels, false);
    assert.equal(config.defaults.expireAfterHours, 48);
    assert.equal(config.defaults.altTextMax, 100);
    assert.equal(config.defaults.captionMax, 2200);
    assert.equal(config.defaults.hashtagCap, 8);
    assert.equal(config.budget.monthlyUsd, 25);
    assert.equal(config.budget.hardStop, true);
    assert.match(config.ig.version, /^v\d+\.\d+$/);
    assert.equal(config.ig.version, "v26.0", "FEAT-107: newest version on Meta's changelog on 2026-10-10 (introduced July 29, 2026)");
    assert.equal(config.ig.versionSource, "https://developers.facebook.com/docs/graph-api/changelog");
    assert.equal(config.ig.versionVerifiedAt, "2026-10-10");
    assert.equal(config.company.owner, "Sudish Kumar");
    assert.equal(config.company.ownerGithub, "Sudish007");
    assert.equal(config.site.basePath, "/hoshlab/");
    assert.equal(config.site.url, "https://sudish007.github.io/hoshlab");
  });

  test(`${label}: cadence — slots ≤ 7/week per page, every slot.format ∈ page.formats, no reel slots while features.reels is false, unique handles/prefixes`, () => {
    const handles = new Set();
    const prefixes = new Set();
    for (const page of config.pages) {
      assert.ok(!handles.has(page.handle), `duplicate handle ${page.handle}`);
      assert.ok(!prefixes.has(page.prefix), `duplicate prefix ${page.prefix}`);
      handles.add(page.handle);
      prefixes.add(page.prefix);
      assert.ok(page.cadence.slots.length >= 1 && page.cadence.slots.length <= 7, `${page.handle}: ${page.cadence.slots.length} slots`);
      for (const slot of page.cadence.slots) {
        assert.ok(page.formats.includes(slot.format), `${page.handle}: slot format ${slot.format} in ${page.formats}`);
        if (!config.features.reels) assert.notEqual(slot.format, "reel", `${page.handle}: reel slot while features.reels is false`);
        assert.match(slot.time, /^(?:[01]\d|2[0-3]):[0-5]\d$/);
      }
      assert.equal(page.mode, "approve_first");
      assert.equal(page.igUserId, "");
      assert.equal(page.appScopedId, "");
      assert.equal(page.modeChangedBy, "owner");
    }
    assert.deepEqual([...handles], ["rishtapatra", "kaatdo", "job_rez"]);
    assert.deepEqual([...prefixes], ["rp", "kd", "jr"]);
    assert.equal(config.pages.reduce((n, p) => n + p.cadence.slots.length, 0), 10);
  });
}

test("CONFIG_SPEC rejects a slot format outside page.formats, a reel-only slot list on a page without reel, a config without features.reels, a 7+ slot cadence", () => {
  const c1 = structuredClone(real);
  c1.pages[0].formats = ["image", "carousel"];
  c1.pages[0].cadence.slots[0].format = "reel";
  assert.ok(validate(c1, CONFIG_SPEC).errors.some((e) => e.includes("not in page formats")));
  const c2 = structuredClone(real);
  delete c2.features.reels;
  assert.ok(validate(c2, CONFIG_SPEC).errors.some((e) => e.includes("features.reels")));
  const c3 = structuredClone(real);
  c3.pages[0].cadence.slots = Array.from({ length: 8 }, (_, i) => ({ dow: "mon", time: `0${i}:00`, format: "image" }));
  assert.ok(validate(c3, CONFIG_SPEC).errors.some((e) => e.includes("at most 7")));
});

test("fixture config equals the real config except the fixed modeChangedAt dates", () => {
  const strip = (c) => {
    const x = structuredClone(c);
    for (const p of x.pages) delete p.modeChangedAt;
    return x;
  };
  assert.deepEqual(strip(fixture), strip(real));
  for (const p of fixture.pages) assert.equal(p.modeChangedAt, "2026-10-01T09:00:00+05:30");
});

test("site.config.js derives its values from the configured company (no fallback object)", async () => {
  const mod = await import("../site.config.js");
  const site = mod.default;
  assert.equal(site.fallback, undefined);
  assert.equal(site.siteUrl, fixture.site.url);
  assert.equal(site.basePath, fixture.site.basePath);
  assert.equal(site.title, "Hoshlab");
  assert.equal(site.titleDevanagari, "होशलैब");
  assert.deepEqual(site.repo, fixture.repo);
  const src = readFileSync(join(ROOT, "site.config.js"), "utf8");
  assert.doesNotMatch(src, /FALLBACK|existsSync/, "FEAT-101 fallback removed");
});
