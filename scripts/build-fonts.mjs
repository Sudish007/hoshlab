// npm run build:fonts (design.md §10, review M8/N8): copies the artwork font files out of the
// @fontsource packages into engine/render/fonts/ (gitignored), writes fonts.css with one @font-face
// per subset file, and builds coverage.json = { "<family>": [[from, to], …] } from the REAL cmap
// tables of the matching .woff files (WOFF header → table directory → zlib.inflateSync('cmap') →
// format 4 / format 12 subtables). The same cmap ranges are written as each face's unicode-range,
// so Chromium's face selection and the engine's coverage() answer agree glyph for glyph (M8).
// Idempotent: every run rewrites the same files. Usage: node scripts/build-fonts.mjs [--quiet]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const FONTS_DIR = join(ROOT, "engine", "render", "fonts");

// The artwork families (brand ## Tokens, design §10). Weights per the templates; subsets per script.
// Space Grotesk ships 300–700 only in @fontsource 5.3.0 (the mock's 800 is rendered at 700);
// DM Mono ships 300–500; Tiro Devanagari Hindi ships 400 only.
const LATIN = ["latin", "latin-ext"];
const DEVANAGARI = ["devanagari", "latin", "latin-ext"];
export const FAMILIES = [
  { family: "Cormorant Garamond", pkg: "cormorant-garamond", weights: [700], subsets: LATIN },
  { family: "Tiro Devanagari Hindi", pkg: "tiro-devanagari-hindi", weights: [400], subsets: DEVANAGARI },
  { family: "Mukta", pkg: "mukta", weights: [400, 700], subsets: DEVANAGARI },
  { family: "Inter", pkg: "inter", weights: [400, 600], subsets: LATIN },
  { family: "Space Grotesk", pkg: "space-grotesk", weights: [700], subsets: LATIN },
  { family: "Cascadia Code", pkg: "cascadia-code", weights: [400], subsets: [...LATIN, "symbols2"] },
  { family: "Noto Sans Devanagari", pkg: "noto-sans-devanagari", weights: [400, 700], subsets: DEVANAGARI },
  { family: "DM Sans", pkg: "dm-sans", weights: [400, 500], subsets: LATIN },
  { family: "Manrope", pkg: "manrope", weights: [800], subsets: LATIN },
  { family: "DM Mono", pkg: "dm-mono", weights: [400], subsets: LATIN },
];

// ---------------------------------------------------------------------------------------
// WOFF 1.0 + cmap parsing (OpenType spec: cmap formats 4 and 12). Pure functions over bytes.

function u16(b, o) {
  return (b[o] << 8) | b[o + 1];
}
function u32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function tag(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

// Returns the decompressed bytes of one table ('cmap') from a WOFF 1.0 buffer; throws when absent.
export function woffTable(buffer, wanted) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (tag(b, 0) !== "wOFF") throw new TypeError(`not a WOFF file (signature ${JSON.stringify(tag(b, 0))})`);
  const numTables = u16(b, 12);
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    if (tag(b, o) !== wanted) continue;
    const offset = u32(b, o + 4);
    const compLength = u32(b, o + 8);
    const origLength = u32(b, o + 12);
    const slice = b.subarray(offset, offset + compLength);
    if (compLength < origLength) {
      const out = inflateSync(slice);
      if (out.length !== origLength) throw new RangeError(`${wanted}: inflated ${out.length} bytes, expected ${origLength}`);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
    return slice;
  }
  throw new RangeError(`table ${wanted} not found`);
}

// Sorted, merged [from, to] ranges from a sorted or unsorted list of code points / ranges.
export function mergeRanges(ranges) {
  const sorted = ranges
    .map((r) => (Array.isArray(r) ? [r[0], r[1]] : [r, r]))
    .filter((r) => Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[1] >= r[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// Code points mapped to a non-zero glyph by a format 4 subtable.
function parseFormat4(b, o, out) {
  const segCount = u16(b, o + 6) / 2;
  const endOff = o + 14;
  const startOff = endOff + segCount * 2 + 2;
  const deltaOff = startOff + segCount * 2;
  const rangeOff = deltaOff + segCount * 2;
  for (let s = 0; s < segCount; s++) {
    const end = u16(b, endOff + s * 2);
    const start = u16(b, startOff + s * 2);
    const delta = u16(b, deltaOff + s * 2);
    const rangeOffset = u16(b, rangeOff + s * 2);
    if (start === 0xffff) continue;
    let runStart = -1;
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        const gi = rangeOff + s * 2 + rangeOffset + (c - start) * 2;
        glyph = gi + 1 < b.length ? u16(b, gi) : 0;
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) {
        if (runStart < 0) runStart = c;
      } else if (runStart >= 0) {
        out.push([runStart, c - 1]);
        runStart = -1;
      }
    }
    if (runStart >= 0) out.push([runStart, end]);
  }
}

// Code points mapped to a non-zero glyph by a format 12 subtable.
function parseFormat12(b, o, out) {
  const numGroups = u32(b, o + 12);
  for (let g = 0; g < numGroups; g++) {
    const go = o + 16 + g * 12;
    const start = u32(b, go);
    const end = u32(b, go + 4);
    const startGlyph = u32(b, go + 8);
    if (startGlyph === 0) {
      if (end > start) out.push([start + 1, end]);
      continue;
    }
    out.push([start, end]);
  }
}

// All code points the font's Unicode cmap subtables map to a real glyph, as merged ranges.
export function cmapRanges(cmap) {
  const b = cmap;
  const n = u16(b, 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const platform = u16(b, 4 + i * 8);
    const encoding = u16(b, 6 + i * 8);
    const offset = u32(b, 8 + i * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = u16(b, offset);
    if (format === 4) parseFormat4(b, offset, out);
    else if (format === 12) parseFormat12(b, offset, out);
  }
  return mergeRanges(out);
}

// 'U+0000-00FF,U+0131' for a unicode-range descriptor.
export function rangesToCss(ranges) {
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  return ranges.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(",");
}

function countCodePoints(ranges) {
  return ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
}

// ---------------------------------------------------------------------------------------

export function buildFonts({ root = ROOT, outDir = FONTS_DIR, families = FAMILIES, log = () => {} } = {}) {
  mkdirSync(outDir, { recursive: true });
  const css = ["/* generated by scripts/build-fonts.mjs from the @fontsource packages — do not edit; unicode-range = the file's cmap */"];
  const coverage = {};
  const summary = [];
  for (const f of families) {
    const filesDir = join(root, "node_modules", "@fontsource", f.pkg, "files");
    if (!existsSync(filesDir)) throw new Error(`build-fonts: ${filesDir} missing — run npm install first`);
    const familyRanges = [];
    let files = 0;
    for (const weight of f.weights) {
      for (const subset of f.subsets) {
        const base = `${f.pkg}-${subset}-${weight}-normal`;
        const woff2 = join(filesDir, `${base}.woff2`);
        const woff = join(filesDir, `${base}.woff`);
        if (!existsSync(woff2) || !existsSync(woff)) throw new Error(`build-fonts: ${f.family} ${weight} ${subset}: ${base}.woff2/.woff not in ${filesDir}`);
        copyFileSync(woff2, join(outDir, `${base}.woff2`));
        const ranges = cmapRanges(woffTable(readFileSync(woff), "cmap"));
        if (ranges.length === 0) throw new Error(`build-fonts: ${base}.woff has an empty Unicode cmap`);
        familyRanges.push(...ranges);
        css.push(`@font-face { font-family: "${f.family}"; font-style: normal; font-weight: ${weight}; font-display: block; src: url("./${base}.woff2") format("woff2"); unicode-range: ${rangesToCss(ranges)}; }`);
        files++;
      }
    }
    const merged = mergeRanges(familyRanges);
    coverage[f.family] = merged;
    const line = `${f.family}: ${f.weights.length} weight${f.weights.length === 1 ? "" : "s"} (${f.weights.join("/")}), ${f.subsets.length} subsets, ${files} files, ${countCodePoints(merged)} code points in ${merged.length} ranges`;
    summary.push(line);
    log(line);
  }
  writeFileSync(join(outDir, "fonts.css"), css.join("\n") + "\n", "utf8");
  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(coverage) + "\n", "utf8");
  return { outDir, coverage, summary, families: families.map((f) => f.family) };
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const quiet = process.argv.includes("--quiet");
  try {
    const r = buildFonts({ log: quiet ? () => {} : (s) => console.log(s) });
    if (!quiet) console.log(`build-fonts: ${r.families.length} families → ${r.outDir}`);
  } catch (err) {
    console.error(`build-fonts: ${err.message}`);
    process.exit(1);
  }
}
