// Pages index: the three Instagram pages as brand cards (same card as Home) plus how a charter works.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { modeLabel } from "../lib/labels.js";
import { brandCard } from "./home.js";
import { sectionHead, sideBox, numberWord, languagesLabel } from "./partials.js";

export function pagesIndexPage(view) {
  const { config } = view;
  const n = config.pages.length;
  const rows = config.pages.map((p) => {
    const b = view.brands[p.handle];
    const facts = b.usableFacts();
    return { k: `@${p.handle}`, v: `${facts.length} usable facts · ${b.pricing.length} pricing rows · ${languagesLabel(p.languages)}`, chip: modeLabel(view.modeOf(p.handle)), page: p.handle };
  });
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">Pages · ${escapeHtml(numberWord(n))} Instagram pages</p>
      <h1>${escapeHtml(cap(numberWord(n)))} pages, ${escapeHtml(numberWord(n))} real products, one rule book each.</h1>
      <p class="lede">Every page is described by a brand charter (brand.md) in this repository: voice rules, a fact table where each row points at a file and line in the product's own repository, the price list, the disclaimers QA enforces, the allowed link domains and the posting cadence. Agents may use nothing that is not in the charter.</p>
      <div class="hero-actions"><a class="btn" href="${url("calendar/")}">Posting calendar</a><a class="btn btn-quiet" href="${url("published/")}">Published posts</a></div>
    </div>
    <div class="hero-side">
      ${sideBox("Charters", rows, { note: "Facts are counted after the owner's disputed rows are removed; a disputed fact is never usable." })}
    </div>
  </section>

  <section class="section">
    ${sectionHead("The pages", { more: { href: url("calendar/"), text: "Posting calendar →" }, desc: "Open a page to read its charter: the facts the agents may use (with their status), the prices they may quote, and the words they must never write." })}
    <div class="grid grid-3">
      ${config.pages.map((p) => brandCard(view, p)).join("\n      ")}
    </div>
  </section>

  <section class="section">
    ${sectionHead("How a charter works", { desc: "A fact is usable only when its source pointer resolves and the owner has not disputed it; a disputed fact never appears on this site or in a post." })}
    <div class="grid grid-3">
      <article class="card"><h3>Facts with sources</h3><p class="meta">Each fact row carries a <span class="mono">repo/path:line</span> pointer into the product's repository. The owner re-verifies them locally; the build fails if a pointer is malformed.</p></article>
      <article class="card"><h3>Status, not opinion</h3><p class="meta">A fact is <em>confirmed</em> when it is the product's own copy, <em>source-only</em> when it exists in code or docs but is not yet owner-confirmed as marketing-safe, and <em>disputed</em> when the owner flagged it — disputed facts are unusable.</p></article>
      <article class="card"><h3>Prices at the time of posting</h3><p class="meta">A price may be quoted only from the charter's pricing table and only with "at the time of posting". Nothing about user counts, testimonials or ratings exists in any charter, so none can be written.</p></article>
    </div>
  </section>`;
  return layout({ title: "Pages", description: `The ${numberWord(n)} Instagram pages ${config.company.name} runs and the brand charters behind them.`, path: "pages/", body, year: view.year });
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
