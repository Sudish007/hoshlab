// feed.xml (Atom, published posts with their Instagram permalinks), sitemap.xml (public pages only —
// /admin/ is never listed, review N9) and robots.txt (no Disallow line: a Disallow would advertise the
// path OF-1 hides; /admin/ carries noindex instead, plan D4).
import config from "../site.config.js";
import { url, absUrl } from "./lib/urls.js";
import { escapeXml } from "./lib/xml.js";
import { toAtomDate } from "./lib/dates.js";

export function atomFeed(view) {
  const posts = view.posts;
  const updated = posts.length ? toAtomDate(posts[0].record.publishedAt) : toAtomDate(view.now);
  const items = posts
    .map(({ record, draft, caption }) => {
      const link = record.permalink || absUrl(`published/#${record.draftId}`);
      const title = draft ? firstLine(draft.caption) : `@${record.page} · ${record.format}`;
      const content = caption || `Published to @${record.page} (${record.format}); the caption is no longer in the repository.`;
      return `  <entry>
    <id>${escapeXml(absUrl(`published/#${record.draftId}`))}</id>
    <title>${escapeXml(title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(link)}"/>
    <published>${escapeXml(toAtomDate(record.publishedAt))}</published>
    <updated>${escapeXml(toAtomDate(record.publishedAt))}</updated>
    <author><name>${escapeXml(config.title)} · @${escapeXml(record.page)}</name></author>
    <category term="${escapeXml(record.page)}"/>
    <category term="${escapeXml(record.format)}"/>
    <content type="text"${draft && draft.language ? ` xml:lang="${escapeXml(draft.language)}"` : ""}>${escapeXml(content)}</content>
  </entry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <id>${escapeXml(absUrl(""))}</id>
  <title>${escapeXml(config.title)} — published posts</title>
  <subtitle>Every post the Publisher posted, with its Instagram permalink.</subtitle>
  <updated>${escapeXml(updated)}</updated>
  <link rel="self" type="application/atom+xml" href="${escapeXml(absUrl("feed.xml"))}"/>
  <link rel="alternate" type="text/html" href="${escapeXml(absUrl("published/"))}"/>
  <author><name>${escapeXml(config.owner.owner)}</name></author>
  <icon>${escapeXml(absUrl("apple-touch-icon.png"))}</icon>
${items}${items ? "\n" : ""}</feed>
`;
}

function firstLine(caption) {
  const line = String(caption || "").split(/\r?\n/).find((l) => l.trim()) || "";
  return line.trim().slice(0, 120);
}

// Public routes only: the fixed pages, one per Instagram page (pages/<handle>/) and one per Analyst report
// (reports/<week>/, FEAT-203).
export function publicRoutes(view) {
  return ["", "team/", "pages/", ...view.config.pages.map((p) => `pages/${p.handle}/`), "activity/", "calendar/", "published/", "reports/", ...(view.reports || []).map((r) => r.url), "about/"];
}

export function sitemap(view) {
  const lastmod = view.nowIso;
  const items = publicRoutes(view)
    .map((p) => `  <url>\n    <loc>${escapeXml(absUrl(p))}</loc>\n    <lastmod>${escapeXml(lastmod)}</lastmod>\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</urlset>
`;
}

export function robots() {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absUrl("sitemap.xml")}\n`;
}

export { url };
