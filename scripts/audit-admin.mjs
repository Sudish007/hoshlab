// Real-browser audit of dist/admin/ with api.github.com and raw.githubusercontent.com fully mocked (design §15,
// §17 P1-19; review M2/M5.5/M9/M12/N1/N6/N11/N20; structure of ai-batkahi scripts/audit-admin.mjs). Playwright
// Chromium comes from the `playwright` dependency (plan D16). Every call to api.github.com is answered by an
// in-memory repository seeded from tests/fixtures/company-populated (every company/** file; the queue step adds one
// render-blocked draft the on-disk fixture cannot hold — see RENDER_BLOCKED) and every call to
// raw.githubusercontent.com by tests/fixtures/media/** as image/jpeg; CORS preflights are answered too. No real
// token exists: the only token strings here are the documented fakes ghp_FAKE_OK (push), ghp_FAKE_READONLY
// (push: false), ghp_FAKE_RATE (403 + x-ratelimit-remaining: 0) and ghp_FAKE_BAD (401). The real GitHub path
// (Contents API, workflow_dispatch, run polling) is therefore UNTESTED by this script.
//
// Usage:   npm run build; npm run audit:admin          serves DIST_DIR on a free port >= 8081 and audits it
//          AUDIT_URL=http://127.0.0.1:4173 npm run audit:admin
//          node scripts/audit-admin.mjs lock queue      (subset of steps)
// Output:  AUDIT_OUT/audit-admin-results.json (default .agents/audit/, gitignored) and viewport-only PNGs
//          <= 1920 px in AUDIT_OUT/shots-admin/. Exit 1 on any failing row.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { get } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import config from "../site.config.js";
import { MODE_CONSEQUENCES, WORKFLOWS } from "../src/templates/admin.js";
import { DRAFT_SPEC, HR_DECISION_SPEC, ROSTER_SPEC, validate } from "../engine/lib/schema.js";
import { collectPaintRects, emptyRegion } from "./lib/empty-region.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = resolve(ROOT, process.env.DIST_DIR || "dist");
const OUT = resolve(ROOT, process.env.AUDIT_OUT || join(".agents", "audit"));
const SHOTS = join(OUT, "shots-admin");
mkdirSync(SHOTS, { recursive: true });
const FIXTURE = join(ROOT, "tests", "fixtures", "company-populated");
const MEDIA = join(ROOT, "tests", "fixtures", "media");

const { owner: OWNER, name: REPO, branch: BRANCH } = config.repo;
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
const TOKEN_OK = "ghp_FAKE_OK";
const TOKEN_READONLY = "ghp_FAKE_READONLY";
const TOKEN_RATE = "ghp_FAKE_RATE";
const TOKEN_BAD = "ghp_FAKE_BAD";
const FAKE_TOKENS = [TOKEN_OK, TOKEN_READONLY, TOKEN_RATE, TOKEN_BAD];
const TOKEN_KEY = "hoshlab.admin.token";
const POLL_MS = 10000; // admin.js POLL_MS
const LIGHT_BG = "rgb(251, 251, 248)"; // --bg #FBFBF8 (design §14)
const MIN_FONT_PX = 12;
const MIN_CONTROL_PX = 44; // --control (review N11)
const MAX_SHOT_PX = 1920;
const NAV_UNDERLINE = "rgb(23, 23, 26) 0px -2px 0px 0px inset"; // the one allowed box-shadow (design §14): active nav/tab
const LAYOUT_PARAMS = { minFont: MIN_FONT_PX, minControl: MIN_CONTROL_PX, underline: NAV_UNDERLINE };
const IST_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;
// The page clock is pinned to the fixture's present (the day after its last run, like BUILD_NOW in scripts/test.mjs)
// and keeps ticking from there, so "latest approval" ordering, the calendar month, "must be in the future" and the
// deploy line's "n min ago" do not depend on the machine date. The fake GitHub stamps its runs from the same clock.
const AUDIT_NOW_MS = Date.parse("2026-10-12T12:00:00+05:30");
const T0 = Date.now();
const fakeNow = () => new Date(AUDIT_NOW_MS + (Date.now() - T0)); // the fake GitHub's clock, in step with the page's
const LOCK_VIEWPORTS = [
  { width: 390, height: 844, dsf: 1 },
  { width: 1440, height: 900, dsf: 1 },
  { width: 1920, height: 1080, dsf: 1 },
  { width: 2560, height: 1440, dsf: 0.75 }, // 2560-wide shots come out as 1920×1080 PNGs
];
const VIEWS = ["queue", "blocked", "calendar", "modes", "run", "brand", "roster", "charter", "tell-ceo", "activity", "json"];
const VIEW_HASH = { queue: "#/", blocked: "#/blocked", calendar: "#/calendar", modes: "#/modes", run: "#/run", brand: "#/brand/rishtapatra", roster: "#/roster", charter: "#/charter/qa", "tell-ceo": "#/tell-ceo", activity: "#/activity", json: "#/json/config.json" };

const results = [];
function record(check, page, width, ok, detail) {
  results.push({ check, page, width, ok: !!ok, detail });
  if (!ok) console.log(`  FAIL ${check} ${page} ${width}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const requestLog = [];

/* ---------- fixture (expected values) ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const readFix = (...p) => readFileSync(join(FIXTURE, ...p), "utf8");
const RP = "rp-2026-10-14-kundali-free";
const KD = "kd-2026-10-13-six-rules";
const JR = "jr-2026-10-15-templates";
const FIX = {
  config: JSON.parse(readFix("config.json")),
  status: JSON.parse(readFix("state", "status.json")),
  approvals: readFix("state", "approvals.jsonl"),
  overrides: readFix("state", "overrides.jsonl"),
  feedback: readFix("state", "feedback.jsonl"),
  brandRp: readFix("brands", "rishtapatra.md"),
  charterQa: readFix("charters", "qa.md"),
  roster: readFix("roster.json"),
  draft: (id) => JSON.parse(readFix("state", "drafts", id, "draft.json")),
  qa: (id) => JSON.parse(readFix("state", "drafts", id, "qa.json")),
};
const MEDIA_BRANCH = FIX.config.repo.mediaBranch;
const brandColor = (handle) => FIX.config.pages.find((p) => p.handle === handle).brandColor;
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const QA_IDS = FIX.qa(RP).deterministic.checks.map((c) => c.id); // the 12 deterministic check ids (N20)

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

/* ---------- fake GitHub + fake raw host ---------- */
const blobSha = (buf) => createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex"); // git blob id
const b64 = (buf) => buf.toString("base64").replace(/(.{60})/g, "$1\n"); // GitHub wraps at 60 columns
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-GitHub-Api-Version",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "x-ratelimit-remaining, x-ratelimit-reset",
};

// Every company/** file of the fixture, keyed by its repo path; writes, dispatches and runs are recorded.
// `overlayDrafts` adds draft.json files the fixture on disk cannot hold (see RENDER_BLOCKED below).
function makeFakeRepo({ overlayDrafts = [] } = {}) {
  const files = new Map();
  for (const file of walk(FIXTURE)) {
    const content = readFileSync(file);
    files.set(`company/${relative(FIXTURE, file).split(sep).join("/")}`, { content, sha: blobSha(content) });
  }
  for (const draft of overlayDrafts) {
    const content = Buffer.from(JSON.stringify(draft, null, 2) + "\n", "utf8");
    files.set(`company/state/drafts/${draft.id}/draft.json`, { content, sha: blobSha(content) });
  }
  return { files, puts: [], dispatches: [], runs: [], commits: [], conflictOnce: new Set(), nextRunId: 1000, apiCalls: 0, rawCalls: 0, rawServed: 0 };
}

// R1-02: the draft the engine writes when the Designer refuses a render at the rework cap (engine/agents/designer.js):
// status blocked, media [], qaReasons[0] 'render: <code> — <detail>', renderError kept for the card. Every draft of the
// populated fixture carries committed JPEGs (tests/fixtures-integrity.test.js), so this one is overlaid onto the queue
// step's fake repo only; it is derived from the fixture's rp draft and validated against DRAFT_SPEC before use.
const RENDER_BLOCKED = "rp-2026-10-16-kundali-arrow";
const RENDER_DETAIL = "U+2192 not in Tiro Devanagari Hindi: “→ मुफ़्त जन्म कुंडली”";
function renderBlockedDraft() {
  const base = FIX.draft(RP);
  const at = "2026-10-12T05:36:40+05:30"; // the fixture's Monday run; older than jr's updatedAt, so jr stays first in the list
  const draft = {
    ...base,
    id: RENDER_BLOCKED,
    ideaId: "rp-i0032",
    slotId: "rishtapatra-2026-10-16-1930",
    slotAt: "2026-10-16T19:30:00+05:30",
    status: "blocked",
    revision: FIX.config.defaults.maxReworkLoops + 1,
    reworkCount: FIX.config.defaults.maxReworkLoops,
    createdAt: "2026-10-12T05:33:10+05:30",
    updatedAt: at,
    runId: "engine-daily-20261012-0531-9a8b7c",
    artwork: { ...base.artwork, headline: "→ मुफ़्त जन्म कुंडली" },
    altText: "Cream card with a maroon Hindi headline behind an arrow: free Janam Kundali, computed on your device.",
    writerNote: "Third revision; the arrow in the headline was kept each time.",
    media: [],
    publishAttempts: [],
    qaReasons: [`render: missing_glyphs — ${RENDER_DETAIL}`],
    renderError: { code: "missing_glyphs", detail: RENDER_DETAIL, at },
  };
  delete draft.qaRef;
  delete draft.designNote;
  const r = validate(draft, DRAFT_SPEC);
  if (!r.ok) throw new Error(`audit-admin: the render-blocked overlay draft does not validate — ${r.errors.join("; ")}`);
  return draft;
}

// GitHub's directory listing: files and sub-directories one level under `dir`, sorted by name.
function listing(files, dir) {
  const prefix = dir ? dir + "/" : "";
  const seen = new Map();
  for (const [k, v] of files) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) seen.set(rest, { name: rest, path: k, sha: v.sha, size: v.content.length, type: "file" });
    else if (!seen.has(rest.slice(0, slash))) {
      const name = rest.slice(0, slash);
      seen.set(name, { name, path: prefix + name, sha: createHash("sha1").update(prefix + name).digest("hex"), size: 0, type: "dir" });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function installMocks(ctx, fake) {
  const json = (route, code, body, headers = {}) => route.fulfill({ status: code, headers: { ...CORS, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const commit = (message, path) => {
    const sha = createHash("sha1").update(`${message}\0${path}\0${fake.commits.length}`).digest("hex");
    fake.commits.push({ sha, message, path });
    return sha;
  };
  const newRun = (file) => {
    const id = fake.nextRunId++;
    const now = fakeNow().toISOString();
    const run = { id, workflow: file, name: file.replace(/\.yml$/, ""), event: "workflow_dispatch", status: "queued", conclusion: null, head_sha: "f".repeat(40), html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${id}`, created_at: now, updated_at: now };
    fake.runs.push(run);
    return run;
  };
  // One state per poll: queued -> in_progress -> completed (success).
  const advance = (run) => {
    if (run.status === "queued") run.status = "in_progress";
    else if (run.status === "in_progress") {
      run.status = "completed";
      run.conclusion = "success";
    }
    run.updated_at = fakeNow().toISOString();
  };
  const publicRun = ({ workflow, ...run }) => run;
  const cannedPagesRun = () => ({ id: 1, name: "pages", event: "push", status: "completed", conclusion: "success", head_sha: "0".repeat(40), html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/1`, created_at: new Date(fakeNow().getTime() - 5 * 60000).toISOString(), updated_at: new Date(fakeNow().getTime() - 3 * 60000).toISOString() });

  const api = (route, request) => {
    fake.apiCalls++;
    const method = request.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    const token = (request.headers()["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (token === TOKEN_RATE) return json(route, 403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(fakeNow().getTime() / 1000) + 600) });
    if (token !== TOKEN_OK && token !== TOKEN_READONLY) return json(route, 401, { message: "Bad credentials" });
    const p = url.pathname;
    if (p === REPO_PATH && method === "GET") return json(route, 200, { full_name: `${OWNER}/${REPO}`, default_branch: BRANCH, permissions: { admin: false, push: token === TOKEN_OK, pull: true } });

    const m = p.match(new RegExp(`^${REPO_PATH}/contents/(.+)$`));
    if (m) {
      const path = decodeURIComponent(m[1]).replace(/\/$/, "");
      if (method === "GET") {
        const file = fake.files.get(path);
        if (file) return json(route, 200, { name: path.split("/").pop(), path, sha: file.sha, size: file.content.length, type: "file", encoding: "base64", content: b64(file.content) });
        const list = listing(fake.files, path);
        if (list.length) return json(route, 200, list);
        return json(route, 404, { message: "Not Found" });
      }
      if (method === "PUT") {
        if (token !== TOKEN_OK) return json(route, 403, { message: "Resource not accessible by personal access token" });
        const body = request.postDataJSON();
        const existing = fake.files.get(path);
        const rec = { path, message: body.message, sha: body.sha || null, branch: body.branch, status: 0, decoded: null, commitSha: null };
        fake.puts.push(rec);
        if (existing && !body.sha) return json(route, (rec.status = 422), { message: '"sha" wasn\'t supplied' });
        if (existing && body.sha !== existing.sha) return json(route, (rec.status = 409), { message: `${path} does not match ${body.sha}` });
        if (fake.conflictOnce.has(path)) {
          fake.conflictOnce.delete(path);
          return json(route, (rec.status = 409), { message: `${path} does not match ${body.sha} (simulated once)` });
        }
        const content = Buffer.from(String(body.content).replace(/\s+/g, ""), "base64");
        const newSha = blobSha(content);
        fake.files.set(path, { content, sha: newSha });
        rec.decoded = content.toString("utf8");
        rec.commitSha = commit(body.message, path);
        rec.status = existing ? 200 : 201;
        return json(route, rec.status, { content: { path, sha: newSha }, commit: { sha: rec.commitSha, message: body.message } });
      }
    }
    const d = p.match(new RegExp(`^${REPO_PATH}/actions/workflows/([^/]+)/dispatches$`));
    if (d && method === "POST") {
      const file = decodeURIComponent(d[1]);
      fake.dispatches.push({ file, method, url: request.url(), hasAuthorization: Boolean(token), body: request.postDataJSON() });
      newRun(file);
      return route.fulfill({ status: 204, headers: CORS });
    }
    const r = p.match(new RegExp(`^${REPO_PATH}/actions/workflows/([^/]+)/runs$`));
    if (r && method === "GET") {
      const file = decodeURIComponent(r[1]);
      const run = [...fake.runs].reverse().find((x) => x.workflow === file);
      if (run) {
        const snapshot = publicRun(run);
        advance(run);
        return json(route, 200, { total_count: 1, workflow_runs: [snapshot] });
      }
      if (file === WORKFLOWS.pages) return json(route, 200, { total_count: 1, workflow_runs: [cannedPagesRun()] });
      return json(route, 200, { total_count: 0, workflow_runs: [] });
    }
    const one = p.match(new RegExp(`^${REPO_PATH}/actions/runs/(\\d+)$`));
    if (one && method === "GET") {
      const run = fake.runs.find((x) => x.id === Number(one[1]));
      return run ? json(route, 200, publicRun(run)) : json(route, 404, { message: "Not Found" });
    }
    return json(route, 404, { message: `unmocked ${method} ${p}` });
  };

  // raw.githubusercontent.com/<owner>/<repo>/<media branch>/media/<id>/<file> -> tests/fixtures/media/<id>/<file>
  const raw = (route, request) => {
    fake.rawCalls++;
    const url = new URL(request.url());
    const m = url.pathname.match(new RegExp(`^/${OWNER}/${REPO}/${MEDIA_BRANCH}/media/(.+)$`));
    const file = m ? join(MEDIA, ...decodeURIComponent(m[1]).split("/")) : null;
    if (!file || !file.startsWith(MEDIA) || !existsSync(file) || statSync(file).isDirectory()) return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" }, body: "404: Not Found" });
    fake.rawServed++;
    return route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "image/jpeg", "Cache-Control": "max-age=300" }, body: readFileSync(file) });
  };

  return Promise.all([ctx.route(`${API}/**`, api), ctx.route(`${RAW}/**`, raw)]);
}

/* ---------- browser helpers ---------- */
let browser;
let BASE;
let ADMIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Request bodies are kept readable: base64 `content` becomes its decoded byte count.
function summariseBody(request) {
  const data = request.postData();
  if (!data) return null;
  try {
    const body = JSON.parse(data);
    if (typeof body.content === "string") body.content = `base64(${Buffer.from(body.content.replace(/\s+/g, ""), "base64").length} bytes)`;
    return body;
  } catch {
    return data.slice(0, 200);
  }
}

async function newCtx({ width = 1440, height = 900, dsf = 1, token = null, fake = makeFakeRepo() } = {}) {
  // colorScheme dark: the admin must stay light regardless of the OS preference (design §14).
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, colorScheme: "dark" });
  ctx.meta = { fake, width, height, errors: [], console: [], dialogs: [], dialog: "accept", requests: [] };
  await ctx.addInitScript(
    ({ token, key }) => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
      try {
        if (token) sessionStorage.setItem(key, token);
      } catch (e) {}
    },
    { token, key: TOKEN_KEY },
  );
  await installMocks(ctx, fake);
  ctx.on("request", (request) => {
    const headers = request.headers();
    ctx.meta.requests.push({ method: request.method(), url: request.url(), hasAuthorization: Boolean(headers.authorization), body: request.method() === "GET" ? null : summariseBody(request) });
  });
  ctx.on("page", (page) => {
    page.on("pageerror", (err) => ctx.meta.errors.push(String((err && err.message) || err)));
    page.on("console", (msg) => ctx.meta.console.push(`${msg.type()}: ${msg.text()}`));
    page.on("dialog", (d) => {
      ctx.meta.dialogs.push(d.message());
      if (ctx.meta.dialog === "dismiss") d.dismiss();
      else d.accept();
    });
  });
  const page = await ctx.newPage();
  // Installed before navigation; the fake clock starts at AUDIT_NOW_MS and ticks on (runNow fast-forwards it).
  await page.clock.install({ time: AUDIT_NOW_MS });
  return { ctx, page, fake };
}
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}
async function open(page, hash = "") {
  await page.goto(ADMIN + hash, { waitUntil: "load" });
  await settle(page);
}
// Same-document route change (hashchange) + the view's own readiness condition.
async function go(page, view) {
  await page.evaluate((h) => {
    location.hash = h;
  }, VIEW_HASH[view]);
  await waitView(page, view);
}
// In-page readiness per view (serialised by Playwright; self-contained).
function viewReadyEval(name) {
  const $ = (id) => document.getElementById(id);
  const n = (sel) => document.querySelectorAll(sel).length;
  if ($("dashboard").hidden || $(`view-${name}`).hidden || !$("loading").hidden || $("queue-count").hidden) return false;
  switch (name) {
    case "queue":
      return n("#queue > li") > 0 || !$("queue-empty").hidden;
    case "blocked":
      return n("#blocked > li") > 0 || !$("blocked-empty").hidden;
    case "calendar":
      return n("#cal-grid .cal-row") > 1;
    case "modes":
      return n("#mode-rows .mode-row") > 0;
    case "brand":
      return $("brand-text").value !== "" && n("#brand-facts tbody tr") > 0;
    case "roster":
      return $("roster-text").value !== "" && $("proposal-list").getAttribute("aria-busy") === "false" && (n("#proposal-list > li") > 0 || !$("proposals-empty").hidden);
    case "charter":
      return $("charter-text").value !== "" && !/loading/.test($("charter-state").textContent);
    case "activity":
      return n("#last-runs > li") > 0 || !$("runs-empty").hidden;
    case "json":
      return $("json-out").textContent !== "";
    default:
      return true;
  }
}
const waitView = (page, view) => page.waitForFunction(viewReadyEval, view, { timeout: 20000 });
const csp = (page) => page.evaluate(() => window.__csp || []);
const styleCount = (page) => page.evaluate(() => document.querySelectorAll("[style]").length);
// Poll the fake for a completed (non-409) PUT to `path` recorded after index `after`.
async function waitPut(fake, path, after = 0, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = fake.puts.slice(after).find((p) => p.path === path && p.status >= 200 && p.status < 300);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}
const lastLine = (text) => {
  const lines = String(text).trimEnd().split("\n");
  return { count: lines.length, last: JSON.parse(lines[lines.length - 1]), lines };
};
const stored = (page) => page.evaluate((k) => ({ session: sessionStorage.getItem(k), local: localStorage.getItem(k) }), TOKEN_KEY);
const mask = (v) => (v === null ? null : FAKE_TOKENS.includes(v) ? "(fake token)" : "(other)");

// Close a context and record its cross-cutting rows: CSP (M2), page errors, inline styles (M2), token
// hygiene, Authorization only to api.github.com (N6), no state/runs|usage|metrics request (M9).
async function closeCtx(ctx, page, label) {
  const { width } = ctx.meta;
  const violations = await csp(page).catch(() => ["(page gone)"]);
  record("csp violations (M2)", label, width, violations.length === 0, violations.length ? violations : "zero securitypolicyviolation events");
  record("pageErrors", label, width, ctx.meta.errors.length === 0, ctx.meta.errors.length ? ctx.meta.errors : "none");
  const styles = await styleCount(page).catch(() => -1);
  record("inlineStyles (M2)", label, width, styles === 0, `${styles} [style] attributes`);
  const leaks = ctx.meta.console.filter((l) => FAKE_TOKENS.some((t) => l.includes(t)));
  const url = page.url();
  record("tokenHygiene console/url", label, width, leaks.length === 0 && !FAKE_TOKENS.some((t) => url.includes(t)), { leaks, url, consoleLines: ctx.meta.console.length });
  const reqs = ctx.meta.requests;
  const withAuth = reqs.filter((r) => r.hasAuthorization);
  const offTarget = withAuth.filter((r) => !r.url.startsWith(API + "/"));
  const rawWithAuth = reqs.filter((r) => r.url.startsWith(RAW + "/") && r.hasAuthorization);
  const hosts = {};
  for (const r of reqs) hosts[new URL(r.url).host] = (hosts[new URL(r.url).host] || 0) + 1;
  record("authTargets (N6)", label, width, offTarget.length === 0 && rawWithAuth.length === 0, { requests: reqs.length, withAuthorization: withAuth.length, offTarget: offTarget.map((r) => r.url), rawWithAuthorization: rawWithAuth.length, hosts });
  const logs = reqs.filter((r) => /company\/state\/(runs|usage|metrics)\//.test(r.url));
  record("noLogRequests (M9)", label, width, logs.length === 0, logs.length ? logs.map((r) => r.url) : "no request for state/runs|usage|metrics");
  // Integration seam: a JavaScript value rendered as text ("undefined", "NaN", "[object Object]", "Invalid Date")
  // anywhere in the final DOM — static markup, hidden views and the data the flows rendered — or in an attribute.
  const valueLeaks = await page.evaluate(valueLeaksEval).catch(() => ["(page gone)"]);
  record("valueLeaks (text/attributes)", label, width, valueLeaks.length === 0, valueLeaks.length ? valueLeaks : "no undefined/NaN/[object Object]/Invalid Date in the DOM");
  requestLog.push({ step: label, width, requests: reqs.map((r) => ({ method: r.method, url: r.url, hasAuthorization: r.hasAuthorization, body: r.body })) });
  await ctx.close();
}
// Runs in the page: text nodes (outside the admin-config JSON and other scripts) and attribute values.
function valueLeaksEval() {
  const re = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/;
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length < 20; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest("script")) continue;
    if (re.test(n.nodeValue)) out.push(`text in <${parent.tagName.toLowerCase()}${parent.id ? "#" + parent.id : ""}>: ${n.nodeValue.trim().slice(0, 120)}`);
  }
  for (const el of document.body.querySelectorAll("*")) {
    if (out.length >= 20) break;
    for (const a of el.attributes) {
      if (re.test(a.value)) out.push(`<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} ${a.name}="${a.value.slice(0, 120)}">`);
    }
  }
  return out;
}
function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG: " + file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
// Viewport-only screenshot; caret:'initial' so Playwright does not leave empty style="" attributes behind
// (FEAT-111 note), PNG never wider or taller than 1920 px.
async function shot(page, name, { width, height, dsf = 1 }) {
  const file = `${name}-${width}x${height}.png`;
  const out = join(SHOTS, file);
  await settle(page);
  await page.screenshot({ path: out, fullPage: false, caret: "initial" });
  const size = pngSize(out);
  const live = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, styles: document.querySelectorAll("[style]").length }));
  const ok = live.w === width && live.h === height && size.width === Math.round(width * dsf) && size.height === Math.round(height * dsf) && size.width <= MAX_SHOT_PX && size.height <= MAX_SHOT_PX && live.styles === 0;
  record("screenshot", name, width, ok, { file: `shots-admin/${file}`, viewport: `${live.w}x${live.h}`, png: `${size.width}x${size.height}`, styleAttrsAfter: live.styles });
}

/* ---------- in-page evaluators (serialised by Playwright; self-contained) ---------- */
// Layout rules shared with scripts/audit.mjs: overflow, inner scrollers (M12), 12 px floor, 44 px controls (N11),
// gradient/shadow scan, light theme, tab rows, [style] count, the Modes view text (N1), calendar ARIA.
function layoutEval({ minFont, minControl, underline }) {
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
  const inMedia = (el) => !!el.closest(".thumb");
  const all = [...document.body.querySelectorAll("*")].filter(visible);

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

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const owners = new Set();
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    if (visible(el)) owners.add(el);
  }
  out.minFont = { px: 999, el: null, sample: null };
  out.small = [];
  for (const el of owners) {
    if (inMedia(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const sample = el.textContent.trim().slice(0, 40);
    if (fs < out.minFont.px) out.minFont = { px: round(fs, 100), el: desc(el), sample };
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

  // Chrome scan: no gradient, no box-shadow except the active nav/tab underline.
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
      if (s && s !== "none" && !(pseudo === null && s === underline && el.matches('.site-nav a[aria-current="page"], .admin-tabs a[aria-current="page"]'))) out.shadows.push({ el: desc(el) + (pseudo || ""), boxShadow: s });
    }
  }

  const tabs = [...document.querySelectorAll(".admin-tabs a")].filter(visible);
  out.tabs = tabs.length;
  out.tabRows = tabs.length ? new Set(tabs.map((a) => Math.round(a.getBoundingClientRect().top))).size : 0;
  out.styleAttrs = document.querySelectorAll("[style]").length;
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    return m ? m[1].split(/[\s,\/]+/).filter(Boolean).map(Number) : null;
  };
  let bg = null;
  for (let e = document.body; e && !bg; e = e.parentElement) {
    const c = parse(getComputedStyle(e).backgroundColor);
    if (c && (c.length < 4 || c[3] > 0)) bg = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }
  out.bodyBg = bg;
  out.prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const modes = document.getElementById("view-modes");
  out.modesText = modes && !modes.hidden ? modes.innerText : null;
  out.gridcells = document.querySelectorAll("[role=gridcell]").length;
  out.cellsOutsideRow = [...document.querySelectorAll("[role=gridcell]")].filter((el) => !el.closest("[role=row]")).length;
  return out;
}
function layoutRows(key, width, r) {
  record("overflow", key, width, r.scrollWidth - r.clientWidth === 0, `scrollWidth ${r.scrollWidth} clientWidth ${r.clientWidth}`);
  record("innerScroll (M12)", key, width, r.innerScroll.length === 0, r.innerScroll.length ? r.innerScroll : "no inner scroll container (a captioned .table-wrap may scroll)");
  record("fontFloor", key, width, r.small.length === 0, r.small.length ? r.small : `min ${r.minFont.px}px (${r.minFont.el}: ${JSON.stringify(r.minFont.sample)})`);
  record("controls (N11)", key, width, r.smallControls.length === 0, r.smallControls.length ? r.smallControls : `${r.controls} controls >= ${MIN_CONTROL_PX}px`);
  record("chrome (gradient/shadow)", key, width, r.gradients.length === 0 && r.shadows.length === 0, r.gradients.length || r.shadows.length ? { gradients: r.gradients, shadows: r.shadows } : "no gradient, no box-shadow beyond the active tab underline");
  record("inlineStyles (M2)", key, width, r.styleAttrs === 0, `${r.styleAttrs} [style] attributes`);
}
function lockStateEval(ids) {
  const $ = (id) => document.getElementById(id);
  const text = document.body.innerText;
  return {
    lock: !$("lock").hidden,
    help: !$("lock-help").hidden,
    dashboardHidden: $("dashboard").hidden,
    signinEnabled: !$("signin-btn").disabled,
    tokenType: $("token").type,
    autocomplete: $("token").getAttribute("autocomplete"),
    remember: $("remember").checked,
    leaked: ids.filter((id) => text.includes(id)),
    queueChildren: $("queue").children.length,
    securityCopy: text.includes("This page talks to api.github.com with your token and loads artwork thumbnails from raw.githubusercontent.com without it."),
  };
}
// Queue / blocked cards as the owner sees them.
function cardsEval(listId) {
  const $ = (id) => document.getElementById(id);
  const cards = [...document.querySelectorAll(`#${listId} > li.queue-item`)].map((li) => {
    const img = li.querySelector(".thumb img");
    const handle = li.querySelector(".chip-handle");
    const reasons = li.querySelector('[data-slot="reasons"]');
    return {
      id: li.dataset.draft,
      page: li.dataset.page,
      head: [...li.querySelectorAll('[data-slot="head"] .chip')].map((c) => c.textContent),
      qa: [...li.querySelectorAll('[data-slot="qa"] .chip')].map((c) => ({ text: c.textContent, ok: c.classList.contains("chip-ok"), bad: c.classList.contains("chip-bad") })),
      buttons: [...li.querySelectorAll('[data-slot="actions"] button')].map((b) => b.textContent),
      links: [...li.querySelectorAll('[data-slot="actions"] a')].map((a) => ({ text: a.textContent, href: a.getAttribute("href"), rel: a.getAttribute("rel"), target: a.getAttribute("target") })),
      thumb: img ? { src: img.getAttribute("src"), complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, missing: img.classList.contains("missing") } : null,
      open: li.querySelector('[data-slot="open"]').getAttribute("href"),
      handle: handle ? { text: handle.textContent, dataPage: handle.dataset.page, color: getComputedStyle(handle).color, borderColor: getComputedStyle(handle).borderTopColor, styleAttr: handle.hasAttribute("style") } : null,
      captionLength: li.querySelector('[data-slot="caption"]').textContent.length,
      lang: li.querySelector('[data-slot="caption"]').getAttribute("lang"),
      note: li.querySelector('[data-slot="note"]').textContent,
      reasons: reasons.hidden ? null : reasons.textContent,
    };
  });
  const deployLink = $("deploy-status").querySelector("a");
  return {
    cards,
    count: $("queue-count").textContent,
    countHidden: $("queue-count").hidden,
    summary: $("queue-summary").textContent,
    emptyHidden: $(`${listId}-empty`).hidden,
    dashError: $("dash-error").hidden ? null : $("dash-error").textContent,
    deploy: $("deploy-status").textContent.trim(),
    deployLink: deployLink ? deployLink.href : null,
    title: $("view-title").textContent,
  };
}

/* ---------- steps ---------- */
// Lock screen at four viewports (layout rules, OF-4 at >= 1920, screenshots), then the sign-in flows at 1440.
async function lock() {
  console.log("lock: 4 viewports + sign-in flows");
  for (const vp of LOCK_VIEWPORTS) {
    const { ctx, page } = await newCtx(vp);
    await open(page);
    const state = await page.evaluate(lockStateEval, [RP, KD, JR]);
    const r = await page.evaluate(layoutEval, LAYOUT_PARAMS);
    record("lock screen", "lock", vp.width, state.lock && state.help && state.dashboardHidden && state.signinEnabled && state.tokenType === "password" && state.autocomplete === "off" && !state.remember && state.leaked.length === 0 && state.queueChildren === 0 && state.securityCopy, state);
    layoutRows("lock", vp.width, r);
    record("lightForced (os dark)", "lock", vp.width, r.bodyBg === LIGHT_BG && r.prefersDark === true, { bodyBg: r.bodyBg, prefersDark: r.prefersDark });
    if (vp.width >= 1920) {
      const paint = await page.evaluate(collectPaintRects);
      const empty = emptyRegion(paint);
      record("OF-4 emptyRegion", "lock", vp.width, empty === null, { emptyRegion: empty, rects: paint.rects.length, scanHeight: Math.round(paint.scanHeight) });
    }
    await shot(page, "lock", vp);
    await closeCtx(ctx, page, "lock");
  }

  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900 });
  await open(page);
  const signIn = async (token, remember = false) => {
    await page.evaluate(() => {
      const e = document.getElementById("signin-error");
      e.textContent = "";
      e.hidden = true;
    });
    await page.fill("#token", token);
    await page.evaluate((on) => {
      document.getElementById("remember").checked = on;
    }, remember);
    await page.click("#signin-btn");
  };
  const errText = () => page.waitForFunction(() => {
    const e = document.getElementById("signin-error");
    return !e.hidden && e.textContent.trim() ? e.textContent.trim() : null;
  }, null, { timeout: 5000 }).then((h) => h.jsonValue());
  const view = () => page.evaluate(() => ({ lock: !document.getElementById("lock").hidden, dashboard: !document.getElementById("dashboard").hidden, tokenValue: document.getElementById("token").value.length }));

  // Three failure messages (github.js userMessage); nothing stored, the token never reaches the URL.
  for (const [token, expect, key] of [
    [TOKEN_BAD, (t) => t === "Token invalid or expired", "401 bad token"],
    [TOKEN_READONLY, (t) => t === "Token has no write access to this repository", "push:false read-only token"],
    [TOKEN_RATE, (t) => /^GitHub rate limit — try again at \d{2}:\d{2} IST$/.test(t), "403 rate-limited token"],
  ]) {
    await signIn(token);
    const text = await errText().catch(() => "(no error shown)");
    const s = await stored(page);
    const v = await view();
    record(`signin ${key}`, "lock", 1440, expect(text) && !page.url().includes(token) && s.session === null && s.local === null && v.lock && !v.dashboard, { text, stored: s, view: v });
  }
  // OK token, remember unticked -> sessionStorage only; the field is cleared; sign out clears storage.
  await signIn(TOKEN_OK, false);
  await waitView(page, "queue");
  let s = await stored(page);
  let v = await view();
  record("signin ok (session)", "lock", 1440, s.session === TOKEN_OK && s.local === null && v.dashboard && !v.lock && v.tokenValue === 0, { stored: { session: mask(s.session), local: mask(s.local) }, view: v });
  await page.click("#signout");
  await page.waitForFunction(() => !document.getElementById("lock").hidden, null, { timeout: 5000 });
  s = await stored(page);
  v = await view();
  record("signout clears storage", "lock", 1440, s.session === null && s.local === null && v.lock && !v.dashboard, { stored: s, view: v });
  // Remember ticked -> localStorage only.
  await signIn(TOKEN_OK, true);
  await waitView(page, "queue");
  s = await stored(page);
  record("signin ok (remember)", "lock", 1440, s.local === TOKEN_OK && s.session === null, { stored: { session: mask(s.session), local: mask(s.local) } });
  await page.click("#signout");
  await page.waitForFunction(() => !document.getElementById("lock").hidden, null, { timeout: 5000 });
  s = await stored(page);
  v = await view();
  record("signout clears storage (remember)", "lock", 1440, s.session === null && s.local === null && v.lock, { stored: s, view: v });
  const outer = await page.evaluate(() => document.documentElement.outerHTML);
  const activity = await page.$$eval("#activity-list li", (l) => l.map((x) => x.textContent));
  const leaks = { dom: FAKE_TOKENS.filter((t) => outer.includes(t)), activity: FAKE_TOKENS.filter((t) => activity.some((l) => l.includes(t))), url: FAKE_TOKENS.filter((t) => page.url().includes(t)) };
  record("tokenHygiene dom/activity", "lock", 1440, Object.values(leaks).every((a) => a.length === 0), { ...leaks, activityLines: activity.length, apiCalls: fake.apiCalls });
  await closeCtx(ctx, page, "signin");
}

// Queue render against the fixture (counts, thumbnails from the fake raw host, 12 QA chips + model verdict, brand
// colour via data-page), the blocked list (the fixture's QA-blocked jr draft + the overlaid render-blocked draft,
// R1-02), then Approve rp and Reject kd with the PUT bodies asserted.
async function queue() {
  console.log("queue: render, blocked, approve, reject");
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK, fake: makeFakeRepo({ overlayDrafts: [renderBlockedDraft()] }) });
  await open(page, "#/");
  await waitView(page, "queue");
  // Thumbnails are loading="lazy": bring every card into view, then wait for the loads to finish.
  for (const img of await page.$$("#queue .thumb img")) await img.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll("#queue .thumb img")].every((i) => i.complete), null, { timeout: 15000 });
  await page.evaluate(() => scrollTo(0, 0));
  const q = await page.evaluate(cardsEval, "queue");
  const rp = q.cards.find((c) => c.id === RP);
  const kd = q.cards.find((c) => c.id === KD);
  const draftRp = FIX.draft(RP);
  const draftKd = FIX.draft(KD);
  record("queue cards (fixture)", "queue", 1440, q.cards.length === 2 && q.cards[0].id === KD && q.cards[1].id === RP && q.count === "2" && !q.countHidden && q.summary === "2 in the queue (@rishtapatra 1 · @kaatdo 1 · @job_rez 0) · 1 awaiting your approval · 2 blocked, failed, expired or rejected" && q.emptyHidden && q.dashError === null && q.title === "Approval queue" && rp.head.includes("awaiting approval") && rp.buttons.join("|") === "Approve|Edit caption|Move slot|Reject with reason" && kd.head.some((h) => /^approved rev 1 · /.test(h)) && kd.buttons.join("|") === "Edit caption|Move slot|Reject with reason" && rp.head.includes("rev 1") && rp.head.includes("image · 1080×1350 · 97 KB") && rp.lang === "hi" && kd.lang === null && rp.note.includes("Writer note:") && rp.note.includes("alt text:"), { count: q.count, summary: q.summary, order: q.cards.map((c) => c.id), rp: { head: rp && rp.head, buttons: rp && rp.buttons }, kd: { head: kd && kd.head, buttons: kd && kd.buttons }, dashError: q.dashError });
  record("queue thumbnails (fake raw host)", "queue", 1440, q.cards.every((c) => c.thumb && c.thumb.src.startsWith(`${RAW}/${OWNER}/${REPO}/${MEDIA_BRANCH}/media/`) && c.thumb.complete && c.thumb.naturalWidth === 1080 && c.thumb.naturalHeight === 1350 && !c.thumb.missing) && rp.thumb.src === draftRp.media[0].rawUrl && kd.thumb.src === draftKd.media[0].rawUrl && rp.open === draftRp.media[0].rawUrl && fake.rawServed >= 2, { thumbs: q.cards.map((c) => c.thumb), rawRequests: fake.rawCalls, rawServed: fake.rawServed });
  const qaOk = (c) => c.qa.length === QA_IDS.length + 1 && QA_IDS.every((id, i) => c.qa[i].ok && c.qa[i].text.startsWith(`${id.replace(/_/g, " ")} · `)) && /^model: pass · tone \d\/5$/.test(c.qa[QA_IDS.length].text) && c.qa[QA_IDS.length].ok;
  record("queue QA chips 12 + model (N20)", "queue", 1440, q.cards.every(qaOk), q.cards.map((c) => ({ id: c.id, chips: c.qa.length, texts: c.qa.map((x) => x.text) })));
  record("queue brand colour via data-page (M2)", "queue", 1440, q.cards.every((c) => c.handle && c.handle.text === `@${c.page}` && c.handle.dataPage === c.page && c.handle.color === hexToRgb(brandColor(c.page)) && c.handle.borderColor === hexToRgb(brandColor(c.page)) && !c.handle.styleAttr), q.cards.map((c) => ({ id: c.id, handle: c.handle, expected: hexToRgb(brandColor(c.page)) })));
  record("queue links (full size, raw draft)", "queue", 1440, q.cards.every((c) => c.links.length === 2 && c.links[0].text === "Open full size" && c.links[0].rel === "noopener" && c.links[0].target === "_blank" && c.links[0].href.startsWith(RAW + "/") && c.links[1].text === "Raw draft" && c.links[1].href === `#/json/state/drafts/${c.id}/draft.json`), q.cards.map((c) => c.links));
  record("deploy line (pages.yml latest run)", "queue", 1440, /^Last Pages deploy: succeeded · \d+ min ago run$/.test(q.deploy) && q.deployLink === `https://github.com/${OWNER}/${REPO}/actions/runs/1`, { deploy: q.deploy, link: q.deployLink });

  await go(page, "blocked");
  const b = await page.evaluate(cardsEval, "blocked");
  const jr = b.cards[0];
  record("blocked list (fixture)", "blocked", 1440, b.cards.length === 2 && jr.id === JR && jr.head.includes("blocked") && jr.buttons.length === 0 && jr.links.length === 2 && jr.head.some((h) => /^slot: .*18:30 IST · moved$/.test(h)) && jr.head.includes("rev 3") && jr.reasons && jr.reasons.startsWith("Reasons: ") && jr.head.includes("carousel · 4 slides · 354 KB"), { cards: b.cards.map((c) => ({ id: c.id, head: c.head, buttons: c.buttons, reasons: c.reasons })) });
  // R1-02: the render-blocked draft (Designer refusal at the rework cap) is listed with its render reason, no artwork
  // and no actions — the owner sees why the slot was lost instead of a draft that exists in no list.
  const rb = b.cards.find((c) => c.id === RENDER_BLOCKED);
  record("blocked list: render-refused draft (R1-02)", "blocked", 1440, Boolean(rb) && b.cards[1] === rb && rb.head.includes("blocked") && rb.head.includes("rev 3") && rb.head.includes("image · not rendered yet") && rb.reasons === `Reasons: render: missing_glyphs — ${RENDER_DETAIL}` && rb.buttons.length === 0 && rb.links.length === 1 && rb.links[0].text === "Raw draft" && rb.thumb && rb.thumb.missing && rb.thumb.src === null && rb.open === null && rb.lang === "hi" && rb.note.includes("Writer note: Third revision"), rb ? { head: rb.head, reasons: rb.reasons, buttons: rb.buttons, links: rb.links, thumb: rb.thumb, open: rb.open } : { cards: b.cards.map((c) => c.id) });

  // Approve rp -> PUT company/state/approvals.jsonl: old content + one JSON line, sha of the old file, message.
  await go(page, "queue");
  const approvalsSha = fake.files.get("company/state/approvals.jsonl").sha;
  const before = fake.puts.length;
  await page.click(`#queue .queue-item[data-draft="${RP}"] [data-slot="actions"] button:has-text("Approve")`);
  const put = await waitPut(fake, "company/state/approvals.jsonl", before);
  await page.waitForFunction((id) => {
    const li = document.querySelector(`#queue .queue-item[data-draft="${id}"]`);
    return li && [...li.querySelectorAll('[data-slot="head"] .chip')].some((c) => /^approved rev 1 · /.test(c.textContent)) && ![...li.querySelectorAll("button")].some((b) => b.textContent === "Approve");
  }, RP, { timeout: 5000 });
  const a = put ? lastLine(put.decoded) : null;
  const approveOk = put && put.status === 200 && put.sha === approvalsSha && put.branch === BRANCH && put.message === `approve: ${RP} (rev 1)` && a.count === 5 && a.lines.slice(0, 4).join("\n") === FIX.approvals.trimEnd() && a.last.draftId === RP && a.last.decision === "approve" && a.last.revision === 1 && a.last.by === "owner" && IST_ISO.test(a.last.at) && Object.keys(a.last).sort().join() === "at,by,decision,draftId,revision" && put.decoded.endsWith("\n") && fake.puts.length === before + 1;
  const afterApprove = await page.evaluate(cardsEval, "queue");
  record("approve PUT (approvals.jsonl line)", "queue", 1440, approveOk && afterApprove.cards.length === 2 && afterApprove.summary.includes("0 awaiting your approval"), { put: put && { path: put.path, status: put.status, message: put.message, shaIsOld: put.sha === approvalsSha, lines: a.count, last: a.last }, summary: afterApprove.summary });

  // Reject kd: disabled without a reason (3-500 chars), then two PUTs: approvals (reject + reason) and feedback.
  await page.click(`#queue .queue-item[data-draft="${KD}"] [data-slot="actions"] button:has-text("Reject with reason")`);
  await page.waitForFunction(() => document.getElementById("reject-dialog").open, null, { timeout: 5000 });
  const g0 = await page.evaluate(() => ({ disabled: document.getElementById("reject-go").disabled, text: document.getElementById("reject-text").textContent, count: document.getElementById("reject-count").textContent }));
  await page.fill("#reject-reason", "no");
  const g1 = await page.evaluate(() => ({ disabled: document.getElementById("reject-go").disabled, count: document.getElementById("reject-count").textContent }));
  const REASON = "Lead with the limitation, not the rule list. Shorter second line.";
  await page.fill("#reject-reason", REASON);
  const g2 = await page.evaluate(() => ({ disabled: document.getElementById("reject-go").disabled, count: document.getElementById("reject-count").textContent }));
  record("reject gating (reason 3-500 chars)", "queue", 1440, g0.disabled && g0.text.startsWith(`${KD} (@kaatdo, rev 1)`) && g0.count === "0 / 500" && g1.disabled && g1.count === "2 / 500" && !g2.disabled && g2.count === `${REASON.length} / 500`, { g0, g1, g2 });
  const before2 = fake.puts.length;
  const feedbackSha = fake.files.get("company/state/feedback.jsonl").sha;
  const approvalsSha2 = fake.files.get("company/state/approvals.jsonl").sha;
  await page.click("#reject-go");
  const rejPut = await waitPut(fake, "company/state/approvals.jsonl", before2);
  const fbPut = await waitPut(fake, "company/state/feedback.jsonl", before2);
  await page.waitForFunction(() => !document.getElementById("reject-dialog").open && document.querySelectorAll("#queue > li").length === 1, null, { timeout: 5000 });
  const rj = rejPut ? lastLine(rejPut.decoded) : null;
  const fb = fbPut ? lastLine(fbPut.decoded) : null;
  const rejectOk = rejPut && fbPut && fake.puts.indexOf(rejPut) < fake.puts.indexOf(fbPut) && rejPut.sha === approvalsSha2 && rejPut.message === `reject: ${KD} (rev 1)` && rj.count === 6 && rj.last.draftId === KD && rj.last.decision === "reject" && rj.last.revision === 1 && rj.last.by === "owner" && rj.last.reason === REASON && IST_ISO.test(rj.last.at) && fbPut.sha === feedbackSha && fbPut.message === `feedback: reject ${KD}` && fb.count === lastLine(FIX.feedback).count + 1 && fb.last.kind === "reject" && fb.last.page === "kaatdo" && fb.last.draftId === KD && fb.last.text === REASON && Array.isArray(fb.last.tags) && fb.last.tags.length === 0 && fb.last.by === "owner" && fb.last.at === rj.last.at && fake.puts.length === before2 + 2;
  const afterReject = await page.evaluate(cardsEval, "queue");
  await go(page, "blocked");
  const blockedAfter = await page.evaluate(cardsEval, "blocked");
  const kdBlocked = blockedAfter.cards.find((c) => c.id === KD);
  record("reject PUTs (approvals + feedback)", "queue", 1440, rejectOk && afterReject.cards.length === 1 && afterReject.cards[0].id === RP && afterReject.count === "1" && blockedAfter.cards.length === 3 && kdBlocked && kdBlocked.head.includes("rejected by owner") && kdBlocked.reasons === `Reasons: Owner: ${REASON}`, { approvals: rejPut && { status: rejPut.status, message: rejPut.message, last: rj.last }, feedback: fbPut && { status: fbPut.status, message: fbPut.message, last: fb.last }, queueAfter: afterReject.cards.map((c) => c.id), blockedAfter: blockedAfter.cards.map((c) => ({ id: c.id, head: c.head })) });
  await closeCtx(ctx, page, "queue");
}

// Edit caption (in-browser checks.js gating, edits/<id>.json with baseRevision) and Move slot (past rejected,
// future -> overrides.jsonl) on the kd draft, fresh fake.
async function editMove() {
  console.log("editMove: edit caption gating + PUT, move slot gating + PUT");
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK });
  await open(page, "#/");
  await waitView(page, "queue");
  const draft = FIX.draft(KD);
  const card = `#queue .queue-item[data-draft="${KD}"]`;
  const editState = () => page.evaluate(() => ({
    open: document.getElementById("edit-dialog").open,
    saveDisabled: document.getElementById("edit-save").disabled,
    chips: [...document.querySelectorAll("#edit-checks .chip")].map((c) => ({ text: c.textContent, ok: c.classList.contains("chip-ok"), bad: c.classList.contains("chip-bad") })),
    count: document.getElementById("edit-caption-count").textContent,
    altCount: document.getElementById("edit-alt-count").textContent,
    diff: [...document.querySelectorAll("#edit-diff span")].map((s) => ({ kind: s.className, line: s.textContent })),
    tags: [...document.querySelectorAll("#edit-tags .chip")].map((c) => c.textContent),
    text: document.getElementById("edit-text").textContent,
  }));
  await page.click(`${card} [data-slot="actions"] button:has-text("Edit caption")`);
  await page.waitForFunction(() => document.getElementById("edit-dialog").open && document.getElementById("edit-caption").value !== "" && document.querySelectorAll("#edit-checks .chip").length > 0, null, { timeout: 10000 });
  const e0 = await editState();
  await page.fill("#edit-caption", "x".repeat(2300));
  const e1 = await editState();
  const lengthChip = e1.chips.find((c) => /^caption length · /.test(c.text));
  record("edit gating (2,300 chars -> caption_length)", "edit", 1440, e0.saveDisabled && e0.chips.length === QA_IDS.length && e0.chips.every((c) => c.ok) && e0.tags.length === draft.hashtags.length && e0.text.includes(`baseRevision ${draft.revision}`) && e1.saveDisabled && lengthChip && lengthChip.bad && /^caption length · 23\d\d\/2200$/.test(lengthChip.text) && e1.count.startsWith("23") && e1.chips.length === QA_IDS.length, { unchanged: { saveDisabled: e0.saveDisabled, chips: e0.chips.length, allOk: e0.chips.every((c) => c.ok), count: e0.count }, long: { saveDisabled: e1.saveDisabled, count: e1.count, bad: e1.chips.filter((c) => c.bad).map((c) => c.text) } });
  // A valid edit: the committed caption back, a new alt text -> every check passes, the diff shows the alt line.
  const NEW_ALT = "Dark console card: six rules, one kill switch; footer kaatdo.com";
  await page.fill("#edit-caption", draft.caption);
  await page.fill("#edit-alt", NEW_ALT);
  const e2 = await editState();
  const before = fake.puts.length;
  await page.click("#edit-save");
  const put = await waitPut(fake, `company/state/edits/${KD}.json`, before);
  await page.waitForFunction((id) => !document.getElementById("edit-dialog").open && [...document.querySelectorAll(`#queue .queue-item[data-draft="${id}"] [data-slot="head"] .chip`)].some((c) => c.textContent === "edited (base rev 1)"), KD, { timeout: 5000 });
  let edit = null;
  try {
    edit = put && JSON.parse(put.decoded);
  } catch {
    edit = null;
  }
  const cardAfter = (await page.evaluate(cardsEval, "queue")).cards.find((c) => c.id === KD);
  record("edit PUT (edits/<id>.json with baseRevision)", "edit", 1440, !e2.saveDisabled && e2.chips.every((c) => c.ok) && e2.diff.some((d) => d.kind === "ins" && d.line === `+ alt: ${NEW_ALT}`) && e2.diff.some((d) => d.kind === "del" && d.line === `− alt: ${draft.altText}`) && put && put.status === 201 && put.sha === null && put.message === `edit: ${KD} (base rev ${draft.revision})` && edit && edit.draftId === KD && edit.baseRevision === draft.revision && edit.caption === draft.caption && JSON.stringify(edit.hashtags) === JSON.stringify(draft.hashtags) && edit.altText === NEW_ALT && edit.by === "owner" && IST_ISO.test(edit.at) && edit.checks && edit.checks.passed === true && edit.checks.checks.length === QA_IDS.length && put.decoded === `${JSON.stringify(edit, null, 2)}\n` && cardAfter && cardAfter.note.includes(`alt text: ${NEW_ALT}`) && fake.puts.length === before + 1, { put: put && { path: put.path, status: put.status, sha: put.sha, message: put.message }, edit: edit && { draftId: edit.draftId, baseRevision: edit.baseRevision, altText: edit.altText, hashtags: edit.hashtags, checksPassed: edit.checks && edit.checks.passed }, diffIns: e2.diff.filter((d) => d.kind !== "same") });

  // Move slot: past rejected with the message, far future accepted -> overrides.jsonl.
  await page.click(`${card} [data-slot="actions"] button:has-text("Move slot")`);
  await page.waitForFunction(() => document.getElementById("move-dialog").open, null, { timeout: 5000 });
  const moveState = () => page.evaluate(() => ({ value: document.getElementById("move-at").value, disabled: document.getElementById("move-go").disabled, error: document.getElementById("move-error").hidden ? null : document.getElementById("move-error").textContent, hint: document.getElementById("move-hint").textContent }));
  const m0 = await moveState();
  await page.fill("#move-at", "2020-01-01T10:00");
  const m1 = await moveState();
  await page.fill("#move-at", "2099-01-01T10:00");
  const m2 = await moveState();
  record("move gating (past rejected)", "edit", 1440, m0.value === "2026-10-13T08:15" && m0.hint.includes("at least 6 h") && m1.disabled && m1.error === "The new slot must be in the future" && !m2.disabled && m2.error === null, { m0, m1, m2 });
  const overridesSha = fake.files.get("company/state/overrides.jsonl").sha;
  const before2 = fake.puts.length;
  await page.click("#move-go");
  const mv = await waitPut(fake, "company/state/overrides.jsonl", before2);
  await page.waitForFunction((id) => !document.getElementById("move-dialog").open && [...document.querySelectorAll(`#queue .queue-item[data-draft="${id}"] [data-slot="head"] .chip`)].some((c) => /· moved$/.test(c.textContent)), KD, { timeout: 5000 });
  const o = mv ? lastLine(mv.decoded) : null;
  const moved = (await page.evaluate(cardsEval, "queue")).cards.find((c) => c.id === KD);
  record("move PUT (overrides.jsonl line)", "edit", 1440, mv && mv.status === 200 && mv.sha === overridesSha && mv.message === `override: ${KD} -> 2099-01-01T10:00:00+05:30` && o.count === lastLine(FIX.overrides).count + 1 && o.last.draftId === KD && o.last.slotAt === "2099-01-01T10:00:00+05:30" && o.last.by === "owner" && IST_ISO.test(o.last.at) && Object.keys(o.last).sort().join() === "at,by,draftId,slotAt" && moved && moved.head.some((h) => /^slot: \w{3} 1 Jan · 10:00 IST · moved$/.test(h)) && fake.puts.length === before2 + 1, { put: mv && { status: mv.status, message: mv.message, last: o.last }, slotChip: moved && moved.head.find((h) => h.startsWith("slot:")) });
  await closeCtx(ctx, page, "edit");
}

// Calendar: Monday-first grid with role=grid/row/gridcell, the fixture's four labelled slots in October 2026
// (blocked jr omitted), movable slots are 44 px buttons opening the move dialog; screenshot at 1440.
async function calendar() {
  console.log("calendar: grid, slots, move dialog, screenshot");
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK });
  await open(page, "#/calendar");
  await waitView(page, "calendar");
  // The grid opens on the current IST month; walk to October 2026 (the fixture's month) with the month buttons.
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  let hops = 0;
  for (; hops < 120; hops++) {
    const title = await page.textContent("#cal-title");
    const m = title.match(/Calendar · (\w+) (\d{4})$/);
    if (!m) break;
    const idx = (Number(m[2]) * 12 + MONTHS.indexOf(m[1])) - (2026 * 12 + 9);
    if (idx === 0) break;
    await page.click(idx > 0 ? "#cal-prev" : "#cal-next");
    await page.waitForTimeout(50);
  }
  const c = await page.evaluate(() => {
    const grid = document.getElementById("cal-grid");
    const slots = [...grid.querySelectorAll(".slot")].map((s) => ({ tag: s.tagName.toLowerCase(), page: s.dataset.page, text: s.textContent, height: Math.round(s.getBoundingClientRect().height), border: getComputedStyle(s).borderLeftColor, styleAttr: s.hasAttribute("style"), label: s.getAttribute("aria-label") }));
    return {
      title: document.getElementById("cal-title").textContent,
      role: grid.getAttribute("role"),
      rows: grid.querySelectorAll('[role="row"]').length,
      headers: [...grid.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent),
      cells: grid.querySelectorAll('[role="gridcell"]').length,
      cellsOutsideRow: [...grid.querySelectorAll('[role="gridcell"]')].filter((el) => !el.closest('[role="row"]')).length,
      slots,
    };
  });
  const r = await page.evaluate(layoutEval, LAYOUT_PARAMS);
  layoutRows("calendar", 1440, r);
  const expectSlots = [
    { page: "kaatdo", text: /^@kaatdo08:15 · image · published$/, tag: "span" },
    { page: "rishtapatra", text: /^@rishtapatra19:30 · image · published$/, tag: "span" },
    { page: "kaatdo", text: /^@kaatdo08:15 · image · scheduled$/, tag: "button" },
    { page: "rishtapatra", text: /^@rishtapatra19:30 · image · in review$/, tag: "button" },
  ];
  const slotsOk = c.slots.length === 4 && expectSlots.every((e) => c.slots.some((s) => s.page === e.page && e.text.test(s.text) && s.tag === e.tag)) && c.slots.every((s) => s.border === hexToRgb(brandColor(s.page)) && !s.styleAttr && (s.tag !== "button" || (s.height >= MIN_CONTROL_PX && /^Move (kd|rp)-/.test(s.label))));
  record("calendar grid (fixture slots, ARIA)", "calendar", 1440, c.title === "Calendar · October 2026" && c.role === "grid" && c.rows >= 5 && c.headers.join() === "Mon,Tue,Wed,Thu,Fri,Sat,Sun" && c.cells >= 28 && c.cellsOutsideRow === 0 && slotsOk, { title: c.title, hops, rows: c.rows, cells: c.cells, cellsOutsideRow: c.cellsOutsideRow, slots: c.slots });
  await page.click(`#cal-grid button.slot[aria-label^="Move ${KD}"]`);
  await page.waitForFunction(() => document.getElementById("move-dialog").open, null, { timeout: 5000 });
  const mt = await page.textContent("#move-text");
  await page.click("#move-cancel");
  await page.waitForFunction(() => !document.getElementById("move-dialog").open, null, { timeout: 5000 });
  record("calendar slot opens the move dialog", "calendar", 1440, mt.startsWith(`${KD} (@kaatdo) is at `) && fake.puts.length === 0, { moveText: mt });
  await shot(page, "calendar", { width: 1440, height: 900 });
  await closeCtx(ctx, page, "calendar");
}

// Modes: labels only (N1), 44 px segmented buttons (N11), Autopilot gated on the exact handle, config.json PUTs
// with the exact commit messages, plain confirm back to Approve first (dismiss -> no write).
async function modes() {
  console.log("modes: labels, gating, config.json PUTs, screenshot of the dialog");
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK });
  await open(page, "#/modes");
  await waitView(page, "modes");
  const r = await page.evaluate(layoutEval, LAYOUT_PARAMS);
  layoutRows("modes", 1440, r);
  const rows = await page.evaluate(() => [...document.querySelectorAll("#mode-rows .mode-row")].map((row) => ({ page: row.dataset.page, who: row.querySelector(".who").textContent, meta: row.querySelector(".meta").textContent, buttons: [...row.querySelectorAll(".seg button")].map((b) => ({ text: b.textContent, mode: b.dataset.mode, pressed: b.getAttribute("aria-pressed"), h: Math.round(b.getBoundingClientRect().height) })) })));
  record("modes labels only (N1)", "modes", 1440, r.modesText !== null && !/\bapprove_first\b/.test(r.modesText) && !/\bautopilot\b/.test(r.modesText) && r.modesText.includes("Approve first") && r.modesText.includes("Autopilot") && rows.length === 3 && rows.every((x) => x.buttons.map((b) => b.text).join("|") === "Approve first|Autopilot" && x.buttons[0].pressed === "true" && x.buttons[1].pressed === "false" && x.meta.includes("in queue") && x.meta.includes("not configured yet") && x.meta.includes("last change 1 Oct 2026 by owner")), { rows, tokens: (r.modesText || "").match(/\b(approve_first|autopilot)\b/g) });
  record("modes segmented buttons >= 44px (N11)", "modes", 1440, rows.every((x) => x.buttons.every((b) => b.h >= MIN_CONTROL_PX)), rows.map((x) => x.buttons.map((b) => b.h)));

  const dlg = () => page.evaluate(() => ({ open: document.getElementById("mode-dialog").open, disabled: document.getElementById("mode-go").disabled, heading: document.getElementById("mode-heading").textContent, placeholder: document.getElementById("mode-handle").placeholder, error: document.getElementById("mode-error").hidden ? null : document.getElementById("mode-error").textContent }));
  await page.click('#mode-rows .mode-row[data-page="kaatdo"] .seg button[data-mode="autopilot"]');
  await page.waitForFunction(() => document.getElementById("mode-dialog").open, null, { timeout: 5000 });
  const d0 = await dlg();
  await page.fill("#mode-handle", "@Kaatdo");
  const d1 = await dlg();
  await page.fill("#mode-handle", "@kaatdo");
  const d2 = await dlg();
  record("mode dialog gating (exact handle)", "modes", 1440, d0.open && d0.disabled && d0.heading === "Switch @kaatdo to Autopilot?" && d0.placeholder === "@kaatdo" && d1.disabled && !d2.disabled && fake.puts.length === 0, { d0, d1, d2 });
  const rd = await page.evaluate(layoutEval, LAYOUT_PARAMS);
  layoutRows("modes-dialog", 1440, rd);
  await shot(page, "modes-dialog", { width: 1440, height: 900 });
  const configSha = fake.files.get("company/config.json").sha;
  await page.click("#mode-go");
  const put = await waitPut(fake, "company/config.json", 0);
  await page.waitForFunction(() => !document.getElementById("mode-dialog").open && document.querySelector('#mode-rows .mode-row[data-page="kaatdo"] .seg button[data-mode="autopilot"]').getAttribute("aria-pressed") === "true", null, { timeout: 5000 });
  let cfg = null;
  try {
    cfg = put && JSON.parse(put.decoded);
  } catch {
    cfg = null;
  }
  const kd = cfg && cfg.pages.find((p) => p.handle === "kaatdo");
  const others = cfg && cfg.pages.filter((p) => p.handle !== "kaatdo").map((p) => p.mode);
  record("mode PUT autopilot (config.json)", "modes", 1440, put && put.status === 200 && put.sha === configSha && put.message === "config: @kaatdo -> autopilot" && kd && kd.mode === "autopilot" && kd.modeChangedBy === "owner" && IST_ISO.test(kd.modeChangedAt) && others.join() === "approve_first,approve_first" && put.decoded === `${JSON.stringify(cfg, null, 2)}\n` && cfg.pages.length === 3 && fake.puts.length === 1, { put: put && { status: put.status, message: put.message, shaIsOld: put.sha === configSha }, kaatdo: kd && { mode: kd.mode, modeChangedAt: kd.modeChangedAt, modeChangedBy: kd.modeChangedBy }, others });
  // Back to Approve first: a native confirm(). Dismissed -> nothing written; accepted -> one PUT.
  ctx.meta.dialog = "dismiss";
  await page.click('#mode-rows .mode-row[data-page="kaatdo"] .seg button[data-mode="approve_first"]');
  await page.waitForTimeout(600);
  const dismissed = { dialogs: ctx.meta.dialogs.length, puts: fake.puts.length, pressed: await page.getAttribute('#mode-rows .mode-row[data-page="kaatdo"] .seg button[data-mode="autopilot"]', "aria-pressed") };
  record("mode confirm dismissed -> no write", "modes", 1440, dismissed.dialogs === 1 && dismissed.puts === 1 && dismissed.pressed === "true" && ctx.meta.dialogs[0].startsWith(MODE_CONSEQUENCES.approve_first.join(" ")) && ctx.meta.dialogs[0].endsWith("Switch @kaatdo to Approve first?"), { ...dismissed, confirmText: ctx.meta.dialogs[0] });
  ctx.meta.dialog = "accept";
  const newSha = fake.files.get("company/config.json").sha;
  await page.click('#mode-rows .mode-row[data-page="kaatdo"] .seg button[data-mode="approve_first"]');
  const put2 = await waitPut(fake, "company/config.json", 1);
  await page.waitForFunction(() => document.querySelector('#mode-rows .mode-row[data-page="kaatdo"] .seg button[data-mode="approve_first"]').getAttribute("aria-pressed") === "true", null, { timeout: 5000 });
  let cfg2 = null;
  try {
    cfg2 = put2 && JSON.parse(put2.decoded);
  } catch {
    cfg2 = null;
  }
  const kd2 = cfg2 && cfg2.pages.find((p) => p.handle === "kaatdo");
  record("mode PUT approve first (config.json)", "modes", 1440, put2 && put2.status === 200 && put2.sha === newSha && put2.message === "config: @kaatdo -> approve_first" && kd2 && kd2.mode === "approve_first" && kd2.modeChangedBy === "owner" && IST_ISO.test(kd2.modeChangedAt) && ctx.meta.dialogs.length === 2 && fake.puts.length === 2, { put: put2 && { status: put2.status, message: put2.message, shaIsPrevious: put2.sha === newSha }, kaatdo: kd2 && { mode: kd2.mode, modeChangedBy: kd2.modeChangedBy } });
  await closeCtx(ctx, page, "modes");
}

// Run now: workflow_dispatch POST bodies asserted, the run strip follows the fake run (queued -> running ->
// succeeded) with Playwright's clock driving the 10 s poll; 'Run analyst' dispatches engine-daily.yml with
// inputs.agents = analyst (FEAT-203).
async function runNow() {
  console.log("runNow: dispatch POSTs + run strip (fake clock)");
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK });
  await open(page, "#/run");
  await waitView(page, "run");
  const r = await page.evaluate(layoutEval, LAYOUT_PARAMS);
  layoutRows("run", 1440, r);
  const strip = () => page.evaluate(() => ({ status: document.getElementById("run-status").textContent, linkHidden: document.getElementById("run-link").hidden, linkHref: document.getElementById("run-link").href, engineDisabled: document.getElementById("run-engine").disabled, publisherDisabled: document.getElementById("run-publisher").disabled, analyst: { disabled: document.getElementById("run-analyst").disabled, ariaDisabled: document.getElementById("run-analyst").getAttribute("aria-disabled"), text: document.getElementById("run-analyst").textContent } }));
  const s0 = await strip();
  record("run analyst button enabled (FEAT-203)", "run", 1440, !s0.analyst.disabled && s0.analyst.ariaDisabled === null && s0.analyst.text === "Run analyst" && s0.status === "" && s0.linkHidden, s0);
  const waitStatus = (text) => page.waitForFunction((t) => document.getElementById("run-status").textContent === t, text, { timeout: 8000, polling: 100 });
  await page.click("#run-engine");
  for (let i = 0; i < 100 && fake.dispatches.length === 0; i++) await sleep(50);
  const d = fake.dispatches[0];
  const seq = [];
  await waitStatus("engine-daily.yml: queued").catch(() => {});
  seq.push((await strip()).status);
  await page.clock.runFor(POLL_MS + 500);
  await waitStatus("engine-daily.yml: running").catch(() => {});
  seq.push((await strip()).status);
  await page.clock.runFor(POLL_MS + 500);
  await waitStatus("engine-daily.yml: succeeded").catch(() => {});
  const s1 = await strip();
  seq.push(s1.status);
  const run = fake.runs[0];
  record("run dispatch POST (engine-daily.yml)", "run", 1440, d && d.file === WORKFLOWS.engine && d.method === "POST" && d.url === `${API}${REPO_PATH}/actions/workflows/${WORKFLOWS.engine}/dispatches` && d.hasAuthorization && JSON.stringify(d.body) === JSON.stringify({ ref: BRANCH, inputs: { dry_run: "false" } }) && fake.dispatches.length === 1, d || "no dispatch recorded");
  record("run strip follows the fake run", "run", 1440, seq.join(" -> ") === "engine-daily.yml: queued -> engine-daily.yml: running -> engine-daily.yml: succeeded" && !s1.linkHidden && run && s1.linkHref === run.html_url && !s1.engineDisabled, { seq, link: s1.linkHref, runUrl: run && run.html_url, clock: "page.clock.runFor" });
  await page.click("#run-publisher");
  for (let i = 0; i < 100 && fake.dispatches.length < 2; i++) await sleep(50);
  const p = fake.dispatches[1];
  await waitStatus("publisher-hourly.yml: queued").catch(() => {});
  const s2 = await strip();
  record("run dispatch POST (publisher-hourly.yml)", "run", 1440, p && p.file === WORKFLOWS.publisher && p.url.endsWith(`/actions/workflows/${WORKFLOWS.publisher}/dispatches`) && JSON.stringify(p.body) === JSON.stringify({ ref: BRANCH, inputs: { dry_run: "false" } }) && s2.status === "publisher-hourly.yml: queued", { dispatch: p, status: s2.status });
  // Run analyst: the same engine workflow with inputs.agents = analyst (and dry_run false); the strip names the input.
  await page.click("#run-analyst");
  for (let i = 0; i < 100 && fake.dispatches.length < 3; i++) await sleep(50);
  const a = fake.dispatches[2];
  await waitStatus("engine-daily.yml (agents=analyst): queued").catch(() => {});
  const s3 = await strip();
  record("run analyst dispatch POST (engine-daily.yml agents=analyst)", "run", 1440, a && a.file === WORKFLOWS.engine && a.method === "POST" && a.url === `${API}${REPO_PATH}/actions/workflows/${WORKFLOWS.engine}/dispatches` && a.hasAuthorization && JSON.stringify(a.body) === JSON.stringify({ ref: BRANCH, inputs: { agents: "analyst", dry_run: "false" } }) && fake.dispatches.length === 3 && s3.status === "engine-daily.yml (agents=analyst): queued" && s3.analyst.disabled, { dispatch: a || "no dispatch recorded", status: s3.status, analystDisabledWhileRunning: s3.analyst.disabled });
  await closeCtx(ctx, page, "run");
}

// Brand editor (facts table, Confirm on the disputed rp-f12 row -> brand PUT), charter and roster gating, Tell the
// CEO (feedback.jsonl with one simulated 409 -> reload + retry once), Activity from status.json only (M9), JSON view.
async function editors() {
  console.log("editors: brand confirm, charter, roster, tell the CEO, activity, json");
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK });
  await open(page, "#/brand/rishtapatra");
  await waitView(page, "brand");
  const brandState = () => page.evaluate(() => ({
    heading: document.getElementById("brand-heading").textContent,
    path: document.getElementById("brand-path").textContent,
    valid: document.getElementById("brand-errors").classList.contains("valid"),
    errors: [...document.querySelectorAll("#brand-errors li")].map((li) => li.textContent),
    saveDisabled: document.getElementById("brand-save").disabled,
    state: document.getElementById("brand-state").textContent,
    rows: [...document.querySelectorAll("#brand-facts tbody tr")].map((tr) => ({ id: tr.children[0].textContent, status: tr.children[3].textContent, disputed: tr.classList.contains("disputed"), bad: tr.classList.contains("bad"), confirm: Boolean(tr.querySelector("button")) })),
    textLength: document.getElementById("brand-text").value.length,
    pressed: [...document.querySelectorAll("[data-brand-link]")].map((a) => `${a.dataset.brandLink}:${a.getAttribute("aria-pressed")}`),
  }));
  const b0 = await brandState();
  const disputed = b0.rows.filter((x) => x.disputed);
  record("brand facts table", "brand", 1440, b0.heading === "Brand charter · @rishtapatra" && b0.path === "company/brands/rishtapatra.md" && b0.valid && b0.errors.join() === "valid" && b0.saveDisabled && b0.rows.length === 12 && disputed.length === 1 && disputed[0].id === "rp-f12" && disputed[0].status === "disputed" && disputed[0].confirm && b0.rows.filter((x) => x.confirm).length === 1 && b0.rows.every((x) => !x.bad) && b0.textLength > 0 && /^\d+ B · sha [0-9a-f]{7}$/.test(b0.state) && b0.pressed.join() === "rishtapatra:true,kaatdo:false,job_rez:false", { rows: b0.rows.map((x) => `${x.id}:${x.status}`), disputed, state: b0.state, pressed: b0.pressed });
  const brandSha = fake.files.get("company/brands/rishtapatra.md").sha;
  await page.click("#brand-facts tbody tr.disputed button:has-text(\"Confirm\")");
  const put = await waitPut(fake, "company/brands/rishtapatra.md", 0);
  await page.waitForFunction(() => document.querySelectorAll("#brand-facts tbody tr.disputed").length === 0 && document.querySelectorAll("#brand-facts tbody tr").length === 12, null, { timeout: 5000 });
  const b1 = await brandState();
  const oldLines = FIX.brandRp.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const newLines = put ? put.decoded.trimEnd().split("\n") : [];
  const changed = newLines.map((l, i) => (l !== oldLines[i] ? i : -1)).filter((i) => i >= 0);
  const row = changed.length === 1 ? newLines[changed[0]] : "";
  record("brand confirm PUT (rp-f12 -> confirmed)", "brand", 1440, put && put.status === 200 && put.sha === brandSha && put.message === "brand: rishtapatra confirm rp-f12" && newLines.length === oldLines.length && changed.length === 1 && /^\| rp-f12 \|/.test(row) && /\| confirmed \|$/.test(row) && !row.includes("disputed") && oldLines[changed[0]].endsWith("| disputed |") && put.decoded.endsWith("\n") && b1.valid && b1.rows.find((x) => x.id === "rp-f12").status === "confirmed" && b1.rows.every((x) => !x.confirm) && b1.saveDisabled && fake.puts.length === 1, { put: put && { status: put.status, message: put.message, shaIsOld: put.sha === brandSha }, changedLines: changed, row: row.slice(0, 120), after: b1.rows.find((x) => x.id === "rp-f12") });

  // Charter editor: a changed body enables Save; removing '## Output' disables it with the heading error.
  await go(page, "charter");
  const charterState = () => page.evaluate(() => ({ heading: document.getElementById("charter-heading").textContent, path: document.getElementById("charter-path").textContent, valid: document.getElementById("charter-errors").classList.contains("valid"), errors: [...document.querySelectorAll("#charter-errors li")].map((li) => li.textContent), saveDisabled: document.getElementById("charter-save").disabled, length: document.getElementById("charter-text").value.length }));
  const c0 = await charterState();
  const charterText = (await page.inputValue("#charter-text")).replace(/\r\n/g, "\n");
  await page.fill("#charter-text", `${charterText.trimEnd()}\nOne more line.\n`);
  const c1 = await charterState();
  await page.fill("#charter-text", charterText.replace(/^## Output\s*$/m, "## Outcome"));
  const c2 = await charterState();
  await page.fill("#charter-text", charterText);
  const c3 = await charterState();
  record("charter gating (## Output required)", "charter", 1440, c0.heading === "Agent charter · qa" && c0.path === "company/charters/qa.md" && c0.valid && c0.saveDisabled && charterText.includes("\n## Output\n") && c1.valid && !c1.saveDisabled && !c2.valid && c2.saveDisabled && c2.errors.includes("heading '## Output' missing") && c3.valid && c3.saveDisabled && fake.puts.length === 1, { c0, c1: { valid: c1.valid, saveDisabled: c1.saveDisabled }, c2: { valid: c2.valid, saveDisabled: c2.saveDisabled, errors: c2.errors }, c3: { valid: c3.valid, saveDisabled: c3.saveDisabled } });

  // Roster editor: removing qa (schema ROSTER_SPEC invariants) disables Save with an error.
  await go(page, "roster");
  const rosterState = () => page.evaluate(() => ({ valid: document.getElementById("roster-errors").classList.contains("valid"), errors: [...document.querySelectorAll("#roster-errors li")].map((li) => li.textContent), saveDisabled: document.getElementById("roster-save").disabled }));
  const r0 = await rosterState();
  const roster = JSON.parse(await page.inputValue("#roster-text"));
  const withoutQa = { ...roster, agents: roster.agents.filter((a) => a.name !== "qa") };
  await page.fill("#roster-text", `${JSON.stringify(withoutQa, null, 2)}\n`);
  const r1 = await rosterState();
  await page.fill("#roster-text", "{ not json");
  const r2 = await rosterState();
  record("roster gating (qa cannot be removed)", "roster", 1440, r0.valid && r0.saveDisabled && roster.agents.length === 8 && withoutQa.agents.length === 7 && !r1.valid && r1.saveDisabled && r1.errors.length > 0 && !r2.valid && r2.saveDisabled && r2.errors.some((e) => e.startsWith("JSON: ")) && fake.puts.length === 1, { r0, withoutQa: { valid: r1.valid, saveDisabled: r1.saveDisabled, errors: r1.errors }, notJson: { valid: r2.valid, saveDisabled: r2.saveDisabled, errors: r2.errors } });

  // Tell the CEO: 3-1000 code points, feedback.jsonl line kind 'note'; the fake answers the first PUT with 409 so
  // the admin reloads the file and retries exactly once (state.js), and the second PUT lands.
  await go(page, "tell-ceo");
  const noteState = () => page.evaluate(() => ({ saveDisabled: document.getElementById("note-save").disabled, count: document.getElementById("note-count").textContent, state: document.getElementById("note-state").textContent, value: document.getElementById("note-text").value }));
  const n0 = await noteState();
  await page.fill("#note-text", "hi");
  const n1 = await noteState();
  const NOTE = "Plan one carousel a week for @job_rez; the single images are not landing.";
  await page.fill("#note-text", NOTE);
  const n2 = await noteState();
  record("note gating (3-1000 chars)", "tell-ceo", 1440, n0.saveDisabled && n0.count === "0 / 1000" && n1.saveDisabled && n1.count === "2 / 1000" && !n2.saveDisabled && n2.count === `${NOTE.length} / 1000`, { n0, n1, n2 });
  fake.conflictOnce.add("company/state/feedback.jsonl");
  const feedbackSha = fake.files.get("company/state/feedback.jsonl").sha;
  const before = fake.puts.length;
  const reqBefore = ctx.meta.requests.length;
  await page.click("#note-save");
  const fbPut = await waitPut(fake, "company/state/feedback.jsonl", before);
  await page.waitForFunction(() => /^sent · commit [0-9a-f]{7}$/.test(document.getElementById("note-state").textContent), null, { timeout: 5000 });
  const n3 = await noteState();
  const fbPuts = fake.puts.slice(before).filter((p) => p.path === "company/state/feedback.jsonl");
  const fbReqs = ctx.meta.requests.slice(reqBefore).filter((r) => r.url.includes("company/state/feedback.jsonl") && r.method !== "OPTIONS").map((r) => r.method);
  const fb = fbPut ? lastLine(fbPut.decoded) : null;
  record("note PUT (feedback.jsonl, 409 retried once)", "tell-ceo", 1440, fbPut && fbPuts.length === 2 && fbPuts[0].status === 409 && fbPuts[1].status === 200 && fbReqs.join() === "GET,PUT,GET,PUT" && fbPut.sha === feedbackSha && fbPut.message === "feedback: note" && fb.count === lastLine(FIX.feedback).count + 1 && fb.last.kind === "note" && fb.last.by === "owner" && fb.last.text === NOTE && Array.isArray(fb.last.tags) && fb.last.tags.length === 0 && !("page" in fb.last) && IST_ISO.test(fb.last.at) && n3.value === "" && n3.saveDisabled && fake.conflictOnce.size === 0, { puts: fbPuts.map((p) => p.status), requests: fbReqs, message: fbPut && fbPut.message, last: fb && fb.last, state: n3.state });

  // Activity: status.json.lastRuns rendered (3 fixture runs); the M9 "no state/runs/ request" row comes from closeCtx.
  await go(page, "activity");
  const act = await page.evaluate(() => ({
    runs: [...document.querySelectorAll("#last-runs > li")].map((li) => ({ time: li.querySelector("time").getAttribute("datetime"), text: li.querySelector(".runline").textContent, failed: li.classList.contains("failed"), agents: li.querySelectorAll(".runline ul li").length })),
    emptyHidden: document.getElementById("runs-empty").hidden,
    session: [...document.querySelectorAll("#activity-list li")].map((li) => li.textContent),
  }));
  const runs = FIX.status.lastRuns;
  record("activity lastRuns (status.json only)", "activity", 1440, act.runs.length === runs.length && act.runs.every((x, i) => x.time === runs[i].endedAt && x.text.includes(runs[i].workflow) && x.text.includes(runs[i].ok ? " · ok · " : " · FAILED · ") && x.text.includes(` · ${runs[i].trigger} · `) && x.text.includes(runs[i].id) && x.agents === runs[i].agents.length && !x.failed) && act.runs[0].text.includes("4 files changed · USD 0.05 used after this run") && act.emptyHidden && act.session.length >= 2 && act.session.some((l) => /^\d\d:\d\d:\d\dnote to the CEO \([0-9a-f]{7}\)$/.test(l)) && !ctx.meta.requests.some((r) => r.url.includes("state/runs/")), { runs: act.runs.map((x) => ({ time: x.time, agents: x.agents, text: x.text.slice(0, 90) })), session: act.session.slice(0, 4), runsRequests: ctx.meta.requests.filter((r) => r.url.includes("state/runs/")).length });

  // JSON view: config.json pretty-printed with its byte count and sha (the one place a config token appears).
  await go(page, "json");
  const j = await page.evaluate(() => ({ path: document.getElementById("json-path").value, meta: document.getElementById("json-meta").textContent, out: document.getElementById("json-out").textContent }));
  let parsed = null;
  try {
    parsed = JSON.parse(j.out);
  } catch {
    parsed = null;
  }
  const configFile = fake.files.get("company/config.json");
  record("json view (config.json)", "json", 1440, j.path === "config.json" && parsed && parsed.pages.length === 3 && parsed.pages[1].mode === "approve_first" && j.meta === `company/config.json · ${configFile.content.length} B · sha ${configFile.sha.slice(0, 7)}` && j.out === JSON.stringify(parsed, null, 2), { meta: j.meta, chars: j.out.length });
  await closeCtx(ctx, page, "editors");
}

// HR proposals in the Roster view (FEAT-204; P2-06; review N14 / plan D13): the fixture's 2026-09 proposal renders with status
// `proposed` and its one change as 'agent · field: from → to — why'; Apply PUTs roster.json (writer temperature 0.7, valid
// against ROSTER_SPEC + the fixture config, message 'roster: apply hr proposal 2026-09') and then ONE line into
// hr/decisions.jsonl (created: no sha; decision apply, by owner, IST stamp) — and never hr/proposals/2026-09.json; the card
// turns `applied` and the roster editor reloads the applied roster. In a fresh context Dismiss PUTs hr/decisions.jsonl only.
async function proposals() {
  console.log("proposals: render, apply (roster + decisions, never the proposal file), dismiss (decisions only)");
  const fixtureProposal = JSON.parse(readFix("state", "hr", "proposals", "2026-09.json"));
  const PROPOSAL_PATH = "company/state/hr/proposals/2026-09.json";
  const DECISIONS_PATH = "company/state/hr/decisions.jsonl";
  const propState = (page) => page.evaluate(() => ({
    items: [...document.querySelectorAll("#proposal-list > li")].map((li) => ({
      month: li.dataset.month,
      status: li.dataset.status,
      chips: [...li.querySelectorAll(".q-head .chip")].map((c) => c.textContent),
      changes: [...li.querySelectorAll(".changes li")].map((c) => c.textContent),
      buttons: [...li.querySelectorAll("button")].map((b) => `${b.textContent}${b.disabled ? " (disabled)" : ""}`),
      links: [...li.querySelectorAll("a")].map((a) => a.getAttribute("href")),
      state: li.querySelector('[data-slot="state"]').textContent,
    })),
    emptyHidden: document.getElementById("proposals-empty").hidden,
    error: document.getElementById("proposals-error").textContent,
    busy: document.getElementById("proposal-list").getAttribute("aria-busy"),
  }));
  const { ctx, page, fake } = await newCtx({ width: 1440, height: 900, token: TOKEN_OK });
  await open(page, "#/roster");
  await waitView(page, "roster");
  const p0 = await propState(page);
  const expectedChange = `writer · temperature: 0.8 → 0.7 — ${fixtureProposal.changes[0].why}`;
  record("proposal renders (2026-09 proposed, one change, Apply + Dismiss)", "roster", 1440, p0.items.length === 1 && p0.items[0].month === "2026-09" && p0.items[0].status === "proposed" && p0.items[0].chips.includes("proposed") && p0.items[0].chips.includes("8 agents reviewed") && p0.items[0].chips.includes("1 change") && p0.items[0].changes.length === 1 && p0.items[0].changes[0] === expectedChange && p0.items[0].buttons.join() === "Apply,Dismiss" && p0.items[0].links.includes("#/json/state/hr/2026-09-review.md") && p0.emptyHidden && p0.error === "" && p0.busy === "false" && !ctx.meta.requests.some((r) => r.method === "PUT"), p0);
  const rosterSha = fake.files.get("company/roster.json").sha;
  const proposalSha = fake.files.get(PROPOSAL_PATH).sha;
  await page.click('#proposal-list li[data-month="2026-09"] button:has-text("Apply")');
  const rosterPut = await waitPut(fake, "company/roster.json", 0);
  const decisionPut = await waitPut(fake, DECISIONS_PATH, 0);
  await page.waitForFunction(() => {
    const li = document.querySelector('#proposal-list li[data-month="2026-09"]');
    return li && li.dataset.status === "applied" && document.getElementById("proposal-list").getAttribute("aria-busy") === "false";
  }, null, { timeout: 8000 });
  const p1 = await propState(page);
  const newRoster = rosterPut ? JSON.parse(rosterPut.decoded) : null;
  const writer = newRoster && newRoster.agents.find((a) => a.name === "writer");
  const rosterValid = newRoster ? validate(newRoster, ROSTER_SPEC, FIX.config) : { ok: false, errors: ["no roster PUT"] };
  const dec = decisionPut ? lastLine(decisionPut.decoded) : null;
  const decValid = dec ? validate(dec.last, HR_DECISION_SPEC) : { ok: false, errors: ["no decisions PUT"] };
  const proposalPuts = fake.puts.filter((p) => p.path.startsWith("company/state/hr/proposals/"));
  const order = fake.puts.map((p) => p.path);
  record("apply PUTs roster.json (writer 0.8 → 0.7, ROSTER_SPEC-valid) then hr/decisions.jsonl (apply, by owner); never the proposal file", "roster", 1440,
    rosterPut && rosterPut.status === 200 && rosterPut.sha === rosterSha && rosterPut.message === "roster: apply hr proposal 2026-09" && writer && writer.temperature === 0.7 && newRoster.agents.length === 8 && rosterValid.ok && newRoster.agents.filter((a) => a.name !== "writer").every((a, i) => JSON.stringify(a) === JSON.stringify(JSON.parse(FIX.roster).agents.filter((x) => x.name !== "writer")[i])) &&
      decisionPut && decisionPut.status === 201 && decisionPut.sha === null && decisionPut.message === "hr: apply proposal 2026-09" && dec.count === 1 && decValid.ok && dec.last.month === "2026-09" && dec.last.proposal === "hr/proposals/2026-09.json" && dec.last.decision === "apply" && dec.last.by === "owner" && IST_ISO.test(dec.last.at) && JSON.stringify(dec.last.applied) === JSON.stringify(["roster.json"]) &&
      proposalPuts.length === 0 && fake.files.get(PROPOSAL_PATH).sha === proposalSha && JSON.stringify(order) === JSON.stringify(["company/roster.json", DECISIONS_PATH]) &&
      p1.items.length === 1 && p1.items[0].status === "applied" && p1.items[0].chips.includes("applied") && p1.items[0].buttons.length === 0 && p1.error === "",
    { rosterPut: rosterPut && { status: rosterPut.status, message: rosterPut.message, shaIsOld: rosterPut.sha === rosterSha, writerTemperature: writer && writer.temperature, valid: rosterValid.errors }, decisionPut: decisionPut && { status: decisionPut.status, sha: decisionPut.sha, message: decisionPut.message, line: dec && dec.last, valid: decValid.errors }, proposalPuts: proposalPuts.length, order, after: p1.items[0] });
  const editorRoster = JSON.parse(await page.inputValue("#roster-text"));
  const rosterState = await page.evaluate(() => ({ state: document.getElementById("roster-state").textContent, valid: document.getElementById("roster-errors").classList.contains("valid"), saveDisabled: document.getElementById("roster-save").disabled }));
  record("roster editor reloaded the applied roster", "roster", 1440, editorRoster.agents.find((a) => a.name === "writer").temperature === 0.7 && rosterState.valid && rosterState.saveDisabled && /^\d+ B · sha [0-9a-f]{7}$/.test(rosterState.state), { writerTemperature: editorRoster.agents.find((a) => a.name === "writer").temperature, ...rosterState });
  const activity = await page.evaluate(() => [...document.querySelectorAll("#activity-list li")].map((li) => li.textContent));
  record("apply logged in the session log", "roster", 1440, activity.some((l) => /^\d\d:\d\d:\d\dhr: applied proposal 2026-09 → roster\.json \([0-9a-f]{7}\)$/.test(l)), activity.slice(0, 4));
  await closeCtx(ctx, page, "proposals-apply");

  // Dismiss, in a fresh fake repository: the decisions log is the only file written.
  const d = await newCtx({ width: 390, height: 844, token: TOKEN_OK });
  await open(d.page, "#/roster");
  await waitView(d.page, "roster");
  const q0 = await propState(d.page);
  await d.page.click('#proposal-list li[data-month="2026-09"] button:has-text("Dismiss")');
  const dismissPut = await waitPut(d.fake, DECISIONS_PATH, 0);
  await d.page.waitForFunction(() => {
    const li = document.querySelector('#proposal-list li[data-month="2026-09"]');
    return li && li.dataset.status === "dismissed" && document.getElementById("proposal-list").getAttribute("aria-busy") === "false";
  }, null, { timeout: 8000 });
  const q1 = await propState(d.page);
  const dd = dismissPut ? lastLine(dismissPut.decoded) : null;
  record("dismiss PUTs hr/decisions.jsonl only (no roster, no proposal file)", "roster", 390,
    q0.items[0].status === "proposed" && dismissPut && dismissPut.status === 201 && dismissPut.message === "hr: dismiss proposal 2026-09" && dd.count === 1 && validate(dd.last, HR_DECISION_SPEC).ok && dd.last.decision === "dismiss" && dd.last.month === "2026-09" && dd.last.by === "owner" && !("applied" in dd.last) && d.fake.puts.length === 1 && JSON.parse(d.fake.files.get("company/roster.json").content.toString("utf8")).agents.find((a) => a.name === "writer").temperature === 0.8 && d.fake.files.get(PROPOSAL_PATH).sha === proposalSha && q1.items[0].status === "dismissed" && q1.items[0].buttons.length === 0,
    { puts: d.fake.puts.map((p) => ({ path: p.path, status: p.status, message: p.message })), line: dd && dd.last, after: q1.items[0] });
  const r = await d.page.evaluate(layoutEval, LAYOUT_PARAMS);
  layoutRows("roster-proposals", 390, r);
  await closeCtx(d.ctx, d.page, "proposals-dismiss");
}

// Layout matrix of the unlocked admin: every view at 390 and 1440 (overflow, M12 inner scrollers, 12 px floor,
// N11 controls, gradient/shadow scan, [style] count); the tabs wrap into rows at 390; queue screenshots.
async function layout() {
  console.log("layout: 11 views x 390/1440");
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { ctx, page } = await newCtx({ ...vp, token: TOKEN_OK });
    await open(page, "#/");
    await waitView(page, "queue");
    for (const view of VIEWS) {
      if (view !== "queue") await go(page, view);
      await page.waitForTimeout(150);
      const r = await page.evaluate(layoutEval, LAYOUT_PARAMS);
      layoutRows(`admin-${view}`, vp.width, r);
      if (view === "queue") {
        record("tabs wrap (M12)", `admin-${view}`, vp.width, r.tabs === 11 && (vp.width >= 1440 ? r.tabRows === 1 : r.tabRows >= 2), { tabs: r.tabs, rows: r.tabRows });
        record("lightForced (os dark)", `admin-${view}`, vp.width, r.bodyBg === LIGHT_BG && r.prefersDark === true, { bodyBg: r.bodyBg, prefersDark: r.prefersDark });
        await page.evaluate(() => scrollTo(0, 0));
        await shot(page, "queue", vp);
      }
      if (view === "calendar") record("aria grid (gridcells inside rows)", `admin-${view}`, vp.width, r.gridcells > 0 && r.cellsOutsideRow === 0, { gridcells: r.gridcells, cellsOutsideRow: r.cellsOutsideRow });
      if (view === "modes") record("modes labels only (N1)", `admin-${view}`, vp.width, r.modesText !== null && !/\b(approve_first|autopilot)\b/.test(r.modesText), { tokens: (r.modesText || "").match(/\b(approve_first|autopilot)\b/g) });
      console.log(`  ${view.padEnd(9)} ${String(vp.width).padEnd(5)} overflow=${r.scrollWidth - r.clientWidth} innerScroll=${r.innerScroll.length} minFont=${r.minFont.px} smallControls=${r.smallControls.length} shadows=${r.shadows.length} styles=${r.styleAttrs}`);
    }
    await closeCtx(ctx, page, "layout");
  }
}

/* ---------- main ---------- */
const started = Date.now();
const server = await startServer();
BASE = server.origin + config.basePath;
ADMIN = BASE + "admin/";
const adminStatus = await status(ADMIN);
if (adminStatus !== 200) {
  if (server.child) server.child.kill();
  console.error(`${ADMIN} answered HTTP ${adminStatus} — build the site first (npm run build)`);
  process.exit(1);
}
console.log(`Auditing ${ADMIN} (${process.env.AUDIT_URL ? "AUDIT_URL" : DIST}) -> ${OUT}\nGitHub + raw host mocked from ${relative(ROOT, FIXTURE)}; the real GitHub path is UNTESTED here`);
browser = await chromium.launch({ headless: true });
const STEPS = { lock, queue, editMove, calendar, modes, runNow, editors, proposals, layout };
const only = process.argv.slice(2);
try {
  for (const [name, fn] of Object.entries(STEPS)) {
    if (only.length && !only.includes(name)) continue;
    const t0 = Date.now();
    let timer;
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out after 300 s")), 300000); })])
      .catch((err) => record("ERROR " + name, "-", 0, false, String((err && err.stack) || err)))
      .finally(() => clearTimeout(timer));
    console.log(`  ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
} finally {
  await browser.close();
  if (server.child) server.child.kill();
}

const perCheck = new Map();
for (const r of results) {
  const s = perCheck.get(r.check) || { check: r.check, rows: 0, failed: 0 };
  s.rows++;
  if (!r.ok) s.failed++;
  perCheck.set(r.check, s);
}
const failed = results.filter((r) => !r.ok).length;
const allRequests = requestLog.flatMap((s) => s.requests);
const byHost = {};
for (const r of allRequests) byHost[new URL(r.url).host] = (byHost[new URL(r.url).host] || 0) + 1;
const report = {
  base: ADMIN,
  dist: process.env.AUDIT_URL ? null : DIST,
  date: new Date().toISOString(),
  seconds: Math.round((Date.now() - started) / 100) / 10,
  note: "api.github.com and raw.githubusercontent.com fully mocked from tests/fixtures (fake tokens ghp_FAKE_*); the real GitHub path is UNTESTED (no token exists).",
  fixture: relative(ROOT, FIXTURE),
  rows: results.length,
  failed,
  perCheck: [...perCheck.values()],
  requests: { total: allRequests.length, withAuthorization: allRequests.filter((r) => r.hasAuthorization).length, authorizationOffApi: allRequests.filter((r) => r.hasAuthorization && !r.url.startsWith(API + "/")).length, byHost },
  results,
  requestLog,
};
writeFileSync(join(OUT, "audit-admin-results.json"), JSON.stringify(report, null, 2));

console.log("\n" + "check".padEnd(44) + "rows".padStart(6) + "failed".padStart(8));
for (const s of perCheck.values()) console.log(s.check.padEnd(44) + String(s.rows).padStart(6) + String(s.failed).padStart(8));
console.log(`\nrequests: ${allRequests.length} (${report.requests.withAuthorization} with Authorization, ${report.requests.authorizationOffApi} of them off api.github.com) ${JSON.stringify(byHost)}`);
console.log(`\n${results.length} rows, ${failed} failed -> ${join(OUT, "audit-admin-results.json")}`);
process.exit(failed ? 1 : 0);
