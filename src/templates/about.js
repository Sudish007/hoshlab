// About: what Hoshlab is, the honesty rules, the limits, and the plain statement that drafts are public
// (design §16, §18). Numbers come from config/roster; nothing is promised that is not built.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { modeLabel, providerLabel } from "../lib/labels.js";
import { sectionHead, sideBox, numberWord } from "./partials.js";

export function aboutPage(view) {
  const { config, roster } = view;
  const reelsOn = Boolean(config.features && config.features.reels);
  const repo = `https://github.com/${config.repo.owner}/${config.repo.name}`;
  const agents = roster.agents.length;
  const pages = config.pages.length;
  const providers = [...new Set(roster.agents.filter((a) => a.kind === "llm").map((a) => a.provider))];
  const rows = [
    { k: "agents", v: `${agents} AI agents · 1 human owner`, plain: true },
    { k: "pages", v: config.pages.map((p) => `@${p.handle}`).join(" · "), plain: true },
    { k: "providers", v: providers.map(providerLabel).join(", "), plain: true },
    { k: "engine", v: `${config.schedule.engineLabel} · publisher ${config.schedule.publisherLabel}`, plain: true },
    { k: "budget", v: `USD ${config.budget.monthlyUsd} per month, hard stop`, plain: true },
    { k: "hosting", v: "GitHub Pages + GitHub Actions, no server", plain: true },
  ];
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">About · ${escapeHtml(config.company.name)} · <span lang="hi">${escapeHtml(config.company.nameDevanagari)}</span></p>
      <h1>An agentic company, run as files in a public repository.</h1>
      <p class="lede">${escapeHtml(config.company.name)} is ${escapeHtml(numberWord(agents))} AI agents and one human owner (${escapeHtml(config.company.owner)}) running the Instagram pages of ${escapeHtml(numberWord(pages))} real products. The agents run inside GitHub Actions on a schedule; every idea, draft, approval, run and published post is a JSON, JSONL or Markdown file in <a href="${repo}" rel="noopener">the repository</a>; this site is built from those files on every push.</p>
      <div class="hero-actions"><a class="btn" href="${url("team/")}">Meet the team</a><a class="btn btn-quiet" href="${repo}" rel="noopener">Repository</a></div>
      <div class="trust-row" aria-label="How the company is run">
        <div><span class="k">Everything is a file</span><span class="s">ideas, drafts, approvals, runs and posts live in company/</span></div>
        <div><span class="k">One human in the loop</span><span class="s">the owner approves drafts, modes and roster changes</span></div>
        <div><span class="k">No servers, no database</span><span class="s">GitHub Actions runs the agents; GitHub Pages serves this site</span></div>
      </div>
    </div>
    <div class="hero-side">
      ${sideBox("In numbers", rows, { note: "From config.json and roster.json at build time." })}
    </div>
  </section>

  <section class="section" id="honesty">
    ${sectionHead("Honesty rules", { aside: `<span class="meta">enforced by QA checks, logs and budget stops</span>`, desc: "Enforced by code, not by promises. The same rules apply to this site, which prints only what the state files contain." })}
    <div class="grid grid-3">
      <article class="card"><h3>Facts only from brand.md</h3><p class="meta">Every fact an agent may use sits in a brand charter with a pointer to a file and line in the product's own repository. Nothing about user counts, testimonials or ratings exists in any charter, so none can be written.</p></article>
      <article class="card"><h3>Nothing posts without QA</h3><p class="meta">Twelve deterministic checks and a model review run on every draft. In ${escapeHtml(modeLabel("approve_first"))} nothing posts without the owner; in ${escapeHtml(modeLabel("autopilot"))} every QA pass posts at its slot and is still logged.</p></article>
      <article class="card"><h3>Costs are visible</h3><p class="meta">Every model call is logged with provider, model, tokens and estimated cost. The month budget (USD ${escapeHtml(String(config.budget.monthlyUsd))}) is a hard stop: drafting pauses when it is spent.</p></article>
      <article class="card"><h3>Human labels, real numbers</h3><p class="meta">Every number on this site is computed from the state files at build time. Anything not built yet says so: ${reelsOn ? "" : "reels, "}weekly reports and the monthly HR review are phase 2.</p></article>
      <article class="card"><h3>One cadence everywhere</h3><p class="meta">The engine runs ${escapeHtml(config.schedule.engineLabel)}; the Publisher runs ${escapeHtml(config.schedule.publisherLabel)}. ${escapeHtml(config.schedule.actionsDelayNote)}.</p></article>
      <article class="card"><h3>Nothing confidential in the repository</h3><p class="meta">Secrets live only in GitHub Actions repository secrets and the owner's local environment. The company folder holds no keys, no tokens and no personal data.</p></article>
    </div>
  </section>

  <section class="section" id="limits">
    ${sectionHead("Limits", { desc: "Known constraints of running a company on GitHub Pages and Actions." })}
    <ul class="rules-list">
      <li><strong>Drafts are public.</strong> The repository is public, so unpublished drafts, QA notes and rejected ideas are readable by anyone who looks at <span class="mono">company/state/</span>. The owner's approval controls what posts, not what is visible in the repository.</li>
      <li><strong>Schedules drift.</strong> ${escapeHtml(config.schedule.actionsDelayNote)}; top-of-hour schedules can be later than that on busy days. A slot posts in the first Publisher run at or after its time.</li>
      <li><strong>Instagram quotas apply.</strong> Instagram caps how many posts an account may publish per day; the Publisher reads the live quota before every post and waits when it is near the cap.</li>
      <li><strong>Tokens expire.</strong> Long-lived Instagram tokens expire after 60 days and are regenerated by the owner until the refresh job exists (phase 2). A page whose token is invalid pauses and the Home page says so.</li>
      ${reelsOn ? `<li><strong>Reels are silent and rendered, not filmed.</strong> A kinetic reel types the Writer's lines over the brand background; a capture reel shows the product's own public pages inside a phone frame with a caption per scene. Both are 1080×1920 H.264, 15–30 seconds, checked with ffprobe before QA sees them; a product site that does not answer leaves the draft waiting instead of inventing a screen.</li>` : ""}
      <li><strong>Not built yet.</strong> ${reelsOn ? "The Analyst's weekly insights and reports, and HR's monthly review" : "Reels, the Analyst's weekly insights and reports, and HR's monthly review"} are phase 2. This site labels each of them as such rather than showing placeholders.</li>
    </ul>
  </section>

  <section class="section" id="built">
    ${sectionHead("How it is built", { desc: "Plain Node, no framework. The same repository holds the company, the agents and this site." })}
    <ul class="rules-list">
      <li><p>Engine: Node ESM agents with plain fetch adapters for the three model providers; one JSON-only envelope per call; every state write is validated against a schema first.</p></li>
      <li><p>Site: a static build to GitHub Pages at <a href="${escapeHtml(config.site.url)}">${escapeHtml(config.site.url.replace(/^https?:\/\//, ""))}</a>; self-hosted Inter and Noto Sans Devanagari; light theme only; 12 px text floor; 44 px controls.</p></li>
      <li><p>Owner: ${escapeHtml(config.company.owner)} (<a href="https://github.com/${escapeHtml(config.company.ownerGithub)}" rel="noopener">@${escapeHtml(config.company.ownerGithub)}</a> on GitHub) approves drafts, switches each page between ${escapeHtml(modeLabel("approve_first"))} and ${escapeHtml(modeLabel("autopilot"))}, and edits the brand charters and the roster.</p></li>
    </ul>
    <p class="meta"><a href="${url("feed.xml")}">Atom feed of published posts</a> · <a href="${repo}" rel="noopener">Repository</a></p>
  </section>`;
  return layout({ title: "About", description: `What ${config.company.name} is, the honesty rules it runs on, its limits, and how it is built.`, path: "about/", body, year: view.year });
}
