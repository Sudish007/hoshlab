// The ONLY place a config token becomes human text (design OF-5, review M6, N2, N5; plan D12).
// Browser-safe: no node: imports — src/build.js byte-copies this file into dist/admin/lib/ so the
// admin prints the same words as the public site. Unknown tokens throw: a token must never leak
// into the UI as text, and every value here is validated by engine/lib/schema.js before it is read.

const MODES = { approve_first: "Approve first", autopilot: "Autopilot" };
const PROVIDERS = { anthropic: "Anthropic", gemini: "Google Gemini", openai: "OpenAI", mock: "Mock adapter" };
const TOKEN_STATES = { ok: "token ok", invalid: "token invalid", not_configured: "not configured yet", expiring: "token expiring", unknown: "token untested" };

// Draft statuses that end a slot's life (review M5): never shown on Calendar or "Next up".
export const TERMINAL = ["rejected", "blocked", "failed", "expired"];
export const SLOT_WORDS = ["planned", "in progress", "in review", "scheduled", "published"];

function lookup(table, value, what) {
  if (!Object.prototype.hasOwnProperty.call(table, value)) throw new TypeError(`labels: unknown ${what} ${JSON.stringify(value)}`);
  return table[value];
}

export function modeLabel(mode) {
  return lookup(MODES, mode, "mode");
}

export function providerLabel(provider) {
  return lookup(PROVIDERS, provider, "provider");
}

export function tokenStateLabel(state) {
  return lookup(TOKEN_STATES, state, "token state");
}

// True when `approval` authorises `draft` (an approve record for the draft's current revision).
export function isApproved(draft, approval) {
  if (!approval || approval.decision !== "approve") return false;
  if (approval.revision === undefined || !draft || draft.revision === undefined) return true;
  return approval.revision === draft.revision;
}

// slotLabel(slot, draft, latestApproval, mode) → 'planned' | 'in progress' | 'in review' | 'scheduled' |
// 'published' | null (review M6 table). null = terminal (rejected/blocked/failed/expired, a reject record,
// or a dropped slot): the public pages omit it; the admin lists it under "Blocked, failed, expired".
//   no draft                                  → 'planned' (slot.status planned/absent) · null when the slot is dropped
//   written | rendered | rework               → 'in progress'
//   queued ∧ approve_first ∧ no valid approve → 'in review'
//   queued ∧ (autopilot ∨ valid approve)      → 'scheduled'
//   published                                 → 'published'
//   a latest reject record                    → null in every mode (reject blocks everywhere)
export function slotLabel(slot, draft, latestApproval, mode) {
  const status = draft ? draft.status : slot ? slot.status : undefined;
  if (status === "published") return "published";
  if (latestApproval && latestApproval.decision === "reject") return null;
  if (status === undefined || status === "planned") return "planned";
  if (status === "dropped" || TERMINAL.includes(status)) return null;
  if (status === "queued") {
    if (mode === "autopilot") return "scheduled";
    return isApproved(draft, latestApproval) ? "scheduled" : "in review";
  }
  return "in progress";
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// cadenceLine(page, features) → '3 posts / week · 1 carousel' (+ ' · 1 reel' only when features.reels and a
// reel slot exists — review N2). Reel slots are not counted while reels are off: the Strategist creates none.
export function cadenceLine(page, features = { reels: false }) {
  const all = (page && page.cadence && page.cadence.slots) || [];
  const reelsOn = Boolean(features && features.reels);
  const slots = all.filter((s) => s.format !== "reel" || reelsOn);
  const carousels = slots.filter((s) => s.format === "carousel").length;
  const reels = slots.filter((s) => s.format === "reel").length;
  let line = `${plural(slots.length, "post")} / week`;
  if (carousels) line += ` · ${plural(carousels, "carousel")}`;
  if (reels) line += ` · ${plural(reels, "reel")}`;
  return line;
}

// flagSentence(flag, { month }) → one plain sentence per status.flags[] entry (design §4.12).
// `month` is the display name of the budget month (e.g. 'October 2026'); it defaults to 'this month'.
export function flagSentence(flag, { month = "this month" } = {}) {
  const [kind, arg] = String(flag).split(":");
  switch (kind) {
    case "budget_exhausted":
      return `Budget for ${month} is spent; drafting paused.`;
    case "budget_warn":
      return `Budget for ${month} is past the warning level.`;
    case "token_invalid":
      return `Token for @${arg} is invalid — run setup-secrets.`;
    case "token_expiring":
      return `Token for @${arg} expires soon — run setup-secrets or wait for the refresh job.`;
    case "render_failed":
      return "The Designer refused at least one draft in the last run; it stays with the Writer.";
    case "provider_down":
      return `${providerLabel(arg)} was unreachable in the last run; the fallback provider was used.`;
    case "media_branch_missing":
      return "Media branch not configured yet; nothing is rendered until it exists.";
    case "publish_failed":
      return `Publishing failed for ${arg}; the owner decides what happens next.`;
    default:
      throw new TypeError(`labels: unknown flag ${JSON.stringify(flag)}`);
  }
}
