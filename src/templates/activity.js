// Activity: the last 50 run records from the current and previous month log files (review M9), one
// block per run with one line per agent step from agents[].note (design §11). 'No runs yet' when empty.
// The page names only the month files that exist (view.runMonths): never a month without a file.
// Money is always billed spend; free-tier usage adds the recorded paid-rate equivalent (polish-gemini).
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { spendLabel, usdLabel } from "../lib/labels.js";
import { formatIst, formatIstTime, monthName } from "../lib/dates.js";
import { chip, sectionHead, sideBox, timeTag } from "./partials.js";
import { agentTitle } from "./home.js";

const WORKFLOW_LABEL = { "engine-daily": "Daily engine run", "publisher-hourly": "Publisher run", "token-refresh": "Weekly token refresh" };
const TRIGGER_LABEL = { schedule: "scheduled", dispatch: "on demand", local: "local run" };

// Kept as a small exported formatting primitive for callers/tests that need the numeric part only.
export function usd(n) {
  return usdLabel(n).slice(4);
}

function sum(rows, field) {
  return Math.round(rows.reduce((total, row) => total + (Number.isFinite(row && row[field]) ? row[field] : 0), 0) * 1e6) / 1e6;
}

function paidSum(rows) {
  return Math.round(rows.reduce((total, row) => total + (Number.isFinite(row && row.paidEquivalentUsd) ? row.paidEquivalentUsd : Number.isFinite(row && row.costUsd) ? row.costUsd : 0), 0) * 1e6) / 1e6;
}

// Spend of one agent row. Presence of paidEquivalentUsd is the durable free-tier marker; zero-token failures
// therefore still say free tier rather than being guessed from today's provider config.
export function agentSpend(view, run, agent) {
  const rows = ((view.usage && view.usage.lines) || []).filter((u) => u.runId === run.id && u.agent === agent.name);
  const hasFreeTierUsage = rows.some((u) => Number.isFinite(u.paidEquivalentUsd)) || Number.isFinite(agent.paidEquivalentUsd);
  return {
    billedUsd: Number.isFinite(agent.costUsd) ? agent.costUsd : sum(rows, "costUsd"),
    paidEquivalentUsd: Number.isFinite(agent.paidEquivalentUsd) ? agent.paidEquivalentUsd : rows.length ? paidSum(rows) : Number(agent.costUsd) || 0,
    hasFreeTierUsage,
  };
}

// Cumulative month spend after this run. New run records carry budgetPaidEquivalentUsd; for fixture/older records,
// current-month usage rows can reconstruct it without rewriting history.
export function runSpend(view, run) {
  const lines = (view.usage && view.usage.lines) || [];
  const rows = lines.filter((u) => String(u.at) <= String(run.endedAt));
  const hasFreeTierUsage = Number.isFinite(run.budgetPaidEquivalentUsd) || rows.some((u) => Number.isFinite(u.paidEquivalentUsd));
  return {
    billedUsd: Number(run.budgetUsedUsd) || 0,
    paidEquivalentUsd: Number.isFinite(run.budgetPaidEquivalentUsd) ? run.budgetPaidEquivalentUsd : rows.length ? paidSum(rows) : Number(run.budgetUsedUsd) || 0,
    hasFreeTierUsage,
  };
}

export function runBlock(view, run) {
  const label = WORKFLOW_LABEL[run.workflow] || run.workflow.replace(/-/g, " ");
  const failed = (run.agents || []).filter((a) => !a.ok);
  const lines = (run.agents || []).map((a) => {
    const cost = a.calls ? ` · ${a.calls} call${a.calls === 1 ? "" : "s"} · ${spendLabel(agentSpend(view, run, a))}` : "";
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
      <p class="meta">Ended ${escapeHtml(formatIstTime(run.endedAt))} IST · ${(run.changed || []).length} file${(run.changed || []).length === 1 ? "" : "s"} changed · ${escapeHtml(spendLabel(runSpend(view, run)))} of the month budget used after this run</p>
    </article>`;
}

// The run-log files the page was built from, as words: '(October 2026 and September 2026)' with two files,
// '(October 2026)' with one, '' with none; 'the two most recent month files' / 'the most recent month file' / 'no month file yet'.
export function monthFilesWords(runMonths) {
  const months = (runMonths || []).map(monthName);
  return {
    list: months.length ? ` (${months.join(" and ")})` : "",
    files: months.length > 1 ? "the two most recent month files" : months.length === 1 ? "the most recent month file" : "no month file yet",
  };
}

export function activityPage(view) {
  const monthFiles = monthFilesWords(view.runMonths);
  const runs = view.runs;
  const byWorkflow = ["engine-daily", "publisher-hourly"].map((w) => {
    const mine = runs.filter((r) => r.workflow === w);
    const last = mine[0];
    return { k: WORKFLOW_LABEL[w], v: last ? `last ${formatIst(last.endedAt || last.startedAt)} · ${mine.length} run${mine.length === 1 ? "" : "s"} in the window` : "no runs yet", chip: last ? (last.ok && last.agents.every((a) => a.ok) ? "ok" : "check the log") : "", kind: last && !(last.ok && last.agents.every((a) => a.ok)) ? "bad" : "ok", plain: !last };
  });
  const failedSteps = runs.reduce((n, r) => n + (r.agents || []).filter((a) => !a.ok).length, 0);
  const rows = byWorkflow.concat([
    { k: "failed steps", v: runs.length ? `${failedSteps} in the last ${runs.length} run${runs.length === 1 ? "" : "s"}` : "no runs yet", plain: !runs.length },
    { k: "budget", v: view.usage.rows ? `${spendLabel({ billedUsd: view.usage.usedUsd, paidEquivalentUsd: view.usage.paidEquivalentUsd, hasFreeTierUsage: view.usage.hasFreeTierUsage })} of ${usdLabel(view.usage.limitUsd)} in ${monthName(view.monthKey)} · ${view.usage.calls} call${view.usage.calls === 1 ? "" : "s"}` : `no model calls yet in ${monthName(view.monthKey)}`, plain: !view.usage.rows },
  ]);
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Activity · run log</p>
      <h1>Every run, line by line.</h1>
      <p class="lede">One record per engine or publisher run from the run log${escapeHtml(monthFiles.list)}, newest first. Each line is what an agent reported; failures stay in the log. Times are IST.</p>
      <div class="hero-actions"><a class="btn" href="${url("team/")}">Who does what</a><a class="btn btn-quiet" href="${url("calendar/")}">Calendar</a></div>
      <div class="trust-row" aria-label="What a run record holds">
        <div><span class="k">One record per run</span><span class="s">engine (${escapeHtml(view.config.schedule.engineLabel)}) and publisher (${escapeHtml(view.config.schedule.publisherLabel)})</span></div>
        <div><span class="k">One line per agent step</span><span class="s">what it did, what it skipped, what failed</span></div>
        <div><span class="k">Cost per step</span><span class="s">billed USD and free-tier paid-rate equivalents, from the usage log</span></div>
      </div>
    </div>
    <div class="hero-side">
      ${sideBox("Summary", rows, { note: monthFiles.files === "no month file yet" ? "The run log has no month file yet." : `Counted over ${monthFiles.files} of the run log${monthFiles.list}.` })}
    </div>
  </section>

  <section class="section">
    ${sectionHead(runs.length ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : "Runs", { aside: `<span class="meta">${runs.length ? "newest first · times in IST" : "nothing logged yet"}</span>`, desc: runs.length ? `Showing the last ${runs.length} run${runs.length === 1 ? "" : "s"} across ${monthFiles.files}${monthFiles.list}.` : "The first engine run writes its record here." })}
    ${runs.length ? runs.map((r) => runBlock(view, r)).join("\n    ") : `<p class="empty">No runs yet.</p>`}
  </section>`;
  return layout({ title: "Activity", description: `${view.config.company.name} run log: what each agent did in the last engine and publisher runs.`, path: "activity/", body, year: view.year });
}
