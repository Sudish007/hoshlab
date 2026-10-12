// Render smoke tests (design.md §10; review M8/M13). The browser-backed tests run only when
// RENDER_TESTS=1 (Chromium from `npx playwright install chromium`); otherwise they are skipped with an
// explicit message. The pure guard tests always run. Outputs go under os.tmpdir().
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { jpegSize, MAX_MEDIA_BYTES } from "../engine/lib/checks.js";
import { loadCoverage } from "../engine/render/coverage.js";
import { RenderError, RenderUnavailableError, applyGuards, brandTokens, checkJpeg, ensureFonts, fontFamilies, renderDraft, templateDirFor, FONTS_DIR, TEXT_FLOOR_U, CONTRAST_MIN } from "../engine/render/render.js";
import { sampleDraft } from "../engine/commands/render-sample.js";

const RENDER = process.env.RENDER_TESTS === "1";
const SKIP = RENDER ? false : "render smoke skipped: set RENDER_TESTS=1 (needs Chromium: npx playwright install chromium)";

const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { brands, config } = company;
const fixture = (id) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "drafts", `${id}.json`), "utf8"));
const RP = fixture("rp-2026-10-14-kundali-free");
const KD = fixture("kd-2026-10-13-six-rules");
const JR = fixture("jr-2026-10-15-templates");

// ---------------------------------------------------------------------------------------
// Pure parts (always run)

test("fontFamilies parses the brand font tokens; brandTokens maps colours/fonts/gradients to CSS custom properties and names the Devanagari-capable families from the real coverage table", async () => {
  assert.deepEqual(fontFamilies("Inter / Mukta"), ["Inter", "Mukta"]);
  assert.deepEqual(fontFamilies("Cormorant Garamond 700"), ["Cormorant Garamond"]);
  assert.deepEqual(fontFamilies("Manrope 800, letter-spacing -0.05em"), ["Manrope"]);
  assert.deepEqual(fontFamilies("Space Grotesk 400/500/700"), ["Space Grotesk"]);
  assert.deepEqual(fontFamilies("DM Sans"), ["DM Sans"]);
  await ensureFonts(FONTS_DIR);
  const table = loadCoverage(join(FONTS_DIR, "coverage.json"));
  const rp = brandTokens(brands.rishtapatra, table);
  assert.equal(rp.vars["--c-brand"], "#7a1f2b");
  assert.equal(rp.vars["--font-display"], '"Cormorant Garamond"');
  assert.equal(rp.vars["--font-ui"], '"Inter", "Mukta"');
  assert.equal(rp.vars["--font-devanagari"], '"Tiro Devanagari Hindi"');
  assert.deepEqual(rp.devanagariFamilies.sort(), ["Mukta", "Tiro Devanagari Hindi"], "M8: the Devanagari-capable families named in ## Tokens");
  const kd = brandTokens(brands.kaatdo, table);
  assert.deepEqual(kd.devanagariFamilies, ["Noto Sans Devanagari"]);
  assert.equal(kd.vars["--font-mono"], '"Cascadia Code"');
  const jr = brandTokens(brands.job_rez, table);
  assert.deepEqual(jr.devanagariFamilies, [], "JobRez names no Devanagari family, so any Devanagari fails");
  assert.equal(jr.vars["--font-devanagari"], '"DM Sans"', "falls back to the body face so the per-script rule catches it");
  assert.equal(jr.vars["--grad-grad-violet"], "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)");
  assert.equal(templateDirFor(brands.job_rez), join(ROOT, "engine", "render", "templates", "jobrez"));
  assert.throws(() => templateDirFor({ path: "brands/nobody.md" }), /no templates for brand nobody/);
});

test("applyGuards: overflow → missing_glyphs (per-script rule, then coverage) → text_floor → contrast, in that order; a clean layout passes", async () => {
  await ensureFonts(FONTS_DIR);
  const table = loadCoverage(join(FONTS_DIR, "coverage.json"));
  const run = (over = {}) => ({ text: "Six rules.", family: "Space Grotesk", sizeU: 104, color: "#dfe7f6", bg: "#070b14", contrast: 17.1, element: "h2", ...over });
  const layout = (over = {}) => ({ variant: "A", overflow: false, overflows: [], runs: [run()], minTextU: 104, minContrast: 17.1, canvas: { width: 1080, height: 1350 }, ...over });
  const opts = { devanagariFamilies: ["Noto Sans Devanagari"], table };
  assert.equal(applyGuards(layout(), opts).variant, "A");
  const codes = (l) => {
    try {
      applyGuards(l, opts);
      return null;
    } catch (e) {
      assert.ok(e instanceof RenderError);
      return e;
    }
  };
  const overflow = codes(layout({ overflow: true, overflows: [{ element: "div#canvas", scrollHeight: 1420, clientHeight: 1350, scrollWidth: 1080, clientWidth: 1080, text: "Six rules" }], runs: [run({ sizeU: 10 })] }));
  assert.equal(overflow.code, "overflow", "overflow wins over the text floor");
  assert.match(overflow.detail, /div#canvas 1420 > 1350 px tall/);
  const wide = codes(layout({ overflow: true, overflows: [{ element: "li", scrollHeight: 50, clientHeight: 50, scrollWidth: 1200, clientWidth: 936, text: "max_daily_loss_profit_target" }] }));
  assert.match(wide.detail, /1200 > 936 px wide/);
  const script = codes(layout({ runs: [run({ text: "काट दो.", family: "Space Grotesk" })] }));
  assert.equal(script.code, "missing_glyphs");
  assert.equal(script.rule, "per-script");
  assert.deepEqual(script.missingGlyphs, [0x0915, 0x091f, 0x0926, 0x093e, 0x094b], "the Devanagari code points of काट दो, sorted");
  assert.match(script.detail, /Devanagari run set in Space Grotesk, not a Devanagari family of this brand \(Noto Sans Devanagari\)/);
  const okScript = codes(layout({ runs: [run({ text: "काट दो.", family: "Noto Sans Devanagari" })] }));
  assert.equal(okScript, null, "Devanagari in the brand's Devanagari family passes");
  const glyph = codes(layout({ runs: [run({ text: "Swipe →" })] }));
  assert.equal(glyph.code, "missing_glyphs");
  assert.equal(glyph.rule, "coverage");
  assert.deepEqual(glyph.missingGlyphs, [0x2192]);
  assert.match(glyph.detail, /U\+2192 not in Space Grotesk/);
  const unknown = codes(layout({ runs: [run({ family: "Comic Sans MS" })] }));
  assert.match(unknown.detail, /family not in coverage table/);
  const floor = codes(layout({ runs: [run(), run({ text: "kaatdo.com", sizeU: 24, element: "div.foot" })] }));
  assert.equal(floor.code, "text_floor");
  assert.match(floor.detail, new RegExp(`div\\.foot text 24 u below ${TEXT_FLOOR_U} u`));
  const contrast = codes(layout({ runs: [run({ text: "footer", sizeU: 30, color: "#5a6890", bg: "#070b14", contrast: 3.52 })] }));
  assert.equal(contrast.code, "contrast");
  assert.match(contrast.detail, new RegExp(`#5a6890 on #070b14 is 3.52:1, below ${CONTRAST_MIN}:1 at 30 u`));
  assert.equal(codes(layout({ runs: [run({ sizeU: 60, contrast: 3.1 })] })), null, "≥ 60 u text needs 3:1");
  assert.equal(codes(layout({ runs: [run({ sizeU: 59, contrast: 3.1 })] })).code, "contrast");
  assert.equal(codes(layout({ canvas: { width: 1080, height: 1080 } })).code, "media_spec");
});

test("checkJpeg reads the JPEG back: the fixture JPEG passes, PNG bytes / wrong SOF size / > 1.5 MB are media_spec", () => {
  const jpeg = readFileSync(join(ROOT, "tests", "fixtures", "media", "fixture-1080x1350.jpg"));
  assert.deepEqual(checkJpeg(jpeg), { width: 1080, height: 1350 });
  assert.throws(() => checkJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), (e) => e instanceof RenderError && e.code === "media_spec" && /not a JPEG/.test(e.detail));
  const big = Buffer.alloc(MAX_MEDIA_BYTES + 1);
  jpeg.copy(big, 0);
  assert.throws(() => checkJpeg(big), (e) => e.code === "media_spec" && /1500001 bytes > 1500000 bytes/.test(e.detail));
});

// ---------------------------------------------------------------------------------------
// Browser-backed smoke (RENDER_TESTS=1)

let browser = null;
let out = null;

before(async () => {
  if (!RENDER) return;
  await ensureFonts(FONTS_DIR);
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  out = tmpDir("hoshlab-render-");
});

after(async () => {
  if (browser) await browser.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

function assertJpegFile(dir, m) {
  const file = join(dir, m.file);
  assert.ok(existsSync(file), `${file} written`);
  const buf = readFileSync(file);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  assert.deepEqual(jpegSize(buf), { width: 1080, height: 1350 });
  assert.ok(buf.length <= MAX_MEDIA_BYTES, `${buf.length} bytes ≤ 1.5 MB`);
  assert.equal(m.bytes, buf.length);
  assert.equal(statSync(file).size, m.bytes);
  const sha = createHash("sha256").update(buf).digest("hex");
  assert.equal(m.sha256, sha);
  assert.ok(m.file.endsWith(`-${sha.slice(0, 8)}.jpg`), "sha8-named");
  assert.equal(m.width, 1080);
  assert.equal(m.height, 1350);
  assert.ok(m.minTextU >= 30, `minTextU ${m.minTextU} ≥ 30 (M13)`);
  assert.ok(m.minContrast >= 4.5, `minContrast ${m.minContrast} ≥ 4.5 (M13)`);
}

test("render smoke: one fixture draft per brand → JPEG FF D8, 1080×1350, ≤ 1.5 MB, sha8 file names, minTextU ≥ 30 and minContrast ≥ 4.5 (M13)", { skip: SKIP }, async () => {
  for (const draft of [RP, KD]) {
    const dir = join(out, draft.id);
    const r = await renderDraft({ draft, brand: brands[draft.page], outDir: dir, browser });
    assert.equal(r.media.length, 1, draft.id);
    assert.match(r.media[0].file, /^image-1-[0-9a-f]{8}\.jpg$/);
    assert.equal(r.media[0].path, `media/${draft.id}/${r.media[0].file}`);
    assert.equal(r.media[0].variant, "A", `${draft.id} headline ≤ 36 chars → tier A`);
    assertJpegFile(dir, r.media[0]);
    assert.deepEqual(readdirSync(dir), [r.media[0].file]);
  }
  const dir = join(out, JR.id);
  const jr = await renderDraft({ draft: JR, brand: brands.job_rez, outDir: dir, browser });
  assert.equal(jr.media.length, 4, "carousel fixture → 4 slide files");
  assert.deepEqual(jr.media.map((m) => m.file.replace(/-[0-9a-f]{8}\.jpg$/, "")), ["slide-1", "slide-2", "slide-3", "slide-4"]);
  for (const m of jr.media) assertJpegFile(dir, m);
  assert.equal(jr.media[0].palette, "cream on ink");
  assert.equal(jr.media[1].palette, "violet on cream");
  assert.equal(new Set(jr.media.map((m) => m.sha256)).size, 4, "every slide is a different image");
});

test("render smoke: carousel templates of RishtaPatra and KaatDo (writer fixture slides) render every slide, KaatDo body slides on the light palette", { skip: SKIP }, async () => {
  for (const page of ["rishtapatra", "kaatdo"]) {
    const draft = sampleDraft({ root: ROOT, page, format: "carousel" });
    assert.equal(draft.format, "carousel");
    const dir = join(out, `${page}-carousel`);
    const r = await renderDraft({ draft, brand: brands[page], outDir: dir, browser });
    assert.equal(r.media.length, draft.slides.length);
    for (const m of r.media) assertJpegFile(dir, m);
    if (page === "kaatdo") {
      assert.equal(r.media[0].palette, "dark console palette");
      assert.equal(r.media[1].palette, "light palette");
      assert.equal(r.media[r.media.length - 1].palette, "dark console palette");
    } else assert.equal(r.media[0].palette, "maroon and cream");
  }
});

// FEAT-205 (plan D23): the owner's preference reaches the templates as window.__PREFER__ — the tier is set instead
// of the measured one, the KaatDo carousel body slides follow a `dark` palette preference, other palettes report
// themselves so `applied` tells the Designer what happened; no preference → byte-identical to the renders above.
test("render smoke: prefer { variant: 'B' } renders the KaatDo image on tier B (applied.variant true); prefer { palette: 'dark' } keeps the KaatDo body slides on the console palette; RishtaPatra offers no dark image palette (applied.palette false); without prefer the result is unchanged", { skip: SKIP }, async () => {
  const dirB = join(out, "kd-prefer-b");
  const b = await renderDraft({ draft: KD, brand: brands.kaatdo, outDir: dirB, browser, prefer: { variant: "B", palette: null } });
  assert.equal(b.media[0].variant, "B", "the measured tier is A (headline ≤ 36 chars); the preferred tier wins");
  assert.equal(b.media[0].paletteKind, "dark");
  assert.deepEqual(b.prefer, { variant: "B", palette: null });
  assert.deepEqual(b.applied, { variant: true, palette: null });
  assertJpegFile(dirB, b.media[0]);
  const plain = await renderDraft({ draft: KD, brand: brands.kaatdo, outDir: join(out, "kd-plain"), browser });
  assert.equal(plain.media[0].variant, "A");
  assert.equal(plain.prefer, null);
  assert.equal(plain.applied, null);
  assert.notEqual(plain.media[0].sha256, b.media[0].sha256, "a different tier is a different image");
  assert.equal(plain.media[0].paletteKind, "dark");
  const again = await renderDraft({ draft: KD, brand: brands.kaatdo, outDir: join(out, "kd-plain-2"), browser, prefer: { variant: null, palette: null } });
  assert.equal(again.media[0].sha256, plain.media[0].sha256, "an empty preference renders exactly the plain image");

  const kdc = sampleDraft({ root: ROOT, page: "kaatdo", format: "carousel" });
  const dark = await renderDraft({ draft: kdc, brand: brands.kaatdo, outDir: join(out, "kd-carousel-dark"), browser, prefer: { variant: null, palette: "dark" } });
  assert.deepEqual([...new Set(dark.media.map((m) => m.palette))], ["dark console palette"], "every slide stays on the console palette");
  assert.deepEqual([...new Set(dark.media.map((m) => m.paletteKind))], ["dark"]);
  assert.deepEqual(dark.applied, { variant: null, palette: true });
  for (const m of dark.media) assertJpegFile(join(out, "kd-carousel-dark"), m);
  const light = await renderDraft({ draft: kdc, brand: brands.kaatdo, outDir: join(out, "kd-carousel-light"), browser, prefer: { variant: null, palette: "light" } });
  assert.equal(light.media[1].palette, "light palette", "light is the body slides' default; the preference is simply followed");
  assert.equal(light.media[0].palette, "dark console palette", "cover and recap have one palette");
  assert.deepEqual(light.applied, { variant: null, palette: true });
  assert.notEqual(dark.media[1].sha256, light.media[1].sha256);

  const rp = await renderDraft({ draft: RP, brand: brands.rishtapatra, outDir: join(out, "rp-prefer-dark"), browser, prefer: { variant: null, palette: "dark" } });
  assert.equal(rp.media[0].palette, "cream and maroon", "the RishtaPatra image has one palette");
  assert.equal(rp.media[0].paletteKind, "light");
  assert.deepEqual(rp.applied, { variant: null, palette: false }, "not offered → the Designer records 'brand palette kept'");
  const rpc = sampleDraft({ root: ROOT, page: "rishtapatra", format: "carousel" });
  const rpDark = await renderDraft({ draft: rpc, brand: brands.rishtapatra, outDir: join(out, "rp-carousel-dark"), browser, prefer: { variant: null, palette: "dark" } });
  assert.deepEqual(rpDark.media.map((m) => m.paletteKind), ["dark", ...rpc.slides.slice(1).map(() => "light")], "the maroon cover is the brand's dark palette; the body stays cream");
  assert.equal(rpDark.applied.palette, true);
});

test("render smoke: Devanagari inside a Latin-only element (JobRez has no Devanagari family) is refused with missingGlyphs.length > 0 (M8); nothing is written", { skip: SKIP }, async () => {
  const draft = { ...JR, format: "image", artwork: { headline: "Free कुंडली for every role", subline: "One master resume.", facts: ["Branch it per role."], footer: "jobrez.com" } };
  delete draft.slides;
  const dir = join(out, "jr-devanagari");
  await assert.rejects(
    renderDraft({ draft, brand: brands.job_rez, outDir: dir, browser }),
    (e) => {
      assert.ok(e instanceof RenderError, String(e));
      assert.equal(e.code, "missing_glyphs");
      assert.ok(Array.isArray(e.missingGlyphs) && e.missingGlyphs.length > 0, "missingGlyphs listed");
      assert.ok(e.missingGlyphs.every((cp) => cp >= 0x0900 && cp <= 0x097f));
      assert.equal(e.rule, "per-script");
      assert.match(e.detail, /not a Devanagari family of this brand \(none\)/);
      return true;
    },
  );
  assert.equal(existsSync(dir), false, "no file written for a refused draft");
  // a glyph no self-hosted family has (→ U+2192) in a RishtaPatra fact row → coverage rule
  const arrow = { ...RP, artwork: { ...RP.artwork, facts: ["Janam Kundali → free"] } };
  await assert.rejects(renderDraft({ draft: arrow, brand: brands.rishtapatra, outDir: join(out, "rp-arrow"), browser }), (e) => e.code === "missing_glyphs" && e.rule === "coverage" && e.missingGlyphs[0] === 0x2192);
});

test("render smoke: an over-long headline is refused with 'overflow' and the canvas named; an unbreakable word is refused as horizontal overflow", { skip: SKIP }, async () => {
  const long = { ...KD, artwork: { ...KD.artwork, headline: "When a rule breaks the server cancels every pending order squares off every position at market and keeps the account locked until the close of the session so that one bad day cannot become a ruinous one and the trader keeps the calm that the rule was written to protect in the first place ".repeat(2).trim() } };
  await assert.rejects(renderDraft({ draft: long, brand: brands.kaatdo, outDir: join(out, "kd-long"), browser }), (e) => {
    assert.ok(e instanceof RenderError, String(e));
    assert.equal(e.code, "overflow");
    assert.match(e.detail, /div#canvas\.post\.post-kd \d+ > 1350 px tall/);
    return true;
  });
  const wide = { ...KD, artwork: { ...KD.artwork, facts: ["max_daily_loss_profit_target_max_trades_kill_time_kill_days_kill_dates_all"] } };
  await assert.rejects(renderDraft({ draft: wide, brand: brands.kaatdo, outDir: join(out, "kd-wide"), browser }), (e) => e.code === "overflow" && / px wide/.test(e.detail));
  assert.equal(existsSync(join(out, "kd-long")), false);
});

test("render smoke: a reel draft without a reel block is refused (reels render through video.js — tests/reel-render.test.js), an unknown format is media_spec, and a browser that cannot launch is RenderUnavailableError", { skip: SKIP }, async () => {
  await assert.rejects(renderDraft({ draft: { ...KD, format: "reel" }, brand: brands.kaatdo, outDir: join(out, "kd-reel"), browser }), (e) => e instanceof RenderError && e.code === "media_spec" && /reel draft without a reel block/.test(e.detail));
  await assert.rejects(renderDraft({ draft: { ...KD, format: "story" }, brand: brands.kaatdo, outDir: join(out, "kd-story"), browser }), (e) => e instanceof RenderError && e.code === "media_spec" && /story: unknown format/.test(e.detail));
  const broken = { launch: async () => { throw new Error("no chromium here"); } };
  await assert.rejects(renderDraft({ draft: KD, brand: brands.kaatdo, outDir: join(out, "kd-nolaunch"), chromium: broken }), (e) => e instanceof RenderUnavailableError && e.code === "render_failed" && /no chromium here/.test(e.message));
});

test("render smoke: the fixture company config yields the raw/pages URL hosts the media rows carry", () => {
  assert.equal(config.repo.mediaBranch, "media");
  assert.match(config.site.url, /^https:\/\//);
});
