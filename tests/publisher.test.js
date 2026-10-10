// engine/agents/publisher.js (design §3.2, §9, §11; review M5; P1-09): decide() truth table, min gap, late
// flag, media preflight and publishDraft with a fake client on a temp state — no browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { createState } from "../engine/lib/state.js";
import { APPROVAL_SPEC, DRAFT_SPEC, PUBLISHED_SPEC, PUBLISH_ATTEMPT_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { fullCaption } from "../engine/lib/checks.js";
import { IgError } from "../engine/ig/client.js";
import { AGENT, QUOTA_HEADROOM, REASONS, completePermalinks, decide, failedAttempts, isLate, latestApproval, latestApprovals, preferredUrl, preflight, preflightMedia, publishDraft } from "../engine/agents/publisher.js";

const config = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
const FIX = join(ROOT, "tests", "fixtures");
const draftFixture = (name) => JSON.parse(readFileSync(join(FIX, "drafts", `${name}.json`), "utf8"));
const KD = { ...draftFixture("kd-2026-10-13-six-rules"), status: "queued" };
const JR = { ...draftFixture("jr-2026-10-15-templates"), status: "queued" };
const PAGE_KD = { ...config.pages.find((p) => p.handle === "kaatdo"), igUserId: "17841400000000001" };
const NOW = "2026-10-14T20:00:00+05:30";
const RUN_ID = "publisher-hourly-20261014-2000-f107aa";

// ---------------------------------------------------------------------------------------
// decide() truth table — an independent restatement of the FEAT-107 rule order

const MODES = ["approve_first", "autopilot"];
const APPROVALS = ["none", "approve_same", "approve_stale", "reject"];
const SLOTS = { future: "2026-10-15T12:30:00+05:30", due: "2026-10-14T19:30:00+05:30", expired: "2026-10-12T08:15:00+05:30" };
const ATTEMPTS = [0, 3];
const TOKEN_STATES = ["ok", "invalid", "not_configured"];
const IG_IDS = { set: "17841400000000001", empty: "" };
const STATUSES = ["queued", "written", "rejected"];

function expected({ mode, approval, slot, attempts, tokenState, igId, status }) {
  if (status !== "queued") return { publish: false, reason: `status:${status}` };
  if (slot === "expired") return { publish: false, reason: "expired" };
  if (slot === "future") return { publish: false, reason: "not_due" };
  if (attempts >= config.defaults.maxPublishAttempts) return { publish: false, reason: "attempts_exhausted" };
  if (tokenState === "invalid") return { publish: false, reason: "token_invalid" };
  if (tokenState === "not_configured" || igId === "empty") return { publish: false, reason: "page_not_configured" };
  if (approval === "reject") return { publish: false, reason: "rejected" };
  if (mode === "approve_first") {
    if (approval === "none") return { publish: false, reason: "awaiting_approval" };
    if (approval === "approve_stale") return { publish: false, reason: "approval_stale" };
  }
  return { publish: true, reason: mode === "autopilot" ? "autopilot" : "approved" };
}

function approvalRecords(kind, draftId, revision) {
  if (kind === "none") return [];
  const at = "2026-10-12T10:00:00+05:30";
  if (kind === "reject") return [{ draftId, decision: "reject", revision, at, by: "owner", reason: "Too salesy; keep to the six rules." }];
  return [{ draftId, decision: "approve", revision: kind === "approve_same" ? revision : revision - 1, at, by: "owner" }];
}

test("decide() truth table: mode × approval × slot × attempts × tokenState × igUserId × status — every cell matches the rule order (P1-09, M5 rows expired / rejected / approval_stale publish:false)", () => {
  assert.equal(AGENT, "publisher");
  assert.equal(config.defaults.maxPublishAttempts, 3);
  assert.equal(config.defaults.expireAfterHours, 48);
  const base = { ...KD, revision: 2 };
  let cells = 0;
  let publishes = 0;
  const seen = new Set();
  for (const mode of MODES)
    for (const approval of APPROVALS)
      for (const [slot, slotAt] of Object.entries(SLOTS))
        for (const attempts of ATTEMPTS)
          for (const tokenState of TOKEN_STATES)
            for (const [igId, igUserId] of Object.entries(IG_IDS))
              for (const status of STATUSES) {
                const draft = { ...base, status, slotAt, publishAttempts: Array.from({ length: attempts }, (_, i) => ({ at: `2026-10-14T1${i}:30:00+05:30`, ok: false, stage: "container", code: 4, message: "rate limited", mediaUrlUsed: "raw" })) };
                const records = approvalRecords(approval, draft.id, draft.revision);
                for (const r of records) assertShape(r, APPROVAL_SPEC);
                const page = { ...PAGE_KD, mode, igUserId };
                const got = decide(draft, records, page, NOW, config, { tokenState }, []);
                const want = expected({ mode, approval, slot, attempts, tokenState, igId, status });
                assert.deepEqual(got, want, JSON.stringify({ mode, approval, slot, attempts, tokenState, igId, status }));
                seen.add(got.reason);
                cells++;
                if (got.publish) publishes++;
              }
  assert.equal(cells, 2 * 4 * 3 * 2 * 3 * 2 * 3);
  // publish:true only for queued + due + 0 attempts + ok + id set and (autopilot ∧ ¬reject) ∨ (approve_first ∧ approve_same)
  assert.equal(publishes, 3 + 1);
  for (const r of [...REASONS.filter((x) => x !== "min_gap"), "status:written", "status:rejected"]) assert.ok(seen.has(r), `reason ${r} exercised`);
  // the M5 rows, spelled out
  const queuedDue = { ...base, status: "queued", slotAt: SLOTS.due, publishAttempts: [] };
  const ok = { tokenState: "ok" };
  assert.deepEqual(decide({ ...queuedDue, slotAt: SLOTS.expired }, approvalRecords("approve_same", base.id, 2), { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: false, reason: "expired" });
  assert.deepEqual(decide(queuedDue, approvalRecords("reject", base.id, 2), { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: false, reason: "rejected" }, "a reject blocks autopilot too");
  assert.deepEqual(decide(queuedDue, approvalRecords("approve_stale", base.id, 2), PAGE_KD, NOW, config, ok, []), { publish: false, reason: "approval_stale" });
  assert.deepEqual(decide(queuedDue, approvalRecords("approve_same", base.id, 2), PAGE_KD, NOW, config, ok, []), { publish: true, reason: "approved" });
  assert.deepEqual(decide(queuedDue, [], { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: true, reason: "autopilot" });
  assert.deepEqual(decide(queuedDue, approvalRecords("approve_stale", base.id, 2), { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: true, reason: "autopilot" }, "autopilot does not consult approve records");
  // exactly expireAfterHours past is not yet expired; one second more is
  const edge = "2026-10-12T20:00:00+05:30";
  assert.deepEqual(decide({ ...queuedDue, slotAt: edge }, [], { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: true, reason: "autopilot" });
  assert.deepEqual(decide({ ...queuedDue, slotAt: "2026-10-12T19:59:59+05:30" }, [], { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: false, reason: "expired" });
  // the slot time itself is due
  assert.deepEqual(decide({ ...queuedDue, slotAt: NOW }, [], { ...PAGE_KD, mode: "autopilot" }, NOW, config, ok, []), { publish: true, reason: "autopilot" });
  // the latest approval wins (reject after approve), by `at`
  const flip = [
    { draftId: base.id, decision: "reject", revision: 2, at: "2026-10-12T09:00:00+05:30", by: "owner", reason: "Too salesy." },
    { draftId: base.id, decision: "approve", revision: 2, at: "2026-10-12T11:00:00+05:30", by: "owner" },
  ];
  assert.deepEqual(decide(queuedDue, flip, PAGE_KD, NOW, config, ok, []), { publish: true, reason: "approved" });
  assert.deepEqual(decide(queuedDue, [flip[1], flip[0]], PAGE_KD, NOW, config, ok, []), { publish: true, reason: "approved" }, "file order does not matter");
  assert.equal(latestApproval(flip, base.id).decision, "approve");
  assert.equal(latestApprovals(flip).get(base.id).at, "2026-10-12T11:00:00+05:30");
  assert.equal(latestApproval(flip, "other"), null);
  assert.equal(failedAttempts({ publishAttempts: [{ ok: false }, { ok: true }, { ok: false }] }), 2);
  assert.throws(() => decide(null, [], PAGE_KD, NOW, config), TypeError);
});

test("min_gap: a publish on the page within minGapHours blocks; older ones do not; late flag is > lateAfterHours (6 h)", () => {
  assert.equal(config.defaults.minGapHours, 6);
  assert.equal(config.defaults.lateAfterHours, 6);
  const draft = { ...KD, slotAt: SLOTS.due, publishAttempts: [] };
  const page = { ...PAGE_KD, mode: "autopilot" };
  const recent = (hoursAgo) => [{ draftId: "kd-earlier", page: "kaatdo", publishedAt: `2026-10-14T${String(20 - hoursAgo).padStart(2, "0")}:00:00+05:30` }];
  assert.deepEqual(decide(draft, [], page, NOW, config, { tokenState: "ok" }, recent(2)), { publish: false, reason: "min_gap" });
  assert.deepEqual(decide(draft, [], page, NOW, config, { tokenState: "ok" }, recent(5)), { publish: false, reason: "min_gap" });
  assert.deepEqual(decide(draft, [], page, NOW, config, { tokenState: "ok" }, recent(6)), { publish: true, reason: "autopilot" }, "exactly minGapHours is allowed");
  assert.deepEqual(decide(draft, [], page, NOW, config, { tokenState: "ok" }, ["2026-10-14T19:30:00+05:30"]), { publish: false, reason: "min_gap" }, "ISO strings work too");
  assert.deepEqual(decide(draft, [], page, NOW, config, { tokenState: "ok" }, recent(12)), { publish: true, reason: "autopilot" });
  // the gap check comes after the approval checks
  assert.deepEqual(decide(draft, [], PAGE_KD, NOW, config, { tokenState: "ok" }, recent(2)), { publish: false, reason: "awaiting_approval" });

  assert.equal(isLate("2026-10-14T13:00:00+05:30", NOW, config), true, "7 h late");
  assert.equal(isLate("2026-10-14T14:00:00+05:30", NOW, config), false, "exactly 6 h is not late");
  assert.equal(isLate("2026-10-14T15:00:00+05:30", NOW, config), false, "5 h");
  assert.equal(isLate("2026-10-14T13:59:59+05:30", NOW, config), true);
});

// ---------------------------------------------------------------------------------------
// preflight (HEAD) with a fake fetch

function headFetch(table) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    const r = table[String(url)];
    if (r instanceof Error) throw r;
    if (!r) return new Response(null, { status: 404 });
    return new Response(null, { status: r.status, headers: { "content-type": r.type } });
  };
  fn.calls = calls;
  return fn;
}

test("preflight: HEAD rawUrl 200 image/jpeg → raw; raw failing or wrong type → pagesUrl; neither → null; prefer 'pages' after a media-fetch failure on raw", async () => {
  const item = KD.media[0];
  const okRaw = headFetch({ [item.rawUrl]: { status: 200, type: "image/jpeg" } });
  assert.deepEqual(await preflight(item, okRaw), { url: item.rawUrl, used: "raw" });
  assert.deepEqual(okRaw.calls, [{ url: item.rawUrl, method: "HEAD" }]);

  const rawDown = headFetch({ [item.rawUrl]: { status: 404, type: "text/plain" }, [item.pagesUrl]: { status: 200, type: "image/jpeg" } });
  assert.deepEqual(await preflight(item, rawDown), { url: item.pagesUrl, used: "pages" });
  assert.equal(rawDown.calls.length, 2);

  const wrongType = headFetch({ [item.rawUrl]: { status: 200, type: "text/html; charset=utf-8" }, [item.pagesUrl]: { status: 200, type: "image/jpeg" } });
  assert.deepEqual(await preflight(item, wrongType), { url: item.pagesUrl, used: "pages" });

  const bothDown = headFetch({ [item.rawUrl]: new Error("ECONNRESET"), [item.pagesUrl]: { status: 404, type: "text/html" } });
  assert.equal(await preflight(item, bothDown), null);

  const both = headFetch({ [item.rawUrl]: { status: 200, type: "image/jpeg" }, [item.pagesUrl]: { status: 200, type: "image/jpeg" } });
  assert.deepEqual(await preflight(item, both, { prefer: "pages" }), { url: item.pagesUrl, used: "pages" });
  assert.deepEqual(both.calls, [{ url: item.pagesUrl, method: "HEAD" }], "the preferred URL is tried first and suffices");

  // a video item expects video/mp4 (phase 2 reels)
  const video = { ...item, kind: "video", rawUrl: item.rawUrl.replace(".jpg", ".mp4"), pagesUrl: item.pagesUrl.replace(".jpg", ".mp4") };
  const mp4 = headFetch({ [video.rawUrl]: { status: 200, type: "video/mp4" } });
  assert.deepEqual(await preflight(video, mp4), { url: video.rawUrl, used: "raw" });
  const notMp4 = headFetch({ [video.rawUrl]: { status: 200, type: "image/jpeg" } });
  assert.equal(await preflight(video, notMp4), null);

  // every carousel file must pass; `used` is pages when any file needed the fallback
  const table = {};
  for (const m of JR.media) table[m.rawUrl] = { status: 200, type: "image/jpeg" };
  table[JR.media[2].rawUrl] = { status: 404, type: "text/plain" };
  table[JR.media[2].pagesUrl] = { status: 200, type: "image/jpeg" };
  const mixed = await preflightMedia(JR.media, headFetch(table));
  assert.equal(mixed.used, "pages");
  assert.deepEqual(mixed.urls, [JR.media[0].rawUrl, JR.media[1].rawUrl, JR.media[2].pagesUrl, JR.media[3].rawUrl]);
  const allRaw = await preflightMedia(JR.media, headFetch(Object.fromEntries(JR.media.map((m) => [m.rawUrl, { status: 200, type: "image/jpeg" }]))));
  assert.equal(allRaw.used, "raw");
  assert.equal(await preflightMedia(JR.media, headFetch({})), null);
  assert.equal(await preflightMedia([], headFetch({})), null);

  assert.equal(preferredUrl(KD), "raw");
  assert.equal(preferredUrl({ ...KD, publishAttempts: [{ at: NOW, ok: false, stage: "container", code: 9004, subcode: 2207052, mediaUrlUsed: "raw" }] }), "pages");
  assert.equal(preferredUrl({ ...KD, publishAttempts: [{ at: NOW, ok: false, stage: "container", code: 9004, mediaUrlUsed: "pages" }] }), "raw");
  assert.equal(preferredUrl({ ...KD, publishAttempts: [{ at: NOW, ok: false, stage: "rate_limit", code: 4, mediaUrlUsed: "raw" }] }), "raw", "only media-fetch failures flip the URL");
  await assert.rejects(() => preflight(item, undefined), TypeError);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

// ---------------------------------------------------------------------------------------
// publishDraft with a fake client on a temp state

function fakeClient({ fail = {}, quota = { quotaUsage: 1, quotaTotal: 50, quotaDuration: 86400 }, permalink = "https://www.instagram.com/p/C_fake1/", dryRun = false } = {}) {
  const calls = [];
  let n = 0;
  const maybeFail = (method) => {
    if (fail[method]) throw fail[method];
  };
  return {
    calls,
    dryRun,
    async publishingLimit() {
      calls.push(["publishingLimit"]);
      maybeFail("publishingLimit");
      return quota;
    },
    async preflight(media, opts) {
      calls.push(["preflight", media.length, opts.prefer]);
      if (fail.preflight) return null;
      const used = opts.prefer === "pages" ? "pages" : "raw";
      return { urls: media.map((m) => (used === "pages" ? m.pagesUrl : m.rawUrl)), used };
    },
    async createImageContainer(args) {
      calls.push(["createImageContainer", args]);
      maybeFail("createImageContainer");
      return { id: `cont-${++n}` };
    },
    async createCarouselItem(args) {
      calls.push(["createCarouselItem", args]);
      maybeFail("createCarouselItem");
      return { id: `child-${++n}` };
    },
    async createCarousel(args) {
      calls.push(["createCarousel", args]);
      maybeFail("createCarousel");
      return { id: `car-${++n}` };
    },
    async publish(id) {
      calls.push(["publish", id]);
      maybeFail("publish");
      return { id: `media-${++n}` };
    },
    async getPermalink(id) {
      calls.push(["getPermalink", id]);
      maybeFail("getPermalink");
      return { permalink, timestamp: "2026-10-14T14:30:05+0000" };
    },
  };
}

function harness(draft) {
  const dir = tmpDir("hoshlab-publisher-");
  const state = createState({ companyDir: dir, now: NOW });
  state.writeDraft(draft);
  return { dir, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const approvalKd = { draftId: KD.id, decision: "approve", revision: 1, at: "2026-10-12T10:00:00+05:30", by: "owner" };
const igErr = (code, extra = {}) => new IgError({ code, message: `fake code ${code}`, stage: "container", status: 400, ...extra });

test("publishDraft image: quota → preflight → container (fullCaption, alt_text) → publish → permalink; published.jsonl record (late, approvedBy/At, qaRevision, mediaUrlUsed raw) and draft `published` with an ok attempt", async () => {
  const draft = { ...KD, slotAt: "2026-10-14T13:00:00+05:30", publishAttempts: [] };
  const h = harness(draft);
  const client = fakeClient();
  const logs = [];
  try {
    const r = await publishDraft({ draft, page: PAGE_KD, client, state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd, log: (s) => logs.push(s) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      client.calls.map((c) => c[0]),
      ["publishingLimit", "preflight", "createImageContainer", "publish", "getPermalink"],
    );
    assert.deepEqual(client.calls[2][1], { imageUrl: KD.media[0].rawUrl, caption: fullCaption(KD), altText: KD.altText });
    assert.ok(fullCaption(KD).endsWith("#KaatDo #FnO #RiskManagement #KillSwitch"), "hashtags appended once");
    assert.equal(client.calls[3][1], "cont-1");
    const rows = h.state.readJsonl("state/published.jsonl");
    assert.equal(rows.length, 1);
    assert.deepEqual(validate(rows[0], PUBLISHED_SPEC), { ok: true, errors: [] });
    assert.deepEqual(rows[0], {
      draftId: KD.id,
      page: "kaatdo",
      igMediaId: "media-2",
      permalink: "https://www.instagram.com/p/C_fake1/",
      publishedAt: NOW,
      slotAt: "2026-10-14T13:00:00+05:30",
      late: true,
      mode: "approve_first",
      qaRevision: 1,
      format: "image",
      mediaUrlUsed: "raw",
      runId: RUN_ID,
      approvedBy: "owner",
      approvedAt: "2026-10-12T10:00:00+05:30",
    });
    assert.deepEqual(r.record, rows[0]);
    const saved = h.state.readDraft(KD.id);
    assert.equal(saved.status, "published");
    assert.equal(saved.updatedAt, NOW);
    assert.deepEqual(saved.publishAttempts, [{ at: NOW, ok: true, stage: "publish", mediaUrlUsed: "raw", runId: RUN_ID }]);
    assert.deepEqual(validate(saved, DRAFT_SPEC), { ok: true, errors: [] });
    assert.ok(logs.some((l) => l.includes("published → media-2 https://www.instagram.com/p/C_fake1/ late")), logs.join("\n"));
    assert.equal(r.quota.quotaUsage, 1);
  } finally {
    h.cleanup();
  }
});

test("publishDraft carousel: one child container per file with the per-slide alt text, then the CAROUSEL container with children + caption, then publish; a dry-run client marks the record dryRun:true and autopilot records no approver", async () => {
  const draft = { ...JR, slotAt: "2026-10-14T19:00:00+05:30", publishAttempts: [] };
  const page = { ...config.pages.find((p) => p.handle === "job_rez"), igUserId: "17841400000000003", mode: "autopilot" };
  const h = harness(draft);
  const client = fakeClient({ dryRun: true });
  try {
    const r = await publishDraft({ draft, page, client, state: h.state, config, now: NOW, runId: RUN_ID, approval: null });
    assert.equal(r.ok, true);
    const names = client.calls.map((c) => c[0]);
    assert.deepEqual(names, ["publishingLimit", "preflight", "createCarouselItem", "createCarouselItem", "createCarouselItem", "createCarouselItem", "createCarousel", "publish", "getPermalink"]);
    for (let i = 0; i < 4; i++) assert.deepEqual(client.calls[2 + i][1], { imageUrl: JR.media[i].rawUrl, altText: JR.altTexts[i] });
    assert.deepEqual(client.calls[6][1], { children: ["child-1", "child-2", "child-3", "child-4"], caption: fullCaption(JR) });
    assert.equal(client.calls[7][1], "car-5");
    const row = h.state.readJsonl("state/published.jsonl")[0];
    assert.equal(row.dryRun, true);
    assert.equal(row.mode, "autopilot");
    assert.equal(row.format, "carousel");
    assert.equal(row.late, false);
    assert.equal(row.approvedBy, undefined);
    assert.equal(row.approvedAt, undefined);
    assert.equal(h.state.readDraft(JR.id).status, "published");
  } finally {
    h.cleanup();
  }
});

test("publishDraft failures (design §11): 9004 → attempt stage container (code, subcode, mediaUrlUsed) and the draft stays queued, next hour prefers the Pages URL; 100 → status failed + publish_failed flag; third retryable failure → failed + flag; 190 → tokenInvalid, draft queued, no flag", async () => {
  const base = { ...KD, slotAt: "2026-10-14T19:30:00+05:30", publishAttempts: [] };

  // 9004 / 2207052 on the container
  let h = harness(base);
  try {
    const r = await publishDraft({ draft: base, page: PAGE_KD, client: fakeClient({ fail: { createImageContainer: igErr(9004, { subcode: 2207052, message: `Media download has failed: ${KD.media[0].rawUrl}` }) } }), state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.equal(r.ok, false);
    assert.equal(r.failed, false);
    assert.equal(r.tokenInvalid, false);
    assert.equal(r.retryable, true);
    assert.deepEqual(r.flags, []);
    const saved = h.state.readDraft(KD.id);
    assert.equal(saved.status, "queued");
    assert.equal(saved.publishAttempts.length, 1);
    const a = saved.publishAttempts[0];
    assertShape(a, PUBLISH_ATTEMPT_SPEC);
    assert.equal(a.ok, false);
    assert.equal(a.stage, "container");
    assert.equal(a.code, 9004);
    assert.equal(a.subcode, 2207052);
    assert.equal(a.mediaUrlUsed, "raw");
    assert.equal(a.runId, RUN_ID);
    assert.match(a.message, /Media download has failed/);
    assert.equal(preferredUrl(saved), "pages", "next hour tries the other URL");
    // second hour: the fake client is asked to preflight with prefer 'pages'
    const client2 = fakeClient();
    const r2 = await publishDraft({ draft: saved, page: PAGE_KD, client: client2, state: h.state, config, now: "2026-10-14T21:00:00+05:30", runId: RUN_ID, approval: approvalKd });
    assert.equal(r2.ok, true);
    assert.deepEqual(client2.calls[1], ["preflight", 1, "pages"]);
    assert.equal(client2.calls[2][1].imageUrl, KD.media[0].pagesUrl);
    assert.equal(r2.record.mediaUrlUsed, "pages");
    assert.equal(h.state.readDraft(KD.id).publishAttempts.length, 2);
  } finally {
    h.cleanup();
  }

  // 100 bad parameter → failed at once
  h = harness(base);
  try {
    const r = await publishDraft({ draft: base, page: PAGE_KD, client: fakeClient({ fail: { createImageContainer: igErr(100, { message: "Invalid parameter alt_text" }) } }), state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.equal(r.ok, false);
    assert.equal(r.failed, true);
    assert.equal(r.retryable, false);
    assert.deepEqual(r.flags, [`publish_failed:${KD.id}`]);
    const saved = h.state.readDraft(KD.id);
    assert.equal(saved.status, "failed");
    assert.equal(saved.publishAttempts[0].code, 100);
    assert.equal(saved.publishAttempts[0].subcode, undefined);
    assert.equal(h.state.exists("state/published.jsonl"), false);
  } finally {
    h.cleanup();
  }

  // third retryable failure (rate limit on publish) → failed + flag
  const twoFailed = { ...base, publishAttempts: [
    { at: "2026-10-14T19:31:00+05:30", ok: false, stage: "container", code: 9004, subcode: 2207052, mediaUrlUsed: "raw" },
    { at: "2026-10-14T20:31:00+05:30", ok: false, stage: "rate_limit", code: 4, mediaUrlUsed: "pages" },
  ] };
  h = harness(twoFailed);
  try {
    const client = fakeClient({ fail: { publish: new IgError({ code: 9007, message: "Media not ready", stage: "publish", status: 400 }) } });
    const r = await publishDraft({ draft: twoFailed, page: PAGE_KD, client, state: h.state, config, now: "2026-10-14T21:31:00+05:30", runId: RUN_ID, approval: approvalKd });
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true, "9007 is retryable in itself");
    assert.equal(r.failed, true, "but the third failure exhausts maxPublishAttempts");
    assert.equal(r.stage, "rate_limit");
    assert.deepEqual(r.flags, [`publish_failed:${KD.id}`]);
    const saved = h.state.readDraft(KD.id);
    assert.equal(saved.status, "failed");
    assert.equal(saved.publishAttempts.length, 3);
    assert.equal(saved.publishAttempts[2].stage, "rate_limit");
    assert.equal(saved.publishAttempts[2].code, 9007);
    assert.equal(failedAttempts(saved), 3);
    assert.deepEqual(decide({ ...saved, status: "queued" }, [approvalKd], PAGE_KD, "2026-10-14T22:00:00+05:30", config, { tokenState: "ok" }, []), { publish: false, reason: "attempts_exhausted" });
  } finally {
    h.cleanup();
  }

  // 190 → token invalid: attempt recorded, draft stays queued, the page is the caller's to pause
  h = harness(base);
  try {
    const r = await publishDraft({ draft: base, page: PAGE_KD, client: fakeClient({ fail: { createImageContainer: igErr(190, { message: "Invalid OAuth 2.0 Access Token" }) } }), state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.equal(r.ok, false);
    assert.equal(r.tokenInvalid, true);
    assert.equal(r.failed, false);
    assert.deepEqual(r.flags, []);
    const saved = h.state.readDraft(KD.id);
    assert.equal(saved.status, "queued");
    assert.equal(saved.publishAttempts[0].code, 190);
  } finally {
    h.cleanup();
  }

  // 190 on the quota call: page-level, nothing on the draft
  h = harness(base);
  try {
    const r = await publishDraft({ draft: base, page: PAGE_KD, client: fakeClient({ fail: { publishingLimit: igErr(190) } }), state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.deepEqual([r.ok, r.skipped, r.tokenInvalid, r.quota], [false, "quota_check_failed", true, undefined]);
    assert.deepEqual(h.state.readDraft(KD.id).publishAttempts, []);
  } finally {
    h.cleanup();
  }
});

test("publishDraft guards: quota_usage ≥ quota_total − 2 skips the page without an attempt; a failed preflight records stage preflight and the draft waits; a failed permalink fetch records permalink:null which completePermalinks fills in without duplicating the record", async () => {
  assert.equal(QUOTA_HEADROOM, 2);
  const base = { ...KD, slotAt: "2026-10-14T19:30:00+05:30", publishAttempts: [] };
  let h = harness(base);
  try {
    const r = await publishDraft({ draft: base, page: PAGE_KD, client: fakeClient({ quota: { quotaUsage: 48, quotaTotal: 50, quotaDuration: 86400 } }), state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.deepEqual([r.ok, r.skipped, r.quota.quotaUsage], [false, "quota", 48]);
    assert.deepEqual(h.state.readDraft(KD.id).publishAttempts, []);
    const r2 = await publishDraft({ draft: base, page: PAGE_KD, client: fakeClient({ quota: { quotaUsage: 47, quotaTotal: 50, quotaDuration: 86400 } }), state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.equal(r2.ok, true, "47 of 50 leaves the headroom");
  } finally {
    h.cleanup();
  }

  h = harness(base);
  try {
    const client = fakeClient({ fail: { preflight: true } });
    const r = await publishDraft({ draft: base, page: PAGE_KD, client, state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.deepEqual([r.ok, r.stage, r.retryable, r.failed], [false, "preflight", true, false]);
    assert.deepEqual(client.calls.map((c) => c[0]), ["publishingLimit", "preflight"]);
    const saved = h.state.readDraft(KD.id);
    assert.equal(saved.status, "queued");
    assert.equal(saved.publishAttempts.length, 1);
    assert.equal(saved.publishAttempts[0].stage, "preflight");
    assert.match(saved.publishAttempts[0].message, /HEAD .*none answered 200/);
    assertShape(saved.publishAttempts[0], PUBLISH_ATTEMPT_SPEC);
  } finally {
    h.cleanup();
  }

  h = harness(base);
  try {
    const client = fakeClient({ fail: { getPermalink: new IgError({ message: "ig GET /media-2: network error", stage: "publish" }) } });
    const r = await publishDraft({ draft: base, page: PAGE_KD, client, state: h.state, config, now: NOW, runId: RUN_ID, approval: approvalKd });
    assert.equal(r.ok, true);
    assert.equal(r.record.permalink, null);
    const rows = h.state.readJsonl("state/published.jsonl");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].permalink, null);
    assert.deepEqual(validate(rows[0], PUBLISHED_SPEC), { ok: true, errors: [] }, "permalink may be null until completed (design §11)");
    assert.equal(h.state.readDraft(KD.id).status, "published");
    // next run: completed in place
    const later = fakeClient({ permalink: "https://www.instagram.com/p/C_done2/" });
    const n = await completePermalinks({ state: h.state, client: later, page: PAGE_KD });
    assert.equal(n, 1);
    assert.deepEqual(later.calls, [["getPermalink", "media-2"]]);
    const after = h.state.readJsonl("state/published.jsonl");
    assert.equal(after.length, 1, "rewritten in place, not appended");
    assert.equal(after[0].permalink, "https://www.instagram.com/p/C_done2/");
    assert.equal(after[0].igMediaId, "media-2");
    assert.equal(await completePermalinks({ state: h.state, client: fakeClient(), page: PAGE_KD }), 0, "nothing pending any more");
    // a failing permalink fetch leaves the null in place
    h.state.appendJsonl("state/published.jsonl", { ...after[0], draftId: "kd-other", igMediaId: "media-9", permalink: null }, PUBLISHED_SPEC);
    assert.equal(await completePermalinks({ state: h.state, client: fakeClient({ fail: { getPermalink: new IgError({ message: "down", stage: "publish" }) } }), page: PAGE_KD }), 0);
    assert.equal(h.state.readJsonl("state/published.jsonl")[1].permalink, null);
  } finally {
    h.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});
