// Publisher agent — deterministic code, no language model (design.md §3.2, §5 row "Publisher", §9, §11;
// review M5 lifecycle; plan D9). The ONLY code path that calls client.publish(); the admin cannot bypass
// it because the admin holds no Instagram token (design §12 "Invariant ownership").
//
//   decide(draft, approvals, page, now, config, pageState, recentPublishes) → { publish, reason }
//     pure, unit-tested as a truth table; rules evaluated in this order:
//       status !== queued                              → 'status:<s>'
//       now − slotAt > expireAfterHours                → 'expired'            (M5.1)
//       slotAt > now                                   → 'not_due'
//       failed attempts ≥ maxPublishAttempts           → 'attempts_exhausted'
//       pageState.tokenState === 'invalid'             → 'token_invalid'
//       tokenState 'not_configured' or no igUserId     → 'page_not_configured'
//       latest approval decision 'reject'              → 'rejected'           (always blocks, autopilot included)
//       approve_first and latest approval ≠ 'approve'  → 'awaiting_approval'
//       approve_first and approval.revision ≠ revision → 'approval_stale'     (M5.5)
//       a publish on this page within minGapHours      → 'min_gap'
//       else publish:true, reason 'autopilot' | 'approved'
//     In autopilot an approve record (fresh or stale) is not needed and not consulted; only a reject blocks.
//
//   preflight(item, fetchImpl, { prefer })   HEAD rawUrl → 200 + image/jpeg (video/mp4 for kind video),
//                                            else pagesUrl → { url, used: 'raw'|'pages' } | null
//   publishDraft({ … })                      quota guard → preflight → container(s) → publish → permalink
//                                            → published.jsonl record + draft `published`; failures append
//                                            publishAttempts[] and move the draft/page as design §11 says
//   completePermalinks({ … })                fills permalink:null records from an earlier run
import { PUBLISHED_SPEC, assertShape } from "../lib/schema.js";
import { fullCaption } from "../lib/checks.js";
import { latestByKey } from "../lib/state.js";
import { hoursBetween, nowIst, parseIso } from "../lib/time.js";
import { withTimeout } from "../llm/adapter.js";
import { IgError } from "../ig/client.js";

export const AGENT = "publisher";
export const REASONS = ["expired", "not_due", "attempts_exhausted", "token_invalid", "page_not_configured", "rejected", "awaiting_approval", "approval_stale", "min_gap", "autopilot", "approved"];
export const PREFLIGHT_TIMEOUT_MS = 30000;
export const QUOTA_HEADROOM = 2;
export const SKIP_REEL_NOT_BUILT = "reel_not_built";
const CONTENT_TYPES = { image: "image/jpeg", video: "video/mp4", poster: "image/jpeg" };

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`publisher: invalid date ${String(v)}`);
  return d;
}

// Latest approvals.jsonl record per draftId (by `at`, then file order) → Map.
export function latestApprovals(records) {
  const sorted = [...(records || [])].filter((r) => r && r.draftId).sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return latestByKey(sorted, "draftId");
}

export function latestApproval(approvals, draftId) {
  if (approvals instanceof Map) return approvals.get(draftId) || null;
  return latestApprovals(approvals).get(draftId) || null;
}

export function failedAttempts(draft) {
  return ((draft && draft.publishAttempts) || []).filter((a) => a && a.ok === false).length;
}

// isLate(slotAt, publishedAt, config) → published more than lateAfterHours after the slot (design §3.2 step 4).
export function isLate(slotAt, publishedAt, config) {
  return hoursBetween(slotAt, publishedAt) > config.defaults.lateAfterHours;
}

// decide(draft, approvals, page, now, config, pageState, recentPublishes) → { publish, reason }
//   approvals        approvals.jsonl records (or the Map from latestApprovals)
//   page             config.pages[] entry (mode, igUserId)
//   pageState        status.json pages[handle] ({ tokenState })
//   recentPublishes  published.jsonl records of this page (or ISO strings) — minGapHours check
export function decide(draft, approvals, page, now, config, pageState = {}, recentPublishes = []) {
  if (!draft || !page || !config) throw new TypeError("publisher: draft, page and config are required");
  const d = config.defaults;
  const nowMs = toDate(now).getTime();
  if (draft.status !== "queued") return { publish: false, reason: `status:${draft.status}` };
  const slotMs = toDate(draft.slotAt).getTime();
  const hoursPast = (nowMs - slotMs) / 3600000;
  if (hoursPast > d.expireAfterHours) return { publish: false, reason: "expired" };
  if (slotMs > nowMs) return { publish: false, reason: "not_due" };
  if (failedAttempts(draft) >= d.maxPublishAttempts) return { publish: false, reason: "attempts_exhausted" };
  const tokenState = pageState && pageState.tokenState;
  if (tokenState === "invalid") return { publish: false, reason: "token_invalid" };
  if (tokenState === "not_configured" || !page.igUserId) return { publish: false, reason: "page_not_configured" };
  const approval = latestApproval(approvals, draft.id);
  if (approval && approval.decision === "reject") return { publish: false, reason: "rejected" };
  if (page.mode !== "autopilot") {
    if (!approval || approval.decision !== "approve") return { publish: false, reason: "awaiting_approval" };
    if (approval.revision !== draft.revision) return { publish: false, reason: "approval_stale" };
  }
  for (const p of recentPublishes || []) {
    const at = typeof p === "string" ? p : p && p.publishedAt;
    if (!at) continue;
    const gap = (nowMs - toDate(at).getTime()) / 3600000;
    if (gap >= 0 && gap < d.minGapHours) return { publish: false, reason: "min_gap" };
  }
  return { publish: true, reason: page.mode === "autopilot" ? "autopilot" : "approved" };
}

async function headOk(url, fetchImpl, expectType, timeoutMs) {
  try {
    const res = await withTimeout(fetchImpl, timeoutMs)(url, { method: "HEAD", redirect: "follow" });
    const type = String((res.headers && typeof res.headers.get === "function" && res.headers.get("content-type")) || "").toLowerCase();
    return res.status === 200 && type.startsWith(expectType);
  } catch {
    return false;
  }
}

// preflight(item, fetchImpl, { prefer = 'raw', timeoutMs }) → { url, used } | null
//   HEAD the preferred URL first (raw.githubusercontent.com by default; 'pages' after a media-fetch
//   failure on raw), then the other; each must answer 200 with the expected Content-Type.
export async function preflight(item, fetchImpl, { prefer = "raw", timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("publisher: preflight needs fetchImpl");
  const expectType = CONTENT_TYPES[item.kind] || CONTENT_TYPES.image;
  const order = prefer === "pages" ? ["pages", "raw"] : ["raw", "pages"];
  for (const used of order) {
    const url = used === "raw" ? item.rawUrl : item.pagesUrl;
    if (!url) continue;
    if (await headOk(url, fetchImpl, expectType, timeoutMs)) return { url, used };
  }
  return null;
}

// preflightMedia(media, fetchImpl, opts) → { urls: [...], used } | null — every file must pass; `used`
// is 'raw' when every file came from raw, else 'pages'.
export async function preflightMedia(media, fetchImpl, opts = {}) {
  const urls = [];
  let used = "raw";
  for (const item of media || []) {
    const r = await preflight(item, fetchImpl, opts);
    if (!r) return null;
    urls.push(r.url);
    if (r.used === "pages") used = "pages";
  }
  return urls.length ? { urls, used } : null;
}

// After a media-fetch failure (code 9004 / subcode 2207052) the next hour tries the other URL (design §11).
export function preferredUrl(draft) {
  const attempts = (draft && draft.publishAttempts) || [];
  const last = attempts[attempts.length - 1];
  if (!last || last.ok !== false) return "raw";
  const fetchFailed = last.code === 9004 || last.subcode === 2207052;
  if (!fetchFailed || !last.mediaUrlUsed) return "raw";
  return last.mediaUrlUsed === "raw" ? "pages" : "raw";
}

function altTextFor(draft, i) {
  if (Array.isArray(draft.altTexts) && typeof draft.altTexts[i] === "string" && draft.altTexts[i]) return draft.altTexts[i];
  if (Array.isArray(draft.slides) && draft.slides[i] && draft.slides[i].altText) return draft.slides[i].altText;
  return draft.altText;
}

function flagFor(id) {
  return `publish_failed:${id}`;
}

// publishDraft({ draft, page, client, state, config, now, runId, mode, approval, fetchImpl, log })
//   → { ok:true, record, draft, quota, mediaUrlUsed }
//   | { ok:false, skipped:'quota'|'quota_check_failed', quota?, error?, tokenInvalid? }                 (page-level, no draft attempt)
//   | { ok:false, stage, code, subcode, message, retryable, tokenInvalid, draft, failed, flags[], quota }  (attempt recorded on the draft)
//   `quota` present means content_publishing_limit answered, i.e. the token was accepted by the API.
//   draft.slotAt must already be the effective slot time (overrides applied by the caller).
export async function publishDraft({ draft, page, client, state, config, now, runId, mode = page && page.mode, approval = null, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (!draft || !page || !client || !state || !config) throw new TypeError("publisher: draft, page, client, state and config are required");
  // FEAT-201 renders reels; the reel publish path (REELS container → status poll → publish, P2-03) is FEAT-202.
  // Until then a queued reel is a page-level skip (no attempt recorded, tried again next hour), never posted as an image.
  if (draft.format === "reel" && typeof client.createReelContainer !== "function") {
    log(`[publisher] ${draft.id}: ${SKIP_REEL_NOT_BUILT} — reel publishing not built yet (FEAT-202)`);
    return { ok: false, skipped: SKIP_REEL_NOT_BUILT, message: "reel publishing: not built yet (FEAT-202)" };
  }
  const at = nowIst(toDate(now === undefined ? state.now() : now));
  const d = config.defaults;
  const flags = [];
  const attempt = (fields) => {
    const a = { at, ok: false, ...fields };
    if (runId) a.runId = runId;
    return a;
  };
  const writeAttempt = (a, status = draft.status) => {
    const next = { ...draft, status, updatedAt: at, publishAttempts: [...(draft.publishAttempts || []), a] };
    state.writeDraft(next);
    return next;
  };

  // 1. quota guard (design §9): once per page per run — the caller publishes at most one draft per page.
  let quota;
  try {
    quota = await client.publishingLimit();
  } catch (err) {
    if (!(err instanceof IgError)) throw err;
    log(`[publisher] ${page.handle}: content_publishing_limit failed — ${err.message}`);
    return { ok: false, skipped: "quota_check_failed", error: err, tokenInvalid: err.tokenInvalid === true, code: err.code, message: err.message };
  }
  if (Number.isInteger(quota.quotaTotal) && quota.quotaUsage >= quota.quotaTotal - QUOTA_HEADROOM) {
    log(`[publisher] ${page.handle}: publishing quota ${quota.quotaUsage}/${quota.quotaTotal} used — page skipped this run`);
    return { ok: false, skipped: "quota", quota };
  }

  // 2. media preflight (HEAD): the dry-run client stands in for the network.
  const prefer = preferredUrl(draft);
  const pre = typeof client.preflight === "function" ? await client.preflight(draft.media, { prefer }) : await preflightMedia(draft.media, fetchImpl, { prefer });
  if (!pre) {
    const urls = (draft.media || []).flatMap((m) => [m.rawUrl, m.pagesUrl]).filter(Boolean);
    const a = attempt({ stage: "preflight", message: `HEAD ${urls.join(" , ")}: none answered 200 with the expected Content-Type` });
    const next = writeAttempt(a);
    log(`[publisher] ${draft.id} preflight failed; waits for the next hour`);
    return { ok: false, stage: "preflight", code: null, subcode: null, message: a.message, retryable: true, tokenInvalid: false, draft: next, failed: false, flags, quota };
  }
  const mediaUrlUsed = pre.used;
  const caption = fullCaption(draft);

  // 3. container(s) → publish → permalink
  let igMediaId;
  let stage = "container";
  try {
    let creationId;
    if (draft.format === "carousel") {
      const children = [];
      for (let i = 0; i < pre.urls.length; i++) {
        const child = await client.createCarouselItem({ imageUrl: pre.urls[i], altText: altTextFor(draft, i) });
        children.push(child.id);
      }
      creationId = (await client.createCarousel({ children, caption })).id;
    } else {
      creationId = (await client.createImageContainer({ imageUrl: pre.urls[0], caption, altText: draft.altText })).id;
    }
    stage = "publish";
    igMediaId = (await client.publish(creationId)).id;
  } catch (err) {
    if (!(err instanceof IgError)) throw err;
    const a = attempt({ stage: err.stage || stage, code: err.code, subcode: err.subcode, message: err.message, mediaUrlUsed });
    if (a.code === null) delete a.code;
    if (a.subcode === null) delete a.subcode;
    const attemptsAfter = failedAttempts(draft) + 1;
    let status = draft.status;
    if (err.tokenInvalid) {
      status = "queued"; // the page is paused, the draft waits for a working token
    } else if (!err.retryable || attemptsAfter >= d.maxPublishAttempts) {
      status = "failed";
      flags.push(flagFor(draft.id));
    }
    const next = writeAttempt(a, status);
    log(`[publisher] ${draft.id} ${a.stage} failed (code ${a.code === undefined ? "none" : a.code}${a.subcode !== undefined ? `/${a.subcode}` : ""})${status === "failed" ? " → failed" : err.tokenInvalid ? " → token invalid, page paused" : " → retry next hour"}`);
    return { ok: false, stage: a.stage, code: err.code, subcode: err.subcode, message: err.message, retryable: err.retryable, tokenInvalid: err.tokenInvalid === true, draft: next, failed: status === "failed", flags, mediaUrlUsed, quota };
  }

  let permalink = null;
  try {
    permalink = (await client.getPermalink(igMediaId)).permalink;
  } catch (err) {
    if (!(err instanceof IgError)) throw err;
    log(`[publisher] ${draft.id} published as ${igMediaId} but the permalink fetch failed (${err.message}); completed next run`);
  }

  // 4. records: published.jsonl + draft `published` (+ the successful attempt for the admin's history)
  const record = {
    draftId: draft.id,
    page: page.handle,
    igMediaId,
    permalink,
    publishedAt: at,
    slotAt: draft.slotAt,
    late: isLate(draft.slotAt, at, config),
    mode: mode || page.mode,
    qaRevision: draft.revision,
    format: draft.format,
    mediaUrlUsed,
    runId: runId || draft.runId,
  };
  if (approval && approval.decision === "approve") {
    record.approvedBy = approval.by;
    record.approvedAt = approval.at;
  }
  if (client.dryRun === true) record.dryRun = true;
  state.appendJsonl("state/published.jsonl", record, PUBLISHED_SPEC);
  const ok = { at, ok: true, stage: "publish", mediaUrlUsed };
  if (runId) ok.runId = runId;
  const next = { ...draft, status: "published", updatedAt: at, publishAttempts: [...(draft.publishAttempts || []), ok] };
  state.writeDraft(next);
  log(`[publisher] ${draft.id} published → ${igMediaId}${permalink ? ` ${permalink}` : " (permalink pending)"}${record.late ? " late" : ""}${client.dryRun ? " (dry run)" : ""}`);
  return { ok: true, record, draft: next, quota, mediaUrlUsed };
}

// completePermalinks({ state, client, page, log }) → number of records completed. Rewrites
// state/published.jsonl in place (engine-owned) so no record is duplicated.
export async function completePermalinks({ state, client, page, log = () => {} } = {}) {
  const rel = "state/published.jsonl";
  const rows = state.readJsonl(rel);
  let completed = 0;
  for (const row of rows) {
    if (!row || row.page !== page.handle || row.permalink || !row.igMediaId) continue;
    try {
      const r = await client.getPermalink(row.igMediaId);
      if (r.permalink) {
        row.permalink = r.permalink;
        completed++;
        log(`[publisher] ${row.draftId}: permalink completed ${r.permalink}`);
      }
    } catch (err) {
      if (!(err instanceof IgError)) throw err;
      log(`[publisher] ${row.draftId}: permalink still pending (${err.message})`);
      if (err.tokenInvalid) break;
    }
  }
  if (completed > 0) {
    for (const r of rows) assertShape(r, PUBLISHED_SPEC);
    state.writeText(rel, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return completed;
}
