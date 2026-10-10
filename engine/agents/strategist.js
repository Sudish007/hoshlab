// Strategist agent (design.md §3.1 step 4, §4.4 ideas.jsonl, §4.5 calendar.json, §5 row
// "Strategist"; review M5.2 slot lifecycle, N3 reels; plan D9).
//
//   fillCalendar(…)   pure: cadence slots for the next backlogWeeks weeks (IST), overrides, minGapHours,
//                     terminal drafts freed → idea back to open (attempts + 1, ≥ 2 → dropped) → slot
//                     re-planned (≥ leadDays out) or dropped; slot status derived from the draft.
//   runStrategist(…)  tops up ideas.jsonl by asking the model, maps its `new:<i>` picks to engine ids,
//                     refuses reel ideas while features.reels is false, assigns open slots, appends the
//                     idea records and writes calendar.json (CALENDAR_SPEC).
//
// The ENGINE creates ids and slots; the model only picks (design §5). Semantic problems in the model's
// ideas (unknown fact ids, wrong language or format) go through the router's single repair call;
// bookkeeping slips in `assignments` (unknown or repeated slot ids, format mismatch) are ignored and
// the slot is filled from the backlog instead, so one sloppy answer never empties the calendar.
import { CALENDAR_SPEC, FORMAT, IDEA_SPEC, LANGUAGE } from "../lib/schema.js";
import { usableFacts } from "../lib/brand.js";
import { ideaId as makeIdeaId, nextIdeaNumber } from "../lib/ids.js";
import { latestByKey } from "../lib/state.js";
import { addDays, istDateTime, istParts, nowIst, parseIso, slotIdFor } from "../lib/time.js";
import { memoExcerptFor, prioritiesFor } from "./ceo.js";

export const AGENT = "strategist";
// M5 set T: a slot whose draft ended in one of these is freed.
export const TERMINAL_SLOT_DRAFT_STATUSES = ["rejected", "blocked", "failed", "expired"];
export const MAX_IDEA_ATTEMPTS = 2;
export const NEW_ID_RE = /^new:(\d+)$/;
export const RECENT_TITLES = 30;
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;

export const OUTPUT_SPEC = {
  ideas: [{ title: "str<=120", angle: "str", format: FORMAT, language: LANGUAGE, factIds: ["str"], hook: "str" }],
  assignments: [{ slotId: "str", ideaId: "str", reason: "str" }],
};

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`strategist: invalid date ${String(v)}`);
  return d;
}

function ms(iso) {
  return parseIso(iso).getTime();
}

// Formats the page may schedule now: reel only while config.features.reels is true (N3).
export function allowedFormats(config, page) {
  return (page.formats || []).filter((f) => f !== "reel" || config.features.reels === true);
}

// Cadence entries per week that produce a slot right now.
export function weeklyCadence(config, page) {
  const allowed = new Set(allowedFormats(config, page));
  return ((page.cadence && page.cadence.slots) || []).filter((s) => allowed.has(s.format)).length;
}

// Cadence slots of one page in [from, from + horizonDays) in IST, time-ordered:
// [{ slotId, page, at, format, epoch }]. Formats not allowed (incl. reel in Phase 1) produce no slot.
export function cadenceSlots(config, page, from, horizonDays) {
  const start = toDate(from);
  const startMs = start.getTime();
  const endMs = startMs + horizonDays * MS_PER_DAY;
  const p = istParts(start);
  const allowed = new Set(allowedFormats(config, page));
  const out = [];
  for (const entry of (page.cadence && page.cadence.slots) || []) {
    if (!allowed.has(entry.format)) continue;
    const [hh, mm] = entry.time.split(":").map(Number);
    const target = DOWS.indexOf(entry.dow);
    if (target < 0) throw new TypeError(`strategist: unknown dow ${entry.dow}`);
    let at = istDateTime(p.y, p.m, p.d, hh, mm);
    at = addDays(at, (target - p.dow + 7) % 7);
    if (at.getTime() < startMs) at = addDays(at, 7);
    while (at.getTime() < endMs) {
      out.push({ slotId: slotIdFor(page.handle, at), page: page.handle, at: nowIst(at), format: entry.format, epoch: at.getTime() });
      at = addDays(at, 7);
    }
  }
  out.sort((a, b) => a.epoch - b.epoch || a.slotId.localeCompare(b.slotId));
  return out;
}

function latestPerDraft(records) {
  const sorted = [...(records || [])].filter((r) => r && r.draftId).sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return latestByKey(sorted, "draftId");
}

// Why a draft's slot must be freed (M5.2), or null when the draft is still alive. `slotAt` is the
// slot's effective time (after overrides). A latest `reject` approval counts even before the next run
// stamps status rejected; a draft whose slot passed more than expireAfterHours ago is expired.
export function terminalReason(draft, { approvals, config, now, slotAt } = {}) {
  if (!draft) return "missing";
  if (TERMINAL_SLOT_DRAFT_STATUSES.includes(draft.status)) return draft.status;
  if (draft.status === "published") return null;
  const approval = approvals instanceof Map ? approvals.get(draft.id) : latestPerDraft(approvals).get(draft.id);
  if (approval && approval.decision === "reject") return "rejected";
  const expireAfterHours = config && config.defaults ? config.defaults.expireAfterHours : null;
  const at = slotAt || draft.slotAt;
  if (Number.isFinite(expireAfterHours) && at && now !== undefined) {
    const hoursPast = (toDate(now).getTime() - ms(at)) / MS_PER_HOUR;
    if (hoursPast > expireAfterHours) return "expired";
  }
  return null;
}

// Slot status is derived from the draft at write time (design §4.5); no draft → planned.
export function slotStatusFor(slot, draft) {
  if (slot.status === "dropped") return "dropped";
  return draft ? draft.status : "planned";
}

function normalizeTitle(t) {
  return String(t || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// fillCalendar({ config, page, calendar, ideas, drafts, overrides, approvals, now })
//   → { slots, freed, dropped, replanned, skipped, ideas, openSlots, horizonDays }
//   slots      this page's slots, time-ordered (other pages are untouched — the caller merges)
//   freed      [{ slotId, draftId, reason }] slots whose draft was terminal (M5.2)
//   dropped    slot ids freed with less than leadDays to go (status dropped, hidden on the site)
//   replanned  slot ids freed with ≥ leadDays to go (status planned; an open idea of the same format
//              is assigned when the backlog has one, otherwise the model fills it)
//   skipped    cadence slots not created because another slot sits within minGapHours
//   ideas      idea records whose status/attempts changed (append them as superseding records)
//   openSlots  future planned slots without an idea (what the model is asked to fill)
export function fillCalendar({ config, page, calendar = null, ideas = [], drafts = [], overrides = [], approvals = [], now } = {}) {
  if (!config || !page) throw new TypeError("strategist: config and page are required");
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();
  const d = config.defaults;
  const horizonDays = d.backlogWeeks * 7;
  const pastMs = nowMs - horizonDays * MS_PER_DAY;
  const handle = page.handle;
  const gapMs = d.minGapHours * MS_PER_HOUR;

  const draftsById = new Map(drafts.filter((x) => x && x.page === handle).map((x) => [x.id, x]));
  const ideaMap = latestByKey(ideas.filter((i) => i && i.page === handle), "id");
  const changed = new Map();
  const touch = (idea, patch) => {
    const next = { ...idea, ...patch };
    ideaMap.set(idea.id, next);
    changed.set(idea.id, next);
    return next;
  };
  const overrideBy = latestPerDraft(overrides);
  const approvalBy = latestPerDraft(approvals);

  // Drafts the Writer created for a slot since the calendar was last written (the Strategist runs
  // before the Writer in a daily run, so the link lands here the next day). Only live drafts attach;
  // a terminal one was freed already and must not be freed (and its idea's attempts counted) twice.
  const liveBySlot = new Map();
  for (const d of draftsById.values()) {
    if (!d.slotId || terminalReason(d, { approvals: approvalBy, config, now: nowDate })) continue;
    const prev = liveBySlot.get(d.slotId);
    if (!prev || String(d.createdAt) > String(prev.createdAt)) liveBySlot.set(d.slotId, d);
  }
  const attach = (s) => {
    if (s.draftId || !liveBySlot.has(s.slotId)) return;
    const d = liveBySlot.get(s.slotId);
    s.draftId = d.id;
    if (!s.ideaId && d.ideaId) s.ideaId = d.ideaId;
  };

  // 1. this page's existing slots, drafts attached, the owner's latest move applied (slotId stays; `at` moves)
  const existing = ((calendar && calendar.slots) || []).filter((s) => s && s.page === handle).map((s) => ({ ...s }));
  for (const s of existing) {
    attach(s);
    const o = s.draftId ? overrideBy.get(s.draftId) : null;
    if (o && o.slotAt && o.slotAt !== s.at) s.at = o.slotAt;
  }

  // 2. cadence slots for the horizon; 3. prune: keep slots with a draft (within one horizon back)
  //    and planned slots the cadence still produces
  const generated = cadenceSlots(config, page, nowDate, horizonDays);
  const generatedIds = new Set(generated.map((g) => g.slotId));
  const kept = existing.filter((s) => {
    const at = ms(s.at);
    if (s.draftId) return at >= pastMs;
    return generatedIds.has(s.slotId) && at >= nowMs;
  });

  // 4. free the slots whose draft is terminal (M5.2)
  const freed = [];
  const dropped = [];
  const replanned = [];
  const freedIdeaIds = new Set();
  for (const s of kept) {
    if (!s.draftId) continue;
    const draft = draftsById.get(s.draftId) || null;
    const reason = terminalReason(draft, { approvals: approvalBy, config, now: nowDate, slotAt: s.at });
    if (!reason) continue;
    const oldDraftId = s.draftId;
    const oldIdeaId = s.ideaId;
    delete s.draftId;
    delete s.ideaId;
    freed.push({ slotId: s.slotId, draftId: oldDraftId, reason });
    if (oldIdeaId && ideaMap.has(oldIdeaId)) {
      const idea = ideaMap.get(oldIdeaId);
      const attempts = (idea.attempts || 0) + 1;
      touch(idea, { attempts, status: attempts >= MAX_IDEA_ATTEMPTS ? "dropped" : "open" });
      freedIdeaIds.add(oldIdeaId);
    }
    const daysOut = (ms(s.at) - nowMs) / MS_PER_DAY;
    const daysText = `${Math.round(daysOut * 10) / 10} day${Math.abs(daysOut) === 1 ? "" : "s"}`;
    if (daysOut >= d.leadDays) {
      s.status = "planned";
      s.reason = `re-planned: draft ${oldDraftId} ${reason} ${daysText} before the slot`;
      replanned.push(s.slotId);
    } else {
      s.status = "dropped";
      s.reason = `dropped: draft ${oldDraftId} ${reason} ${daysText} before the slot (lead ${d.leadDays} days)`;
      dropped.push(s.slotId);
    }
  }

  // 5. new cadence slots, honouring minGapHours against every live slot of the page
  const keptIds = new Set(kept.map((s) => s.slotId));
  const live = kept.filter((s) => s.status !== "dropped").map((s) => ms(s.at));
  const skipped = [];
  for (const g of generated) {
    if (keptIds.has(g.slotId)) continue;
    const clash = live.find((t) => Math.abs(t - g.epoch) < gapMs);
    if (clash !== undefined) {
      skipped.push({ slotId: g.slotId, reason: `within ${d.minGapHours} h of another slot` });
      continue;
    }
    const slot = { slotId: g.slotId, page: handle, at: g.at, format: g.format, status: "planned" };
    attach(slot); // a live draft already written for this cadence id (e.g. the calendar was regenerated)
    kept.push(slot);
    keptIds.add(g.slotId);
    live.push(g.epoch);
  }

  // 6. re-plan freed slots from the open backlog: another open idea of the same format
  const referenced = new Set(kept.filter((s) => s.ideaId).map((s) => s.ideaId));
  for (const slotId of replanned) {
    const s = kept.find((x) => x.slotId === slotId);
    const pick = [...ideaMap.values()]
      .filter((i) => i.status === "open" && i.format === s.format && !referenced.has(i.id) && !freedIdeaIds.has(i.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))[0];
    if (pick) {
      s.ideaId = pick.id;
      s.reason = `${s.reason}; idea ${pick.id} assigned from the backlog`;
      referenced.add(pick.id);
    }
  }

  // 7. derive slot and idea statuses
  for (const s of kept) {
    const draft = s.draftId ? draftsById.get(s.draftId) : null;
    s.status = slotStatusFor(s, draft);
  }
  for (const idea of [...ideaMap.values()]) {
    if (idea.status === "used" || idea.status === "dropped") continue;
    const slot = kept.find((s) => s.ideaId === idea.id && s.status !== "dropped");
    let status = "open";
    if (slot) {
      const draft = slot.draftId ? draftsById.get(slot.draftId) : null;
      status = draft && draft.status === "published" ? "used" : "scheduled";
    }
    if (status !== idea.status) touch(idea, { status });
  }

  kept.sort((a, b) => ms(a.at) - ms(b.at) || a.slotId.localeCompare(b.slotId));
  const openSlots = kept.filter((s) => s.status === "planned" && !s.ideaId && !s.draftId && ms(s.at) >= nowMs);
  return { slots: kept, freed, dropped, replanned, skipped, ideas: [...changed.values()], freedIdeas: [...freedIdeaIds], openSlots, horizonDays };
}

// Semantic rules for the model's answer (repair path): ideas rest on usable facts of this page, in
// one of its languages and formats; `new:<i>` indexes `ideas`; other idea ids must be open ideas.
export function validateStrategistOutput(json, { usableIds, languages = [], formats = [], openIdeaIds = new Set(), handle = "" } = {}) {
  const errors = [];
  const usable = usableIds instanceof Set ? usableIds : new Set(usableIds || []);
  const ideas = Array.isArray(json.ideas) ? json.ideas : [];
  ideas.forEach((idea, i) => {
    if (!Array.isArray(idea.factIds) || idea.factIds.length === 0) errors.push(`$.ideas[${i}].factIds: at least one fact id is required`);
    else idea.factIds.forEach((id, j) => void (usable.has(id) || errors.push(`$.ideas[${i}].factIds[${j}]: ${id} is not a usable fact of @${handle}`)));
    if (languages.length && !languages.includes(idea.language)) errors.push(`$.ideas[${i}].language: ${idea.language} is not a language of @${handle} (${languages.join("|")})`);
    if (formats.length && !formats.includes(idea.format)) errors.push(`$.ideas[${i}].format: ${idea.format} is not a format of @${handle} (${formats.join("|")})`);
  });
  (Array.isArray(json.assignments) ? json.assignments : []).forEach((a, k) => {
    const m = NEW_ID_RE.exec(String(a.ideaId));
    if (m) {
      if (Number(m[1]) >= ideas.length) errors.push(`$.assignments[${k}].ideaId: ${a.ideaId} does not index ideas (${ideas.length} given)`);
    } else if (!openIdeaIds.has(a.ideaId)) errors.push(`$.assignments[${k}].ideaId: ${a.ideaId} is neither new:<index> nor an open idea of @${handle}`);
  });
  return errors;
}

// Titles of the page's last `limit` published posts (via draft → idea), newest last.
export function recentTitles({ published = [], drafts = [], ideas = [], handle, limit = RECENT_TITLES } = {}) {
  const draftsById = new Map(drafts.map((x) => [x.id, x]));
  const ideaMap = latestByKey(ideas, "id");
  return published
    .filter((p) => p.page === handle)
    .sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)))
    .slice(-limit)
    .map((p) => {
      const draft = draftsById.get(p.draftId);
      const idea = draft ? ideaMap.get(draft.ideaId) : null;
      return idea ? idea.title : p.draftId;
    });
}

// The task JSON (charter "Inputs you receive in the task JSON").
export function buildTask({ config, page, brand, memo, openIdeas = [], titles = [], openSlots = [], needNewIdeas = 0, feedbackDigest = "" }) {
  const { priorities, pause } = prioritiesFor(memo, page.handle);
  return {
    page: {
      handle: page.handle,
      languages: page.languages,
      formats: allowedFormats(config, page),
      reelsEnabled: config.features.reels === true,
      cadence: (page.cadence && page.cadence.slots) || [],
      minGapHours: config.defaults.minGapHours,
      backlogWeeks: config.defaults.backlogWeeks,
    },
    priorities: priorities.map((p) => ({ rank: p.rank, theme: p.theme, why: p.why, factIds: p.factIds || [] })),
    pause: pause.map((p) => ({ what: p.what, why: p.why })),
    facts: usableFacts(brand).map((f) => ({ id: f.id, fact: f.fact })),
    pricing: (brand.pricing || []).map((p) => ({ sku: p.sku, price: p.price })),
    openIdeas: openIdeas.map((i) => ({ id: i.id, title: i.title, angle: i.angle, format: i.format, language: i.language, factIds: i.facts, hook: i.hook || "" })),
    recentTitles: titles,
    slots: openSlots.map((s) => ({ slotId: s.slotId, at: s.at, format: s.format })),
    needNewIdeas,
    feedback: feedbackDigest || "",
  };
}

// applyOutput(json, ctx) → { records, assigned, refused, ignored, idMap }: maps `new:<i>` to engine ids,
// refuses reel ideas while reels are off, merges exact-title repeats into the existing idea, honours
// the model's assignments that point at open slots of the right format.
export function applyOutput(json, { page, prefix, allIdeaIds = [], ideaMap, openSlots = [], reelsEnabled = false, at, runId }) {
  const records = [];
  const refused = [];
  const ignored = [];
  const idMap = new Map();
  let n = nextIdeaNumber(prefix, allIdeaIds);
  const titles = new Map();
  for (const idea of ideaMap.values()) if (idea.status === "open" || idea.status === "scheduled") titles.set(normalizeTitle(idea.title), idea.id);

  (json.ideas || []).forEach((idea, i) => {
    const key = `new:${i}`;
    if (idea.format === "reel" && !reelsEnabled) {
      refused.push({ index: i, title: idea.title, reason: "reel: not built yet (features.reels is false)" });
      idMap.set(key, null);
      return;
    }
    const dup = titles.get(normalizeTitle(idea.title));
    if (dup) {
      ignored.push({ index: i, title: idea.title, reason: `duplicate title of idea ${dup}` });
      idMap.set(key, dup);
      return;
    }
    const id = makeIdeaId(prefix, n++);
    const record = { id, page: page.handle, title: idea.title, angle: idea.angle, hook: idea.hook, format: idea.format, language: idea.language, facts: [...idea.factIds], status: "open", attempts: 0, createdAt: at, by: AGENT, runId };
    records.push(record);
    ideaMap.set(id, record);
    titles.set(normalizeTitle(idea.title), id);
    idMap.set(key, id);
  });

  const open = new Map(openSlots.map((s) => [s.slotId, s]));
  const referenced = new Set();
  const assigned = [];
  (json.assignments || []).forEach((a, k) => {
    const slot = open.get(a.slotId);
    if (!slot) return void ignored.push({ assignment: k, slotId: a.slotId, reason: "not an open slot" });
    const id = NEW_ID_RE.test(String(a.ideaId)) ? idMap.get(a.ideaId) : a.ideaId;
    const idea = id ? ideaMap.get(id) : null;
    if (!idea || idea.status === "used" || idea.status === "dropped") return void ignored.push({ assignment: k, slotId: a.slotId, reason: `${a.ideaId}: no such idea to schedule` });
    if (referenced.has(id)) return void ignored.push({ assignment: k, slotId: a.slotId, reason: `${id} already assigned in this answer` });
    if (idea.format !== slot.format) return void ignored.push({ assignment: k, slotId: a.slotId, reason: `${id} is ${idea.format}, slot is ${slot.format}` });
    open.delete(a.slotId);
    referenced.add(id);
    assigned.push({ slotId: a.slotId, ideaId: id, reason: a.reason, by: "model" });
  });
  return { records, assigned, refused, ignored, idMap, openLeft: [...open.values()], referenced };
}

// Fill the slots the model left open from the unreferenced open backlog, oldest idea first. Ideas
// freed in this run (`exclude`) are not re-queued by the engine; the model may pick them again later.
export function autoAssign(openLeft, ideaMap, referenced, exclude = new Set()) {
  const out = [];
  for (const slot of openLeft) {
    const pick = [...ideaMap.values()]
      .filter((i) => i.status === "open" && i.format === slot.format && !referenced.has(i.id) && !exclude.has(i.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))[0];
    if (!pick) continue;
    referenced.add(pick.id);
    out.push({ slotId: slot.slotId, ideaId: pick.id, reason: `backlog idea ${pick.id} (${pick.title})`, by: "engine" });
  }
  return out;
}

// runStrategist({ page, brand, memo, state, router, config, now, runId, feedbackDigest })
//   → { page, modelCalled, calls, costUsd, mock, ideasAdded, ideasChanged, refused, ignored, assigned,
//       autoAssigned, openSlotsLeft, freed, dropped, replanned, skipped, slots, calendarRel, note }
// Reads ideas.jsonl, calendar.json, every draft, overrides/approvals/published; writes ideas.jsonl
// (append) and calendar.json. Router errors propagate and nothing is written.
export async function runStrategist({ page, brand, memo = null, state, router, config, now, runId, feedbackDigest = "" } = {}) {
  if (!page || !brand || !state || !config) throw new TypeError("strategist: page, brand, state and config are required");
  const nowDate = toDate(now === undefined ? state.now() : now);
  const at = nowIst(nowDate);
  const id = runId || (router && router.runId) || undefined;
  const handle = page.handle;

  const ideasAll = state.readJsonl("state/ideas.jsonl");
  const calendar = state.exists("state/calendar.json") ? state.readJson("state/calendar.json", CALENDAR_SPEC) : null;
  const drafts = state.listDrafts().map((did) => state.readDraft(did));
  const overrides = state.readJsonl("state/overrides.jsonl");
  const approvals = state.readJsonl("state/approvals.jsonl");
  const published = state.readJsonl("state/published.jsonl");

  const filled = fillCalendar({ config, page, calendar, ideas: ideasAll, drafts, overrides, approvals, now: nowDate });
  const ideaMap = latestByKey(ideasAll.filter((i) => i && i.page === handle), "id");
  for (const i of filled.ideas) ideaMap.set(i.id, i);
  const changedIds = new Set(filled.ideas.map((i) => i.id));
  const referenced = new Set(filled.slots.filter((s) => s.ideaId).map((s) => s.ideaId));
  const openIdeas = [...ideaMap.values()].filter((i) => i.status === "open" && !referenced.has(i.id));
  const target = config.defaults.backlogWeeks * weeklyCadence(config, page);
  const needNew = Math.max(0, target - openIdeas.length);
  const openSlots = filled.openSlots;

  let res = null;
  let applied = { records: [], assigned: [], refused: [], ignored: [], openLeft: openSlots, referenced };
  if (openSlots.length || needNew > 0) {
    if (!router) throw new TypeError("strategist: router is required when slots are open or the backlog is short");
    const titles = recentTitles({ published, drafts, ideas: ideasAll, handle });
    const task = buildTask({ config, page, brand, memo, openIdeas, titles, openSlots, needNewIdeas: needNew, feedbackDigest });
    const usableIds = new Set(usableFacts(brand).map((f) => f.id));
    res = await router.complete(AGENT, {
      task,
      spec: OUTPUT_SPEC,
      context: { brand, page, memoExcerpt: memoExcerptFor(memo, handle), feedbackDigest },
      validate: (json) => validateStrategistOutput(json, { usableIds, languages: page.languages, formats: page.formats, openIdeaIds: new Set(openIdeas.map((i) => i.id)), handle }),
    });
    applied = applyOutput(res.json, { page, prefix: page.prefix, allIdeaIds: [...ideaMap.keys()], ideaMap, openSlots, reelsEnabled: config.features.reels === true, at, runId: id });
  }
  const auto = autoAssign(applied.openLeft, ideaMap, applied.referenced, new Set(filled.freedIdeas));

  // apply assignments to the slots; assigned ideas become scheduled
  const bySlot = new Map(filled.slots.map((s) => [s.slotId, s]));
  for (const a of [...applied.assigned, ...auto]) {
    const s = bySlot.get(a.slotId);
    s.ideaId = a.ideaId;
    s.status = "planned";
    s.reason = a.reason;
    const idea = ideaMap.get(a.ideaId);
    if (idea.status !== "scheduled") {
      ideaMap.set(a.ideaId, { ...idea, status: "scheduled" });
      changedIds.add(a.ideaId);
    }
  }

  // append: new records (with their final status) then superseding records for changed ideas
  const newIds = new Set(applied.records.map((r) => r.id));
  for (const r of applied.records) state.appendJsonl("state/ideas.jsonl", ideaMap.get(r.id), IDEA_SPEC);
  for (const cid of changedIds) {
    if (newIds.has(cid)) continue;
    const rec = { ...ideaMap.get(cid) };
    if (id) rec.runId = id;
    state.appendJsonl("state/ideas.jsonl", rec, IDEA_SPEC);
  }

  const others = ((calendar && calendar.slots) || []).filter((s) => s.page !== handle);
  const slots = [...others, ...filled.slots].sort((a, b) => ms(a.at) - ms(b.at) || a.page.localeCompare(b.page) || a.slotId.localeCompare(b.slotId));
  const calendarRel = state.writeJson("state/calendar.json", { generatedAt: at, horizonDays: filled.horizonDays, slots }, CALENDAR_SPEC);

  const openSlotsLeft = filled.slots.filter((s) => s.status === "planned" && !s.ideaId && ms(s.at) >= nowDate.getTime());
  const parts = [`${applied.records.length} ideas`, `${filled.slots.length} slots`];
  if (applied.assigned.length || auto.length) parts.push(`${applied.assigned.length + auto.length} assigned${auto.length ? ` (${auto.length} from the backlog)` : ""}`);
  if (filled.replanned.length) parts.push(`${filled.replanned.length} re-planned`);
  if (filled.dropped.length) parts.push(`${filled.dropped.length} dropped`);
  if (applied.refused.length) parts.push(`${applied.refused.length} reel idea${applied.refused.length === 1 ? "" : "s"} refused (reels not built yet)`);
  if (openSlotsLeft.length) parts.push(`${openSlotsLeft.length} open`);
  if (!res) parts.push("model not called (backlog full)");
  return {
    page: handle,
    modelCalled: res !== null,
    calls: res ? res.calls : 0,
    costUsd: res ? res.costUsd : 0,
    mock: res ? res.mock === true : false,
    ideasAdded: applied.records.length,
    ideasChanged: [...changedIds].filter((x) => !newIds.has(x)).length,
    refused: applied.refused,
    ignored: applied.ignored,
    assigned: applied.assigned,
    autoAssigned: auto,
    openSlotsLeft: openSlotsLeft.map((s) => s.slotId),
    freed: filled.freed,
    freedIdeas: filled.freedIdeas,
    dropped: filled.dropped,
    replanned: filled.replanned,
    skipped: filled.skipped,
    slots: filled.slots,
    calendarRel,
    at,
    runId: id,
    note: parts.join(", "),
  };
}
