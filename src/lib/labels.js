// The ONLY place a config token becomes human text (design OF-5, review M6, N2, N5; plan D12).
// Browser-safe: no node: imports — src/build.js byte-copies this file into dist/admin/lib/ so the
// admin prints the same words as the public site. Unknown tokens throw: a token must never leak
// into the UI as text, and every value here is validated by engine/lib/schema.js before it is read.

const MODES = { approve_first: "Approve first", autopilot: "Autopilot" };
const PROVIDERS = { anthropic: "Anthropic", gemini: "Google Gemini", openai: "OpenAI", mock: "Mock adapter" };
const TOKEN_STATES = { ok: "token ok", invalid: "token invalid", not_configured: "not configured yet", expiring: "token expiring", unknown: "token untested" };
// Insights windows (design §4.10, FEAT-203): the metrics record token → the words the Reports page prints.
const WINDOWS = { "48h": "48 hours", "7d": "7 days" };
// Insights metric names (Meta's media-insights metrics) → column headings.
const METRICS = { reach: "reach", views: "views", likes: "likes", comments: "comments", saved: "saves", shares: "shares" };

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

// windowLabel('48h') → '48 hours'; windowLabel('7d') → '7 days'.
export function windowLabel(window) {
  return lookup(WINDOWS, window, "insights window");
}

// metricLabel('saved') → 'saves'.
export function metricLabel(metric) {
  return lookup(METRICS, metric, "insights metric");
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

// IST is UTC+05:30 all year (no DST): fixed-offset arithmetic, no host time zone involved.
const IST_OFFSET_MINUTES = 330;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n) => String(n).padStart(2, "0");

// cronLabel(cron) → the one human label for a GitHub Actions cron (UTC), in IST (design OF-7/D1, review M1):
//   'M * * * *'  → 'Hourly at :MM IST'          ('17 * * * *' → 'Hourly at :47 IST')
//   'M H * * *'  → 'Daily HH:MM IST'            ('23 0 * * *' → 'Daily 05:53 IST')
//   'M H * * D'  → '<Day>s HH:MM IST'           ('13 2 * * 1' → 'Mondays 07:43 IST'; the day shifts when the IST time crosses midnight)
// company/config.json carries each cron beside its label; src/lib/company.js refuses a label that is not this
// derivation of its cron, so no page, README line or workflow comment can print a time the cron does not fire at.
// Any other shape (ranges, lists, steps, a fixed day of month) throws: no such cron exists here.
export function cronLabel(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) throw new TypeError(`labels: cron needs 5 fields, got ${JSON.stringify(cron)}`);
  const [minute, hour, dom, month, dow] = fields;
  if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59) throw new TypeError(`labels: cron minute must be a fixed 0–59, got ${JSON.stringify(cron)}`);
  if (dom !== "*" || month !== "*") throw new TypeError(`labels: cron day-of-month and month must be *, got ${JSON.stringify(cron)}`);
  if (hour === "*") {
    if (dow !== "*") throw new TypeError(`labels: an hourly cron cannot name a weekday, got ${JSON.stringify(cron)}`);
    return `Hourly at :${pad2((Number(minute) + IST_OFFSET_MINUTES) % 60)} IST`;
  }
  if (!/^\d{1,2}$/.test(hour) || Number(hour) > 23) throw new TypeError(`labels: cron hour must be * or a fixed 0–23, got ${JSON.stringify(cron)}`);
  const total = Number(hour) * 60 + Number(minute) + IST_OFFSET_MINUTES;
  const time = `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
  if (dow === "*") return `Daily ${time} IST`;
  if (!/^[0-7]$/.test(dow)) throw new TypeError(`labels: cron weekday must be * or a single 0–7, got ${JSON.stringify(cron)}`);
  const day = DAY_NAMES[(Number(dow) + Math.floor(total / 1440)) % 7];
  return `${day}s ${time} IST`;
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

// tokenDaysLeft(expiresAt, now) → whole days until the ISO expiry (floor; negative once past), or null when the
// expiry is not known. Home passes status.pages[<page>].tokenExpiresAt with the build clock, the admin with Date.now().
export function tokenDaysLeft(expiresAt, now = new Date()) {
  if (typeof expiresAt !== "string" || !expiresAt) return null;
  const ms = Date.parse(expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(String(now));
  if (Number.isNaN(ms) || Number.isNaN(nowMs)) return null;
  return Math.floor((ms - nowMs) / 86400000);
}

// flagSentence(flag, { month, daysLeft }) → one plain sentence per status.flags[] entry (design §4.12).
// `month` is the display name of the budget month (e.g. 'October 2026'); it defaults to 'this month'.
// `daysLeft` (whole days, from tokenDaysLeft) turns token_expiring into 'expires in <n> days'; without it the
// sentence says 'expires soon' (expiry not known yet).
export function flagSentence(flag, { month = "this month", daysLeft = null } = {}) {
  const [kind, arg] = String(flag).split(":");
  switch (kind) {
    case "budget_exhausted":
      return `Budget for ${month} is spent; drafting paused.`;
    case "budget_warn":
      return `Budget for ${month} is past the warning level.`;
    case "token_invalid":
      return `Token for @${arg} is invalid — run setup-secrets.`;
    case "token_expiring": {
      const n = Number.isInteger(daysLeft) ? daysLeft : null;
      if (n === null) return `Token for @${arg} expires soon — run setup-secrets or wait for the weekly refresh.`;
      if (n < 0) return `Token for @${arg} has passed its expiry date — run setup-secrets.`;
      if (n === 0) return `Token for @${arg} expires today — run setup-secrets.`;
      return `Token for @${arg} expires in ${n} day${n === 1 ? "" : "s"} — run setup-secrets or wait for the weekly refresh.`;
    }
    case "render_failed":
      return "The Designer refused at least one draft in the last run; it goes back to the Writer, or is blocked for the owner once the rework limit is reached.";
    case "provider_down":
      return `${providerLabel(arg)} was unreachable in the last run.`;
    case "media_branch_missing":
      return "Media branch not configured yet; nothing is rendered until it exists.";
    case "publish_failed":
      return `Publishing failed for ${arg}; the owner decides what happens next.`;
    default:
      throw new TypeError(`labels: unknown flag ${JSON.stringify(flag)}`);
  }
}
