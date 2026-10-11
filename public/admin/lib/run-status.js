// GitHub Actions run classification for the "Run now" strip and the deploy line. Imports nothing.
// (ai-batkahi pattern in English; a dispatched run is matched by creation time, a commit by head_sha.)
const QUEUED = new Set(["queued", "waiting", "pending", "requested"]);

// classifyRun(run, { commitSha, since }) → { state, label, url }
//   commitSha  the run must be for this commit (push-triggered deploys)
//   since      ISO instant; the run must have been created at or after it (workflow_dispatch)
export function classifyRun(run, { commitSha = null, since = null } = {}) {
  const url = (run && run.html_url) || null;
  const matches = Boolean(run) && (commitSha === null || run.head_sha === commitSha) && (since === null || Date.parse(run.created_at || 0) >= Date.parse(since));
  if (!matches) return { state: "waiting", label: "run not started yet", url };
  if (QUEUED.has(run.status)) return { state: "queued", label: "queued", url };
  if (run.status === "in_progress") return { state: "in_progress", label: "running", url };
  if (run.status === "completed") {
    if (run.conclusion === "success") return { state: "success", label: "succeeded", url };
    return { state: "failure", label: `failed (${run.conclusion})`, url };
  }
  return { state: "queued", label: "queued", url };
}

export function relativeTime(iso, now = new Date()) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const mins = Math.round((now.getTime() - then.getTime()) / 60000);
  if (mins < 60) return `${Math.max(0, mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return then.toISOString().slice(0, 10);
}

// "Last <what>: succeeded · 5 min ago"; null when there is no run yet.
export function describeLatest(run, { what = "Pages deploy", now = new Date() } = {}) {
  if (!run) return null;
  let label = "running";
  if (run.status === "completed") label = run.conclusion === "success" ? "succeeded" : `failed (${run.conclusion})`;
  else if (QUEUED.has(run.status)) label = "queued";
  const when = relativeTime(run.updated_at || run.created_at, now);
  return { text: `Last ${what}: ${label}${when ? ` · ${when}` : ""}`, url: run.html_url || null, state: label };
}
