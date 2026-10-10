// One Instagram page: the brand charter as the public reads it — voice, usable facts with their status
// (never a disputed one), pricing "at the time of posting", disclaimers, allowed domains, cadence, mode
// and token state through labels.js. JobRez copy is checked by the build for the OF-2 tokens.
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { renderInline } from "../lib/markdown.js";
import { modeLabel, tokenStateLabel, cadenceLine } from "../lib/labels.js";
import { formatIst, formatIstDate } from "../lib/dates.js";
import { hi, hiHtml, chip, sectionHead, hostOf, languagesLabel, hasDevanagari } from "./partials.js";
import { taglineOf } from "./home.js";

const DOW_NAME = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function formatLine(format, config) {
  if (format === "image") return "image · 1080×1350 JPEG";
  if (format === "carousel") return "carousel · 2–10 slides, 1080×1350 each";
  if (format === "reel") return config.features && config.features.reels ? "reel · 1080×1920 MP4" : "reel · not built yet (phase 2)";
  return format;
}

function disclaimerLine(d) {
  const when = d.trigger === "always" ? "Every caption" : `When a caption mentions ${d.trigger.map((t) => `“${t}”`).join(", ")}, it`;
  const groups = d.fragments.map((alts) => alts.map((a) => `“${a}”`).join(" or ")).join(" and ");
  return `${when} must carry ${groups}.`;
}

export function pageDetail(view, page) {
  const { config, status } = view;
  const brand = view.brands[page.handle];
  const fm = brand.frontMatter;
  const facts = brand.usableFacts();
  const tagline = taglineOf(brand);
  const pageStatus = (status.pages && status.pages[page.handle]) || {};
  const tokenState = pageStatus.tokenState || "not_configured";
  const posts = view.posts.filter((p) => p.record.page === page.handle);
  const name = fm.nameDevanagari ? `${escapeHtml(fm.name)} · <span lang="hi">${escapeHtml(fm.nameDevanagari)}</span>` : escapeHtml(fm.name);
  const statusCounts = ["confirmed", "source-only"].map((s) => ({ s, n: facts.filter((f) => f.status === s).length })).filter((x) => x.n > 0);
  const disputed = brand.facts.length - facts.length;
  const body = `<section class="hero" data-page="${escapeHtml(page.handle)}">
    <div>
      <p class="eyebrow"><span class="as-is">@${escapeHtml(page.handle)} · ${escapeHtml(hostOf(fm.site))}</span></p>
      <div class="title-row">
        <h1 class="page-title">${name}</h1>
        <div class="title-chips" aria-label="Page settings">${chip(modeLabel(view.modeOf(page.handle)), "ok", { plain: false })}${chip(`Instagram token: ${tokenStateLabel(tokenState)}`, tokenState === "ok" ? "ok" : "warn")}${chip(cadenceLine(page, config.features))}</div>
      </div>
      ${tagline.length ? `<p class="lede">${tagline.map((t) => (hasDevanagari(t) ? `<span lang="hi">${escapeHtml(t)}</span>` : escapeHtml(t))).join(" · ")}</p>` : ""}
      <p class="lede">Everything the agents may say about ${escapeHtml(fm.name)} is on this page: the charter is a Markdown file in the repository, and every fact row points at a file and line in the product's own source.</p>
      <div class="hero-actions">
        <a class="btn" href="${escapeHtml(fm.site)}" rel="noopener">${escapeHtml(hostOf(fm.site))}</a>
        <a class="btn btn-quiet" href="${url(`published/?page=${page.handle}`)}">Published posts (${posts.length})</a>
      </div>
      <div class="trust-row" aria-label="How the charter is enforced">
        <div><span class="k">Facts need a source line</span><span class="s">a fact without a pointer into ${escapeHtml(fm.sourceRepo)} fails the build</span></div>
        <div><span class="k">QA runs the Forbidden list</span><span class="s">${brand.forbidden.length} patterns a caption may never match</span></div>
        <div><span class="k">Links only to</span><span class="s">${escapeHtml(brand.allowedDomains.join(", "))}</span></div>
      </div>
    </div>
    <div class="hero-side">
      <div class="next-up" aria-label="Charter summary">
        <h2>Charter</h2>
        <ol>
          <li><span class="mono">facts</span><span class="who">${facts.length} usable${statusCounts.length ? ` · ${statusCounts.map((x) => `${x.n} ${x.s}`).join(" · ")}` : ""}${disputed ? ` · ${disputed} disputed (hidden)` : ""}</span></li>
          <li><span class="mono">pricing</span><span class="who">${brand.pricing.length} row${brand.pricing.length === 1 ? "" : "s"}, quoted only “at the time of posting”</span></li>
          <li><span class="mono">languages</span><span class="who">${escapeHtml(languagesLabel(page.languages))}</span></li>
          <li><span class="mono">sources</span><span class="who">${fm.sourceVerifiedAt ? `verified ${escapeHtml(formatIstDate(`${fm.sourceVerifiedAt}T12:00:00+05:30`))} against ${escapeHtml(fm.sourceRepo)}` : `not verified yet (${escapeHtml(fm.sourceRepo)})`}</span></li>
          <li><span class="mono">last post</span><span class="who">${pageStatus.lastPublishedAt ? escapeHtml(formatIst(pageStatus.lastPublishedAt)) : "nothing published yet"}</span></li>
        </ol>
      </div>
    </div>
  </section>

  <section class="section" id="voice">
    ${sectionHead("Voice", { aside: `<span class="meta">${brand.voice.bullets.length} rules · from brand.md</span>`, desc: "How this page speaks. The Writer's prompt carries these lines verbatim; QA judges tone against them." })}
    <ul class="rules-list">
      ${brand.voice.bullets.map((b) => `<li>${hiHtml(renderInline(b))}</li>`).join("\n      ")}
    </ul>
  </section>

  <section class="section" id="facts">
    ${sectionHead("Usable facts", { desc: `${facts.length} facts the agents may use; each carries a source pointer into ${escapeHtml(fm.sourceRepo)} and a status. Disputed facts are not listed and cannot be used.` })}
    <ol class="facts-list">
      ${facts.map((f) => `<li><span class="mono fact-id">${escapeHtml(f.id)}</span>${chip(f.status, f.status === "confirmed" ? "ok" : "warn")}<p>${hi(f.fact)}</p></li>`).join("\n      ")}
    </ol>
  </section>

  <section class="section" id="pricing">
    ${sectionHead("Pricing", { desc: "The only prices a caption may quote, always with “at the time of posting”. Rows without a listed price are not configured yet." })}
    <ol class="facts-list">
      ${brand.pricing.map((p) => `<li><span class="mono fact-id">${escapeHtml(p.sku)}</span><p>${hi(p.price)}</p></li>`).join("\n      ")}
    </ol>
  </section>

  <section class="section" id="disclaimers">
    ${sectionHead("Disclaimers", { desc: "Required text fragments; QA fails a caption that triggers one and lacks it." })}
    ${brand.disclaimers.length ? `<ul class="rules-list">\n      ${brand.disclaimers.map((d) => `<li>${hi(disclaimerLine(d))}</li>`).join("\n      ")}\n    </ul>` : `<p class="meta">No mandatory disclaimer; the forbidden-word list does the guarding.</p>`}
  </section>

  <section class="section" id="cadence">
    ${sectionHead("Cadence and formats", { desc: `Posting slots in IST. The Strategist fills them with ideas; the Publisher posts at the slot time in ${escapeHtml(modeLabel(view.modeOf(page.handle)))} mode.` })}
    <div class="grid grid-3">
      <article class="card"><h3>Slots</h3><ul class="plain">${page.cadence.slots.map((s) => `<li><span class="mono">${DOW_NAME[s.dow]} ${escapeHtml(s.time)} IST</span> · ${escapeHtml(s.format)}</li>`).join("")}</ul></article>
      <article class="card"><h3>Formats</h3><ul class="plain">${page.formats.map((f) => `<li>${escapeHtml(formatLine(f, config))}</li>`).join("")}</ul></article>
      <article class="card"><h3>Allowed link domains</h3><ul class="plain">${brand.allowedDomains.map((d) => `<li><span class="mono">${escapeHtml(d)}</span></li>`).join("")}</ul><p class="meta">A caption may link nowhere else.</p></article>
    </div>
  </section>`;
  return layout({ title: `${fm.name} · @${page.handle}`, description: `Brand charter of @${page.handle} (${fm.name}): voice, ${facts.length} usable facts with sources, pricing, disclaimers and cadence.`, path: `pages/${page.handle}/`, body, year: view.year });
}
