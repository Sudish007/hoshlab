// Dry-run Instagram client (design.md §3.5, §9 "dry-run.js"): the same method surface as client.js,
// nothing sent. Every call is recorded in client.calls[] as { method, path, fields } (there is no token
// to remove — the dry-run client never holds one) and printed as one stdout line
//   [ig dry-run] POST /dry-user/media image_url=https://… caption="…" alt_text="…"
// Ids are deterministic: 'dry-' + the first 8 hex of sha256(method, path, fields), so the same draft
// always yields the same container/media ids and permalink https://www.instagram.com/p/DRYRUN<sha8>/.
// Selected by engine/commands/publish.js when IG_DRY_RUN=1 or --dry-run (isDryRun()).
import { createHash } from "node:crypto";

export const DRY_USER_ID = "dry-user";
export const DRY_ME = { id: "dry-app", user_id: DRY_USER_ID, username: "dry" };
export const DRY_QUOTA = { quotaUsage: 0, quotaTotal: 50, quotaDuration: 86400 };
export const LINE_PREFIX = "[ig dry-run]";
const VALUE_MAX = 80;

export function sha8(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 8);
}

export function isDryRun(processEnv = process.env, flags = {}) {
  return (processEnv && processEnv.IG_DRY_RUN === "1") || flags["dry-run"] === true || flags.dryRun === true;
}

// URL-safe values (urls, ids, booleans, field lists) print in full; free text (captions, alt text) is
// JSON-quoted and cut at VALUE_MAX characters — the full value is in calls[].
function shortValue(v) {
  const s = String(v);
  if (/^[A-Za-z0-9_.:/?&=%,+-]*$/.test(s)) return s;
  const cut = s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX - 1)}…` : s;
  return JSON.stringify(cut);
}

// formatCall({ method, path, fields }) → '[ig dry-run] POST /dry-user/media image_url=… caption="…"'
export function formatCall({ method, path, fields }) {
  const parts = Object.entries(fields || {}).map(([k, v]) => `${k}=${shortValue(v)}`);
  return [LINE_PREFIX, method, path, ...parts].join(" ");
}

// createDryRunClient({ igUserId, stdout, now }) → client (same surface as createClient, plus preflight()).
export function createDryRunClient({ igUserId = DRY_USER_ID, stdout = (s) => process.stdout.write(s + "\n"), now = () => new Date() } = {}) {
  const uid = typeof igUserId === "string" && igUserId.length > 0 ? igUserId : DRY_USER_ID;
  const calls = [];
  const clock = () => (typeof now === "function" ? now() : now);

  function record(method, path, fields = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && k !== "access_token") clean[k] = typeof v === "boolean" ? String(v) : String(v);
    const call = { method, path, fields: clean, at: clock().toISOString() };
    calls.push(call);
    if (stdout) stdout(formatCall(call));
    return `dry-${sha8({ method, path, fields: clean })}`;
  }

  return {
    base: "dry-run",
    igUserId: uid,
    calls,
    dryRun: true,
    async publishingLimit() {
      record("GET", `/${uid}/content_publishing_limit`, { fields: "quota_usage,config" });
      return { ...DRY_QUOTA, raw: { data: [{ quota_usage: DRY_QUOTA.quotaUsage, config: { quota_total: DRY_QUOTA.quotaTotal, quota_duration: DRY_QUOTA.quotaDuration } }] } };
    },
    // Stands in for publisher.preflightMedia(): records a HEAD per file and accepts the preferred URL.
    async preflight(media, { prefer = "raw" } = {}) {
      const used = prefer === "pages" ? "pages" : "raw";
      const urls = (media || []).map((m) => {
        const url = used === "pages" ? m.pagesUrl : m.rawUrl;
        record("HEAD", url, {});
        return url;
      });
      return { urls, used };
    },
    async createImageContainer({ imageUrl, caption, altText }) {
      return { id: record("POST", `/${uid}/media`, { image_url: imageUrl, caption, alt_text: altText }) };
    },
    async createCarouselItem({ imageUrl, altText }) {
      return { id: record("POST", `/${uid}/media`, { image_url: imageUrl, is_carousel_item: true, alt_text: altText }) };
    },
    async createCarousel({ children, caption }) {
      return { id: record("POST", `/${uid}/media`, { media_type: "CAROUSEL", children: (children || []).join(","), caption }) };
    },
    async publish(creationId) {
      return { id: record("POST", `/${uid}/media_publish`, { creation_id: creationId }) };
    },
    async getPermalink(mediaId) {
      const id = record("GET", `/${mediaId}`, { fields: "permalink,timestamp" });
      return { permalink: `https://www.instagram.com/p/DRYRUN${id.slice(4)}/`, timestamp: clock().toISOString(), raw: null };
    },
    async getMe() {
      record("GET", "/me", { fields: "id,user_id,username" });
      return { ...DRY_ME };
    },
  };
}
