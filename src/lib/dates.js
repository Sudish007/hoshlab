// Display formatting in IST for the public site. Every instant is converted with engine/lib/time.js
// (fixed +05:30 arithmetic), so the host time zone (UTC in Actions, IST on the owner's machine) never
// changes a label. Machine-readable values stay ISO-8601 with the explicit +05:30 offset.
import { istParts, nowIst, parseIso, istMonthKey, istDate } from "../../engine/lib/time.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad2 = (n) => String(n).padStart(2, "0");

function parts(d) {
  return istParts(typeof d === "string" ? parseIso(d) : d);
}

// '2026-10-13T08:15:00+05:30' → 'Tue 13 Oct · 08:15 IST'
export function formatIst(d) {
  return `${formatIstDay(d)} · ${formatIstTime(d)} IST`;
}

// → 'Tue 13 Oct'
export function formatIstDay(d) {
  const p = parts(d);
  return `${DOW[p.dow]} ${p.d} ${MON[p.m - 1]}`;
}

// → 'Tue 13 Oct 2026'
export function formatIstDate(d) {
  const p = parts(d);
  return `${DOW[p.dow]} ${p.d} ${MON[p.m - 1]} ${p.y}`;
}

// → '08:15'
export function formatIstTime(d) {
  const p = parts(d);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
}

// Normalised ISO value for <time datetime> (always +05:30).
export function isoIst(d) {
  return nowIst(typeof d === "string" ? parseIso(d) : d);
}

// 'YYYY-MM' → 'October 2026'
export function monthName(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key));
  if (!m) throw new TypeError(`dates: month key must be YYYY-MM, got ${JSON.stringify(key)}`);
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`;
}

// 'YYYY-MM' of an instant in IST; previousMonth('2026-10') → '2026-09'.
export function monthKeyOf(d) {
  return istMonthKey(typeof d === "string" ? parseIso(d) : d);
}

export function previousMonth(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key));
  if (!m) throw new TypeError(`dates: month key must be YYYY-MM, got ${JSON.stringify(key)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 1 ? `${y - 1}-12` : `${y}-${pad2(mo - 1)}`;
}

// Days in the IST calendar month of `key`, and the weekday (0 = Monday … 6 = Sunday) its first day falls on.
export function monthGrid(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key));
  if (!m) throw new TypeError(`dates: month key must be YYYY-MM, got ${JSON.stringify(key)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const firstDow = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  return { year: y, month: mo, days, firstDow };
}

// 'YYYY-MM-DD' in IST for an instant.
export function dateKeyOf(d) {
  return istDate(typeof d === "string" ? parseIso(d) : d);
}

// Atom/RFC 3339 timestamp: the normalised IST ISO string (offsets are valid RFC 3339).
export function toAtomDate(d) {
  return isoIst(d);
}
