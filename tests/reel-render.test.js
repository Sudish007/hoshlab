// Reel rendering (design.md §10, plan D17, P2-01; FEAT-201). Three layers:
//   1. pure (always): reelDuration / frameCount / checkPoster / the ffmpeg argument list / the missing-binary paths.
//   2. frames only (RENDER_TESTS=1, Chromium, no ffmpeg): every brand's kinetic template and the capture template
//      (frames from the fixture product site) pass the render guards and step setProgress(t) into 1080×1920 PNG frames
//      at 30 fps with a 1080×1920 JPEG poster — provable on the owner's machine, which has no ffmpeg.
//   3. the full pipeline (RENDER_TESTS=1 AND ffprobe resolvable — spawnSync ffprobe -version): one kinetic and one
//      capture reel per brand through renderDraft → MP4 + poster, probe() + assertReel pass, 15–30 s, ≤ 60 MB.
//      Without ffprobe it skips with 'skipped: ffmpeg/ffprobe not installed (runs in CI)'; with REQUIRE_FFMPEG=1
//      (ci.yml) a missing ffprobe is a FAILURE, so CI can never silently skip the reel proof.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { get } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, tmpDir } from "./helpers.js";
import siteConfig from "../site.config.js";
import { loadCompany } from "../src/lib/company.js";
import { DRAFT_SPEC, MEDIA_ITEM_SPEC, PROBE_SUMMARY_SPEC, validate } from "../engine/lib/schema.js";
import { MAX_MEDIA_BYTES, REEL_HOUSE_CAP_BYTES, jpegSize, pngSize, runChecks } from "../engine/lib/checks.js";
import { loadCoverage } from "../engine/render/coverage.js";
import { FONTS_DIR, RenderError, RenderUnavailableError, applyGuards, brandInfo, brandTokens, ensureFonts, renderDraft, templateDirFor } from "../engine/render/render.js";
import { FFMPEG_ARGS, REEL_FPS, REEL_TEMPLATES, checkPoster, encode, frameCount, openReel, probeReel, reelDuration, renderFrames, renderReel } from "../engine/render/video.js";
import { captureProduct, framesForScenes } from "../engine/render/capture.js";
import { assertReel, probe } from "../engine/render/probe.js";
import { mediaRows } from "../engine/agents/designer.js";

const RENDER = process.env.RENDER_TESTS === "1";
const REQUIRE_FFMPEG = process.env.REQUIRE_FFMPEG === "1";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SKIP_NO_FFMPEG = "skipped: ffmpeg/ffprobe not installed (runs in CI)";
const SKIP_NO_RENDER = "skipped: set RENDER_TESTS=1 (needs Chromium: npx playwright install chromium)";

function resolvable(cmd) {
  const r = spawnSync(cmd, ["-version"], { encoding: "utf8", shell: false, windowsHide: true });
  return !r.error && r.status === 0;
}
const HAS_FFPROBE = resolvable(FFPROBE) && resolvable(FFMPEG);
const FRAMES_SKIP = RENDER ? false : SKIP_NO_RENDER;
const FULL_SKIP = !HAS_FFPROBE ? SKIP_NO_FFMPEG : !RENDER ? SKIP_NO_RENDER : false;

const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { brands, config } = company;
const FIX = join(ROOT, "tests", "fixtures", "drafts");
const REEL_FIXTURES = readdirSync(FIX).filter((f) => f.includes("-reel-")).map((f) => JSON.parse(readFileSync(join(FIX, f), "utf8")));
const BASE = siteConfig.basePath;
const FIXTURE_SITE = join(ROOT, "tests", "fixtures", "product-site");
const FIXTURE_PATHS = [`${BASE}index.html`, `${BASE}pricing.html`];

// ---------------------------------------------------------------------------------------
// 1. pure

test("reel fixtures: one kinetic reel per brand, 16 s = 4 × 4 s, 480 frames at 30 fps; reelDuration / frameCount agree with the Writer's rule", () => {
  assert.deepEqual(REEL_FIXTURES.map((d) => [d.page, d.reel.style, d.reel.scenes.length, d.reel.durationSec]).sort(), [["job_rez", "kinetic", 4, 16], ["kaatdo", "kinetic", 4, 16], ["rishtapatra", "kinetic", 4, 16]]);
  for (const d of REEL_FIXTURES) {
    assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] }, d.id);
    assert.equal(reelDuration(d.reel), d.reel.durationSec);
    assert.equal(frameCount(reelDuration(d.reel)), 480);
    assert.ok(reelDuration(d.reel) >= config.defaults.reel.minSec && reelDuration(d.reel) <= config.defaults.reel.maxSec);
  }
  assert.equal(REEL_FPS, 30);
  assert.deepEqual(REEL_TEMPLATES, { kinetic: "reel-kinetic.html", capture: "reel-capture.html" });
  for (const b of Object.values(brands)) for (const file of Object.values(REEL_TEMPLATES)) assert.ok(existsSync(join(templateDirFor(b), file)), `${b.frontMatter.handle}/${file}`);
  assert.equal(frameCount(15), 450);
  assert.equal(frameCount(30), 900);
});

test("FFMPEG_ARGS is the design §10 command (libx264 high 4.1, yuv420p, +faststart, no audio, 30 fps in and out) and the missing-binary paths are RenderUnavailableError code ffmpeg", () => {
  const args = FFMPEG_ARGS("/frames", "/frames/out.mp4");
  assert.deepEqual(args.slice(args.indexOf("-framerate")), ["-framerate", "30", "-i", join("/frames", "frame-%05d.png"), "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", "-r", "30", "/frames/out.mp4"]);
  assert.ok(args.includes("-y") && args.includes("-hide_banner"), "overwrite the temp output, keep the log short");
  const missing = join(tmpDir("hoshlab-ffmpeg-missing-"), "ffmpeg-does-not-exist");
  assert.throws(() => encode("/nowhere", "/nowhere/out.mp4", { ffmpegPath: missing }), (e) => e instanceof RenderUnavailableError && e.code === "ffmpeg" && /not installed \(spawn ENOENT\) — reel: untested/.test(e.message));
  assert.throws(() => probeReel("/nowhere/out.mp4", { ffprobePath: missing }), (e) => e instanceof RenderUnavailableError && e.code === "ffmpeg" && /not installed/.test(e.message));
  // checkPoster reads the JPEG back: a 1080×1350 fixture is refused for a reel, PNG bytes are refused
  const feed = readFileSync(join(ROOT, "tests", "fixtures", "media", "fixture-1080x1350.jpg"));
  assert.throws(() => checkPoster(feed), (e) => e instanceof RenderError && e.code === "media_spec" && /poster 1080x1350, expected 1080x1920/.test(e.detail));
  assert.throws(() => checkPoster(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), (e) => e.code === "media_spec" && /poster is not a JPEG/.test(e.detail));
});

test("renderReel refuses a malformed reel block before any rendering: no reel, 2 scenes, unknown style, durationSec ≠ Σ seconds, capture without frames", async () => {
  const base = REEL_FIXTURES.find((d) => d.page === "kaatdo");
  const brand = brands.kaatdo;
  const dir = templateDirFor(brand);
  const out = tmpDir("hoshlab-reel-refuse-");
  const fake = { launch: async () => { throw new Error("must not launch"); } };
  const code = async (draft, extra = {}) => {
    try {
      await renderReel({ draft, brand, templateDir: dir, outDir: out, chromium: fake, ...extra });
      return null;
    } catch (e) {
      assert.ok(e instanceof RenderError, String(e));
      return e;
    }
  };
  assert.match((await code({ ...base, reel: undefined })).detail, /reel needs 3–6 scenes, got 0/);
  assert.match((await code({ ...base, reel: { ...base.reel, scenes: base.reel.scenes.slice(0, 2) } })).detail, /reel needs 3–6 scenes, got 2/);
  assert.match((await code({ ...base, reel: { ...base.reel, style: "slides" } })).detail, /reel style "slides" is not one of kinetic\|capture/);
  assert.match((await code({ ...base, reel: { ...base.reel, durationSec: 20 } })).detail, /reel\.durationSec 20 differs from the scenes' sum 16/);
  assert.match((await code({ ...base, reel: { ...base.reel, style: "capture" } })).detail, /capture reel without product frames/);
  await assert.rejects(renderReel({ draft: base, brand, templateDir: join(out, "no-templates"), outDir: out, chromium: fake }), TypeError);
  // renderDraft routes a reel draft without a reel block to media_spec too
  await assert.rejects(renderDraft({ draft: { ...base, reel: undefined }, brand, outDir: out, chromium: fake }), (e) => e instanceof RenderError && /reel draft without a reel block/.test(e.detail));
  rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// shared browser + fixture product server for layers 2 and 3

let browser = null;
let server = null;
let origin = null;
let table = null;

function freePort(start) {
  return new Promise((resolvePort) => {
    const tryPort = (p) => {
      const srv = createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolvePort(p)));
    };
    tryPort(start);
  });
}
function status(url) {
  return new Promise((resolveStatus) => {
    const req = get(url, (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    });
    req.on("error", () => resolveStatus(0));
  });
}

before(async () => {
  if (REQUIRE_FFMPEG) assert.ok(HAS_FFPROBE, `REQUIRE_FFMPEG=1 but ffmpeg/ffprobe are not resolvable (${FFMPEG}, ${FFPROBE}) — CI must never silently skip the reel proof`);
  if (!RENDER) return;
  await ensureFonts(FONTS_DIR);
  table = loadCoverage(join(FONTS_DIR, "coverage.json"));
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });
  const port = await freePort(8381);
  server = spawn(process.execPath, [join(ROOT, "scripts", "serve.mjs")], { env: { ...process.env, PORT: String(port), DIST_DIR: FIXTURE_SITE }, stdio: "ignore" });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if ((await status(`${origin}${BASE}index.html`)) === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`serve.mjs did not come up on ${origin}`);
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

// The brand with its allowed host pointed at the fixture product server (the capture allow-list is on the URL's host).
const fixtureBrand = (brand) => ({ ...brand, allowedDomains: ["127.0.0.1"], capture: { verifiedAt: "2026-10-11", notes: "fixture", paths: FIXTURE_PATHS.map((p) => ({ path: p, source: "hoshlab/tests/fixtures/product-site/index.html:1" })) } });

// ---------------------------------------------------------------------------------------
// 2. frames only (Chromium, no ffmpeg)

async function framesOf(draft, brand, style, frames = null) {
  const tokens = brandTokens(brand, table);
  const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  const framesDir = mkdtempSync(join(tmpdir(), "hoshlab-reel-frames-"));
  try {
    const templateFile = join(templateDirFor(brand), REEL_TEMPLATES[style]);
    const payload = { draft, brand: brandInfo(brand), tokens: { vars: tokens.vars }, frames };
    const { page, layout } = await openReel(context, { templateFile, payload, guard: (l) => applyGuards(l, { devanagariFamilies: tokens.devanagariFamilies, table, canvas: { width: 1080, height: 1920 } }) });
    // a short slice of the timeline keeps the local test quick: 2 s = 60 frames, the real run uses the full duration
    const { count, poster } = await renderFrames(page, { durationSec: 2, fps: REEL_FPS, framesDir });
    const files = readdirSync(framesDir).sort();
    const first = readFileSync(join(framesDir, files[0]));
    const last = readFileSync(join(framesDir, files[files.length - 1]));
    // the real timeline: progress 0, mid-scene, a scene boundary and the end must all paint
    const probes = [];
    for (const t of [0, 0.3, 0.5, 0.74, 1]) {
      await page.evaluate((v) => window.setProgress(v), t);
      probes.push({ t, text: await page.evaluate(() => (document.querySelector("#scene-text, #caption") || {}).textContent || ""), counter: await page.evaluate(() => (document.getElementById("counter") || {}).textContent || "") });
    }
    const reelInfo = await page.evaluate(() => window.__REEL__);
    return { layout, count, poster, files, first, last, probes, reelInfo };
  } finally {
    await context.close().catch(() => {});
    rmSync(framesDir, { recursive: true, force: true });
  }
}

test("frames (kinetic): every brand's reel-kinetic.html passes the guards for every scene (1080×1920 canvas, text ≥ 30 u, contrast ≥ 4.5), paints 30 PNG frames per second, frame 0 ≠ last frame, scene 1 is full from frame 0, later scenes type on, poster is a 1080×1920 JPEG ≤ 1.5 MB", { skip: FRAMES_SKIP }, async () => {
  for (const draft of REEL_FIXTURES) {
    const brand = brands[draft.page];
    const r = await framesOf(draft, brand, "kinetic");
    assert.equal(r.layout.style, "kinetic", draft.id);
    assert.equal(r.layout.scenes, 4);
    assert.equal(r.layout.durationSec, 16);
    assert.deepEqual(r.layout.canvas, { width: 1080, height: 1920 });
    assert.equal(r.layout.overflow, false, `${draft.id}: ${JSON.stringify(r.layout.overflows)}`);
    assert.ok(r.layout.minTextU >= 30, `${draft.id}: minTextU ${r.layout.minTextU}`);
    assert.ok(r.layout.minContrast >= 4.5, `${draft.id}: minContrast ${r.layout.minContrast}`);
    assert.ok(r.layout.runs.some((run) => run.text.includes(draft.reel.scenes[3].text.slice(0, 12))), "the last scene's text was measured");
    assert.equal(r.count, 60);
    assert.deepEqual(r.files.slice(0, 2), ["frame-00000.png", "frame-00001.png"]);
    assert.equal(r.files.length, 60);
    assert.deepEqual(pngSize(r.first), { width: 1080, height: 1920 });
    assert.deepEqual(pngSize(r.last), { width: 1080, height: 1920 });
    assert.notEqual(r.first.toString("base64"), r.last.toString("base64"), `${draft.id}: the type-on changes the frame`);
    assert.deepEqual(checkPoster(r.poster), { width: 1080, height: 1920 });
    assert.ok(r.poster.length <= MAX_MEDIA_BYTES);
    assert.equal(r.probes[0].text, draft.reel.scenes[0].text, `${draft.id}: scene 1 (the hook) is complete at t = 0, so the poster carries it`);
    assert.equal(r.probes[0].counter, "1 / 4");
    assert.ok(r.probes[1].text.length > 0 && r.probes[1].text.length < draft.reel.scenes[1].text.length, `${draft.id}: scene 2 is mid type-on at t = 0.3 (${r.probes[1].text.length} of ${draft.reel.scenes[1].text.length})`);
    assert.equal(r.probes[1].counter, "2 / 4");
    assert.equal(r.probes[3].text, draft.reel.scenes[2].text, `${draft.id}: scene 3 is fully typed at 74 % (local 0.96 > TYPE_FRACTION)`);
    assert.equal(r.probes[4].text, draft.reel.scenes[3].text, `${draft.id}: t = 1 shows the last scene in full`);
    assert.equal(r.probes[4].counter, "4 / 4");
    assert.deepEqual(r.reelInfo, { style: "kinetic", scenes: 4, durationSec: 16 });
  }
});

test("frames (capture): the fixture product site's frames inside every brand's reel-capture.html pass the guards, the caption follows the scene, frame 0 ≠ last frame", { skip: FRAMES_SKIP }, async () => {
  const shot = await captureProduct({ brand: fixtureBrand(brands.kaatdo), origin, browser, timeoutMs: 20000 });
  assert.equal(shot.frames.length, 6);
  for (const draft of REEL_FIXTURES) {
    const brand = brands[draft.page];
    const capture = { ...draft, reel: { ...draft.reel, style: "capture" } };
    const frames = framesForScenes(shot.frames, capture.reel.scenes);
    const r = await framesOf(capture, brand, "capture", frames);
    assert.equal(r.layout.style, "capture", draft.id);
    assert.equal(r.layout.frames, 4);
    assert.equal(r.layout.overflow, false, `${draft.id}: ${JSON.stringify(r.layout.overflows)}`);
    assert.ok(r.layout.minTextU >= 30, `${draft.id}: minTextU ${r.layout.minTextU}`);
    assert.ok(r.layout.minContrast >= 4.5, `${draft.id}: minContrast ${r.layout.minContrast}`);
    assert.equal(r.count, 60);
    assert.deepEqual(pngSize(r.first), { width: 1080, height: 1920 });
    assert.notEqual(r.first.toString("base64"), r.last.toString("base64"), `${draft.id}: the push-in changes the frame`);
    assert.deepEqual(checkPoster(r.poster), { width: 1080, height: 1920 });
    assert.equal(r.probes[0].text, capture.reel.scenes[0].text);
    assert.equal(r.probes[2].text, capture.reel.scenes[2].text, "t = 0.5 is scene 3");
    assert.equal(r.probes[4].text, capture.reel.scenes[3].text);
    assert.deepEqual(r.reelInfo, { style: "capture", scenes: 4, durationSec: 16, frames: 4 });
  }
});

test("frames: a Devanagari scene on JobRez (no Devanagari family) is refused per-script, an over-long scene overflows — nothing is rendered", { skip: FRAMES_SKIP }, async () => {
  const jr = REEL_FIXTURES.find((d) => d.page === "job_rez");
  const hindi = { ...jr, reel: { ...jr.reel, scenes: jr.reel.scenes.map((s, i) => (i === 1 ? { ...s, text: "मुफ़्त कुंडली for every role" } : s)) } };
  await assert.rejects(framesOf(hindi, brands.job_rez, "kinetic"), (e) => e instanceof RenderError && e.code === "missing_glyphs" && e.rule === "per-script");
  const kd = REEL_FIXTURES.find((d) => d.page === "kaatdo");
  const long = { ...kd, reel: { ...kd.reel, scenes: kd.reel.scenes.map((s) => ({ ...s, text: "max_daily_loss_profit_target_max_trades_kill_time_kill_days_kill_dates_xx" })) } };
  await assert.rejects(framesOf(long, brands.kaatdo, "kinetic"), (e) => e instanceof RenderError && e.code === "overflow" && / px wide/.test(e.detail));
});

// ---------------------------------------------------------------------------------------
// 3. the full pipeline (ffmpeg + ffprobe)

test("P2-01: one kinetic and one capture reel per brand through renderDraft → reel-<sha8>.mp4 + poster-<sha8>.jpg; ffprobe says h264 1080×1920 yuv420p 30/1, 15–30 s, +faststart, ≤ 60 MB; the probe summary is on the media row and QA's media_spec passes", { skip: FULL_SKIP }, async () => {
  const out = tmpDir("hoshlab-reel-full-");
  try {
    for (const draft of REEL_FIXTURES) {
      const brand = brands[draft.page];
      for (const style of ["kinetic", "capture"]) {
        const d = { ...draft, reel: { ...draft.reel, style } };
        const b = style === "capture" ? fixtureBrand(brand) : brand;
        const dir = join(out, `${draft.id}-${style}`);
        const r = await renderDraft({ draft: d, brand: b, outDir: dir, browser, capture: { origin, paths: FIXTURE_PATHS, timeoutMs: 20000 } });
        assert.equal(r.style, style, draft.id);
        assert.equal(r.scenes, 4);
        assert.equal(r.durationSec, 16);
        assert.equal(r.frames, 480);
        assert.equal(r.media.length, 2);
        const [video, poster] = r.media;
        assert.equal(video.kind, "video");
        assert.match(video.file, /^reel-[0-9a-f]{8}\.mp4$/);
        assert.equal(video.path, `media/${draft.id}/${video.file}`);
        assert.equal(poster.kind, "poster");
        assert.match(poster.file, /^poster-[0-9a-f]{8}\.jpg$/);
        assert.deepEqual(readdirSync(dir).sort(), [poster.file, video.file].sort());
        const mp4 = join(dir, video.file);
        assert.equal(statSync(mp4).size, video.bytes);
        assert.ok(video.bytes <= REEL_HOUSE_CAP_BYTES, `${video.bytes} bytes ≤ 60 MB`);
        // re-probe the file independently of the pipeline
        const json = probe(mp4);
        assert.deepEqual(assertReel(json), [], `${draft.id} ${style}: ${JSON.stringify(json.streams && json.streams[0])}`);
        const v = json.streams.find((s) => s.codec_type === "video");
        assert.equal(v.codec_name, "h264");
        assert.equal(Number(v.width), 1080);
        assert.equal(Number(v.height), 1920);
        assert.equal(v.pix_fmt, "yuv420p");
        assert.equal(v.r_frame_rate, "30/1");
        const duration = Number(json.format.duration);
        assert.ok(duration >= 15 && duration <= 30, `${draft.id} ${style}: ${duration} s`);
        assert.ok(Math.abs(duration - 16) < 0.2, `${draft.id} ${style}: 480 frames at 30 fps ≈ 16 s (${duration})`);
        assert.equal(json.faststart.ok, true, JSON.stringify(json.faststart));
        assert.equal(json.streams.length, 1, "silent: no audio stream");
        assert.deepEqual(validate(video.probe, PROBE_SUMMARY_SPEC), { ok: true, errors: [] });
        assert.equal(video.probe.ok, true);
        assert.equal(video.durationSec, video.probe.durationSec);
        // poster: frame 0 as JPEG, read back
        const posterBytes = readFileSync(join(dir, poster.file));
        assert.deepEqual(jpegSize(posterBytes), { width: 1080, height: 1920 });
        assert.ok(posterBytes.length <= MAX_MEDIA_BYTES);
        assert.equal(poster.bytes, posterBytes.length);
        // the Designer's media rows validate and QA's media_spec accepts them with the real bytes
        const rows = mediaRows(r, config);
        for (const row of rows) assert.deepEqual(validate(row, MEDIA_ITEM_SPEC), { ok: true, errors: [] });
        assert.equal(rows[0].kind, "video");
        assert.deepEqual(rows[0].probe, video.probe);
        const media = [
          { kind: "video", bytes: readFileSync(mp4), width: 1080, height: 1920, path: rows[0].path, durationSec: video.durationSec, probe: video.probe },
          { kind: "poster", bytes: posterBytes, width: 1080, height: 1920, path: rows[1].path },
        ];
        const qa = runChecks(d, brand, { config, media }).checks.find((c) => c.id === "media_spec");
        assert.equal(qa.ok, true, `${draft.id} ${style}: ${qa.detail}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("skip bookkeeping: without ffprobe the full test skips with the exact message; REQUIRE_FFMPEG=1 turns a missing ffprobe into a failure (asserted in before())", () => {
  assert.equal(SKIP_NO_FFMPEG, "skipped: ffmpeg/ffprobe not installed (runs in CI)");
  if (!HAS_FFPROBE) assert.equal(FULL_SKIP, SKIP_NO_FFMPEG);
  if (REQUIRE_FFMPEG) assert.ok(HAS_FFPROBE);
});
