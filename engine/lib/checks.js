// Deterministic QA checks (design.md §4.7, §12; review M14 defines the twelve rules — each one is
// restated in the doc comment of its check function) plus jpegSize() for the renderer (design §10).
// Browser-safe: no node: imports; imports only ./schema.js and ./brand.js. The file is byte-copied
// into dist/admin/lib/ at build time (plan D12) so the admin's caption editor runs the same rules.
//
//   runChecks(draft, brand, { config, slotDate, recentCaptions, media })
//     → { passed, checks: [{ id, ok, detail }] }      one entry per QA_CHECK_IDS, in that order
//
//   draft              a DRAFT_SPEC-shaped object (caption, hashtags, altText(s), artwork, slides, format, slotAt …)
//   brand              parseBrand() output (frontMatter, facts, pricing, disclaimers, forbidden, allowedDomains)
//   ctx.config         the company config; defaults.captionMax / hashtagCap / altTextMax are the caps
//   ctx.slotDate       'YYYY-MM-DD' of the slot in IST (default: the leading date of draft.slotAt, which
//                      carries the +05:30 offset, so its date part IS the IST date)
//   ctx.recentCaptions the page's last 30 captions (strings), for the duplicate check
//   ctx.media          [{ kind, bytes, width, height, path?, probe? }] — `bytes` is the file content (Uint8Array)
//                      when the caller has it (engine), or the byte count (number) when only the
//                      draft's metadata is known (admin); `probe` is the Designer's ffprobe summary on a
//                      reel's video row (PROBE_SUMMARY_SPEC); default: draft.media
//
// Every check returns ok + a short human detail string that qa.json stores and the admin shows as a chip.
import { HASHTAG, QA_CHECK_IDS } from "./schema.js";
import { forbiddenRegexes, usableFacts } from "./brand.js";

export const JOBREZ_HANDLE = "job_rez";
export const MEDIA_WIDTH = 1080;
export const MEDIA_HEIGHT = 1350;
export const MAX_MEDIA_BYTES = 1_500_000; // 1.5 MB (decimal, like the '141 KB' detail in design §4.7)
// Reels (design §10, FEAT-201): 1080×1920 H.264 yuv420p 30 fps, 3–90 s; house cap 60 MB, git hard cap 100 MB.
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_CODEC = "h264";
export const REEL_PIX_FMT = "yuv420p";
export const REEL_FRAME_RATE = "30/1";
export const REEL_MIN_SEC = 3;
export const REEL_MAX_SEC = 90;
export const REEL_HOUSE_CAP_BYTES = 60 * 1024 * 1024;
export const REEL_HARD_CAP_BYTES = 100 * 1024 * 1024;
export const DUPLICATE_THRESHOLD = 0.5;
export const EMOJI_CAP = { none: 0, sparse: 2 };
// OF-2 tokens for @job_rez (review M14; \b added around B.Tech so 'WebTech' does not trip it).
export const OF2_PATTERNS = [/\bIndia\b/iu, /\bIndian\b/iu, /\bNaukri\b/iu, /\bB\.?Tech\b/iu, /\bGST\b/iu, /#India/iu];
export const BARE_DOMAIN_RE = /\b[\w-]+\.(com|in|org|net|app|dev)\b/i;
const BARE_DOMAIN_ALL_RE = new RegExp(BARE_DOMAIN_RE.source, "gi");

const HASHTAG_RE = new RegExp(HASHTAG.slice("pattern:".length), "u");
const HASHTAG_IN_TEXT_RE = /#[\p{L}\p{M}\p{N}_]+/gu;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME_RE = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const PRICE_TOKEN_RE = /₹\s?\d[\d,]*(?:\.\d+)?/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EMOJI_ONE_RE = /\p{Extended_Pictographic}/u;
const DEVANAGARI_RUN_RE = /[\u0900-\u097F\uA8E0-\uA8FF]+/gu;
const WORD_SPLIT_RE = /[^\p{L}\p{M}\p{N}]+/u;
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const DETAIL_MAX = 300;

// ---------------------------------------------------------------------------------------
// Helpers (exported for the tests, the renderer and the admin)

// Number of Unicode code points ([...s].length), the length rule everywhere in Hoshlab.
export function codePoints(s) {
  let n = 0;
  for (const _ of String(s ?? "")) n++;
  return n;
}

// NFC normalisation; every comparison in this file runs on NFC text.
export function nfc(s) {
  return String(s ?? "").normalize("NFC");
}

export function isDateToken(t) {
  return /^\d{4}-\d{2}-\d{2}$/.test(t);
}

export function isTimeToken(t) {
  return /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(t);
}

// numberTokens(text) → tokens in a stable order: whole 'YYYY-MM-DD' dates and 'HH:MM' times first
// (kept intact so '2026-10-03' and '08:45' are not split into digit runs), then every
// /\d[\d,]*(\.\d+)?/ run with trailing commas trimmed ('1,011,' → '1,011'). Hashtags and URLs are
// NOT removed here; numbers_sourced strips them from the caption before calling this.
export function numberTokens(text) {
  let s = nfc(text);
  const out = [];
  s = s.replace(DATE_RE, (m) => {
    out.push(m);
    return " ";
  });
  s = s.replace(TIME_RE, (m) => {
    out.push(m);
    return " ";
  });
  for (const m of s.matchAll(NUMBER_RE)) {
    const t = m[0].replace(/,+$/, "");
    if (t) out.push(t);
  }
  return out;
}

// Lower-cased NFC words (letters, marks, digits) with hashtags removed.
export function words(text) {
  return nfc(text).toLowerCase().replace(HASHTAG_IN_TEXT_RE, " ").split(WORD_SPLIT_RE).filter(Boolean);
}

// Word 3-shingles ('a b c', 'b c d', …); a text shorter than three words is one shingle.
export function shingles3(text) {
  const w = words(text);
  if (w.length < 3) return w.length ? [w.join(" ")] : [];
  const out = [];
  for (let i = 0; i + 3 <= w.length; i++) out.push(w.slice(i, i + 3).join(" "));
  return out;
}

// Jaccard similarity |A ∩ B| / |A ∪ B| of two shingle lists (0 when both are empty).
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Host of a URL or bare-domain token, lower-cased, without 'www.' and trailing punctuation; null when unparsable.
export function hostOf(token) {
  const t = String(token ?? "")
    .trim()
    .replace(/[.,;:!?)\]]+$/, "");
  if (!t) return null;
  let host;
  if (/^https?:\/\//i.test(t)) {
    try {
      host = new URL(t).hostname;
    } catch {
      return null;
    }
  } else host = t.split(/[/?#]/)[0];
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host || null;
}

// Devanagari (U+0900–U+097F) and Devanagari Extended (U+A8E0–U+A8FF).
export function isDevanagari(cp) {
  return (cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff);
}

// Code points the language check accepts on every page (review M14): Latin (Basic Latin, Latin-1
// Supplement incl. · and ×, Latin Extended-A/B), Devanagari, General Punctuation (— – ‘ ’ “ ” … •
// and the ZWNJ/ZWJ that Devanagari conjuncts use), ₹, → and ╱.
export function isAllowedCodePoint(cp) {
  if (cp <= 0x024f) return true;
  if (isDevanagari(cp)) return true;
  if (cp >= 0x2000 && cp <= 0x206f) return true;
  return cp === 0x20b9 || cp === 0x2192 || cp === 0x2571;
}

// Emoji territory is the emoji check's business, not the language check's: pictographs, VS16, the
// combining keycap and the skin-tone modifiers.
function isEmojiTerritory(ch) {
  const cp = ch.codePointAt(0);
  return EMOJI_ONE_RE.test(ch) || cp === 0xfe0f || cp === 0x20e3 || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

// jpegSize(bytes) → { width, height } read from the first SOFn marker (SOF0 baseline / SOF2
// progressive are what Chromium writes; the other SOFn markers are accepted too). Throws TypeError
// on anything that is not a JPEG (missing FF D8 magic, broken marker chain, no SOF).
export function jpegSize(bytes) {
  const b = toBytes(bytes);
  if (!b) throw new TypeError("jpegSize: expected a Uint8Array or ArrayBuffer");
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new TypeError("jpegSize: not a JPEG (missing FF D8 magic)");
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) throw new TypeError(`jpegSize: expected a marker at byte ${i}`);
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before any frame header
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) throw new TypeError(`jpegSize: bad segment length at byte ${i}`);
    if (SOF_MARKERS.has(marker)) {
      if (i + 8 >= b.length) throw new TypeError("jpegSize: truncated SOF segment");
      return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
    }
    i += 2 + length;
  }
  throw new TypeError("jpegSize: no SOF marker found");
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// pngSize(bytes) → { width, height } from the IHDR chunk (the first chunk of every PNG: 8 magic bytes,
// 4 length, 'IHDR', then width and height as big-endian uint32). Throws TypeError on anything else.
// Used for the product-capture frames (FEAT-201) the same way jpegSize guards the JPEGs: read back, not trusted.
export function pngSize(bytes) {
  const b = toBytes(bytes);
  if (!b) throw new TypeError("pngSize: expected a Uint8Array or ArrayBuffer");
  if (b.length < 24 || PNG_MAGIC.some((v, i) => b[i] !== v)) throw new TypeError("pngSize: not a PNG (missing \\x89PNG magic)");
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) throw new TypeError("pngSize: first chunk is not IHDR");
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  return { width: u32(16), height: u32(20) };
}

// reelProbeErrors(probe) → errors[] for a recorded ffprobe summary (PROBE_SUMMARY_SPEC) against the reel spec:
// codec h264, 1080×1920, yuv420p, 30/1, 3–90 s, ≤ 60 MB house cap, faststart. Browser-safe; the admin and
// QA's media_spec share it with engine/render/probe.js (which derives the summary from real ffprobe JSON).
export function reelProbeErrors(p, { houseCapBytes = REEL_HOUSE_CAP_BYTES } = {}) {
  const errors = [];
  if (!p || typeof p !== "object") return ["probe missing"];
  if (p.codec !== REEL_CODEC) errors.push(`codec ${p.codec}, expected ${REEL_CODEC}`);
  if (p.width !== REEL_WIDTH || p.height !== REEL_HEIGHT) errors.push(`${p.width}x${p.height}, expected ${REEL_WIDTH}x${REEL_HEIGHT}`);
  if (p.pixFmt !== REEL_PIX_FMT) errors.push(`pix_fmt ${p.pixFmt}, expected ${REEL_PIX_FMT}`);
  if (p.frameRate !== REEL_FRAME_RATE) errors.push(`frame rate ${p.frameRate}, expected ${REEL_FRAME_RATE}`);
  if (!(typeof p.durationSec === "number" && p.durationSec >= REEL_MIN_SEC && p.durationSec <= REEL_MAX_SEC)) errors.push(`duration ${p.durationSec} s, expected ${REEL_MIN_SEC}–${REEL_MAX_SEC} s`);
  if (!(Number.isInteger(p.bytes) && p.bytes > 0 && p.bytes <= houseCapBytes)) errors.push(`${p.bytes} bytes, cap ${houseCapBytes} bytes`);
  if (p.faststart !== true) errors.push("moov atom after mdat (no +faststart)");
  return errors;
}

// The text Instagram receives: caption + blank line + the hashtag line. Hashtags already written
// inside the caption are not appended twice. Shared with the Publisher so every length rule and the
// published text agree.
export function fullCaption(draft) {
  const caption = String((draft && draft.caption) || "").replace(/\s+$/, "");
  const tags = ((draft && draft.hashtags) || []).filter((h) => typeof h === "string" && h !== "");
  const present = new Set([...caption.matchAll(HASHTAG_IN_TEXT_RE)].map((m) => nfc(m[0]).toLowerCase()));
  const missing = tags.filter((h) => !present.has(nfc(h).toLowerCase()));
  if (!missing.length) return caption;
  return caption ? `${caption}\n\n${missing.join(" ")}` : missing.join(" ");
}

// Every piece of copy a draft carries: [{ where, text }] for caption, hashtags, alt text(s),
// artwork (headline, subline, facts, footer), slide text and reel scenes.
export function copySurfaces(draft) {
  const out = [];
  const add = (where, text) => {
    if (typeof text === "string" && text !== "") out.push({ where, text });
  };
  add("caption", draft.caption);
  (draft.hashtags || []).forEach((h, i) => add(`hashtags[${i}]`, h));
  add("altText", draft.altText);
  (draft.altTexts || []).forEach((t, i) => add(`altTexts[${i}]`, t));
  const a = draft.artwork;
  if (a && typeof a === "object") {
    add("artwork.headline", a.headline);
    add("artwork.subline", a.subline);
    (a.facts || []).forEach((f, i) => add(`artwork.facts[${i}]`, f));
    add("artwork.footer", a.footer);
  }
  (draft.slides || []).forEach((s, i) => {
    if (!s || typeof s !== "object") return;
    add(`slides[${i}].heading`, s.heading);
    add(`slides[${i}].body`, s.body);
    add(`slides[${i}].altText`, s.altText);
  });
  if (draft.reel && Array.isArray(draft.reel.scenes)) draft.reel.scenes.forEach((sc, i) => add(`reel.scenes[${i}]`, sc && sc.text));
  return out;
}

function clip(s, max = DETAIL_MAX) {
  const t = String(s);
  return codePoints(t) > max ? [...t].slice(0, max - 1).join("") + "…" : t;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function kb(bytes) {
  return `${Math.round(bytes / 1000)} KB`;
}

function hex(n) {
  return n === undefined ? "--" : n.toString(16).toUpperCase().padStart(2, "0");
}

function cpLabel(ch) {
  return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function normNumber(t) {
  return t.replace(/,/g, "");
}

function normPrice(t) {
  return t.replace(/[\s,]/g, "");
}

function capsOf(config) {
  const d = config && config.defaults;
  for (const key of ["captionMax", "hashtagCap", "altTextMax"]) {
    if (!d || !Number.isInteger(d[key])) throw new TypeError(`checks: ctx.config.defaults.${key} is required`);
  }
  return { captionMax: d.captionMax, hashtagCap: d.hashtagCap, altTextMax: d.altTextMax };
}

// Caption text for the number and link scans: hashtags and URLs removed.
function captionWithoutTagsAndUrls(draft) {
  return nfc(draft.caption || "")
    .replace(URL_RE, " ")
    .replace(HASHTAG_IN_TEXT_RE, " ");
}

// Copy whose numbers must be sourced: caption (hashtags/URLs removed) + artwork + slides + reel scenes.
function numbersCopy(draft) {
  const parts = [captionWithoutTagsAndUrls(draft)];
  for (const { where, text } of copySurfaces(draft)) {
    if (where === "caption" || where.startsWith("hashtags") || where.startsWith("altText") || where.endsWith(".altText")) continue;
    parts.push(nfc(text).replace(URL_RE, " "));
  }
  return parts.join("\n");
}

// Map normalised token → [{ label, dates }] from usable facts (disputed excluded) and pricing rows.
// A fact that carries a YYYY-MM-DD date is "dated": its numbers count only when the copy carries that
// date too (jr-f15 '1,011 live listings' is usable only with 'as of 2026-10-03').
function numberAllowList(brand) {
  const allow = new Map();
  const add = (token, label, dates) => {
    const key = normNumber(token);
    if (!allow.has(key)) allow.set(key, []);
    allow.get(key).push({ label, dates });
  };
  for (const f of usableFacts(brand)) {
    const tokens = numberTokens(f.fact);
    const dates = [...new Set(tokens.filter(isDateToken))];
    for (const t of tokens) add(t, f.id, dates.length ? dates : null);
  }
  for (const p of brand.pricing || []) for (const t of numberTokens(`${p.sku} ${p.price}`)) add(t, `pricing:${p.sku}`, null);
  return allow;
}

function isSlotDay(token, slotDate) {
  if (!slotDate || !/^\d{1,2}$/.test(token)) return false;
  return Number(token) === Number(slotDate.slice(8, 10));
}

// ---------------------------------------------------------------------------------------
// The twelve checks (review M14). Each receives d = { draft, brand, caps, slotDate, recentCaptions, media }.

// caption_length — the code-point length ([...s].length) of the full caption, i.e. the caption
// INCLUDING its hashtag line (fullCaption), must be ≤ config.defaults.captionMax.
function checkCaptionLength({ draft, caps }) {
  const n = codePoints(fullCaption(draft));
  return { ok: n <= caps.captionMax, detail: `${n}/${caps.captionMax}` };
}

// hashtags — at most config.defaults.hashtagCap tags; each matches ^#[\p{L}\p{M}\p{N}_]{2,40}$ (the
// schema's HASHTAG: design §12's class plus \p{M}, so Devanagari matras and the virama pass — the
// same rule DRAFT_SPEC applies, FEAT-101 deviation 2); no duplicates after case folding.
function checkHashtags({ draft, caps }) {
  const tags = Array.isArray(draft.hashtags) ? draft.hashtags : [];
  const problems = [];
  const seen = new Set();
  if (tags.length > caps.hashtagCap) problems.push(`${tags.length} > ${caps.hashtagCap}`);
  for (const t of tags) {
    const s = nfc(t);
    if (!HASHTAG_RE.test(s)) problems.push(`bad: ${clip(s, 40)}`);
    const key = s.toLowerCase();
    if (seen.has(key)) problems.push(`duplicate: ${s}`);
    seen.add(key);
  }
  if (problems.length) return { ok: false, detail: clip(`${tags.length}/${caps.hashtagCap}; ${problems.join("; ")}`) };
  return { ok: true, detail: `${tags.length}/${caps.hashtagCap}` };
}

// disclaimer — for every brand ## Disclaimers entry whose trigger fires (`always`, or any trigger
// word present in the full caption, case-insensitive after NFC), each `require` group must have one
// of its alternatives present verbatim in the full caption (NFC, case-insensitive). A weakened or
// paraphrased fragment is absent.
function checkDisclaimer({ draft, brand }) {
  const rows = brand.disclaimers || [];
  if (!rows.length) return { ok: true, detail: "none defined" };
  const hay = nfc(fullCaption(draft)).toLowerCase();
  const fired = [];
  const missing = [];
  for (const d of rows) {
    let firedBy = null;
    if (d.trigger === "always") firedBy = "always";
    else for (const w of d.trigger || []) if (hay.includes(nfc(w).toLowerCase())) {
      firedBy = w;
      break;
    }
    if (!firedBy) continue;
    const groups = d.fragments || [];
    const absent = groups.filter((g) => !g.some((alt) => hay.includes(nfc(alt).toLowerCase())));
    fired.push(`${firedBy} → ${groups.length - absent.length}/${groups.length} groups`);
    for (const g of absent) missing.push(`${firedBy}: missing ${g.join(" | ")}`);
  }
  if (missing.length) return { ok: false, detail: clip(missing.join("; ")) };
  return { ok: true, detail: fired.length ? fired.join("; ") : "no trigger fired" };
}

// forbidden — every brand ## Forbidden regex (compiled with flags iu) is applied to each copy
// surface: caption, hashtags, alt text(s), artwork (headline, subline, facts, footer), slide text and
// reel scenes. Any match fails; the detail names the surface and the pattern.
function checkForbidden({ draft, brand }) {
  const regexes = forbiddenRegexes(brand);
  if (!regexes.length) return { ok: true, detail: "no forbidden patterns" };
  const hits = [];
  for (const { where, text } of copySurfaces(draft)) {
    const s = nfc(text);
    for (const re of regexes) {
      const m = re.exec(s);
      if (m) hits.push(`${where}: "${clip(m[0], 40)}" matches /${re.source}/`);
    }
  }
  if (hits.length) return { ok: false, detail: clip(hits.join("; ")) };
  return { ok: true, detail: `${plural(regexes.length, "pattern")}, no match` };
}

// numbers_sourced — every number token (/\d[\d,]*(\.\d+)?/g, with YYYY-MM-DD dates and HH:MM times
// kept whole) in the caption (hashtags and URLs removed) and in artwork / slides / reel scenes must
// occur verbatim as a number token of a usable fact's text (disputed facts excluded), of a
// ## Pricing row (sku + price), be the slot date (YYYY-MM-DD) or its day DD, or be an HH:MM time.
// A dated fact (its text carries a YYYY-MM-DD date) sources a number only when the copy carries
// that date as well. The detail lists 'token → factId' for every distinct token.
function checkNumbersSourced({ draft, brand, slotDate }) {
  const tokens = numberTokens(numbersCopy(draft));
  if (!tokens.length) return { ok: true, detail: "no numbers" };
  const copyDates = new Set(tokens.filter(isDateToken));
  const allow = numberAllowList(brand);
  const seen = new Set();
  const lines = [];
  let bad = 0;
  for (const t of tokens) {
    const key = normNumber(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const cands = allow.get(key) || [];
    let label = null;
    const direct = cands.find((c) => !c.dates);
    const dated = cands.find((c) => c.dates && c.dates.some((d) => copyDates.has(d)));
    if (direct) label = direct.label;
    else if (dated) label = dated.label;
    else if (isDateToken(t) && t === slotDate) label = "slot date";
    else if (isTimeToken(t)) label = "time";
    else if (isSlotDay(t, slotDate)) label = `slot date (${slotDate})`;
    if (label === null) {
      bad++;
      label = cands.length ? `unsourced (${cands[0].label} needs the date ${cands[0].dates.join(" or ")} in the copy)` : "unsourced";
    }
    lines.push(`${t} → ${label}`);
  }
  return { ok: bad === 0, detail: clip(lines.join(", ")) };
}

// alt_text — every media item needs an alt text of 1 … config.defaults.altTextMax code points:
// altText for an image (one item), altTexts[] (or slides[].altText) for a carousel — one per slide.
function checkAltText({ draft, caps, media }) {
  const max = caps.altTextMax;
  let texts;
  let expected;
  let label;
  if (draft.format === "carousel") {
    const slides = Array.isArray(draft.slides) ? draft.slides : [];
    texts = Array.isArray(draft.altTexts) && draft.altTexts.length ? draft.altTexts : slides.map((s) => s && s.altText);
    expected = slides.length || media.length || texts.length;
    label = "altTexts";
  } else {
    texts = [draft.altText];
    expected = 1;
    label = "altText";
  }
  const problems = [];
  if (texts.length !== expected) problems.push(`${plural(texts.length, "alt text")} for ${plural(expected, "media item")}`);
  const lengths = texts.map((t) => (typeof t === "string" ? codePoints(t.trim()) : 0));
  lengths.forEach((n, i) => {
    if (n < 1) problems.push(`${label}[${i}] empty`);
    else if (n > max) problems.push(`${label}[${i}] ${n}/${max}`);
  });
  if (problems.length) return { ok: false, detail: clip(problems.join("; ")) };
  return { ok: true, detail: texts.length === 1 ? `${lengths[0]}/${max}` : `${texts.length} alt texts, longest ${Math.max(...lengths)}/${max}` };
}

// language — pages whose languages lack 'hi': any Devanagari code point outside the brand's
// allowedDevanagari strings fails (KaatDo: only "काट दो"; null means any Devanagari is fine); pages
// with 'hi': Devanagari is free. All pages: every code point must be Latin (U+0000–U+024F),
// Devanagari (U+0900–U+097F, U+A8E0–U+A8FF), General Punctuation (U+2000–U+206F), ₹, —, ·, → or ╱;
// emoji code points are left to the emoji check. Applied to every copy surface.
function checkLanguage({ draft, brand }) {
  const fm = brand.frontMatter || {};
  const langs = Array.isArray(fm.languages) ? fm.languages : [];
  const devanagariFree = langs.includes("hi") || fm.allowedDevanagari === null;
  const allowedStrings = Array.isArray(fm.allowedDevanagari) ? fm.allowedDevanagari.map(nfc).filter(Boolean) : [];
  const problems = [];
  for (const { where, text } of copySurfaces(draft)) {
    const s = nfc(text);
    const disallowed = [];
    for (const ch of s) {
      if (isEmojiTerritory(ch) || isAllowedCodePoint(ch.codePointAt(0))) continue;
      disallowed.push(ch);
    }
    if (disallowed.length) {
      problems.push(
        `${where}: disallowed ${[...new Set(disallowed)]
          .slice(0, 5)
          .map((c) => `${cpLabel(c)} "${c}"`)
          .join(", ")}`,
      );
    }
    if (!devanagariFree) {
      let stripped = s;
      for (const a of allowedStrings) stripped = stripped.split(a).join(" ");
      const runs = stripped.match(DEVANAGARI_RUN_RE) || [];
      if (runs.length) {
        problems.push(
          `${where}: Devanagari outside the allow-list ${[...new Set(runs)]
            .slice(0, 3)
            .map((r) => `"${r}"`)
            .join(", ")}`,
        );
      }
    }
  }
  if (problems.length) return { ok: false, detail: clip(problems.join("; ")) };
  const pages = langs.join("+") || "any";
  if (devanagariFree) return { ok: true, detail: `ok (${pages}; Devanagari allowed)` };
  if (allowedStrings.length) return { ok: true, detail: `ok (${pages}; Devanagari only ${allowedStrings.map((a) => `"${a}"`).join(", ")})` };
  return { ok: true, detail: `ok (${pages}; no Devanagari)` };
}

// media_spec, reel branch (FEAT-201): exactly two items — one `video` whose recorded ffprobe summary
// (the Designer measured the MP4 with ffprobe; QA passes it through) says ok and meets the reel spec
// (reelProbeErrors), and one `poster`, a JPEG of 1080×1920 read from its SOF marker, ≤ 1.5 MB. The
// MP4 bytes themselves are never parsed here (browser-safe code; ffprobe is the measurement).
function checkReelMediaSpec(media) {
  const problems = [];
  if (media.length !== 2) problems.push(`${plural(media.length, "media item")} for reel (expected 2: video + poster)`);
  const videos = media.filter((m) => m && m.kind === "video");
  const posters = media.filter((m) => m && m.kind === "poster");
  if (videos.length !== 1) problems.push(`${plural(videos.length, "video item")}, expected 1`);
  if (posters.length !== 1) problems.push(`${plural(posters.length, "poster item")}, expected 1`);
  for (const m of media) if (m && m.kind !== "video" && m.kind !== "poster") problems.push(`${m.path ? String(m.path).split("/").pop() : "item"}: kind ${m.kind}, expected video or poster`);
  const video = videos[0];
  let probeDetail = "";
  if (video) {
    const label = video.path ? String(video.path).split("/").pop() : "video";
    const p = video.probe;
    if (!p || typeof p !== "object") problems.push(`${label}: no ffprobe summary recorded`);
    else {
      const errs = reelProbeErrors(p);
      if (p.ok !== true) errs.unshift("probe ok:false");
      if (errs.length) problems.push(`${label}: ${[...new Set(errs)].join(", ")}`);
      else probeDetail = `${p.codec} ${p.width}x${p.height} ${p.pixFmt} ${p.frameRate} ${p.durationSec} s ${kb(p.bytes)} faststart`;
    }
    const data = toBytes(video.bytes);
    const size = data ? data.byteLength : Number.isInteger(video.bytes) ? video.bytes : null;
    if (size === null) problems.push(`${label}: media bytes not available`);
    else if (size > REEL_HOUSE_CAP_BYTES) problems.push(`${label}: ${size} bytes > ${REEL_HOUSE_CAP_BYTES} bytes`);
    else if (video.probe && Number.isInteger(video.probe.bytes) && video.probe.bytes !== size) problems.push(`${label}: ${size} bytes on disk, probe measured ${video.probe.bytes}`);
  }
  const poster = posters[0];
  let posterDetail = "";
  if (poster) {
    const label = poster.path ? String(poster.path).split("/").pop() : "poster";
    const data = toBytes(poster.bytes);
    let width;
    let height;
    let size;
    let metadataOnly = false;
    if (data) {
      size = data.byteLength;
      if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) problems.push(`${label}: not a JPEG (magic ${hex(data[0])} ${hex(data[1])})`);
      else {
        try {
          ({ width, height } = jpegSize(data));
        } catch (e) {
          problems.push(`${label}: ${e.message}`);
        }
      }
    } else if (Number.isInteger(poster.bytes) && poster.bytes > 0) {
      metadataOnly = true;
      size = poster.bytes;
      width = poster.width;
      height = poster.height;
    } else problems.push(`${label}: media bytes not available`);
    if (size !== undefined) {
      if (width !== undefined && (width !== REEL_WIDTH || height !== REEL_HEIGHT)) problems.push(`${label}: ${width}x${height}, expected ${REEL_WIDTH}x${REEL_HEIGHT}`);
      if (size > MAX_MEDIA_BYTES) problems.push(`${label}: ${size} bytes > ${MAX_MEDIA_BYTES} bytes`);
      posterDetail = `poster ${REEL_WIDTH}x${REEL_HEIGHT} jpeg ${kb(size)}${metadataOnly ? " (metadata only: magic and SOF not verified)" : ""}`;
    }
  }
  if (problems.length) return { ok: false, detail: clip(problems.join("; ")) };
  return { ok: true, detail: `${probeDetail}; ${posterDetail}` };
}

// media_spec — every media item is a JPEG (magic FF D8) of exactly 1080×1350 read from its SOF
// marker (jpegSize) and ≤ 1.5 MB; the item count matches the format (1 for image, 2–10 for
// carousel). When only metadata is available (`bytes` is a number) the stored width/height/bytes
// are checked and the detail says so. Reels: see checkReelMediaSpec (video probe + 1080×1920 poster).
function checkMediaSpec({ draft, media }) {
  const format = draft.format;
  if (format === "reel") return checkReelMediaSpec(media);
  const [min, max] = format === "carousel" ? [2, 10] : [1, 1];
  const problems = [];
  if (media.length < min || media.length > max) problems.push(`${plural(media.length, "media item")} for ${format} (expected ${min === max ? min : `${min}–${max}`})`);
  const sizes = [];
  let metadataOnly = 0;
  media.forEach((m, i) => {
    const label = m && m.path ? String(m.path).split("/").pop() : `item ${i + 1}`;
    const data = toBytes(m && m.bytes);
    let width;
    let height;
    let size;
    if (data) {
      size = data.byteLength;
      if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) {
        problems.push(`${label}: not a JPEG (magic ${hex(data[0])} ${hex(data[1])})`);
        return;
      }
      try {
        ({ width, height } = jpegSize(data));
      } catch (e) {
        problems.push(`${label}: ${e.message}`);
        return;
      }
    } else if (m && Number.isInteger(m.bytes) && m.bytes > 0) {
      metadataOnly++;
      size = m.bytes;
      width = m.width;
      height = m.height;
    } else {
      problems.push(`${label}: media bytes not available`);
      return;
    }
    if (m.kind && m.kind !== "image") problems.push(`${label}: kind ${m.kind}, expected image`);
    if (width !== MEDIA_WIDTH || height !== MEDIA_HEIGHT) problems.push(`${label}: ${width}x${height}, expected ${MEDIA_WIDTH}x${MEDIA_HEIGHT}`);
    if (size > MAX_MEDIA_BYTES) problems.push(`${label}: ${size} bytes > ${MAX_MEDIA_BYTES} bytes`);
    sizes.push(size);
  });
  if (problems.length) return { ok: false, detail: clip(problems.join("; ")) };
  const many = media.length > 1;
  const base = `${many ? `${media.length} × ` : ""}${MEDIA_WIDTH}x${MEDIA_HEIGHT} jpeg ${many ? "max " : ""}${kb(Math.max(...sizes))}`;
  return { ok: true, detail: metadataOnly ? `${base} (metadata only: magic and SOF not verified)` : base };
}

// links — every URL (https?://…) and bare domain token (/\b[\w-]+\.(com|in|org|net|app|dev)\b/i) in
// the caption, alt text(s), artwork and slides must have a host that is one of the brand's
// ## Allowed domains (or a subdomain of one, e.g. www.).
function checkLinks({ draft, brand }) {
  const allowed = (brand.allowedDomains || []).map((d) => String(d).toLowerCase());
  const bad = [];
  let count = 0;
  for (const { where, text } of copySurfaces(draft)) {
    if (where.startsWith("hashtags")) continue;
    const s = nfc(text);
    const tokens = [...s.matchAll(URL_RE)].map((m) => m[0]);
    const rest = s.replace(URL_RE, " ");
    tokens.push(...[...rest.matchAll(BARE_DOMAIN_ALL_RE)].map((m) => m[0]));
    for (const t of tokens) {
      count++;
      const host = hostOf(t);
      if (!host || !allowed.some((d) => host === d || host.endsWith(`.${d}`))) bad.push(`${where}: ${clip(t, 60)} (host ${host || "?"})`);
    }
  }
  if (bad.length) return { ok: false, detail: clip(`not allowed: ${bad.join("; ")}`) };
  return { ok: true, detail: count ? `${plural(count, "link token")}, all on ${allowed.join(", ")}` : "no links" };
}

// emoji — the count of /\p{Extended_Pictographic}/gu matches in the full caption (caption + hashtag
// line) must be ≤ 2 when the brand's emoji policy is `sparse` and 0 when it is `none`.
function checkEmoji({ draft, brand }) {
  const policy = (brand.frontMatter || {}).emoji;
  const cap = EMOJI_CAP[policy] ?? 0;
  const found = [...nfc(fullCaption(draft)).matchAll(EMOJI_RE)].map((m) => cpLabel(m[0]));
  const detail = `${found.length}/${cap} (${policy || "none"})${found.length ? `: ${found.slice(0, 6).join(" ")}` : ""}`;
  return { ok: found.length <= cap, detail };
}

// duplicate — Jaccard similarity of word 3-shingles (lower-cased NFC words, hashtags removed) between
// the caption and each of the page's last 30 captions; the maximum must stay below 0.5 (≥ 0.5
// fails). The detail prints the max.
function checkDuplicate({ draft, recentCaptions }) {
  const mine = shingles3(draft.caption || "");
  let max = 0;
  for (const c of recentCaptions) {
    const text = typeof c === "string" ? c : c && typeof c.caption === "string" ? c.caption : "";
    const j = jaccard(mine, shingles3(text));
    if (j > max) max = j;
  }
  const scope = recentCaptions.length ? ` over ${plural(recentCaptions.length, "recent caption")}` : " (no recent captions)";
  return { ok: max < DUPLICATE_THRESHOLD, detail: `max jaccard ${max.toFixed(2)}${scope}` };
}

// brand_lint — (a) @job_rez only: the OF-2 tokens \bIndia\b, \bIndian\b, \bNaukri\b, B\.?Tech,
// \bGST\b and #India (flags iu) must not appear in caption, hashtags, alt text, artwork or slides;
// (b) every page: a ₹ amount may appear only when the whole price token (₹ + digits) equals a price
// token of a ## Pricing row; (c) disputed facts are excluded from every allow-list (usableFacts), so
// a disputed number fails numbers_sourced and a disputed claim has no fact id for the QA model.
function checkBrandLint({ draft, brand }) {
  const handle = (brand.frontMatter || {}).handle;
  const surfaces = copySurfaces(draft);
  const problems = [];
  const notes = [];
  if (handle === JOBREZ_HANDLE) {
    for (const { where, text } of surfaces) {
      const s = nfc(text);
      for (const re of OF2_PATTERNS) {
        const m = re.exec(s);
        if (m) problems.push(`${where}: "${m[0]}" (OF-2 /${re.source}/)`);
      }
    }
  }
  const priceRows = new Map();
  for (const p of brand.pricing || []) for (const m of nfc(`${p.sku} ${p.price}`).matchAll(PRICE_TOKEN_RE)) priceRows.set(normPrice(m[0]), p.sku);
  let prices = 0;
  for (const { where, text } of surfaces) {
    for (const m of nfc(text).matchAll(PRICE_TOKEN_RE)) {
      prices++;
      const sku = priceRows.get(normPrice(m[0]));
      if (sku) notes.push(`${m[0]} = pricing:${sku}`);
      else problems.push(`${where}: ${m[0]} is not a ## Pricing row`);
    }
  }
  if (problems.length) return { ok: false, detail: clip(problems.join("; ")) };
  const of2 = handle === JOBREZ_HANDLE ? "no OF-2 tokens" : "OF-2 applies to @job_rez only";
  return { ok: true, detail: `${of2}; ${prices ? [...new Set(notes)].join(", ") : "no ₹ amounts"}` };
}

const CHECKS = {
  caption_length: checkCaptionLength,
  hashtags: checkHashtags,
  disclaimer: checkDisclaimer,
  forbidden: checkForbidden,
  numbers_sourced: checkNumbersSourced,
  alt_text: checkAltText,
  language: checkLanguage,
  media_spec: checkMediaSpec,
  links: checkLinks,
  emoji: checkEmoji,
  duplicate: checkDuplicate,
  brand_lint: checkBrandLint,
};

// runChecks(draft, brand, ctx) → { passed, checks } — see the file header for ctx.
export function runChecks(draft, brand, ctx = {}) {
  if (!draft || typeof draft !== "object") throw new TypeError("checks: draft is required");
  if (!brand || typeof brand !== "object" || !brand.frontMatter) throw new TypeError("checks: brand (parseBrand output) is required");
  const d = {
    draft,
    brand,
    caps: capsOf(ctx.config),
    slotDate: typeof ctx.slotDate === "string" && ctx.slotDate ? ctx.slotDate : typeof draft.slotAt === "string" ? draft.slotAt.slice(0, 10) : null,
    recentCaptions: Array.isArray(ctx.recentCaptions) ? ctx.recentCaptions.slice(-30) : [],
    media: (Array.isArray(ctx.media) ? ctx.media : Array.isArray(draft.media) ? draft.media : []).map((m) => m || {}),
  };
  const checks = QA_CHECK_IDS.map((id) => {
    const r = CHECKS[id](d);
    return { id, ok: r.ok === true, detail: String(r.detail) };
  });
  return { passed: checks.every((c) => c.ok), checks };
}
