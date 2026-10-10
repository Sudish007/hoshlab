// The site's read model: everything the templates print, derived once from company/ at build time
// (design §14 "every number on the site comes from company/state/* at build time"). Pure functions over
// already-validated state; the only clock is `now` (the build clock; BUILD_NOW pins it in tests).
import { addDays, nextCadenceSlots, parseIso, slotIdFor, nowIst, istParts, istDateTime } from "../../engine/lib/time.js";
import { fullCaption } from "../../engine/lib/checks.js";
import { slotLabel, isApproved, TERMINAL } from "./labels.js";
import { monthKeyOf, dateKeyOf } from "./dates.js";

const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Latest record per `key` (ties keep file order, like the Publisher's latestApprovals()).
export function latestBy(records, key, order = "at") {
  const out = new Map();
  for (const r of records) {
    if (!r || r[key] === undefined) continue;
    const prev = out.get(r[key]);
    if (!prev || String(r[order]) >= String(prev[order])) out.set(r[key], r);
  }
  return out;
}

// An owner edit applies only to the revision it was written against (design §4.8).
export function applyEdit(draft, edit) {
  if (!edit || !draft || edit.baseRevision !== draft.revision) return draft;
  const out = { ...draft };
  for (const k of ["caption", "hashtags", "altText", "altTexts"]) if (edit[k] !== undefined) out[k] = edit[k];
  return out;
}

// Every cadence occurrence of `page` in the IST month `monthKey` → [{ slotId, page, at (ISO), format, epoch }].
export function cadenceInMonth(page, monthKey) {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= days; d++) {
    const dow = DOWS[istParts(istDateTime(y, mo, d, 12, 0)).dow];
    for (const slot of (page.cadence && page.cadence.slots) || []) {
      if (slot.dow !== dow) continue;
      const [hh, mm] = slot.time.split(":").map(Number);
      const at = istDateTime(y, mo, d, hh, mm);
      out.push({ slotId: slotIdFor(page.handle, at), page: page.handle, at: nowIst(at), format: slot.format, epoch: at.getTime() });
    }
  }
  return out.sort((a, b) => a.epoch - b.epoch);
}

function cadenceEntry(occ) {
  return { slotId: occ.slotId, page: occ.page, at: occ.at, epoch: occ.epoch ?? parseIso(occ.at).getTime(), format: occ.format, draftId: null, draft: null, label: "planned", published: null, source: "cadence" };
}

// buildView({ config, roster, brands, status, drafts, edits, approvals, overrides, calendar, published,
//             runs, usage, mediaFiles, now })
export function buildView(input) {
  const { config, status, calendar, now } = input;
  const nowDate = now instanceof Date ? now : parseIso(now);
  const nowMs = nowDate.getTime();
  const monthKey = monthKeyOf(nowDate);
  const reelsOn = Boolean(config.features && config.features.reels);

  const drafts = new Map();
  for (const d of input.drafts) drafts.set(d.id, applyEdit(d, (input.edits && input.edits.get(d.id)) || null));
  const approvals = latestBy(input.approvals || [], "draftId");
  const overrides = latestBy(input.overrides || [], "draftId");
  const published = (input.published || [])
    .filter((r) => !r.dryRun)
    .slice()
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const publishedByDraft = new Map(published.map((r) => [r.draftId, r]));

  // config.json is the admin-owned truth for the mode; status.json only mirrors it after a run.
  const pageByHandle = new Map(config.pages.map((p) => [p.handle, p]));
  const modeOf = (handle) => pageByHandle.get(handle).mode;

  // Calendar entries: every slot with a public label, at its effective (owner-moved or actual) time.
  const entries = [];
  const seenDrafts = new Set();
  const seenSlotIds = new Set();
  for (const slot of (calendar && calendar.slots) || []) {
    seenSlotIds.add(slot.slotId);
    const draft = slot.draftId ? drafts.get(slot.draftId) || null : null;
    const approval = slot.draftId ? approvals.get(slot.draftId) : undefined;
    const label = slotLabel(slot, draft, approval, modeOf(slot.page));
    if (slot.draftId) seenDrafts.add(slot.draftId);
    if (label === null) continue;
    const record = slot.draftId ? publishedByDraft.get(slot.draftId) : undefined;
    const override = slot.draftId ? overrides.get(slot.draftId) : undefined;
    const at = record ? record.publishedAt : override ? override.slotAt : slot.at;
    entries.push({ slotId: slot.slotId, page: slot.page, at, epoch: parseIso(at).getTime(), format: (draft && draft.format) || slot.format, draftId: slot.draftId || null, draft, label: record ? "published" : label, published: record || null, source: "calendar" });
  }
  // Published posts the calendar no longer lists (pruned history) stay visible as 'published'.
  for (const record of published) {
    if (seenDrafts.has(record.draftId)) continue;
    const draft = drafts.get(record.draftId) || null;
    entries.push({ slotId: null, page: record.page, at: record.publishedAt, epoch: parseIso(record.publishedAt).getTime(), format: record.format, draftId: record.draftId, draft, label: "published", published: record, source: "published" });
  }
  // Beyond the Strategist's horizon the posting cadence is the plan (review M11, applied in every state):
  // one 'planned' entry per cadence slot of the current month after the horizon ends (after now when no
  // calendar exists yet). Reel slots are skipped while reels are not built.
  const horizonEnd = calendar && calendar.generatedAt ? addDays(parseIso(calendar.generatedAt), calendar.horizonDays || 0).getTime() : nowMs;
  const fillFrom = Math.max(horizonEnd, nowMs);
  const cadenceOk = (occ) => !seenSlotIds.has(occ.slotId) && (occ.format !== "reel" || reelsOn);
  for (const page of config.pages) {
    for (const occ of cadenceInMonth(page, monthKey)) {
      if (occ.epoch < fillFrom || !cadenceOk(occ)) continue;
      seenSlotIds.add(occ.slotId);
      entries.push(cadenceEntry(occ));
    }
  }
  entries.sort((a, b) => a.epoch - b.epoch || a.page.localeCompare(b.page));

  // "Next up": the next four upcoming entries, topped up from the cadence (also across the month end).
  const upcoming = entries.filter((e) => e.epoch >= nowMs && e.label !== "published");
  const nextUp = upcoming.slice(0, 4);
  if (nextUp.length < 4) {
    for (const occ of nextCadenceSlots(config, new Date(fillFrom), 12)) {
      if (nextUp.length >= 4) break;
      if (!cadenceOk(occ)) continue;
      seenSlotIds.add(occ.slotId);
      nextUp.push(cadenceEntry(occ));
    }
    nextUp.sort((a, b) => a.epoch - b.epoch || a.page.localeCompare(b.page));
  }

  // Drafts waiting for the owner: queued, Approve first, no valid approve, no reject.
  const awaiting = [...drafts.values()].filter((d) => {
    if (d.status !== "queued" || modeOf(d.page) !== "approve_first") return false;
    const a = approvals.get(d.id);
    if (a && a.decision === "reject") return false;
    return !isApproved(d, a);
  });

  const runs = (input.runs || [])
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, 50);
  const hasRuns = Boolean((status.lastRun && status.lastRun.id) || (status.lastRuns && status.lastRuns.length) || runs.length);

  const usageRows = (input.usage || []).filter((u) => monthKeyOf(u.at) === monthKey);
  const usage = {
    month: monthKey,
    rows: usageRows.length,
    usedUsd: Math.round(usageRows.reduce((s, u) => s + (u.costUsd || 0), 0) * 1e6) / 1e6,
    calls: usageRows.length,
    providers: [...new Set(usageRows.filter((u) => u.provider !== "mock").map((u) => u.provider))].sort(),
    limitUsd: config.budget.monthlyUsd,
  };

  const monthEntries = entries.filter((e) => monthKeyOf(e.at) === monthKey);
  const thisMonth = config.pages.map((page) => {
    const mine = monthEntries.filter((e) => e.page === page.handle);
    const count = (label) => mine.filter((e) => e.label === label).length;
    return { page: page.handle, published: count("published"), scheduled: count("scheduled"), inReview: count("in review"), inProgress: count("in progress"), planned: count("planned") };
  });

  // First cadence slot per page from now (the Published empty state, review M11).
  const firstSlotByPage = new Map();
  for (const page of config.pages) {
    const first = nextCadenceSlots({ ...config, pages: [page] }, nowDate, 4).find((s) => s.format !== "reel" || reelsOn);
    if (first) firstSlotByPage.set(page.handle, first);
  }

  const mediaFiles = input.mediaFiles || new Set();
  const posts = published.map((record) => {
    const draft = drafts.get(record.draftId) || null;
    const media = draft ? draft.media.map((m) => ({ ...m, present: mediaFiles.has(m.path) })) : [];
    return { record, draft, caption: draft ? fullCaption(draft) : "", media };
  });

  return {
    now: nowDate,
    nowIso: nowIst(nowDate),
    today: dateKeyOf(nowDate),
    year: istParts(nowDate).y,
    monthKey,
    horizonEnd: calendar && calendar.generatedAt ? nowIst(new Date(horizonEnd)) : null,
    config,
    roster: input.roster,
    brands: input.brands,
    status,
    drafts,
    approvals,
    overrides,
    calendar: calendar || null,
    entries,
    nextUp,
    nextUpFromCadence: nextUp.length > 0 && nextUp.every((e) => e.source === "cadence"),
    nextUpPartlyCadence: nextUp.some((e) => e.source === "cadence"),
    awaiting,
    published,
    posts,
    runs,
    hasRuns,
    usage,
    thisMonth,
    firstSlotByPage,
    mediaFiles,
    modeOf,
    terminal: TERMINAL,
  };
}

// Last run record in which `agent` actually ran (not skipped) → { run, row } | null.
export function lastRunOf(runs, agentName) {
  for (const run of runs) {
    const row = (run.agents || []).find((a) => a.name === agentName && !a.skipped);
    if (row) return { run, row };
  }
  return null;
}
