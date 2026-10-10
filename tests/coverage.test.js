// M8 prove-by: glyph coverage answers come from the REAL font files (cmap tables), never from
// document.fonts.check(). Needs engine/render/fonts/ — built here when missing (npm run build:fonts).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.js";
import { FAMILIES, buildFonts, cmapRanges, mergeRanges, rangesToCss, woffTable } from "../scripts/build-fonts.mjs";
import { coverage, familyRanges, formatCodePoints, inRanges, isIgnoredCodePoint, loadCoverage } from "../engine/render/coverage.js";

const FONTS = join(ROOT, "engine", "render", "fonts");
let table;

before(() => {
  if (!existsSync(join(FONTS, "coverage.json"))) buildFonts();
  table = loadCoverage(join(FONTS, "coverage.json"));
});

const cps = (s) => [...s].map((c) => c.codePointAt(0));

test("coverage: Cormorant Garamond has no Devanagari; Tiro Devanagari Hindi covers कुंडली (M8)", () => {
  const cg = coverage("Cormorant Garamond", "कुंडली", table);
  assert.equal(cg.ok, false);
  assert.equal(cg.known, true);
  assert.deepEqual(cg.missing, [0x0902, 0x0915, 0x0921, 0x0932, 0x0940, 0x0941], "every distinct Devanagari code point of कुंडली, sorted");
  const tiro = coverage("Tiro Devanagari Hindi", "कुंडली", table);
  assert.deepEqual(tiro, { ok: true, missing: [], family: "Tiro Devanagari Hindi", known: true });
  assert.equal(coverage("Mukta", "कुंडली", table).ok, true);
  assert.equal(coverage("Noto Sans Devanagari", "काट दो.", table).ok, true);
  assert.equal(coverage("Inter", "Free Janam Kundali — 36-point, ₹499", table).ok, true);
});

test("coverage: ╱ (U+2571) against the real font tables — Space Grotesk lacks it, Cascadia Code (symbols2) has it, and the KaatDo template sets ╱ in the mono family", () => {
  const sg = coverage("Space Grotesk", "╱", table);
  assert.equal(sg.ok, false, "observed: @fontsource/space-grotesk 5.3.0 ships no box-drawing glyphs");
  assert.deepEqual(sg.missing, [0x2571]);
  assert.deepEqual(coverage("Cascadia Code", "╱", table), { ok: true, missing: [], family: "Cascadia Code", known: true });
  const css = readFileSync(join(ROOT, "engine", "render", "templates", "common.css"), "utf8");
  assert.match(css, /\.post-kd \.brand-row \.slash \{ font-family: var\(--font-mono\)/, "the ╱ span uses the brand mono family (Cascadia Code)");
  for (const f of ["kaatdo/image.html", "kaatdo/carousel.html"]) {
    const html = readFileSync(join(ROOT, "engine", "render", "templates", f), "utf8");
    assert.match(html, /<span class="slash"[^>]*>╱<\/span>/, `${f} renders ╱ inside .slash`);
  }
});

test("coverage: whitespace and U+200B–U+200D are ignored; unknown family → every code point missing, known:false; family names match case-insensitively with quotes trimmed", () => {
  assert.deepEqual(coverage("Inter", " \n\t\u200b\u200c\u200d", table), { ok: true, missing: [], family: "Inter", known: true });
  assert.equal(coverage("Tiro Devanagari Hindi", "कुं\u200dडली", table).ok, true, "ZWJ inside a conjunct is ignored");
  const unknown = coverage("Comic Sans MS", "ab", table);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.missing, cps("ab"));
  assert.equal(coverage('"tiro devanagari hindi"', "क", table).ok, true);
  assert.equal(isIgnoredCodePoint(0x20), true);
  assert.equal(isIgnoredCodePoint(0x200b), true);
  assert.equal(isIgnoredCodePoint(0x0915), false);
  assert.equal(formatCodePoints([0x0915, 0x0941]), "U+0915 U+0941");
  assert.equal(formatCodePoints(Array.from({ length: 10 }, (_, i) => 0x41 + i), 3), "U+0041 U+0042 U+0043 +7 more");
});

test("coverage.json: every artwork family is present with sorted, merged, non-overlapping ranges; the table is the cmap of the copied .woff files", () => {
  assert.deepEqual(Object.keys(table).sort(), FAMILIES.map((f) => f.family).sort());
  for (const [family, ranges] of Object.entries(table)) {
    assert.ok(ranges.length > 0, family);
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i];
      assert.ok(Number.isInteger(a) && Number.isInteger(b) && a <= b, `${family} range ${i}`);
      if (i > 0) assert.ok(a > ranges[i - 1][1] + 1, `${family}: ranges sorted and merged at ${i}`);
    }
    assert.equal(inRanges(0x41, ranges), true, `${family} covers 'A'`);
    assert.equal(familyRanges(family, table), ranges);
  }
  // the parser on one real file: Inter latin 400 maps 'A' and not 'क'; the table is a superset of that file
  const woff = readFileSync(join(ROOT, "node_modules", "@fontsource", "inter", "files", "inter-latin-400-normal.woff"));
  const ranges = cmapRanges(woffTable(woff, "cmap"));
  assert.equal(inRanges(0x41, ranges), true);
  assert.equal(inRanges(0x0915, ranges), false);
  for (const [a, b] of ranges) assert.ok(inRanges(a, table.Inter) && inRanges(b, table.Inter), "family table ⊇ subset file");
  assert.throws(() => woffTable(new Uint8Array([0, 1, 2, 3, 4, 5]), "cmap"), /not a WOFF file/);
  assert.throws(() => woffTable(woff, "zzzz"), /table zzzz not found/);
  assert.deepEqual(mergeRanges([[5, 7], [1, 2], 3, [8, 9], [20, 21]]), [[1, 3], [5, 9], [20, 21]]);
  assert.equal(rangesToCss([[0, 255], [0x2571, 0x2571]]), "U+0000-00FF,U+2571");
});

test("fonts.css: one @font-face per copied .woff2 with the file's own cmap as unicode-range (face selection == coverage table)", () => {
  const css = readFileSync(join(FONTS, "fonts.css"), "utf8");
  const faces = [...css.matchAll(/@font-face \{ font-family: "([^"]+)"; font-style: normal; font-weight: (\d+); font-display: block; src: url\("\.\/([^"]+)"\) format\("woff2"\); unicode-range: ([^;]+); \}/g)];
  const expectedFiles = FAMILIES.reduce((n, f) => n + f.weights.length * f.subsets.length, 0);
  assert.equal(faces.length, expectedFiles, "every family × weight × subset has a face");
  for (const [, family, weight, file, range] of faces) {
    assert.ok(existsSync(join(FONTS, file)), `${file} copied`);
    assert.ok(FAMILIES.some((f) => f.family === family && f.weights.includes(Number(weight))), `${family} ${weight}`);
    for (const token of range.split(",")) {
      const m = /^U\+([0-9A-F]{4,6})(?:-([0-9A-F]{4,6}))?$/.exec(token);
      assert.ok(m, `${file}: unicode-range token ${token}`);
      const a = parseInt(m[1], 16);
      const b = m[2] ? parseInt(m[2], 16) : a;
      assert.ok(inRanges(a, table[family]) && inRanges(b, table[family]), `${file}: ${token} is in the family's coverage`);
    }
  }
  // no artwork family covers U+2192 → in the subsets Google ships; the templates draw the swipe arrow as SVG
  for (const f of FAMILIES) assert.equal(coverage(f.family, "→", table).ok, false, `${f.family} lacks → (observed; if this changes the SVG arrow may become text)`);
});
