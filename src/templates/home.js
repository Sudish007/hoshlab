// Home (mock/index.html → real data). Every number is computed from the view; with no runs yet the
// status strip prints '—' in every cell and no digit (review M11), while "Next up" falls back to the
// next cadence slots labelled 'planned'. No admin link, no config token (OF-1, OF-5).
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { modeLabel, flagSentence, cadenceLine } from "../lib/labels.js";
import { formatIstDay, formatIstTime, formatIst, monthName } from "../lib/dates.js";
import { hi, chip, timeTag, sectionHead, hostOf, excerpt, numberWord, hasDevanagari, languagesLabel } from "./partials.js";

export function statusStrip(view) {
  const { config, status } = view;
  const cells = [];
  if (!view.hasRuns) {
    for (const k of ["Mode", "Engine", "Awaiting approval", "Month budget"]) {
      cells.push({ k, v: "—", s: "No runs yet" });
    }
  } else {
    const modes = config.pages.map((p) => ({ handle: p.handle, mode: view.modeOf(p.handle) }));
    const distinct = [...new Set(modes.map((m) => m.mode))];
    cells.push(
      distinct.length === 1
        ? { k: "Mode", v: modeLabel(distinct[0]), s: `all ${config.pages.length} pages · ${distinct[0] === "approve_first" ? "the owner reviews each draft" : "QA passes post on schedule"}` }
        : { k: "Mode", v: "Mixed", s: modes.map((m) => `@${m.handle} ${modeLabel(m.mode)}`).join(" · ") },
    );
    cells.push({ k: "Engine", v: config.schedule.engineLabel, s: `publisher ${config.schedule.publisherLabel} · ${config.schedule.actionsDelayNote}` });
    const n = view.awaiting.length;
    const perPage = config.pages.map((p) => ({ handle: p.handle, n: view.awaiting.filter((d) => d.page === p.handle).length })).filter((x) => x.n > 0);
    cells.push(n === 0 ? { k: "Awaiting approval", v: "—", s: "nothing waiting for the owner" } : { k: "Awaiting approval", v: `${n} draft${n === 1 ? "" : "s"}`, s: perPage.map((x) => `@${x.handle} ${x.n}`).join(" · ") });
    const u = view.usage;
    cells.push(
      u.rows === 0
        ? { k: "Month budget", v: "—", s: `No runs yet in ${monthName(u.month)}` }
        : { k: "Month budget", v: `USD ${u.usedUsd.toFixed(2)} of ${u.limitUsd}`, s: `${monthName(u.month)} · ${u.calls} call${u.calls === 1 ? "" : "s"} logged · ${u.providers.length} provider${u.providers.length === 1 ? "" : "s"}` },
    );
  }
  const flags = (status.flags || []).map((f) => `<p class="flag">${escapeHtml(flagSentence(f, { month: monthName(view.usage.month) }))}</p>`).join("\n");
  return `<div class="status-strip" aria-label="Company status">
        ${cells.map((c) => `<div><span class="k">${escapeHtml(c.k)}</span><span class="v">${escapeHtml(c.v)}</span><span class="s">${escapeHtml(c.s)}</span></div>`).join("\n        ")}
      </div>${flags ? `\n      <div class="flags" aria-label="Status notes">${flags}</div>` : ""}`;
}

export function nextUpList(view) {
  const items = view.nextUp.map((e) => {
    const label = e.label;
    const kind = label === "scheduled" || label === "published" ? "ok" : label === "in review" ? "warn" : "";
    const what = e.format === "image" ? "" : `${e.format} · `;
    return `<li data-page="${escapeHtml(e.page)}"${e.draftId ? ` data-draft="${escapeHtml(e.draftId)}"` : ""}>${timeTag(e.at, { text: `${formatIstDay(e.at)} · ${formatIstTime(e.at)}` })}<span class="who">@${escapeHtml(e.page)}</span>${chip(`${what}${label}`, kind)}</li>`;
  });
  const note = view.nextUpFromCadence
    ? `<p class="meta">From the posting cadence; the Strategist has not planned these slots yet.</p>`
    : view.nextUpPartlyCadence
      ? `<p class="meta">Later slots come from the posting cadence; the Strategist plans ${view.config.defaults.backlogWeeks} weeks ahead.</p>`
      : "";
  return `<div class="next-up" aria-label="Next scheduled posts">
        <h2>Next up</h2>
        <ol>
          ${items.join("\n          ")}
        </ol>${note}
      </div>`;
}

// Tagline fact: the usable fact whose text starts with 'Tagline' → its quoted strings.
export function taglineOf(brand) {
  const fact = brand.usableFacts().find((f) => /^Tagline\b/.test(f.fact));
  if (!fact) return [];
  return [...fact.fact.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function brandCard(view, page) {
  const brand = view.brands[page.handle];
  const fm = brand.frontMatter;
  const facts = brand.usableFacts();
  const confirmed = facts.filter((f) => f.status === "confirmed").length;
  const tagline = taglineOf(brand);
  const voice = brand.voice.bullets[0] || "";
  const pageStatus = view.status.pages && view.status.pages[page.handle];
  const last = pageStatus && pageStatus.lastPublishedAt ? `last published ${formatIstDay(pageStatus.lastPublishedAt)}` : "nothing published yet";
  const colours = Object.values(brand.tokens.colours).slice(0, 5);
  const name = fm.nameDevanagari ? `${escapeHtml(fm.name)} · <span lang="hi">${escapeHtml(fm.nameDevanagari)}</span>` : escapeHtml(fm.name);
  return `<article class="card page-card" data-page="${escapeHtml(page.handle)}">
        <p class="handle">@${escapeHtml(page.handle)} · ${escapeHtml(hostOf(fm.site))}</p>
        <h3>${name}</h3>
        ${tagline.length ? `<p class="meta">${tagline.map((t) => (hasDevanagari(t) ? `<span lang="hi">${escapeHtml(t)}</span>` : escapeHtml(t))).join(" · ")}</p>` : ""}
        <dl class="kv">
          <dt>Facts</dt><dd>${facts.length} usable · ${confirmed} confirmed</dd>
          <dt>Voice</dt><dd>${hi(excerpt(voice, 110))}</dd>
          <dt>Languages</dt><dd>${escapeHtml(languagesLabel(page.languages))}</dd>
          <dt>Cadence</dt><dd>${escapeHtml(cadenceLine(page, view.config.features))}</dd>
        </dl>
        <div class="swatches" aria-label="brand colours">${colours.map((_, i) => `<span class="sw sw-${i + 1}"></span>`).join("")}</div>
        <div class="card-foot">${chip(modeLabel(view.modeOf(page.handle)), "ok", { plain: false })}${chip(last)}<a class="btn btn-quiet" href="${url(`pages/${page.handle}/`)}">Brand charter →</a></div>
      </article>`;
}

// The Home excerpt lists the steps that ran (skipped rows stay on the Activity page, which prints every row).
export function activityLines(view, limit = 6) {
  if (!view.runs.length) return `<p class="empty">No runs yet.</p>`;
  const rows = [];
  for (const run of view.runs) {
    for (const a of run.agents || []) {
      if (!a.note || a.skipped) continue;
      rows.push({ at: run.endedAt || run.startedAt, actor: a.name, ok: a.ok, note: a.note, skipped: Boolean(a.skipped) });
      if (rows.length >= limit) break;
    }
    if (rows.length >= limit) break;
  }
  return `<ol class="activity">
      ${rows.map((r) => `<li>${timeTag(r.at, { text: `${formatIstDay(r.at)} ${formatIstTime(r.at)}` })}<span><span class="actor">${escapeHtml(agentTitle(view, r.actor))}</span>${r.ok ? "" : ' <span class="chip chip-bad chip-plain">failed</span>'} ${escapeHtml(r.note)}</span></li>`).join("\n      ")}
    </ol>`;
}

export function agentTitle(view, name) {
  const a = view.roster.agents.find((x) => x.name === name);
  return (a && a.title) || name;
}

export function homePage(view) {
  const { config } = view;
  const agents = view.roster.agents;
  const llm = agents.filter((a) => a.kind === "llm").length;
  const handles = config.pages.map((p) => `<strong>@${escapeHtml(p.handle)}</strong>`);
  const handleList = handles.length > 1 ? `${handles.slice(0, -1).join(", ")} and ${handles[handles.length - 1]}` : handles.join("");
  const lastRun = view.runs[0];
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">${escapeHtml(config.company.name)} · <span lang="hi">${escapeHtml(config.company.nameDevanagari)}</span></p>
      <h1>${escapeHtml(capitalize(numberWord(agents.length)))} AI agents run the Instagram pages for ${escapeHtml(numberWord(config.pages.length))} real products.</h1>
      <p class="lede">A CEO sets priorities, HR keeps the roster honest, and a Strategist, Writer, Designer, QA editor, Publisher and Analyst turn them into posts for ${handleList}. Everything runs on GitHub Actions; every draft, approval and published post is a file in this repository.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="${url("team/")}">Meet the team</a>
        <a class="btn" href="${url("published/")}">See published posts</a>
      </div>
      <div class="trust-row" aria-label="How this company stays honest">
        <div><span class="k">Facts only from the product repos</span><span class="s">every claim in a post points at a source line</span></div>
        <div><span class="k">Nothing posts silently</span><span class="s">each publish is a logged file with its permalink</span></div>
        <div><span class="k">Costs are visible</span><span class="s">every model call is logged; the month budget is a hard stop</span></div>
      </div>
    </div>
    <div class="hero-side">
      ${statusStrip(view)}
      ${nextUpList(view)}
    </div>
  </section>

  <section class="section" id="pages">
    ${sectionHead(`${capitalize(numberWord(config.pages.length))} pages, ${numberWord(config.pages.length)} real brands`, { more: { href: url("pages/"), text: "Brand charters →" }, desc: "Each page has a charter (brand.md) of facts, tokens and voice rules taken from the product's own repository; every line carries a source pointer, and the agents may use nothing else." })}
    <div class="grid grid-3">
      ${config.pages.map((p) => brandCard(view, p)).join("\n      ")}
    </div>
  </section>

  <section class="section" id="how">
    ${sectionHead("How a post happens", { more: { href: url("team/"), text: "Who does what →" }, desc: "Four hand-offs, each one a file in the repository: plan, make, check, ship. Nothing reaches Instagram without a QA pass, and in Approve first nothing reaches it without the owner." })}
    <div class="grid grid-4">
      <article class="card"><p class="eyebrow">1 · Plan</p><h3>CEO + Strategist</h3><p class="meta">The CEO memo sets this week's priorities per page; the Strategist turns them into an idea backlog and a calendar of slots.</p></article>
      <article class="card"><p class="eyebrow">2 · Make</p><h3>Writer + Designer</h3><p class="meta">Caption in the page's voice from brand.md facts only; artwork rendered with the product's real tokens (${config.features && config.features.reels ? "image, carousel and silent reel — kinetic type or the product's own screens" : "image and carousel; reels are not built yet"}).</p></article>
      <article class="card"><p class="eyebrow">3 · Check</p><h3>QA / Editor</h3><p class="meta">Blocks invented numbers, missing disclaimers, off-brand colours, text under the floor. A failed check goes back to the Writer, not to you.</p></article>
      <article class="card"><p class="eyebrow">4 · Ship</p><h3>Publisher + Analyst</h3><p class="meta">In Approve first, the Publisher waits for the owner's tick; in Autopilot it posts on schedule. The Analyst's insights are not built yet (phase 2).</p></article>
    </div>
  </section>

  <section class="section" id="activity">
    ${sectionHead("Recent activity", { more: { href: url("activity/"), text: "Full log →" }, desc: lastRun ? `The latest engine runs, line by line, from the run log. Last run ${escapeHtml(formatIst(lastRun.endedAt || lastRun.startedAt))}.` : "Lines from the run log appear here after the first engine run. Times are IST." })}
    ${activityLines(view)}
  </section>

  <section class="section" id="honesty">
    ${sectionHead("Honesty rules this company runs on", { desc: "These are enforced by code (QA checks, logs, budget stops), not by promises." })}
    <div class="grid grid-3">
      <article class="card"><h3>Facts only from brand.md</h3><p class="meta">Each page has a charter of verified facts taken from its own repository. Agents may not invent user counts, testimonials, ratings or metrics. QA rejects any number without a source line.</p></article>
      <article class="card"><h3>Nothing posts silently</h3><p class="meta">Every publish writes to <span class="mono">company/state/published.jsonl</span> and appears on the Published page with the Instagram permalink. Autopilot still logs; it only skips the wait.</p></article>
      <article class="card"><h3>Costs are visible</h3><p class="meta">Every model call is logged with provider, model, tokens and estimated cost. The month budget is a hard stop: drafting pauses when the budget is spent.</p></article>
    </div>
    <p class="meta">${escapeHtml(capitalize(numberWord(llm)))} of the ${escapeHtml(numberWord(agents.length))} roles run on a language model; the Designer and Publisher are deterministic code.</p>
  </section>`;
  return layout({ title: "", path: "", body, year: view.year });
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
