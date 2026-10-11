// Dist tests for the Reports pages built from tests/fixtures/company-populated by scripts/test.mjs (P2-05, FEAT-203):
// /reports/ lists 2026-W41 with per-page totals from the report's JSON block; /reports/2026-W41/ renders the Markdown
// (tables inside the captioned scroller, headings below the page h1, no links, raw HTML escaped) beside the
// provenance; the sitemap carries the page; no config token; and every number printed on the report page is a
// metrics value, an engine count/sum over the metrics, a window constant or a calendar number of that week.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../site.config.js";
import { PUBLIC_SURFACE_RULES } from "../src/build.js";
import { EMPTY_SENTENCE, SOURCE_SENTENCE, bodyWithoutTitle, totalsLine } from "../src/templates/reports.js";
import { renderDocument } from "../src/lib/markdown.js";
import { isoWeekRange } from "../src/lib/dates.js";
import { numberTokens, parseReport } from "../engine/agents/analyst.js";
import { createState } from "../engine/lib/state.js";
import { DIST, COMPANY_DIR, read } from "./helpers.js";

const BASE = config.basePath;
const page = (rel) => read(join(DIST, ...rel.split("/")));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const state = createState({ companyDir: COMPANY_DIR });
const metrics = state.readJsonl("state/metrics/2026-10.jsonl");
const published = state.readJsonl("state/published.jsonl");
const fixture = parseReport(readFileSync(join(COMPANY_DIR, "state", "reports", "2026-W41.md"), "utf8"));

test("/reports/ lists 2026-W41 newest first with per-page totals computed from the JSON block, the source sentence, the latest-report box; the empty sentence is gone", () => {
  const html = page("reports/index.html");
  assert.ok(!html.includes(EMPTY_SENTENCE));
  assert.ok(html.includes("1 weekly report from Instagram insights."));
  assert.ok(html.includes(SOURCE_SENTENCE));
  assert.match(html, /<article class="report-row" id="2026-W41">/);
  assert.ok(html.includes(`<h3><a href="${BASE}reports/2026-W41/">2026-W41</a></h3>`));
  assert.ok(html.includes("Mon 5 Oct – Sun 11 Oct 2026"), isoWeekRange("2026-W41").label);
  for (const row of fixture.report.perPage) assert.ok(html.includes(`<li data-page="${row.page}"><span class="mono">@${row.page}</span><span>${totalsLine(row)}</span></li>`), row.page);
  assert.equal(totalsLine(fixture.report.perPage.find((r) => r.page === "kaatdo")), "1 post · reach 412 · views 538 · saves 17");
  assert.equal(totalsLine(fixture.report.perPage.find((r) => r.page === "job_rez")), "0 posts in the window");
  assert.ok(html.includes("Written Sun 11 Oct · 21:03 IST · 2 insight records (48 hours) · fetched Sun 11 Oct 2026 · 2 items for the CEO"));
  assert.ok(html.includes(`<a class="btn" href="${BASE}reports/2026-W41/">Latest report · 2026-W41</a>`));
  assert.ok(html.includes("2 posts in the 28-day window"));
  assert.ok(!html.includes("mock run"), "the fixture report was not a mock run");
  assert.ok(!html.includes("not built yet"), "nothing on the Reports page is unbuilt any more");
});

test("/reports/2026-W41/ renders the report Markdown inside the design: tables in the captioned .table-wrap, headings at h2 and below (the page h1 is the week), raw HTML escaped, no links in the prose; the side column carries the insight records, forCeo and provenance; sitemap lists it", () => {
  const file = join(DIST, "reports", "2026-W41", "index.html");
  assert.ok(existsSync(file));
  const html = read(file);
  assert.ok(html.includes("<h1>Weekly report 2026-W41.</h1>"));
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, "one h1");
  assert.ok(html.includes(`<link rel="canonical" href="${config.siteUrl}/reports/2026-W41/">`));
  assert.ok(html.includes("Report · 2026-W41 · Mon 5 Oct – Sun 11 Oct 2026"));
  assert.ok(html.includes(`${SOURCE_SENTENCE} after each post went live (fetched Sun 11 Oct 2026; 48 hours)`), "the source sentence and the fetch dates");
  assert.ok(html.includes("Written by the Analyst Sun 11 Oct · 21:03 IST from 2 insight records covering 2 posts of the last 28 days."));
  const prose = html.match(/<article class="prose" aria-label="Report">([\s\S]*?)<\/article>/)[1];
  assert.equal(prose.trim(), renderDocument(bodyWithoutTitle(fixture.body)), "the body is renderDocument() of the Markdown without its title");
  assert.ok(!/<h1/.test(prose) && /<h2>Summary<\/h2>/.test(prose), "## sections are h2 under the page h1; the Markdown's # title is dropped");
  assert.equal((prose.match(/<figure class="table-wrap"><figcaption class="meta">scroll →<\/figcaption>/g) || []).length, 2, "both per-page tables sit in the captioned scroller (M12)");
  assert.equal((prose.match(/<table class="table">/g) || []).length, 2);
  assert.ok(prose.includes('<th scope="col" class="align-right">reach</th>'));
  assert.ok(prose.includes('<td class="align-right">412</td>') && prose.includes('<td class="align-right">655</td>'));
  assert.ok(!/<a\b/.test(prose), "no links inside the rendered report");
  assert.ok(!/<[^>]+\sstyle=/.test(html), "no inline styles (M2)");
  // raw HTML (block and inline), links and images in a report body are neutralised by the renderer
  const hostile = renderDocument("# t\n\nsee [x](https://example.com) and ![alt](https://example.com/i.png) <b>raw</b>\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| <b>1</b> | 2 |");
  assert.ok(!hostile.includes("<script>") && hostile.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "raw HTML block escaped");
  assert.ok(hostile.includes("<p>see x and alt &lt;b&gt;raw&lt;/b&gt;</p>"), "link text and alt text only; inline HTML escaped");
  assert.ok(!hostile.includes("<a ") && !hostile.includes("<img"));
  assert.ok(hostile.includes("<td>&lt;b&gt;1&lt;/b&gt;</td>"));
  assert.ok(hostile.includes("<h2>t</h2>"), "a document-level # title renders as h2");
  // side column
  assert.ok(html.includes("<h3>Insights used</h3>"));
  for (const m of metrics) assert.ok(html.includes(`<li data-page="${m.page}"><span class="mono">${m.draftId}</span><span>48 hours · `), m.draftId);
  assert.ok(html.includes("<h3>For the CEO</h3>"));
  for (const f of fixture.report.forCeo) assert.ok(html.includes(f.replace(/'/g, "&#39;")), f);
  assert.ok(html.includes("<dt>Run</dt><dd><span class=\"mono\">engine-daily-20261011-2100-5e4d3c</span></dd>"));
  assert.ok(html.includes("<dt>File</dt><dd><span class=\"mono\">company/state/reports/2026-W41.md</span></dd>"));
  assert.ok(html.includes("(v26.0): reach, views, likes, comments, saves, shares"), "metric names and the verified API version");
  assert.ok(!html.includes("mock run"));
  // the week's nav item is current for the detail page too (a section is current for every page below it)
  assert.ok(html.includes(`<li><a href="${BASE}reports/" aria-current="page">Reports</a></li>`));
  const sitemap = read(join(DIST, "sitemap.xml"));
  assert.ok(sitemap.includes(`<loc>${config.siteUrl}/reports/2026-W41/</loc>`));
  assert.ok(!sitemap.includes("/reports/2026-W41.md"), "the Markdown file itself is not a route");
});

test("no config token or admin link on either Reports page; the detail page is as public-surface clean as the build demands", () => {
  for (const rel of ["reports/index.html", "reports/2026-W41/index.html"]) {
    const html = page(rel);
    for (const rule of PUBLIC_SURFACE_RULES) assert.ok(!rule.re.test(html), `${rel}: ${rule.name}`);
    assert.equal((html.match(/href="[^"]*admin[^"]*"/g) || []).length, 0, `${rel}: OF-1`);
    assert.ok(!/\bapprove_first\b|\bautopilot\b|\* \* \*/.test(text(html)), `${rel}: OF-5`);
  }
});

test("every number printed on the report page is a metrics value, an engine count/sum, a window constant or a calendar number of that week (P2-04 cross-check on the public surface)", () => {
  const html = page("reports/2026-W41/index.html");
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  // drop the machine parts that legitimately carry other digits: ids, times, dates, the run id, the API version
  const visible = text(main)
    .replace(/engine-daily-\d{8}-\d{4}-[0-9a-f]{6}/g, " ")
    .replace(/v\d+\.\d+/g, " ")
    .replace(/\b\d{2}:\d{2}\b/g, " ")
    .replace(/\b\d{4}-W\d{2}\b/g, " ")
    .replace(/\b[a-z]{2}-\d{4}-\d{2}-\d{2}-[a-z0-9-]+/g, " ");
  const values = new Set(metrics.flatMap((m) => Object.values(m.metrics).map(String)));
  const sums = new Set();
  for (const handle of ["rishtapatra", "kaatdo", "job_rez"]) {
    const mine = metrics.filter((m) => m.page === handle);
    sums.add(String(mine.length));
    sums.add(String(published.filter((p) => p.page === handle).length));
    for (const name of Object.keys(metrics[0].metrics)) sums.add(String(mine.reduce((s, m) => s + m.metrics[name], 0)));
  }
  sums.add(String(published.length));
  sums.add(String(metrics.length));
  const calendar = new Set(["2026", "41", "5", "6", "7", "8", "9", "10", "11", "13", "16", "48", "7", "2", "28", "0"]);
  const tokens = [...new Set(numberTokens(visible))];
  const unexplained = tokens.filter((t) => !values.has(t) && !sums.has(t) && !calendar.has(t));
  assert.deepEqual(unexplained, [], `numbers on /reports/2026-W41/ not traceable to metrics: ${unexplained.join(", ")}`);
  for (const v of ["412", "655", "538", "790", "17", "23"]) assert.ok(tokens.includes(v), `${v} printed`);
});
