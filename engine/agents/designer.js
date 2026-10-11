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
import { join } from "node:path";
import { mediaBranchPresent, mediaPaths, pagesUrl, rawUrl, updateIndex } from "../lib/media.js";
import { nowIst } from "../lib/time.js";
import { RenderError, RenderUnavailableError, createRenderer } from "../render/render.js";
import { nextStatus } from "./qa.js";

export const AGENT = "designer";
export const SKIP_MEDIA_BRANCH_MISSING = "media_branch_missing";
export const FLAG_RENDER_FAILED = "render_failed";
export const RENDER_REASON_PREFIX = "render: ";

// The qaReasons entry a refusal leaves for the Writer: 'render: missing_glyphs — U+2192 not in Inter: “…”'.
export function renderReason(err) {
  return `${RENDER_REASON_PREFIX}${err.code} — ${String(err.detail).slice(0, 1000)}`;
}

function toDate(v) {
  if (v === undefined || v === null) return new Date();
  if (typeof v === "function") return toDate(v());
  return v instanceof Date ? v : new Date(v);
}

// 'variant A · dark console palette' / '4 slides · variant A · cream on ink'
export function designNote(result, draft) {
  const first = result.media[0] || {};
  const parts = [];
  if (draft.format === "carousel") parts.push(`${result.media.length} slides`);
  parts.push(`variant ${first.variant || "?"}`);
  if (first.palette) parts.push(first.palette);
  return parts.join(" · ");
}

// The media[] rows the draft records (MEDIA_ITEM_SPEC): file metadata plus the two URLs.
export function mediaRows(result, config) {
  return result.media.map((m) => ({ kind: "image", path: m.path, bytes: m.bytes, width: m.width, height: m.height, sha256: m.sha256, rawUrl: rawUrl(config, m.path), pagesUrl: pagesUrl(config, m.path) }));
}

// runDesigner({ drafts, brands, config, state, mediaRoot='.media', renderer, now, runId })
//   → { ok, skipped?, rendered, refused, results: [{ id, status, code?, detail? }], note, flags, changed }
//   drafts: draft records (only status `written` are rendered); brands: loadCompany().brands;
//   renderer: createRenderer()-shaped { renderDraft(draft, brand, { outDir }), close() } (injectable).
export async function runDesigner({ drafts = [], brands, config, state, mediaRoot = ".media", renderer, now, runId, log = () => {} } = {}) {
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
  let rendered = 0;
  let refused = 0;
  let toRework = 0;
  let blocked = 0;
  let failure = null;
  try {
    for (const draft of queue) {
      const brand = brands[draft.page];
      if (!brand) throw new TypeError(`designer: no brand loaded for page ${draft.page} (draft ${draft.id})`);
      const at = nowIst(toDate(now === undefined ? state.now() : now));
      const outDir = join(mediaRoot, "media", draft.id);
      try {
        const result = await r.renderDraft(draft, brand, { outDir, relDir: mediaPaths(draft.id).dir });
        const next = { ...draft, status: "rendered", updatedAt: at, media: mediaRows(result, config), designNote: designNote(result, draft) };
        if (runId) next.runId = runId;
        delete next.renderError;
        changed.push(state.writeDraft(next));
        updateIndex(mediaRoot, draft.id, result.media.map((m) => m.file));
        rendered++;
        results.push({ id: draft.id, status: "rendered", files: result.media.map((m) => m.file), note: next.designNote });
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
  // design §11 "Render" row: any render failure — a refused draft or a dead renderer — raises render_failed
  if (refused > 0 && !flags.includes(FLAG_RENDER_FAILED)) flags.push(FLAG_RENDER_FAILED);
  const refusedNote = refused > 0 ? `${refused} refused (${toRework} to rework, ${blocked} blocked)` : `${refused} refused`;
  const note = failure ? `${rendered} rendered, ${refusedNote}, stopped: ${failure.message}` : `${rendered} rendered, ${refusedNote}`;
  return { ok: !failure, rendered, refused, toRework, blocked, results, changed, flags, note, error: failure || undefined };
}
