// Page shell (ai-batkahi pattern, reduced for Hoshlab): lang="en", light theme only, one inline
// pre-paint script that only marks html.js (review N13 — still sha256-pinned by the admin CSP),
// a skip link, the masthead + wrapping nav (OF-8) and the footer. No admin link or text anywhere
// (OF-1), no command palette, no theme toggle.
import { createHash } from "node:crypto";
import config from "../../site.config.js";
import { url, absUrl } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { preloadUrls } from "../lib/fonts.js";
import { masthead, siteNav, footer } from "./partials.js";

export const PREPAINT = 'document.documentElement.classList.add("js");';
export const PREPAINT_SHA256 = createHash("sha256").update(PREPAINT, "utf8").digest("base64");

export const DESCRIPTION = "Hoshlab is an agentic company: eight AI agents and one human owner run the Instagram pages of three real products on GitHub Actions and GitHub Pages.";

export function layout({
  title,
  description = DESCRIPTION,
  path, // site-relative path e.g. "team/" (canonical/og:url and the nav's current item)
  body,
  year,
  noindex = false,
  mainClass = "container",
  bodyData = "", // extra attributes on <body> (e.g. data-page="published")
  headStart = "", // <head> markup emitted BEFORE the inline pre-paint script (admin: CSP meta)
  head = "", // extra <head> markup, emitted after brands.css (admin: admin.css)
  foot = "", // extra end-of-body markup, emitted after main.js (admin: module script)
  mainJs = true,
}) {
  const fullTitle = title ? `${title} · ${config.title}` : `${config.title} · an agentic content studio`;
  const canonical = absUrl(path);
  const preloads = preloadUrls()
    .map((f) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${url(f)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${canonical}">`}
<meta property="og:site_name" content="${escapeHtml(config.title)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title || config.title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${absUrl("og-default.png")}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(config.title)} — an agentic content studio">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#FBFBF8">
<link rel="alternate" type="application/atom+xml" title="${escapeHtml(config.title)} — published posts" href="${url("feed.xml")}">
<link rel="icon" href="${url("favicon.svg")}" type="image/svg+xml">
<link rel="icon" href="${url("favicon.ico")}" sizes="32x32">
<link rel="apple-touch-icon" href="${url("apple-touch-icon.png")}">
${headStart ? `${headStart}\n` : ""}<script>${PREPAINT}</script>
${preloads}
<link rel="stylesheet" href="${url("styles.css")}">
<link rel="stylesheet" href="${url("brands.css")}">
${head ? `${head}\n` : ""}</head>
<body${bodyData ? ` ${bodyData}` : ""}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="container header-inner">
    ${masthead()}
    ${siteNav(path)}
  </div>
</header>
<main id="main"${mainClass ? ` class="${mainClass}"` : ""} tabindex="-1">
${body}
</main>
${footer({ year })}
${mainJs ? `<script src="${url("main.js")}" defer></script>\n` : ""}${foot ? `${foot}\n` : ""}</body>
</html>
`;
}
