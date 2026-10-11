// engine/lib/checks.js — the twelve deterministic QA checks (review M14 prove-by: one passing and one
// failing case per id, the six named cases, jpegSize on the fixture JPEG) against the REAL brand files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { DRAFT_SPEC, EDIT_SPEC, QA_CHECK_IDS, validate } from "../engine/lib/schema.js";
import {
  BARE_DOMAIN_RE,
  DUPLICATE_THRESHOLD,
  MAX_MEDIA_BYTES,
  OF2_PATTERNS,
  codePoints,
  copySurfaces,
  fullCaption,
  hostOf,
  isAllowedCodePoint,
  isDevanagari,
  jaccard,
  jpegSize,
  nfc,
  numberTokens,
  pngSize,
  reelProbeErrors,
  runChecks,
  shingles3,
} from "../engine/lib/checks.js";

const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { config, brands } = company;
const DRAFTS_DIR = join(ROOT, "tests", "fixtures", "drafts");
const JPEG_PATH = join(ROOT, "tests", "fixtures", "media", "fixture-1080x1350.jpg");
const JPEG = new Uint8Array(readFileSync(JPEG_PATH));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

function fixture(name) {
  return JSON.parse(readFileSync(join(DRAFTS_DIR, `${name}.json`), "utf8"));
}
const RP = fixture("rp-2026-10-14-kundali-free");
const KD = fixture("kd-2026-10-13-six-rules");
const JR = fixture("jr-2026-10-15-templates");

function mediaFor(draft, bytes = JPEG) {
  return draft.media.map((m) => ({ kind: m.kind, bytes, width: m.width, height: m.height, path: m.path }));
}

// run(draft, overrides, ctx) → { result, check(id) } against the draft's own brand.
function run(base, overrides = {}, ctx = {}) {
  const draft = { ...structuredClone(base), ...overrides };
  const result = runChecks(draft, brands[draft.page], { config, recentCaptions: [], media: mediaFor(draft), ...ctx });
  return { result, check: (id) => result.checks.find((c) => c.id === id) };
}

function withCaption(base, caption) {
  return run(base, { caption });
}

// A JPEG whose SOF height bytes are patched (1080×1080) — jpegSize must read the patched value.
function patchedJpeg(width, height) {
  const b = new Uint8Array(JPEG);
  let i = 2;
  while (i + 3 < b.length) {
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xc0 || marker === 0xc2) {
      b[i + 5] = height >> 8;
      b[i + 6] = height & 0xff;
      b[i + 7] = width >> 8;
      b[i + 8] = width & 0xff;
      return b;
    }
    i += 2 + length;
  }
  throw new Error("no SOF in fixture");
}

// ---------------------------------------------------------------------------------------------------
// Fixtures, shape and purity

test("the three fixture drafts validate against DRAFT_SPEC, their media rows match the committed fixture JPEG (computed sha256/bytes), and every one passes runChecks against the real brand files (N19)", () => {
  const sha = createHash("sha256").update(JPEG).digest("hex");
  assert.equal(JPEG.length, 9432);
  assert.ok(JPEG.length <= 60 * 1024, "fixture JPEG ≤ 60 KB");
  for (const draft of [RP, KD, JR]) {
    assert.deepEqual(validate(draft, DRAFT_SPEC), { ok: true, errors: [] }, draft.id);
    for (const m of draft.media) {
      assert.equal(m.sha256, sha, `${draft.id} media sha256 is the fixture JPEG's`);
      assert.equal(m.bytes, JPEG.length);
      assert.ok(m.path.endsWith(`-${sha.slice(0, 8)}.jpg`), "sha8-named file");
      assert.equal(m.rawUrl, `https://raw.githubusercontent.com/${config.repo.owner}/${config.repo.name}/${config.repo.mediaBranch}/${m.path}`);
      assert.equal(m.pagesUrl, `${config.site.url}/${m.path}`);
    }
    const { result } = run(draft);
    assert.equal(result.passed, true, `${draft.id}: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
  }
  assert.deepEqual(readdirSync(DRAFTS_DIR).sort(), ["jr-2026-10-15-templates.json", "jr-reel-2026-10-16-templates.json", "kd-2026-10-13-six-rules.json", "kd-reel-2026-10-18-six-rules.json", "rp-2026-10-14-kundali-free.json", "rp-reel-2026-10-17-kundali-free.json"]);
  // FEAT-201: the reel fixtures (one kinetic reel per page, media: [] — rendered by the reel tests) validate and pass
  // every text check; media_spec fails honestly because nothing is rendered yet
  for (const file of readdirSync(DRAFTS_DIR).filter((f) => f.includes("-reel-"))) {
    const reel = JSON.parse(readFileSync(join(DRAFTS_DIR, file), "utf8"));
    assert.equal(reel.format, "reel");
    assert.equal(reel.status, "written");
    assert.deepEqual(reel.media, []);
    assert.deepEqual(validate(reel, DRAFT_SPEC), { ok: true, errors: [] }, reel.id);
    assert.equal(reel.reel.durationSec, reel.reel.scenes.reduce((s, sc) => s + sc.seconds, 0), `${reel.id}: durationSec is the scenes' sum`);
    const { result } = run(reel, {}, { media: [] });
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.id);
    assert.deepEqual(failed, ["media_spec"], `${reel.id}: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`);
  }
  // N19: the JobRez fixture states the export rule as jr-f09 does (Word is Pro, not free)
  assert.match(JR.caption, /Export to PDF or plain text — free, unlimited and watermark-free on the free plan\. Word export is Pro\./);
  assert.ok(!/Word or plain text\. Free/.test(JR.caption));
  assert.ok(JR.factsUsed.some((f) => f.factId === "jr-f09") && JR.factsUsed.some((f) => f.factId === "jr-f10"));
});

test("runChecks returns the twelve checks in QA_CHECK_IDS order with boolean ok and string detail; the result fits EDIT_SPEC.checks; fixture-company brands agree with the real ones", () => {
  const { result } = run(RP);
  assert.deepEqual(
    result.checks.map((c) => c.id),
    QA_CHECK_IDS,
  );
  for (const c of result.checks) {
    assert.equal(typeof c.ok, "boolean");
    assert.equal(typeof c.detail, "string");
    assert.ok(c.detail.length > 0);
  }
  const edit = { draftId: RP.id, baseRevision: 1, caption: RP.caption, hashtags: RP.hashtags, altText: RP.altText, at: "2026-10-12T09:00:00+05:30", by: "owner", checks: result };
  assert.deepEqual(validate(edit, EDIT_SPEC), { ok: true, errors: [] });
  const fx = loadCompany({ companyDir: join(ROOT, "tests", "fixtures", "company-populated"), warn: () => {} });
  for (const draft of [RP, KD, JR]) {
    const r = runChecks(draft, fx.brands[draft.page], { config: fx.config, recentCaptions: [], media: mediaFor(draft) });
    assert.equal(r.passed, true);
  }
  assert.throws(() => runChecks(RP, brands.rishtapatra, {}), /ctx\.config\.defaults\.captionMax is required/);
  assert.throws(() => runChecks(RP, null, { config }), /brand/);
});

test("checks.js imports nothing from node: (it is byte-copied into dist/admin/lib/ in FEAT-111) and only ./schema.js and ./brand.js", () => {
  const src = readFileSync(join(ROOT, "engine", "lib", "checks.js"), "utf8");
  assert.equal(/from\s+["']node:/.test(src), false);
  assert.equal(/import\(/.test(src), false);
  const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./brand.js", "./schema.js"]);
});

// ---------------------------------------------------------------------------------------------------
// caption_length

test("caption_length: pass — the fixture's full caption (caption + hashtag line) is within captionMax", () => {
  const { check } = run(RP);
  assert.equal(check("caption_length").ok, true);
  assert.equal(check("caption_length").detail, `${codePoints(fullCaption(RP))}/${config.defaults.captionMax}`);
  assert.ok(codePoints(fullCaption(RP)) > codePoints(RP.caption), "the hashtag line counts");
});

test("caption_length: fail — a caption that fits alone but crosses captionMax once the hashtag line is added", () => {
  const room = config.defaults.captionMax - codePoints(RP.caption) - 5; // leaves no room for the hashtag line
  const { check } = withCaption(RP, RP.caption + "\n" + "क".repeat(room));
  assert.equal(codePoints(RP.caption + "\n" + "क".repeat(room)) <= config.defaults.captionMax, true, "caption alone fits");
  assert.equal(check("caption_length").ok, false);
  assert.match(check("caption_length").detail, /^\d+\/2200$/);
});

// ---------------------------------------------------------------------------------------------------
// hashtags

test("hashtags: pass — 4/8 well-formed tags; a Devanagari tag with a matra passes (schema HASHTAG adds \\p{M})", () => {
  assert.equal(run(RP).check("hashtags").detail, "4/8");
  const { check } = run(RP, { hashtags: ["#RishtaPatra", "#रिश्ता", "#कुंडली"] });
  assert.equal(check("hashtags").ok, true, check("hashtags").detail);
});

test("hashtags: fail — more than hashtagCap, a malformed tag, and a case-insensitive duplicate", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `#Tag${i}`);
  assert.equal(run(RP, { hashtags: nine }).check("hashtags").ok, false);
  assert.match(run(RP, { hashtags: nine }).check("hashtags").detail, /9 > 8/);
  const bad = run(RP, { hashtags: ["#RishtaPatra", "#a b"] }).check("hashtags");
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /bad: #a b/);
  const dup = run(RP, { hashtags: ["#RishtaPatra", "#rishtapatra"] }).check("hashtags");
  assert.equal(dup.ok, false);
  assert.match(dup.detail, /duplicate: #rishtapatra/);
});

// ---------------------------------------------------------------------------------------------------
// disclaimer

test("disclaimer: pass — the kundali trigger fires and both require groups are present (Hindi alternative accepted); no trigger → pass", () => {
  const { check } = run(RP);
  assert.equal(check("disclaimer").ok, true);
  assert.equal(check("disclaimer").detail, "kundali → 2/2 groups");
  const none = run(RP, { caption: "Make your biodata on your device. rishtapatra.com", hashtags: ["#RishtaPatra", "#Biodata"] }).check("disclaimer");
  assert.equal(none.ok, true);
  assert.equal(none.detail, "no trigger fired");
  // the hashtag line is part of the caption: #JanamKundali alone fires the kundali trigger
  const tagOnly = run(RP, { caption: "Make your biodata on your device. rishtapatra.com", hashtags: ["#JanamKundali"] }).check("disclaimer");
  assert.equal(tagOnly.ok, false);
  assert.match(tagOnly.detail, /^kundali: missing indicative/);
  const english = withCaption(RP, "Your Janam Kundali is indicative. Consult your pandit before you decide. rishtapatra.com").check("disclaimer");
  assert.equal(english.ok, true);
});

test("disclaimer: fail — a KaatDo caption without the SEBI fragment fails (M14); a kundali caption without 'indicative' fails", () => {
  const noSebi = KD.caption.replace("KaatDo is not registered with SEBI. ", "");
  assert.equal(noSebi.includes("SEBI"), false);
  const kd = withCaption(KD, noSebi).check("disclaimer");
  assert.equal(kd.ok, false);
  assert.equal(kd.detail, "always: missing not registered with SEBI | not SEBI-registered");
  const rp = withCaption(RP, "मुफ़्त जन्म कुंडली — अपने पंडित से सलाह लें। rishtapatra.com").check("disclaimer");
  assert.equal(rp.ok, false);
  assert.match(rp.detail, /missing indicative/);
  // paraphrased ("not SEBI registered" without the hyphen) is a weakened fragment → absent
  const weakened = withCaption(KD, KD.caption.replace("not registered with SEBI", "not SEBI registered")).check("disclaimer");
  assert.equal(weakened.ok, false);
});

// ---------------------------------------------------------------------------------------------------
// forbidden

test("forbidden: pass — the fixtures match none of the brand regexes; KaatDo's look-behinds keep 'never guaranteed' / 'Not SEBI-registered' legal", () => {
  assert.equal(run(KD).check("forbidden").ok, true);
  assert.match(run(KD).check("forbidden").detail, /10 patterns, no match/);
  assert.equal(run(JR).check("forbidden").ok, true);
});

test("forbidden: fail — KaatDo 'guaranteed' in the caption, JobRez '!' and a user count in the artwork", () => {
  const kd = withCaption(KD, KD.caption + "\nGuaranteed exits.").check("forbidden");
  assert.equal(kd.ok, false);
  assert.match(kd.detail, /caption: "Guaranteed" matches/);
  const jr = withCaption(JR, JR.caption.replace("Three are free.", "Three are free!")).check("forbidden");
  assert.equal(jr.ok, false);
  assert.match(jr.detail, /caption: "!" matches \/!\//);
  const art = run(RP, { artwork: { ...RP.artwork, subline: "Trusted by 10,000 families" } }).check("forbidden");
  assert.equal(art.ok, false);
  assert.match(art.detail, /artwork\.subline/);
});

// ---------------------------------------------------------------------------------------------------
// numbers_sourced

test("numbers_sourced: pass — '36-point Guna Milan' is sourced by rp-f08 (M14); the detail lists token → factId", () => {
  const { check } = run(RP);
  assert.equal(check("numbers_sourced").ok, true);
  assert.equal(check("numbers_sourced").detail, "36 → rp-f08");
  const kd = run(KD).check("numbers_sourced");
  assert.equal(kd.ok, true);
  assert.equal(kd.detail, "999 → pricing:monthly, 7 → pricing:trial");
  assert.equal(run(JR).check("numbers_sourced").detail, "no numbers");
});

test("numbers_sourced: fail — '1,011 listings' without 'as of 2026-10-03' fails for job_rez (jr-f15 is usable only with its date, M14); with the date it passes", () => {
  const bare = withCaption(JR, "The live jobs panel listed 1,011 roles from 35 boards. jobrez.com").check("numbers_sourced");
  assert.equal(bare.ok, false);
  assert.match(bare.detail, /1,011 → unsourced \(jr-f15 needs the date 2026-10-03 in the copy\)/);
  assert.match(bare.detail, /35 → unsourced/);
  const dated = withCaption(JR, "As of 2026-10-03 the live jobs panel listed 1,011 roles from 35 boards. jobrez.com").check("numbers_sourced");
  assert.equal(dated.ok, true, dated.detail);
  assert.match(dated.detail, /1,011 → jr-f15/);
  assert.match(dated.detail, /2026-10-03 → jr-f0\d/);
  // comma-less form of a sourced number is accepted; a number that exists nowhere is not
  assert.equal(withCaption(JR, "As of 2026-10-03: 1011 live listings. jobrez.com").check("numbers_sourced").ok, true);
  assert.equal(withCaption(JR, "Twelve templates, 12 in total. jobrez.com").check("numbers_sourced").ok, false);
});

test("numbers_sourced: ₹999 passes and ₹1000 fails for KaatDo pricing (M14); slot date DD and HH:MM times are allowed; hashtags and URLs are ignored", () => {
  const ok = run(KD).check("numbers_sourced");
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /999 → pricing:monthly/);
  const bad = withCaption(KD, KD.caption.replace("₹999", "₹1000")).check("numbers_sourced");
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /1000 → unsourced/);
  const slot = withCaption(KD, KD.caption + "\nArmed from 13 October, nudge at 08:45 and alert at 09:20.").check("numbers_sourced");
  assert.equal(slot.ok, true, slot.detail);
  assert.match(slot.detail, /13 → slot date \(2026-10-13\)/);
  assert.match(slot.detail, /08:45 → kd-f07/);
  assert.match(slot.detail, /09:20 → kd-f07/);
  assert.match(withCaption(KD, KD.caption + "\nStarts 11:05 sharp.").check("numbers_sourced").detail, /11:05 → time/);
  const ignored = run(KD, { caption: KD.caption + "\nhttps://kaatdo.com/pricing?v=2026 #Top10", hashtags: ["#KaatDo2026"] }).check("numbers_sourced");
  assert.equal(ignored.ok, true, ignored.detail);
  // artwork numbers count too
  const art = run(KD, { artwork: { ...KD.artwork, facts: ["Square off within 3 seconds"] } }).check("numbers_sourced");
  assert.equal(art.ok, false);
  assert.match(art.detail, /3 → unsourced/);
});

// ---------------------------------------------------------------------------------------------------
// alt_text

test("alt_text: pass — one alt text within altTextMax for an image; one per slide for a carousel", () => {
  assert.equal(run(RP).check("alt_text").detail, `${codePoints(RP.altText)}/${config.defaults.altTextMax}`);
  const jr = run(JR).check("alt_text");
  assert.equal(jr.ok, true);
  assert.match(jr.detail, /^4 alt texts, longest \d+\/100$/);
  // without altTexts[] the slides' own alt texts are used
  const { altTexts, ...noList } = JR;
  assert.equal(runChecks(noList, brands.job_rez, { config, media: mediaFor(JR) }).checks.find((c) => c.id === "alt_text").ok, true);
});

test("alt_text: fail — empty, longer than altTextMax (code points), or fewer alt texts than slides", () => {
  assert.match(run(RP, { altText: "" }).check("alt_text").detail, /altText\[0\] empty/);
  const long = run(RP, { altText: "क".repeat(config.defaults.altTextMax + 1) }).check("alt_text");
  assert.equal(long.ok, false);
  assert.equal(long.detail, `altText[0] ${config.defaults.altTextMax + 1}/${config.defaults.altTextMax}`);
  const few = run(JR, { altTexts: JR.altTexts.slice(0, 3) }).check("alt_text");
  assert.equal(few.ok, false);
  assert.match(few.detail, /3 alt texts for 4 media items/);
});

// ---------------------------------------------------------------------------------------------------
// language

test("language: pass — 'काट दो.' passes for KaatDo (M14); any Devanagari passes on the hi page; General Punctuation, ₹, →, ╱ and · are allowed", () => {
  assert.equal(run(KD).check("language").ok, true);
  assert.equal(run(KD).check("language").detail, 'ok (en; Devanagari only "काट दो")');
  assert.equal(withCaption(RP, "नमस्ते — बायोडाटा बनाइए। rishtapatra.com").check("language").ok, true);
  assert.equal(withCaption(KD, "₹999 → one rule · KaatDo ╱ काट दो. “Cut it.” kaatdo.com").check("language").ok, true);
  assert.equal(run(JR).check("language").detail, "ok (en; no Devanagari)");
});

test("language: fail — 'नमस्ते' fails for KaatDo (M14); any Devanagari fails for JobRez; code points outside the allowed set fail everywhere", () => {
  const kd = withCaption(KD, KD.caption.replace("काट दो.", "नमस्ते, काट दो.")).check("language");
  assert.equal(kd.ok, false);
  assert.equal(kd.detail, 'caption: Devanagari outside the allow-list "नमस्ते"');
  const jr = run(JR, { altText: "काट दो" }).check("language");
  assert.equal(jr.ok, false);
  assert.match(jr.detail, /altText: Devanagari outside the allow-list "काट", "दो"/);
  const sym = withCaption(RP, RP.caption + " ≥ 1 ✓").check("language");
  assert.equal(sym.ok, false);
  assert.match(sym.detail, /U\+2265 "≥"/);
  assert.match(sym.detail, /U\+2713 "✓"/);
  // an emoji is not a language failure (the emoji check owns it)
  assert.equal(withCaption(RP, RP.caption + " 🙏").check("language").ok, true);
});

// ---------------------------------------------------------------------------------------------------
// media_spec

test("media_spec: pass — the fixture JPEG is 1080×1350, FF D8, under 1.5 MB; carousel with 4 items; metadata-only items are accepted and labelled", () => {
  assert.equal(run(RP).check("media_spec").detail, "1080x1350 jpeg 9 KB");
  assert.equal(run(JR).check("media_spec").detail, "4 × 1080x1350 jpeg max 9 KB");
  const meta = runChecks(RP, brands.rishtapatra, { config }).checks.find((c) => c.id === "media_spec");
  assert.equal(meta.ok, true);
  assert.match(meta.detail, /metadata only/);
});

test("media_spec: fail — 1080×1080 from the SOF marker, > 1.5 MB, wrong count for the format, PNG bytes, missing bytes (M14)", () => {
  const square = run(RP, {}, { media: mediaFor(RP, patchedJpeg(1080, 1080)) }).check("media_spec");
  assert.equal(square.ok, false);
  assert.match(square.detail, /1080x1080, expected 1080x1350/);
  const big = new Uint8Array(MAX_MEDIA_BYTES + 1);
  big.set(JPEG, 0);
  const large = run(RP, {}, { media: mediaFor(RP, big) }).check("media_spec");
  assert.equal(large.ok, false);
  assert.match(large.detail, /1500001 bytes > 1500000 bytes/);
  const largeMeta = runChecks(RP, brands.rishtapatra, { config, media: [{ kind: "image", bytes: 1_600_000, width: 1080, height: 1350 }] }).checks.find((c) => c.id === "media_spec");
  assert.equal(largeMeta.ok, false);
  const two = run(RP, {}, { media: [...mediaFor(RP), ...mediaFor(RP)] }).check("media_spec");
  assert.equal(two.ok, false);
  assert.match(two.detail, /2 media items for image \(expected 1\)/);
  const one = run(JR, {}, { media: mediaFor(JR).slice(0, 1) }).check("media_spec");
  assert.equal(one.ok, false);
  assert.match(one.detail, /1 media item for carousel \(expected 2–10\)/);
  const png = run(RP, {}, { media: mediaFor(RP, PNG) }).check("media_spec");
  assert.equal(png.ok, false);
  assert.match(png.detail, /not a JPEG \(magic 89 50\)/);
  const missing = run(RP, {}, { media: [{ kind: "image", bytes: null, path: "media/x/image-1-abc.jpg" }] }).check("media_spec");
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /image-1-abc\.jpg: media bytes not available/);
  assert.equal(run(RP, {}, { media: [] }).check("media_spec").ok, false);
  // a reel draft with image media is not a reel's media set
  const reel = run(RP, { format: "reel" }).check("media_spec");
  assert.equal(reel.ok, false);
  assert.match(reel.detail, /1 media item for reel \(expected 2: video \+ poster\)/);
});

// FEAT-201: media_spec for reels — one video row whose ffprobe summary (recorded by the Designer, passed through by QA)
// meets the reel spec and one 1080×1920 JPEG poster ≤ 1.5 MB; pngSize reads the capture frames back.
test("media_spec (reel): video probe ok + 1080×1920 poster passes; a wrong codec / size / fps / duration / cap / faststart, a missing probe, a 1080×1350 poster or a wrong item count fails with the reason named", () => {
  const probe = (over = {}) => ({ ok: true, codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", frameRate: "30/1", durationSec: 16, bytes: 2_400_000, faststart: true, ...over });
  const poster = patchedJpeg(1080, 1920);
  const reelDraft = { ...RP, format: "reel", reel: { style: "kinetic", durationSec: 16, scenes: [{ text: "a", seconds: 4 }, { text: "b", seconds: 4 }, { text: "c", seconds: 4 }, { text: "d", seconds: 4 }] } };
  delete reelDraft.artwork;
  const media = (p = probe(), posterBytes = poster, videoBytes = 2_400_000) => [
    { kind: "video", bytes: videoBytes, width: 1080, height: 1920, path: "media/x/reel-abcdef12.mp4", durationSec: 16, probe: p },
    { kind: "poster", bytes: posterBytes, width: 1080, height: 1920, path: "media/x/poster-12345678.jpg" },
  ];
  const check = (m) => runChecks(reelDraft, brands.rishtapatra, { config, media: m }).checks.find((c) => c.id === "media_spec");
  const ok = check(media());
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /h264 1080x1920 yuv420p 30\/1 16 s 2400 KB faststart; poster 1080x1920 jpeg/);
  const metaOnly = check(media(probe(), 9432));
  assert.equal(metaOnly.ok, true, metaOnly.detail);
  assert.match(metaOnly.detail, /metadata only/);
  const cases = [
    [media(probe({ codec: "hevc", ok: false })), /codec hevc, expected h264/],
    [media(probe({ width: 1080, height: 1080 })), /1080x1080, expected 1080x1920/],
    [media(probe({ frameRate: "25/1" })), /frame rate 25\/1, expected 30\/1/],
    [media(probe({ durationSec: 2 })), /duration 2 s, expected 3–90 s/],
    [media(probe({ durationSec: 95 })), /duration 95 s, expected 3–90 s/],
    [media(probe({ bytes: 70 * 1024 * 1024 }), poster, 70 * 1024 * 1024), /bytes, cap 62914560 bytes/],
    [media(probe({ pixFmt: "yuv444p" })), /pix_fmt yuv444p, expected yuv420p/],
    [media(probe({ faststart: false })), /moov atom after mdat/],
    [media(probe({ ok: false })), /probe ok:false/],
    [media(null), /no ffprobe summary recorded/],
    [media(probe(), patchedJpeg(1080, 1350)), /1080x1350, expected 1080x1920/],
    [media(probe(), PNG), /not a JPEG \(magic 89 50\)/],
    [media().slice(0, 1), /1 media item for reel \(expected 2: video \+ poster\)/],
    [[...media(), ...media()], /4 media items for reel/],
    [media(probe(), poster, 2_400_001), /2400001 bytes on disk, probe measured 2400000/],
  ];
  for (const [m, re] of cases) {
    const r = check(m);
    assert.equal(r.ok, false, `${re}: ${r.detail}`);
    assert.match(r.detail, re);
  }
  assert.deepEqual(reelProbeErrors(probe()), []);
  assert.deepEqual(reelProbeErrors(null), ["probe missing"]);
  assert.equal(reelProbeErrors(probe({ bytes: 61 * 1024 * 1024 })).length, 1);
  // pngSize reads the IHDR of a real PNG header and refuses JPEG bytes
  const ihdr = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x04, 0x38, 0, 0, 0x07, 0x80, 8, 6, 0, 0, 0]);
  assert.deepEqual(pngSize(ihdr), { width: 1080, height: 1920 });
  assert.throws(() => pngSize(JPEG), /not a PNG/);
  assert.throws(() => pngSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 1, 0, 0, 0, 1])), /first chunk is not IHDR/);
});

test("jpegSize: the fixture JPEG is 1080×1350; throws on PNG bytes, on non-bytes and on a truncated marker chain", () => {
  assert.deepEqual(jpegSize(JPEG), { width: 1080, height: 1350 });
  assert.deepEqual(jpegSize(JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength)), { width: 1080, height: 1350 }, "ArrayBuffer input");
  assert.deepEqual(jpegSize(patchedJpeg(1080, 1080)), { width: 1080, height: 1080 });
  assert.throws(() => jpegSize(PNG), /not a JPEG \(missing FF D8 magic\)/);
  assert.throws(() => jpegSize("string"), /expected a Uint8Array/);
  assert.throws(() => jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), /no SOF marker found|truncated/);
});

// ---------------------------------------------------------------------------------------------------
// links

test("links: pass — bare domains and URLs on the brand's allowed domain (incl. www. and e-mail hosts)", () => {
  assert.equal(run(KD).check("links").detail, "3 link tokens, all on kaatdo.com");
  const ok = withCaption(KD, KD.caption + "\nhttps://www.kaatdo.com/pricing and info@kaatdo.com").check("links");
  assert.equal(ok.ok, true, ok.detail);
  assert.equal(run(RP, { caption: "बायोडाटा बनाइए।", artwork: undefined, altText: "Maroon headline on cream." }).check("links").detail, "no links");
});

test("links: fail — a URL or bare domain off the allowed list, on any copy surface", () => {
  const url = withCaption(KD, KD.caption + "\nPay via https://razorpay.com/kaatdo").check("links");
  assert.equal(url.ok, false);
  assert.match(url.detail, /not allowed: caption: https:\/\/razorpay\.com\/kaatdo \(host razorpay\.com\)/);
  const bare = run(JR, { slides: JR.slides.map((s, i) => (i === 3 ? { ...s, body: s.body.replace("jobrez.com", "jobrez.dev") } : s)) }).check("links");
  assert.equal(bare.ok, false);
  assert.match(bare.detail, /slides\[3\]\.body: jobrez\.dev/);
  assert.equal("see naukri.in today".match(BARE_DOMAIN_RE)[0], "naukri.in");
  assert.equal(BARE_DOMAIN_RE.global, false, "exported regex is stateless (no g flag)");
});

// ---------------------------------------------------------------------------------------------------
// emoji

test("emoji: pass — two pictographs on a sparse brand (RishtaPatra); zero on a none brand", () => {
  const two = withCaption(RP, RP.caption + " 🙏 ✨").check("emoji");
  assert.equal(two.ok, true);
  assert.equal(two.detail, "2/2 (sparse): U+1F64F U+2728");
  assert.equal(run(KD).check("emoji").detail, "0/0 (none)");
});

test("emoji: fail — three on a sparse brand; one on a none brand (KaatDo, JobRez); a hashtag-line emoji counts", () => {
  assert.equal(withCaption(RP, RP.caption + " 🙏 ✨ 🎉").check("emoji").ok, false);
  const kd = withCaption(KD, KD.caption + " 🚨").check("emoji");
  assert.equal(kd.ok, false);
  assert.equal(kd.detail, "1/0 (none): U+1F6A8");
  assert.equal(withCaption(JR, JR.caption + " ✅").check("emoji").ok, false);
  assert.equal(run(KD, { hashtags: ["#KaatDo", "#🚨"] }).check("emoji").ok, false);
});

// ---------------------------------------------------------------------------------------------------
// duplicate

test("duplicate: pass — unrelated recent captions stay far below 0.5; no recent captions → 0.00 (M14)", () => {
  const { check } = run(RP, {}, { recentCaptions: [KD.caption, JR.caption, "Shubh Pass: all premium templates for ₹499 at the time of posting."] });
  assert.equal(check("duplicate").ok, true);
  assert.match(check("duplicate").detail, /^max jaccard 0\.\d\d over 3 recent captions$/);
  assert.ok(Number(check("duplicate").detail.slice(12, 16)) < DUPLICATE_THRESHOLD);
  assert.equal(run(RP).check("duplicate").detail, "max jaccard 0.00 (no recent captions)");
});

test("duplicate: fail — an identical caption among the recent ones gives max 1.00 (M14); a near-copy ≥ 0.5 fails too; only the last 30 count", () => {
  const same = run(RP, {}, { recentCaptions: [KD.caption, RP.caption] }).check("duplicate");
  assert.equal(same.ok, false);
  assert.equal(same.detail, "max jaccard 1.00 over 2 recent captions");
  const near = run(RP, {}, { recentCaptions: [RP.caption.replace("every match card", "each match card")] }).check("duplicate");
  assert.equal(near.ok, false);
  assert.ok(Number(near.detail.slice(12, 16)) >= DUPLICATE_THRESHOLD);
  const old = run(RP, {}, { recentCaptions: [RP.caption, ...Array.from({ length: 30 }, (_, i) => `unrelated caption number ${i}`)] }).check("duplicate");
  assert.equal(old.ok, true, "the identical caption is the 31st most recent and drops out");
});

// ---------------------------------------------------------------------------------------------------
// brand_lint

test("brand_lint: pass — JobRez copy without OF-2 tokens; 'India' is fine on RishtaPatra; ₹999 equals the KaatDo monthly row (M14)", () => {
  assert.equal(run(JR).check("brand_lint").detail, "no OF-2 tokens; no ₹ amounts");
  assert.equal(withCaption(RP, "RishtaPatra operates from India. rishtapatra.com").check("brand_lint").ok, true);
  const kd = run(KD).check("brand_lint");
  assert.equal(kd.ok, true);
  assert.equal(kd.detail, "OF-2 applies to @job_rez only; ₹999 = pricing:monthly");
  assert.equal(withCaption(KD, "Quarterly ₹2,599 at the time of posting. Not investment advice.").check("brand_lint").ok, true);
});

test("brand_lint: fail — a JobRez caption with '#India' (M14), 'B.Tech' in a slide, 'Indian' in alt text; ₹1000 is not a KaatDo pricing row", () => {
  const tag = run(JR, { hashtags: [...JR.hashtags, "#India"] }).check("brand_lint");
  assert.equal(tag.ok, false);
  assert.match(tag.detail, /hashtags\[4\]: "#India" \(OF-2 \/#India\/\)/);
  const cap = withCaption(JR, JR.caption + "\nBuilt for engineers in India.").check("brand_lint");
  assert.equal(cap.ok, false);
  assert.match(cap.detail, /caption: "India" \(OF-2 \/\\bIndia\\b\/\)/);
  const slide = run(JR, { slides: JR.slides.map((s, i) => (i === 1 ? { ...s, body: "Fresh B.Tech graduates welcome." } : s)) }).check("brand_lint");
  assert.equal(slide.ok, false);
  assert.match(slide.detail, /slides\[1\]\.body: "B\.Tech"/);
  assert.equal(run(JR, { altText: "Indian resume templates" }).check("brand_lint").ok, false);
  assert.equal(OF2_PATTERNS.length, 6);
  assert.equal(OF2_PATTERNS.some((re) => re.test("WebTech")), false, "\\b keeps WebTech legal");
  const price = withCaption(KD, KD.caption.replace("₹999", "₹1000")).check("brand_lint");
  assert.equal(price.ok, false);
  assert.match(price.detail, /caption: ₹1000 is not a ## Pricing row/);
  // ₹ on JobRez is allowed only for its own pricing rows (OF-2 note in the brand file)
  assert.equal(withCaption(JR, "Pro for 30 days at ₹699 at the time of posting. jobrez.com").check("brand_lint").ok, true);
  assert.equal(withCaption(JR, "Pro for 30 days at ₹700. jobrez.com").check("brand_lint").ok, false);
});

// ---------------------------------------------------------------------------------------------------
// Helpers

test("helpers: codePoints, nfc, numberTokens, shingles3, jaccard, hostOf, isDevanagari, isAllowedCodePoint, fullCaption, copySurfaces", () => {
  assert.equal(codePoints("🙏a"), 2);
  assert.equal("🙏a".length, 3);
  assert.equal(codePoints("कुंडली"), 6);
  assert.equal(nfc("e\u0301"), "é");
  assert.deepEqual(numberTokens("As of 2026-10-03 at 08:45 IST: 1,011 listings, 22.5/36 and 7-day trial, ₹2,599."), ["2026-10-03", "08:45", "1,011", "22.5", "36", "7", "2,599"]);
  assert.deepEqual(numberTokens("no digits here"), []);
  assert.deepEqual(shingles3("Six rules. One kill switch. #KaatDo"), ["six rules one", "rules one kill", "one kill switch"]);
  assert.deepEqual(shingles3("two words"), ["two words"]);
  assert.deepEqual(shingles3(""), []);
  assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(["a"], ["a"]), 1);
  assert.equal(hostOf("https://www.KaatDo.com/pricing?x=1"), "kaatdo.com");
  assert.equal(hostOf("jobrez.com."), "jobrez.com");
  assert.equal(hostOf("www.rishtapatra.com/biodata"), "rishtapatra.com");
  assert.equal(hostOf("http://[bad"), null);
  assert.equal(isDevanagari("क".codePointAt(0)), true);
  assert.equal(isDevanagari("।".codePointAt(0)), true);
  assert.equal(isDevanagari("a".codePointAt(0)), false);
  for (const ch of ["a", "é", "·", "×", "क", "—", "“", "₹", "→", "╱", "\u200d"]) assert.equal(isAllowedCodePoint(ch.codePointAt(0)), true, ch);
  for (const ch of ["≥", "✓", "™", "α"]) assert.equal(isAllowedCodePoint(ch.codePointAt(0)), false, ch);
  assert.equal(fullCaption({ caption: "Hello", hashtags: ["#A", "#B"] }), "Hello\n\n#A #B");
  assert.equal(fullCaption({ caption: "Hello #a world", hashtags: ["#A", "#B"] }), "Hello #a world\n\n#B", "a tag already in the caption is not appended twice");
  assert.equal(fullCaption({ caption: "Plain", hashtags: [] }), "Plain");
  const surfaces = copySurfaces(JR).map((s) => s.where);
  assert.ok(surfaces.includes("caption") && surfaces.includes("hashtags[0]") && surfaces.includes("altTexts[3]") && surfaces.includes("slides[2].body") && surfaces.includes("slides[0].altText"));
  assert.ok(copySurfaces(RP).map((s) => s.where).includes("artwork.facts[1]"));
});
