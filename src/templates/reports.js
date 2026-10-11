// Reports (design §14 route /reports/ + /reports/<week>/, §5 row "Analyst"; P2-05; FEAT-203): one entry per
// company/state/reports/<YYYY-Www>.md the Analyst wrote (view.reports, newest first) with the per-page totals
// computed from the report's own JSON block, and one page per report rendering its Markdown (marked, raw HTML
// escaped, headings shifted, tables inside the captioned scroller — src/lib/markdown.js renderDocument) beside
// the structured numbers and the provenance the engine stored (insights fetch dates, windows, run id). With no
// report the page keeps its honest empty state: nothing is invented, the sentence says when the first one comes.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { metricLabel, providerLabel, windowLabel } from "../lib/labels.js";
import { renderDocument } from "../lib/markdown.js";
import { formatIst, formatIstDate } from "../lib/dates.js";
import { chip, hi, hiHtml, sectionHead, sideBox } from "./partials.js";

export const EMPTY_SENTENCE = "No reports yet — the Analyst runs on Sundays once posts have been live for 48 hours";
export const SOURCE_SENTENCE = "Numbers come from Instagram insights fetched at 48 h and 7 d";
const TOTAL_METRICS = ["reach", "views", "saved"];

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// '@kaatdo · 1 post · reach 412 · views 538 · saves 17' from a perPage row of the report JSON.
export function totalsLine(row) {
  if (!row.posts) return `${plural(row.posts, "post")} in the window`;
  return [plural(row.posts, "post"), ...TOTAL_METRICS.map((m) => `${metricLabel(m)} ${row[m]}`)].join(" · ");
}

function fetchDatesText(report) {
  if (!report.fetchDates.length) return "no insights fetched";
  return `fetched ${report.fetchDates.map((d) => formatIstDate(`${d}T12:00:00+05:30`)).join(", ")}`;
}

function windowsText(report) {
  return report.windows.length ? report.windows.map(windowLabel).join(" and ") : "no window reached yet";
}

export function reportRow(report) {
  const totals = report.report.perPage.map((row) => `<li data-page="${escapeHtml(row.page)}"><span class="mono">@${escapeHtml(row.page)}</span><span>${escapeHtml(totalsLine(row))}</span></li>`);
  return `<article class="report-row" id="${escapeHtml(report.week)}">
        <div>
          <h3><a href="${url(report.url)}">${escapeHtml(report.week)}</a></h3>
          <p class="meta">${escapeHtml(report.range.label)}</p>
          ${report.mock ? chip("mock run", "warn") : ""}
        </div>
        <ul class="totals" aria-label="Per page">
          ${totals.join("\n          ")}
        </ul>
        <p class="meta">Written ${escapeHtml(formatIst(report.generatedAt))} · ${escapeHtml(plural(report.metricsCount, "insight record"))} (${escapeHtml(windowsText(report))}) · ${escapeHtml(fetchDatesText(report))} · ${escapeHtml(plural(report.report.forCeo.length, "item"))} for the CEO</p>
      </article>`;
}

function emptyBody(view) {
  const analyst = view.roster.agents.find((a) => a.name === "analyst");
  const n = view.published.length;
  const m = view.metrics.length;
  const rows = [
    { k: "reports", v: "none yet", chip: "waiting for insights", kind: "warn", plain: true },
    { k: "insights", v: m ? `${plural(m, "record")} fetched so far` : "none fetched yet", plain: !m },
    { k: "published", v: n ? `${plural(n, "post")} a report could cover` : "nothing published yet", plain: !n },
    { k: "analyst", v: analyst ? `${providerLabel(analyst.provider)} · ${analyst.model}` : "not in the roster", plain: true },
  ];
  return `<section class="hero">
    <div>
      <p class="eyebrow">Reports · weekly, by the Analyst</p>
      <h1>${escapeHtml(EMPTY_SENTENCE)}.</h1>
      <p class="lede">The Analyst fetches reach, views, likes, comments, saves and shares for every published post at 48 hours and 7 days, and writes one report per ISO week; every number in a report must exist in the metrics log first. The first report appears after the first Sunday with a post that has been live for 48 hours.</p>
      <div class="hero-actions"><a class="btn" href="${url("published/")}">See published posts</a><a class="btn btn-quiet" href="${url("team/")}">Meet the Analyst</a></div>
    </div>
    <div class="hero-side">
      ${sideBox("Today", rows)}
    </div>
  </section>

  <section class="section">
    ${sectionHead("What a report contains", { desc: "The Analyst never reports a number it did not fetch; the engine rejects a report whose numbers are not in the metrics log." })}
    <div class="grid grid-3">
      <article class="card"><h3>Per-page tables</h3><p class="meta">One row per published post of the window with the metrics at 48 hours and 7 days, taken from <span class="mono">company/state/metrics/</span>.</p></article>
      <article class="card"><h3>Observations</h3><p class="meta">What worked and what did not, each line pointing at the posts it is about. Causes are labelled as hypotheses.</p></article>
      <article class="card"><h3>For the CEO</h3><p class="meta">At least one finding the CEO must answer in the next weekly memo.</p></article>
    </div>
    <p class="meta">${analyst ? `The Analyst is in the roster (${escapeHtml(analyst.schedule === "weekly-sunday" ? "Sundays" : analyst.schedule)}) and also runs when the owner asks for it.` : "The Analyst is not in the roster."}</p>
  </section>`;
}

export function reportsPage(view) {
  const reports = view.reports;
  if (!reports.length) {
    return layout({ title: "Reports", description: `${view.config.company.name} weekly reports: ${EMPTY_SENTENCE.toLowerCase()}.`, path: "reports/", body: emptyBody(view), year: view.year });
  }
  const latest = reports[0];
  const rows = [
    { k: "week", v: `${latest.week} · ${latest.range.label}`, plain: true },
    { k: "written", v: formatIst(latest.generatedAt), plain: true },
    { k: "insights", v: `${plural(latest.metricsCount, "record")} · ${windowsText(latest)}`, plain: true },
    { k: "posts", v: `${plural(latest.engine.publishedInWindow, "post")} in the ${latest.engine.reportDays}-day window`, plain: true },
    { k: "for the CEO", v: plural(latest.report.forCeo.length, "item"), plain: true },
  ];
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Reports · weekly, by the Analyst</p>
      <h1>${escapeHtml(plural(reports.length, "weekly report"))} from Instagram insights.</h1>
      <p class="lede">${escapeHtml(SOURCE_SENTENCE)} after each post went live, one report per ISO week, written on Sundays. Every number in a report exists in the metrics log first — the engine rejects a report that says otherwise — and causes are labelled as hypotheses.</p>
      <div class="hero-actions"><a class="btn" href="${url(latest.url)}">Latest report · ${escapeHtml(latest.week)}</a><a class="btn btn-quiet" href="${url("published/")}">See published posts</a></div>
    </div>
    <div class="hero-side">
      ${sideBox("Latest report", rows, { note: "Insights are fetched 48 hours and 7 days after a post goes live; a post is measured once per window." })}
    </div>
  </section>

  <section class="section">
    ${sectionHead(plural(reports.length, "report"), { aside: `<span class="meta">newest first · totals from each report's own JSON block</span>`, desc: "Per page: posts in the window and the sums of reach, views and saves over the window the report ranks on." })}
    <div class="report-list">
      ${reports.map((r) => reportRow(r)).join("\n      ")}
    </div>
  </section>`;
  return layout({ title: "Reports", description: `${view.config.company.name} weekly reports from Instagram insights: ${plural(reports.length, "report")}, newest ${latest.week}.`, path: "reports/", body, year: view.year });
}

// The Markdown body without its leading level-1 heading (the hero prints the week as the page's h1).
export function bodyWithoutTitle(markdown) {
  return String(markdown || "").replace(/^\s*#\s[^\n]*\n+/, "");
}

export function reportPage(view, report) {
  const json = report.report;
  const rows = json.perPage.map((row) => ({ k: `@${row.page}`, v: totalsLine(row), page: row.page, plain: true }));
  const perPost = report.engine.metricsUsed.map((m) => `<li data-page="${escapeHtml(m.page)}"><span class="mono">${escapeHtml(m.draftId)}</span><span>${escapeHtml(windowLabel(m.window))} · ${escapeHtml(formatIst(m.at))}</span>${m.dryRun ? chip("dry run", "warn") : ""}</li>`);
  const unmeasured = report.engine.unmeasured || [];
  const body = `<section class="hero" data-view="report">
    <div>
      <p class="eyebrow">Report · ${escapeHtml(report.week)} · ${escapeHtml(report.range.label)}</p>
      <h1>Weekly report ${escapeHtml(report.week)}.</h1>
      <p class="lede">${escapeHtml(SOURCE_SENTENCE)} after each post went live (${escapeHtml(fetchDatesText(report))}; ${escapeHtml(windowsText(report))}). Written by the Analyst ${escapeHtml(formatIst(report.generatedAt))} from ${escapeHtml(plural(report.metricsCount, "insight record"))} covering ${escapeHtml(plural(report.engine.publishedInWindow, "post"))} of the last ${escapeHtml(String(report.engine.reportDays))} days. Every number below exists in the metrics log; causes are labelled as hypotheses.</p>
      <div class="hero-actions"><a class="btn" href="${url("reports/")}">All reports</a><a class="btn btn-quiet" href="${url("published/")}">Published posts</a></div>
      ${report.mock ? `<p class="flag">This report was written in a mock run: the model answer came from a fixture, not from a provider.</p>` : ""}
    </div>
    <div class="hero-side">
      ${sideBox("Per page", rows, { note: `Posts in the window and the sums of reach, views and saves over the window each page is ranked on (${escapeHtml(windowsText(report))}).` })}
    </div>
  </section>

  <section class="section report-grid">
    <article class="prose" aria-label="Report">
      ${hiHtml(renderDocument(bodyWithoutTitle(report.body)))}
    </article>
    <aside class="report-side" aria-label="Numbers and provenance">
      <div class="card">
        <h3>Insights used</h3>
        <p class="meta">${escapeHtml(plural(report.metricsCount, "record"))} from <span class="mono">company/state/metrics/</span>, one line per post and window.</p>
        <ul class="used" aria-label="Insight records">
          ${perPost.join("\n          ")}
        </ul>
        ${unmeasured.length ? `<p class="meta">Not measured yet: ${unmeasured.map((id) => `<span class="mono">${escapeHtml(id)}</span>`).join(", ")} (not 48 hours old at the last fetch, or the fetch failed).</p>` : ""}
      </div>
      <div class="card">
        <h3>For the CEO</h3>
        <ol class="plain">
          ${json.forCeo.map((f) => `<li>${hi(f)}</li>`).join("\n          ")}
        </ol>
        <p class="meta">The CEO's next memo answers each item.</p>
      </div>
      <div class="card">
        <h3>Provenance</h3>
        <dl class="kv">
          <dt>File</dt><dd><span class="mono">company/state/${escapeHtml(report.path)}</span></dd>
          <dt>Run</dt><dd><span class="mono">${escapeHtml(report.engine.runId)}</span></dd>
          <dt>Written</dt><dd>${escapeHtml(formatIst(report.generatedAt))}</dd>
          <dt>Windows</dt><dd>${escapeHtml(windowsText(report))}</dd>
          <dt>Metric names</dt><dd>Meta's media insights for feed posts and reels (${escapeHtml(report.engine.insightsDoc && report.engine.insightsDoc.version ? report.engine.insightsDoc.version : view.config.ig.version)}): reach, views, likes, comments, saves, shares</dd>
        </dl>
      </div>
    </aside>
  </section>`;
  return layout({ title: `Report ${report.week}`, description: `${view.config.company.name} weekly report ${report.week} (${report.range.label}) from Instagram insights fetched at 48 h and 7 d.`, path: report.url, body, year: view.year });
}
