// Published (mock/posts.html → real posts): one card per published.jsonl record (dry runs excluded) with
// the artwork copied from the media branch, the caption as posted, the Instagram permalink and the IST
// time; page filters driven by main.js (?page=<handle>); the static Formats list; and in the empty state
// one "Nothing published yet — first slot <date>" card per page computed from the cadence (review M11).
import { layout } from "./layout.js";
import { url } from "../lib/urls.js";
import { escapeHtml } from "../lib/xml.js";
import { modeLabel } from "../lib/labels.js";
import { formatIst, formatIstDay, formatIstTime, monthName, monthKeyOf } from "../lib/dates.js";
import { chip, hi, sectionHead } from "./partials.js";

export function formatsList(view) {
  const reels = view.config.features && view.config.features.reels;
  return `<div class="next-up" aria-label="Formats">
        <h2>Formats</h2>
        <ol>
          <li><span class="mono">image</span><span class="who">1080 × 1350 JPEG · 4:5</span>${chip("built")}</li>
          <li><span class="mono">carousel</span><span class="who">2–10 slides · same size</span>${chip("built")}</li>
          <li><span class="mono">reel</span><span class="who">1080 × 1920 MP4</span>${reels ? chip("built") : chip("not built yet (phase 2)", "warn")}</li>
        </ol>
      </div>`;
}

export function monthBox(view) {
  const inMonth = view.published.filter((r) => monthKeyOf(r.publishedAt) === view.monthKey);
  const carousels = inMonth.filter((r) => r.format === "carousel").length;
  const waiting = view.awaiting.length;
  return `<div class="next-up" aria-label="${escapeHtml(monthName(view.monthKey))}">
        <h2>${escapeHtml(monthName(view.monthKey))}</h2>
        <ol>
          <li><span class="mono">published</span><span class="who">${inMonth.length} post${inMonth.length === 1 ? "" : "s"}${carousels ? ` · ${carousels} carousel${carousels === 1 ? "" : "s"}` : ""}</span>${chip(`${view.published.length} all time`)}</li>
          <li><span class="mono">waiting</span><span class="who">${waiting === 0 ? "no drafts with the owner" : `${waiting} draft${waiting === 1 ? "" : "s"} with the owner`}</span>${chip(modeLabel("approve_first"), waiting ? "warn" : "")}</li>
        </ol>
      </div>`;
}

function mediaMarkup(post) {
  const { media: all, draft, record } = post;
  // a reel's card shows its poster JPEG (the MP4 row is not an image); the video itself plays on Instagram (FEAT-201)
  const video = record.format === "reel" ? all.find((m) => m.kind === "video") : null;
  const media = record.format === "reel" ? all.filter((m) => m.kind === "poster") : all;
  if (!media.length) return `<div class="post-frame post-missing"><p class="meta">No artwork recorded for this post.</p></div>`;
  const alt = (i) => (draft.altTexts && draft.altTexts[i]) || (draft.slides && draft.slides[i] && draft.slides[i].altText) || draft.altText || "";
  const frame = (item, i, cls) =>
    item.present
      ? `<figure class="${cls}"><img src="${url(item.path)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(alt(i))}" loading="lazy" decoding="async"></figure>`
      : `<div class="${cls} post-missing" role="img" aria-label="${escapeHtml(alt(i))}"><p class="meta">Artwork not in this build (media branch not checked out); the Instagram post has it.</p></div>`;
  const first = frame(media[0], 0, "post-frame");
  const rest = media.length > 1 ? `<div class="thumbs" aria-label="${media.length} slides">${media.slice(1).map((m, i) => frame(m, i + 1, "thumb")).join("")}</div>` : "";
  const note = record.format === "carousel" ? `<p class="meta">${media.length} slides · swipe on Instagram</p>` : record.format === "reel" ? `<p class="meta">reel${video && typeof video.durationSec === "number" ? ` · ${escapeHtml(String(video.durationSec))} s` : ""} · silent · plays on Instagram</p>` : "";
  return `${first}${rest}${note}`;
}

export function postCard(view, post) {
  const { record, draft, caption } = post;
  const approval = record.approvedBy ? `approved by ${escapeHtml(record.approvedBy)}${record.approvedAt ? ` · ${escapeHtml(formatIstDay(record.approvedAt))} ${escapeHtml(formatIstTime(record.approvedAt))}` : ""}` : `${escapeHtml(modeLabel(record.mode))} · QA pass revision ${record.qaRevision}`;
  const link = record.permalink
    ? `<a class="btn btn-quiet" href="${escapeHtml(record.permalink)}" rel="noopener">View on Instagram →</a>`
    : `<span class="chip chip-warn chip-plain">permalink pending</span>`;
  return `<article class="card post-card" data-page="${escapeHtml(record.page)}" id="${escapeHtml(record.draftId)}">
        <header class="post-head"><span class="handle mono">@${escapeHtml(record.page)}</span>${chip(record.format)}<time datetime="${escapeHtml(record.publishedAt)}">${escapeHtml(formatIst(record.publishedAt))}</time>${record.late ? chip("late", "warn") : ""}</header>
        ${mediaMarkup(post)}
        ${draft ? `<p class="post-caption">${hi(caption)}</p>` : `<p class="meta">Draft file no longer in the repository; the record below is what was published.</p>`}
        <dl class="kv">
          <dt>Media id</dt><dd><span class="mono">${escapeHtml(record.igMediaId)}</span></dd>
          <dt>Approval</dt><dd>${approval}</dd>
          <dt>Slot</dt><dd>${escapeHtml(formatIst(record.slotAt))}${record.late ? " · posted late" : ""}</dd>
        </dl>
        <div class="card-foot">${link}<span class="mono run-id">${escapeHtml(record.runId)}</span></div>
      </article>`;
}

export function emptyCard(view, page) {
  const first = view.firstSlotByPage.get(page.handle);
  return `<article class="card post-card post-empty" data-page="${escapeHtml(page.handle)}">
        <header class="post-head"><span class="handle mono">@${escapeHtml(page.handle)}</span>${chip(modeLabel(view.modeOf(page.handle)))}</header>
        <h3>Nothing published yet${first ? ` — first slot ${escapeHtml(formatIst(first.at))}` : ""}</h3>
        <p class="meta">${first ? `The first ${escapeHtml(first.format)} slot for @${escapeHtml(page.handle)} is ${escapeHtml(formatIstDay(first.at))} at ${escapeHtml(formatIstTime(first.at))} IST. ` : ""}A post appears here only after the Publisher has posted it and logged the permalink.</p>
      </article>`;
}

export function publishedPage(view) {
  const { config } = view;
  const n = view.published.length;
  const filters = [`<a class="btn" role="button" href="./" data-filter="" aria-pressed="true">All pages</a>`].concat(config.pages.map((p) => `<a class="btn" role="button" href="?page=${escapeHtml(p.handle)}" data-filter="${escapeHtml(p.handle)}" aria-pressed="false">@${escapeHtml(p.handle)}</a>`));
  const grid = n ? view.posts.map((p) => postCard(view, p)).join("\n      ") : config.pages.map((p) => emptyCard(view, p)).join("\n      ");
  const body = `<section class="hero" data-page="published">
    <div>
      <p class="eyebrow">Published · ${n === 0 ? "nothing yet" : `${n} post${n === 1 ? "" : "s"}`}</p>
      <h1>${n === 0 ? "What a Hoshlab post will look like on each page." : "Every post that went out, with its receipt."}</h1>
      <p class="lede">The Designer renders 1080×1350 JPEG artwork from the draft using only the tokens in that page's brand.md. Each card below is a line in <span class="mono">published.jsonl</span>: the artwork, the caption as posted, the Instagram media id and permalink, who approved it and when.</p>
      <div class="hero-actions" role="group" aria-label="Filter by page">
        ${filters.join("\n        ")}
      </div>
      <p class="meta filter-status" role="status"></p>
      <div class="trust-row" aria-label="What a published entry records">
        <div><span class="k">Permalink + media id</span><span class="s">from the Instagram API response</span></div>
        <div><span class="k">Who approved, when</span><span class="s">or "Autopilot" with the QA pass revision</span></div>
        <div><span class="k">The artwork itself</span><span class="s">copied from the media branch at build time</span></div>
      </div>
    </div>
    <div class="hero-side">
      ${formatsList(view)}
      ${monthBox(view)}
    </div>
  </section>

  <section class="section">
    ${sectionHead(n ? "Posts" : "Nothing published yet", { aside: `<span class="meta">${n ? `${n} post${n === 1 ? "" : "s"} · newest first` : "one card per page"}</span>`, desc: n ? "Newest first. The filter above shows one page at a time." : "One card per page until its first post goes out; the first slot comes from the posting cadence." })}
    <div class="posts-grid">
      ${grid}
    </div>
  </section>`;
  return layout({ title: "Published", description: `Every post ${config.company.name} has published, with artwork, caption, Instagram permalink and approval record.`, path: "published/", body, year: view.year, bodyData: 'data-view="published"' });
}
