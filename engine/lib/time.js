// IST helpers with no dependency on the host time zone (CI is UTC, the owner is IST).
// IST is UTC+05:30 all year (no DST), so every conversion is fixed-offset arithmetic on epoch ms.
// Browser-safe: no node: imports.

export const IST_OFFSET_MINUTES = 330;
export const IST_OFFSET = "+05:30";
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const pad2 = (n) => String(n).padStart(2, "0");

function toDate(d) {
  const date = d instanceof Date ? d : typeof d === "string" ? parseIso(d) : new Date(d);
  if (Number.isNaN(date.getTime())) throw new TypeError(`time: invalid date ${String(d)}`);
  return date;
}

// Wall-clock parts of `d` in IST: { y, m (1-12), d, hh, mm, ss, dow (0=sun) }.
export function istParts(d = new Date()) {
  const shifted = new Date(toDate(d).getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
    dow: shifted.getUTCDay(),
  };
}

// Builds the instant for an IST wall-clock time.
export function istDateTime(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - IST_OFFSET_MINUTES * MS_PER_MINUTE);
}

// '2026-10-14T19:30:00+05:30' for the given instant (default: now).
export function nowIst(date = new Date()) {
  const p = istParts(date);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}${IST_OFFSET}`;
}

// 'YYYY-MM-DD' in IST.
export function istDate(d = new Date()) {
  const p = istParts(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

// 'YYYY-MM' in IST — the month-partition key for runs/usage/metrics logs (review M9, plan D7).
export function istMonthKey(d = new Date()) {
  const p = istParts(d);
  return `${p.y}-${pad2(p.m)}`;
}

// 'HH:MM' in IST.
export function istTime(d = new Date()) {
  const p = istParts(d);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}

// ISO-8601 week id of the IST calendar date, e.g. '2026-W42' (review N7).
export function isoWeekId(d = new Date()) {
  const p = istParts(d);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const dayNum = (day.getUTCDay() + 6) % 7; // mon = 0 … sun = 6
  day.setUTCDate(day.getUTCDate() - dayNum + 3); // the Thursday of this ISO week
  const isoYear = day.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((day - jan4) / MS_PER_DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${isoYear}-W${pad2(week)}`;
}

// 'mon' … 'sun' for the IST calendar date.
export function dowIst(d = new Date()) {
  return DOWS[istParts(d).dow];
}

// Parses an ISO-8601 string into a Date; throws on anything Date cannot parse.
export function parseIso(s) {
  if (typeof s !== "string") throw new TypeError(`time: expected ISO string, got ${typeof s}`);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new TypeError(`time: invalid ISO datetime ${JSON.stringify(s)}`);
  return new Date(ms);
}

export function addHours(d, hours) {
  return new Date(toDate(d).getTime() + hours * MS_PER_HOUR);
}

export function addDays(d, days) {
  return new Date(toDate(d).getTime() + days * MS_PER_DAY);
}

// Signed hours from `a` to `b` (positive when b is later).
export function hoursBetween(a, b) {
  return (toDate(b).getTime() - toDate(a).getTime()) / MS_PER_HOUR;
}

// 'rishtapatra-2026-10-14-1930' — the slot id format of calendar.json (§4.5).
export function slotIdFor(handle, at) {
  const p = istParts(at);
  return `${handle}-${p.y}-${pad2(p.m)}-${pad2(p.d)}-${pad2(p.hh)}${pad2(p.mm)}`;
}

// Next `count` cadence slots across config.pages[] at or after `fromDate`, in time order
// (used by the Strategist and by the Home empty state, review M11):
// [{ slotId, page, at, format, dow, time }].
export function nextCadenceSlots(config, fromDate = new Date(), count = 4) {
  const from = toDate(fromDate);
  const start = istParts(from);
  const out = [];
  for (const page of config.pages || []) {
    for (const slot of (page.cadence && page.cadence.slots) || []) {
      const [hh, mm] = slot.time.split(":").map(Number);
      const target = DOWS.indexOf(slot.dow);
      if (target < 0) throw new TypeError(`time: unknown dow ${slot.dow}`);
      let at = istDateTime(start.y, start.m, start.d, hh, mm);
      at = addDays(at, (target - start.dow + 7) % 7);
      if (at.getTime() < from.getTime()) at = addDays(at, 7);
      for (let i = 0; i < count; i++) {
        out.push({ slotId: slotIdFor(page.handle, at), page: page.handle, at: nowIst(at), format: slot.format, dow: slot.dow, time: slot.time, epoch: at.getTime() });
        at = addDays(at, 7);
      }
    }
  }
  out.sort((a, b) => a.epoch - b.epoch || a.page.localeCompare(b.page));
  return out.slice(0, count).map(({ epoch, ...slot }) => slot);
}

// For an hourly cron ('M * * * *') or any cron with a fixed minute field, the IST minute it
// fires at: '0 * * * *' → 30, '30 * * * *' → 0 (review M1 test helper).
export function cronMinuteToIst(cronExpr) {
  const fields = String(cronExpr).trim().split(/\s+/);
  if (fields.length !== 5) throw new TypeError(`time: cron needs 5 fields, got ${JSON.stringify(cronExpr)}`);
  if (!/^\d{1,2}$/.test(fields[0])) throw new TypeError(`time: cron minute field must be a fixed minute, got ${fields[0]}`);
  const minute = Number(fields[0]);
  if (minute > 59) throw new TypeError(`time: cron minute out of range ${fields[0]}`);
  return (minute + IST_OFFSET_MINUTES) % 60;
}

// For a daily cron ('M H * * *'), the IST 'HH:MM' it fires at: '0 0 * * *' → '05:30'.
export function cronTimeToIst(cronExpr) {
  const fields = String(cronExpr).trim().split(/\s+/);
  if (fields.length !== 5) throw new TypeError(`time: cron needs 5 fields, got ${JSON.stringify(cronExpr)}`);
  if (!/^\d{1,2}$/.test(fields[0]) || !/^\d{1,2}$/.test(fields[1])) throw new TypeError(`time: cron needs fixed minute and hour fields, got ${JSON.stringify(cronExpr)}`);
  const total = (Number(fields[1]) * 60 + Number(fields[0]) + IST_OFFSET_MINUTES) % (24 * 60);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}
