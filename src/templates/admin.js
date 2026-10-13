// Owner-only admin page (dist/admin/index.html) — design §13, OF-1/OF-4/OF-5, review M2/M12/N1/N6/N13.
// ai-batkahi lock-screen pattern in English: static markup only, public/admin/admin.js toggles `hidden`,
// classes and dataset (never el.style), so the Content-Security-Policy below forbids inline styles and
// allows exactly one inline script — the layout's reduced PREPAINT, pinned by its sha256 hash (N13).
// Brand colours reach the markup only through data-page + dist/brands.css (M2). Not linked from any
// public page (OF-1); noindex. Every count shown after sign-in is computed in the browser from company/.
import { createHash } from "node:crypto";
import config from "../../site.config.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { layout, PREPAINT } from "./layout.js";
import { CHARTER_HEADINGS, CHARTER_MAX_CHARS } from "../lib/company.js";

export const WORKFLOWS = { engine: "engine-daily.yml", publisher: "publisher-hourly.yml", pages: "pages.yml" };

// The two consequence sentences per mode (engine/commands/set-page.js CONSEQUENCES, design §9 — binding).
export const MODE_CONSEQUENCES = {
  autopilot: ["Autopilot applies to drafts already in the queue: they post at their slots without an approval.", "Nothing posts without a QA pass; a reject on a draft still blocks it."],
  approve_first: ["Approve first stops unapproved posting immediately: only drafts with an approve record for their current revision post.", "Drafts already in the queue wait for your approval in the admin."],
};

export function adminCsp(siteOrigin) {
  const hash = createHash("sha256").update(PREPAINT, "utf8").digest("base64");
  return (
    `default-src 'self'; connect-src 'self' https://api.github.com https://raw.githubusercontent.com ${siteOrigin}; ` +
    "img-src 'self' data: blob: https://raw.githubusercontent.com; style-src 'self'; " +
    `script-src 'self' 'sha256-${hash}'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`
  );
}

// adminPage({ config: companyConfig, roster, year }) → HTML. `year` is the build clock's IST year (view.year),
// printed in the shared footer exactly like every public page.
export function adminPage({ config: company, roster, year }) {
  const { owner, name: repoName, branch } = config.repo;
  const siteOrigin = new URL(config.siteUrl).origin;
  const siteHost = new URL(config.siteUrl).host;
  const repoUrl = `https://github.com/${owner}/${repoName}`;
  const pages = company.pages;
  const agents = roster.agents.map((a) => a.name);
  const charters = Object.fromEntries(roster.agents.map((a) => [a.name, a.charter]));

  const adminConfig = JSON.stringify({
    owner,
    repo: repoName,
    branch,
    siteUrl: config.siteUrl,
    basePath: config.basePath,
    rawBase: `https://raw.githubusercontent.com/${owner}/${repoName}`,
    pages: pages.map((p) => ({ handle: p.handle, prefix: p.prefix, displayName: p.displayName, brandColor: p.brandColor, mode: p.mode, brand: p.brand })),
    agents,
    charters,
    workflows: { engine: WORKFLOWS.engine, publisher: WORKFLOWS.publisher, pages: WORKFLOWS.pages },
    caps: {
      captionMax: company.defaults.captionMax,
      hashtagCap: company.defaults.hashtagCap,
      altTextMax: company.defaults.altTextMax,
      minGapHours: company.defaults.minGapHours,
      expireAfterHours: company.defaults.expireAfterHours,
    },
    charter: { headings: CHARTER_HEADINGS, maxChars: CHARTER_MAX_CHARS },
    timezone: company.company.timezone,
    consequences: MODE_CONSEQUENCES,
  }).replace(/</g, "\\u003c");

  const handleLinks = pages.map((p) => `<a class="btn btn-quiet" href="#/brand/${escapeHtml(p.handle)}" data-brand-link="${escapeHtml(p.handle)}">@${escapeHtml(p.handle)}</a>`).join("");
  const agentLinks = agents.map((a) => `<a class="btn btn-quiet" href="#/charter/${escapeHtml(a)}" data-charter-link="${escapeHtml(a)}">${escapeHtml(a)}</a>`).join("");
  const jsonPaths = ["config.json", "roster.json", "state/status.json", "state/calendar.json", "state/approvals.jsonl", "state/overrides.jsonl", "state/feedback.jsonl", "state/published.jsonl", "state/ideas.jsonl", "state/hr/decisions.jsonl", ...pages.map((p) => p.brand.replace(/^company\//, ""))];

  const body = `<section class="hero" id="lock" aria-labelledby="lock-heading">
  <div>
    <p class="eyebrow">Admin · owner only</p>
    <h1>Sign in with a GitHub token.</h1>
    <p class="lede">The admin runs entirely in your browser. It talks to api.github.com with a fine-grained token scoped to this repository and loads artwork thumbnails from raw.githubusercontent.com without it. Approving a draft, switching a mode or running the engine now is a commit or a workflow dispatch — nothing else exists.</p>
    <div class="trust-row" aria-label="Security facts">
      <div><span class="k">No server, no database</span><span class="s">the token never leaves this browser</span></div>
      <div><span class="k">Instagram tokens stay in repository secrets</span><span class="s">the admin cannot read them</span></div>
      <div><span class="k">Reached by URL only</span><span class="s">nothing on the public site links here</span></div>
    </div>
    <div class="help mt-1" aria-labelledby="help-heading">
      <h3 id="help-heading" class="title-compact">Create the token</h3>
      <ol>
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" rel="noopener">github.com/settings/personal-access-tokens/new</a> (fine-grained token).</li>
        <li>Token name <span class="mono">hoshlab admin</span>; expiration 90 days or less.</li>
        <li>Repository access → Only select repositories → <span class="mono">${escapeHtml(owner)}/${escapeHtml(repoName)}</span>.</li>
        <li>Permissions: <strong>Contents</strong> → Read and write; <strong>Actions</strong> → Read and write (for Run now); nothing else.</li>
        <li>Generate, copy, paste it into the sign-in box.</li>
        <li>Keep it in a password manager; revoke it at <a href="https://github.com/settings/tokens" rel="noopener">github.com/settings/tokens</a> when you change devices.</li>
      </ol>
    </div>
  </div>
  <div class="hero-side">
    <div class="panel" aria-labelledby="signin-heading">
      <h3 id="signin-heading">Sign in</h3>
      <p class="form-error m-0" id="browser-notice" role="alert" hidden></p>
      <form id="signin" method="post" novalidate>
        <label for="token">GitHub token</label>
        <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
        <div class="check"><input id="remember" type="checkbox"><label for="remember">Remember on this device</label></div>
        <p class="meta">Unticked: the token lives in this tab only (sessionStorage). Ticked: localStorage, which every site on ${escapeHtml(siteHost)} can read — do not tick on a shared computer.</p>
        <div><button type="submit" class="btn btn-primary" id="signin-btn" disabled>Sign in</button></div>
        <p class="form-error m-0" role="alert" id="signin-error" hidden></p>
        <noscript><p class="meta">JavaScript is required for this page.</p></noscript>
      </form>
    </div>
    <div class="next-up" aria-label="After sign-in">
      <h2>After sign-in</h2>
      <ol>
        <li><span class="mono">1</span><span class="who plain">The token is checked for push access to the repository</span></li>
        <li><span class="mono">2</span><span class="who plain">Drafts, approvals, calendar and config load from company/state</span></li>
        <li><span class="mono">3</span><span class="who plain">Every action is one commit, shown in the activity log</span></li>
      </ol>
    </div>
  </div>
</section>
<section class="section lock-grid" id="lock-help">
  <div class="panel help security" aria-labelledby="sec-heading">
    <h3 id="sec-heading">Security</h3>
    <ul>
      <li>This page talks to api.github.com with your token and loads artwork thumbnails from raw.githubusercontent.com without it.</li>
      <li>Anyone using this browser profile can approve posts. Do not tick "Remember" on a shared computer; sign out when done.</li>
      <li>Revoke the token any time at <a href="https://github.com/settings/tokens" rel="noopener">github.com/settings/tokens</a>.</li>
      <li>All sites on ${escapeHtml(siteHost)} share one origin, so sessionStorage is the default.</li>
    </ul>
  </div>
  <div class="panel help" aria-labelledby="can-heading">
    <h3 id="can-heading">What the admin can do</h3>
    <ul>
      <li>Approve, edit, move or reject drafts in the queue (one commit each).</li>
      <li>Switch a page between Approve first and Autopilot — confirmed by typing the handle.</li>
      <li>Run the engine or the publisher now (a workflow dispatch on <span class="mono">${escapeHtml(branch)}</span>).</li>
      <li>Edit brand charters, agent charters and the roster with the engine's own validation; apply or dismiss HR's monthly roster proposals.</li>
      <li>Reached by its URL only; nothing on the public site links here.</li>
    </ul>
  </div>
  <div class="panel help limits" aria-labelledby="lim-heading">
    <h3 id="lim-heading">Limits</h3>
    <ul>
      <li>No server, no database; the token never leaves the browser.</li>
      <li>Instagram tokens live only in repository secrets — the admin cannot read them and cannot post directly.</li>
      <li>An approval takes effect on the next publisher run (${escapeHtml(company.schedule.publisherLabel)}; ${escapeHtml(company.schedule.actionsDelayNote)}).</li>
      <li>One owner; no roles, no comments. Analytics are Instagram's own media insights (reach, views, likes, comments, saves, shares at 48 h and 7 d), read by the Analyst on Sundays or on demand; the weekly reports are on the public site.</li>
    </ul>
  </div>
</section>
<section id="dashboard" class="section section-tight" hidden aria-labelledby="view-title">
  <div class="section-head">
    <div><p class="eyebrow">Admin · signed in</p><h1 id="view-title" class="h2">Approval queue</h1></div>
    <p class="meta" id="deploy-status" role="status"></p>
    <div class="q-actions"><button type="button" class="btn btn-quiet" id="reload">Reload</button><button type="button" class="btn btn-quiet" id="signout">Sign out</button></div>
  </div>
  <nav class="admin-tabs" aria-label="Admin sections">
    <a href="#/" data-view="queue">Queue <span class="chip chip-accent chip-plain" id="queue-count" hidden></span></a>
    <a href="#/blocked" data-view="blocked">Blocked</a>
    <a href="#/calendar" data-view="calendar">Calendar</a>
    <a href="#/modes" data-view="modes">Modes</a>
    <a href="#/run" data-view="run">Run now</a>
    <a href="#/brand/${escapeHtml(pages[0].handle)}" data-view="brand">Brands</a>
    <a href="#/roster" data-view="roster">Roster</a>
    <a href="#/charter/${escapeHtml(agents[0])}" data-view="charter">Charters</a>
    <a href="#/tell-ceo" data-view="tell-ceo">Tell the CEO</a>
    <a href="#/activity" data-view="activity">Activity</a>
    <a href="#/json/config.json" data-view="json">JSON</a>
  </nav>
  <p class="form-error" id="dash-error" role="alert" hidden></p>
  <p class="meta" id="loading" role="status" hidden>Loading company/state…</p>
  <!-- status.json flags as the same plain sentences the Home page prints (labels.js flagSentence), above every view -->
  <div class="flags" id="status-flags" role="status" aria-label="Status notes" hidden></div>

  <section id="view-queue" class="view" hidden aria-label="Approval queue">
    <p class="meta" id="queue-summary"></p>
    <ol id="queue" class="queue" aria-label="Drafts in the queue" aria-busy="false"></ol>
    <p class="empty" id="queue-empty" hidden>Nothing in the queue.</p>
  </section>

  <section id="view-blocked" class="view" hidden aria-labelledby="blocked-heading">
    <h2 id="blocked-heading" class="h3">Blocked, failed, expired</h2>
    <p class="meta">Drafts the engine stopped or that missed their slot, plus drafts you rejected. Nothing here posts; the Strategist frees or re-plans their slots.</p>
    <ol id="blocked" class="queue" aria-label="Blocked, failed, expired and rejected drafts"></ol>
    <p class="empty" id="blocked-empty" hidden>No blocked, failed, expired or rejected drafts.</p>
  </section>

  <section id="view-calendar" class="view" hidden aria-labelledby="cal-title">
    <div class="section-head"><h2 id="cal-title" class="h3">Calendar</h2><div class="q-actions"><button type="button" class="btn btn-quiet" id="cal-prev">‹ Previous month</button><button type="button" class="btn btn-quiet" id="cal-next">Next month ›</button></div></div>
    <div id="cal-grid" class="calendar" role="grid" aria-labelledby="cal-title"></div>
    <p class="meta cal-note">Click a slot to move it. Colours are each page's brand colour; labels are the public calendar's words. Published slots stay where they posted.</p>
  </section>

  <section id="view-modes" class="view" hidden aria-labelledby="modes-heading">
    <div class="panel">
      <h2 id="modes-heading" class="h3">Publishing mode per page</h2>
      <p class="meta">Approve first: nothing posts until you approve it here. Autopilot: every QA pass posts at its slot. Switching to Autopilot asks you to type the handle; switching back asks for a plain confirmation. Each switch is one commit to <span class="mono">company/config.json</span>.</p>
      <div id="mode-rows"></div>
    </div>
  </section>

  <section id="view-run" class="view" hidden aria-labelledby="run-heading">
    <div class="panel">
      <h2 id="run-heading" class="h3">Run now</h2>
      <p class="meta">Dispatches the workflow on <span class="mono">${escapeHtml(branch)}</span> (needs Actions: read and write on the token). The run's state and link appear below while it runs; the engine's own commits show on the site after its Pages deploy. "Run analyst" dispatches the engine with only the Analyst selected: Instagram insights for the posts live 48 h / 7 d, then this week's report (nothing is written while no post has insights yet).</p>
      <div class="q-actions"><button type="button" class="btn" id="run-engine">Run engine</button><button type="button" class="btn" id="run-publisher">Run publisher</button><button type="button" class="btn" id="run-analyst">Run analyst</button></div>
      <p class="meta" id="run-status" role="status"></p>
      <p class="meta"><a id="run-link" href="${repoUrl}/actions" rel="noopener" hidden>Open the Actions run</a></p>
    </div>
  </section>

  <section id="view-brand" class="view" hidden aria-labelledby="brand-heading">
    <div class="section-head"><h2 id="brand-heading" class="h3">Brand charter</h2><div class="q-actions" id="brand-links">${handleLinks}</div></div>
    <p class="meta">Edit <span class="mono" id="brand-path"></span> with the engine's validation: front matter keys, the Facts and Pricing tables (every row needs a <span class="mono">source</span> pointer <span class="mono">repo/path:line</span>), compiling Forbidden regexes, hex colours. Save is disabled while any error is listed. Disputed facts are unusable until you confirm them below.</p>
    <div class="editor-grid">
      <div>
        <label for="brand-text">brand.md</label>
        <textarea id="brand-text" rows="28" spellcheck="false" aria-describedby="brand-errors"></textarea>
        <ul id="brand-errors" class="errors" aria-live="polite"></ul>
        <div class="q-actions"><button type="button" class="btn btn-primary" id="brand-save" disabled>Save brand charter</button><span class="meta" id="brand-state"></span></div>
      </div>
      <div>
        <h3 class="title-compact">Facts</h3>
        <figure class="table-wrap"><figcaption class="meta">scroll →</figcaption>
          <table class="table" id="brand-facts"><thead><tr><th scope="col">id</th><th scope="col">fact</th><th scope="col">source</th><th scope="col">status</th><th scope="col">action</th></tr></thead><tbody></tbody></table>
        </figure>
      </div>
    </div>
  </section>

  <section id="view-roster" class="view" hidden aria-labelledby="roster-heading">
    <h2 id="roster-heading" class="h3">Roster</h2>
    <p class="meta">JSON editor for <span class="mono">company/roster.json</span> with the roster invariants: exactly the eight agents, <span class="mono">qa</span> and <span class="mono">publisher</span> cannot be removed or disabled, every language-model agent names an enabled provider and either inherits its configured model ladder or names one model, every agent keeps a non-empty never-list.</p>
    <label for="roster-text">roster.json</label>
    <textarea id="roster-text" rows="28" spellcheck="false" aria-describedby="roster-errors"></textarea>
    <ul id="roster-errors" class="errors" aria-live="polite"></ul>
    <div class="q-actions"><button type="button" class="btn btn-primary" id="roster-save" disabled>Save roster</button><span class="meta" id="roster-state"></span></div>
    <!-- HR proposals (FEAT-204, review N14 / plan D13): read from company/state/hr/proposals/, status from hr/decisions.jsonl; the admin never edits a proposal file -->
    <div class="panel" id="proposals" aria-labelledby="proposals-heading">
      <h3 id="proposals-heading">HR proposals</h3>
      <p class="meta">HR reviews every agent on the 1st of the month and writes a proposal into <span class="mono">company/state/hr/proposals/</span> once a month of runs exists. <strong>Apply</strong> writes the proposed values into <span class="mono">roster.json</span> (checked against the same invariants as the editor above) and appends the decision to <span class="mono">company/state/hr/decisions.jsonl</span>; <strong>Dismiss</strong> appends the decision only. The proposal files themselves are never edited here.</p>
      <ol id="proposal-list" class="proposals" aria-label="HR proposals" aria-busy="false"></ol>
      <p class="empty" id="proposals-empty" hidden>No HR proposals yet — HR reviews the roster on the 1st of each month once a month of runs exists.</p>
      <p class="form-error" id="proposals-error" role="alert" hidden></p>
    </div>
  </section>

  <section id="view-charter" class="view" hidden aria-labelledby="charter-heading">
    <div class="section-head"><h2 id="charter-heading" class="h3">Agent charter</h2><div class="q-actions" id="charter-links">${agentLinks}</div></div>
    <p class="meta">Markdown the agent receives as its system prompt. Required headings in order: ${CHARTER_HEADINGS.map((h) => `<span class="mono">${escapeHtml(h)}</span>`).join(", ")}; at most ${CHARTER_MAX_CHARS.toLocaleString("en-US")} characters.</p>
    <label for="charter-text"><span class="mono" id="charter-path"></span></label>
    <textarea id="charter-text" rows="28" spellcheck="false" aria-describedby="charter-errors"></textarea>
    <ul id="charter-errors" class="errors" aria-live="polite"></ul>
    <div class="q-actions"><button type="button" class="btn btn-primary" id="charter-save" disabled>Save charter</button><span class="meta" id="charter-state"></span></div>
  </section>

  <section id="view-tell-ceo" class="view" hidden aria-labelledby="note-heading">
    <div class="panel">
      <h2 id="note-heading" class="h3">Tell the CEO</h2>
      <p class="meta">A note the CEO reads before the next weekly memo and the Writer sees in its feedback digest (3–1000 characters). Appends one line to <span class="mono">company/state/feedback.jsonl</span>.</p>
      <label for="note-page">About</label>
      <select id="note-page"><option value="">the whole company</option>${pages.map((p) => `<option value="${escapeHtml(p.handle)}">@${escapeHtml(p.handle)}</option>`).join("")}</select>
      <label for="note-text">Note</label>
      <textarea id="note-text" rows="6"></textarea>
      <p class="meta" id="note-count">0 / 1000</p>
      <div class="q-actions"><button type="button" class="btn btn-primary" id="note-save" disabled>Send to the CEO</button><span class="meta" id="note-state"></span></div>
    </div>
  </section>

  <section id="view-activity" class="view" hidden aria-labelledby="activity-heading">
    <div class="admin-grid">
      <div>
        <h2 id="activity-heading" class="h3">Last runs</h2>
        <p class="meta">From <span class="mono">company/state/status.json</span> (the last 20 runs the engine recorded). The full monthly logs are on the public Activity page.</p>
        <ol id="last-runs" class="activity" aria-label="Last runs"></ol>
        <p class="empty" id="runs-empty" hidden>No runs yet.</p>
      </div>
      <div>
        <h3 class="title-compact">This session</h3>
        <ol id="activity-list" class="activity" aria-live="polite" aria-label="Session log"></ol>
      </div>
    </div>
  </section>

  <section id="view-json" class="view" hidden aria-labelledby="json-heading">
    <h2 id="json-heading" class="h3">Raw file</h2>
    <p class="meta">Any file under <span class="mono">company/</span>, as committed — the one place configuration tokens appear as written.</p>
    <form id="json-form" class="q-actions" novalidate>
      <label for="json-path" class="visually-hidden">Path under company/</label>
      <input id="json-path" type="text" list="json-paths" autocomplete="off" spellcheck="false" placeholder="state/status.json">
      <datalist id="json-paths">${jsonPaths.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("")}</datalist>
      <button type="submit" class="btn">Load</button>
    </form>
    <p class="meta" id="json-meta"></p>
    <pre id="json-out" class="json" tabindex="0"></pre>
  </section>
</section>

<template id="card-template">
  <li class="queue-item">
    <a class="thumb" rel="noopener" target="_blank" data-slot="open"><img alt="" width="1080" height="1350" loading="lazy" data-slot="img"><span class="thumb-missing" data-slot="img-missing" hidden>artwork not rendered yet</span></a>
    <div class="q-body">
      <div class="q-head" data-slot="head"></div>
      <h3 class="mono title-compact" data-slot="id"></h3>
      <p class="caption" data-slot="caption"></p>
      <div class="qa" data-slot="qa" aria-label="QA checks"></div>
      <p class="meta" data-slot="note"></p>
      <p class="meta" data-slot="reasons" hidden></p>
      <div class="q-actions" data-slot="actions"></div>
    </div>
  </li>
</template>

<dialog id="reject-dialog" class="admin-dialog" aria-labelledby="reject-heading">
  <form method="dialog" novalidate>
    <h2 id="reject-heading" class="h3">Reject with reason</h2>
    <p class="meta" id="reject-text"></p>
    <label for="reject-reason">Reason (3–500 characters) — the Writer reads it on its next draft for this page</label>
    <textarea id="reject-reason" rows="4" maxlength="500"></textarea>
    <p class="meta" id="reject-count">0 / 500</p>
    <p class="form-error" id="reject-error" role="alert" hidden></p>
    <div class="q-actions"><button type="submit" class="btn btn-danger" id="reject-go" value="ok" disabled>Reject</button><button type="button" class="btn" id="reject-cancel">Cancel</button></div>
  </form>
</dialog>

<dialog id="edit-dialog" class="admin-dialog admin-dialog-wide" aria-labelledby="edit-heading">
  <form method="dialog" novalidate>
    <h2 id="edit-heading" class="h3">Edit caption</h2>
    <p class="meta" id="edit-text"></p>
    <div class="editor-grid">
      <div>
        <label for="edit-caption">Caption (without the hashtag line)</label>
        <textarea id="edit-caption" rows="10"></textarea>
        <p class="meta" id="edit-caption-count"></p>
        <label for="edit-hashtags">Hashtags (space separated)</label>
        <input id="edit-hashtags" type="text" autocomplete="off" spellcheck="false">
        <ul id="edit-tags" class="chips-list" aria-label="Hashtags"></ul>
        <label for="edit-alt">Alt text</label>
        <input id="edit-alt" type="text" autocomplete="off">
        <p class="meta" id="edit-alt-count"></p>
      </div>
      <div>
        <h3 class="title-compact">Deterministic checks</h3>
        <ul id="edit-checks" class="qa" aria-live="polite"></ul>
        <h3 class="title-compact">Diff</h3>
        <pre id="edit-diff" class="diff" aria-label="Changes against the draft"></pre>
      </div>
    </div>
    <p class="form-error" id="edit-error" role="alert" hidden></p>
    <div class="q-actions"><button type="submit" class="btn btn-primary" id="edit-save" value="ok" disabled>Save edit</button><button type="button" class="btn" id="edit-cancel">Cancel</button></div>
  </form>
</dialog>

<dialog id="move-dialog" class="admin-dialog" aria-labelledby="move-heading">
  <form method="dialog" novalidate>
    <h2 id="move-heading" class="h3">Move slot</h2>
    <p class="meta" id="move-text"></p>
    <label for="move-at">New slot (IST)</label>
    <input id="move-at" type="datetime-local" step="60">
    <p class="meta" id="move-hint"></p>
    <p class="form-error" id="move-error" role="alert" hidden></p>
    <div class="q-actions"><button type="submit" class="btn btn-primary" id="move-go" value="ok" disabled>Move</button><button type="button" class="btn" id="move-cancel">Cancel</button></div>
  </form>
</dialog>

<dialog id="mode-dialog" class="admin-dialog confirm" aria-labelledby="mode-heading">
  <form method="dialog" novalidate>
    <h2 id="mode-heading" class="h3">Switch to Autopilot?</h2>
    <p class="m-0">${MODE_CONSEQUENCES.autopilot[0]}</p>
    <p class="m-0">${MODE_CONSEQUENCES.autopilot[1]}</p>
    <p class="meta m-0">You can switch back any time; the change is one commit to <span class="mono">company/config.json</span>.</p>
    <label for="mode-handle">Type the handle to confirm</label>
    <input id="mode-handle" type="text" autocomplete="off" spellcheck="false">
    <p class="form-error" id="mode-error" role="alert" hidden></p>
    <div class="q-actions"><button type="submit" class="btn btn-primary" id="mode-go" value="ok" disabled>Switch to Autopilot</button><button type="button" class="btn" id="mode-cancel">Cancel</button></div>
  </form>
</dialog>

<script type="application/json" id="admin-config">${adminConfig}</script>`;

  return layout({
    title: "Admin",
    description: "Hoshlab admin (owner only).",
    path: "admin/",
    body,
    year,
    mainClass: "container admin",
    noindex: true,
    mainJs: false,
    // The CSP must precede the inline pre-paint script it hashes, or the hash gates nothing.
    headStart: `<meta http-equiv="Content-Security-Policy" content="${adminCsp(siteOrigin)}">`,
    head: `<link rel="stylesheet" href="${url("admin/admin.css")}">`,
    foot: `<script type="module" src="${url("admin/admin.js")}"></script>`,
  });
}
