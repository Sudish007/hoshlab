// Playwright renderer for image and carousel artwork (design.md §10; review M8 per-script font rule +
// cmap coverage, M13 text floor + contrast; plan D19). Opens engine/render/templates/<brand>/<format>.html
// over file://, injects the draft, the brand and its tokens before load, waits for document.fonts.ready,
// runs the template's layout() and applies the guards IN THIS ORDER — overflow, per-script rule,
// glyph coverage, text floor (30 u), contrast (4.5:1, 3:1 at ≥ 60 u) — then screenshots #canvas as
// JPEG quality 90, names the file by its sha256 and reads width/height back from the JPEG SOF marker.
// A guard failure is a RenderError (per-draft: the draft stays `written`); a browser that cannot be
// launched is a RenderUnavailableError (the Designer step fails, the run continues).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_MEDIA_BYTES, MEDIA_HEIGHT, MEDIA_WIDTH, isDevanagari, jpegSize } from "../lib/checks.js";
import { mediaPaths } from "../lib/media.js";
import { coverage, formatCodePoints, isIgnoredCodePoint, loadCoverage, normalizeFamily } from "./coverage.js";

export const RENDER_DIR = fileURLToPath(new URL("./", import.meta.url));
export const TEMPLATES_DIR = join(RENDER_DIR, "templates");
export const FONTS_DIR = join(RENDER_DIR, "fonts");
export const JPEG_QUALITY = 90;
export const TEXT_FLOOR_U = 30;
export const CONTRAST_MIN = 4.5;
export const CONTRAST_MIN_LARGE = 3;
export const LARGE_TEXT_U = 60;
// RenderError codes raised here: overflow | missing_glyphs | text_floor | contrast | media_spec (schema RENDER_ERROR_CODES)
export const FORMATS = { image: "image.html", carousel: "carousel.html" };

// Per-draft refusal: the draft stays `written`, renderError = { code, detail, at } (design §11).
export class RenderError extends Error {
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = "RenderError";
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

// Chromium could not be launched / a font face failed to load: the Designer step fails (`render_failed`).
export class RenderUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "RenderUnavailableError";
    this.code = "render_failed";
    if (cause) this.cause = cause;
  }
}

// 'Inter / Mukta' → ['Inter', 'Mukta']; 'Cormorant Garamond 700' → ['Cormorant Garamond'];
// 'Manrope 800, letter-spacing -0.05em' → ['Manrope']; 'Space Grotesk 400/500/700' → ['Space Grotesk'].
export function fontFamilies(value) {
  const head = String(value ?? "").split(",")[0];
  return head
    .split("/")
    .map((s) => s.replace(/\s*\d{3}(?:\s*\/\s*\d{3})*\s*$/, "").trim())
    .filter(Boolean);
}

const quote = (f) => `"${f}"`;

// brandTokens(brand, coverageTable) → { vars, families, devanagariFamilies }
//   vars: CSS custom properties for the template (--c-<colour>, --grad-<gradient>, --font-<font>,
//   --font-devanagari). A brand without a Devanagari family (JobRez) gets its body face as
//   --font-devanagari, so a Devanagari run computes to a Latin family and the per-script rule refuses it.
//   devanagariFamilies: the Devanagari-capable families named in ## Tokens — those whose cmap covers 'क'.
export function brandTokens(brand, table) {
  const tk = brand.tokens || {};
  const vars = {};
  for (const [name, value] of Object.entries(tk.colours || {})) vars[`--c-${name}`] = value;
  for (const [name, value] of Object.entries(tk.gradients || {})) vars[`--grad-${name}`] = value;
  const families = new Set();
  for (const [name, value] of Object.entries(tk.fonts || {})) {
    const fams = fontFamilies(value);
    if (!fams.length) continue;
    vars[`--font-${name}`] = fams.map(quote).join(", ");
    for (const f of fams) families.add(f);
  }
  const devanagari = tk.devanagariFamily ? fontFamilies(tk.devanagariFamily) : [];
  if (devanagari.length) {
    vars["--font-devanagari"] = devanagari.map(quote).join(", ");
    for (const f of devanagari) families.add(f);
  } else vars["--font-devanagari"] = vars["--font-body"] || vars["--font-ui"] || vars["--font-display"] || "serif";
  const devanagariFamilies = [...families].filter((f) => (table ? coverage(f, "क", table).ok : devanagari.includes(f)));
  return { vars, families: [...families], devanagariFamilies };
}

// What the template reads as window.__BRAND__ (front matter only; never facts or prices).
export function brandInfo(brand) {
  const fm = brand.frontMatter || {};
  return { handle: fm.handle || "", name: fm.name || "", nameDevanagari: fm.nameDevanagari || "", site: fm.site || "" };
}

// engine/render/templates/<brand folder>/ — the folder is the brand file's name (brands/jobrez.md → jobrez).
export function templateDirFor(brand, templatesRoot = TEMPLATES_DIR) {
  const source = brand.path || brand.file || "";
  const folder = basename(String(source)).replace(/\.md$/i, "");
  if (!folder) throw new TypeError("render: brand has no path/file to derive the template folder from");
  const dir = join(templatesRoot, folder);
  if (!existsSync(dir)) throw new TypeError(`render: no templates for brand ${folder} at ${dir}`);
  return dir;
}

// Builds engine/render/fonts/ when it is missing (review N8: build and engine call build:fonts themselves).
export async function ensureFonts(fontsDir = FONTS_DIR) {
  if (existsSync(join(fontsDir, "coverage.json")) && existsSync(join(fontsDir, "fonts.css"))) return false;
  const { buildFonts } = await import("../../scripts/build-fonts.mjs");
  buildFonts({ outDir: fontsDir });
  return true;
}

const clip = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The render guards over a template's layout() result (pure: unit-tested without a browser).
// Throws RenderError in the order overflow → missing_glyphs (per-script rule, then coverage) → text_floor → contrast.
export function applyGuards(result, { devanagariFamilies = [], table, textFloorU = TEXT_FLOOR_U } = {}) {
  if (!result || !Array.isArray(result.runs)) throw new TypeError("render: layout() returned no runs");
  if (result.canvas && (result.canvas.width !== MEDIA_WIDTH || result.canvas.height !== MEDIA_HEIGHT)) {
    throw new RenderError("media_spec", `canvas ${result.canvas.width}x${result.canvas.height}, expected ${MEDIA_WIDTH}x${MEDIA_HEIGHT}`);
  }
  if (result.overflow) {
    const o = (result.overflows && result.overflows[0]) || {};
    const axis = o.scrollHeight > o.clientHeight + 1 ? `${o.scrollHeight} > ${o.clientHeight} px tall` : `${o.scrollWidth} > ${o.clientWidth} px wide`;
    throw new RenderError("overflow", `${o.element || "canvas"} ${axis}: “${clip(o.text)}”`, { overflows: result.overflows || [] });
  }
  const allowed = new Set(devanagariFamilies.map(normalizeFamily));
  for (const run of result.runs) {
    const cps = [...String(run.text)].map((ch) => ch.codePointAt(0)).filter((cp) => !isIgnoredCodePoint(cp));
    const devanagari = [...new Set(cps.filter(isDevanagari))].sort((a, b) => a - b);
    if (devanagari.length && !allowed.has(normalizeFamily(run.family))) {
      throw new RenderError("missing_glyphs", `Devanagari run set in ${run.family}, not a Devanagari family of this brand (${devanagariFamilies.join(", ") || "none"}): “${clip(run.text)}”`, { missingGlyphs: devanagari, family: run.family, text: run.text, rule: "per-script" });
    }
    if (table) {
      const cov = coverage(run.family, run.text, table);
      if (!cov.ok) {
        throw new RenderError("missing_glyphs", `${formatCodePoints(cov.missing)} not in ${run.family}${cov.known ? "" : " (family not in coverage table)"}: “${clip(run.text)}”`, { missingGlyphs: cov.missing, family: run.family, text: run.text, rule: "coverage" });
      }
    }
  }
  for (const run of result.runs) {
    if (run.sizeU < textFloorU) throw new RenderError("text_floor", `${run.element} text ${run.sizeU} u below ${textFloorU} u: “${clip(run.text)}”`, { run });
  }
  for (const run of result.runs) {
    const min = run.sizeU >= LARGE_TEXT_U ? CONTRAST_MIN_LARGE : CONTRAST_MIN;
    if (run.contrast < min) throw new RenderError("contrast", `${run.element} ${run.color} on ${run.bg} is ${run.contrast}:1, below ${min}:1 at ${run.sizeU} u: “${clip(run.text)}”`, { run });
  }
  return result;
}

// Reads the JPEG back (magic, SOF dimensions, size) — never trusts the screenshot call (design §10).
export function checkJpeg(buf) {
  let dims;
  try {
    dims = jpegSize(buf);
  } catch (e) {
    throw new RenderError("media_spec", `screenshot is not a JPEG (${e.message})`);
  }
  if (dims.width !== MEDIA_WIDTH || dims.height !== MEDIA_HEIGHT) throw new RenderError("media_spec", `jpeg ${dims.width}x${dims.height}, expected ${MEDIA_WIDTH}x${MEDIA_HEIGHT}`);
  if (buf.length > MAX_MEDIA_BYTES) throw new RenderError("media_spec", `jpeg ${buf.length} bytes > ${MAX_MEDIA_BYTES} bytes`);
  return dims;
}

async function launch(chromium) {
  try {
    const pw = chromium || (await import("playwright")).chromium;
    return await pw.launch({ headless: true });
  } catch (e) {
    throw new RenderUnavailableError(`Chromium could not be launched: ${e && e.message ? e.message.split("\n")[0] : e}`, e);
  }
}

// One page: inject → load → fonts.ready → layout() → guard(layout) → JPEG of #canvas. The context is
// closed on every path; a failed font face is an environment problem, not a draft problem.
async function renderOne(browser, { templateFile, payload, guard }) {
  const context = await browser.newContext({ viewport: { width: MEDIA_WIDTH, height: MEDIA_HEIGHT }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.addInitScript((p) => {
      window.__DRAFT__ = p.draft;
      window.__BRAND__ = p.brand;
      window.__TOKENS__ = p.tokens;
      window.__SLIDE__ = p.slide;
    }, payload);
    await page.goto(pathToFileURL(templateFile).href, { waitUntil: "load" });
    const fonts = await page.evaluate(() => document.fonts.ready.then(() => ({ status: document.fonts.status, failed: Array.from(document.fonts).filter((f) => f.status === "error").map((f) => `${f.family} ${f.weight}`) })));
    if (fonts.failed.length) throw new RenderUnavailableError(`font face failed to load: ${fonts.failed.join(", ")} (run npm run build:fonts)`);
    const layout = await page.evaluate(() => window.layout());
    guard(layout);
    const buf = Buffer.from(await page.locator("#canvas").screenshot({ type: "jpeg", quality: JPEG_QUALITY }));
    return { layout, buf };
  } finally {
    await context.close().catch(() => {});
  }
}

// renderDraft({ draft, brand, outDir, relDir?, templateDir?, templatesRoot?, fontsDir?, coverageTable?, chromium?, browser? })
//   → { media: [{ kind, file, path, bytes, width, height, sha256, variant, palette, minTextU, minContrast }], variant, palette }
// Files are written to outDir as image-<n>-<sha8>.jpg (image) / slide-<n>-<sha8>.jpg (carousel); `path` is
// relDir + file (default 'media/<draftId>/<file>'). An injected `browser` is reused and left open.
export async function renderDraft({ draft, brand, outDir, relDir, templateDir, templatesRoot = TEMPLATES_DIR, fontsDir = FONTS_DIR, coverageTable, chromium, browser } = {}) {
  if (!draft || !brand || !outDir) throw new TypeError("render: draft, brand and outDir are required");
  const format = draft.format;
  const file = FORMATS[format];
  if (!file) throw new RenderError("media_spec", `${format}: not built yet (phase 2; features.reels is false)`);
  await ensureFonts(fontsDir);
  const table = coverageTable || loadCoverage(join(fontsDir, "coverage.json"));
  const tokens = brandTokens(brand, table);
  const info = brandInfo(brand);
  const dir = templateDir || templateDirFor(brand, templatesRoot);
  const templateFile = join(dir, file);
  if (!existsSync(templateFile)) throw new TypeError(`render: template missing ${templateFile}`);
  const rel = relDir === undefined ? mediaPaths(draft.id).dir : relDir;
  const slides = format === "carousel" ? (Array.isArray(draft.slides) ? draft.slides.length : 0) : 1;
  if (format === "carousel" && (slides < 2 || slides > 10)) throw new RenderError("media_spec", `carousel needs 2–10 slides, got ${slides}`);

  const own = !browser;
  const b = browser || (await launch(chromium));
  const media = [];
  try {
    for (let i = 0; i < slides; i++) {
      const payload = { draft, brand: info, tokens: { vars: tokens.vars }, slide: i };
      const { layout, buf } = await renderOne(b, { templateFile, payload, guard: (l) => applyGuards(l, { devanagariFamilies: tokens.devanagariFamilies, table }) });
      const dims = checkJpeg(buf);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const name = `${format === "carousel" ? "slide" : "image"}-${i + 1}-${sha256.slice(0, 8)}.jpg`;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, name), buf);
      media.push({ kind: "image", file: name, path: `${rel}${name}`, bytes: buf.length, width: dims.width, height: dims.height, sha256, variant: layout.variant, palette: layout.palette || null, minTextU: layout.minTextU, minContrast: layout.minContrast });
    }
  } finally {
    if (own) await b.close().catch(() => {});
  }
  return { media, variant: media[0] ? media[0].variant : null, palette: media[0] ? media[0].palette : null };
}

// createRenderer({ chromium?, templatesRoot?, fontsDir?, coverageTable? }) → { renderDraft(draft, brand, { outDir, relDir }), close() }
// One Chromium for many drafts (the Designer renders every `written` draft of a run); launch is lazy, so a
// machine without Chromium only fails when a draft actually needs rendering (RenderUnavailableError).
export function createRenderer({ chromium, templatesRoot = TEMPLATES_DIR, fontsDir = FONTS_DIR, coverageTable } = {}) {
  let browser = null;
  let table = coverageTable || null;
  return {
    async renderDraft(draft, brand, { outDir, relDir } = {}) {
      if (!table) {
        await ensureFonts(fontsDir);
        table = loadCoverage(join(fontsDir, "coverage.json"));
      }
      if (!browser) browser = await launch(chromium);
      return renderDraft({ draft, brand, outDir, relDir, templatesRoot, fontsDir, coverageTable: table, browser });
    },
    async close() {
      if (browser) await browser.close().catch(() => {});
      browser = null;
    },
  };
}
