// Team (mock/team.html → roster.json). Eight cards, each with the visible 'AI agent · <group>' eyebrow
// (OF-6); provider names through providerLabel (N5); the two deterministic roles say so in words (N4);
// phase-2 work is labelled 'not built yet'. "Last run" lines come from the run log, never invented.
import { layout } from "./layout.js";
import { escapeHtml } from "../lib/xml.js";
import { providerLabel } from "../lib/labels.js";
import { formatIst } from "../lib/dates.js";
import { chip, sectionHead, numberWord } from "./partials.js";
import { lastRunOf } from "../lib/view.js";

const GROUP_TITLE = { leadership: "Leadership", studio: "Studio", operations: "Operations" };

// Role copy (what each agent does, what it writes). Facts about schedule, provider, model, temperature
// and the never-list come from roster.json/config.json at build time.
const ROLE = {
  ceo: {
    monogram: "CEO",
    what: "Writes the weekly memo: priorities per page, what to push, what to pause, the budget split. Reads the owner's feedback first; the Analyst's report joins in phase 2.",
    output: "company/state/memos/YYYY-Www.md",
  },
  hr: {
    monogram: "HR",
    what: "Reviews every agent against its charter once a month: QA rejection rate, rework loops, cost per approved post. Proposes roster edits as a draft the owner approves.",
    output: "company/state/hr/YYYY-MM-review.md + roster proposal",
    phase2: "Monthly review: not built yet (phase 2)",
  },
  strategist: {
    monogram: "ST",
    what: "Turns the memo into ideas and slots: fills the backlog per page, assigns formats (image, carousel), places them on the calendar with a reason.",
    output: "ideas.jsonl, calendar.json",
  },
  writer: {
    monogram: "WR",
    what: "Caption, alt text, hashtags and carousel slide copy in the page's voice. Every factual claim must map to a fact id in brand.md.",
    output: "drafts/<id>/draft.json",
  },
  designer: {
    monogram: "DS",
    what: "Renders the artwork from the draft with the page's real tokens: 1080×1350 JPEG and carousel slides. Checks pixel size, bytes, glyph coverage, text floor and contrast before handing over.",
    output: "media/<id>/*.jpg",
  },
  qa: {
    monogram: "QA",
    what: "Twelve deterministic checks first (lengths, hashtags, disclaimers, forbidden words, media specs), then a model pass for tone and claims. Fails go back to the Writer with a reason; passes enter the queue.",
    output: "drafts/<id>/qa.json",
  },
  publisher: {
    monogram: "PB",
    what: "Posts approved drafts whose slot has arrived through the Instagram API. In Approve first it only takes items the owner ticked; in Autopilot it takes every QA pass. A dry-run client stands in during tests.",
    output: "published.jsonl (permalink, media id, time)",
  },
  analyst: {
    monogram: "AN",
    what: "Pulls insights per published post, writes the weekly report with what worked and what did not, and files findings the CEO must answer in the next memo.",
    output: "metrics/YYYY-MM.jsonl, reports/YYYY-Www.md",
    phase2: "Weekly insights: not built yet (phase 2)",
  },
};

function scheduleWord(agent, config) {
  switch (agent.schedule) {
    case "daily":
      return config.schedule.engineLabel;
    case "hourly":
      return config.schedule.publisherLabel;
    case "weekly-monday":
      return "Mondays";
    case "weekly-sunday":
      return "Sundays";
    case "monthly-1st":
      return "1st of the month";
    default:
      return agent.schedule;
  }
}

function acceptsTemperature(agent, config) {
  const provider = agent.provider && config.providers[agent.provider];
  const price = provider && provider.models && provider.models[agent.model];
  return !(price && price.acceptsTemperature === false);
}

export function agentCard(view, agent) {
  const { config } = view;
  const role = ROLE[agent.name] || { monogram: agent.name.slice(0, 2).toUpperCase(), what: "", output: "" };
  const foot = [];
  if (agent.kind === "llm") {
    foot.push(chip(`${providerLabel(agent.provider)} · ${agent.model}`));
    if (agent.temperature !== undefined && acceptsTemperature(agent, config)) foot.push(chip(`temperature ${agent.temperature}`));
    if (agent.fallback && agent.fallback.length) foot.push(chip(`fallback: ${agent.fallback.map(providerLabel).join(", ")}`));
  } else {
    foot.push(chip("deterministic code, no language model"));
  }
  const last = lastRunOf(view.runs, agent.name);
  foot.push(`<span>${last ? `last ran ${escapeHtml(formatIst(last.run.endedAt || last.run.startedAt))}${last.row.ok ? "" : " (failed)"}` : "not run yet"}</span>`);
  const never = agent.never.map((n) => escapeHtml(n)).join("; ");
  return `<article class="card agent" data-agent="${escapeHtml(agent.name)}">
        <div class="monogram" aria-hidden="true">${escapeHtml(role.monogram)}</div>
        <div class="body">
          <p class="ai-label">AI agent · ${escapeHtml(agent.group)}</p>
          <h3>${escapeHtml(agent.title || agent.name)}</h3>
          <p class="meta">${escapeHtml(role.what)}</p>
          <ul><li>Runs: ${escapeHtml(scheduleWord(agent, config))}</li><li>Output: <span class="mono">${escapeHtml(role.output)}</span></li>${role.phase2 ? `<li>${escapeHtml(role.phase2)}</li>` : ""}</ul>
          <p class="nots"><strong>Never:</strong> ${never}.</p>
        </div>
        <div class="foot">${foot.join("")}</div>
      </article>`;
}

export function teamPage(view) {
  const { config, roster } = view;
  const agents = roster.agents;
  const llm = agents.filter((a) => a.kind === "llm");
  const deterministic = agents.filter((a) => a.kind !== "llm");
  const providers = [...new Set(llm.map((a) => a.provider))];
  const byGroup = (g) => agents.filter((a) => a.group === g);
  const groupSummary = {
    leadership: { meta: "runs weekly (CEO) · monthly (HR)", desc: "Two agents that never touch a post directly: one decides what the studio should push each week, the other decides whether the studio itself is working." },
    studio: { meta: `runs ${config.schedule.engineLabel}`, desc: `The four agents that turn a memo into a finished, checked draft. A draft loops between Writer and QA at most ${numberWord(config.defaults.maxReworkLoops)} times before it is parked for the owner.` },
    operations: { meta: `publisher ${config.schedule.publisherLabel} · analyst weekly`, desc: "Shipping and measuring. The Publisher is deliberately not a language model; the Analyst only reports numbers it fetched from the Instagram API." },
  };
  const detNames = deterministic.map((a) => a.title || a.name);
  const detSentence = detNames.length > 1 ? `the ${detNames.slice(0, -1).join(", ")} and ${detNames[detNames.length - 1]} are deterministic code` : detNames.length === 1 ? `the ${detNames[0]} is deterministic code` : "none is deterministic code";
  const rhythm = [
    { when: config.schedule.engineLabel, who: agents.filter((a) => a.schedule === "daily").map((a) => a.title || a.name).join(" · "), what: "the engine run" },
    { when: config.schedule.publisherLabel, who: agents.filter((a) => a.schedule === "hourly").map((a) => a.title || a.name).join(" · "), what: "posts what is due and approved" },
    { when: "Mondays", who: agents.filter((a) => a.schedule === "weekly-monday").map((a) => a.title || a.name).join(" · "), what: "weekly memo" },
    { when: "Sundays", who: agents.filter((a) => a.schedule === "weekly-sunday").map((a) => a.title || a.name).join(" · "), what: "weekly report · not built yet (phase 2)" },
    { when: "1st of the month", who: agents.filter((a) => a.schedule === "monthly-1st").map((a) => a.title || a.name).join(" · "), what: "review + roster proposal · not built yet (phase 2)" },
  ].filter((r) => r.who);
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Team · ${escapeHtml(numberWord(agents.length))} AI agents</p>
      <h1>${escapeHtml(cap(numberWord(agents.length)))} roles, one roster file.</h1>
      <p class="lede">${escapeHtml(cap(numberWord(llm.length)))} of the ${escapeHtml(numberWord(agents.length))} roles run on a language model; ${escapeHtml(detSentence)}. Every role has a list of things it is never allowed to do. HR proposes changes to the roster once a month; the owner approves them like any other draft.</p>
      <div class="trust-row" aria-label="Roster facts">
        <div><span class="k">${agents.length} AI agents · 1 human owner</span><span class="s">the owner approves drafts, modes and roster changes</span></div>
        <div><span class="k">${providers.length} model providers</span><span class="s">${escapeHtml(providers.map(providerLabel).join(", "))}, assigned per role</span></div>
        <div><span class="k">Every role has a "never" list</span><span class="s">QA and the Publisher cannot be removed; nothing publishes without a QA pass</span></div>
      </div>
    </div>
    <div class="hero-side">
      <div class="org" aria-label="Reporting lines">
        <div class="row"><span class="lvl">Owner</span>${chip(`${config.company.owner} (human · approves, switches modes)`)}</div>
        ${["leadership", "studio", "operations"].map((g) => `<div class="row"><span class="lvl">${GROUP_TITLE[g]}</span>${byGroup(g).map((a) => chip(a.title || a.name, g === "leadership" ? "accent" : "")).join("")}</div>`).join("\n        ")}
        <div class="row"><span class="lvl">Rule</span><span class="meta">Every role is an AI agent; the owner is the only human in the loop.</span></div>
      </div>
    </div>
    <div class="trust-row cols-5 span-all" aria-label="Working rhythm">
      ${rhythm.map((r) => `<div><span class="mono when">${escapeHtml(r.when)}</span><span class="k">${escapeHtml(r.who)}</span><span class="s">${escapeHtml(r.what)}</span></div>`).join("\n      ")}
    </div>
  </section>

  ${["leadership", "studio", "operations"]
    .map(
      (g) => `<section class="section" id="${g}">
    ${sectionHead(GROUP_TITLE[g], { aside: `<span class="meta">${escapeHtml(groupSummary[g].meta)}</span>`, desc: escapeHtml(groupSummary[g].desc) })}
    <div class="grid grid-2">
      ${byGroup(g).map((a) => agentCard(view, a)).join("\n      ")}
    </div>
  </section>`,
    )
    .join("\n\n  ")}`;
  return layout({ title: "Team", description: `The ${numberWord(agents.length)} AI agents of ${config.company.name}: roles, providers, schedules and the things each one is never allowed to do.`, path: "team/", body, year: view.year });
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
