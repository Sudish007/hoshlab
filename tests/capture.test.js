// engine/render/capture.js — product screen capture for `capture` reels (plan D17, FEAT-201). The allow-list is pure
// and always tested; the browser-backed part serves tests/fixtures/product-site through scripts/serve.mjs on a free
// port (the brand under test allows 127.0.0.1) and asserts real 1080×1920 PNG frames, the scroll positions, the banner
// dismissal, an HTTP 404 and an unreachable port → capture_unreachable. Chromium is required; without it the browser
// tests skip with an explicit message unless RENDER_TESTS=1 / REQUIRE_FFMPEG=1 (CI), where that is a failure.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FETCH_ATTEMPTS, ROOT } from "./helpers.js";
import siteConfig from "../site.config.js";
import { loadCompany } from "../src/lib/company.js";
import { capturePaths } from "../engine/lib/brand.js";
import { pngSize } from "../engine/lib/checks.js";
import { CAPTURE_SCALE, CAPTURE_SCROLLS, CAPTURE_VIEWPORT, CaptureError, captureProduct, defaultOrigin, framesForScenes, hostAllowed, resolveCapture } from "../engine/render/capture.js";

const MUST_RUN = process.env.RENDER_TESTS === "1" || process.env.REQUIRE_FFMPEG === "1";
const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { brands } = company;
const FIXTURE_SITE = join(ROOT, "tests", "fixtures", "product-site");
const BASE = siteConfig.basePath; // serve.mjs mounts DIST_DIR under the site's basePath, exactly like Pages

// A brand whose only allowed host is the local fixture server (never a real product domain).
const FIXTURE_BRAND = {
  file: "fixture.md",
  frontMatter: { handle: "fixture", name: "Fixture product", site: "http://127.0.0.1" },
  allowedDomains: ["127.0.0.1"],
  capture: { verifiedAt: "2026-10-11", notes: "fixture", paths: [{ path: `${BASE}index.html`, source: "hoshlab/tests/fixtures/product-site/index.html:1" }, { path: `${BASE}pricing.html`, source: "hoshlab/tests/fixtures/product-site/pricing.html:1" }] },
};

// ---------------------------------------------------------------------------------------
// Pure parts (always run)

test("resolveCapture: paths stay on the brand's allowed domain (www. allowed); absolute URLs, protocol-relative paths, other hosts and non-http schemes are capture_unreachable before any network call", () => {
  assert.equal(CAPTURE_VIEWPORT.width * CAPTURE_SCALE, 1080);
  assert.equal(CAPTURE_VIEWPORT.height * CAPTURE_SCALE, 1920);
  assert.deepEqual(CAPTURE_SCROLLS, [0, 0.33, 0.66]);
  const kd = brands.kaatdo;
  assert.equal(defaultOrigin(kd), "https://kaatdo.com");
  assert.deepEqual(capturePaths(kd), ["/", "/#flatline", "/#rules", "/#pricing", "/status"]);
  assert.deepEqual(resolveCapture(kd, "/#pricing", defaultOrigin(kd)), { url: "https://kaatdo.com/#pricing", host: "kaatdo.com" });
  assert.deepEqual(resolveCapture(kd, "/status", "https://www.kaatdo.com"), { url: "https://www.kaatdo.com/status", host: "kaatdo.com" });
  assert.ok(hostAllowed("kaatdo.com", kd) && hostAllowed("www.kaatdo.com", kd) && !hostAllowed("app.kaatdo.com", kd) && !hostAllowed("kaatdo.com.evil.example", kd));
  const refused = (path, origin = defaultOrigin(kd)) => {
    try {
      resolveCapture(kd, path, origin);
      return null;
    } catch (e) {
      assert.ok(e instanceof CaptureError, String(e));
      assert.equal(e.code, "capture_unreachable");
      assert.equal(e.reason, "host_not_allowed");
      return e;
    }
  };
  assert.match(refused("https://rishtapatra.com/").detail, /is not a site-relative path/);
  assert.match(refused("//evil.example/x").detail, /is not a site-relative path/);
  assert.match(refused("/status", "https://evil.example").detail, /host evil.example is not an allowed domain of @kaatdo \(kaatdo.com\)/);
  assert.match(refused("/status", "https://app.kaatdo.com").detail, /host app.kaatdo.com is not an allowed domain/);
  assert.match(refused("/status", "ftp://kaatdo.com").detail, /not http\(s\)/);
  assert.match(refused("/status", "not a url").detail, /is not a URL/);
  // every real brand lists capture paths that resolve on its own domain
  for (const b of Object.values(brands)) for (const p of capturePaths(b)) assert.equal(resolveCapture(b, p, defaultOrigin(b)).host, b.allowedDomains[0], `${b.frontMatter.handle} ${p}`);
});

test("captureProduct with a fake chromium: a non-allow-listed path is refused BEFORE the browser is used; a brand without capture paths is refused; the injected browser is left open", async () => {
  let launched = 0;
  const fake = { launch: async () => (launched++, { newContext: async () => { throw new Error("never reached"); }, close: async () => {} }) };
  await assert.rejects(captureProduct({ brand: brands.kaatdo, paths: ["/status", "/ok"], origin: "https://evil.example", chromium: fake }), (e) => e instanceof CaptureError && e.code === "capture_unreachable" && e.reason === "host_not_allowed");
  assert.equal(launched, 0, "refused without launching Chromium");
  await assert.rejects(captureProduct({ brand: { ...brands.kaatdo, capture: null }, chromium: fake }), (e) => e instanceof CaptureError && e.reason === "no_paths");
  await assert.rejects(captureProduct({ chromium: fake }), TypeError);
  let closed = 0;
  const browser = { newContext: async () => { throw new Error("stop here"); }, close: async () => closed++ };
  await assert.rejects(captureProduct({ brand: FIXTURE_BRAND, origin: "http://127.0.0.1:9", browser }), /stop here/);
  assert.equal(closed, 0, "an injected browser is never closed by captureProduct");
});

test("framesForScenes spreads the captured frames over the scenes (scene i → frame floor(i·frames/scenes)) and carries the scene text as the caption", () => {
  const frames = Array.from({ length: 6 }, (_, i) => ({ path: `/p${i}`, scroll: 0, png: Buffer.from([i]), sha256: String(i) }));
  const scenes = [{ text: "a", seconds: 4 }, { text: "b", seconds: 4 }, { text: "c", seconds: 4 }, { text: "d", seconds: 4 }];
  const out = framesForScenes(frames, scenes);
  assert.deepEqual(out.map((f) => [f.path, f.caption]), [["/p0", "a"], ["/p1", "b"], ["/p3", "c"], ["/p4", "d"]]);
  assert.ok(out.every((f) => f.dataUrl.startsWith("data:image/png;base64,")));
  assert.deepEqual(framesForScenes(frames.slice(0, 1), scenes).map((f) => f.path), ["/p0", "/p0", "/p0", "/p0"], "one frame repeats");
  assert.deepEqual(framesForScenes([], scenes), []);
});

// ---------------------------------------------------------------------------------------
// Browser-backed (the fixture product site on 127.0.0.1)

let browser = null;
let server = null;
let origin = null;
let skipReason = false;

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
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    if (MUST_RUN) throw e;
    skipReason = `capture tests skipped: Chromium not launchable (${String(e.message).split("\n")[0]}) — npx playwright install chromium`;
    return;
  }
  const port = await freePort(8181);
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

test("fixture product site → 3 frames per path, each a real 1080×1920 PNG (IHDR read back), scroll positions differ, the banner's Close control is clicked, status 200", { skip: skipReason }, async () => {
  const r = await captureProduct({ brand: FIXTURE_BRAND, origin, browser, timeoutMs: 20000 });
  assert.equal(r.origin, origin);
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.frames.length, 6, "2 paths × 3 scroll positions");
  assert.deepEqual(r.frames.map((f) => [f.path, f.scroll, f.status]), [
    [`${BASE}index.html`, 0, 200],
    [`${BASE}index.html`, 0.33, 200],
    [`${BASE}index.html`, 0.66, 200],
    [`${BASE}pricing.html`, 0, 200],
    [`${BASE}pricing.html`, 0.33, 200],
    [`${BASE}pricing.html`, 0.66, 200],
  ]);
  for (const f of r.frames) {
    assert.ok(Buffer.isBuffer(f.png) && f.png.length > 1000, `${f.path} @ ${f.scroll}: PNG bytes`);
    assert.deepEqual(pngSize(f.png), { width: 1080, height: 1920 }, `${f.path} @ ${f.scroll}`);
    assert.deepEqual([f.width, f.height], [1080, 1920]);
    assert.equal(f.sha256, createHash("sha256").update(f.png).digest("hex"));
    assert.equal(f.url, `${origin}${f.path}`);
  }
  const home = r.frames.slice(0, 3).map((f) => f.sha256);
  assert.equal(new Set(home).size, 3, "the three scroll positions of a tall page are three different screens");
  // the frames become the capture template's input: one per scene, captions from the scenes
  const scenes = [{ text: "One", seconds: 4 }, { text: "Two", seconds: 4 }, { text: "Three", seconds: 4 }, { text: "Four", seconds: 4 }];
  const forTemplate = framesForScenes(r.frames, scenes);
  assert.equal(forTemplate.length, 4);
  assert.deepEqual(forTemplate.map((f) => f.caption), ["One", "Two", "Three", "Four"]);
  assert.ok(forTemplate.every((f) => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(f.dataUrl)));
  assert.equal(FETCH_ATTEMPTS.length, 0, "no Node fetch was used (Chromium fetched the fixture pages)");
});

test("an HTTP 404 path and an unreachable port are capture_unreachable (status / navigation failure named); no frame is fabricated", { skip: skipReason }, async () => {
  await assert.rejects(captureProduct({ brand: FIXTURE_BRAND, paths: [`${BASE}index.html`, `${BASE}no-such-page.html`], origin, browser, timeoutMs: 20000 }), (e) => {
    assert.ok(e instanceof CaptureError, String(e));
    assert.equal(e.code, "capture_unreachable");
    assert.equal(e.reason, "http_error");
    assert.equal(e.status, 404);
    assert.equal(e.path, `${BASE}no-such-page.html`);
    assert.match(e.detail, /HTTP 404$/);
    return true;
  });
  const dead = await freePort(8281);
  await assert.rejects(captureProduct({ brand: FIXTURE_BRAND, paths: [`${BASE}index.html`], origin: `http://127.0.0.1:${dead}`, browser, timeoutMs: 5000 }), (e) => {
    assert.ok(e instanceof CaptureError, String(e));
    assert.equal(e.code, "capture_unreachable");
    assert.equal(e.reason, "navigation_failed");
    assert.equal(e.status, null);
    assert.match(e.message, /^capture_unreachable: http:\/\/127\.0\.0\.1:\d+\/hoshlab\/index\.html: /);
    return true;
  });
});
