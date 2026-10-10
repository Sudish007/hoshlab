// Identifiers and state file paths (design.md §4 "Identifiers", §2 tree, review N7).
// Browser-safe: no node: imports.
import { istDate, istParts, istMonthKey, isoWeekId } from "./time.js";

const pad2 = (n) => String(n).padStart(2, "0");

// 'Free Janam Kundali, computed on the device' → 'free-janam-kundali-computed-on-the-device' (≤ 40, [a-z0-9-]).
export function slugify(title, max = 40) {
  let slug = String(title)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // drop combining marks left by decomposition (é → e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length > max) slug = slug.slice(0, max).replace(/-+$/g, "");
  return slug || "untitled";
}

// '<prefix>-<YYYY-MM-DD>-<slug>', de-duplicated against existingIds with -2, -3, …
export function draftId(prefix, slotDate, title, existingIds = []) {
  const date = slotDate instanceof Date ? istDate(slotDate) : /^\d{4}-\d{2}-\d{2}$/.test(String(slotDate)) ? String(slotDate) : istDate(slotDate);
  const taken = new Set(existingIds);
  const base = `${prefix}-${date}-${slugify(title)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ideaId('rp', 31) → 'rp-i0031' (sequential per page).
export function ideaId(prefix, n) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`ids: idea number must be a non-negative integer, got ${n}`);
  return `${prefix}-i${String(n).padStart(4, "0")}`;
}

// Next idea number for a page given existing idea ids ('rp-i0031' → 32).
export function nextIdeaNumber(prefix, existingIds = []) {
  let max = 0;
  const re = new RegExp(`^${prefix}-i(\\d{4,})$`);
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// runId('engine-daily', date) → 'engine-daily-20261012-0001-a1b2c3' (IST stamp + 6 hex).
export function runId(workflow, date = new Date(), hex = randomHex(6)) {
  const p = istParts(date);
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new TypeError(`ids: run suffix must be 6 hex chars, got ${hex}`);
  return `${workflow}-${p.y}${pad2(p.m)}${pad2(p.d)}-${pad2(p.hh)}${pad2(p.mm)}-${hex}`;
}

export function randomHex(length) {
  let out = "";
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out.slice(0, length);
}

// Paths relative to company/state/ (ISO week ids, review N7; IST months, review M9).
export function memoPath(date = new Date()) {
  return `memos/${isoWeekId(date)}.md`;
}

export function reportPath(date = new Date()) {
  return `reports/${isoWeekId(date)}.md`;
}

export function hrReviewPath(date = new Date()) {
  return `hr/${istMonthKey(date)}-review.md`;
}

export function hrProposalPath(date = new Date()) {
  return `hr/proposals/${istMonthKey(date)}.json`;
}

export function draftPath(id) {
  return `drafts/${id}/draft.json`;
}

export function qaPath(id) {
  return `drafts/${id}/qa.json`;
}

export function editPath(id) {
  return `edits/${id}.json`;
}
