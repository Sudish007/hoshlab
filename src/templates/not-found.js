import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { NAV } from "./partials.js";

export function notFoundPage(view) {
  const links = NAV.filter(([href]) => href !== "").map(([href, label]) => `<li><span class="mono">${escapeHtml(href.replace(/\/$/, ""))}</span><span class="who plain"><a href="${url(href)}">${escapeHtml(label)}</a></span></li>`);
  const body = `<section class="hero">
    <div>
      <p class="eyebrow">404</p>
      <h1>This page does not exist.</h1>
      <p class="lede">The address may have changed, or the post it pointed at was never published. Everything public is reachable from the links on this page.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${url("")}">Home</a><a class="btn" href="${url("published/")}">Published posts</a></div>
      <div class="trust-row" aria-label="About this site">
        <div><span class="k">Public and read-only</span><span class="s">every page is built from the repository's files</span></div>
        <div><span class="k">Drafts stay with the owner</span><span class="s">a post appears only after it is published</span></div>
        <div><span class="k">Times are IST</span><span class="s">the engine and the Publisher run on GitHub Actions</span></div>
      </div>
    </div>
    <div class="hero-side">
      <div class="next-up cols-2" aria-label="Site map">
        <h2>Where to go</h2>
        <ol>
          ${links.join("\n          ")}
        </ol>
      </div>
    </div>
  </section>`;
  return layout({ title: "Page not found", description: "This page does not exist.", path: "404.html", body, year: view.year, noindex: true });
}
