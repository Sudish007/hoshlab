// Writer agent (design.md §3.1 step 5, §4.6 draft.json, §5 row "Writer", §11 "LLM output", §12 caps;
// review M5; plan D9). Writes one post from an idea — caption, hashtags, alt text and the words the
// Designer renders — speaking as the product, with every claim traceable to an offered fact id.
//
//   runWriter({ slot, idea, brand, page, config, state, router, draft?, qaReasons?, recentCaptions?, now, runId, feedbackDigest? })
//     new draft : drafts/<id>/draft.json with status written, revision 1, reworkCount 0, mock from the router
//     rework    : (draft given) revision + 1, status written; reworkCount is NOT touched — QA owns that
//                 counter (it increments it when it sends a draft back, FEAT-104), so the Writer bumping it
//                 too would double-count the loops against maxReworkLoops
//     invalid   : AgentOutputError (one repair call already made by the router) → nothing new is written;
//                 an existing draft stays `rework` with the reason `invalid_output` in qaReasons; the result
//                 is { ok:false, reason:'invalid_output', error }. Other router errors propagate untouched.
//
// Caps come from config.defaults at runtime (outputSpec(caps)); the engine also checks what the shape
// cannot: every factsUsed id was offered (usable facts only), the format's block is present, and the
// caption + hashtag line fits captionMax (the length rule QA applies, engine/lib/checks.js).
import { HASHTAG } from "../lib/schema.js";
import { usableFacts } from "../lib/brand.js";
import { codePoints, fullCaption, rishtapatraLocalFirstErrors, visualAltTextErrors } from "../lib/checks.js";
import { draftId as makeDraftId } from "../lib/ids.js";
import { nowIst, parseIso } from "../lib/time.js";
import { AgentOutputError } from "../llm/router.js";

export const AGENT = "writer";
export const INVALID_OUTPUT_REASON = "invalid_output";
export const RECENT_CAPTIONS = 10;
// design §12: caption ≤ 2200 incl. hashtags, ≤ 8 hashtags, alt text per config (altTextMax, 100 in company/config.json)
export const DEFAULT_CAPS = { captionMax: 2200, hashtagCap: 8, altTextMax: 100 };
export const ARTWORK_CAPS = { headline: 60, subline: 110, fact: 70, facts: 3 };
export const SLIDE_CAPS = { heading: 40, body: 160, min: 2, max: 10 };
// Reels (design §10/§12, plan D17, FEAT-201): 3–6 scenes of ≤ 60 characters, 3–5 s each; the total and the
// per-style scene counts come from config.defaults.reel at runtime (reelRules), these are the design defaults.
export const REEL_CAPS = { scene: 60, scenes: [3, 6], seconds: [3, 5], minSec: 15, maxSec: 30 };

// reelRules(config, brand) → { minSec, maxSec, kineticScenes, captureScenes, seconds, capturePaths } — the live
// reel limits the validation and the format spec text use (config.defaults.reel; capturePaths from the brand).
export function reelRules(config, brand) {
  const r = (config && config.defaults && config.defaults.reel) || {};
  const pair = (v, fallback) => (Array.isArray(v) && v.length === 2 ? [v[0], v[1]] : fallback);
  return {
    minSec: Number.isInteger(r.minSec) ? r.minSec : REEL_CAPS.minSec,
    maxSec: Number.isInteger(r.maxSec) ? r.maxSec : REEL_CAPS.maxSec,
    kineticScenes: pair(r.kineticScenes, REEL_CAPS.scenes),
    captureScenes: pair(r.captureScenes, REEL_CAPS.scenes),
    seconds: REEL_CAPS.seconds,
    capturePaths: brand && brand.capture && Array.isArray(brand.capture.paths) ? brand.capture.paths.map((p) => p.path) : [],
  };
}

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`writer: invalid date ${String(v)}`);
  return d;
}

export function capsOf(config) {
  const d = (config && config.defaults) || {};
  return {
    captionMax: Number.isInteger(d.captionMax) ? d.captionMax : DEFAULT_CAPS.captionMax,
    hashtagCap: Number.isInteger(d.hashtagCap) ? d.hashtagCap : DEFAULT_CAPS.hashtagCap,
    altTextMax: Number.isInteger(d.altTextMax) ? d.altTextMax : DEFAULT_CAPS.altTextMax,
  };
}

// The model's JSON output (design §5, caps §12). Hashtags use the schema HASHTAG token (design §12 +
// \p{M}, FEAT-101) so a Devanagari tag with a matra validates here exactly as DRAFT_SPEC does.
export function outputSpec(caps = DEFAULT_CAPS) {
  const c = { ...DEFAULT_CAPS, ...caps };
  return {
    caption: `str<=${c.captionMax}`,
    hashtags: [HASHTAG, { max: c.hashtagCap }],
    altText: `str<=${c.altTextMax}`,
    "artwork?": { headline: `str<=${ARTWORK_CAPS.headline}`, subline: `str<=${ARTWORK_CAPS.subline}`, facts: [`str<=${ARTWORK_CAPS.fact}`, { max: ARTWORK_CAPS.facts }], footer: "str" },
    "slides?": [{ heading: `str<=${SLIDE_CAPS.heading}`, body: `str<=${SLIDE_CAPS.body}`, altText: `str<=${c.altTextMax}` }, { min: SLIDE_CAPS.min, max: SLIDE_CAPS.max }],
    "reel?": { style: "enum[kinetic|capture]", durationSec: "int", scenes: [{ text: `str<=${REEL_CAPS.scene}`, seconds: "int" }, { min: REEL_CAPS.scenes[0], max: REEL_CAPS.scenes[1] }] },
    factsUsed: [{ factId: "str", quote: "str" }, { min: 1 }],
    "writerNote?": "str",
  };
}
export const OUTPUT_SPEC = outputSpec();

// The format spec text handed to the model (design §5 Writer row), with the live caps. The reel text explains
// both styles: kinetic = the scene lines type on over the brand background; capture = each scene is a caption
// over one real screen of the product's own public pages (the brand's capture list), so a capture scene says
// what the viewer is looking at. durationSec is the sum of the scenes' seconds.
export function formatSpecText(format, caps = DEFAULT_CAPS, reel = reelRules(null, null)) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const r = reel || reelRules(null, null);
  const common = `caption ≤ ${c.captionMax} characters including the hashtag line; ≤ ${c.hashtagCap} hashtags, each # followed by 2–40 letters, digits or underscores; altText ≤ ${c.altTextMax} characters, literally describes the rendered branded text artwork (not a product screen, editor, page or preview) and repeats words visibly rendered in it; carousel slide alt text identifies a slide and repeats its visible heading/body copy; no hashtags`;
  const captureNote = r.capturePaths.length ? `the product screens available are ${r.capturePaths.join(", ")}` : "no product screens are listed for this brand, so use kinetic";
  const byFormat = {
    image: `image: artwork.headline ≤ ${ARTWORK_CAPS.headline} characters, artwork.subline ≤ ${ARTWORK_CAPS.subline}, artwork.facts 2–3 lines of ≤ ${ARTWORK_CAPS.fact} characters each, artwork.footer the brand's site domain or sign-off; omit slides and reel`,
    carousel: `carousel: 3–7 slides (the engine accepts ${SLIDE_CAPS.min}–${SLIDE_CAPS.max}), each heading ≤ ${SLIDE_CAPS.heading} and body ≤ ${SLIDE_CAPS.body} characters plus one altText ≤ ${c.altTextMax} per slide; omit artwork and reel`,
    reel: `reel: ${REEL_CAPS.scenes[0]}–${REEL_CAPS.scenes[1]} scenes of ≤ ${REEL_CAPS.scene} characters, ${r.seconds[0]}–${r.seconds[1]} seconds each (whole seconds; kinetic takes ${r.kineticScenes[0]}–${r.kineticScenes[1]} scenes, capture ${r.captureScenes[0]}–${r.captureScenes[1]}); reel.durationSec is the sum of the scenes' seconds and must be ${r.minSec}–${r.maxSec}; reel.style is kinetic or capture — kinetic: each scene's line types on over the brand background, one claim per scene, the first scene is the hook and the cover frame; capture: each scene is a short caption shown over a real screen of the product's own public pages, so write what the viewer sees on that screen (${captureNote}); the reel is silent; omit artwork and slides`,
  };
  return `${byFormat[format] || `${format}: unknown format`}; ${common}`;
}

// Semantic rules for the model's answer (the router's single repair call): offered facts only, the
// format's block present, caption + hashtag line within captionMax; for reels (FEAT-201) the scene count of
// the chosen style, whole seconds of 3–5 per scene, durationSec = Σ seconds within config.defaults.reel, and
// capture only when the brand lists product screens to capture.
export function validateWriterOutput(json, { format, offeredIds, caps = DEFAULT_CAPS, reel = null } = {}) {
  const errors = [];
  const offered = offeredIds instanceof Set ? offeredIds : new Set(offeredIds || []);
  (Array.isArray(json.factsUsed) ? json.factsUsed : []).forEach((f, i) => {
    if (!offered.has(f.factId)) errors.push(`$.factsUsed[${i}].factId: ${f.factId} was not offered (usable facts only)`);
  });
  if (format === "image" && !json.artwork) errors.push("$.artwork: required for format image");
  if (format === "carousel" && !Array.isArray(json.slides)) errors.push("$.slides: required for format carousel");
  if (format === "reel" && !json.reel) errors.push("$.reel: required for format reel");
  errors.push(...visualAltTextErrors(json, format));
  errors.push(...rishtapatraLocalFirstErrors(json));
  if (format === "reel" && json.reel && typeof json.reel === "object") errors.push(...reelErrors(json.reel, reel || reelRules(null, null)));
  const max = caps.captionMax || DEFAULT_CAPS.captionMax;
  const full = codePoints(fullCaption({ caption: json.caption, hashtags: json.hashtags }));
  if (full > max) errors.push(`$.caption: ${full} characters with the hashtag line, limit ${max}`);
  return errors;
}

// reelErrors(reel, rules) → errors[] for the reel block beyond its shape (pure; FEAT-201).
export function reelErrors(reel, rules) {
  const errors = [];
  const scenes = Array.isArray(reel.scenes) ? reel.scenes : [];
  const range = reel.style === "capture" ? rules.captureScenes : rules.kineticScenes;
  if ((reel.style === "kinetic" || reel.style === "capture") && (scenes.length < range[0] || scenes.length > range[1])) errors.push(`$.reel.scenes: ${reel.style} reels take ${range[0]}–${range[1]} scenes (${scenes.length})`);
  if (reel.style === "capture" && rules.capturePaths.length === 0) errors.push("$.reel.style: capture needs product screens to record and this brand lists none; use kinetic");
  let sum = 0;
  scenes.forEach((s, i) => {
    const sec = s && s.seconds;
    if (!Number.isInteger(sec) || sec < rules.seconds[0] || sec > rules.seconds[1]) errors.push(`$.reel.scenes[${i}].seconds: expected a whole number of ${rules.seconds[0]}–${rules.seconds[1]} seconds (${JSON.stringify(sec)})`);
    else sum += sec;
    if (s && typeof s.text === "string" && !s.text.trim()) errors.push(`$.reel.scenes[${i}].text: empty`);
  });
  if (scenes.length && errors.every((e) => !e.includes(".seconds"))) {
    if (reel.durationSec !== sum) errors.push(`$.reel.durationSec: ${JSON.stringify(reel.durationSec)} is not the sum of the scenes' seconds (${sum})`);
    if (sum < rules.minSec || sum > rules.maxSec) errors.push(`$.reel.scenes: the scenes add up to ${sum} s, a reel must run ${rules.minSec}–${rules.maxSec} s`);
  }
  return errors;
}

function captionText(c) {
  return typeof c === "string" ? c : c && typeof c.caption === "string" ? c.caption : "";
}

const PREVIOUS_KEYS = ["caption", "hashtags", "altText", "altTexts", "artwork", "slides", "reel", "factsUsed", "writerNote"];

// The task JSON (charter "Inputs you receive in the task JSON").
export function buildTask({ slot, idea, brand, page, config, recentCaptions = [], qaReasons = [], draft = null, feedbackDigest = "" }) {
  const caps = capsOf(config);
  const fm = brand.frontMatter || {};
  let rework = null;
  if (draft || qaReasons.length) {
    const previous = {};
    for (const k of PREVIOUS_KEYS) if (draft && draft[k] !== undefined) previous[k] = draft[k];
    rework = { revision: draft ? draft.revision : null, reasons: [...qaReasons], previous };
  }
  const reel = reelRules(config, brand);
  const format = { name: slot.format, caps: { ...caps, ...ARTWORK_CAPS, slideHeading: SLIDE_CAPS.heading, slideBody: SLIDE_CAPS.body }, spec: formatSpecText(slot.format, caps, reel) };
  if (slot.format === "reel") format.reel = { minSec: reel.minSec, maxSec: reel.maxSec, kineticScenes: reel.kineticScenes, captureScenes: reel.captureScenes, secondsPerScene: reel.seconds, sceneMax: REEL_CAPS.scene, captureScreens: reel.capturePaths };
  return {
    page: { handle: page.handle, languages: page.languages, emoji: fm.emoji || null, site: fm.site || null },
    slot: { slotId: slot.slotId, at: slot.at, format: slot.format },
    idea: { id: idea.id, title: idea.title, angle: idea.angle, format: idea.format, language: idea.language, factIds: idea.facts || idea.factIds || [], hook: idea.hook || "" },
    format,
    brand: {
      name: fm.name || null,
      voice: (brand.voice && brand.voice.bullets) || [],
      facts: usableFacts(brand).map((f) => ({ id: f.id, fact: f.fact })),
      pricing: (brand.pricing || []).map((p) => ({ sku: p.sku, price: p.price })),
      disclaimers: brand.disclaimers || [],
      forbidden: brand.forbidden || [],
      allowedDomains: brand.allowedDomains || [],
    },
    copyRules: {
      altText: "Describe only the branded text artwork that will be rendered. Name the card/graphic/slide, repeat visible words, and never call it a product screen, editor, page or preview.",
      ...(fm.handle === "rishtapatra"
        ? { localFirst: "rp-f05 applies only to the local biodata-making flow. Say create/build your biodata, never a Rishta Connect/family/matchmaking profile; qualify every privacy claim with biodata, editor, browser, details, photo or resume." }
        : {}),
    },
    recentCaptions: recentCaptions.map(captionText).filter(Boolean).slice(-RECENT_CAPTIONS),
    rework,
    feedback: feedbackDigest || "",
  };
}

// The draft record for a validated answer (pure). Images keep `artwork`, carousels keep `slides`
// (+ altTexts, one per slide), reels keep `reel`; the other blocks are dropped. A rework keeps the
// draft's identity and reworkCount and bumps the revision.
export function draftFromOutput({ output, slot, idea, page, existing = null, existingIds = [], now, runId, mock = false }) {
  const at = nowIst(toDate(now));
  const format = slot.format;
  const content = { caption: output.caption, hashtags: [...output.hashtags], altText: output.altText, factsUsed: output.factsUsed.map((f) => ({ factId: f.factId, quote: f.quote })) };
  if (format === "image") content.artwork = { headline: output.artwork.headline, subline: output.artwork.subline, facts: [...output.artwork.facts], footer: output.artwork.footer };
  if (format === "carousel") {
    content.slides = output.slides.map((s) => ({ heading: s.heading, body: s.body, altText: s.altText }));
    content.altTexts = output.slides.map((s) => s.altText);
  }
  if (format === "reel") content.reel = { style: output.reel.style, durationSec: output.reel.durationSec, scenes: output.reel.scenes.map((s) => ({ text: s.text, seconds: s.seconds })) };
  if (typeof output.writerNote === "string" && output.writerNote.trim()) content.writerNote = output.writerNote;

  if (existing) {
    const next = { ...existing, ...content, status: "written", revision: existing.revision + 1, mock: mock === true, updatedAt: at, by: AGENT, runId: runId || existing.runId, media: [] };
    for (const k of ["artwork", "slides", "altTexts", "reel", "writerNote", "qaReasons", "renderError", "designNote"]) if (!(k in content) || content[k] === undefined) delete next[k];
    return next;
  }
  const id = makeDraftId(page.prefix, slot.at, idea.title, existingIds);
  return {
    id,
    page: page.handle,
    ideaId: idea.id,
    slotId: slot.slotId,
    slotAt: slot.at,
    format,
    language: idea.language,
    status: "written",
    revision: 1,
    reworkCount: 0,
    mock: mock === true,
    createdAt: at,
    updatedAt: at,
    by: AGENT,
    runId,
    ...content,
    media: [],
    publishAttempts: [],
  };
}

// runWriter(…) → { ok, draft, created, modelCalled, calls, costUsd, mock, repaired } or, after an
// AgentOutputError, { ok:false, reason:'invalid_output', error, draft (existing, marked) | null }.
export async function runWriter({ slot, idea, brand, page, config, state, router, draft = null, qaReasons, recentCaptions = [], now, runId, feedbackDigest = "" } = {}) {
  if (!slot || !idea || !brand || !page || !config || !state || !router) throw new TypeError("writer: slot, idea, brand, page, config, state and router are required");
  const nowDate = toDate(now === undefined ? state.now() : now);
  const id = runId || router.runId;
  const reasons = Array.isArray(qaReasons) ? qaReasons : draft && Array.isArray(draft.qaReasons) ? draft.qaReasons : [];
  const caps = capsOf(config);
  const offered = new Set(usableFacts(brand).map((f) => f.id));
  const task = buildTask({ slot, idea, brand, page, config, recentCaptions, qaReasons: reasons, draft, feedbackDigest });

  let res;
  try {
    res = await router.complete(AGENT, {
      task,
      spec: outputSpec(caps),
      context: { brand, page, feedbackDigest },
      validate: (json) => validateWriterOutput(json, { format: slot.format, offeredIds: offered, caps, reel: reelRules(config, brand) }),
    });
  } catch (e) {
    if (!(e instanceof AgentOutputError)) throw e;
    const detail = (e.repairErrors.length ? e.repairErrors : e.errors).slice(0, 3).join("; ");
    const reason = `${INVALID_OUTPUT_REASON}: ${detail}`;
    let marked = null;
    if (draft) {
      const kept = (draft.qaReasons || []).filter((r) => !String(r).startsWith(`${INVALID_OUTPUT_REASON}:`) && r !== INVALID_OUTPUT_REASON);
      marked = { ...draft, status: "rework", updatedAt: nowIst(nowDate), qaReasons: [...kept, reason] };
      state.writeDraft(marked);
    }
    return { ok: false, reason: INVALID_OUTPUT_REASON, error: e, draft: marked, created: false, modelCalled: true, calls: e.calls, costUsd: 0, mock: e.provider === "mock", repaired: false };
  }

  const record = draftFromOutput({ output: res.json, slot, idea, page, existing: draft, existingIds: draft ? [] : state.listDrafts(), now: nowDate, runId: id, mock: res.mock === true });
  state.writeDraft(record);
  return { ok: true, draft: record, created: !draft, modelCalled: true, calls: res.calls, costUsd: res.costUsd, mock: res.mock === true, repaired: res.repaired === true };
}
