// Reel rendering (design.md §10 "Reel", plan D17/D22, FEAT-201): one frame pipeline for both styles.
//
//   renderReel({ draft, brand, templateDir, outDir, relDir, style?, frames?, fps = 30, ffmpegPath, ffprobePath, browser, chromium,
//                coverageTable, fontsDir, keepFrames })
//     1. open templates/<brand>/reel-<style>.html over file:// at 1080×1920 with window.__DRAFT__ / __BRAND__ / __TOKENS__
//        and, for capture, window.__FRAMES__ (one pre-captured product screenshot per scene, from capture.js);
//     2. ready() (fonts + frame images decoded), layout() over every scene → the same guards as the images
//        (overflow → missing_glyphs → text_floor → contrast → canvas 1080×1920; render.js applyGuards);
//     3. N = round(durationSec × fps) frames: setProgress(i / N) then a PNG screenshot of #canvas → frame-%05d.png in a
//        mkdtemp dir (deterministic: a frame is a pure function of its progress value);
//     4. frame 0 is also screenshotted as the poster (JPEG quality 90, 1080×1920 read back from the SOF marker, ≤ 1.5 MB);
//     5. ffmpeg -framerate 30 -i frame-%05d.png -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -movflags +faststart
//        -an -r 30 out.mp4 (spawnSync, no shell), then ffprobe (probe.js) → assertReel must hold;
//     6. files are named by sha256: reel-<sha8>.mp4 + poster-<sha8>.jpg under outDir.
//     → { media: [{ kind: 'video', file, path, bytes, width, height, durationSec, sha256, probe }, { kind: 'poster', … }],
//         style, scenes, durationSec, frames: N, variant, palette, minTextU, minContrast }
//
//   Errors: RenderError (guard failures — the Writer reworks the draft, R1-02), RenderUnavailableError code 'render_failed'
//   (Chromium / fonts: the step stops) and RenderUnavailableError code 'ffmpeg' (ffmpeg/ffprobe missing, encoder failure
//   or a probe assertion failing — the draft stays `written`, the Designer notes 'reel: untested — ffmpeg not installed').
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { MAX_MEDIA_BYTES, REEL_HEIGHT, REEL_WIDTH, jpegSize } from "../lib/checks.js";
import { REEL_STYLES } from "../lib/schema.js";
import { mediaPaths } from "../lib/media.js";
import { loadCoverage } from "./coverage.js";
import { FONTS_DIR, JPEG_QUALITY, RenderError, RenderUnavailableError, applyGuards, brandInfo, brandTokens, ensureFonts, launchBrowser } from "./render.js";
import { ProbeError, ProbeUnavailableError, assertReel, probe, summarize } from "./probe.js";

export const REEL_FPS = 30;
export const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const DEFAULT_FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
export const REEL_TEMPLATES = { kinetic: "reel-kinetic.html", capture: "reel-capture.html" };
export const FFMPEG_ARGS = (framesDir, out, fps = REEL_FPS) => ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(fps), "-i", join(framesDir, "frame-%05d.png"), "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", "-r", String(fps), out];

export function ffmpegMissingError(cmd, cause) {
  return new RenderUnavailableError(`${cmd} not installed (spawn ENOENT) — reel: untested`, cause, "ffmpeg");
}

// reelDuration(reel) → the sum of the scenes' seconds (the truth the frame count is built from).
export function reelDuration(reel) {
  return (reel && Array.isArray(reel.scenes) ? reel.scenes : []).reduce((s, sc) => s + (Number(sc && sc.seconds) || 0), 0);
}

// Opens the template and prepares the page: inject → load → ready() → layout() → guards. Returns { page, layout }.
// Exported for the frames-only tests (they run without ffmpeg); renderReel is the pipeline.
export async function openReel(context, { templateFile, payload, guard }) {
  const page = await context.newPage();
  await page.addInitScript((p) => {
    window.__DRAFT__ = p.draft;
    window.__BRAND__ = p.brand;
    window.__TOKENS__ = p.tokens;
    window.__FRAMES__ = p.frames;
  }, payload);
  await page.goto(pathToFileURL(templateFile).href, { waitUntil: "load" });
  const fonts = await page.evaluate(() => document.fonts.ready.then(() => ({ status: document.fonts.status, failed: Array.from(document.fonts).filter((f) => f.status === "error").map((f) => `${f.family} ${f.weight}`) })));
  if (fonts.failed.length) throw new RenderUnavailableError(`font face failed to load: ${fonts.failed.join(", ")} (run npm run build:fonts)`);
  await page.evaluate(() => (typeof window.ready === "function" ? window.ready() : null));
  const layout = await page.evaluate(() => window.layout());
  guard(layout);
  if (typeof layout.style !== "string") throw new RenderError("media_spec", "reel template exposes no setProgress/layout driver (reel.js missing)");
  return { page, layout };
}

// renderFrames(page, { durationSec, fps, framesDir, canvas }) → { count, poster (Buffer), frameFiles[] }
// The frame loop: setProgress(i / N) then a PNG of #canvas; frame 0 doubles as the JPEG poster.
export async function renderFrames(page, { durationSec, fps = REEL_FPS, framesDir }) {
  const count = Math.round(durationSec * fps);
  if (count < 1) throw new RenderError("media_spec", `reel duration ${durationSec} s yields no frames`);
  const canvas = page.locator("#canvas");
  let poster = null;
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => window.setProgress(t), i / count);
    const png = Buffer.from(await canvas.screenshot({ type: "png", animations: "disabled", caret: "hide" }));
    writeFileSync(join(framesDir, `frame-${String(i).padStart(5, "0")}.png`), png);
    if (i === 0) poster = Buffer.from(await canvas.screenshot({ type: "jpeg", quality: JPEG_QUALITY, animations: "disabled", caret: "hide" }));
  }
  return { count, poster };
}

// checkPoster(buf) → { width, height }: JPEG magic, SOF 1080×1920, ≤ 1.5 MB (read back, never trusted).
export function checkPoster(buf) {
  let dims;
  try {
    dims = jpegSize(buf);
  } catch (e) {
    throw new RenderError("media_spec", `poster is not a JPEG (${e.message})`);
  }
  if (dims.width !== REEL_WIDTH || dims.height !== REEL_HEIGHT) throw new RenderError("media_spec", `poster ${dims.width}x${dims.height}, expected ${REEL_WIDTH}x${REEL_HEIGHT}`);
  if (buf.length > MAX_MEDIA_BYTES) throw new RenderError("media_spec", `poster ${buf.length} bytes > ${MAX_MEDIA_BYTES} bytes`);
  return dims;
}

// encode(framesDir, out, { ffmpegPath, fps }) — runs ffmpeg (no shell). Missing binary → RenderUnavailableError 'ffmpeg'.
export function encode(framesDir, out, { ffmpegPath = DEFAULT_FFMPEG, fps = REEL_FPS } = {}) {
  const r = spawnSync(ffmpegPath, FFMPEG_ARGS(framesDir, out, fps), { encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === "ENOENT") throw ffmpegMissingError(ffmpegPath, r.error);
    throw new RenderUnavailableError(`${ffmpegPath} could not be started: ${r.error.message}`, r.error, "ffmpeg");
  }
  if (r.status !== 0) throw new RenderUnavailableError(`ffmpeg exited ${r.status}: ${String(r.stderr || "").trim().split("\n").slice(-3).join(" | ")}`, null, "ffmpeg");
  if (!existsSync(out)) throw new RenderUnavailableError("ffmpeg exited 0 but wrote no file", null, "ffmpeg");
  return out;
}

// probeReel(path, { ffprobePath }) → { json, summary } with assertReel satisfied; otherwise RenderUnavailableError 'ffmpeg'.
export function probeReel(path, { ffprobePath = DEFAULT_FFPROBE } = {}) {
  let json;
  try {
    json = probe(path, { ffprobePath });
  } catch (e) {
    if (e instanceof ProbeUnavailableError) throw ffmpegMissingError(ffprobePath, e);
    if (e instanceof ProbeError) throw new RenderUnavailableError(`ffprobe: ${e.message}`, e, "ffmpeg");
    throw e;
  }
  const errors = assertReel(json);
  const summary = summarize(json);
  if (errors.length) throw new RenderUnavailableError(`ffprobe: encoded reel fails the spec — ${errors.join("; ")}`, null, "ffmpeg", { probe: summary, errors });
  return { json, summary };
}

// renderReel(opts) → see the file header.
export async function renderReel({ draft, brand, templateDir, outDir, relDir, style, frames = null, fps = REEL_FPS, ffmpegPath = DEFAULT_FFMPEG, ffprobePath = DEFAULT_FFPROBE, browser, chromium, coverageTable, fontsDir = FONTS_DIR, keepFrames = false } = {}) {
  if (!draft || !brand || !templateDir || !outDir) throw new TypeError("video: draft, brand, templateDir and outDir are required");
  const reel = draft.reel;
  if (!reel || !Array.isArray(reel.scenes) || reel.scenes.length < 3 || reel.scenes.length > 6) throw new RenderError("media_spec", `reel needs 3–6 scenes, got ${reel && Array.isArray(reel.scenes) ? reel.scenes.length : 0}`);
  const theStyle = style || reel.style;
  const file = REEL_TEMPLATES[theStyle];
  if (!file) throw new RenderError("media_spec", `reel style ${JSON.stringify(theStyle)} is not one of ${REEL_STYLES.join("|")}`);
  if (theStyle === "capture" && (!Array.isArray(frames) || frames.length === 0)) throw new RenderError("media_spec", "capture reel without product frames");
  const templateFile = join(templateDir, file);
  if (!existsSync(templateFile)) throw new TypeError(`video: template missing ${templateFile}`);
  const durationSec = reelDuration(reel);
  if (Number.isInteger(reel.durationSec) && reel.durationSec !== durationSec) throw new RenderError("media_spec", `reel.durationSec ${reel.durationSec} differs from the scenes' sum ${durationSec}`);
  await ensureFonts(fontsDir);
  const table = coverageTable || loadCoverage(join(fontsDir, "coverage.json"));
  const tokens = brandTokens(brand, table);
  const rel = relDir === undefined ? mediaPaths(draft.id).dir : relDir;

  const own = !browser;
  const b = browser || (await launchBrowser(chromium));
  const framesDir = mkdtempSync(join(tmpdir(), "hoshlab-reel-"));
  let context = null;
  try {
    context = await b.newContext({ viewport: { width: REEL_WIDTH, height: REEL_HEIGHT }, deviceScaleFactor: 1 });
    const payload = { draft, brand: brandInfo(brand), tokens: { vars: tokens.vars }, frames: theStyle === "capture" ? frames.map((f) => ({ dataUrl: f.dataUrl, caption: f.caption })) : null };
    const { page, layout } = await openReel(context, { templateFile, payload, guard: (l) => applyGuards(l, { devanagariFamilies: tokens.devanagariFamilies, table, canvas: { width: REEL_WIDTH, height: REEL_HEIGHT } }) });
    const { count, poster } = await renderFrames(page, { durationSec, fps, framesDir });
    const posterDims = checkPoster(poster);
    await context.close().catch(() => {});
    context = null;

    const mp4 = encode(framesDir, join(framesDir, "out.mp4"), { ffmpegPath, fps });
    const { summary } = probeReel(mp4, { ffprobePath });
    const video = readFileSync(mp4);
    const videoSha = createHash("sha256").update(video).digest("hex");
    const posterSha = createHash("sha256").update(poster).digest("hex");
    const videoName = `reel-${videoSha.slice(0, 8)}.mp4`;
    const posterName = `poster-${posterSha.slice(0, 8)}.jpg`;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, videoName), video);
    writeFileSync(join(outDir, posterName), poster);
    const media = [
      { kind: "video", file: videoName, path: `${rel}${videoName}`, bytes: video.length, width: summary.width, height: summary.height, durationSec: summary.durationSec, sha256: videoSha, probe: summary, variant: layout.variant, palette: layout.palette || null, minTextU: layout.minTextU, minContrast: layout.minContrast },
      { kind: "poster", file: posterName, path: `${rel}${posterName}`, bytes: poster.length, width: posterDims.width, height: posterDims.height, sha256: posterSha, variant: layout.variant, palette: layout.palette || null, minTextU: layout.minTextU, minContrast: layout.minContrast },
    ];
    return { media, style: theStyle, scenes: reel.scenes.length, durationSec, frames: count, variant: layout.variant, palette: layout.palette || null, minTextU: layout.minTextU, minContrast: layout.minContrast, framesDir: keepFrames ? framesDir : null };
  } finally {
    if (context) await context.close().catch(() => {});
    if (own) await b.close().catch(() => {});
    if (!keepFrames) rmSync(framesDir, { recursive: true, force: true });
  }
}

// frameCount(durationSec, fps) — the number of frames a reel of that length has (shared with the tests).
export function frameCount(durationSec, fps = REEL_FPS) {
  return Math.round(durationSec * fps);
}
