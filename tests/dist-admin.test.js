// dist/admin/index.html built from tests/fixtures/company-populated (FEAT-111): CSP with the PREPAINT hash
// and exactly one inline script (N13), noindex, zero inline styles (M2), no public page links to it (OF-1),
// the Modes markup carries no config token (N1), the security copy names raw.githubusercontent.com (N6),
// the tabs wrap (M12), the admin-config JSON has the keys admin.js reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../site.config.js";
import { PREPAINT, PREPAINT_SHA256 } from "../src/templates/layout.js";
import { adminCsp, MODE_CONSEQUENCES, WORKFLOWS } from "../src/templates/admin.js";
import { CONSEQUENCES } from "../engine/commands/set-page.js";
import { istParts } from "../engine/lib/time.js";
import { DIST, COMPANY_DIR, htmlFiles, read } from "./helpers.js";

const BASE = config.basePath;
const html = read(join(DIST, "admin", "index.html"));
const section = (id) => {
  const m = html.match(new RegExp(`<section[^>]*\\bid="${id}"[\\s\\S]*?</section>`));
  assert.ok(m, `section #${id}`);
  return m[0];
};

test("noindex, CSP before the inline script, hash = sha256(PREPAINT), only that one inline script (N13)", () => {
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!html.includes('<link rel="canonical"'), "no canonical for a noindex page");
  const cspAt = html.indexOf('<meta http-equiv="Content-Security-Policy"');
  const scriptAt = html.indexOf("<script>");
  assert.ok(cspAt > 0 && cspAt < scriptAt, "the CSP meta precedes the inline script it hashes");
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  const hash = createHash("sha256").update(PREPAINT, "utf8").digest("base64");
  assert.equal(hash, PREPAINT_SHA256);
  assert.ok(csp.includes(`'sha256-${hash}'`), csp);
  assert.equal(csp, adminCsp(new URL(config.siteUrl).origin));
  for (const directive of ["default-src 'self'", "connect-src 'self' https://api.github.com https://raw.githubusercontent.com https://sudish007.github.io", "img-src 'self' data: blob: https://raw.githubusercontent.com", "style-src 'self'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type="application\/json"/.test(m[1]));
  assert.equal(inline.length, 1, "exactly one inline script");
  assert.equal(inline[0][2], PREPAINT);
  assert.ok(html.includes(`<script type="module" src="${BASE}admin/admin.js"></script>`));
  assert.ok(html.includes(`<link rel="stylesheet" href="${BASE}admin/admin.css">`));
  assert.ok(html.includes(`<link rel="stylesheet" href="${BASE}brands.css">`), "brand colours come from brands.css (M2)");
  assert.ok(!html.includes(`<script src="${BASE}main.js"`), "the public filter script is not loaded on the admin");
});

test("M2: zero style attributes and zero <style> blocks; brand colour only through data-page", () => {
  assert.equal((html.match(/ style=/g) || []).length, 0);
  assert.equal((html.match(/<style/g) || []).length, 0);
  const markup = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<script type="application\/json"[\s\S]*?<\/script>/, "").replace(/<meta name="theme-color"[^>]*>/, "");
  assert.doesNotMatch(markup, /#[0-9a-fA-F]{6}\b/, "no hex colour in the markup outside the mark, the theme-color meta and the config JSON");
});

test("OF-1: still no public page links to the admin, and the admin is not in the nav", () => {
  for (const file of htmlFiles().filter((f) => !/[\\/]admin[\\/]/.test(f))) {
    assert.doesNotMatch(read(file), /<a\b[^>]*\bhref="[^"]*admin/i, file);
  }
  const nav = html.match(/<nav class="site-nav"[\s\S]*?<\/nav>/)[0];
  assert.ok(!/admin/i.test(nav));
});

test("N1: the Modes section and the mode dialog print labels only — no approve_first / autopilot token", () => {
  const modes = section("view-modes");
  assert.ok(!modes.includes("approve_first"));
  assert.ok(!/\bautopilot\b/.test(modes), "lower-case token");
  assert.ok(modes.includes("Approve first") && modes.includes("Autopilot"));
  const dialog = html.match(/<dialog id="mode-dialog"[\s\S]*?<\/dialog>/)[0];
  assert.ok(!dialog.includes("approve_first") && !/\bautopilot\b/.test(dialog));
  for (const sentence of MODE_CONSEQUENCES.autopilot) assert.ok(dialog.includes(sentence), sentence);
  assert.ok(dialog.includes("Type the handle to confirm"));
  assert.deepEqual(MODE_CONSEQUENCES, CONSEQUENCES, "the dialog mirrors set-page's binding sentences");
  // The token appears only inside the admin-config JSON (and the raw JSON view at runtime).
  const outsideJson = html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, "");
  assert.ok(!outsideJson.includes("approve_first"));
});

test("N6: the lock copy names raw.githubusercontent.com beside api.github.com; help asks for Contents + Actions read and write", () => {
  const security = html.match(/<div class="panel help security"[\s\S]*?<\/div>/)[0];
  assert.ok(security.includes("This page talks to api.github.com with your token and loads artwork thumbnails from raw.githubusercontent.com without it."));
  const lock = section("lock").replace(/<section id="lock-help"[\s\S]*/, "");
  assert.ok(lock.includes("raw.githubusercontent.com") && lock.includes("api.github.com"));
  assert.ok(lock.includes("Only select repositories") && lock.includes("Sudish007/hoshlab"));
  assert.ok(lock.includes("<strong>Contents</strong> → Read and write") && lock.includes("<strong>Actions</strong> → Read and write"));
  assert.ok(lock.includes('<input id="token" name="token" type="password" autocomplete="off"'));
  assert.ok(lock.includes("Remember on this device"));
  assert.ok(lock.includes('aria-label="After sign-in"'), "OF-4 composition: the hero side carries the sign-in panel and the after-sign-in list");
  assert.ok(lock.includes('class="trust-row"'));
  for (const h of ["Security", "What the admin can do", "Limits"]) assert.ok(html.includes(`>${h}</h3>`), h);
});

test("views, dialogs, tabs and the card template exist as static markup; tabs wrap (M12); 'Run analyst' is an enabled button (FEAT-203)", () => {
  for (const id of ["view-queue", "view-blocked", "view-calendar", "view-modes", "view-run", "view-brand", "view-roster", "view-charter", "view-tell-ceo", "view-activity", "view-json"]) {
    assert.match(html, new RegExp(`<section id="${id}" class="view" hidden`), id);
  }
  for (const id of ["reject-dialog", "edit-dialog", "move-dialog", "mode-dialog"]) assert.ok(html.includes(`<dialog id="${id}"`), id);
  assert.ok(html.includes('<template id="card-template">'));
  const tabs = html.match(/<nav class="admin-tabs"[\s\S]*?<\/nav>/)[0];
  for (const href of ["#/", "#/blocked", "#/calendar", "#/modes", "#/run", "#/brand/rishtapatra", "#/roster", "#/charter/ceo", "#/tell-ceo", "#/activity", "#/json/config.json"]) assert.ok(tabs.includes(`href="${href}"`), href);
  const css = read(join(DIST, "admin", "admin.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.admin-tabs \{[^}]*flex-wrap: wrap;[^}]*overflow: visible/, "tabs wrap instead of scrolling (M12)");
  assert.doesNotMatch(css, /gradient\(|box-shadow: [^;]*\d+px \d+px \d+px/, "no gradients or blurred shadows");
  assert.doesNotMatch(css, /\.admin-tabs[^{]*\{[^}]*overflow-x: (auto|scroll)/, "no scrolling tab row (M12)");
  assert.equal((css.match(/overflow-x: (auto|scroll)/g) || []).length, 1, "the captioned .table-wrap is the only horizontal scroller");
  assert.match(css, /\.table-wrap \{[^}]*overflow-x: auto/);
  assert.match(css, /\.seg button \{[^}]*min-height: var\(--control\)/, "segmented mode buttons are 44 px (N11)");
  assert.ok(html.includes("Blocked, failed, expired"));
  assert.match(html, /<button type="button" class="btn" id="run-analyst">Run analyst<\/button>/, "Run analyst is a live button (no disabled, no aria-disabled)");
  assert.ok(!html.includes("not built yet (phase 2)") || !/Run analyst[^<]*not built yet/.test(html), "the Analyst is no longer labelled unbuilt");
  assert.ok(!html.includes("Reports and analytics: not built yet"), "the limits list no longer calls analytics unbuilt");
  assert.ok(html.includes("Instagram's own media insights"), "the limits list names the insights source");
  assert.ok(html.includes('<figcaption class="meta">scroll →</figcaption>'), "the facts table is the one captioned scroller (M12)");
  assert.ok(html.includes('role="grid"'));
  // FEAT-204: the HR proposals panel lives in the Roster view as static markup (list + empty state + error line)
  const roster = section("view-roster");
  assert.ok(roster.includes('<div class="panel" id="proposals" aria-labelledby="proposals-heading">'));
  assert.ok(roster.includes('<ol id="proposal-list" class="proposals" aria-label="HR proposals" aria-busy="false"></ol>'));
  assert.ok(roster.includes('<p class="empty" id="proposals-empty" hidden>No HR proposals yet — HR reviews the roster on the 1st of each month once a month of runs exists.</p>'));
  assert.ok(roster.includes("The proposal files themselves are never edited here."), "N14 stated to the owner");
  assert.ok(roster.includes("company/state/hr/decisions.jsonl"));
  assert.ok(html.includes("apply or dismiss HR's monthly roster proposals"), "the lock screen's capability list names it");
  assert.ok(!/HR[^<]*not built yet/.test(html), "the admin no longer calls HR unbuilt");
  assert.match(css, /\.proposals \{[^}]*list-style: none/, "proposal list styling present, flat");
});

test("admin-config JSON carries what admin.js reads, from the fixture config", () => {
  const cfg = JSON.parse(html.match(/<script type="application\/json" id="admin-config">([\s\S]*?)<\/script>/)[1]);
  const company = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
  assert.equal(cfg.owner, "Sudish007");
  assert.equal(cfg.repo, "hoshlab");
  assert.equal(cfg.branch, "main");
  assert.equal(cfg.siteUrl, config.siteUrl);
  assert.equal(cfg.basePath, BASE);
  assert.equal(cfg.rawBase, "https://raw.githubusercontent.com/Sudish007/hoshlab");
  assert.deepEqual(cfg.pages.map((p) => p.handle), company.pages.map((p) => p.handle));
  assert.deepEqual(Object.keys(cfg.pages[0]).sort(), ["brand", "brandColor", "displayName", "handle", "mode", "prefix"]);
  assert.deepEqual(cfg.agents, ["ceo", "hr", "strategist", "writer", "designer", "qa", "publisher", "analyst"]);
  assert.deepEqual(cfg.workflows, { engine: "engine-daily.yml", publisher: "publisher-hourly.yml", pages: "pages.yml" });
  assert.deepEqual(cfg.workflows, WORKFLOWS);
  assert.deepEqual(cfg.caps, { captionMax: 2200, hashtagCap: 8, altTextMax: 100, minGapHours: 6, expireAfterHours: 48 });
  assert.equal(cfg.timezone, "Asia/Kolkata");
  assert.deepEqual(cfg.charter.headings, ["## Identity", "## Method", "## Output"]);
  assert.equal(cfg.charter.maxChars, 12000);
});

test("the admin footer prints the build clock's year like every public page (integration seam: adminPage receives view.year)", () => {
  // scripts/test.mjs pins BUILD_NOW to 2026-10-12T09:30:00+05:30; view.year is the IST year of that clock.
  const year = istParts(new Date(process.env.BUILD_NOW || Date.now())).y;
  const footer = html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
  assert.ok(footer.includes(`© ${year} Hoshlab`), footer);
  const home = read(join(DIST, "index.html")).match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
  assert.equal(footer, home, "the admin and the public pages share one footer, byte for byte");
});

test("no JavaScript value leaks into any built file: undefined, NaN, [object Object], Invalid Date, __BASE__", () => {
  const files = [...htmlFiles(), join(DIST, "feed.xml"), join(DIST, "sitemap.xml"), join(DIST, "robots.txt"), join(DIST, "brands.css"), join(DIST, "styles.css"), join(DIST, "admin", "admin.css")];
  for (const file of files) {
    const text = read(file);
    for (const re of [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\bInvalid Date\b/, /__BASE__/]) {
      assert.doesNotMatch(text, re, `${file} leaks ${re}`);
    }
  }
});
