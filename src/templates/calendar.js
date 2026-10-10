// Calendar (mock/calendar.html → real slots): the current IST month as an ARIA grid with role=row
// wrappers and columnheader/gridcell cells (review N10); one slotLabel word per slot (M6); captions and
// permalinks only for published posts; the legend uses the same five words; "This month" per page counts
// published and planned slots, from the cadence alone in the empty state (M11). No <time> without datetime.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { cadenceLine } from "../lib/labels.js";
import { formatIstTime, monthName, monthGrid, dateKeyOf, formatIstDate } from "../lib/dates.js";
import { chip, hi, excerpt } from "./partials.js";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function thisMonthList(view, { heading = "This month" } = {}) {
  const items = view.thisMonth.map((t) => {
    const page = view.config.pages.find((p) => p.handle === t.page);
    const parts = [`${t.published} published`];
    if (t.scheduled) parts.push(`${t.scheduled} scheduled`);
    if (t.inReview) parts.push(`${t.inReview} in review`);
    if (t.inProgress) parts.push(`${t.inProgress} in progress`);
    parts.push(`${t.planned} planned`);
    const perWeek = cadenceLine(page, view.config.features).split(" / week")[0].replace(/ posts?$/, "");
    return `<li data-page="${escapeHtml(t.page)}"><span class="mono">@${escapeHtml(t.page)}</span><span class="who">${parts.join(" · ")}</span>${chip(`${perWeek} / week`)}</li>`;
  });
  return `<div class="next-up" aria-label="${escapeHtml(heading)}">
        <h2>${escapeHtml(heading)}</h2>
        <ol>
          ${items.join("\n          ")}
        </ol>
      </div>`;
}

function slotMarkup(entry) {
  const kind = entry.label === "scheduled" || entry.label === "published" ? "" : entry.label === "in review" ? " slot-warn" : "";
  const what = entry.format === "image" ? "" : `${entry.format} · `;
  const attrs = `data-page="${escapeHtml(entry.page)}"${entry.draftId ? ` data-draft="${escapeHtml(entry.draftId)}"` : ""}`;
  if (entry.label === "published") {
    const rec = entry.published;
    const cap = entry.draft ? entry.draft.caption : "";
    const capHtml = cap ? `<span class="cap">${hi(excerpt(cap, 70))}</span>` : "";
    if (rec && rec.permalink) {
      return `<a class="slot slot-link" href="${escapeHtml(rec.permalink)}" rel="noopener" ${attrs}>@${escapeHtml(entry.page)}<span class="st">${formatIstTime(entry.at)} · published</span>${capHtml}</a>`;
    }
    return `<span class="slot" ${attrs}>@${escapeHtml(entry.page)}<span class="st">${formatIstTime(entry.at)} · published · permalink pending</span>${capHtml}</span>`;
  }
  return `<span class="slot${kind}" ${attrs}>@${escapeHtml(entry.page)}<span class="st">${formatIstTime(entry.at)} · ${what}${entry.label}</span></span>`;
}

export function calendarGrid(view) {
  const { year, month, days, firstDow } = monthGrid(view.monthKey);
  const byDay = new Map();
  for (const e of view.entries) {
    const key = dateKeyOf(e.at);
    if (!key.startsWith(view.monthKey)) continue;
    const d = Number(key.slice(8, 10));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const cells = [];
  const prevDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  for (let i = firstDow - 1; i >= 0; i--) cells.push(`<div class="day pad" role="gridcell" aria-label="${prevDays - i} (previous month)"><span class="n">${prevDays - i}</span></div>`);
  for (let d = 1; d <= days; d++) {
    const key = `${view.monthKey}-${String(d).padStart(2, "0")}`;
    const today = key === view.today ? " today" : "";
    const slots = (byDay.get(d) || []).map(slotMarkup).join("");
    const label = formatIstDate(`${key}T12:00:00+05:30`);
    cells.push(`<div class="day${today}" role="gridcell" aria-label="${escapeHtml(label)}${today ? " (today)" : ""}"><span class="n">${d}</span>${slots}</div>`);
  }
  let next = 1;
  while (cells.length % 7 !== 0) cells.push(`<div class="day pad" role="gridcell" aria-label="${next} (next month)"><span class="n">${next++}</span></div>`);
  const rows = [];
  rows.push(`<div class="cal-row" role="row">${DOW.map((d) => `<div class="dow" role="columnheader">${d}</div>`).join("")}</div>`);
  for (let i = 0; i < cells.length; i += 7) rows.push(`<div class="cal-row" role="row">${cells.slice(i, i + 7).join("")}</div>`);
  return `<div class="calendar" role="grid" aria-label="${escapeHtml(monthName(view.monthKey))} posting calendar">
      ${rows.join("\n      ")}
    </div>`;
}

export function calendarPage(view) {
  const title = monthName(view.monthKey);
  const horizonNote = view.horizonEnd
    ? `Slots up to ${escapeHtml(formatIstDate(view.horizonEnd))} are what the Strategist planned; later slots in the month come from the posting cadence and are labelled planned until the Strategist reaches them.`
    : `No calendar has been generated yet; every slot shown comes from the posting cadence and is labelled planned.`;
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Calendar · public, read-only</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="lede">What each page is scheduled to post and what has gone out. Captions appear here only after a post is published; drafts stay with the owner until then. Times are IST.</p>
      <div class="hero-actions"><a class="btn" href="${url("published/")}">See published posts</a><a class="btn btn-quiet" href="${url("pages/")}">Posting cadence per page</a></div>
    </div>
    <div class="hero-side">
      ${thisMonthList(view)}
    </div>
  </section>

  <section class="section">
    ${calendarGrid(view)}
    <p class="meta cal-note">${horizonNote}</p>
    <div class="trust-row legend" aria-label="Legend">
      <div><span class="k">planned</span><span class="s">a cadence slot; nothing written yet</span></div>
      <div><span class="k">in progress</span><span class="s">being written, rendered or checked</span></div>
      <div><span class="k">in review</span><span class="s">QA passed; waiting for the owner's approval</span></div>
      <div><span class="k">scheduled</span><span class="s">approved (or Autopilot), waiting for its time</span></div>
      <div><span class="k">published</span><span class="s">live; links to the Instagram post</span></div>
    </div>
  </section>`;
  return layout({ title: `Calendar · ${title}`, description: `${view.config.company.name} posting calendar for ${title}: planned, in progress, in review, scheduled and published slots per page (IST).`, path: "calendar/", body, year: view.year });
}
