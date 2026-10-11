// QA / Editor agent (design.md §4.7 qa.json, §5 row "QA / Editor", §12 invariants; review M5/M14;
// plan D9). The last gate before a draft can be queued:
//
//   1. a draft with mock:true never passes — qa.json { passed:false, reasons:['mock_output'] }, model not called;
//   2. the twelve deterministic checks (engine/lib/checks.js) run first; when any fails the model is NOT
//      called (saves budget) and qa.json carries model:null;
//   3. otherwise router.complete('qa', …) judges claims, tone and disclaimers; the verdict is `fail` when
//      the model says so, when any claim lacks a USABLE fact id (disputed or unknown ids count as none),
//      when any claim is ok:false, or when toneScore < 3;
//   4. passed = deterministic.passed && model.verdict === 'pass'; qa.json is written with QA_SPEC;
//   5. the draft moves to `queued` (pass) or, with reworkCount < config.defaults.maxReworkLoops, to
//      `rework` (reworkCount + 1, reasons kept on the draft as qaReasons for the Writer), else `blocked`.
//
// Router errors (BudgetExhaustedError, AgentOutputError, AllProvidersFailedError) propagate untouched and
// nothing is written: the draft stays `rendered` and the caller records the skip/error for the run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { usableFacts } from "../lib/brand.js";
import { runChecks } from "../lib/checks.js";
import { istDate, nowIst } from "../lib/time.js";

export const AGENT = "qa";
export const MOCK_OUTPUT_REASON = "mock_output";
export const MIN_TONE_SCORE = 3;

// The model's JSON output (design §5). toneScore is 1–5 like QA_SPEC so an out-of-range score is
// repaired by the router instead of failing the qa.json write; factId stays a free string here and is
// checked against the brand's usable facts in judge().
export const OUTPUT_SPEC = {
  verdict: "enum[pass|fail]",
  toneScore: "int[1..5]",
  claims: [{ claim: "str", "factId?": "str", ok: "bool" }],
  reasons: ["str"],
  "notes?": "str",
};

const TASK_DRAFT_KEYS = ["id", "page", "format", "language", "revision", "reworkCount", "caption", "hashtags", "altText", "altTexts", "artwork", "slides", "reel", "factsUsed", "writerNote"];

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

// Media metadata for the task JSON (never pixels): byte count, dimensions, kind, file name; a reel's video
// row adds its duration and the Designer's ffprobe summary (FEAT-201).
export function mediaSummary(media = []) {
  return media.map((m) => {
    const data = toBytes(m && m.bytes);
    const out = {
      kind: (m && m.kind) || "image",
      bytes: data ? data.byteLength : Number.isInteger(m && m.bytes) ? m.bytes : null,
      width: (m && m.width) ?? null,
      height: (m && m.height) ?? null,
      path: (m && m.path) || null,
    };
    if (m && typeof m.durationSec === "number") out.durationSec = m.durationSec;
    if (m && m.probe) out.probe = m.probe;
    return out;
  });
}

// Reads the rendered files named in draft.media[] from the media worktree root (default `.media`);
// paths are 'media/<draftId>/<file>' and also resolve when the root already IS the media/ folder
// (tests/fixtures/media). A missing file yields bytes:null so media_spec fails honestly. The video row's
// `probe` (the Designer's ffprobe summary) and `durationSec` pass through for the reel branch of media_spec.
export function loadMedia(draft, mediaRoot = ".media") {
  return (draft.media || []).map((m) => {
    const rel = String(m.path || "").replace(/\\/g, "/");
    const candidates = [join(mediaRoot, rel), join(mediaRoot, rel.replace(/^media\//, ""))];
    const file = candidates.find((p) => rel && existsSync(p));
    const base = { kind: m.kind, width: m.width, height: m.height, path: m.path };
    if (typeof m.durationSec === "number") base.durationSec = m.durationSec;
    if (m.probe) base.probe = m.probe;
    if (!file) return { ...base, bytes: null };
    const buf = readFileSync(file);
    return { ...base, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  });
}

// The task JSON the model receives (charter "Inputs you receive in the task JSON").
export function buildTask({ draft, brand, media = [], deterministic }) {
  const d = {};
  for (const k of TASK_DRAFT_KEYS) if (draft[k] !== undefined) d[k] = draft[k];
  const fm = brand.frontMatter || {};
  return {
    draft: d,
    media: mediaSummary(media),
    brand: {
      handle: fm.handle,
      name: fm.name,
      languages: fm.languages,
      emoji: fm.emoji,
      voice: (brand.voice && brand.voice.bullets) || [],
      facts: usableFacts(brand).map((f) => ({ id: f.id, fact: f.fact })),
      pricing: (brand.pricing || []).map((p) => ({ sku: p.sku, price: p.price })),
      disclaimers: brand.disclaimers || [],
      forbidden: brand.forbidden || [],
      allowedDomains: brand.allowedDomains || [],
    },
    deterministic: deterministic ? deterministic.checks : [],
  };
}

// Ids a claim may cite: the brand's usable fact ids (disputed excluded) and, for price claims, the
// sku of a ## Pricing row (the only place a ₹ figure may come from, design §4.3).
export function claimSourceIds(brand) {
  const ids = new Set(usableFacts(brand).map((f) => f.id));
  for (const p of brand.pricing || []) if (typeof p.sku === "string" && p.sku) ids.add(p.sku);
  return ids;
}

// judge(output, brand) → { verdict, toneScore, claims, reasons, notes }: the engine's verdict over the
// model's answer. A claim counts as sourced only when its factId is a usable fact (or pricing sku) of
// this brand — disputed and unknown ids are dropped ("never pass a disputed fact"); fail when the
// model says fail, any claim is unsourced or ok:false, or toneScore < MIN_TONE_SCORE.
export function judge(output, brand) {
  const usable = claimSourceIds(brand);
  const modelReasons = Array.isArray(output.reasons) ? output.reasons.map((r) => String(r).trim()).filter(Boolean) : [];
  const generated = [];
  const claims = (Array.isArray(output.claims) ? output.claims : []).map((c) => {
    const text = String((c && c.claim) || "").trim();
    const id = c && typeof c.factId === "string" ? c.factId.trim() : null;
    const sourced = id !== null && usable.has(id);
    const claim = { claim: text, ok: sourced && c.ok === true };
    if (sourced) claim.factId = id;
    if (!sourced) generated.push(id ? `claim cites ${id}, which is not a usable fact of this brand: "${text}"` : `claim without a fact id: "${text}"`);
    else if (c.ok !== true && modelReasons.length === 0) generated.push(`claim overstates ${id}: "${text}"`);
    return claim;
  });
  const toneScore = Number.isInteger(output.toneScore) ? output.toneScore : 0;
  if (toneScore < MIN_TONE_SCORE) generated.push(`tone score ${toneScore} below ${MIN_TONE_SCORE}`);
  const fail = output.verdict === "fail" || toneScore < MIN_TONE_SCORE || claims.some((c) => !c.ok);
  const reasons = fail ? [...new Set([...modelReasons, ...generated])] : [];
  if (fail && reasons.length === 0) reasons.push("model verdict fail");
  const out = { verdict: fail ? "fail" : "pass", toneScore, claims, reasons };
  if (typeof output.notes === "string") out.notes = output.notes;
  return out;
}

// Where a draft goes after QA (design §4.7, plan D9).
export function nextStatus(draft, passed, config) {
  if (passed) return "queued";
  const max = config.defaults.maxReworkLoops;
  return (draft.reworkCount || 0) < max ? "rework" : "blocked";
}

// runQa({ draft, brand, config, router, state, recentCaptions, media, mediaRoot, runId, now })
//   → { passed, reasons, modelCalled, status, qa, draft }
//   media: [{ kind, bytes (Uint8Array | number), width, height, path }]; when omitted the files named in
//   draft.media[] are read from mediaRoot (when given) or the draft's own metadata is checked.
export async function runQa({ draft, brand, config, router, state, recentCaptions = [], media, mediaRoot, runId, now } = {}) {
  if (!draft || !brand || !config || !state) throw new TypeError("qa: draft, brand, config and state are required");
  const clock = () => {
    const v = typeof now === "function" ? now() : now;
    if (v === undefined) return state.now();
    return v instanceof Date ? v : new Date(v);
  };
  const mediaItems = Array.isArray(media) ? media : mediaRoot ? loadMedia(draft, mediaRoot) : draft.media || [];
  const deterministic = runChecks(draft, brand, { config, slotDate: istDate(draft.slotAt), recentCaptions, media: mediaItems });

  let model = null;
  let modelCalled = false;
  let passed;
  let reasons;
  let mock = draft.mock === true;
  if (draft.mock === true) {
    passed = false;
    reasons = [MOCK_OUTPUT_REASON];
  } else if (!deterministic.passed) {
    passed = false;
    reasons = deterministic.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  } else {
    if (!router) throw new TypeError("qa: router is required once the deterministic checks pass");
    const res = await router.complete(AGENT, {
      task: buildTask({ draft, brand, media: mediaItems, deterministic }),
      spec: OUTPUT_SPEC,
      context: { brand, page: draft.page },
    });
    modelCalled = true;
    const j = judge(res.json, brand);
    model = { provider: res.provider, model: res.model, verdict: j.verdict, toneScore: j.toneScore, claims: j.claims, reasons: j.reasons };
    if (j.notes !== undefined) model.notes = j.notes;
    passed = deterministic.passed && j.verdict === "pass";
    reasons = j.reasons;
    mock = res.mock === true;
  }

  const at = nowIst(clock());
  const qa = { draftId: draft.id, revision: draft.revision, at, passed, deterministic, model, reasons, mock };
  const id = runId || (router && router.runId);
  if (id) qa.runId = id;
  state.writeQa(qa);

  const status = nextStatus(draft, passed, config);
  const updated = { ...draft, status, updatedAt: at, qaRef: `drafts/${draft.id}/qa.json` };
  if (passed) delete updated.qaReasons;
  else {
    updated.qaReasons = reasons;
    if (status === "rework") updated.reworkCount = (draft.reworkCount || 0) + 1;
  }
  state.writeDraft(updated);
  return { passed, reasons, modelCalled, status, qa, draft: updated };
}
