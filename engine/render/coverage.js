// Glyph coverage against the self-hosted font files (review M8). coverage.json is written by
// `npm run build:fonts` from the cmap tables of the @fontsource .woff files; the same ranges are the
// faces' unicode-range in fonts.css, so "covered here" == "Chromium renders it with this family".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_COVERAGE_PATH = fileURLToPath(new URL("./fonts/coverage.json", import.meta.url));

// Code points that never need a glyph: whitespace and the zero-width space / joiner / non-joiner
// (U+200B–U+200D, used inside Devanagari conjuncts).
export function isIgnoredCodePoint(cp) {
  if (cp >= 0x200b && cp <= 0x200d) return true;
  return /\s/u.test(String.fromCodePoint(cp));
}

export function inRanges(cp, ranges) {
  for (const [from, to] of ranges) {
    if (cp < from) return false;
    if (cp <= to) return true;
  }
  return false;
}

// loadCoverage(path) → { "<family>": [[from, to], …] } (throws when the file is missing: run build:fonts).
export function loadCoverage(path = DEFAULT_COVERAGE_PATH) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`coverage: ${path} missing — run npm run build:fonts (${e.message})`);
  }
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

// Family names compare case-insensitively with quotes trimmed ('"Tiro Devanagari Hindi"' matches).
export function normalizeFamily(name) {
  return String(name ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .toLowerCase();
}

export function familyRanges(family, table) {
  const want = normalizeFamily(family);
  for (const [name, ranges] of Object.entries(table || {})) if (normalizeFamily(name) === want) return ranges;
  return null;
}

// coverage(family, text, table) → { ok, missing: [codePoint, …], family, known }.
//   missing lists every distinct non-ignored code point the family's cmap does not map (sorted);
//   an unknown family (not in the table) yields every non-ignored code point as missing, known:false.
export function coverage(family, text, table) {
  const ranges = familyRanges(family, table);
  const missing = new Set();
  for (const ch of String(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (isIgnoredCodePoint(cp)) continue;
    if (!ranges || !inRanges(cp, ranges)) missing.add(cp);
  }
  return { ok: missing.size === 0, missing: [...missing].sort((a, b) => a - b), family: String(family ?? ""), known: ranges !== null };
}

// 'U+0915 U+0941' for error details.
export function formatCodePoints(cps, max = 8) {
  const list = cps.slice(0, max).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  return cps.length > max ? `${list.join(" ")} +${cps.length - max} more` : list.join(" ");
}
