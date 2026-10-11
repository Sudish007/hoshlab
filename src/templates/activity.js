// Activity: the last 50 run records from the current and previous month log files (review M9), one
// block per run with one line per agent step from agents[].note (design §11). 'No runs yet' when empty.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { formatIst, formatIstTime, monthName, previousMonth } from "../lib/dates.js";
import { chip, sectionHead, sideBox, timeTag } from "./partials.js";
import { agentTitle } from "./home.js";

const WORKFLOW_LABEL = { "engine-daily": "Daily engine run", "publisher-hourly": "Publisher run", "token-refresh": "Weekly token refresh" };
const TRIGGER_LABEL = { schedule: "scheduled", dispatch: "on demand", local: "local run" };

export function usd(n) {
  const v = Number(n) || 0;
  return v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2);
}

export function runBlock(view, run) {
  const label = WORKFLOW_LABEL[run.workflow] || run.workflow.replace(/-/g, " ");
  const failed = (run.agents || []).filter((a) => !a.ok);
  const lines = (run.agents || []).map((a) => {
    const cost = a.calls ? ` · ${a.calls} call${a.calls === 1 ? "" : "s"} · USD ${usd(a.costUsd)}` : "";
    const cls = [a.skipped ? "skipped" : "", a.ok ? "" : "failed"].filter(Boolean).join(" ");
    return `<li${cls ? ` class="${cls}"` : ""}><span class="actor">${escapeHtml(agentTitle(view, a.name))}</span><span>${escapeHtml(a.note || (a.skipped ? `skipped: ${a.skipped}` : "ok"))}${escapeHtml(cost)}</span></li>`;
  });
  const errors = (run.errors || []).map((e) => `<li class="failed"><span class="actor">error</span><span>${escapeHtml(e)}</span></li>`);
  return `<article class="run${run.ok ? "" : " run-failed"}" id="${escapeHtml(run.id)}">
      <header class="run-head">
        ${timeTag(run.startedAt, { text: formatIst(run.startedAt), cls: "when" })}
        <h2>${escapeHtml(label)}</h2>
        ${chip(TRIGGER_LABEL[run.trigger] || run.trigger)}${run.ok ? chip("completed", "ok") : chip("failed to load", "bad")}${failed.length ? chip(`${failed.length} step${failed.length === 1 ? "" : "s"} failed`, "bad") : ""}${run.dryRun ? chip("dry run", "warn") : ""}
        <span class="mono run-id">${escapeHtml(run.id)}</span>
      </header>
      <ul class="run-lines">
        ${lines.concat(errors).join("\n        ")}
      </ul>
      <p class="meta">Ended ${escapeHtml(formatIstTime(run.endedAt))} IST · ${(run.changed || []).length} file${(run.changed || []).length === 1 ? "" : "s"} changed · USD ${usd(run.budgetUsedUsd)} of the month budget used after this run</p>
    </article>`;
}

export function activityPage(view) {
  const months = [view.monthKey, previousMonth(view.monthKey)].map(monthName);
  const runs = view.runs;
  const byWorkflow = ["engine-daily", "publisher-hourly"].map((w) => {
    const mine = runs.filter((r) => r.workflow === w);
    const last = mine[0];
    return { k: WORKFLOW_LABEL[w], v: last ? `last ${formatIst(last.endedAt || last.startedAt)} · ${mine.length} run${mine.length === 1 ? "" : "s"} in the window` : "no runs yet", chip: last ? (last.ok && last.agents.every((a) => a.ok) ? "ok" : "check the log") : "", kind: last && !(last.ok && last.agents.every((a) => a.ok)) ? "bad" : "ok", plain: !last };
  });
  const failedSteps = runs.reduce((n, r) => n + (r.agents || []).filter((a) => !a.ok).length, 0);
  const rows = byWorkflow.concat([
    { k: "failed steps", v: runs.length ? `${failedSteps} in the last ${runs.length} run${runs.length === 1 ? "" : "s"}` : "no runs yet", plain: !runs.length },
    { k: "budget", v: view.usage.rows ? `USD ${view.usage.usedUsd.toFixed(2)} of ${view.usage.limitUsd} in ${monthName(view.monthKey)} · ${view.usage.calls} call${view.usage.calls === 1 ? "" : "s"}` : `no model calls yet in ${monthName(view.monthKey)}`, plain: !view.usage.rows },
  ]);
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Activity · run log</p>
      <h1>Every run, line by line.</h1>
      <p class="lede">One record per engine or publisher run from the run log (${escapeHtml(months.join(" and "))}), newest first. Each line is what an agent reported; failures stay in the log. Times are IST.</p>
      <div class="hero-actions"><a class="btn" href="${url("team/")}">Who does what</a><a class="btn btn-quiet" href="${url("calendar/")}">Calendar</a></div>
      <div class="trust-row" aria-label="What a run record holds">
        <div><span class="k">One record per run</span><span class="s">engine (${escapeHtml(view.config.schedule.engineLabel)}) and publisher (${escapeHtml(view.config.schedule.publisherLabel)})</span></div>
        <div><span class="k">One line per agent step</span><span class="s">what it did, what it skipped, what failed</span></div>
        <div><span class="k">Cost per step</span><span class="s">model calls and estimated USD, from the usage log</span></div>
      </div>
    </div>
    <div class="hero-side">
      ${sideBox("Summary", rows, { note: "Counted over the two most recent month files of the run log." })}
    </div>
  </section>

  <section class="section">
    ${sectionHead(runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : "Runs", { aside: `<span class="meta">${runs.length ? "newest first · times in IST" : "nothing logged yet"}</span>`, desc: runs.length ? `Showing the last ${runs.length} run${runs.length === 1 ? "" : "s"} across the two most recent month files.` : "The first engine run writes its record here." })}
    ${runs.length ? runs.map((r) => runBlock(view, r)).join("\n    ") : `<p class="empty">No runs yet.</p>`}
  </section>`;
  return layout({ title: "Activity", description: `${view.config.company.name} run log: what each agent did in the last engine and publisher runs.`, path: "activity/", body, year: view.year });
}
