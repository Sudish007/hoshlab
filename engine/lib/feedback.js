// Owner feedback → prompts and the Designer (design.md §4.11, §5 envelope "feedback digest"; plan D23;
// FEAT-205, P2-08). company/state/feedback.jsonl is ADMIN-OWNED: the engine only reads it. Two pure functions:
//
//   buildDigest({ feedback, page, lastReport, now, maxTokens })
//     → the text the Writer and the Strategist get under '### Owner feedback and observations' in their context
//       block: the last 10 entries addressed to the page (its own plus company-wide notes) — rejection reasons
//       first, then newest first — and the latest Analyst report's observations for the page. Trimmed to
//       maxTokens (default 1,500; the chars / 4 estimate of engine/llm/prompt.js) at a line boundary with a
//       '…(truncated)' marker. '' when nothing exists, so a company without feedback or reports sends exactly
//       the Phase 1 prompt.
//
//   designPreferences({ feedback, page })
//     → { preferVariant: 'A'|'B'|'C'|null, preferPalette: 'dark'|'light'|null, reasons[], variantReason, paletteReason }
//       for the deterministic Designer. Only entries tagged design / variant / palette count, and only when their
//       text names a variant ("variant B") or a palette ("dark palette" / "light palette") — a strict keyword match,
//       nothing is inferred from tone, wording or the rest of the note. The newest such entry wins; an older
//       conflicting one is ignored. Every reason reads 'variant B preferred by owner feedback 2026-10-10' and is
//       what the Designer records in draft.designNote.
import { estimateTokens } from "../llm/prompt.js";
import { istDate, parseIso } from "./time.js";

export const DIGEST_MAX_TOKENS = 1500;
export const DIGEST_ENTRIES = 10;
export const TRUNCATION_MARKER = "…(truncated)";
export const FEEDBACK_HEADING = (page) => `Owner feedback (last ${DIGEST_ENTRIES} for @${page})`;
export const OBSERVATIONS_HEADING = (week) => `Analyst observations (${week})`;
export const DESIGN_TAGS = ["design", "variant", "palette"];
export const VARIANTS = ["A", "B", "C"];
export const PALETTES = ["dark", "light"];
// "variant B", "Variant b", "variant: C" — the letter must stand alone (not "variant Bold").
const VARIANT_RE = /\bvariant\s*:?\s*([abc])\b/i;
// "dark palette", "the light palette" — never a bare "dark"/"light" (too easy to mean something else).
const PALETTE_RE = /\b(dark|light)\s+palette\b/i;

function toMs(v) {
  if (v === undefined || v === null) return Infinity;
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`feedback: invalid date ${String(v)}`);
  return d.getTime();
}

function atMs(record) {
  const t = Date.parse(record && record.at);
  return Number.isNaN(t) ? null : t;
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCompanyWide(record) {
  return record.page === undefined || record.page === null || record.page === "";
}

// The feedback addressed to `page`: its own entries plus company-wide ones (no page), dated, not after `now`
// (a back-dated --now dry run never sees a note from its future). Newest first.
export function entriesFor(feedback, page, now) {
  const limit = toMs(now);
  return (feedback || [])
    .filter((r) => r && typeof r.text === "string" && (r.page === page || isCompanyWide(r)))
    .filter((r) => {
      const t = atMs(r);
      return t !== null && t <= limit;
    })
    .sort((a, b) => atMs(b) - atMs(a));
}

// '- 2026-10-08 reject: "Too salesy; keep to the six layout rules." [tone]'
export function entryLine(record) {
  const date = istDate(parseIso(record.at));
  const kind = `${record.kind}${isCompanyWide(record) ? " (company-wide)" : ""}`;
  const tags = Array.isArray(record.tags) && record.tags.length ? ` [${record.tags.map(oneLine).join(", ")}]` : "";
  return `- ${date} ${kind}: "${oneLine(record.text)}"${tags}`;
}

// The report's observations for the page, whichever shape the caller holds: the Analyst's output
// ({ week, perPage }) or analyst.latestReport()'s wrapper ({ week, report: { perPage } }).
export function observationsFor(lastReport, page) {
  if (!lastReport || typeof lastReport !== "object") return { week: null, observations: [] };
  const report = lastReport.report && typeof lastReport.report === "object" ? lastReport.report : lastReport;
  const week = lastReport.week || report.week || null;
  const row = (Array.isArray(report.perPage) ? report.perPage : []).find((p) => p && p.page === page);
  const observations = row && Array.isArray(row.observations) ? row.observations.map(oneLine).filter(Boolean) : [];
  return { week, observations };
}

// Cuts `text` so that estimateTokens(result) ≤ maxTokens, at the last line break that fits, and marks the cut.
export function truncateToTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  const budget = maxTokens * 4 - (TRUNCATION_MARKER.length + 1);
  if (budget <= 0) return TRUNCATION_MARKER.slice(0, Math.max(0, maxTokens * 4));
  const head = text.slice(0, budget);
  const cut = head.lastIndexOf("\n");
  const kept = (cut > 0 ? head.slice(0, cut) : head).replace(/\s+$/, "");
  return `${kept}\n${TRUNCATION_MARKER}`;
}

// buildDigest({ feedback, page, lastReport, now, maxTokens }) → string ('' when there is nothing to say).
export function buildDigest({ feedback = [], page, lastReport = null, now, maxTokens = DIGEST_MAX_TOKENS } = {}) {
  if (typeof page !== "string" || !page) throw new TypeError("feedback: page handle is required");
  const entries = entriesFor(feedback, page, now).slice(0, DIGEST_ENTRIES);
  const ordered = [...entries.filter((r) => r.kind === "reject"), ...entries.filter((r) => r.kind !== "reject")];
  const sections = [];
  if (ordered.length) sections.push([FEEDBACK_HEADING(page), ...ordered.map(entryLine)].join("\n"));
  const { week, observations } = observationsFor(lastReport, page);
  if (observations.length) sections.push([OBSERVATIONS_HEADING(week || "latest report"), ...observations.map((o) => `- ${o}`)].join("\n"));
  if (!sections.length) return "";
  return truncateToTokens(sections.join("\n\n"), maxTokens);
}

function isDesignTagged(record) {
  return Array.isArray(record.tags) && record.tags.some((t) => DESIGN_TAGS.includes(String(t).trim().toLowerCase()));
}

// designPreferences({ feedback, page, now }) → { preferVariant, preferPalette, reasons, variantReason, paletteReason }
export function designPreferences({ feedback = [], page, now } = {}) {
  if (typeof page !== "string" || !page) throw new TypeError("feedback: page handle is required");
  const out = { preferVariant: null, preferPalette: null, reasons: [], variantReason: null, paletteReason: null };
  for (const record of entriesFor(feedback, page, now)) {
    if (!isDesignTagged(record)) continue;
    const date = istDate(parseIso(record.at));
    if (!out.preferVariant) {
      const m = VARIANT_RE.exec(record.text);
      if (m) {
        out.preferVariant = m[1].toUpperCase();
        out.variantReason = `variant ${out.preferVariant} preferred by owner feedback ${date}`;
      }
    }
    if (!out.preferPalette) {
      const m = PALETTE_RE.exec(record.text);
      if (m) {
        out.preferPalette = m[1].toLowerCase();
        out.paletteReason = `${out.preferPalette} palette preferred by owner feedback ${date}`;
      }
    }
    if (out.preferVariant && out.preferPalette) break;
  }
  if (out.variantReason) out.reasons.push(out.variantReason);
  if (out.paletteReason) out.reasons.push(out.paletteReason);
  return out;
}

// True when the preferences carry anything the Designer should act on.
export function hasPreference(prefs) {
  return Boolean(prefs && (prefs.preferVariant || prefs.preferPalette));
}
