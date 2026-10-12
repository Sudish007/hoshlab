// Designer agent — deterministic code, no language model (design.md §5 row "Designer", §10, §11; review
// M8/M13/M16; plan D19). For every draft in status `written` it renders the image or every carousel
// slide through engine/render/render.js into the media worktree (.media/media/<draftId>/), records
// media[] (sha256-named files with rawUrl + pagesUrl) and moves the draft to `rendered`.
//
//   • .media/.git absent → { skipped: 'media_branch_missing' }: nothing rendered, no draft touched; the
//     caller adds the `media_branch_missing` flag (M16 — the engine never creates the branch).
//   • RenderError (overflow, missing_glyphs, text_floor, contrast, media_spec) is treated like a failed
//     deterministic QA check (Phase 1 review R1-02, an endorsed deviation from design §11's "stays written"):
//     the draft goes to `rework` with qaReasons[0] = 'render: <code> — <detail>' and reworkCount + 1, or to
//     `blocked` once reworkCount has reached config.defaults.maxReworkLoops (qa.nextStatus — the same cap);
//     media is emptied, renderError { code, detail, at } is kept for the admin card; the run continues with
//     the next draft and the step reports flag `render_failed` (design §11 "Render" row) while staying ok.
//     The caller (engine/commands/daily.js) feeds the `rework` ids into the inline rework loop.
//   • RenderUnavailableError (Chromium missing, font face failed) → the step stops: ok:false, flag
//     `render_failed`; drafts not yet rendered stay `written` untouched.
//   • Reels (FEAT-201): a CaptureError (the product site did not answer — `capture_unreachable`) or a
//     RenderUnavailableError with code `ffmpeg` (ffmpeg/ffprobe missing, encoder or probe failure) is nobody's
//     fault inside the company: the draft STAYS `written` with renderError { code, detail, at } (design §10
//     "Failure → draft stays written"), the step reports flag `render_failed` and carries on with the next
//     draft; locally without ffmpeg the note reads 'reel: untested — ffmpeg not installed'.
//   • Owner feedback (FEAT-205, plan D23): feedback.jsonl entries for the page tagged design / variant / palette
//     whose text names a variant or a palette (engine/lib/feedback.js designPreferences — a strict keyword match,
//     nothing inferred, no model call) are handed to the renderer as `prefer` for image and carousel drafts: the
//     templates set the preferred headline tier and, where a template offers both palettes, the preferred palette.
//     When the preferred rendering fails a guard (the copy does not fit the bigger tier) the draft is rendered once
//     more without the preference — the measured tier, the brand palette — and the fallback is recorded. Every
//     outcome is written to draft.designNote ('variant B · dark console palette · variant B preferred by owner
//     feedback 2026-10-10'). Reels take no preference (their tier is per scene).
import { join } from "node:path";
import { designPreferences, hasPreference } from "../lib/feedback.js";
import { mediaBranchPresent, mediaPaths, pagesUrl, rawUrl, updateIndex } from "../lib/media.js";
import { nowIst } from "../lib/time.js";
import { CaptureError } from "../render/capture.js";
import { RenderError, RenderUnavailableError, createRenderer } from "../render/render.js";
import { nextStatus } from "./qa.js";

export const AGENT = "designer";
export const SKIP_MEDIA_BRANCH_MISSING = "media_branch_missing";
export const FLAG_RENDER_FAILED = "render_failed";
export const RENDER_REASON_PREFIX = "render: ";
export const FFMPEG_UNTESTED_NOTE = "reel: untested — ffmpeg not installed";
export const PREFERENCE_FORMATS = ["image", "carousel"];

// A reel failure that leaves the draft `written` for the next run (not a refusal of the Writer's copy).
export function isDeferral(err) {
  return err instanceof CaptureError || (err instanceof RenderUnavailableError && err.code === "ffmpeg");
}

// The qaReasons entry a refusal leaves for the Writer: 'render: missing_glyphs — U+2192 not in Inter: “…”'.
export function renderReason(err) {
  return `${RENDER_REASON_PREFIX}${err.code} — ${String(err.detail).slice(0, 1000)}`;
}

function toDate(v) {
  if (v === undefined || v === null) return new Date();
  if (typeof v === "function") return toDate(v());
  return v instanceof Date ? v : new Date(v);
}

// The renderer's `prefer` argument for a draft, or null: the owner's preferences for the page (designPreferences)
// apply to image and carousel artwork only.
export function preferFor(draft, prefs) {
  if (!PREFERENCE_FORMATS.includes(draft.format) || !hasPreference(prefs)) return null;
  return { variant: prefs.preferVariant || null, palette: prefs.preferPalette || null };
}

// What the designNote says about the owner's preference, from the render result:
//   'variant B preferred by owner feedback 2026-10-10'                                   — applied
//   'dark palette preferred by owner feedback 2026-10-10 — not offered by this template, brand palette kept'
//   'variant A preferred by owner feedback 2026-10-10 — did not fit (overflow), measured tier kept'  — fallback
export function preferenceNote(prefs, result, fallback = null) {
  if (!hasPreference(prefs)) return "";
  if (fallback) return `${prefs.reasons.join(" and ")} — did not fit (${fallback.code}), measured tier${prefs.preferPalette ? " and brand palette" : ""} kept`;
  const parts = [];
  const applied = (result && result.applied) || {};
  if (prefs.preferVariant) {
    const ok = applied.variant === true || (applied.variant === undefined && result.media.length > 0 && result.media.every((m) => m.variant === prefs.preferVariant));
    parts.push(ok ? prefs.variantReason : `${prefs.variantReason} — not applied by this template, measured tier kept`);
  }
  if (prefs.preferPalette) parts.push(applied.palette === true ? prefs.paletteReason : `${prefs.paletteReason} — not offered by this template, brand palette kept`);
  return parts.join(" · ");
}

// 'variant A · dark console palette' / '4 slides · variant A · cream on ink' /
// 'reel kinetic · 4 scenes · 18 s · 540 frames · cream and maroon' /
// 'variant B · dark console palette · variant B preferred by owner feedback 2026-10-10' (FEAT-205)
export function designNote(result, draft, { prefs = null, fallback = null } = {}) {
  const first = result.media[0] || {};
  const parts = [];
  if (draft.format === "reel") {
    parts.push(`reel ${result.style || (draft.reel && draft.reel.style) || "?"}`);
    if (result.scenes) parts.push(`${result.scenes} scenes`);
    if (result.durationSec) parts.push(`${result.durationSec} s`);
    if (result.frames) parts.push(`${result.frames} frames`);
    if (first.palette) parts.push(first.palette);
    return parts.join(" · ");
  }
  if (draft.format === "carousel") parts.push(`${result.media.length} slides`);
  parts.push(`variant ${first.variant || "?"}`);
  if (first.palette) parts.push(first.palette);
  const preference = preferFor(draft, prefs) ? preferenceNote(prefs, result, fallback) : "";
  if (preference) parts.push(preference);
  return parts.join(" · ");
}

// The media[] rows the draft records (MEDIA_ITEM_SPEC): file metadata plus the two URLs; a reel's video row
// carries durationSec and the ffprobe summary (PROBE_SUMMARY_SPEC) QA's media_spec reads back.
export function mediaRows(result, config) {
  return result.media.map((m) => {
    const row = { kind: m.kind === "video" || m.kind === "poster" ? m.kind : "image", path: m.path, bytes: m.bytes, width: m.width, height: m.height, sha256: m.sha256, rawUrl: rawUrl(config, m.path), pagesUrl: pagesUrl(config, m.path) };
    if (m.kind === "video") {
      if (typeof m.durationSec === "number") row.durationSec = m.durationSec;
      if (m.probe) row.probe = m.probe;
    }
    return row;
  });
}

// The draft a deferred reel leaves behind: still `written`, media emptied, renderError for the admin card.
export function deferredDraft(draft, err, at, runId) {
  const detail = String(err.detail || err.message || err.code).slice(0, 1000);
  const next = { ...draft, status: "written", updatedAt: at, media: [], renderError: { code: err.code, detail, at } };
  if (runId) next.runId = runId;
  delete next.designNote;
  return next;
}

// runDesigner({ drafts, brands, config, state, mediaRoot='.media', renderer, now, runId, feedback })
//   → { ok, skipped?, rendered, refused, results: [{ id, status, code?, detail? }], note, flags, changed }
//   drafts: draft records (only status `written` are rendered); brands: loadCompany().brands;
//   renderer: createRenderer()-shaped { renderDraft(draft, brand, { outDir, relDir, prefer }), close() } (injectable);
//   feedback: the feedback.jsonl records (default: read from the state) — the source of the design preferences.
export async function runDesigner({ drafts = [], brands, config, state, mediaRoot = ".media", renderer, now, runId, log = () => {}, feedback } = {}) {
  if (!brands || !config || !state) throw new TypeError("designer: brands, config and state are required");
  const flags = [];
  const results = [];
  const changed = [];
  if (!mediaBranchPresent(mediaRoot)) {
    flags.push(SKIP_MEDIA_BRANCH_MISSING);
    return { ok: true, skipped: SKIP_MEDIA_BRANCH_MISSING, rendered: 0, refused: 0, results, changed, flags, note: `media branch worktree missing (${join(mediaRoot, ".git")}) — not configured yet; nothing rendered` };
  }
  const queue = drafts.filter((d) => d && d.status === "written");
  const r = renderer || createRenderer();
  const feedbackRows = Array.isArray(feedback) ? feedback : state.readJsonl("state/feedback.jsonl");
  const prefsByPage = new Map();
  const prefsFor = (handle) => {
    if (!prefsByPage.has(handle)) prefsByPage.set(handle, designPreferences({ feedback: feedbackRows, page: handle, now: now === undefined ? state.now() : now }));
    return prefsByPage.get(handle);
  };
  let rendered = 0;
  let refused = 0;
  let deferred = 0;
  let untested = false;
  let toRework = 0;
  let blocked = 0;
  let preferred = 0;
  let fellBack = 0;
  let failure = null;
  try {
    for (const draft of queue) {
      const brand = brands[draft.page];
      if (!brand) throw new TypeError(`designer: no brand loaded for page ${draft.page} (draft ${draft.id})`);
      const at = nowIst(toDate(now === undefined ? state.now() : now));
      const outDir = join(mediaRoot, "media", draft.id);
      const relDir = mediaPaths(draft.id).dir;
      const prefs = prefsFor(draft.page);
      const prefer = preferFor(draft, prefs);
      try {
        let result;
        let fallback = null;
        try {
          result = await r.renderDraft(draft, brand, prefer ? { outDir, relDir, prefer } : { outDir, relDir });
        } catch (err) {
          if (!prefer || !(err instanceof RenderError)) throw err;
          // the owner's preferred tier / palette did not fit this copy: render the measured tier on the brand palette
          fallback = err;
          log(`[designer] ${draft.id} preference (${prefs.reasons.join("; ")}) did not fit: ${err.code} — ${err.detail}; rendering the measured tier`);
          result = await r.renderDraft(draft, brand, { outDir, relDir });
        }
        if (prefer) {
          preferred++;
          if (fallback) fellBack++;
        }
        const next = { ...draft, status: "rendered", updatedAt: at, media: mediaRows(result, config), designNote: designNote(result, draft, { prefs, fallback }) };
        if (runId) next.runId = runId;
        delete next.renderError;
        changed.push(state.writeDraft(next));
        updateIndex(mediaRoot, draft.id, result.media.map((m) => m.file));
        rendered++;
        results.push({ id: draft.id, status: "rendered", files: result.media.map((m) => m.file), note: next.designNote, prefer, fallback: fallback ? fallback.code : null });
        log(`[designer] ${draft.id} rendered ${result.media.length} file${result.media.length === 1 ? "" : "s"} (${next.designNote})`);
      } catch (err) {
        if (err instanceof RenderError) {
          refused++;
          // R1-02: a refusal is a deterministic QA failure — rework (reworkCount + 1) or blocked at the cap
          const status = nextStatus(draft, false, config);
          const reason = renderReason(err);
          const next = { ...draft, status, updatedAt: at, media: [], qaReasons: [reason, ...(draft.qaReasons || []).filter((x) => x !== reason)], renderError: { code: err.code, detail: String(err.detail).slice(0, 1000), at } };
          if (status === "rework") {
            next.reworkCount = (draft.reworkCount || 0) + 1;
            toRework++;
          } else blocked++;
          if (runId) next.runId = runId;
          delete next.designNote;
          changed.push(state.writeDraft(next));
          results.push({ id: draft.id, status, code: err.code, detail: err.detail });
          log(`[designer] ${draft.id} refused: ${err.code} — ${err.detail} → ${status === "rework" ? `rework (${next.reworkCount} of ${config.defaults.maxReworkLoops})` : "blocked for the owner"}`);
          continue;
        }
        if (isDeferral(err)) {
          // FEAT-201: the product site or ffmpeg, not the copy — the draft waits, still `written`
          deferred++;
          const next = deferredDraft(draft, err, at, runId);
          changed.push(state.writeDraft(next));
          const ffmpegMissing = err.code === "ffmpeg" && /not installed/.test(err.message);
          if (ffmpegMissing) untested = true;
          results.push({ id: draft.id, status: "written", code: err.code, detail: next.renderError.detail, deferred: true });
          log(`[designer] ${draft.id} deferred: ${err.code} — ${next.renderError.detail} → stays written${ffmpegMissing ? ` (${FFMPEG_UNTESTED_NOTE})` : ""}`);
          continue;
        }
        if (err instanceof RenderUnavailableError) {
          failure = err;
          flags.push(FLAG_RENDER_FAILED);
          results.push({ id: draft.id, status: "written", code: err.code, detail: err.message });
          log(`[designer] stopped: ${err.message}`);
          break;
        }
        throw err;
      }
    }
  } finally {
    if (!renderer) await r.close();
  }
  // design §11 "Render" row: any render failure — a refused draft, a deferred reel or a dead renderer — raises render_failed
  if ((refused > 0 || deferred > 0) && !flags.includes(FLAG_RENDER_FAILED)) flags.push(FLAG_RENDER_FAILED);
  const refusedNote = refused > 0 ? `${refused} refused (${toRework} to rework, ${blocked} blocked)` : `${refused} refused`;
  const parts = [`${rendered} rendered`, refusedNote];
  if (deferred > 0) parts.push(`${deferred} deferred (still written)${untested ? ` — ${FFMPEG_UNTESTED_NOTE}` : ""}`);
  if (preferred > 0) parts.push(`${preferred} with owner design preference${fellBack ? ` (${fellBack} fell back to the measured tier)` : ""}`);
  const note = failure ? `${parts.join(", ")}, stopped: ${failure.message}` : parts.join(", ");
  return { ok: !failure, rendered, refused, deferred, toRework, blocked, preferred, fellBack, results, changed, flags, note, error: failure || undefined };
}
