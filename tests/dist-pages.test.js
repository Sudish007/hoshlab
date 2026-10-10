// Dist tests on the site built from tests/fixtures/company-populated by scripts/test.mjs (clock BUILD_NOW
// 2026-10-12T09:30 IST): page set (P1-12), OF-1/OF-2/OF-5/OF-6, M2, M6, N2, N4, N5, N9, N10, N13, N22.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import config from "../site.config.js";
import { OF2_PATTERNS } from "../engine/lib/checks.js";
import { PREPAINT } from "../src/templates/layout.js";
import { NAV } from "../src/templates/partials.js";
import { ROOT, DIST, COMPANY_DIR, htmlFiles, read, tmpDir } from "./helpers.js";

const BASE = config.basePath;
const publicHtml = () => htmlFiles().filter((f) => !/[\\/]admin[\\/]/.test(f));
const page = (rel) => read(join(DIST, ...rel.split("/")));
const text = (html) => html.replace(/<[^>]+>/g, " ");
const UNAPPROVED_RP = "rp-2026-10-14-kundali-free";
const APPROVED_KD = "kd-2026-10-13-six-rules";
const BLOCKED_JR = "jr-2026-10-15-templates";

test("P1-12: every public page, the 404 and the three feeds exist", () => {
  for (const rel of ["index.html", "team/index.html", "pages/index.html", "pages/rishtapatra/index.html", "pages/kaatdo/index.html", "pages/job_rez/index.html", "activity/index.html", "calendar/index.html", "published/index.html", "reports/index.html", "about/index.html", "404.html", "sitemap.xml", "feed.xml", "robots.txt", "styles.css", "main.js", "brands.css", "favicon.svg", "favicon.ico", "apple-touch-icon.png", "og-default.png"]) {
    assert.ok(existsSync(join(DIST, ...rel.split("/"))), rel);
  }
  assert.ok(existsSync(join(DIST, "admin", "lib", "labels.js")), "shared libs copied for the admin (N18)");
  assert.ok(!existsSync(join(ROOT, "public", "admin", "lib")), "shared libs are never committed under public/admin/lib (N18)");
  assert.equal(publicHtml().length, 12);
});

test("OF-1: no public page links to admin or has an element whose text is 'Admin'", () => {
  for (const file of publicHtml()) {
    const html = read(file);
    assert.doesNotMatch(html, /<a\b[^>]*\bhref="[^"]*admin/i, `${file}: a[href*=admin]`);
    assert.doesNotMatch(html, />\s*Admin\s*</, `${file}: 'Admin' element`);
    assert.ok(!/\badmin\b/i.test(text(html).replace(/sudish007|hoshlab/gi, "")), `${file}: the word admin in visible text`);
  }
});

test("OF-5: no config token or cron expression in public HTML; the status strip prints the human labels (P1-16)", () => {
  for (const file of publicHtml()) {
    const html = read(file);
    assert.ok(!html.includes("approve_first"), `${file}: approve_first`);
    assert.doesNotMatch(html, /\bautopilot\b/, `${file}: autopilot token (the label is 'Autopilot')`);
    // 'cron ' followed by a schedule expression. The literal substring 'cron ' is allowed exactly once in
    // prose: the mandated delay note "Actions cron may start 10–30 min late" (config.schedule.actionsDelayNote).
    assert.doesNotMatch(html, /\bcron\s+`?[\d*]/i, `${file}: cron expression`);
    assert.doesNotMatch(html, /\*\s\*\s\*/, `${file}: cron expression`);
    for (const m of html.matchAll(/\bcron\b/gi)) {
      assert.ok(html.slice(Math.max(0, m.index - 8), m.index + 40).includes("Actions cron may start"), `${file}: 'cron' outside the delay note at ${m.index}`);
    }
  }
  const home = page("index.html");
  const strip = home.match(/<div class="status-strip"[\s\S]*?<\/div>\s*<\/div>/)[0];
  for (const s of ["Approve first", "Daily 05:30 IST", "Hourly at :30 IST", "Actions cron may start 10–30 min late"]) assert.ok(strip.includes(s), `status strip: ${s}`);
  assert.ok(strip.includes("USD 0.05 of 25"), "month budget computed from the usage file (0.053618 → 0.05)");
  assert.ok(strip.includes("1 draft"), "awaiting approval counts the unapproved queued draft only");
});

test("OF-6: the Team page has exactly eight 'AI agent ·' eyebrows, one per roster agent", () => {
  const team = page("team/index.html");
  const labels = team.match(/<p class="ai-label">[^<]*<\/p>/g) || [];
  assert.equal(labels.length, 8);
  for (const l of labels) assert.match(l, /AI agent · (leadership|studio|operations)/);
  assert.equal((team.match(/<article class="card agent"/g) || []).length, 8);
});

test("N4: Team says 'no language model' exactly twice (Designer, Publisher) and never 'dated source'; hero copy per N4", () => {
  const team = page("team/index.html");
  assert.equal((team.match(/no language model/g) || []).length, 2);
  assert.ok(!team.includes("dated source"));
  assert.ok(team.includes("Six of the eight roles run on a language model; the Designer and Publisher are deterministic code. Every role has a list of things it is never allowed to do."));
  assert.ok(team.includes("Every factual claim must map to a fact id in brand.md."));
  assert.ok(team.includes("Monthly review: not built yet (phase 2)"));
  assert.ok(team.includes("Weekly insights: not built yet (phase 2)"));
});

test("N5: provider names are human labels, never config tokens", () => {
  const team = page("team/index.html");
  assert.doesNotMatch(team, /provider: (anthropic|gemini|openai)/);
  for (const t of ["Anthropic · claude-sonnet-5-5", "Google Gemini · gemini-3.8-flash", "OpenAI · gpt-6-luna"]) assert.ok(team.includes(t), t);
  assert.ok(!/<span class="chip chip-plain">temperature[^<]*<\/span><span class="chip chip-plain">fallback: OpenAI, Google Gemini/.test(team), "no temperature chip for claude-sonnet-5-5 (acceptsTemperature false)");
  const ceo = team.match(/<article class="card agent" data-agent="ceo">[\s\S]*?<\/article>/)[0];
  assert.ok(!ceo.includes("temperature"), "CEO card: model ignores temperature, so no chip");
  const hr = team.match(/<article class="card agent" data-agent="hr">[\s\S]*?<\/article>/)[0];
  assert.ok(hr.includes("temperature 0.3"), "HR card prints its temperature");
});

test("N2: the RishtaPatra card reads '3 posts / week · 1 carousel' and no public page says '1 reel'", () => {
  const home = page("index.html");
  const card = home.match(/<article class="card page-card" data-page="rishtapatra">[\s\S]*?<\/article>/)[0];
  assert.ok(card.includes("3 posts / week · 1 carousel"));
  for (const file of publicHtml()) {
    const html = read(file);
    assert.ok(!html.includes("· 1 reel"), `${file}: a cadence line claims a reel`);
    // Run-log notes are engine output, not site copy: the fixture's Strategist note honestly says
    // "1 reel idea refused (reels not built yet)". Everything outside the log lines must not say '1 reel'.
    const copy = html.replace(/<ul class="run-lines">[\s\S]*?<\/ul>/g, "").replace(/<ol class="activity">[\s\S]*?<\/ol>/g, "");
    assert.ok(!copy.includes("1 reel"), file);
  }
});

test("N9: robots.txt has no Disallow and neither it nor sitemap.xml mentions admin", () => {
  const robots = page("robots.txt");
  const sitemap = page("sitemap.xml");
  assert.ok(!/admin/i.test(robots));
  assert.ok(!/admin/i.test(sitemap));
  assert.ok(!/Disallow/.test(robots));
  assert.ok(robots.includes(`Sitemap: ${config.siteUrl.replace(/\/$/, "")}/sitemap.xml`));
});

test("M6: the unapproved queued draft is 'in review' on Home and Calendar (never 'scheduled'); the approved one is 'scheduled'; the blocked one is absent", () => {
  const home = page("index.html");
  const calendar = page("calendar/index.html");
  const nextUp = home.match(/<div class="next-up" aria-label="Next scheduled posts">[\s\S]*?<\/div>/)[0];
  const rpHome = nextUp.match(new RegExp(`<li[^>]*data-draft="${UNAPPROVED_RP}"[^>]*>[\\s\\S]*?</li>`))[0];
  assert.ok(rpHome.includes("in review") && !rpHome.includes("scheduled"), rpHome);
  const kdHome = nextUp.match(new RegExp(`<li[^>]*data-draft="${APPROVED_KD}"[^>]*>[\\s\\S]*?</li>`))[0];
  assert.ok(kdHome.includes("scheduled") && !kdHome.includes("in review"), kdHome);
  assert.ok(!nextUp.includes(BLOCKED_JR), "blocked drafts are omitted from Next up");
  const rpCal = calendar.match(new RegExp(`<span class="slot[^"]*" data-page="rishtapatra" data-draft="${UNAPPROVED_RP}">[\\s\\S]*?</span></span>`))[0];
  assert.ok(rpCal.includes("in review") && !rpCal.includes("scheduled"), rpCal);
  const kdCal = calendar.match(new RegExp(`<span class="slot[^"]*" data-page="kaatdo" data-draft="${APPROVED_KD}">[\\s\\S]*?</span></span>`))[0];
  assert.ok(kdCal.includes("scheduled"), kdCal);
  assert.ok(!calendar.includes(BLOCKED_JR), "blocked drafts are omitted from the Calendar");
  const legend = calendar.match(/<div class="trust-row legend"[\s\S]*?<\/div>\s*<\/div>/)[0];
  for (const w of ["planned", "in progress", "in review", "scheduled", "published"]) assert.ok(legend.includes(`<span class="k">${w}</span>`), `legend: ${w}`);
  assert.equal((calendar.match(/<a class="slot slot-link"/g) || []).length, 2, "the two published posts link to their permalinks");
  const month = calendar.match(/<div class="next-up" aria-label="This month">[\s\S]*?<\/div>/)[0];
  assert.ok(month.includes("1 published · 1 in review · 3 planned"), "RishtaPatra this month");
  assert.ok(month.includes("1 published · 1 scheduled · 3 planned"), "KaatDo this month");
  assert.ok(month.includes("0 published · 4 planned"), "JobRez this month");
});

test("OF-2: the JobRez card and detail page carry none of the India-specific tokens", () => {
  const detail = page("pages/job_rez/index.html");
  for (const re of OF2_PATTERNS) assert.doesNotMatch(detail, re, `detail page: ${re}`);
  for (const file of publicHtml()) {
    for (const card of read(file).matchAll(/<article class="card page-card" data-page="job_rez">[\s\S]*?<\/article>/g)) {
      for (const re of OF2_PATTERNS) assert.doesNotMatch(card[0], re, `${file} card: ${re}`);
    }
  }
  assert.ok(detail.includes("live jobs panel"));
  assert.ok(!detail.includes("rp-f12"), "a disputed fact never appears");
  assert.ok(!page("pages/rishtapatra/index.html").includes("rp-f12"), "the disputed RishtaPatra fact is not listed");
  assert.ok(page("pages/rishtapatra/index.html").includes("1 disputed (hidden)"));
});

test("M2: no inline style attribute in any public HTML; brand colours come from brands.css via data-page", () => {
  for (const file of publicHtml()) {
    assert.doesNotMatch(read(file), /<[a-z][^>]*\sstyle=/i, `${file}: style attribute`);
    assert.ok(read(file).includes(`<link rel="stylesheet" href="${BASE}brands.css">`), `${file}: links brands.css`);
  }
  const brands = page("brands.css");
  for (const p of JSON.parse(read(join(COMPANY_DIR, "config.json"))).pages) {
    assert.ok(brands.includes(`[data-page="${p.handle}"]{--brand:${p.brandColor}}`), p.handle);
    assert.equal((brands.match(new RegExp(`\\[data-page="${p.handle}"\\] \\.sw-\\d\\{background:#[0-9a-f]{6}\\}`, "g")) || []).length, 5, `${p.handle}: five swatches`);
  }
});

// A tiny tag walker (no DOM): every role=gridcell must sit inside a role=row element (N10).
function gridcellsInsideRows(html) {
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack = [];
  let cells = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (close) {
      const i = stack.map((s) => s.name).lastIndexOf(name);
      if (i >= 0) stack.length = i;
      continue;
    }
    const role = /\brole="([^"]+)"/.exec(attrs)?.[1];
    if (role === "gridcell") {
      cells++;
      if (!stack.some((s) => s.role === "row")) return { ok: false, cells };
    }
    if (!VOID.has(name) && !attrs.trim().endsWith("/")) stack.push({ name, role });
  }
  return { ok: true, cells };
}

test("N10: calendar grid has row wrappers around every gridcell and columnheader; no <time> lacks datetime", () => {
  const calendar = page("calendar/index.html");
  assert.match(calendar, /<div class="calendar" role="grid" aria-label="October 2026 posting calendar">/);
  const r = gridcellsInsideRows(calendar);
  assert.ok(r.ok, "every gridcell has a row ancestor");
  assert.equal(r.cells, 35, "5 weeks × 7 days in October 2026 (Thu 1 → Sat 31)");
  assert.equal((calendar.match(/role="row"/g) || []).length, 6, "one header row + five week rows");
  assert.equal((calendar.match(/role="columnheader"/g) || []).length, 7);
  assert.ok(/<div class="cal-row" role="row"><div class="dow" role="columnheader">Mon<\/div>/.test(calendar));
  for (const file of publicHtml()) {
    assert.doesNotMatch(read(file), /<time\b(?![^>]*\sdatetime=)/, `${file}: <time> without datetime`);
    for (const t of read(file).matchAll(/<time\b[^>]*datetime="([^"]+)"/g)) assert.match(t[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/, `${file}: ${t[1]}`);
  }
});

test("N13: one inline script per page, equal to PREPAINT; lang=en, light only, skip link, nav of eight, footer without Admin", () => {
  for (const file of publicHtml()) {
    const html = read(file);
    const inline = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    assert.deepEqual(inline, [`<script>${PREPAINT}</script>`], `${file}: inline scripts`);
    assert.ok(!html.includes("prefers-color-scheme"), `${file}: no OS scheme`);
    assert.match(html, /^<!doctype html>\n<html lang="en">/, file);
    assert.ok(html.includes('<meta name="color-scheme" content="light">'), file);
    assert.ok(html.includes('<a class="skip-link" href="#main">Skip to content</a>'), file);
    const nav = html.match(/<nav class="site-nav" aria-label="Main">[\s\S]*?<\/nav>/)[0];
    assert.equal((nav.match(/<li>/g) || []).length, NAV.length, file);
    assert.equal(NAV.length, 8);
    assert.ok(!/Admin/.test(nav), file);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, file.endsWith("404.html") ? 0 : 1, `${file}: one current nav item`);
    const footer = html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
    assert.ok(footer.includes("© 2026 Hoshlab · Sudish Kumar · built on GitHub Pages + Actions"), file);
    assert.ok(footer.includes('href="https://github.com/Sudish007/hoshlab"'), file);
    assert.ok(!/Admin/.test(footer), file);
    assert.ok(html.includes(`<link rel="stylesheet" href="${BASE}styles.css">`), file);
    assert.ok(html.includes(`<script src="${BASE}main.js" defer></script>`), file);
  }
  assert.match(page("404.html"), /<meta name="robots" content="noindex">/);
});

test("Home: hero copy, honesty section without the mock adapter sentence, second CTA, brand cards and real activity lines", () => {
  const home = page("index.html");
  assert.ok(home.includes("<h1>Eight AI agents run the Instagram pages for three real products.</h1>"));
  assert.ok(home.includes(`<a class="btn" href="${BASE}published/">See published posts</a>`));
  assert.ok(!home.includes("Open the approval queue"), "OF-1: the old hero CTA is gone");
  assert.ok(home.includes("drafting pauses when the budget is spent"));
  assert.ok(!home.includes("mock adapter"));
  assert.equal((home.match(/<article class="card page-card" data-page="/g) || []).length, 3);
  for (const t of ["2 published", "mock entries", "ideas/2026-10/"]) assert.ok(!home.includes(t), `no mock copy: ${t}`);
  const activity = home.match(/<ol class="activity">[\s\S]*?<\/ol>/)[0];
  assert.ok(activity.includes("0 written, 1 reworked"), "a real agents[].note from runs/2026-10.jsonl");
  assert.ok(!activity.includes("skipped:"), "skipped rows stay on the Activity page");
});

test("Published: one card per published record with artwork copied from the media folder, caption, permalink and IST time; filters per page", () => {
  const html = page("published/index.html");
  const cards = html.match(/<article class="card post-card"[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, 2);
  for (const card of cards) {
    const src = card.match(/<img src="([^"]+)"/)[1];
    assert.ok(src.startsWith(`${BASE}media/`), src);
    assert.ok(existsSync(join(DIST, ...src.slice(BASE.length).split("/"))), `media file copied: ${src}`);
    assert.match(card, /<time datetime="2026-10-\d{2}T[^"]+\+05:30">\w{3} \d{1,2} Oct · \d{2}:\d{2} IST<\/time>/);
    assert.match(card, /href="https:\/\/www\.instagram\.com\/p\/FIXTURE[^"]+"/);
    assert.ok(card.includes('<p class="post-caption">'));
  }
  assert.ok(cards[0].includes('data-page="rishtapatra"') && cards[1].includes('data-page="kaatdo"'), "newest first");
  assert.ok(cards[1].includes('<span lang="hi">काट दो.</span>'), "a Devanagari run inside an English caption is wrapped, not the whole caption");
  assert.ok(cards[0].includes("#RishtaPatra #Biodata #Rishta #Shaadi"), "hashtags appended as posted");
  const filters = html.match(/<div class="hero-actions" role="group" aria-label="Filter by page">[\s\S]*?<\/div>/)[0];
  assert.equal((filters.match(/data-filter="/g) || []).length, 4);
  assert.ok(filters.includes('data-filter="" aria-pressed="true"') && filters.includes('href="?page=kaatdo" data-filter="kaatdo" aria-pressed="false"'));
  assert.ok(html.includes("not built yet (phase 2)"), "reel format labelled honestly");
  assert.ok(page("pages/job_rez/index.html").includes(`href="${BASE}published/?page=job_rez"`));
});

test("Activity page: every run from the current + previous month files, newest first, one line per agent step with notes", () => {
  const html = page("activity/index.html");
  const runs = html.match(/<article class="run"[^>]*id="([^"]+)"/g).map((m) => m.match(/id="([^"]+)"/)[1]);
  assert.deepEqual(runs, ["engine-daily-20261012-0900-a7b8c9", "engine-daily-20261010-0531-c4d5e6", "publisher-hourly-20261009-1930-7a6b5c"]);
  assert.ok(html.includes("skipped: phase2 — HR monthly review: not built yet (phase 2)"));
  assert.ok(html.includes("1 published, 0 waiting, 0 failed, 0 expired"));
  assert.ok(html.includes("October 2026 and September 2026"));
});

test("Reports page prints the honest phase-2 sentence; About states public drafts and the limits", () => {
  assert.ok(page("reports/index.html").includes("No reports yet — the Analyst starts in phase 2"));
  const about = page("about/index.html");
  assert.ok(about.includes("Drafts are public."));
  assert.ok(about.includes("Actions cron may start 10–30 min late"));
  assert.ok(about.includes("not built yet"));
});

// N22: the build itself is the gate — a token in a visible field fails `npm run build` with a named error.
function buildCopy(mutate, label) {
  const dir = tmpDir(`hoshlab-n22-${label}-`);
  const companyDir = join(dir, "company");
  cpSync(COMPANY_DIR, companyDir, { recursive: true });
  mutate(companyDir);
  const r = spawnSync(process.execPath, [join(ROOT, "src", "build.js")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, COMPANY_DIR: companyDir, MEDIA_DIR: join(ROOT, "tests", "fixtures", "media"), DIST_DIR: join(dir, "dist"), BUILD_NOW: process.env.BUILD_NOW || "2026-10-12T09:30:00+05:30" },
  });
  return r;
}

test("N22: a draft caption containing approve_first on the Published page makes the build fail with a named public-surface error", () => {
  const r = buildCopy((companyDir) => {
    const p = join(companyDir, "state", "drafts", "kd-2026-10-06-reconnect-every-trading-morning", "draft.json");
    const draft = JSON.parse(readFileSync(p, "utf8"));
    draft.writerNote = "mode was approve_first when drafted";
    draft.caption = `${draft.caption}\nMode: approve_first`;
    writeFileSync(p, JSON.stringify(draft, null, 2) + "\n");
  }, "token");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /build failed — public-surface: approve_first found in published\/index\.html/);
});

test("N22: an OF-2 token in JobRez brand copy fails the build by name", () => {
  const r = buildCopy((companyDir) => {
    const p = join(companyDir, "brands", "jobrez.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("- Speaks to engineers:", "- Speaks to engineers in India:"));
  }, "of2");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /build failed — public-surface: OF-2 token "India" in JobRez copy in pages\/job_rez\/index\.html/);
});

test("N22: a broken state file fails the build by path instead of printing stale numbers", () => {
  const r = buildCopy((companyDir) => {
    writeFileSync(join(companyDir, "state", "approvals.jsonl"), '{"draftId":"x","decision":"maybe"}\n');
  }, "state");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /state\/approvals\.jsonl line 1/);
});
