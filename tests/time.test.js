import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.js";
import { addDays, addHours, cronMinuteToIst, cronTimeToIst, dowIst, hoursBetween, isoWeekId, istDate, istDateTime, istMonthKey, istTime, nextCadenceSlots, nowIst, parseIso, slotIdFor } from "../engine/lib/time.js";

const T = new Date("2026-10-12T00:01:00Z"); // 05:31 IST, Monday

test("nowIst / istDate / istTime / istMonthKey / dowIst are IST regardless of the host zone", () => {
  assert.equal(nowIst(T), "2026-10-12T05:31:00+05:30");
  assert.equal(istDate(T), "2026-10-12");
  assert.equal(istTime(T), "05:31");
  assert.equal(istMonthKey(T), "2026-10");
  assert.equal(dowIst(T), "mon");
  // 23:50 IST on 31 Oct is 18:20 UTC; 00:10 IST on 1 Nov is 18:40 UTC on 31 Oct (M9 fixture clocks)
  assert.equal(istMonthKey("2026-10-31T23:50:00+05:30"), "2026-10");
  assert.equal(istMonthKey("2026-11-01T00:10:00+05:30"), "2026-11");
  assert.equal(istMonthKey(new Date("2026-10-31T18:40:00Z")), "2026-11");
  assert.equal(istDate(new Date("2026-12-31T19:00:00Z")), "2027-01-01");
  assert.equal(dowIst(new Date("2026-10-18T19:00:00Z")), "mon");
  assert.equal(nowIst(new Date("2026-10-14T14:00:00Z")), "2026-10-14T19:30:00+05:30");
});

test("istDateTime builds the instant for an IST wall clock", () => {
  assert.equal(istDateTime(2026, 10, 14, 19, 30).toISOString(), "2026-10-14T14:00:00.000Z");
  assert.equal(nowIst(istDateTime(2026, 1, 1)), "2026-01-01T00:00:00+05:30");
});

test("isoWeekId: ISO-8601 weeks of the IST date (N7), incl. year boundaries", () => {
  assert.equal(isoWeekId("2026-10-12T05:30:00+05:30"), "2026-W42");
  assert.equal(isoWeekId("2026-10-18T23:59:59+05:30"), "2026-W42");
  assert.equal(isoWeekId("2026-10-19T00:00:00+05:30"), "2026-W43");
  assert.equal(isoWeekId("2026-01-01T12:00:00+05:30"), "2026-W01");
  assert.equal(isoWeekId("2027-01-01T12:00:00+05:30"), "2026-W53");
  assert.equal(isoWeekId("2027-01-04T12:00:00+05:30"), "2027-W01");
  assert.equal(isoWeekId("2024-12-30T12:00:00+05:30"), "2025-W01");
  assert.equal(isoWeekId("2021-01-03T12:00:00+05:30"), "2020-W53");
  // Sunday 23:00 UTC = Monday 04:30 IST → the IST date decides
  assert.equal(isoWeekId(new Date("2026-10-18T23:00:00Z")), "2026-W43");
});

test("parseIso / addHours / addDays / hoursBetween", () => {
  assert.equal(parseIso("2026-10-14T19:30:00+05:30").toISOString(), "2026-10-14T14:00:00.000Z");
  assert.throws(() => parseIso("yesterday"), TypeError);
  assert.throws(() => parseIso(42), TypeError);
  assert.equal(nowIst(addHours("2026-10-14T19:30:00+05:30", 6)), "2026-10-15T01:30:00+05:30");
  assert.equal(nowIst(addHours(T, -5.5)), "2026-10-12T00:01:00+05:30");
  assert.equal(istDate(addDays(T, 20)), "2026-11-01");
  assert.equal(hoursBetween("2026-10-14T19:30:00+05:30", "2026-10-15T01:30:00+05:30"), 6);
  assert.equal(hoursBetween("2026-10-15T01:30:00+05:30", "2026-10-14T19:30:00+05:30"), -6);
});

test("slotIdFor: <handle>-<YYYY-MM-DD>-<HHmm> in IST", () => {
  assert.equal(slotIdFor("rishtapatra", "2026-10-14T19:30:00+05:30"), "rishtapatra-2026-10-14-1930");
  assert.equal(slotIdFor("kaatdo", new Date("2026-10-13T02:45:00Z")), "kaatdo-2026-10-13-0815");
});

test("cronMinuteToIst: '0 * * * *' → 30 and '30 * * * *' → 0 (M1); cronTimeToIst for daily crons", () => {
  assert.equal(cronMinuteToIst("0 * * * *"), 30);
  assert.equal(cronMinuteToIst("30 * * * *"), 0);
  assert.equal(cronMinuteToIst("45 * * * *"), 15);
  assert.throws(() => cronMinuteToIst("* * * * *"), TypeError);
  assert.throws(() => cronMinuteToIst("0 * * *"), TypeError);
  assert.equal(cronTimeToIst("0 0 * * *"), "05:30");
  assert.equal(cronTimeToIst("0 2 * * 1"), "07:30");
  assert.equal(cronTimeToIst("30 20 * * *"), "02:00");
});

const CONFIG = {
  pages: [
    { handle: "rishtapatra", cadence: { slots: [{ dow: "mon", time: "19:30", format: "image" }, { dow: "wed", time: "19:30", format: "carousel" }, { dow: "fri", time: "19:30", format: "image" }] } },
    { handle: "kaatdo", cadence: { slots: [{ dow: "tue", time: "08:15", format: "image" }, { dow: "thu", time: "08:15", format: "image" }, { dow: "sat", time: "11:00", format: "carousel" }] } },
    { handle: "job_rez", cadence: { slots: [{ dow: "mon", time: "12:30", format: "image" }, { dow: "tue", time: "12:30", format: "image" }, { dow: "wed", time: "12:30", format: "carousel" }, { dow: "thu", time: "12:30", format: "image" }] } },
  ],
};

test("nextCadenceSlots: the next N cadence slots across pages, in IST time order (M11 empty state)", () => {
  // Monday 2026-10-12 05:31 IST
  const four = nextCadenceSlots(CONFIG, T, 4);
  assert.deepEqual(
    four.map((s) => [s.page, s.at, s.format]),
    [
      ["job_rez", "2026-10-12T12:30:00+05:30", "image"],
      ["rishtapatra", "2026-10-12T19:30:00+05:30", "image"],
      ["kaatdo", "2026-10-13T08:15:00+05:30", "image"],
      ["job_rez", "2026-10-13T12:30:00+05:30", "image"],
    ],
  );
  assert.equal(four[0].slotId, "job_rez-2026-10-12-1230");
  assert.deepEqual(Object.keys(four[0]).sort(), ["at", "dow", "format", "page", "slotId", "time"]);
  // A slot earlier today is pushed to next week: Monday 20:00 IST → next Monday for rishtapatra
  const later = nextCadenceSlots(CONFIG, "2026-10-12T20:00:00+05:30", 10);
  const rp = later.filter((s) => s.page === "rishtapatra");
  assert.equal(rp[0].at, "2026-10-14T19:30:00+05:30");
  assert.equal(rp.find((s) => s.dow === "mon").at, "2026-10-19T19:30:00+05:30");
  // 14 days of a 10-slot/week cadence
  const twenty = nextCadenceSlots(CONFIG, T, 20);
  assert.equal(twenty.length, 20);
  for (let i = 1; i < twenty.length; i++) assert.ok(parseIso(twenty[i].at) >= parseIso(twenty[i - 1].at), "sorted");
  assert.deepEqual(nextCadenceSlots({ pages: [] }, T, 4), []);
});

// The real proof of host-zone independence: rerun the core assertions in child processes with TZ pinned.
const CHILD = `
import { nowIst, istDate, istMonthKey, isoWeekId, dowIst, cronMinuteToIst, nextCadenceSlots } from ${JSON.stringify(pathToFileURL(join(ROOT, "engine/lib/time.js")).href)};
const out = {
  tz: process.env.TZ,
  offset: new Date("2026-10-12T00:01:00Z").getTimezoneOffset(),
  nowIst: nowIst(new Date("2026-10-12T00:01:00Z")),
  istDate: istDate(new Date("2026-10-31T18:40:00Z")),
  month1: istMonthKey("2026-10-31T23:50:00+05:30"),
  month2: istMonthKey("2026-11-01T00:10:00+05:30"),
  week: isoWeekId("2026-10-12T05:30:00+05:30"),
  dow: dowIst(new Date("2026-10-18T19:00:00Z")),
  cron: cronMinuteToIst("0 * * * *"),
  slot: nextCadenceSlots({ pages: [{ handle: "rishtapatra", cadence: { slots: [{ dow: "mon", time: "19:30", format: "image" }] } }] }, new Date("2026-10-12T00:01:00Z"), 1)[0].at,
};
process.stdout.write(JSON.stringify(out));
`;

for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
  test(`time.js gives identical IST results with TZ=${tz}`, () => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.tz, tz);
    if (tz === "UTC") assert.equal(out.offset, 0);
    if (tz === "America/New_York") assert.equal(out.offset, 240, "child really runs in New York time (EDT in October)");
    if (tz === "Asia/Kolkata") assert.equal(out.offset, -330);
    if (tz === "Pacific/Kiritimati") assert.equal(out.offset, -840);
    assert.deepEqual(
      { ...out, tz: undefined, offset: undefined },
      { tz: undefined, offset: undefined, nowIst: "2026-10-12T05:31:00+05:30", istDate: "2026-11-01", month1: "2026-10", month2: "2026-11", week: "2026-W42", dow: "mon", cron: 30, slot: "2026-10-12T19:30:00+05:30" },
    );
  });
}
