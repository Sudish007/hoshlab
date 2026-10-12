// Real-browser audit of the public site in dist/ (design §15 + §0 OF-1/4/5/6/8, review M11/M12/N10/N11,
// acceptance P1-13/15/17/18): a port of mock/shoot.py's checks and ai-batkahi's scripts/audit.mjs structure
// to Playwright for Node (the `playwright` dependency, plan D16). Every page is opened at 390/820/1440/1920/
// 2560 (2560 at deviceScaleFactor 0.75) and each rule becomes one row; any failing row exits 1.
//
// Usage:   npm run build; npm run audit                 serves DIST_DIR on a free port >= 8081 and audits it
//          AUDIT_URL=https://host npm run audit         audits a running or live site at <origin> + basePath
// Output:  AUDIT_OUT/audit-results.json (default .agents/audit/, gitignored; CI uses audit-out/) and
//          viewport-only PNGs <= 1920 px in AUDIT_OUT/shots-public/<page>-<w>x<h>.png.
// Empty-state run (review M11) — build the empty fixture into a temp DIST_DIR and audit that directory:
//   $env:COMPANY_DIR='tests/fixtures/company-empty'; $env:DIST_DIR="$env:TEMP\hoshlab-dist-empty"; node src/build.js
//   $env:AUDIT_OUT="$env:TEMP\hoshlab-audit-empty"; node scripts/audit.mjs
// (scripts/serve.mjs honours the same DIST_DIR; the audit only reads what is served.)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { get } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import config from "../site.config.js";
import { collectPaintRects, emptyRegion } from "./lib/empty-region.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = resolve(ROOT, process.env.DIST_DIR || "dist");
const OUT = resolve(ROOT, process.env.AUDIT_OUT || join(".agents", "audit"));
const SHOTS = join(OUT, "shots-public");
mkdirSync(SHOTS, { recursive: true });

// The admin lock screen (last entry) is audited only when the server answers 200 for it (FEAT-111);
// until then one informational row says "admin: not built yet". The newest Analyst report page
// (reports/<week>/, FEAT-203) is inserted after "reports" when one exists (newestReportPath()).
const PAGES = [
  { key: "home", path: "" },
  { key: "team", path: "team/" },
  { key: "pages", path: "pages/" },
  { key: "page", path: "pages/kaatdo/" },
  { key: "activity", path: "activity/" },
  { key: "calendar", path: "calendar/" },
  { key: "published", path: "published/" },
  { key: "reports", path: "reports/" },
  { key: "about", path: "about/" },
  { key: "404", path: "404.html" },
  { key: "admin-lock", path: "admin/", admin: true },
];
const VIEWPORTS = [
  { width: 390, height: 844, dsf: 1 },
  { width: 820, height: 1180, dsf: 1 },
  { width: 1440, height: 900, dsf: 1 },
  { width: 1920, height: 1080, dsf: 1 },
  { width: 2560, height: 1440, dsf: 0.75 }, // 2560-wide shots come out as 1920×1080 PNGs
];
const MAX_SHOT_PX = 1920;
const LIGHT_BG = "rgb(251, 251, 248)"; // --bg #FBFBF8 (design §14)
const MIN_FONT_PX = 12; // --fs-xs floor
const MIN_CONTROL_PX = 44; // --control (review N11: only the running-text `p` exemption)
const MIN_CONTAINER_RATIO = 0.88; // at >= 1920 (design §14)
const MIN_CONTAINER_MAX_WIDTH = 2400; // computed max-width must be none or >= this (P1-18)
const EMPTY_REGION_WIDTHS = [1920, 2560]; // OF-4 runs on monitors only
const NAV_UNDERLINE = "rgb(23, 23, 26) 0px -2px 0px 0px inset"; // the one allowed box-shadow (design §14)
const AI_LABELS = 8; // OF-6
// OF-5 tokens on document.body.innerText — the same rule as src/build.js PUBLIC_SURFACE_RULES: 'cron' is a
// violation only when a schedule expression follows it (P1-16/P1-17); the word alone is prose (the delay note
// config.schedule.actionsDelayNote says "scheduled runs"); 'autopilot' is the lower-case TOKEN, 'Autopilot' the label.
const TOKEN_RULES = [
  { name: "approve_first", re: /\bapprove_first\b/ },
  { name: "autopilot (config token)", re: /\bautopilot\b/ },
  { name: "cron expression", re: /\bcron\s+`?[\d*]/i },
  { name: "cron expression", re: /\*\s\*\s\*/ },
];

const results = [];
function record(check, page, width, ok, detail) {
  results.push({ check, page, width, ok: !!ok, detail });
  if (!ok) console.log(`  FAIL ${check} ${page} ${width}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

/* ---------- server ---------- */
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
    const onRes = (res) => {
      res.resume();
      resolveStatus(res.statusCode);
    };
    const req = url.startsWith("https:") ? httpsRequest(url, { method: "GET" }, onRes) : get(url, onRes);
    req.on("error", () => resolveStatus(0));
    if (url.startsWith("https:")) req.end();
  });
}
function text(url) {
  return new Promise((resolveText) => {
    const onRes = (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolveText(res.statusCode === 200 ? body : ""));
    };
    const req = url.startsWith("https:") ? httpsRequest(url, { method: "GET" }, onRes) : get(url, onRes);
    req.on("error", () => resolveText(""));
    if (url.startsWith("https:")) req.end();
  });
}
// FEAT-203 (P2-05): the newest Analyst report page, when one exists — from dist/reports/<week>/ for a local dist,
// from the served /reports/ index for AUDIT_URL. null = no report built yet (the real company until its first Sunday
// with a 48 h-old post; the fixture build carries 2026-W41).
async function newestReportPath() {
  if (!process.env.AUDIT_URL) {
    const dir = join(DIST, "reports");
    if (!existsSync(dir)) return null;
    const weeks = readdirSync(dir)
      .filter((n) => /^\d{4}-W\d{2}$/.test(n) && existsSync(join(dir, n, "index.html")))
      .sort()
      .reverse();
    return weeks.length ? `reports/${weeks[0]}/` : null;
  }
  const html = await text(BASE + "reports/");
  const m = html.match(/href="[^"]*\/reports\/(\d{4}-W\d{2})\/"/);
  return m ? `reports/${m[1]}/` : null;
}
async function startServer() {
  if (process.env.AUDIT_URL) return { origin: process.env.AUDIT_URL.replace(/\/$/, ""), child: null };
  const port = await freePort(8081);
  const child = spawn(process.execPath, [join(ROOT, "scripts", "serve.mjs")], {
    env: { ...process.env, PORT: String(port), DIST_DIR: DIST },
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    if ((await status(origin + config.basePath)) === 200) return { origin, child };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("serve.mjs did not come up on " + origin);
}

/* ---------- helpers ---------- */
let browser;
let BASE;

function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG: " + file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
async function open(page, pagePath) {
  await page.goto(BASE + pagePath, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}
function watch(page, sink) {
  page.on("pageerror", (err) => sink.errors.push(String((err && err.message) || err)));
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().startsWith(BASE)) sink.bad.push({ url: res.url().slice(BASE.length - 1), status: res.status() });
  });
}

/* ---------- in-page evaluator (serialised by Playwright; self-contained) ---------- */
function pageEval({ navUnderline, minFont, minControl }) {
  const de = document.documentElement;
  const out = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  const round = (v, d = 10) => Math.round(v * d) / d;
  const visible = (el) => {
    if (!el || el.closest("[hidden]")) return false;
    if (!el.getClientRects().length) return false;
    return getComputedStyle(el).visibility !== "hidden";
  };
  const desc = (el) => {
    const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return (el.tagName.toLowerCase() + cls + (el.id ? "#" + el.id : "")).slice(0, 80);
  };
  const inMedia = (el) => !!el.closest(".post, .post-frame, .thumb");
  const all = [...document.body.querySelectorAll("*")];

  // M12: inner scroll containers — only a .table-wrap with a visible "scroll →" caption may scroll.
  out.innerScroll = [];
  for (const el of all) {
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    if (el.scrollWidth <= el.clientWidth) continue;
    const scope = el.parentElement || el;
    const captioned = el.classList.contains("table-wrap") && [...scope.querySelectorAll("*")].some((c) => visible(c) && /scroll\s*→/.test(c.textContent));
    if (!captioned) out.innerScroll.push({ el: desc(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }

  // Elements owning visible text.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textOwners = new Set();
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
    if (visible(el)) textOwners.add(el);
  }

  // 12 px floor (artwork inside .post/.thumb scales with its frame and is excluded).
  out.minFont = { px: 999, sample: null, el: null };
  out.small = [];
  for (const el of textOwners) {
    if (inMedia(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const sample = el.textContent.trim().slice(0, 40);
    if (fs < out.minFont.px) out.minFont = { px: round(fs, 100), sample, el: desc(el) };
    if (fs < minFont) out.small.push({ el: desc(el), fs: round(fs, 100), sample });
  }

  // Controls >= 44 px; a checkbox/radio is judged by its label; the only exemption is running text (ancestor p).
  out.controls = 0;
  out.smallControls = [];
  for (const el of document.querySelectorAll("a, button, input, select, textarea, [role=button]")) {
    if (!visible(el) || inMedia(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    let box = r;
    let tag = el.tagName;
    if (el.matches("input[type=checkbox], input[type=radio]")) {
      const lab = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label");
      if (lab) {
        box = lab.getBoundingClientRect();
        tag = "CHECKBOX-LABEL";
      }
    }
    out.controls++;
    if (box.height < minControl && !el.closest("p")) out.smallControls.push({ el: desc(el), tag, text: (el.textContent || "").trim().slice(0, 30), h: round(box.height), w: Math.round(box.width) });
  }

  // Container: main.container (or the first .container inside main).
  const main = document.querySelector("main");
  const container = main ? (main.matches(".container") ? main : main.querySelector(".container")) : null;
  out.container = container
    ? { el: desc(container), width: Math.round(container.getBoundingClientRect().width), ratio: round(container.getBoundingClientRect().width / window.innerWidth, 1000), maxWidth: getComputedStyle(container).maxWidth }
    : null;

  // Chrome scan: no gradient backgrounds, no box-shadow except the active nav underline (outside artwork).
  out.gradients = [];
  out.shadows = [];
  for (const el of all) {
    if (inMedia(el)) continue;
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (pseudo && (!cs.content || cs.content === "none" || cs.content === "normal")) continue;
      const bg = cs.backgroundImage;
      if (bg && bg.includes("gradient")) out.gradients.push({ el: desc(el) + (pseudo || ""), backgroundImage: bg.slice(0, 80) });
      const s = cs.boxShadow;
      if (s && s !== "none" && !(pseudo === null && s === navUnderline && el.matches('.site-nav a[aria-current="page"]'))) out.shadows.push({ el: desc(el) + (pseudo || ""), boxShadow: s });
    }
  }

  // Contrast (WCAG AA): every visible text node against its nearest painted ancestor background.
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const rootBg0 = parse(getComputedStyle(de).backgroundColor);
  const rootBg = rootBg0 && rootBg0.a > 0 ? { ...rootBg0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const effectiveBg = (el, pseudo) => {
    const chain = [];
    for (let e = el; e && e !== de; e = e.parentElement) chain.unshift(e);
    let bg = rootBg;
    for (const e of chain) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (!c || c.a === 0) continue;
      bg = c.a >= 1 ? { ...c, a: 1 } : over(c, bg);
    }
    if (pseudo) {
      const c = parse(getComputedStyle(el, pseudo).backgroundColor);
      if (c && c.a > 0) bg = c.a >= 1 ? { ...c, a: 1 } : over(c, bg);
    }
    return bg;
  };
  const pairs = [];
  const consider = (el, pseudo, label, sample) => {
    if (inMedia(el)) return;
    const cs = getComputedStyle(el, pseudo || null);
    const fg0 = parse(cs.color);
    if (!fg0) return;
    const bg = effectiveBg(el, pseudo);
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    const fs = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = fs >= 24 || (bold && fs >= 18.66) ? 3 : 4.5;
    const r = ratio(fg, bg);
    pairs.push({ el: label, sample, fs: round(fs, 100), fg: hex(fg), bg: hex(bg), ratio: round(r, 100), need, ok: r >= need });
  };
  for (const el of textOwners) consider(el, null, desc(el), el.textContent.trim().slice(0, 30));
  for (const el of all) {
    if (!visible(el)) continue;
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(el, pseudo).content;
      if (!content || content === "none" || content === "normal" || content === '""' || content === "''") continue;
      consider(el, pseudo, desc(el) + pseudo, content.slice(0, 30));
    }
  }
  pairs.sort((a, b) => a.ratio / a.need - b.ratio / b.need);
  out.contrast = { pairs: pairs.length, worst: pairs[0] || null, failures: pairs.filter((p) => !p.ok).slice(0, 8) };
  out.bodyBg = hex(effectiveBg(document.body, null));
  out.prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;

  // OF-1, OF-5 (text returned; the token scan runs in Node), OF-6, N10, M2.
  out.adminLinks = document.querySelectorAll('a[href*="admin"]').length;
  out.adminText = all.filter((el) => el.textContent.trim() === "Admin").length;
  out.innerText = document.body.innerText;
  out.aiLabels = { total: document.querySelectorAll(".ai-label").length, labelled: [...document.querySelectorAll(".ai-label")].filter((el) => visible(el) && /AI agent\s*·/.test(el.textContent)).length };
  out.gridcells = document.querySelectorAll("[role=gridcell]").length;
  out.cellsOutsideRow = [...document.querySelectorAll("[role=gridcell]")].filter((el) => !el.closest("[role=row]")).length;
  out.timeNoDatetime = document.querySelectorAll("time:not([datetime])").length;
  out.styleAttrs = document.querySelectorAll("[style]").length;
  // Integration seam: a JavaScript value rendered as text or into an attribute (text nodes outside <script>,
  // hidden markup included; every attribute value).
  const leakRe = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/;
  out.leaks = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n && out.leaks.length < 20; n = tw.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest("script")) continue;
    if (leakRe.test(n.nodeValue)) out.leaks.push(`text in <${parent.tagName.toLowerCase()}${parent.id ? "#" + parent.id : ""}>: ${n.nodeValue.trim().slice(0, 120)}`);
  }
  for (const el of all) {
    if (out.leaks.length >= 20) break;
    for (const a of el.attributes) if (leakRe.test(a.value)) out.leaks.push(`<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} ${a.name}="${a.value.slice(0, 120)}">`);
  }
  return out;
}

/* ---------- the matrix ---------- */
async function auditPage(page, p, vp, sink) {
  const { width, height } = vp;
  const key = p.key;
  sink.errors.length = 0;
  sink.bad.length = 0;
  await open(page, p.path);
  const r = await page.evaluate(pageEval, { navUnderline: NAV_UNDERLINE, minFont: MIN_FONT_PX, minControl: MIN_CONTROL_PX });
  const isPublic = !p.admin;

  record("overflow", key, width, r.scrollWidth - r.clientWidth === 0, `scrollWidth ${r.scrollWidth} clientWidth ${r.clientWidth}`);
  record("innerScroll (M12)", key, width, r.innerScroll.length === 0, r.innerScroll.length ? r.innerScroll : "no inner scroll container");
  record("fontFloor", key, width, r.small.length === 0, r.small.length ? r.small : `min ${r.minFont.px}px (${r.minFont.el}: ${JSON.stringify(r.minFont.sample)})`);
  record("controls (N11)", key, width, r.smallControls.length === 0, r.smallControls.length ? r.smallControls : `${r.controls} controls >= ${MIN_CONTROL_PX}px`);
  if (width >= 1920) {
    const c = r.container;
    const ok = !!c && c.ratio >= MIN_CONTAINER_RATIO && (c.maxWidth === "none" || parseFloat(c.maxWidth) >= MIN_CONTAINER_MAX_WIDTH);
    record("container", key, width, ok, c || "no main.container");
  }
  record("chrome (gradient/shadow)", key, width, r.gradients.length === 0 && r.shadows.length === 0, r.gradients.length || r.shadows.length ? { gradients: r.gradients, shadows: r.shadows } : "no gradient, no box-shadow beyond the nav underline");
  record("contrast", key, width, r.contrast.failures.length === 0, { pairs: r.contrast.pairs, worst: r.contrast.worst, failures: r.contrast.failures });
  if (isPublic) {
    record("OF-1 admin", key, width, r.adminLinks === 0 && r.adminText === 0, { adminLinks: r.adminLinks, adminText: r.adminText });
    const hits = TOKEN_RULES.map((rule) => ({ rule: rule.name, match: rule.re.exec(r.innerText) })).filter((h) => h.match).map((h) => ({ rule: h.rule, text: h.match[0] }));
    record("OF-5 tokens", key, width, hits.length === 0, hits.length ? hits : "no config token in innerText");
  }
  if (key === "team") record("OF-6 aiLabels", key, width, r.aiLabels.total === AI_LABELS && r.aiLabels.labelled === AI_LABELS, r.aiLabels);
  record("aria (N10)", key, width, r.cellsOutsideRow === 0 && r.timeNoDatetime === 0, { gridcells: r.gridcells, cellsOutsideRow: r.cellsOutsideRow, timeNoDatetime: r.timeNoDatetime });
  record("inlineStyles (M2)", key, width, r.styleAttrs === 0, `${r.styleAttrs} [style] attributes`);
  record("valueLeaks (text/attributes)", key, width, r.leaks.length === 0, r.leaks.length ? r.leaks : "no undefined/NaN/[object Object]/Invalid Date in the DOM");
  record("pageErrors", key, width, sink.errors.length === 0 && sink.bad.length === 0, sink.errors.length || sink.bad.length ? { errors: [...sink.errors], badResponses: [...sink.bad] } : "no page errors, no failed same-origin responses");

  let empty = null;
  if (EMPTY_REGION_WIDTHS.includes(width)) {
    const paint = await page.evaluate(collectPaintRects);
    empty = emptyRegion(paint);
    record("OF-4 emptyRegion", key, width, empty === null, { emptyRegion: empty, rects: paint.rects.length, scanHeight: Math.round(paint.scanHeight) });
  }

  const file = `${key}-${width}x${height}.png`;
  const out = join(SHOTS, file);
  await page.screenshot({ path: out, fullPage: false });
  const size = pngSize(out);
  const shotOk = r.innerWidth === width && r.innerHeight === height && size.width <= MAX_SHOT_PX && size.height <= MAX_SHOT_PX;
  record("screenshot", key, width, shotOk, { file: `shots-public/${file}`, viewport: `${r.innerWidth}x${r.innerHeight}`, png: `${size.width}x${size.height}` });

  const line = `overflow=${r.scrollWidth - r.clientWidth} minFont=${r.minFont.px} controls=${r.smallControls.length ? "FAIL " + r.smallControls.length : "ok"}` +
    `${r.container ? " container=" + r.container.ratio : ""} contrast=${r.contrast.worst ? r.contrast.worst.ratio : "-"}` +
    `${width >= 1920 ? " empty=" + (empty ? JSON.stringify(empty) : "null") : ""} png=${size.width}x${size.height}`;
  console.log(`  ${key.padEnd(11)} ${(width + "x" + height).padEnd(9)} ${line}`);
  return r;
}

async function matrix(pages) {
  console.log(`matrix: ${pages.length} pages x ${VIEWPORTS.length} viewports`);
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, colorScheme: "light" });
    const page = await ctx.newPage();
    const sink = { errors: [], bad: [] };
    watch(page, sink);
    for (const p of pages) await auditPage(page, p, vp, sink);
    await ctx.close();
  }
}

// Light theme regardless of the OS preference: under colorScheme 'dark' the body still paints --bg.
async function lightForced(pages) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  for (const p of pages) {
    await open(page, p.path);
    const r = await page.evaluate(() => {
      const parse = (c) => {
        const m = String(c).match(/rgba?\(([^)]+)\)/);
        return m ? m[1].split(/[\s,\/]+/).filter(Boolean).map(Number) : null;
      };
      let bg = null;
      for (let e = document.body; e && !bg; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && (c.length < 4 || c[3] > 0)) bg = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      }
      return { bodyBg: bg, prefersDark: matchMedia("(prefers-color-scheme: dark)").matches, colorSchemeMeta: (document.querySelector('meta[name="color-scheme"]') || {}).content || null };
    });
    record("lightForced (os dark)", p.key, 1440, r.bodyBg === LIGHT_BG && r.prefersDark === true, r);
  }
  await ctx.close();
}

/* ---------- main ---------- */
const started = Date.now();
const server = await startServer();
BASE = server.origin + config.basePath;
console.log(`Auditing ${BASE} (${process.env.AUDIT_URL ? "AUDIT_URL" : DIST}) -> ${OUT}`);
browser = await chromium.launch({ headless: true });
let pages = PAGES;
try {
  const adminStatus = await status(BASE + "admin/");
  if (adminStatus !== 200) {
    pages = PAGES.filter((p) => !p.admin);
    record("admin", "admin-lock", 0, true, `admin: not built yet (${BASE}admin/ answered HTTP ${adminStatus}; FEAT-111)`);
  }
  const reportPath = await newestReportPath();
  if (reportPath) {
    const at = pages.findIndex((p) => p.key === "reports") + 1;
    pages = [...pages.slice(0, at), { key: "report", path: reportPath }, ...pages.slice(at)];
  } else record("report", "report", 0, true, "report detail page: no report built yet (company/state/reports/ is empty until the first Sunday with a 48 h-old post); the fixture build carries one — FEAT-203");
  await matrix(pages);
  await lightForced(pages);
} catch (err) {
  record("ERROR", "-", 0, false, String((err && err.stack) || err));
} finally {
  await browser.close();
  if (server.child) server.child.kill();
}

// Summary: per check, and the observed minimum font size / container ratio per width.
const perCheck = new Map();
for (const r of results) {
  const s = perCheck.get(r.check) || { check: r.check, rows: 0, failed: 0 };
  s.rows++;
  if (!r.ok) s.failed++;
  perCheck.set(r.check, s);
}
const perWidth = {};
for (const vp of VIEWPORTS) {
  const fonts = results.filter((r) => r.check === "fontFloor" && r.width === vp.width && typeof r.detail === "string").map((r) => parseFloat(r.detail.match(/min ([\d.]+)px/)[1]));
  const containers = results.filter((r) => r.check === "container" && r.width === vp.width && r.detail && typeof r.detail === "object").map((r) => r.detail.ratio);
  perWidth[vp.width] = {
    minFontPx: fonts.length ? Math.min(...fonts) : null,
    containerRatio: containers.length ? { min: Math.min(...containers), max: Math.max(...containers) } : null,
  };
}
const failed = results.filter((r) => !r.ok).length;
const report = { base: BASE, dist: process.env.AUDIT_URL ? null : DIST, date: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 100) / 10, viewports: VIEWPORTS, pages: pages.map((p) => p.path || "/"), rows: results.length, failed, perCheck: [...perCheck.values()], perWidth, results };
writeFileSync(join(OUT, "audit-results.json"), JSON.stringify(report, null, 2));

console.log("\n" + "check".padEnd(28) + "rows".padStart(6) + "failed".padStart(8));
for (const s of perCheck.values()) console.log(s.check.padEnd(28) + String(s.rows).padStart(6) + String(s.failed).padStart(8));
console.log("\nper width: " + Object.entries(perWidth).map(([w, v]) => `${w}: minFont ${v.minFontPx}px${v.containerRatio ? ` container ${v.containerRatio.min}-${v.containerRatio.max}` : ""}`).join(" | "));
console.log(`\n${results.length} rows, ${failed} failed -> ${join(OUT, "audit-results.json")}`);
process.exit(failed ? 1 : 0);
