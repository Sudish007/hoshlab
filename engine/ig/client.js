// Instagram Graph API client for the Publisher (design.md §9, §11; review M15; plan D5).
//
//   createClient({ config, token, igUserId, fetchImpl, now, timeoutMs, log })
//     .publishingLimit()                                  GET  /{igUserId}/content_publishing_limit?fields=quota_usage,config
//     .createImageContainer({ imageUrl, caption, altText })  POST /{igUserId}/media            image_url, caption, alt_text
//     .createCarouselItem({ imageUrl, altText })          POST /{igUserId}/media            image_url, is_carousel_item=true, alt_text
//     .createCarousel({ children, caption })              POST /{igUserId}/media            media_type=CAROUSEL, children, caption
//     .createReelContainer({ videoUrl, caption, coverUrl, shareToFeed })  POST /{igUserId}/media  media_type=REELS, video_url, caption, cover_url, share_to_feed
//     .containerStatus(containerId)                       GET  /{containerId}?fields=status_code,status   (reels: poll until FINISHED)
//     .publish(creationId)                                POST /{igUserId}/media_publish    creation_id
//     .getPermalink(mediaId)                              GET  /{mediaId}?fields=permalink,timestamp
//     .getMe()                                            GET  /me?fields=id,user_id,username
//     .refreshToken()                                     GET  /refresh_access_token?grant_type=ig_refresh_token  (unversioned, as Meta documents it)
//
// Base URL is `${ig.host}/${ig.version}` (config.json; v26.0 verified against Meta's changelog on
// 2026-10-10). Every request aborts after 30 s. The token travels ONLY as the `access_token` form field
// (POST) or query parameter (GET) — never in a header, a path, an Error or a log line: every message is
// passed through log.scrub() with the token, and the recorded `calls[]` carry the fields without it.
// refreshToken() returns the NEW token value to the caller in memory only (design §3.4): it is never put
// into calls[], a log line or an error; engine/commands/refresh-tokens.js pipes it to `gh secret set`.
//
// Failures are IgError instances carrying Meta's envelope ({ code, error_subcode, message, type,
// fbtrace_id }) plus the publisher's reading of it (classifyError): which `stage` to record on the
// draft, whether the draft may be `retryable` next hour and whether the page's token is dead
// (`tokenInvalid`). Network failures and timeouts have code null and are retryable.
import { withTimeout } from "../llm/adapter.js";
import { scrub } from "../lib/log.js";

export const DEFAULT_TIMEOUT_MS = 30000;

// Error-code families (design §11 rows "IG container create", "IG container create / publish", "IG rate limit").
export const MEDIA_FETCH_CODES = [9004];
export const MEDIA_FETCH_SUBCODES = [2207052];
export const PARAM_ERROR_CODES = [100];
export const TOKEN_ERROR_CODES = [190, 10, 200];
export const RATE_LIMIT_CODES = [4, 17, 32, 613, 9007];
export const ERROR_KINDS = ["media_fetch", "param", "token", "rate_limit", "network", "other"];
// Container status_code values (design §9 step 2): the Publisher polls a REELS container until FINISHED;
// ERROR and EXPIRED end the attempt; PUBLISHED means an earlier run already published it.
export const CONTAINER_STATUS_CODES = ["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"];
// Unversioned Graph endpoint (https://graph.instagram.com/refresh_access_token, Meta's reference page shows no version segment).
export const REFRESH_PATH = "/refresh_access_token";
export const REFRESH_GRANT = "ig_refresh_token";

export class IgError extends Error {
  // new IgError({ code, subcode, message, stage, status, type, fbtraceId, secrets })
  constructor({ code = null, subcode = null, message, stage = "container", status = 0, type = null, fbtraceId = null, secrets = [] } = {}) {
    super(scrub(message, secrets));
    this.name = "IgError";
    this.code = Number.isInteger(code) ? code : null;
    this.subcode = Number.isInteger(subcode) ? subcode : null;
    this.status = status;
    this.type = type;
    this.fbtraceId = fbtraceId;
    const c = classifyError({ code: this.code, subcode: this.subcode, stage });
    this.kind = c.kind;
    this.stage = c.stage;
    this.retryable = c.retryable;
    this.tokenInvalid = c.tokenInvalid;
  }
}

// classifyError({ code, subcode, stage }) → { kind, stage, retryable, tokenInvalid }
//   9004 / subcode 2207052  media fetch failed      retry next hour with the other URL      stage as given
//   100                     bad parameter           NOT retryable (draft → failed)           stage as given
//   190, 10, 200            token invalid / no perm NOT retryable; tokenInvalid (page paused) stage as given
//   4, 17, 32, 613, 9007    rate limit              retry next hour                          stage rate_limit
//   null (no envelope)      network / timeout       retry next hour                          stage as given
//   anything else           other                   retry once next hour                     stage as given
export function classifyError({ code = null, subcode = null, stage = "container" } = {}) {
  if (code === null && subcode === null) return { kind: "network", stage, retryable: true, tokenInvalid: false };
  if (MEDIA_FETCH_CODES.includes(code) || MEDIA_FETCH_SUBCODES.includes(subcode)) return { kind: "media_fetch", stage, retryable: true, tokenInvalid: false };
  if (TOKEN_ERROR_CODES.includes(code)) return { kind: "token", stage, retryable: false, tokenInvalid: true };
  if (PARAM_ERROR_CODES.includes(code)) return { kind: "param", stage, retryable: false, tokenInvalid: false };
  if (RATE_LIMIT_CODES.includes(code)) return { kind: "rate_limit", stage: "rate_limit", retryable: true, tokenInvalid: false };
  return { kind: "other", stage, retryable: true, tokenInvalid: false };
}

// Integers arrive as numbers; some envelopes carry them as digit strings.
function intOrNull(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

// Meta's envelope: { error: { message, type, code, error_subcode, fbtrace_id, error_user_title, error_user_msg } }
export function parseEnvelope(json) {
  const e = json && typeof json === "object" ? json.error : null;
  if (!e || typeof e !== "object") return null;
  const parts = [];
  if (e.type) parts.push(String(e.type));
  if (e.message) parts.push(String(e.message));
  if (e.error_user_title && e.error_user_title !== e.message) parts.push(String(e.error_user_title));
  if (e.error_user_msg) parts.push(String(e.error_user_msg));
  return {
    code: intOrNull(e.code),
    subcode: intOrNull(e.error_subcode),
    type: e.type ? String(e.type) : null,
    fbtraceId: e.fbtrace_id ? String(e.fbtrace_id) : null,
    message: parts.join(": ") || "error without message",
  };
}

function requireString(name, value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`ig: ${name} is required`);
  return value;
}

// createClient({ config, token, igUserId, fetchImpl, now, timeoutMs, log }) → client (see the file header).
//   config    company config (ig.host, ig.version)
//   token     the page's access token (process.env[page.tokenSecret]); kept in this closure only
//   igUserId  the Instagram professional account id (config.pages[].igUserId = /me user_id, plan D5)
//   fetchImpl injected fetch (tests pass a fake; tests/helpers.js throws on the global one)
//   calls[]   every request as { method, path, fields } — fields never include the token
export function createClient({ config, token, igUserId, fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, log = null } = {}) {
  if (!config || !config.ig || !config.ig.host || !config.ig.version) throw new TypeError("ig: config.ig.host and config.ig.version are required");
  requireString("token", token);
  requireString("igUserId", igUserId);
  if (typeof fetchImpl !== "function") throw new TypeError("ig: fetchImpl must be a function");
  const host = String(config.ig.host).replace(/\/+$/, "");
  const base = `${host}/${config.ig.version}`;
  const secrets = [token];
  const calls = [];
  const fetchWithTimeout = withTimeout(fetchImpl, timeoutMs);
  const clock = () => (typeof now === "function" ? now() : now);

  // One request → parsed JSON; throws IgError (scrubbed) on network failure, non-2xx or an error envelope.
  // `unversioned` requests go to the host root (refresh_access_token has no version segment).
  async function request(method, path, fields, stage, { unversioned = false } = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(fields || {})) if (v !== undefined && v !== null && k !== "access_token") clean[k] = typeof v === "boolean" ? String(v) : String(v);
    calls.push({ method, path, fields: clean, at: clock().toISOString() });
    if (log) log(`[ig] ${method} ${path} ${Object.keys(clean).join(",")}`);
    const params = new URLSearchParams({ ...clean, access_token: token });
    let url = `${unversioned ? host : base}${path}`;
    const init = { method, headers: { accept: "application/json" } };
    if (method === "GET") url += `?${params.toString()}`;
    else {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = params.toString();
    }
    let res;
    try {
      res = await fetchWithTimeout(url, init);
    } catch (err) {
      const reason = err && err.name === "TimeoutError" ? err.message : `network error: ${(err && err.message) || String(err)}`;
      throw new IgError({ message: `ig ${method} ${path}: ${reason}`, stage, status: 0, secrets });
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const envelope = parseEnvelope(json);
    if (envelope) {
      throw new IgError({ ...envelope, message: `ig ${method} ${path}: HTTP ${res.status} ${envelope.message} (code ${envelope.code}${envelope.subcode !== null ? `/${envelope.subcode}` : ""})`, stage, status: res.status, secrets });
    }
    if (!res.ok) {
      const snippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
      throw new IgError({ message: `ig ${method} ${path}: HTTP ${res.status} ${snippet || res.statusText || "no response body"}`, stage, status: res.status, secrets });
    }
    if (json === null || typeof json !== "object") throw new IgError({ message: `ig ${method} ${path}: HTTP ${res.status} with a non-JSON body`, stage, status: res.status, secrets });
    return json;
  }

  function idOf(json, what, stage) {
    const id = json && (typeof json.id === "string" || typeof json.id === "number") ? String(json.id) : "";
    if (!id) throw new IgError({ message: `ig: ${what} response carries no id (${JSON.stringify(json).slice(0, 200)})`, stage, status: 200, secrets });
    return id;
  }

  return {
    base,
    igUserId,
    calls,
    dryRun: false,
    // → { quotaUsage, quotaTotal, quotaDuration, raw }  (response: { data: [ { quota_usage, config: { quota_total, quota_duration } } ] })
    async publishingLimit() {
      const json = await request("GET", `/${igUserId}/content_publishing_limit`, { fields: "quota_usage,config" }, "skip");
      const row = Array.isArray(json.data) ? json.data[0] || {} : json;
      const cfg = row.config || {};
      return { quotaUsage: Number.isInteger(row.quota_usage) ? row.quota_usage : Number(row.quota_usage) || 0, quotaTotal: Number.isInteger(cfg.quota_total) ? cfg.quota_total : Number(cfg.quota_total) || null, quotaDuration: Number.isInteger(cfg.quota_duration) ? cfg.quota_duration : Number(cfg.quota_duration) || null, raw: json };
    },
    async createImageContainer({ imageUrl, caption, altText }) {
      requireString("imageUrl", imageUrl);
      const json = await request("POST", `/${igUserId}/media`, { image_url: imageUrl, caption, alt_text: altText }, "container");
      return { id: idOf(json, "image container", "container") };
    },
    async createCarouselItem({ imageUrl, altText }) {
      requireString("imageUrl", imageUrl);
      const json = await request("POST", `/${igUserId}/media`, { image_url: imageUrl, is_carousel_item: true, alt_text: altText }, "container");
      return { id: idOf(json, "carousel item", "container") };
    },
    async createCarousel({ children, caption }) {
      if (!Array.isArray(children) || children.length < 2 || children.length > 10) throw new TypeError(`ig: a carousel needs 2-10 children, got ${Array.isArray(children) ? children.length : typeof children}`);
      const json = await request("POST", `/${igUserId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }, "container");
      return { id: idOf(json, "carousel container", "container") };
    },
    // Reel (design §9 column "Reel", P2-03): the video is fetched by Instagram from video_url (the preflighted
    // raw/Pages URL of the MP4), cover_url is the poster JPEG, share_to_feed puts the reel on the grid too.
    async createReelContainer({ videoUrl, caption, coverUrl, shareToFeed = true }) {
      requireString("videoUrl", videoUrl);
      const json = await request("POST", `/${igUserId}/media`, { media_type: "REELS", video_url: videoUrl, caption, cover_url: coverUrl, share_to_feed: shareToFeed }, "container");
      return { id: idOf(json, "reel container", "container") };
    },
    // → { statusCode: 'FINISHED'|'IN_PROGRESS'|'ERROR'|'EXPIRED'|'PUBLISHED'|null, status: '<free text or null>', raw }
    async containerStatus(containerId) {
      requireString("containerId", containerId);
      const json = await request("GET", `/${containerId}`, { fields: "status_code,status" }, "status");
      const code = typeof json.status_code === "string" ? json.status_code.toUpperCase() : null;
      return { statusCode: code, status: typeof json.status === "string" ? json.status : null, raw: json };
    },
    async publish(creationId) {
      requireString("creationId", creationId);
      const json = await request("POST", `/${igUserId}/media_publish`, { creation_id: creationId }, "publish");
      return { id: idOf(json, "media_publish", "publish") };
    },
    async getPermalink(mediaId) {
      requireString("mediaId", mediaId);
      const json = await request("GET", `/${mediaId}`, { fields: "permalink,timestamp" }, "publish");
      return { permalink: typeof json.permalink === "string" ? json.permalink : null, timestamp: typeof json.timestamp === "string" ? json.timestamp : null, raw: json };
    },
    async getMe() {
      const json = await request("GET", "/me", { fields: "id,user_id,username" }, "skip");
      return { id: json.id === undefined ? null : String(json.id), user_id: json.user_id === undefined ? null : String(json.user_id), username: json.username === undefined ? null : String(json.username) };
    },
    // Refreshes the long-lived token this client holds (design §3.4; Meta: ≥ 24 h old, unexpired, valid for 60 days
    // from the refresh). → { accessToken, expiresIn (seconds), tokenType }. The new value exists only in this
    // return value: calls[], logs and IgError messages never carry it (the old token is scrubbed; the new one is
    // scrubbed by the caller's logger once it knows it). A code 190 here means the stored token is dead.
    async refreshToken() {
      const json = await request("GET", REFRESH_PATH, { grant_type: REFRESH_GRANT }, "skip", { unversioned: true });
      const accessToken = typeof json.access_token === "string" ? json.access_token : "";
      const expiresIn = intOrNull(json.expires_in);
      if (!accessToken || expiresIn === null || expiresIn <= 0) {
        throw new IgError({ message: `ig GET ${REFRESH_PATH}: response without access_token/expires_in (keys: ${Object.keys(json).join(",") || "none"})`, stage: "skip", status: 200, secrets });
      }
      return { accessToken, expiresIn, tokenType: typeof json.token_type === "string" ? json.token_type : null };
    },
  };
}
