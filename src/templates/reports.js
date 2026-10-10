// Reports: the honest Phase 1 empty state (design §14, plan D18). Phase 2 lists the Analyst's weekly
// reports here; until then the page says so and describes what a report will contain.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { providerLabel } from "../lib/labels.js";
import { sectionHead, sideBox } from "./partials.js";

export const EMPTY_SENTENCE = "No reports yet — the Analyst starts in phase 2";

export function reportsPage(view) {
  const analyst = view.roster.agents.find((a) => a.name === "analyst");
  const n = view.published.length;
  const rows = [
    { k: "reports", v: "none yet", chip: "not built yet (phase 2)", kind: "warn", plain: true },
    { k: "metrics", v: "no insights fetched yet", chip: "not built yet (phase 2)", kind: "warn", plain: true },
    { k: "published", v: n ? `${n} post${n === 1 ? "" : "s"} a report could cover` : "nothing published yet", plain: !n },
    { k: "analyst", v: analyst ? `${providerLabel(analyst.provider)} · ${analyst.model}` : "not in the roster", plain: true },
  ];
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Reports · weekly, by the Analyst</p>
      <h1>${escapeHtml(EMPTY_SENTENCE)}.</h1>
      <p class="lede">Weekly insights are not built yet (phase 2). When they are, the Analyst fetches reach, views, likes, comments, saves and shares for every published post at 48 hours and 7 days, and writes one report per ISO week; every number in a report must exist in the metrics log first.</p>
      <div class="hero-actions"><a class="btn" href="${url("published/")}">See published posts</a><a class="btn btn-quiet" href="${url("team/")}">Meet the Analyst</a></div>
    </div>
    <div class="hero-side">
      ${sideBox("Today", rows)}
    </div>
  </section>

  <section class="section">
    ${sectionHead("What a report will contain", { aside: `<span class="chip chip-warn chip-plain">not built yet (phase 2)</span>`, desc: "Planned shape, not built yet. The Analyst never reports a number it did not fetch." })}
    <div class="grid grid-3">
      <article class="card"><h3>Per-page tables</h3><p class="meta">One row per published post of the week with the metrics at 48 hours and 7 days, taken from <span class="mono">company/state/metrics/</span>.</p></article>
      <article class="card"><h3>Observations</h3><p class="meta">What worked and what did not, each line pointing at the posts it is about. Causes are labelled as hypotheses.</p></article>
      <article class="card"><h3>For the CEO</h3><p class="meta">At least one finding the CEO must answer in the next weekly memo; the memo then references it by id.</p></article>
    </div>
    <p class="meta">${analyst ? `The Analyst is in the roster today (${escapeHtml(analyst.schedule === "weekly-sunday" ? "Sundays" : analyst.schedule)}) but its run is not built yet (phase 2).` : "The Analyst is not in the roster."}</p>
  </section>`;
  return layout({ title: "Reports", description: `${view.config.company.name} weekly reports: ${EMPTY_SENTENCE.toLowerCase()}.`, path: "reports/", body, year: view.year });
}
