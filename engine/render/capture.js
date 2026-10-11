// Product screen capture for `capture` reels (plan D17, FEAT-201): Playwright records the product's OWN public
// pages — the paths listed under `## Formats → capture:` in the brand file, on the brand's allowed domain — at a
// 1080×1920 phone frame (viewport 360×640 at deviceScaleFactor 3: exactly 1080×1920 device pixels; the FEAT's
// 390×693 @ 2.769 rounds to 1080×1919, so the clean 9:16 pair is used). Nothing is fabricated: a page that does not
// answer 200, times out or sits on another host is a CaptureError('capture_unreachable') and the Designer leaves the
// draft `written` for the next run.
//
//   captureProduct({ brand, paths?, origin?, chromium?, browser?, timeoutMs = 30000, scrolls = [0, 0.33, 0.66] })
//     → { frames: [{ path, url, scroll, png (Buffer), width, height, sha256 }], origin, host }
//   paths    default: the brand's capture list (capturePaths(brand)); each must be site-relative ('/kundali', '/#pricing')
//   origin   default: https://<first allowed domain>; tests point it at a local fixture server whose host the test
//            brand allows (the allow-list check is on the URL's hostname, never on the origin option)
//   For each path: new context (light colour scheme, mobile UA), goto waitUntil 'networkidle', one generic cookie-banner
//   dismissal (a visible [aria-label="close"] / [aria-label="Close"] control is clicked once — no site-specific hooks),
//   a viewport-only PNG at the top plus at 33 % and 66 % of the scrollable height (3 frames per path; an unscrollable
//   page repeats its single screen). Every PNG's IHDR is read back (pngSize) and must say 1080×1920.
import { createHash } from "node:crypto";
import { REEL_HEIGHT, REEL_WIDTH, hostOf, pngSize } from "../lib/checks.js";
import { capturePaths } from "../lib/brand.js";

export const CAPTURE_VIEWPORT = { width: 360, height: 640 };
export const CAPTURE_SCALE = 3;
export const CAPTURE_TIMEOUT_MS = 30000;
export const CAPTURE_SCROLLS = [0, 0.33, 0.66];
export const CAPTURE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 Hoshlab-Designer";
const CLOSE_SELECTOR = '[aria-label="close"], [aria-label="Close"]';

// capture_unreachable: the one error code of this module (design §11 "Render" row; plan D17).
export class CaptureError extends Error {
  constructor(detail, { path = null, url = null, status = null, reason = "unreachable" } = {}) {
    super(`capture_unreachable: ${detail}`);
    this.name = "CaptureError";
    this.code = "capture_unreachable";
    this.detail = detail;
    this.path = path;
    this.url = url;
    this.status = status;
    this.reason = reason;
  }
}

// The hosts a brand may be captured on: its allowed domains and their www. forms.
export function hostAllowed(hostname, brand) {
  const host = String(hostname || "").toLowerCase();
  const allowed = ((brand && brand.allowedDomains) || []).map((d) => String(d).toLowerCase());
  return allowed.some((d) => host === d || host === `www.${d}`);
}

// resolveCapture(brand, path, origin) → { url, host } or throws CaptureError when the path leaves the allowed domain
// (absolute URLs, protocol-relative paths and other hosts are refused before any network call).
export function resolveCapture(brand, path, origin) {
  const p = String(path || "");
  if (!p.startsWith("/") || p.startsWith("//")) throw new CaptureError(`${JSON.stringify(p)} is not a site-relative path`, { path: p, reason: "host_not_allowed" });
  let url;
  try {
    url = new URL(p, origin);
  } catch {
    throw new CaptureError(`origin ${JSON.stringify(origin)} is not a URL`, { path: p, reason: "host_not_allowed" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CaptureError(`${url.href}: not http(s)`, { path: p, url: url.href, reason: "host_not_allowed" });
  const host = hostOf(url.href);
  if (!hostAllowed(url.hostname, brand)) throw new CaptureError(`${url.href}: host ${host} is not an allowed domain of @${(brand.frontMatter || {}).handle || "?"} (${(brand.allowedDomains || []).join(", ") || "none"})`, { path: p, url: url.href, reason: "host_not_allowed" });
  return { url: url.href, host };
}

export function defaultOrigin(brand) {
  const first = ((brand && brand.allowedDomains) || [])[0];
  if (!first) throw new CaptureError("brand lists no allowed domain to capture", { reason: "host_not_allowed" });
  return `https://${first}`;
}

async function launch(chromium) {
  const pw = chromium || (await import("playwright")).chromium;
  return pw.launch({ headless: true });
}

async function dismissBanner(page) {
  try {
    const close = page.locator(CLOSE_SELECTOR).first();
    if ((await close.count()) > 0 && (await close.isVisible())) await close.click({ timeout: 1500, trial: false });
  } catch {
    /* nothing to dismiss, or it would not click: the frame is taken as the page shows itself */
  }
}

// One path → up to scrolls.length frames.
async function captureOne(browser, { url, path, timeoutMs, scrolls }) {
  const context = await browser.newContext({ viewport: CAPTURE_VIEWPORT, deviceScaleFactor: CAPTURE_SCALE, isMobile: true, hasTouch: true, colorScheme: "light", userAgent: CAPTURE_UA, locale: "en-IN", reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch (e) {
      throw new CaptureError(`${url}: ${String(e && e.message ? e.message : e).split("\n")[0]}`, { path, url, reason: "navigation_failed" });
    }
    const status = response ? response.status() : null;
    if (status === null || status >= 400) throw new CaptureError(`${url}: HTTP ${status === null ? "no response" : status}`, { path, url, status, reason: "http_error" });
    await dismissBanner(page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const frames = [];
    for (const scroll of scrolls) {
      await page.evaluate((s) => {
        const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.round(max * s));
      }, scroll);
      await page.waitForTimeout(150);
      const png = Buffer.from(await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide" }));
      let dims;
      try {
        dims = pngSize(png);
      } catch (e) {
        throw new CaptureError(`${url}: screenshot is not a PNG (${e.message})`, { path, url, status, reason: "bad_frame" });
      }
      if (dims.width !== REEL_WIDTH || dims.height !== REEL_HEIGHT) throw new CaptureError(`${url}: frame ${dims.width}x${dims.height}, expected ${REEL_WIDTH}x${REEL_HEIGHT}`, { path, url, status, reason: "bad_frame" });
      frames.push({ path, url, status, scroll, png, width: dims.width, height: dims.height, sha256: createHash("sha256").update(png).digest("hex") });
    }
    return frames;
  } finally {
    await context.close().catch(() => {});
  }
}

// captureProduct(opts) → { frames, origin, host } — see the file header. An injected `browser` is reused and left open.
export async function captureProduct({ brand, paths, origin, chromium, browser, timeoutMs = CAPTURE_TIMEOUT_MS, scrolls = CAPTURE_SCROLLS } = {}) {
  if (!brand || !Array.isArray(brand.allowedDomains)) throw new TypeError("capture: a parsed brand (allowedDomains) is required");
  const list = Array.isArray(paths) ? paths : capturePaths(brand);
  if (!list.length) throw new CaptureError(`@${(brand.frontMatter || {}).handle || "?"} lists no capture paths under ## Formats`, { reason: "no_paths" });
  const base = origin || defaultOrigin(brand);
  const targets = list.map((p) => ({ path: p, ...resolveCapture(brand, p, base) }));
  const own = !browser;
  let b = browser;
  if (!b) {
    try {
      b = await launch(chromium);
    } catch (e) {
      throw new CaptureError(`Chromium could not be launched: ${String(e && e.message ? e.message : e).split("\n")[0]}`, { reason: "browser" });
    }
  }
  const frames = [];
  try {
    for (const t of targets) frames.push(...(await captureOne(b, { url: t.url, path: t.path, timeoutMs, scrolls })));
  } finally {
    if (own) await b.close().catch(() => {});
  }
  return { frames, origin: base, host: targets[0].host };
}

// framesForScenes(frames, scenes) → one frame per scene, spread evenly over the captured material (scene i takes
// frame floor(i × frames / scenes)), each with the scene's text as its caption — what reel-capture.html receives.
export function framesForScenes(frames, scenes) {
  if (!frames.length) return [];
  return scenes.map((s, i) => {
    const f = frames[Math.min(frames.length - 1, Math.floor((i * frames.length) / scenes.length))];
    return { dataUrl: `data:image/png;base64,${f.png.toString("base64")}`, caption: s.text, path: f.path, scroll: f.scroll, sha256: f.sha256 };
  });
}
