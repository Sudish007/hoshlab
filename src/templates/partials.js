// Shared markup: masthead, nav, footer and the small helpers every template uses. No admin link or
// the word "Admin" anywhere (design OF-1); no inline style attributes (review M2 — brand colours come
// from dist/brands.css through data-page); Devanagari runs are wrapped in <span lang="hi"> so the
// Noto Sans Devanagari face is used for them.
import config from "../../site.config.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { formatIst, isoIst } from "../lib/dates.js";

// The Hoshlab mark from the mock masthead (public/favicon.svg carries the same drawing).
export const MARK_SVG =
  '<svg class="mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="25" height="25" rx="5" fill="none" stroke="#17171A" stroke-width="2"/><path d="M8 20V8M8 14h12M20 20V8" fill="none" stroke="#17171A" stroke-width="2.4" stroke-linecap="round"/><circle cx="20" cy="20" r="2.6" fill="#2B4C7E"/></svg>';

export const NAV = [
  ["", "Home"],
  ["team/", "Team"],
  ["pages/", "Pages"],
  ["activity/", "Activity"],
  ["calendar/", "Calendar"],
  ["published/", "Published"],
  ["reports/", "Reports"],
  ["about/", "About"],
];

const DEVANAGARI_RUN = /([\u0900-\u097F\u1CD0-\u1CF9\uA8E0-\uA8FF][\u0900-\u097F\u1CD0-\u1CF9\uA8E0-\uA8FF\u200C\u200D\s.,!?।॥\-:;·]*)/g;

// Escapes text and wraps Devanagari runs in <span lang="hi">; a run never swallows Latin words.
export function hi(text) {
  const s = String(text ?? "");
  let out = "";
  let last = 0;
  for (const m of s.matchAll(DEVANAGARI_RUN)) {
    const run = m[0];
    const start = m.index;
    out += escapeHtml(s.slice(last, start));
    out += `<span lang="hi">${escapeHtml(run.trimEnd())}</span>${escapeHtml(run.slice(run.trimEnd().length))}`;
    last = start + run.length;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

// Same wrapping for already-rendered HTML (marked output): only text between tags is touched, nothing is
// re-escaped.
export function hiHtml(html) {
  return String(html ?? "")
    .split(/(<[^>]+>)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(DEVANAGARI_RUN, (run) => `<span lang="hi">${run.trimEnd()}</span>${run.slice(run.trimEnd().length)}`)))
    .join("");
}

export function hasDevanagari(text) {
  return /[\u0900-\u097F]/.test(String(text ?? ""));
}

export function chip(text, kind = "", { plain = true } = {}) {
  const classes = ["chip", kind ? `chip-${kind}` : "", plain ? "chip-plain" : ""].filter(Boolean).join(" ");
  return `<span class="${classes}">${hi(text)}</span>`;
}

export function timeTag(iso, { text, cls = "" } = {}) {
  return `<time${cls ? ` class="${cls}"` : ""} datetime="${escapeHtml(isoIst(iso))}">${escapeHtml(text || formatIst(iso))}</time>`;
}

export function masthead() {
  return `<a class="masthead" href="${url("")}">
      ${MARK_SVG}
      <span>${escapeHtml(config.title)}</span><span class="sub">an agentic content studio</span>
    </a>`;
}

// `path` is the page's site-relative path ('' for Home, 'pages/kaatdo/' for a detail page); a section
// is current for every page below it.
export function siteNav(path = "") {
  const items = NAV.map(([href, label]) => {
    const current = href === "" ? path === "" : path === href || path.startsWith(href);
    return `<li><a href="${url(href)}"${current ? ' aria-current="page"' : ""}>${label}</a></li>`;
  });
  return `<nav class="site-nav" aria-label="Main">
      <ul>
        ${items.join("\n        ")}
      </ul>
    </nav>`;
}

export function footer({ year }) {
  const repo = `https://github.com/${config.repo.owner}/${config.repo.name}`;
  return `<footer class="site-footer">
  <div class="container footer-inner">
    <p>© ${year} ${escapeHtml(config.title)} · ${escapeHtml(config.owner.owner)} · built on GitHub Pages + Actions</p>
    <ul><li><a href="${repo}" rel="noopener">Repository</a></li><li><a href="${url("feed.xml")}">Feed</a></li></ul>
  </div>
</footer>`;
}

// A hero right-column box in the "Next up" style: rows of { k (mono key), v (text), chip?, kind?, page?, html? }.
// Text is escaped here; pass html:true for a row whose `v` is already markup.
export function sideBox(title, rows, { label = title, note = "" } = {}) {
  const items = rows.map((r) => {
    const v = r.html ? r.v : hi(r.v);
    return `<li${r.page ? ` data-page="${escapeHtml(r.page)}"` : ""}><span class="mono">${escapeHtml(r.k)}</span><span class="who${r.plain ? " plain" : ""}">${v}</span>${r.chip ? chip(r.chip, r.kind || "") : ""}</li>`;
  });
  return `<div class="next-up" aria-label="${escapeHtml(label)}">
        <h2>${escapeHtml(title)}</h2>
        <ol>
          ${items.join("\n          ")}
        </ol>${note ? `<p class="meta">${note}</p>` : ""}
      </div>`;
}

export function sectionHead(title, { more = null, desc = "", id = "", level = 2, aside = "" } = {}) {
  const h = `h${level}`;
  return `<div class="section-head"${id ? ` id="${id}"` : ""}><${h}>${title}</${h}>${more ? `<a class="more" href="${more.href}">${escapeHtml(more.text)}</a>` : ""}${aside}${desc ? `<p class="desc">${desc}</p>` : ""}</div>`;
}

// Site host of a brand URL: 'https://kaatdo.com' → 'kaatdo.com'.
export function hostOf(site) {
  try {
    return new URL(String(site)).host.replace(/^www\./, "");
  } catch {
    return String(site ?? "");
  }
}

// Word-based excerpt (code points), ending with an ellipsis when cut.
export function excerpt(text, max = 90) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if ([...s].length <= max) return s;
  const cut = [...s].slice(0, max).join("");
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, "")}…`;
}

export const LANGUAGE_NAMES = { hi: "Hindi", en: "English" };

export function languagesLabel(codes) {
  return (codes || []).map((c) => LANGUAGE_NAMES[c] || c).join(" + ");
}

// Number words for the small counts the copy spells out ('Six of the eight roles …').
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export function numberWord(n) {
  return WORDS[n] ?? String(n);
}
