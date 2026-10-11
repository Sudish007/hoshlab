// engine/agents/strategist.js — pure slot filling (cadence incl. the weekly reel slot now that features.reels is
// true — FEAT-201 / plan D22 —, minGapHours, overrides, M5 free / re-plan / drop) and runStrategist with the mock
// router: the engine creates ids and slots, the model only picks (design §3.1 step 4, §4.4, §4.5, §5; review M5.2, N3; plan D9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { APPROVAL_SPEC, CALENDAR_SPEC, IDEA_SPEC, OVERRIDE_SPEC, PUBLISHED_SPEC, USAGE_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { dowIst, hoursBetween } from "../engine/lib/time.js";
import { AgentOutputError, createRouter } from "../engine/llm/router.js";
import { AGENT, MAX_IDEA_ATTEMPTS, OUTPUT_SPEC, TERMINAL_SLOT_DRAFT_STATUSES, allowedFormats, applyOutput, autoAssign, cadenceSlots, fillCalendar, recentTitles, runStrategist, terminalReason, validateStrategistOutput, weeklyCadence } from "../engine/agents/strategist.js";
import { parseMemo } from "../engine/agents/ceo.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster, brands, charters } = company;
const NOW = "2026-10-12T05:31:00+05:30"; // Monday
const NOW_MS = Date.parse(NOW);
const DAY = 86400000;
const RUN_ID = "engine-daily-20261012-0531-abc123";
const SECRET_NAMES = Object.values(config.providers).map((p) => p.secret);
const FIX = join(ROOT, "tests", "fixtures");
const draftFixture = (name) => JSON.parse(readFileSync(join(FIX, "drafts", `${name}.json`), "utf8"));
const llm = (name) => JSON.parse(readFileSync(join(FIX, "llm", `${name}.json`), "utf8"));
const pageOf = (handle) => config.pages.find((p) => p.handle === handle);
const KD = pageOf("kaatdo");
const RP = pageOf("rishtapatra");

function idea(id, page, format, status, attempts = 0, extra = {}) {
  return { id, page, title: `Idea ${id}`, angle: "angle", format, language: "en", facts: [`${id.split("-")[0]}-f04`], status, attempts, createdAt: "2026-10-05T05:31:00+05:30", by: "strategist", runId: "engine-daily-20261005-0531-aaaaaa", ...extra };
}

function kdDraft(id, slotId, slotAt, format, status, extra = {}) {
  const base = draftFixture("kd-2026-10-13-six-rules");
  return { ...base, id, slotId, slotAt, format, status, media: [], ...extra };
}

function withPage(handle, patch) {
  const cfg = structuredClone(config);
  const page = cfg.pages.find((p) => p.handle === handle);
  Object.assign(page, typeof patch === "function" ? patch(page, cfg) : patch);
  return { cfg, page };
}

function harness({ now = NOW, processEnv = { MOCK_LLM: "1" } } = {}) {
  const dir = tmpDir("hoshlab-strategist-");
  const state = createState({ companyDir: dir, now });
  const router = createRouter({ config, roster, state, env: readEnv(SECRET_NAMES, {}), fetchImpl: () => Promise.reject(new Error("no network in tests")), now, runId: RUN_ID, charters, processEnv });
  return { dir, state, router, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cadence: every page gets backlogWeeks (2) weeks = 14 days of slots, each cadence entry twice, ids <handle>-<YYYY-MM-DD>-<HHMM>, formats per entry, all within the horizon (design §4.5)", () => {
  assert.equal(config.defaults.backlogWeeks, 2);
  for (const page of config.pages) {
    const r = fillCalendar({ config, page, now: NOW });
    assert.equal(r.horizonDays, 14);
    assert.equal(r.slots.length, page.cadence.slots.length * 2, `${page.handle}: ${page.cadence.slots.length} entries × 2 weeks`);
    assert.deepEqual(r.freed, []);
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.replanned, []);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.ideas, []);
    assert.equal(r.openSlots.length, r.slots.length, "no ideas yet → every slot is open");
    const times = r.slots.map((s) => Date.parse(s.at));
    assert.ok(times.every((t) => t >= NOW_MS && t < NOW_MS + 14 * DAY), "within [now, now + 14 d)");
    assert.ok(times[times.length - 1] - times[0] >= 7 * DAY, "the slots span into the second week");
    assert.deepEqual([...times].sort((a, b) => a - b), times, "time-ordered");
    for (const s of r.slots) {
      assert.equal(s.page, page.handle);
      assert.equal(s.status, "planned");
      assert.equal(s.draftId, undefined);
      assert.equal(s.ideaId, undefined);
      assert.match(s.slotId, new RegExp(`^${page.handle}-\\d{4}-\\d{2}-\\d{2}-\\d{4}$`));
      assert.ok(s.at.endsWith("+05:30"), "IST offset explicit");
      assert.ok(s.slotId.endsWith(s.at.slice(0, 10) + "-" + s.at.slice(11, 13) + s.at.slice(14, 16)), `${s.slotId} encodes ${s.at}`);
    }
    for (const entry of page.cadence.slots) {
      const mine = r.slots.filter((s) => dowIst(s.at) === entry.dow && s.at.slice(11, 16) === entry.time && s.format === entry.format);
      assert.equal(mine.length, 2, `${page.handle} ${entry.dow} ${entry.time} appears twice`);
      assert.equal(Date.parse(mine[1].at) - Date.parse(mine[0].at), 7 * DAY);
    }
    assertShape({ generatedAt: NOW, horizonDays: r.horizonDays, slots: r.slots }, CALENDAR_SPEC);
  }
  const rp = fillCalendar({ config, page: RP, now: NOW }).slots.map((s) => `${s.slotId}:${s.format}`);
  assert.deepEqual(rp, ["rishtapatra-2026-10-12-1930:image", "rishtapatra-2026-10-14-1930:carousel", "rishtapatra-2026-10-16-1930:image", "rishtapatra-2026-10-17-1930:reel", "rishtapatra-2026-10-19-1930:image", "rishtapatra-2026-10-21-1930:carousel", "rishtapatra-2026-10-23-1930:image", "rishtapatra-2026-10-24-1930:reel"], "FEAT-201: the Saturday reel slot is scheduled now that features.reels is true");
  // Monday 05:31 IST is before Monday 19:30, so this Monday's slot is included; a later `now` rolls to next week
  const later = fillCalendar({ config, page: RP, now: "2026-10-12T20:00:00+05:30" }).slots.map((s) => s.slotId);
  assert.equal(later[0], "rishtapatra-2026-10-14-1930");
  assert.ok(later.includes("rishtapatra-2026-10-26-1930"));
  // host time zone never matters: the same instant written in UTC gives the same slots
  assert.deepEqual(fillCalendar({ config, page: RP, now: new Date("2026-10-12T00:01:00Z") }).slots.map((s) => s.slotId), rp.map((x) => x.split(":")[0]));
  assert.equal(weeklyCadence(config, RP), 4, "three feed slots + the reel slot");
  assert.equal(weeklyCadence(config, pageOf("job_rez")), 5);
});

test("minGapHours: a cadence entry within 6 h of another slot on the same page is not created (reported in skipped); with a 1 h gap both appear", () => {
  const { cfg, page } = withPage("kaatdo", (p) => ({ cadence: { slots: [...p.cadence.slots, { dow: "tue", time: "10:00", format: "carousel" }] } }));
  assert.equal(cfg.defaults.minGapHours, 6);
  const r = fillCalendar({ config: cfg, page, now: NOW });
  assert.equal(r.slots.length, 8, "the 10:00 entry is dropped both weeks (4 cadence entries incl. the Sunday reel × 2 weeks)");
  assert.deepEqual(r.skipped.map((s) => s.slotId), ["kaatdo-2026-10-13-1000", "kaatdo-2026-10-20-1000"]);
  assert.match(r.skipped[0].reason, /within 6 h/);
  for (let i = 1; i < r.slots.length; i++) assert.ok(hoursBetween(r.slots[i - 1].at, r.slots[i].at) >= 6, "no two slots within 6 h");
  cfg.defaults.minGapHours = 1;
  const r2 = fillCalendar({ config: cfg, page, now: NOW });
  assert.equal(r2.slots.length, 10);
  assert.deepEqual(r2.skipped, []);
  // a slot moved by the owner also counts: a cadence slot landing within the gap of the moved one is skipped
  const { cfg: cfg3, page: page3 } = withPage("kaatdo", {});
  const draft = kdDraft("kd-2026-10-15-moved", "kaatdo-2026-10-15-0815", "2026-10-15T08:15:00+05:30", "image", "written");
  const calendar = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: "kaatdo-2026-10-15-0815", page: "kaatdo", at: "2026-10-15T08:15:00+05:30", format: "image", ideaId: "kd-i0001", draftId: draft.id, status: "written" }] };
  const override = { draftId: draft.id, slotAt: "2026-10-17T07:30:00+05:30", at: "2026-10-12T01:00:00+05:30", by: "owner" };
  assertShape(override, OVERRIDE_SPEC);
  const r3 = fillCalendar({ config: cfg3, page: page3, calendar, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled")], drafts: [draft], overrides: [override], now: NOW });
  assert.deepEqual(r3.skipped.map((s) => s.slotId), ["kaatdo-2026-10-17-1100"], "Saturday 11:00 is 3.5 h after the moved slot");
});

test("features.reels switch (N3, FEAT-201): the real config schedules the Saturday reel slot (two in a fortnight); with reels off the same cadence yields no reel slot and a reel idea is never auto-assigned", () => {
  const { cfg, page } = withPage("rishtapatra", {});
  assert.equal(cfg.features.reels, true, "Phase 2: reels are on (plan D22)");
  assert.ok(page.formats.includes("reel"));
  assert.deepEqual(page.cadence.slots.filter((s) => s.format === "reel"), [{ dow: "sat", time: "19:30", format: "reel" }]);
  const on = fillCalendar({ config: cfg, page, now: NOW });
  assert.equal(on.slots.length, 8);
  assert.deepEqual(on.slots.filter((s) => s.format === "reel").map((s) => s.slotId), ["rishtapatra-2026-10-17-1930", "rishtapatra-2026-10-24-1930"]);
  assert.deepEqual(allowedFormats(cfg, page), ["image", "carousel", "reel"]);
  assert.equal(weeklyCadence(cfg, page), 4);
  // a reel idea in the backlog is auto-assigned to a reel slot only (never to an image or carousel slot)
  const withIdea = fillCalendar({ config: cfg, page, calendar: { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: "rishtapatra-2026-10-17-1930", page: "rishtapatra", at: "2026-10-17T19:30:00+05:30", format: "reel", ideaId: "rp-i0001", draftId: "rp-gone", status: "rejected" }] }, ideas: [idea("rp-i0001", "rishtapatra", "reel", "scheduled"), idea("rp-i0002", "rishtapatra", "reel", "open")], drafts: [], now: NOW });
  const re = withIdea.slots.find((s) => s.slotId === "rishtapatra-2026-10-17-1930");
  assert.equal(re.ideaId, "rp-i0002", "the freed reel slot takes the other open reel idea");
  assert.ok(withIdea.slots.filter((s) => s.format !== "reel").every((s) => s.ideaId === undefined), "feed slots never take a reel idea");
  // the switch off: the same cadence produces no reel slot and the reel idea stays open
  cfg.features.reels = false;
  const off = fillCalendar({ config: cfg, page, now: NOW });
  assert.equal(off.slots.length, 6);
  assert.ok(off.slots.every((s) => s.format !== "reel"), "no reel slot");
  assert.deepEqual(allowedFormats(cfg, page), ["image", "carousel"]);
  assert.equal(weeklyCadence(cfg, page), 3);
  assert.deepEqual(cadenceSlots(cfg, page, NOW, 14).filter((s) => s.format === "reel"), []);
  const r3 = fillCalendar({ config: cfg, page, ideas: [idea("rp-i0001", "rishtapatra", "reel", "open")], now: NOW });
  assert.ok(r3.slots.every((s) => s.ideaId === undefined));
  assert.deepEqual(r3.ideas, [], "the reel idea is untouched (still open)");
});

test("overrides move a slot: the latest overrides.jsonl slotAt per draftId replaces `at`, the slotId stays, the cadence slot with that id is not duplicated, status derives from the draft", () => {
  const draft = kdDraft("kd-2026-10-15-moved", "kaatdo-2026-10-15-0815", "2026-10-15T08:15:00+05:30", "image", "queued");
  const calendar = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: "kaatdo-2026-10-15-0815", page: "kaatdo", at: "2026-10-15T08:15:00+05:30", format: "image", ideaId: "kd-i0001", draftId: draft.id, status: "rendered", reason: "memo priority 1" }] };
  const overrides = [
    { draftId: draft.id, slotAt: "2026-10-16T09:00:00+05:30", at: "2026-10-12T01:00:00+05:30", by: "owner" },
    { draftId: draft.id, slotAt: "2026-10-16T18:00:00+05:30", at: "2026-10-12T02:00:00+05:30", by: "owner" },
    { draftId: "kd-other", slotAt: "2026-10-20T18:00:00+05:30", at: "2026-10-12T02:00:00+05:30", by: "owner" },
  ];
  for (const o of overrides) assertShape(o, OVERRIDE_SPEC);
  const r = fillCalendar({ config, page: KD, calendar, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled")], drafts: [draft], overrides, now: NOW });
  const moved = r.slots.find((s) => s.slotId === "kaatdo-2026-10-15-0815");
  assert.ok(moved, "slotId unchanged");
  assert.equal(moved.at, "2026-10-16T18:00:00+05:30", "the latest override wins");
  assert.equal(moved.draftId, draft.id);
  assert.equal(moved.ideaId, "kd-i0001");
  assert.equal(moved.status, "queued", "status derived from the draft, not carried over");
  assert.equal(moved.reason, "memo priority 1");
  assert.equal(r.slots.filter((s) => s.slotId === "kaatdo-2026-10-15-0815").length, 1, "not duplicated by the cadence");
  assert.equal(r.slots.length, 8);
  assert.deepEqual(r.slots.map((s) => s.slotId), ["kaatdo-2026-10-13-0815", "kaatdo-2026-10-15-0815", "kaatdo-2026-10-17-1100", "kaatdo-2026-10-18-1100", "kaatdo-2026-10-20-0815", "kaatdo-2026-10-22-0815", "kaatdo-2026-10-24-1100", "kaatdo-2026-10-25-1100"]);
  assert.ok(Date.parse(r.slots[1].at) < Date.parse(r.slots[2].at), "ordered by the effective time");
  assert.deepEqual(r.ideas, [], "the idea stays scheduled");
  assert.equal(r.openSlots.length, 7);
});

test("M5 prove-by: one rejected draft 5 days out → slot freed and re-planned with another open idea; one blocked draft 1 day out → slot dropped; idea attempts +1, dropped at 2", () => {
  assert.equal(config.defaults.leadDays, 3);
  assert.deepEqual(TERMINAL_SLOT_DRAFT_STATUSES, ["rejected", "blocked", "failed", "expired"]);
  const rejected = kdDraft("kd-2026-10-17-limits", "kaatdo-2026-10-17-1100", "2026-10-17T11:00:00+05:30", "carousel", "rejected");
  const blocked = kdDraft("kd-2026-10-13-six-rules", "kaatdo-2026-10-13-0815", "2026-10-13T08:15:00+05:30", "image", "blocked");
  assert.ok(hoursBetween(NOW, rejected.slotAt) / 24 > 5 && hoursBetween(NOW, rejected.slotAt) / 24 < 5.5, "about 5 days out");
  assert.ok(hoursBetween(NOW, blocked.slotAt) / 24 > 1 && hoursBetween(NOW, blocked.slotAt) / 24 < 1.5, "about 1 day out");
  const ideas = [
    idea("kd-i0001", "kaatdo", "carousel", "scheduled", 0),
    idea("kd-i0002", "kaatdo", "image", "scheduled", 1),
    idea("kd-i0003", "kaatdo", "carousel", "open", 0, { createdAt: "2026-10-06T05:31:00+05:30" }),
    idea("kd-i0004", "kaatdo", "image", "open", 0),
  ];
  for (const i of ideas) assertShape(i, IDEA_SPEC);
  const calendar = {
    generatedAt: "2026-10-11T05:31:00+05:30",
    horizonDays: 14,
    slots: [
      { slotId: "kaatdo-2026-10-13-0815", page: "kaatdo", at: blocked.slotAt, format: "image", ideaId: "kd-i0002", draftId: blocked.id, status: "blocked" },
      { slotId: "kaatdo-2026-10-15-0815", page: "kaatdo", at: "2026-10-15T08:15:00+05:30", format: "image", status: "planned" },
      { slotId: "kaatdo-2026-10-17-1100", page: "kaatdo", at: rejected.slotAt, format: "carousel", ideaId: "kd-i0001", draftId: rejected.id, status: "rejected" },
    ],
  };
  assertShape(calendar, CALENDAR_SPEC);
  const r = fillCalendar({ config, page: KD, calendar, ideas, drafts: [rejected, blocked], now: NOW });
  assert.deepEqual(r.freed.map((f) => [f.slotId, f.draftId, f.reason]), [
    ["kaatdo-2026-10-13-0815", blocked.id, "blocked"],
    ["kaatdo-2026-10-17-1100", rejected.id, "rejected"],
  ]);
  assert.deepEqual(r.replanned, ["kaatdo-2026-10-17-1100"], "one re-planned slot");
  assert.deepEqual(r.dropped, ["kaatdo-2026-10-13-0815"], "one dropped slot");
  const re = r.slots.find((s) => s.slotId === "kaatdo-2026-10-17-1100");
  assert.equal(re.status, "planned");
  assert.equal(re.draftId, undefined);
  assert.equal(re.ideaId, "kd-i0003", "another open idea of the same format, not the failed one");
  assert.match(re.reason, /^re-planned: draft kd-2026-10-17-limits rejected 5\.2 days before the slot; idea kd-i0003 assigned from the backlog$/);
  const dr = r.slots.find((s) => s.slotId === "kaatdo-2026-10-13-0815");
  assert.equal(dr.status, "dropped");
  assert.equal(dr.draftId, undefined);
  assert.equal(dr.ideaId, undefined);
  assert.match(dr.reason, /^dropped: draft kd-2026-10-13-six-rules blocked 1\.1 days before the slot \(lead 3 days\)$/);
  const changed = Object.fromEntries(r.ideas.map((i) => [i.id, [i.status, i.attempts]]));
  assert.deepEqual(changed, {
    "kd-i0001": ["open", 1],
    "kd-i0002": ["dropped", 2],
    "kd-i0003": ["scheduled", 0],
  });
  assert.equal(MAX_IDEA_ATTEMPTS, 2);
  for (const i of r.ideas) assertShape(i, IDEA_SPEC);
  assert.ok(!("kd-i0004" in changed), "the untouched open image idea is not re-planned onto a fresh cadence slot by the pure function (the model picks)");
  assert.equal(r.slots.length, 8, "the five remaining cadence ids (incl. the two Sunday reel slots) are added");
  assert.deepEqual(r.openSlots.map((s) => s.slotId), ["kaatdo-2026-10-15-0815", "kaatdo-2026-10-18-1100", "kaatdo-2026-10-20-0815", "kaatdo-2026-10-22-0815", "kaatdo-2026-10-24-1100", "kaatdo-2026-10-25-1100"], "the dropped slot is not open");
  assertShape({ generatedAt: NOW, horizonDays: 14, slots: r.slots }, CALENDAR_SPEC);
});

test("terminal detection: a latest reject approval frees a queued draft; a slot more than expireAfterHours in the past frees as expired (M5.1); failed frees; published and live drafts stay; a missing draft file frees", () => {
  const queued = kdDraft("kd-2026-10-15-q", "kaatdo-2026-10-15-0815", "2026-10-15T08:15:00+05:30", "image", "queued");
  const approvals = [
    { draftId: queued.id, decision: "approve", revision: 1, at: "2026-10-11T10:00:00+05:30", by: "owner" },
    { draftId: queued.id, decision: "reject", revision: 1, at: "2026-10-11T11:00:00+05:30", by: "owner", reason: "Too salesy." },
  ];
  for (const a of approvals) assertShape(a, APPROVAL_SPEC);
  assert.equal(terminalReason(queued, { approvals, config, now: NOW }), "rejected");
  assert.equal(terminalReason(queued, { approvals: [approvals[0]], config, now: NOW }), null, "approve keeps it alive");
  assert.equal(config.defaults.expireAfterHours, 48);
  const stale = kdDraft("kd-2026-10-09-stale", "kaatdo-2026-10-09-0815", "2026-10-09T08:15:00+05:30", "image", "queued");
  assert.equal(terminalReason(stale, { approvals: [], config, now: NOW }), "expired", "70 h past the slot");
  assert.equal(terminalReason({ ...stale, slotAt: "2026-10-10T08:15:00+05:30" }, { approvals: [], config, now: NOW }), null, "45 h past: not yet expired");
  assert.equal(terminalReason({ ...stale, status: "published" }, { approvals: [], config, now: NOW }), null);
  assert.equal(terminalReason({ ...stale, status: "failed" }, { approvals: [], config, now: NOW }), "failed");
  assert.equal(terminalReason(null, {}), "missing");
  // in the calendar: the stale queued draft's slot is in the past → freed and dropped, the idea goes back to open
  const calendar = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: stale.slotId, page: "kaatdo", at: stale.slotAt, format: "image", ideaId: "kd-i0001", draftId: stale.id, status: "queued" }] };
  const r = fillCalendar({ config, page: KD, calendar, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled")], drafts: [stale], now: NOW });
  assert.deepEqual(r.freed, [{ slotId: stale.slotId, draftId: stale.id, reason: "expired" }]);
  assert.deepEqual(r.dropped, [stale.slotId]);
  assert.deepEqual(r.ideas.map((i) => [i.id, i.status, i.attempts]), [["kd-i0001", "open", 1]]);
  // a published slot in the past is kept (history inside the window) and its idea becomes used
  const done = kdDraft("kd-2026-10-08-done", "kaatdo-2026-10-08-0815", "2026-10-08T08:15:00+05:30", "image", "published");
  const cal2 = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: done.slotId, page: "kaatdo", at: done.slotAt, format: "image", ideaId: "kd-i0001", draftId: done.id, status: "queued" }] };
  const r2 = fillCalendar({ config, page: KD, calendar: cal2, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled")], drafts: [done], now: NOW });
  assert.equal(r2.slots[0].status, "published");
  assert.deepEqual(r2.ideas.map((i) => [i.id, i.status]), [["kd-i0001", "used"]]);
  // older than one horizon back → pruned; a past planned slot without a draft → pruned
  const cal3 = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: "kaatdo-2026-09-20-0815", page: "kaatdo", at: "2026-09-20T08:15:00+05:30", format: "image", draftId: "kd-old", status: "published" }, { slotId: "kaatdo-2026-10-10-0815", page: "kaatdo", at: "2026-10-10T08:15:00+05:30", format: "image", status: "planned" }] };
  const r3 = fillCalendar({ config, page: KD, calendar: cal3, drafts: [], now: NOW });
  assert.equal(r3.slots.length, 8);
  assert.ok(r3.slots.every((s) => !s.slotId.startsWith("kaatdo-2026-09") && s.slotId !== "kaatdo-2026-10-10-0815"));
  assert.deepEqual(r3.freed, []);
});

test("drafts the Writer created since the last calendar are linked to their slot by slotId (status derived from the draft, idea scheduled); the newest live draft wins; a terminal draft is never re-attached, so a slot is freed once", () => {
  const calendar = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: "kaatdo-2026-10-13-0815", page: "kaatdo", at: "2026-10-13T08:15:00+05:30", format: "image", ideaId: "kd-i0001", status: "planned" }] };
  const draft = kdDraft("kd-2026-10-13-six-rules", "kaatdo-2026-10-13-0815", "2026-10-13T08:15:00+05:30", "image", "written", { ideaId: "kd-i0001" });
  const r = fillCalendar({ config, page: KD, calendar, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled")], drafts: [draft], now: NOW });
  const s = r.slots.find((x) => x.slotId === "kaatdo-2026-10-13-0815");
  assert.equal(s.draftId, draft.id);
  assert.equal(s.ideaId, "kd-i0001");
  assert.equal(s.status, "written");
  assert.deepEqual(r.freed, []);
  assert.deepEqual(r.ideas, []);
  assert.equal(r.openSlots.some((x) => x.slotId === s.slotId), false);
  // no calendar yet: the generated cadence slot picks up the live draft and its idea
  const r2 = fillCalendar({ config, page: KD, ideas: [idea("kd-i0001", "kaatdo", "image", "open")], drafts: [draft], now: NOW });
  const s2 = r2.slots.find((x) => x.slotId === "kaatdo-2026-10-13-0815");
  assert.equal(s2.draftId, draft.id);
  assert.equal(s2.ideaId, "kd-i0001");
  assert.equal(s2.status, "written");
  assert.deepEqual(r2.ideas.map((i) => [i.id, i.status]), [["kd-i0001", "scheduled"]]);
  // two live drafts for one slot: the newest wins
  const newer = { ...draft, id: "kd-2026-10-13-six-rules-2", createdAt: "2026-10-12T05:35:00+05:30" };
  assert.equal(fillCalendar({ config, page: KD, drafts: [draft, newer], now: NOW }).slots.find((x) => x.slotId === "kaatdo-2026-10-13-0815").draftId, newer.id);
  // a blocked draft for an unlinked slot is not attached: nothing is freed, attempts stay, the slot stays open
  const blocked = { ...draft, status: "blocked" };
  const unlinked = { generatedAt: NOW, horizonDays: 14, slots: [{ slotId: "kaatdo-2026-10-13-0815", page: "kaatdo", at: "2026-10-13T08:15:00+05:30", format: "image", status: "planned" }] };
  const r4 = fillCalendar({ config, page: KD, calendar: unlinked, ideas: [idea("kd-i0001", "kaatdo", "image", "open", 1)], drafts: [blocked], now: NOW });
  assert.deepEqual(r4.freed, []);
  assert.deepEqual(r4.ideas, []);
  const s4 = r4.slots.find((x) => x.slotId === "kaatdo-2026-10-13-0815");
  assert.equal(s4.draftId, undefined);
  assert.equal(s4.status, "planned");
  assert.ok(r4.openSlots.some((x) => x.slotId === s4.slotId));
  // a slot freed on one run is not freed again on the next (the terminal draft stays unattached)
  const linked = { generatedAt: NOW, horizonDays: 14, slots: [{ ...unlinked.slots[0], ideaId: "kd-i0001", draftId: blocked.id, status: "blocked" }] };
  const run1 = fillCalendar({ config, page: KD, calendar: linked, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled")], drafts: [blocked], now: NOW });
  assert.deepEqual(run1.freed.map((f) => f.draftId), [blocked.id]);
  assert.deepEqual(run1.ideas.map((i) => [i.id, i.status, i.attempts]), [["kd-i0001", "open", 1]]);
  const run2 = fillCalendar({ config, page: KD, calendar: { generatedAt: NOW, horizonDays: 14, slots: run1.slots }, ideas: [idea("kd-i0001", "kaatdo", "image", "scheduled"), ...run1.ideas], drafts: [blocked], now: NOW });
  assert.deepEqual(run2.freed, [], "freed once");
  assert.deepEqual(run2.ideas, [], "attempts not counted twice");
});

test("validateStrategistOutput: unknown/disputed fact ids, a foreign language, an unknown format, a bad new:<i> index and an unknown idea id are errors; the ok fixtures have none", () => {
  const ctx = (handle) => ({ usableIds: new Set(brands[handle].usableFacts().map((f) => f.id)), languages: pageOf(handle).languages, formats: pageOf(handle).formats, openIdeaIds: new Set(["rp-i0001"]), handle });
  assert.deepEqual(validateStrategistOutput(llm("strategist.ok").output, ctx("rishtapatra")), []);
  assert.deepEqual(validateStrategistOutput(llm("strategist.ok.kaatdo").output, ctx("kaatdo")), []);
  assert.deepEqual(validateStrategistOutput(llm("strategist.ok.job_rez").output, ctx("job_rez")), []);
  const bad = {
    ideas: [
      { title: "a", angle: "b", format: "image", language: "hi", factIds: ["rp-f12"], hook: "h" },
      { title: "a", angle: "b", format: "image", language: "hi", factIds: [], hook: "h" },
      { title: "a", angle: "b", format: "image", language: "fr", factIds: ["kd-f04"], hook: "h" },
      { title: "a", angle: "b", format: "video", language: "en", factIds: ["rp-f04"], hook: "h" },
    ],
    assignments: [
      { slotId: "x", ideaId: "new:4", reason: "r" },
      { slotId: "x", ideaId: "rp-i0099", reason: "r" },
      { slotId: "x", ideaId: "rp-i0001", reason: "r" },
      { slotId: "x", ideaId: "new:0", reason: "r" },
    ],
  };
  assert.deepEqual(validateStrategistOutput(bad, ctx("rishtapatra")), [
    "$.ideas[0].factIds[0]: rp-f12 is not a usable fact of @rishtapatra",
    "$.ideas[1].factIds: at least one fact id is required",
    "$.ideas[2].factIds[0]: kd-f04 is not a usable fact of @rishtapatra",
    "$.ideas[2].language: fr is not a language of @rishtapatra (hi|en)",
    "$.ideas[3].format: video is not a format of @rishtapatra (image|carousel|reel)",
    "$.assignments[0].ideaId: new:4 does not index ideas (4 given)",
    "$.assignments[1].ideaId: rp-i0099 is neither new:<index> nor an open idea of @rishtapatra",
  ]);
});

test("runStrategist under MOCK_LLM=1: the engine creates the ids (rp-i0001…) and slots, 'new:0' is mapped to the generated id on the slot the model picked, the reel idea is accepted and auto-assigned to the Saturday reel slot (FEAT-201), calendar.json validates, one usage line mock:true, no network", async () => {
  const h = harness();
  try {
    const res = await runStrategist({ page: RP, brand: brands.rishtapatra, memo: llm("ceo.ok").output, state: h.state, router: h.router, config, now: NOW, runId: RUN_ID });
    assert.equal(res.modelCalled, true);
    assert.equal(res.mock, true);
    assert.equal(res.calls, 1);
    assert.equal(res.ideasAdded, 4, "four ideas offered, all accepted (reels are on)");
    assert.deepEqual(res.refused, [], "FEAT-201: the reel idea is no longer refused");
    assert.deepEqual(res.ignored, []);
    assert.deepEqual(
      res.assigned.map((a) => [a.slotId, a.ideaId, a.by]),
      [
        ["rishtapatra-2026-10-12-1930", "rp-i0001", "model"],
        ["rishtapatra-2026-10-14-1930", "rp-i0002", "model"],
        ["rishtapatra-2026-10-16-1930", "rp-i0003", "model"],
      ],
      "model picks honoured; new:<i> → engine ids",
    );
    assert.deepEqual(res.autoAssigned.map((a) => [a.slotId, a.ideaId, a.by]), [["rishtapatra-2026-10-17-1930", "rp-i0004", "engine"]], "the reel idea the model did not place goes to the first open reel slot (format match)");
    assert.deepEqual(res.openSlotsLeft, ["rishtapatra-2026-10-19-1930", "rishtapatra-2026-10-21-1930", "rishtapatra-2026-10-23-1930", "rishtapatra-2026-10-24-1930"]);
    assert.equal(res.note, "4 ideas, 8 slots, 4 assigned (1 from the backlog), 4 open");
    // ideas.jsonl: engine ids, status scheduled (assigned), facts from the model, runId/createdAt from the engine
    const ideas = h.state.readJsonl("state/ideas.jsonl");
    assert.deepEqual(ideas.map((i) => i.id), ["rp-i0001", "rp-i0002", "rp-i0003", "rp-i0004"]);
    for (const i of ideas) {
      assert.deepEqual(validate(i, IDEA_SPEC), { ok: true, errors: [] });
      assert.equal(i.page, "rishtapatra");
      assert.equal(i.status, "scheduled");
      assert.equal(i.attempts, 0);
      assert.equal(i.by, AGENT);
      assert.equal(i.runId, RUN_ID);
      assert.equal(i.createdAt, NOW);
    }
    assert.equal(ideas[0].title, "Free kundali, no account");
    assert.deepEqual(ideas[0].facts, ["rp-f04", "rp-f07", "rp-f05"]);
    assert.equal(ideas[0].language, "hi");
    assert.equal(ideas[1].format, "carousel");
    assert.deepEqual(ideas.filter((i) => i.format === "reel").map((i) => [i.id, i.title, i.status]), [["rp-i0004", "Tagline reel", "scheduled"]]);
    // calendar.json
    const cal = h.state.readJson("state/calendar.json", CALENDAR_SPEC);
    assert.equal(cal.generatedAt, NOW);
    assert.equal(cal.horizonDays, 14);
    assert.equal(cal.slots.length, 8);
    const first = cal.slots[0];
    assert.equal(first.slotId, "rishtapatra-2026-10-12-1930");
    assert.equal(first.ideaId, "rp-i0001");
    assert.equal(first.status, "planned");
    assert.equal(first.reason, "Monday image slot; memo priority 1: lead with the free product");
    assert.equal(first.draftId, undefined);
    assert.ok(cal.slots.every((s) => s.status === "planned"));
    assert.deepEqual(cal.slots.filter((s) => s.format === "reel").map((s) => [s.slotId, s.ideaId || null]), [["rishtapatra-2026-10-17-1930", "rp-i0004"], ["rishtapatra-2026-10-24-1930", null]]);
    assert.match(cal.slots.find((s) => s.slotId === "rishtapatra-2026-10-17-1930").reason, /^backlog idea rp-i0004 \(Tagline reel\)$/);
    // usage: one mock line for the strategist on this page
    const usage = h.state.readJsonl(h.state.monthLogPath("usage"));
    assert.equal(usage.length, 1);
    assert.equal(validate(usage[0], USAGE_SPEC).ok, true);
    assert.equal(usage[0].agent, AGENT);
    assert.equal(usage[0].page, "rishtapatra");
    assert.equal(usage[0].mock, true);

    // second run, same day: the fixture repeats → duplicate titles merge into the existing ideas,
    // its assignments point at slots that are no longer open → ignored; nothing new is appended
    const again = await runStrategist({ page: RP, brand: brands.rishtapatra, memo: llm("ceo.ok").output, state: h.state, router: h.router, config, now: NOW, runId: RUN_ID });
    assert.equal(again.modelCalled, true, "backlog target 8 open ideas not met → asked again");
    assert.equal(again.ideasAdded, 0);
    assert.equal(again.ignored.filter((x) => /duplicate title/.test(x.reason)).length, 4);
    assert.equal(again.ignored.filter((x) => x.reason === "not an open slot").length, 3);
    assert.equal(h.state.readJsonl("state/ideas.jsonl").length, 4, "no superseding records: nothing changed");
    assert.deepEqual(h.state.readJson("state/calendar.json", CALENDAR_SPEC).slots.map((s) => s.ideaId), cal.slots.map((s) => s.ideaId));

    // another page joins the same calendar; the first page's slots are untouched
    const kd = await runStrategist({ page: KD, brand: brands.kaatdo, memo: llm("ceo.ok").output, state: h.state, router: h.router, config, now: NOW, runId: RUN_ID });
    assert.equal(kd.ideasAdded, 4);
    assert.deepEqual(kd.assigned.map((a) => a.ideaId), ["kd-i0001", "kd-i0002", "kd-i0003"]);
    assert.deepEqual(kd.autoAssigned.map((a) => [a.slotId, a.ideaId]), [["kaatdo-2026-10-18-1100", "kd-i0004"]], "KaatDo's reel idea lands on the Sunday reel slot");
    const merged = h.state.readJson("state/calendar.json", CALENDAR_SPEC);
    assert.equal(merged.slots.length, 16);
    assert.deepEqual(merged.slots.filter((s) => s.page === "rishtapatra"), cal.slots);
    assert.equal(merged.slots.filter((s) => s.page === "kaatdo" && s.ideaId).length, 4);
    assert.deepEqual([...merged.slots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.page.localeCompare(b.page)), merged.slots, "time-ordered across pages");
    const kdIdeas = h.state.readJsonl("state/ideas.jsonl").filter((i) => i.page === "kaatdo");
    assert.deepEqual(kdIdeas.map((i) => i.id), ["kd-i0001", "kd-i0002", "kd-i0003", "kd-i0004"]);
  } finally {
    h.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("runStrategist: open backlog ideas are picked for the slots the model left open (auto-assign), ideas from the model that are already in the backlog are merged, and recentTitles come from published → draft → idea", async () => {
  const h = harness();
  try {
    // two open image ideas already in the backlog, one of them with the fixture's title
    const existing = [
      { ...idea("rp-i0007", "rishtapatra", "image", "open"), title: "Free kundali, no account", facts: ["rp-f04"] },
      { ...idea("rp-i0008", "rishtapatra", "image", "open"), title: "Older backlog idea", facts: ["rp-f05"], createdAt: "2026-10-01T05:31:00+05:30" },
    ];
    for (const i of existing) h.state.appendJsonl("state/ideas.jsonl", i, IDEA_SPEC);
    const res = await runStrategist({ page: RP, brand: brands.rishtapatra, memo: null, state: h.state, router: h.router, config, now: NOW, runId: RUN_ID });
    assert.equal(res.ideasAdded, 3, "the duplicate title merges into rp-i0007; the reel idea is accepted (FEAT-201)");
    assert.deepEqual(res.ignored.map((x) => x.reason), ["duplicate title of idea rp-i0007"]);
    const ids = h.state.readJsonl("state/ideas.jsonl").map((i) => i.id);
    assert.ok(ids.includes("rp-i0009") && ids.includes("rp-i0010") && ids.includes("rp-i0011"), "numbering continues after the highest existing id");
    assert.deepEqual(
      res.assigned.map((a) => [a.slotId, a.ideaId]),
      [
        ["rishtapatra-2026-10-12-1930", "rp-i0007"],
        ["rishtapatra-2026-10-14-1930", "rp-i0009"],
        ["rishtapatra-2026-10-16-1930", "rp-i0010"],
      ],
      "new:0 resolved to the merged existing idea",
    );
    assert.deepEqual(
      res.autoAssigned.map((a) => [a.slotId, a.ideaId, a.by]),
      [
        ["rishtapatra-2026-10-17-1930", "rp-i0011", "engine"],
        ["rishtapatra-2026-10-19-1930", "rp-i0008", "engine"],
      ],
      "the new reel idea fills the Saturday reel slot; the older open image idea fills the next open image slot",
    );
    assert.match(res.autoAssigned[1].reason, /^backlog idea rp-i0008 \(Older backlog idea\)$/);
    assert.deepEqual(res.openSlotsLeft, ["rishtapatra-2026-10-21-1930", "rishtapatra-2026-10-23-1930", "rishtapatra-2026-10-24-1930"]);
    const latest = new Map();
    for (const i of h.state.readJsonl("state/ideas.jsonl")) latest.set(i.id, i);
    assert.equal(latest.get("rp-i0007").status, "scheduled");
    assert.equal(latest.get("rp-i0008").status, "scheduled");
    assert.equal(latest.get("rp-i0007").runId, RUN_ID, "superseding record carries this run's id");
    assert.equal(h.state.readJsonl("state/ideas.jsonl").filter((i) => i.id === "rp-i0007").length, 2, "append-only: the later record supersedes");
    const cal = h.state.readJson("state/calendar.json", CALENDAR_SPEC);
    assert.equal(cal.slots.find((s) => s.slotId === "rishtapatra-2026-10-19-1930").reason, "backlog idea rp-i0008 (Older backlog idea)");
  } finally {
    h.cleanup();
  }
  // recentTitles
  const drafts = [{ id: "rp-2026-10-06-x", ideaId: "rp-i0001" }, { id: "rp-2026-10-08-y", ideaId: "rp-i0002" }];
  const ideas = [idea("rp-i0001", "rishtapatra", "image", "used", 0, { title: "First title" }), idea("rp-i0002", "rishtapatra", "image", "used", 0, { title: "Second title" })];
  const published = [
    { draftId: "rp-2026-10-08-y", page: "rishtapatra", publishedAt: "2026-10-08T19:31:00+05:30" },
    { draftId: "rp-2026-10-06-x", page: "rishtapatra", publishedAt: "2026-10-06T19:31:00+05:30" },
    { draftId: "rp-2026-10-07-z", page: "rishtapatra", publishedAt: "2026-10-07T19:31:00+05:30" },
    { draftId: "kd-2026-10-06-k", page: "kaatdo", publishedAt: "2026-10-06T08:16:00+05:30" },
  ];
  assert.deepEqual(recentTitles({ published, drafts, ideas, handle: "rishtapatra" }), ["First title", "rp-2026-10-07-z", "Second title"], "oldest first; a draft without an idea falls back to its id; other pages excluded");
  assert.deepEqual(recentTitles({ published, drafts, ideas, handle: "rishtapatra", limit: 1 }), ["Second title"]);
});

test("runStrategist: no open slot and a full backlog → the model is not called; a reel-only cadence has zero slots only while features.reels is false (two Sunday reel slots when it is on)", async () => {
  const h = harness();
  try {
    const { cfg, page } = withPage("kaatdo", { cadence: { slots: [{ dow: "sun", time: "11:00", format: "reel" }] } });
    const on = fillCalendar({ config: cfg, page, now: NOW });
    assert.deepEqual(on.slots.map((s) => `${s.slotId}:${s.format}`), ["kaatdo-2026-10-18-1100:reel", "kaatdo-2026-10-25-1100:reel"], "FEAT-201: reel slots exist with reels on");
    cfg.features.reels = false;
    const res = await runStrategist({ page, brand: brands.kaatdo, state: h.state, router: h.router, config: cfg, now: NOW, runId: RUN_ID });
    assert.equal(res.modelCalled, false);
    assert.equal(res.calls, 0);
    assert.deepEqual(res.slots, []);
    assert.equal(res.note, "0 ideas, 0 slots, model not called (backlog full)");
    assert.equal(h.state.exists("state/ideas.jsonl"), false);
    assert.deepEqual(h.state.readJson("state/calendar.json", CALENDAR_SPEC).slots, []);
    assert.equal(h.state.readJsonl(h.state.monthLogPath("usage")).length, 0);
    // without a router the pure parts still work when nothing is needed from the model
    const res2 = await runStrategist({ page, brand: brands.kaatdo, state: h.state, router: null, config: cfg, now: NOW });
    assert.equal(res2.modelCalled, false);
    await assert.rejects(runStrategist({ page: KD, brand: brands.kaatdo, state: h.state, router: null, config, now: NOW }), /router is required/);
  } finally {
    h.cleanup();
  }
});

test("strategist.bad (missing assignments) → one repair call → AgentOutputError propagates; nothing is written (no ideas.jsonl, no calendar.json); both attempts are usage lines", async () => {
  const h = harness({ processEnv: { MOCK_LLM: "1", MOCK_LLM_CASE_STRATEGIST: "bad" } });
  try {
    await assert.rejects(runStrategist({ page: RP, brand: brands.rishtapatra, state: h.state, router: h.router, config, now: NOW, runId: RUN_ID }), (e) => {
      assert.ok(e instanceof AgentOutputError, e.message);
      assert.equal(e.agent, AGENT);
      assert.equal(e.calls, 2);
      assert.ok(e.errors.some((x) => /\$\.assignments: required/.test(x)), e.errors.join("; "));
      return true;
    });
    assert.equal(h.state.exists("state/ideas.jsonl"), false);
    assert.equal(h.state.exists("state/calendar.json"), false);
    assert.equal(h.state.readJsonl(h.state.monthLogPath("usage")).length, 2);
  } finally {
    h.cleanup();
  }
});

test("applyOutput / autoAssign are deterministic and never touch a slot of the wrong format; the task JSON offers usable facts only and the memo priorities of the page", async () => {
  const ideaMap = new Map();
  const openSlots = fillCalendar({ config, page: RP, now: NOW }).openSlots;
  const out = applyOutput(llm("strategist.ok").output, { page: RP, prefix: RP.prefix, allIdeaIds: [], ideaMap, openSlots, reelsEnabled: true, at: NOW, runId: RUN_ID });
  assert.deepEqual(out.records.map((r) => r.id), ["rp-i0001", "rp-i0002", "rp-i0003", "rp-i0004"]);
  assert.deepEqual([...out.idMap.entries()], [["new:0", "rp-i0001"], ["new:1", "rp-i0002"], ["new:2", "rp-i0003"], ["new:3", "rp-i0004"]]);
  assert.equal(out.openLeft.length, 5, "8 slots, 3 placed by the model");
  assert.deepEqual(out.refused, []);
  // with reels off the same answer's reel idea is refused and new:3 maps to null
  const off = applyOutput(llm("strategist.ok").output, { page: RP, prefix: RP.prefix, allIdeaIds: [], ideaMap: new Map(), openSlots, reelsEnabled: false, at: NOW, runId: RUN_ID });
  assert.deepEqual(off.records.map((r) => r.id), ["rp-i0001", "rp-i0002", "rp-i0003"]);
  assert.deepEqual(off.refused.map((r) => [r.index, r.title, r.reason]), [[3, "Tagline reel", "reel: not built yet (features.reels is false)"]]);
  assert.deepEqual(off.idMap.get("new:3"), null);
  // a wrong-format pick is ignored, not applied
  const wrong = applyOutput({ ideas: [{ title: "T", angle: "a", format: "carousel", language: "en", factIds: ["rp-f04"], hook: "h" }], assignments: [{ slotId: "rishtapatra-2026-10-12-1930", ideaId: "new:0", reason: "r" }] }, { page: RP, prefix: RP.prefix, allIdeaIds: [], ideaMap: new Map(), openSlots, reelsEnabled: false, at: NOW, runId: RUN_ID });
  assert.deepEqual(wrong.assigned, []);
  assert.deepEqual(wrong.ignored.map((x) => x.reason), ["rp-i0001 is carousel, slot is image"]);
  const auto = autoAssign(wrong.openLeft, new Map(wrong.records.map((r) => [r.id, r])), wrong.referenced);
  assert.deepEqual(auto.map((a) => [a.slotId, a.ideaId]), [["rishtapatra-2026-10-14-1930", "rp-i0001"]], "the carousel idea lands on the carousel slot instead");
  // the task JSON through a recording router
  const calls = [];
  const recorder = {
    runId: RUN_ID,
    async complete(agent, args) {
      calls.push({ agent, args });
      const fx = llm("strategist.ok");
      return { json: structuredClone(fx.output), text: "", usage: fx.usage, costUsd: 0, provider: "mock", model: "mock", ms: 1, mock: true, calls: 1, repaired: false, raw: {}, failures: [] };
    },
  };
  const dir = tmpDir("hoshlab-strategist-task-");
  try {
    const state = createState({ companyDir: dir, now: NOW });
    const memo = parseMemo(`# memo\n\n\`\`\`json\n${JSON.stringify(llm("ceo.ok").output)}\n\`\`\`\n`);
    await runStrategist({ page: RP, brand: brands.rishtapatra, memo, state, router: recorder, config, now: NOW, runId: RUN_ID, feedbackDigest: "owner: fewer prices" });
    assert.equal(calls.length, 1);
    const { agent, args } = calls[0];
    assert.equal(agent, AGENT);
    assert.equal(args.spec, OUTPUT_SPEC);
    assert.equal(typeof args.validate, "function");
    assert.equal(args.context.page, RP);
    assert.equal(args.context.brand, brands.rishtapatra);
    assert.match(args.context.memoExcerpt, /^Memo 2026-W42 — priorities for @rishtapatra:\n1\. lead with the free product/);
    assert.equal(args.context.feedbackDigest, "owner: fewer prices");
    const task = args.task;
    assert.deepEqual(task.page, { handle: "rishtapatra", languages: ["hi", "en"], formats: ["image", "carousel", "reel"], reelsEnabled: true, cadence: RP.cadence.slots, minGapHours: 6, backlogWeeks: 2 });
    assert.deepEqual(task.priorities.map((p) => p.rank), [1, 2], "this page's priorities only, ranked");
    assert.deepEqual(task.pause, []);
    assert.ok(task.facts.some((f) => f.id === "rp-f08"));
    assert.ok(!task.facts.some((f) => f.id === "rp-f12"), "disputed excluded");
    assert.ok(task.pricing.some((p) => p.sku === "shubh-pass"));
    assert.deepEqual(task.openIdeas, []);
    assert.deepEqual(task.recentTitles, []);
    assert.deepEqual(task.slots.map((s) => s.slotId), ["rishtapatra-2026-10-12-1930", "rishtapatra-2026-10-14-1930", "rishtapatra-2026-10-16-1930", "rishtapatra-2026-10-17-1930", "rishtapatra-2026-10-19-1930", "rishtapatra-2026-10-21-1930", "rishtapatra-2026-10-23-1930", "rishtapatra-2026-10-24-1930"]);
    assert.deepEqual(Object.keys(task.slots[0]), ["slotId", "at", "format"]);
    assert.deepEqual(task.slots.filter((s) => s.format === "reel").length, 2, "the reel slots are offered to the model");
    assert.equal(task.needNewIdeas, 8, "backlogWeeks 2 × weekly cadence 4 (incl. the reel), no open ideas yet");
    assert.equal(task.feedback, "owner: fewer prices");
    // the validate hook flags a disputed fact
    assert.deepEqual(args.validate({ ideas: [{ title: "x", angle: "y", format: "image", language: "hi", factIds: ["rp-f12"], hook: "h" }], assignments: [] }), ["$.ideas[0].factIds[0]: rp-f12 is not a usable fact of @rishtapatra"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("published.jsonl / overrides / approvals are read from state by runStrategist (reject approval frees a slot and the idea comes back open)", async () => {
  const h = harness();
  try {
    const first = await runStrategist({ page: KD, brand: brands.kaatdo, state: h.state, router: h.router, config, now: NOW, runId: RUN_ID });
    assert.equal(first.assigned.length, 3);
    // a Writer draft for the Thursday slot, then the owner rejects it
    const draft = kdDraft("kd-2026-10-15-reconnect", "kaatdo-2026-10-15-0815", "2026-10-15T08:15:00+05:30", "image", "queued", { ideaId: "kd-i0002" });
    h.state.writeDraft(draft);
    const cal = h.state.readJson("state/calendar.json", CALENDAR_SPEC);
    const slot = cal.slots.find((s) => s.slotId === "kaatdo-2026-10-15-0815");
    slot.draftId = draft.id;
    h.state.writeJson("state/calendar.json", cal, CALENDAR_SPEC);
    const { writeFileSync } = await import("node:fs");
    const approval = { draftId: draft.id, decision: "reject", revision: 1, at: "2026-10-12T04:00:00+05:30", by: "owner", reason: "Not this week." };
    assertShape(approval, APPROVAL_SPEC);
    writeFileSync(join(h.dir, "state", "approvals.jsonl"), JSON.stringify(approval) + "\n", "utf8");
    const pub = { draftId: "kd-2026-10-06-six-rules", page: "kaatdo", igMediaId: "1", permalink: "https://www.instagram.com/p/x/", publishedAt: "2026-10-06T08:16:00+05:30", slotAt: "2026-10-06T08:15:00+05:30", late: false, mode: "approve_first", qaRevision: 1, format: "image", mediaUrlUsed: "raw", runId: "publisher-hourly-20261006-0816-aaaaaa" };
    h.state.appendJsonl("state/published.jsonl", pub, PUBLISHED_SPEC);

    // Tuesday 06:00 IST: the Thursday 08:15 slot is 2.1 days out (< leadDays 3)
    const second = await runStrategist({ page: KD, brand: brands.kaatdo, state: h.state, router: h.router, config, now: "2026-10-13T06:00:00+05:30", runId: RUN_ID });
    assert.deepEqual(second.freed, [{ slotId: "kaatdo-2026-10-15-0815", draftId: draft.id, reason: "rejected" }]);
    assert.deepEqual(second.dropped, ["kaatdo-2026-10-15-0815"], "2.1 days out < leadDays 3 → dropped");
    assert.deepEqual(second.replanned, []);
    assert.deepEqual(second.freedIdeas, ["kd-i0002"]);
    const latest = new Map();
    for (const i of h.state.readJsonl("state/ideas.jsonl")) latest.set(i.id, i);
    assert.equal(latest.get("kd-i0002").status, "open");
    assert.equal(latest.get("kd-i0002").attempts, 1);
    const cal2 = h.state.readJson("state/calendar.json", CALENDAR_SPEC);
    const dropped = cal2.slots.find((s) => s.slotId === "kaatdo-2026-10-15-0815");
    assert.equal(dropped.status, "dropped");
    assert.equal(dropped.draftId, undefined);
    assert.equal(dropped.ideaId, undefined);
    assert.ok(cal2.slots.filter((s) => s.page === "kaatdo").every((s) => s.status === "dropped" || s.status === "planned"));
    // the freed idea is open again but was not re-used in this run (freed ideas are not re-picked immediately)
    assert.ok(!cal2.slots.some((s) => s.ideaId === "kd-i0002"));
  } finally {
    h.cleanup();
  }
});
