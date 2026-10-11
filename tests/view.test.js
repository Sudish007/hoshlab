// src/lib/view.js — the site's read model (pure). Dry-run publish records are never shown, owner edits
// apply only to their revision, a stale approval reads 'in review', terminal drafts vanish, cadence fill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadCompany } from "../src/lib/company.js";
import { buildView, applyEdit, cadenceInMonth, latestBy } from "../src/lib/view.js";
import { parseJsonl } from "../engine/lib/state.js";
import { COMPANY_DIR, read } from "./helpers.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const state = company.state;
const NOW = "2026-10-12T09:30:00+05:30";

function input(overrides = {}) {
  return {
    config: company.config,
    roster: company.roster,
    brands: company.brands,
    status: state.readJson("state/status.json", undefined) ,
    drafts: state.listDrafts().map((id) => state.readDraft(id)),
    edits: new Map(),
    approvals: parseJsonl(read(join(COMPANY_DIR, "state", "approvals.jsonl"))),
    overrides: parseJsonl(read(join(COMPANY_DIR, "state", "overrides.jsonl"))),
    published: parseJsonl(read(join(COMPANY_DIR, "state", "published.jsonl"))),
    calendar: JSON.parse(read(join(COMPANY_DIR, "state", "calendar.json"))),
    runs: parseJsonl(read(join(COMPANY_DIR, "state", "runs", "2026-10.jsonl"))),
    usage: parseJsonl(read(join(COMPANY_DIR, "state", "usage", "2026-10.jsonl"))),
    mediaFiles: new Set(),
    now: NOW,
    ...overrides,
  };
}

test("the fixture view: labels, awaiting, month totals, usage sum", () => {
  const v = buildView(input());
  assert.deepEqual(v.nextUp.map((e) => [e.draftId, e.label]), [["kd-2026-10-13-six-rules", "scheduled"], ["rp-2026-10-14-kundali-free", "in review"], [null, "planned"], [null, "planned"]]);
  assert.deepEqual(v.awaiting.map((d) => d.id), ["rp-2026-10-14-kundali-free"]);
  assert.ok(!v.entries.some((e) => e.draftId === "jr-2026-10-15-templates"), "blocked draft omitted (M6/M5)");
  assert.equal(v.usage.usedUsd, 0.053618);
  assert.equal(v.usage.calls, 6);
  assert.deepEqual(v.usage.providers, ["anthropic", "gemini", "openai"]);
  // planned = the fixture calendar's open slots this month + the cadence after its horizon (26 Oct 05:33 → 31 Oct):
  // RishtaPatra Mon 26, Wed 28, Fri 30 + the Sat 31 reel slot (FEAT-201) = 4; KaatDo Tue 27, Thu 29, Sat 31 = 3 (the
  // Sunday reel falls on 1 Nov); JobRez Mon 26 – Thu 29 + the Fri 30 reel slot = 5
  assert.deepEqual(v.thisMonth.map((t) => [t.page, t.published, t.scheduled, t.inReview, t.planned]), [["rishtapatra", 1, 0, 1, 4], ["kaatdo", 1, 1, 0, 3], ["job_rez", 0, 0, 0, 5]]);
  assert.equal(v.hasRuns, true);
  assert.equal(v.posts.length, 2);
  assert.equal(v.horizonEnd, "2026-10-26T05:33:00+05:30");
});

test("dry-run publish records are excluded from posts, feed data and calendar entries", () => {
  const dry = { draftId: "rp-2026-10-14-kundali-free", page: "rishtapatra", igMediaId: "dry-1", permalink: "https://www.instagram.com/p/DRYRUN1/", publishedAt: "2026-10-14T20:00:00+05:30", slotAt: "2026-10-14T19:30:00+05:30", late: false, mode: "approve_first", qaRevision: 1, format: "image", mediaUrlUsed: "raw", runId: "publisher-hourly-20261014-2000-aaaaaa", dryRun: true };
  const base = input();
  const v = buildView({ ...base, published: [...base.published, dry] });
  assert.equal(v.published.length, 2);
  assert.ok(!v.posts.some((p) => p.record.dryRun));
  assert.equal(v.entries.find((e) => e.draftId === "rp-2026-10-14-kundali-free").label, "in review");
});

test("an owner edit applies only when baseRevision matches the draft revision (design §4.8)", () => {
  const draft = { id: "x", revision: 2, caption: "old", hashtags: ["#a"], altText: "alt" };
  assert.equal(applyEdit(draft, { draftId: "x", baseRevision: 1, caption: "stale" }).caption, "old");
  const edited = applyEdit(draft, { draftId: "x", baseRevision: 2, caption: "new", hashtags: ["#b"] });
  assert.deepEqual([edited.caption, edited.hashtags, edited.altText], ["new", ["#b"], "alt"]);
  const base = input();
  const kd = base.drafts.find((d) => d.id === "kd-2026-10-06-reconnect-every-trading-morning");
  const edits = new Map([[kd.id, { draftId: kd.id, baseRevision: kd.revision, caption: "Edited by the owner.", hashtags: kd.hashtags, altText: kd.altText, at: NOW, by: "owner", checks: [] }]]);
  const v = buildView({ ...base, edits });
  assert.ok(v.posts.find((p) => p.record.draftId === kd.id).caption.startsWith("Edited by the owner."));
});

test("a stale approval (older revision) and a reject record read as 'in review' / hidden; autopilot reads 'scheduled'", () => {
  const base = input();
  const stale = base.approvals.map((a) => (a.draftId === "kd-2026-10-13-six-rules" ? { ...a, revision: 0 } : a));
  assert.equal(buildView({ ...base, approvals: stale }).entries.find((e) => e.draftId === "kd-2026-10-13-six-rules").label, "in review");
  const rejected = [...base.approvals, { draftId: "kd-2026-10-13-six-rules", decision: "reject", revision: 1, at: "2026-10-12T11:00:00+05:30", by: "owner", reason: "not today" }];
  assert.ok(!buildView({ ...base, approvals: rejected }).entries.some((e) => e.draftId === "kd-2026-10-13-six-rules"));
  const autopilot = { ...base.config, pages: base.config.pages.map((p) => (p.handle === "rishtapatra" ? { ...p, mode: "autopilot" } : p)) };
  assert.equal(buildView({ ...base, config: autopilot }).entries.find((e) => e.draftId === "rp-2026-10-14-kundali-free").label, "scheduled");
});

test("cadenceInMonth and latestBy", () => {
  const rp = company.config.pages.find((p) => p.handle === "rishtapatra");
  const occ = cadenceInMonth(rp, "2026-10");
  assert.equal(occ.length, 18, "13 feed slots + 5 Saturday reel slots (FEAT-201)");
  assert.equal(occ[0].slotId, "rishtapatra-2026-10-02-1930");
  assert.equal(occ[0].format, "image");
  assert.equal(occ[1].format, "reel", "Sat 3 Oct is the reel slot");
  assert.equal(occ[3].format, "carousel", "Wed 7 Oct is the carousel slot");
  const latest = latestBy([{ draftId: "a", at: "2026-10-01T00:00:00+05:30", decision: "approve" }, { draftId: "a", at: "2026-10-02T00:00:00+05:30", decision: "reject" }], "draftId");
  assert.equal(latest.get("a").decision, "reject");
});
