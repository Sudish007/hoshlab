// Hoshlab site build (ai-batkahi pattern, design §14, review M2/M9/M11/N9/N18/N22, plan D12/D14/D15):
// company/* + the media worktree → dist/. Run with `npm run build` (real company/) or by scripts/test.mjs
// with COMPANY_DIR/MEDIA_DIR/DIST_DIR pointing at fixtures. Every state file is validated against its
// schema before anything is printed; the public-surface rules (OF-1/OF-2/OF-5) and the size budgets are
// enforced as build FAILURES with named errors, so the real build that pages.yml deploys is the gate.
//
// Environment: COMPANY_DIR (default company), MEDIA_DIR (default .media/media; the folder that holds
// <draftId>/<file>, a parent holding media/ is accepted too), DIST_DIR (default dist), PUBLIC_DIR
// (default public; tests only), BUILD_NOW (ISO instant used as the build clock; tests only).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import config from "../site.config.js";
import { loadCompany } from "./lib/company.js";
import { APPROVAL_SPEC, CALENDAR_SPEC, EDIT_SPEC, HR_DECISION_SPEC, HR_PROPOSAL_SPEC, METRIC_SPEC, OVERRIDE_SPEC, PUBLISHED_SPEC, RUN_SPEC, STATUS_SPEC, USAGE_SPEC, validate } from "../engine/lib/schema.js";
import { OF2_PATTERNS } from "../engine/lib/checks.js";
import { OUTPUT_SPEC as ANALYST_OUTPUT_SPEC, listReports, parseReport } from "../engine/agents/analyst.js";
import { OUTPUT_SPEC as HR_OUTPUT_SPEC, listProposals, listReviews, parseReview } from "../engine/agents/hr.js";
import { nowIst, parseIso, istMonthKey } from "../engine/lib/time.js";
import { buildFonts, FONTS_DIR } from "../scripts/build-fonts.mjs";
import { FONT_FILES, FONT_BUDGET } from "./lib/fonts.js";
import { previousMonth } from "./lib/dates.js";
import { buildView } from "./lib/view.js";
import { atomFeed, sitemap, robots } from "./feeds.js";
import { homePage } from "./templates/home.js";
import { teamPage } from "./templates/team.js";
import { pagesIndexPage } from "./templates/pages.js";
import { pageDetail } from "./templates/page.js";
import { activityPage } from "./templates/activity.js";
import { calendarPage } from "./templates/calendar.js";
import { publishedPage } from "./templates/published.js";
import { reportPage, reportsPage } from "./templates/reports.js";
import { aboutPage } from "./templates/about.js";
import { notFoundPage } from "./templates/not-found.js";
import { adminPage } from "./templates/admin.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (p) => (isAbsolute(p) ? p : resolve(ROOT, p));
export const COMPANY_DIR = fromRoot(process.env.COMPANY_DIR || "company");
export const MEDIA_DIR = fromRoot(process.env.MEDIA_DIR || join(".media", "media"));
export const DIST = fromRoot(process.env.DIST_DIR || "dist");
export const PUBLIC = fromRoot(process.env.PUBLIC_DIR || "public");

// Size budgets (bytes; design §14). The build fails on any violation.
const KB = 1024;
export const BUDGETS = {
  css: 60 * KB, // styles.css
  js: 40 * KB, // main.js
  page: 150 * KB, // one HTML page + styles.css + main.js
  fonts: FONT_BUDGET, // sum of dist/fonts/*
  // admin/admin.js + the admin's own admin/lib/*.js (github, store, base64, run-status, state). The four
  // engine libraries byte-copied into admin/lib/ (ADMIN_SHARED_LIBS, review N18) are the engine's size, pinned
  // byte-for-byte by tests/parity.test.js, and are reported beside this number rather than counted in it:
  // they alone are ~85 KB, so §14's 100 KB and N18's byte-copy rule cannot both hold otherwise (FEAT-109/111).
  adminJs: 100 * KB,
  media: 1024 * 1024 * KB, // dist/media/** (design §8.6: pages.yml copies at most 1 GB)
};

// Browser-shared libraries byte-copied into dist/admin/lib/ (review N18, plan D12); never committed there.
export const ADMIN_SHARED_LIBS = [
  ["engine/lib/schema.js", "schema.js"],
  ["engine/lib/checks.js", "checks.js"],
  ["engine/lib/brand.js", "brand.js"],
  ["src/lib/labels.js", "labels.js"],
];

// Public-surface rules (OF-1, OF-5; review N22). 'cron' is only a violation when a schedule expression
// follows it (P1-16/P1-17): the word alone is prose (today no public page uses it — the delay note
// config.schedule.actionsDelayNote says "scheduled runs"). 'autopilot' is the lower-case TOKEN; the label is 'Autopilot'.
export const PUBLIC_SURFACE_RULES = [
  { name: "approve_first", re: /\bapprove_first\b/ },
  { name: "autopilot (config token)", re: /\bautopilot\b/ },
  { name: "cron expression", re: /\bcron\s+`?[\d*]/i },
  { name: "cron expression", re: /\*\s\*\s\*/ },
  { name: "admin link", re: /<a\b[^>]*\bhref="[^"]*admin[^"]*"/i },
  { name: "'Admin' text", re: />\s*Admin\s*</ },
  { name: "inline style attribute", re: /<[a-z][^>]*\sstyle=/i },
];

export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = "BuildError";
  }
}

const TEXT_EXT = new Set([".css", ".js", ".svg", ".html", ".txt", ".json", ".webmanifest", ".xml"]);
const rel = (p) => relative(DIST, p).replace(/\\/g, "/");

function log(name, bytes, note = "") {
  console.log(`  ${name.padEnd(48)} ${String(bytes).padStart(9)} B${note ? `  ${note}` : ""}`);
}

function write(relPath, content) {
  const out = join(DIST, relPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content, "utf8");
  log(relPath, Buffer.byteLength(content, "utf8"));
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// public/ → dist/ verbatim, except that text files have the __BASE__ token rewritten to basePath.
function copyPublic() {
  if (!existsSync(PUBLIC)) throw new BuildError(`public dir missing: ${PUBLIC}`);
  let total = 0;
  for (const src of walk(PUBLIC)) {
    const out = join(DIST, relative(PUBLIC, src));
    mkdirSync(dirname(out), { recursive: true });
    if (TEXT_EXT.has(extname(src))) {
      const text = readFileSync(src, "utf8").replace(/__BASE__/g, config.basePath);
      writeFileSync(out, text, "utf8");
      total += Buffer.byteLength(text, "utf8");
    } else {
      cpSync(src, out);
      total += statSync(src).size;
    }
  }
  log(`public/ (${walk(PUBLIC).length} files)`, total);
}

function copyAdminLibs() {
  const libDir = join(DIST, "admin", "lib");
  mkdirSync(libDir, { recursive: true });
  let total = 0;
  for (const [from, name] of ADMIN_SHARED_LIBS) {
    const src = join(ROOT, from);
    cpSync(src, join(libDir, name));
    total += statSync(src).size;
  }
  log(`admin/lib/ (${ADMIN_SHARED_LIBS.length} shared files)`, total);
}

function copyFonts() {
  const outDir = join(DIST, "fonts");
  mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (const [pkg, file] of FONT_FILES) {
    const src = join(ROOT, "node_modules", pkg, "files", file);
    if (!existsSync(src)) throw new BuildError(`font file missing: ${pkg}/files/${file} (run npm install)`);
    cpSync(src, join(outDir, file));
    total += statSync(src).size;
  }
  log(`fonts/ (${FONT_FILES.length} files)`, total, `(budget ${BUDGETS.fonts} B)`);
  if (total > BUDGETS.fonts) throw new BuildError(`size budget exceeded: fonts/ is ${total} B (limit ${BUDGETS.fonts} B)`);
}

// The media folder: MEDIA_DIR itself when it holds <draftId>/ folders, or MEDIA_DIR/media when that exists
// (the .media worktree layout). Returns null when neither exists (media branch not checked out).
export function resolveMediaDir(dir = MEDIA_DIR) {
  const nested = join(dir, "media");
  if (existsSync(nested) && statSync(nested).isDirectory()) return nested;
  if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  return null;
}

// Copies the media folder to dist/media/ (≤ 1 GB) and returns the set of 'media/<id>/<file>' paths present.
function copyMedia() {
  const src = resolveMediaDir();
  const files = new Set();
  if (!src) {
    console.log(`  media/: not copied (${MEDIA_DIR} absent — media branch not checked out)`);
    return files;
  }
  const all = walk(src).filter((p) => !relative(src, p).split(/[\\/]/).includes(".git"));
  const total = all.reduce((s, p) => s + statSync(p).size, 0);
  if (total > BUDGETS.media) throw new BuildError(`media budget exceeded: ${src} holds ${total} B (limit ${BUDGETS.media} B)`);
  for (const p of all) {
    const r = relative(src, p).replace(/\\/g, "/");
    const out = join(DIST, "media", r);
    mkdirSync(dirname(out), { recursive: true });
    cpSync(p, out);
    files.add(`media/${r}`);
  }
  log(`media/ (${all.length} files)`, total, `(budget ${BUDGETS.media} B)`);
  return files;
}

// Five representative swatches from a brand's colour tokens: the page colour first, then greedily the
// token farthest (RGB distance) from everything already picked — deterministic, no hand-chosen list.
export function pickSwatches(brandColor, colours, count = 5) {
  const hex = (c) => /^#[0-9a-f]{6}$/i.test(String(c).trim()) ? String(c).trim().toLowerCase() : null;
  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const dist = (a, b) => {
    const [r1, g1, b1] = rgb(a);
    const [r2, g2, b2] = rgb(b);
    return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
  };
  const pool = [...new Set(colours.map(hex).filter(Boolean))];
  const picked = [hex(brandColor)].filter(Boolean);
  while (picked.length < count && pool.some((c) => !picked.includes(c))) {
    let best = null;
    let bestScore = -1;
    for (const c of pool) {
      if (picked.includes(c)) continue;
      const score = Math.min(...picked.map((p) => dist(p, c)));
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    picked.push(best);
  }
  return picked;
}

// dist/brands.css: the only place a brand colour meets the markup (review M2 — zero inline styles).
export function brandsCss(cfg, brands) {
  const lines = ["/* generated by src/build.js from company/config.json + brands/*.md Tokens — do not edit */"];
  for (const page of cfg.pages) {
    lines.push(`[data-page="${page.handle}"]{--brand:${page.brandColor}}`);
    const brand = brands[page.handle];
    const swatches = pickSwatches(page.brandColor, brand ? Object.values(brand.tokens.colours) : []);
    swatches.forEach((c, i) => lines.push(`[data-page="${page.handle}"] .sw-${i + 1}{background:${c}}`));
  }
  return lines.join("\n") + "\n";
}

// --- state loading (every file validated; a broken state file fails the build by name) ---------------

function assertRecords(rows, spec, relPath) {
  rows.forEach((row, i) => {
    const r = validate(row, spec);
    if (!r.ok) throw new BuildError(`${relPath} line ${i + 1}: ${r.errors.slice(0, 3).join("; ")}`);
  });
  return rows;
}

function readLog(state, kind, monthKey) {
  const relPath = `state/${kind}/${monthKey}.jsonl`;
  return state.exists(relPath) ? state.readJsonl(relPath) : [];
}

function seedStatus(cfg, now) {
  const pages = {};
  for (const p of cfg.pages) pages[p.handle] = { mode: p.mode, tokenState: "not_configured" };
  const queue = {};
  for (const p of cfg.pages) queue[p.handle] = 0;
  return { updatedAt: nowIst(now), lastRuns: [], queue, blocked: {}, budget: { month: istMonthKey(now), usedUsd: 0, limitUsd: cfg.budget.monthlyUsd, exhausted: false }, pages, flags: [] };
}

export function loadState(company, now) {
  const { state, config: cfg } = company;
  const monthKey = istMonthKey(now);
  const prevKey = previousMonth(monthKey);
  const status = state.exists("state/status.json") ? state.readJson("state/status.json", STATUS_SPEC) : seedStatus(cfg, now);
  const drafts = state.listDrafts().map((id) => state.readDraft(id));
  const edits = new Map();
  const editsDir = state.resolve("state/edits");
  if (existsSync(editsDir)) {
    for (const name of readdirSync(editsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const edit = state.readJson(`state/edits/${name}`, EDIT_SPEC);
      edits.set(edit.draftId, edit);
    }
  }
  const approvals = assertRecords(state.readJsonl("state/approvals.jsonl"), APPROVAL_SPEC, "state/approvals.jsonl");
  const overrides = assertRecords(state.readJsonl("state/overrides.jsonl"), OVERRIDE_SPEC, "state/overrides.jsonl");
  const published = assertRecords(state.readJsonl("state/published.jsonl"), PUBLISHED_SPEC, "state/published.jsonl");
  const calendar = state.exists("state/calendar.json") ? state.readJson("state/calendar.json", CALENDAR_SPEC) : null;
  const runs = [...assertRecords(readLog(state, "runs", prevKey), RUN_SPEC, `state/runs/${prevKey}.jsonl`), ...assertRecords(readLog(state, "runs", monthKey), RUN_SPEC, `state/runs/${monthKey}.jsonl`)];
  // The run-log month files that actually exist among the two the build reads, newest first — the Activity page names
  // only these (a month without a file is never named, so "September 2026" cannot appear while no such file exists).
  const runMonths = [monthKey, prevKey].filter((k) => state.exists(`state/runs/${k}.jsonl`));
  const usage = [...assertRecords(readLog(state, "usage", prevKey), USAGE_SPEC, `state/usage/${prevKey}.jsonl`), ...assertRecords(readLog(state, "usage", monthKey), USAGE_SPEC, `state/usage/${monthKey}.jsonl`)];
  const metrics = [...assertRecords(readLog(state, "metrics", prevKey), METRIC_SPEC, `state/metrics/${prevKey}.jsonl`), ...assertRecords(readLog(state, "metrics", monthKey), METRIC_SPEC, `state/metrics/${monthKey}.jsonl`)];
  // The Analyst's reports (FEAT-203): every file must carry the JSON block the engine wrote and the block must still
  // be a valid Analyst output — a hand-edited or truncated report fails the build by name, like any state file.
  const reports = listReports(state).map((entry) => {
    const markdown = state.readText(entry.rel);
    const parsed = parseReport(markdown);
    if (!parsed) throw new BuildError(`${entry.rel}: no JSON block (the Analyst writes one; see engine/agents/analyst.js renderReport)`);
    const r = validate(parsed.report, ANALYST_OUTPUT_SPEC);
    if (!r.ok) throw new BuildError(`${entry.rel}: ${r.errors.slice(0, 3).join("; ")}`);
    if (parsed.report.week !== entry.week) throw new BuildError(`${entry.rel}: the JSON block says week ${parsed.report.week}`);
    return { ...entry, markdown };
  });
  // HR's monthly reviews, proposals and the owner's decisions (FEAT-204): the same rule — a review without the engine's
  // JSON block, a proposal or a decision line that fails its spec, fails the build by name.
  const hr = {
    reviews: listReviews(state).map((entry) => {
      const markdown = state.readText(entry.rel);
      const parsed = parseReview(markdown);
      if (!parsed) throw new BuildError(`${entry.rel}: no JSON block (HR writes one; see engine/agents/hr.js renderReview)`);
      const r = validate(parsed.review, HR_OUTPUT_SPEC);
      if (!r.ok) throw new BuildError(`${entry.rel}: ${r.errors.slice(0, 3).join("; ")}`);
      return { ...entry, markdown, review: parsed.review, engine: parsed.engine, body: parsed.body };
    }),
    proposals: listProposals(state).map((entry) => {
      const proposal = state.readJson(entry.rel, HR_PROPOSAL_SPEC);
      if (proposal.month !== entry.month) throw new BuildError(`${entry.rel}: the file says month ${proposal.month}`);
      return { ...entry, ...proposal };
    }),
    decisions: assertRecords(state.readJsonl("state/hr/decisions.jsonl"), HR_DECISION_SPEC, "state/hr/decisions.jsonl"),
  };
  return { status, drafts, edits, approvals, overrides, published, calendar, runs, runMonths, usage, metrics, reports, hr };
}

// --- enforcement ------------------------------------------------------------------------------------

function publicHtmlFiles() {
  return walk(DIST).filter((p) => p.endsWith(".html") && !rel(p).startsWith("admin/"));
}

export function checkPublicSurface(files = publicHtmlFiles()) {
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    for (const rule of PUBLIC_SURFACE_RULES) {
      const m = rule.re.exec(html);
      if (m) throw new BuildError(`public-surface: ${rule.name} found in ${rel(file)} (${JSON.stringify(m[0].slice(0, 60))})`);
    }
    // OF-2: JobRez copy — the whole detail page and the JobRez card wherever it appears.
    const jobrez = /[\\/]pages[\\/]job_rez[\\/]index\.html$/.test(file) ? [html] : [...html.matchAll(/<article class="card page-card" data-page="job_rez">[\s\S]*?<\/article>/g)].map((x) => x[0]);
    for (const text of jobrez) {
      for (const re of OF2_PATTERNS) {
        const m = re.exec(text);
        if (m) throw new BuildError(`public-surface: OF-2 token ${JSON.stringify(m[0])} in JobRez copy in ${rel(file)}`);
      }
    }
  }
}

export function assertBudgets() {
  const size = (p) => (existsSync(p) ? statSync(p).size : 0);
  const over = (what, bytes, limit) => new BuildError(`size budget exceeded: ${what} is ${bytes} B (limit ${limit} B)`);
  const css = size(join(DIST, "styles.css"));
  const js = size(join(DIST, "main.js"));
  log("styles.css", css, `(budget ${BUDGETS.css} B)`);
  log("main.js", js, `(budget ${BUDGETS.js} B)`);
  if (css > BUDGETS.css) throw over("styles.css", css, BUDGETS.css);
  if (js > BUDGETS.js) throw over("main.js", js, BUDGETS.js);
  let largest = { file: null, total: 0 };
  for (const p of walk(DIST).filter((f) => f.endsWith(".html"))) {
    const total = size(p) + css + js;
    if (total > largest.total) largest = { file: rel(p), total };
    if (total > BUDGETS.page) throw over(`${rel(p)} + styles.css + main.js`, total, BUDGETS.page);
  }
  log(`largest page (${largest.file}) + css + js`, largest.total, `(budget ${BUDGETS.page} B)`);
  const fonts = walk(join(DIST, "fonts")).reduce((s, p) => s + size(p), 0);
  if (fonts > BUDGETS.fonts) throw over("fonts/", fonts, BUDGETS.fonts);
  const adminDir = join(DIST, "admin");
  const shared = new Set(ADMIN_SHARED_LIBS.map(([, name]) => name));
  const libFiles = walk(join(adminDir, "lib")).filter((f) => f.endsWith(".js"));
  const adminShared = libFiles.filter((f) => shared.has(relative(join(adminDir, "lib"), f))).reduce((s, p) => s + size(p), 0);
  const adminJs = size(join(adminDir, "admin.js")) + libFiles.reduce((s, p) => s + size(p), 0) - adminShared;
  log("admin js (admin.js + own admin/lib)", adminJs, `(budget ${BUDGETS.adminJs} B)`);
  log(`admin/lib shared copies (${shared.size} engine libs)`, adminShared, "(not budgeted; byte-identical to engine/lib + src/lib)");
  if (adminJs > BUDGETS.adminJs) throw over("admin/admin.js + own admin/lib", adminJs, BUDGETS.adminJs);
}

// --- build --------------------------------------------------------------------------------------------

export function build() {
  const started = Date.now();
  const now = process.env.BUILD_NOW ? parseIso(process.env.BUILD_NOW) : new Date();
  if (!existsSync(join(FONTS_DIR, "coverage.json"))) {
    const r = buildFonts({ log: () => {} });
    console.log(`fonts: engine/render/fonts/ was missing — built ${r.families.length} families (review N8)`);
  }
  const company = loadCompany({ companyDir: COMPANY_DIR, now: () => now });
  const data = loadState(company, now);
  const view0 = { config: company.config, roster: company.roster, brands: company.brands, ...data, now };

  console.log(`Building ${company.config.pages.length} pages, ${data.drafts.length} drafts, ${data.published.length} published posts, ${data.runs.length} runs, ${data.reports.length} reports (clock ${nowIst(now)}) -> ${rel(DIST) || DIST}`);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  copyPublic();
  copyAdminLibs();
  copyFonts();
  const mediaFiles = copyMedia();
  write("brands.css", brandsCss(company.config, company.brands));

  const view = buildView({ ...view0, mediaFiles });
  write("index.html", homePage(view));
  write("team/index.html", teamPage(view));
  write("pages/index.html", pagesIndexPage(view));
  for (const page of company.config.pages) write(`pages/${page.handle}/index.html`, pageDetail(view, page));
  write("activity/index.html", activityPage(view));
  write("calendar/index.html", calendarPage(view));
  write("published/index.html", publishedPage(view));
  write("reports/index.html", reportsPage(view));
  for (const report of view.reports) write(`reports/${report.week}/index.html`, reportPage(view, report));
  write("about/index.html", aboutPage(view));
  write("admin/index.html", adminPage({ config: company.config, roster: company.roster, year: view.year }));
  write("404.html", notFoundPage(view));
  write("feed.xml", atomFeed(view));
  write("sitemap.xml", sitemap(view));
  write("robots.txt", robots());

  checkPublicSurface();
  assertBudgets();
  console.log(`Done in ${Date.now() - started} ms`);
  return { dist: DIST, view };
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    build();
  } catch (e) {
    console.error(e instanceof BuildError ? `build failed — ${e.message}` : e && e.stack ? e.stack : String(e));
    process.exit(1);
  }
}
