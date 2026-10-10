// engine/commands/publish.js on a temp copy of tests/fixtures/company-populated (design §3.2, §11; M5.1;
// P1-09): dry-run client, fake clients for 190 / repeated failures, stale edits, expiry, load failure, CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir, walk } from "./helpers.js";
import { EXIT, main } from "../engine/index.js";
import { createState } from "../engine/lib/state.js";
import { DRAFT_SPEC, EDIT_SPEC, PUBLISHED_SPEC, RUN_SPEC, STATUS_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { fullCaption } from "../engine/lib/checks.js";
import { IgError } from "../engine/ig/client.js";
import { LINE_PREFIX } from "../engine/ig/dry-run.js";
import { LIVE_STATUSES, WORKFLOW, applyEdit, latestOverrides, queueCounts, runPublish, triggerFrom } from "../engine/commands/publish.js";

const NOW = "2026-10-14T20:00:00+05:30"; // the kd slot (Tue 13th 08:15) is due and late, the rp slot (Wed 14th 19:30) is due
const KD = "kd-2026-10-13-six-rules";
const RP = "rp-2026-10-14-kundali-free";
const JR = "jr-2026-10-15-templates";
const IG_USER = "17841400000000001";
const TOKEN = "FAKE-IG-TOKEN-KAATDO-" + "x".repeat(40);
const ENV_KD = { IG_TOKEN_KAATDO: TOKEN };

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

// A temp copy of the populated fixture → { dir (company dir), state, cleanup, config(), status(), draft(id) }
function copyFixture({ configure = false } = {}) {
  const base = tmpDir("hoshlab-publish-cmd-");
  const dir = join(base, "company");
  cpSync(COMPANY_DIR, dir, { recursive: true });
  const configPath = join(dir, "config.json");
  if (configure) {
    // the owner's setup: igUserId in config.json (admin-owned, written with plain fs as setup-secrets.ps1 would)
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.pages.find((p) => p.handle === "kaatdo").igUserId = IG_USER;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }
  const state = createState({ companyDir: dir, now: NOW });
  return {
    dir,
    state,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    config: () => JSON.parse(readFileSync(configPath, "utf8")),
    status: () => JSON.parse(readFileSync(join(dir, "state", "status.json"), "utf8")),
    draft: (id) => JSON.parse(readFileSync(join(dir, "state", "drafts", id, "draft.json"), "utf8")),
    published: () => state.readJsonl("state/published.jsonl"),
    runs: () => state.readJsonl("state/runs/2026-10.jsonl"),
  };
}

// A client double whose named methods throw `fail[method]`; records calls.
function fakeClient(fail = {}) {
  const calls = [];
  let n = 0;
  const step = (method, ret) => async (...args) => {
    calls.push([method, ...args]);
    if (fail[method]) throw fail[method];
    return typeof ret === "function" ? ret(...args) : ret;
  };
  return {
    calls,
    dryRun: false,
    publishingLimit: step("publishingLimit", { quotaUsage: 3, quotaTotal: 50, quotaDuration: 86400 }),
    preflight: step("preflight", (media, opts) => ({ urls: media.map((m) => m.rawUrl), used: opts.prefer === "pages" ? "pages" : "raw" })),
    createImageContainer: step("createImageContainer", () => ({ id: `cont-${++n}` })),
    createCarouselItem: step("createCarouselItem", () => ({ id: `child-${++n}` })),
    createCarousel: step("createCarousel", () => ({ id: `car-${++n}` })),
    publish: step("publish", () => ({ id: `17990${++n}` })),
    getPermalink: step("getPermalink", { permalink: "https://www.instagram.com/p/C_cmd1/", timestamp: "2026-10-14T14:30:05+0000" }),
  };
}

function treeHash(dir) {
  const h = createHash("sha256");
  for (const p of walk(dir).sort()) {
    h.update(relative(dir, p).replace(/\\/g, "/"));
    h.update(readFileSync(p));
  }
  return h.digest("hex");
}

test("fixture state seeded for the publisher: kd queued rev 1 + approve rev 1, rp queued rev 1 without approval, jr blocked reworkCount 2; calendar, ideas and qa files validate", () => {
  const fx = copyFixture();
  try {
    const kd = fx.draft(KD);
    const rp = fx.draft(RP);
    const jr = fx.draft(JR);
    for (const d of [kd, rp, jr]) assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] }, d.id);
    assert.deepEqual([kd.status, kd.revision, rp.status, rp.revision, jr.status, jr.reworkCount, jr.revision], ["queued", 1, "queued", 1, "blocked", 2, 3]);
    assert.equal(kd.media[0].path, `media/${KD}/image-1-7cfbae6d.jpg`);
    assert.equal(kd.media[0].rawUrl, `https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/${KD}/image-1-7cfbae6d.jpg`);
    assert.equal(kd.media[0].pagesUrl, `https://sudish007.github.io/hoshlab/media/${KD}/image-1-7cfbae6d.jpg`);
    const qa = (id) => fx.state.readQa(id);
    assert.equal(qa(KD).passed, true);
    assert.equal(qa(RP).passed, true);
    assert.equal(qa(JR).passed, false);
    assert.ok(qa(JR).reasons.length >= 1);
    assert.deepEqual(jr.qaReasons, qa(JR).reasons);
    const approvals = fx.state.readJsonl("state/approvals.jsonl");
    assert.deepEqual(approvals, [{ draftId: KD, decision: "approve", revision: 1, at: "2026-10-12T10:00:00+05:30", by: "owner" }]);
    const calendar = fx.state.readJson("state/calendar.json");
    assert.deepEqual(calendar.slots.map((s) => [s.slotId, s.draftId, s.status]), [
      ["kaatdo-2026-10-13-0815", KD, "queued"],
      ["rishtapatra-2026-10-14-1930", RP, "queued"],
      ["job_rez-2026-10-15-1230", JR, "blocked"],
    ]);
    assert.ok(Date.parse(calendar.slots[0].at) < Date.parse(NOW), "the kd slot is due relative to the test clock");
    const ideas = fx.state.readJsonl("state/ideas.jsonl");
    assert.deepEqual(ideas.map((i) => i.id), ["kd-i0007", "rp-i0031", "jr-i0012"]);
    assert.deepEqual(validate(fx.status(), STATUS_SPEC), { ok: true, errors: [] });
    assert.equal(fx.status().pages.kaatdo.tokenState, "not_configured");
    assert.equal(fx.config().pages[1].igUserId, "", "fixture pages are not configured (dry run substitutes dry-user)");
  } finally {
    fx.cleanup();
  }
});

test("dry-run client: the approved kd draft publishes (dry- id, DRYRUN permalink, dryRun:true, late), rp stays queued with awaiting_approval in the run record, status.json counts/lastRuns update, the call sequence is printed; a second run changes nothing", async () => {
  const fx = copyFixture();
  const out = sink();
  try {
    const r = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: {}, dryRun: true, stdout: out });
    assert.equal(r.ok, true, out.text());
    assert.equal(r.changed, true);
    assert.equal(r.run.dryRun, true);
    assert.equal(r.run.workflow, WORKFLOW);
    assert.equal(r.run.trigger, "local");
    assert.match(r.run.id, /^publisher-hourly-20261014-2000-[0-9a-f]{6}$/);
    assert.deepEqual(validate(r.run, RUN_SPEC), { ok: true, errors: [] });

    const published = fx.published();
    assert.equal(published.length, 1);
    const rec = published[0];
    assert.deepEqual(validate(rec, PUBLISHED_SPEC), { ok: true, errors: [] });
    assert.equal(rec.draftId, KD);
    assert.match(rec.igMediaId, /^dry-[0-9a-f]{8}$/);
    assert.match(rec.permalink, /^https:\/\/www\.instagram\.com\/p\/DRYRUN[0-9a-f]{8}\/$/);
    assert.equal(rec.dryRun, true);
    assert.equal(rec.late, true, "35.75 h after the slot");
    assert.equal(rec.slotAt, "2026-10-13T08:15:00+05:30");
    assert.equal(rec.publishedAt, NOW);
    assert.equal(rec.mode, "approve_first");
    assert.equal(rec.approvedBy, "owner");
    assert.equal(rec.qaRevision, 1);
    assert.equal(rec.mediaUrlUsed, "raw");
    assert.equal(rec.runId, r.run.id);
    assert.equal(fx.draft(KD).status, "published");
    assert.equal(fx.draft(KD).publishAttempts.at(-1).ok, true);
    assert.equal(fx.draft(RP).status, "queued");
    assert.equal(fx.draft(JR).status, "blocked");

    const pub = r.run.publisher;
    assert.deepEqual(pub.decisions.map((d) => [d.draftId, d.publish, d.reason]), [
      [RP, false, "awaiting_approval"],
      [KD, true, "approved"],
    ]);
    assert.equal(pub.decisions[1].igMediaId, rec.igMediaId);
    assert.deepEqual(pub.staleEdits, []);
    assert.deepEqual(pub.expired, []);
    assert.deepEqual(pub.pages, { rishtapatra: { outcome: "idle" }, kaatdo: { outcome: "published", draftId: KD, quotaUsage: 0, quotaTotal: 50 }, job_rez: { outcome: "idle" } });
    assert.equal(r.run.agents[0].name, "publisher");
    assert.equal(r.run.agents[0].note, "1 published, 1 waiting, 0 failed, 0 expired");
    assert.deepEqual(r.run.changed, ["company/state/published.jsonl", `company/state/drafts/${KD}/draft.json`, "company/state/status.json", "company/state/runs/2026-10.jsonl"]);

    const status = fx.status();
    assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
    assert.equal(status.pages.kaatdo.lastPublishedAt, NOW);
    assert.equal(status.pages.kaatdo.tokenState, "not_configured", "a dry run proves nothing about the token");
    assert.equal(status.pages.kaatdo.mode, "approve_first");
    assert.deepEqual(status.queue, { rishtapatra: 1, kaatdo: 0, job_rez: 0 });
    assert.deepEqual(status.blocked, { job_rez: 1 });
    assert.deepEqual(status.flags, []);
    assert.equal(status.lastRuns.length, 1);
    assert.equal(status.lastRun.workflow, WORKFLOW);
    assert.equal(status.lastRun.ok, true);
    const runs = fx.runs();
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0], r.run);

    // the dry-run client printed the exact sequence: quota → HEAD → media (image_url …) → media_publish → permalink
    const dry = out.lines.filter((l) => l.startsWith(LINE_PREFIX));
    assert.deepEqual(
      dry.map((l) => l.split(" ").slice(2, 4).join(" ")),
      ["GET /dry-user/content_publishing_limit", `HEAD https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/${KD}/image-1-7cfbae6d.jpg`, "POST /dry-user/media", "POST /dry-user/media_publish", `GET /${rec.igMediaId}`],
    );
    assert.ok(dry[2].startsWith(`[ig dry-run] POST /dry-user/media image_url=https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/${KD}/image-1-7cfbae6d.jpg caption=`), dry[2]);
    assert.ok(out.lines.some((l) => l === `[publisher] rishtapatra: idle (${RP} awaiting_approval)`), out.text());
    assert.ok(out.lines.some((l) => l.startsWith(`[publisher] kaatdo: published ${KD}`)), out.text());
    assert.ok(out.lines.some((l) => l === "[publisher] job_rez: idle (no queued drafts)"), out.text());
    assert.ok(out.lines.at(-1).startsWith("[publisher] ok "), out.lines.at(-1));

    // second run an hour later: nothing new (kd published, rp still unapproved) → changed false
    const out2 = sink();
    const r2 = await runPublish({ companyDir: fx.dir, now: "2026-10-14T21:00:00+05:30", processEnv: {}, dryRun: true, stdout: out2 });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false);
    assert.equal(fx.published().length, 1);
    assert.deepEqual(r2.run.publisher.decisions, [{ draftId: RP, page: "rishtapatra", publish: false, reason: "awaiting_approval" }]);
    assert.equal(fx.status().lastRuns.length, 2);
    assert.equal(fx.runs().length, 2);
    assert.equal(out2.lines.filter((l) => l.startsWith(LINE_PREFIX)).length, 0);
    assert.deepEqual(r2.run.changed, ["company/state/status.json", "company/state/runs/2026-10.jsonl"]);
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("approving rp (revision 1) publishes it in the next dry run; a stale approval (revision 2) is reported approval_stale; an autopilot page posts without approval", async () => {
  const fx = copyFixture();
  try {
    const appr = join(fx.dir, "state", "approvals.jsonl");
    writeFileSync(appr, readFileSync(appr, "utf8") + JSON.stringify({ draftId: RP, decision: "approve", revision: 2, at: "2026-10-14T19:40:00+05:30", by: "owner" }) + "\n", "utf8");
    const r1 = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: {}, dryRun: true, page: "rishtapatra", stdout: () => {} });
    assert.deepEqual(r1.run.publisher.decisions, [{ draftId: RP, page: "rishtapatra", publish: false, reason: "approval_stale" }]);
    assert.deepEqual(r1.run.publisher.pages, { rishtapatra: { outcome: "idle" }, kaatdo: { outcome: "filtered" }, job_rez: { outcome: "filtered" } });
    writeFileSync(appr, readFileSync(appr, "utf8") + JSON.stringify({ draftId: RP, decision: "approve", revision: 1, at: "2026-10-14T19:50:00+05:30", by: "owner" }) + "\n", "utf8");
    const r2 = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: {}, dryRun: true, page: "rishtapatra", stdout: () => {} });
    assert.deepEqual(r2.run.publisher.decisions.map((d) => [d.draftId, d.publish, d.reason]), [[RP, true, "approved"]]);
    assert.equal(fx.draft(RP).status, "published");
    assert.equal(fx.published()[0].late, false, "30 min after the slot");
    assert.equal(fx.draft(KD).status, "queued", "filtered page untouched");
  } finally {
    fx.cleanup();
  }

  const auto = copyFixture();
  try {
    const cfg = auto.config();
    cfg.pages.find((p) => p.handle === "rishtapatra").mode = "autopilot";
    writeFileSync(join(auto.dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    const r = await runPublish({ companyDir: auto.dir, now: NOW, processEnv: {}, dryRun: true, stdout: () => {} });
    assert.deepEqual(r.run.publisher.decisions.map((d) => [d.draftId, d.publish, d.reason]), [
      [RP, true, "autopilot"],
      [KD, true, "approved"],
    ]);
    const rows = auto.published();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((p) => p.draftId === RP).mode, "autopilot");
    assert.equal(rows.find((p) => p.draftId === RP).approvedBy, undefined);
    assert.equal(auto.status().pages.rishtapatra.mode, "autopilot", "status mirrors config");
  } finally {
    auto.cleanup();
  }
});

test("a fake client returning code 190 → status.json pages.kaatdo.tokenState 'invalid', flag token_invalid:kaatdo, attempt on the draft without the token; the page is skipped afterwards (no client built)", async () => {
  const fx = copyFixture({ configure: true });
  const out = sink();
  try {
    const client = fakeClient({ createImageContainer: new IgError({ code: 190, message: `Invalid OAuth 2.0 Access Token ${TOKEN}`, stage: "container", status: 400, type: "IGApiException", secrets: [TOKEN] }) });
    let factoryCalls = 0;
    const r = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: ENV_KD, clientFactory: (page, token) => (factoryCalls++, assert.equal(page.handle, "kaatdo"), assert.equal(token, TOKEN), client), stdout: out });
    assert.equal(r.ok, true);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(client.calls.map((c) => c[0]), ["publishingLimit", "preflight", "createImageContainer"]);
    const status = fx.status();
    assert.equal(status.pages.kaatdo.tokenState, "invalid");
    assert.deepEqual(status.flags, ["token_invalid:kaatdo"]);
    assert.equal(status.pages.kaatdo.lastPublishedAt, null);
    assert.equal(status.pages.rishtapatra.tokenState, "not_configured", "no secret for rishtapatra");
    assert.equal(status.pages.job_rez.tokenState, "not_configured");
    const kd = fx.draft(KD);
    assert.equal(kd.status, "queued");
    assert.equal(kd.publishAttempts.length, 1);
    assert.equal(kd.publishAttempts[0].code, 190);
    assert.ok(!kd.publishAttempts[0].message.includes(TOKEN), "token scrubbed from the attempt message");
    assert.ok(!out.text().includes(TOKEN), "token never printed");
    assert.ok(!JSON.stringify(r.run).includes(TOKEN));
    assert.deepEqual(r.run.publisher.pages.kaatdo, { outcome: "token_invalid", draftId: KD });
    assert.deepEqual(r.run.publisher.decisions.filter((d) => d.page === "kaatdo"), [{ draftId: KD, page: "kaatdo", publish: false, reason: "attempt_failed:container", stage: "container", code: 190 }], "one row per draft: the attempt outcome replaces the positive decision");
    assert.deepEqual(r.run.publisher.decisions.filter((d) => d.page === "rishtapatra"), [{ draftId: RP, page: "rishtapatra", publish: false, reason: "page_not_configured" }], "no secret and no igUserId for rishtapatra");
    assert.equal(fx.published().length, 0);
    assert.equal(r.changed, true, "the draft changed (attempt recorded)");

    // next hour: the page is skipped without building a client; the draft decision reads token_invalid
    const r2 = await runPublish({ companyDir: fx.dir, now: "2026-10-14T21:00:00+05:30", processEnv: ENV_KD, clientFactory: () => (factoryCalls++, client), stdout: () => {} });
    assert.equal(factoryCalls, 1, "no client for an invalid page");
    assert.deepEqual(r2.run.publisher.pages.kaatdo, { outcome: "token_invalid" });
    assert.deepEqual(r2.run.publisher.decisions.find((d) => d.page === "kaatdo"), { draftId: KD, page: "kaatdo", publish: false, reason: "token_invalid" });
    assert.equal(fx.status().pages.kaatdo.tokenState, "invalid");
    assert.deepEqual(fx.status().flags, ["token_invalid:kaatdo"], "flag not duplicated");
    assert.equal(fx.draft(KD).publishAttempts.length, 1, "no new attempt");
    assert.equal(r2.changed, false);
    // ... and once the token works again (a replaced secret) the page recovers by publishing
    const good = fakeClient();
    const r3 = await runPublish({ companyDir: fx.dir, now: "2026-10-14T22:00:00+05:30", processEnv: ENV_KD, clientFactory: () => good, stdout: () => {} });
    assert.deepEqual(r3.run.publisher.pages.kaatdo, { outcome: "token_invalid" }, "a stored invalid state needs the owner (design §11: run setup-secrets)");
    assert.equal(good.calls.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("three failed attempts (one per run) → status failed + publish_failed:<id> flag; the first two leave the draft queued with retry_next_hour and mark the token ok (quota call answered)", async () => {
  const fx = copyFixture({ configure: true });
  try {
    const hours = ["2026-10-14T20:00:00+05:30", "2026-10-14T21:00:00+05:30", "2026-10-14T22:00:00+05:30"];
    const outcomes = [];
    for (const now of hours) {
      const client = fakeClient({ createImageContainer: new IgError({ code: 4, message: "Application request limit reached", stage: "container", status: 400 }) });
      const r = await runPublish({ companyDir: fx.dir, now, processEnv: ENV_KD, clientFactory: () => client, stdout: () => {} });
      outcomes.push(r.run.publisher.pages.kaatdo.outcome);
      assert.deepEqual(client.calls.map((c) => c[0]), ["publishingLimit", "preflight", "createImageContainer"], "one attempt per run");
    }
    assert.deepEqual(outcomes, ["retry_next_hour", "retry_next_hour", "failed"]);
    const kd = fx.draft(KD);
    assert.equal(kd.status, "failed");
    assert.equal(kd.publishAttempts.length, 3);
    assert.ok(kd.publishAttempts.every((a) => a.ok === false && a.stage === "rate_limit" && a.code === 4 && a.mediaUrlUsed === "raw"));
    assert.deepEqual(kd.publishAttempts.map((a) => a.at), hours);
    const status = fx.status();
    assert.deepEqual(status.flags, [`publish_failed:${KD}`]);
    assert.equal(status.pages.kaatdo.tokenState, "ok", "content_publishing_limit answered, so the token works");
    assert.deepEqual(status.queue, { rishtapatra: 1, kaatdo: 0, job_rez: 0 });
    assert.equal(status.lastRuns.length, 3);
    const runs = fx.runs();
    assert.equal(runs.length, 3);
    // rp is page_not_configured here (no secret), which is not "waiting" on time or approval
    assert.equal(runs[2].agents[0].note, "0 published, 0 waiting, 1 failed, 0 expired");
    assert.equal(runs[0].agents[0].note, "0 published, 1 waiting, 0 failed, 0 expired", "the retry_next_hour draft waits");
    // a fourth run: nothing queued on kaatdo any more
    const r4 = await runPublish({ companyDir: fx.dir, now: "2026-10-14T23:00:00+05:30", processEnv: ENV_KD, clientFactory: () => fakeClient(), stdout: () => {} });
    assert.deepEqual(r4.run.publisher.pages.kaatdo, { outcome: "idle" });
    assert.equal(r4.changed, false);
  } finally {
    fx.cleanup();
  }
});

test("owner edits: a stale edit (baseRevision ≠ revision) is ignored and listed in staleEdits[]; a matching edit replaces caption/hashtags/altText in the published call; an unparsable edit file is listed too", async () => {
  const fx = copyFixture({ configure: true });
  try {
    const original = fx.draft(KD);
    const editsDir = join(fx.dir, "state", "edits");
    mkdirSync(editsDir, { recursive: true });
    const checks = { passed: true, checks: [{ id: "caption_length", ok: true, detail: "1/2200" }] };
    const stale = { draftId: KD, baseRevision: 2, caption: "STALE EDIT", hashtags: ["#KaatDo"], altText: "stale", at: "2026-10-14T19:00:00+05:30", by: "owner", checks };
    assertShape(stale, EDIT_SPEC);
    writeFileSync(join(editsDir, `${KD}.json`), JSON.stringify(stale, null, 2), "utf8");
    const c1 = fakeClient();
    const r1 = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: ENV_KD, clientFactory: () => c1, stdout: () => {} });
    assert.deepEqual(r1.run.publisher.staleEdits, [KD]);
    assert.equal(c1.calls.find((c) => c[0] === "createImageContainer")[1].caption, fullCaption(original), "the stale edit is not applied");
    assert.equal(r1.run.agents[0].note, "1 published, 0 waiting, 0 failed, 0 expired, 1 stale edit");
    assert.equal(fx.draft(KD).caption, original.caption, "the publisher never rewrites owner copy into the draft");
  } finally {
    fx.cleanup();
  }

  const fx2 = copyFixture({ configure: true });
  try {
    const editsDir = join(fx2.dir, "state", "edits");
    mkdirSync(editsDir, { recursive: true });
    const edit = { draftId: KD, baseRevision: 1, caption: "Six rules. One kill switch. Edited by the owner.\nKaatDo is a risk-management tool, not investment advice. KaatDo is not registered with SEBI. Broker API execution is never guaranteed.\nkaatdo.com", hashtags: ["#KaatDo", "#FnO"], altText: "Edited alt text", at: "2026-10-14T19:00:00+05:30", by: "owner", checks: { passed: true, checks: [] } };
    assertShape(edit, EDIT_SPEC);
    writeFileSync(join(editsDir, `${KD}.json`), JSON.stringify(edit, null, 2), "utf8");
    writeFileSync(join(editsDir, `${RP}.json`), "{ not json", "utf8");
    const c2 = fakeClient();
    const r2 = await runPublish({ companyDir: fx2.dir, now: NOW, processEnv: ENV_KD, clientFactory: () => c2, stdout: () => {} });
    const call = c2.calls.find((c) => c[0] === "createImageContainer")[1];
    assert.equal(call.caption, `${edit.caption}\n\n#KaatDo #FnO`);
    assert.equal(call.altText, "Edited alt text");
    assert.deepEqual(r2.run.publisher.staleEdits, [RP], "the unparsable edit is listed, the valid one is not");
    assert.equal(fx2.published()[0].draftId, KD);
    assert.deepEqual(applyEdit({ caption: "a", hashtags: [], altText: "b", altTexts: ["x"] }, { caption: "c", hashtags: ["#d"], altText: "e" }), { caption: "c", hashtags: ["#d"], altText: "e", altTexts: ["x"] });
  } finally {
    fx2.cleanup();
  }
});

test("overrides move the publish time: the latest overrides.jsonl slotAt per draft decides due/not_due and lands in the record's slotAt; an expired queued draft becomes status expired (M5.1) and is listed", async () => {
  const fx = copyFixture();
  try {
    // move rp to tomorrow → not_due even though its original slot has passed; the record of kd is unaffected
    const ovr = [
      { draftId: RP, slotAt: "2026-10-16T19:30:00+05:30", at: "2026-10-14T18:00:00+05:30", by: "owner" },
      { draftId: RP, slotAt: "2026-10-15T19:30:00+05:30", at: "2026-10-14T18:30:00+05:30", by: "owner" },
    ];
    writeFileSync(join(fx.dir, "state", "overrides.jsonl"), ovr.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
    assert.equal(latestOverrides(ovr).get(RP), "2026-10-15T19:30:00+05:30", "latest by `at`");
    // an extra queued draft whose slot passed 6.5 days ago → expired
    const stale = { ...fx.draft(KD), id: "kd-2026-10-08-stale", slotId: "kaatdo-2026-10-08-0815", slotAt: "2026-10-08T08:15:00+05:30", createdAt: "2026-10-05T05:33:00+05:30", updatedAt: "2026-10-07T05:35:00+05:30" };
    fx.state.writeDraft(stale);
    // a written draft past expiry expires too; a published one never does
    fx.state.writeDraft({ ...stale, id: "kd-2026-10-09-written", slotAt: "2026-10-09T08:15:00+05:30", status: "written", media: [] });
    fx.state.writeDraft({ ...stale, id: "kd-2026-10-07-done", slotAt: "2026-10-07T08:15:00+05:30", status: "published" });
    assert.deepEqual(LIVE_STATUSES, ["written", "rendered", "queued", "rework"]);
    const r = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: {}, dryRun: true, stdout: () => {} });
    assert.deepEqual(r.run.publisher.expired.sort(), ["kd-2026-10-08-stale", "kd-2026-10-09-written"]);
    assert.equal(fx.draft("kd-2026-10-08-stale").status, "expired");
    assert.equal(fx.draft("kd-2026-10-09-written").status, "expired");
    assert.equal(fx.draft("kd-2026-10-07-done").status, "published");
    assert.deepEqual(r.run.publisher.decisions.map((d) => [d.draftId, d.reason]), [
      [RP, "not_due"],
      [KD, "approved"],
    ]);
    assert.equal(r.run.agents[0].note, "1 published, 1 waiting, 0 failed, 2 expired");
    assert.equal(fx.draft(RP).slotAt, "2026-10-14T19:30:00+05:30", "the draft file keeps its own slotAt; the override stays the owner's record");
    // next day the moved rp slot is due: an approval publishes it with the moved slotAt in the record
    writeFileSync(join(fx.dir, "state", "approvals.jsonl"), readFileSync(join(fx.dir, "state", "approvals.jsonl"), "utf8") + JSON.stringify({ draftId: RP, decision: "approve", revision: 1, at: "2026-10-15T09:00:00+05:30", by: "owner" }) + "\n", "utf8");
    const r2 = await runPublish({ companyDir: fx.dir, now: "2026-10-15T19:45:00+05:30", processEnv: {}, dryRun: true, stdout: () => {} });
    const rec = fx.published().find((p) => p.draftId === RP);
    assert.ok(rec, JSON.stringify(r2.run.publisher));
    assert.equal(rec.slotAt, "2026-10-15T19:30:00+05:30");
    assert.equal(rec.late, false);
    assert.deepEqual(queueCounts([{ page: "kaatdo", status: "queued" }, { page: "job_rez", status: "blocked" }, { page: "kaatdo", status: "blocked" }], fx.config()), { queue: { rishtapatra: 0, kaatdo: 1, job_rez: 0 }, blocked: { job_rez: 1, kaatdo: 1 } });
  } finally {
    fx.cleanup();
  }
});

test("a company that fails to load (corrupt config.json) → ok:false, the only write is the run record with errors[] (design §11 row 1)", async () => {
  const fx = copyFixture();
  try {
    writeFileSync(join(fx.dir, "config.json"), "{ broken", "utf8");
    const before = treeHash(join(fx.dir, "state"));
    const out = sink();
    const r = await runPublish({ companyDir: fx.dir, now: NOW, processEnv: {}, dryRun: true, stdout: out });
    assert.equal(r.ok, false);
    assert.equal(r.changed, false);
    assert.ok(r.errors.length >= 1);
    assert.match(out.text(), /\[publisher\] error: config\.json/);
    const runs = fx.runs();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ok, false);
    assert.deepEqual(validate(runs[0], RUN_SPEC), { ok: true, errors: [] });
    assert.ok(runs[0].errors.some((e) => e.includes("config.json")));
    assert.equal(runs[0].agents[0].note, "company failed to load");
    rmSync(join(fx.dir, "state", "runs"), { recursive: true, force: true });
    assert.equal(treeHash(join(fx.dir, "state")), before, "nothing else under state/ changed");
  } finally {
    fx.cleanup();
  }
});

test("CLI: `publish --dry-run --now <iso>` runs on a temp copy (fixture byte-identical afterwards), prints the call sequence and exits 0; --now without a dry run exits 2; --page filters", async () => {
  const before = treeHash(COMPANY_DIR);
  const out = sink();
  const err = sink();
  const code = await main(["publish", "--dry-run", "--now", NOW], { stdout: out, stderr: err, processEnv: {}, companyDir: COMPANY_DIR });
  assert.equal(code, EXIT.ok, out.text() + err.text());
  assert.equal(treeHash(COMPANY_DIR), before, "the fixture company is untouched");
  assert.equal(err.lines.length, 0);
  assert.match(out.lines[0], /^publish: --dry-run works on a temp copy .*hoshlab-publish-dry-run-/);
  assert.ok(out.lines.some((l) => l.startsWith(`[ig dry-run] POST /dry-user/media image_url=https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/${KD}/`)), out.text());
  assert.ok(out.lines.some((l) => l.startsWith("[ig dry-run] POST /dry-user/media_publish creation_id=dry-")), out.text());
  assert.match(out.lines.at(-1), /^publish: dry run complete — state written under /);
  const tmp = out.lines[0].match(/temp copy (.+) \(the repo/)[1];
  assert.ok(existsSync(join(tmp, "state", "published.jsonl")));
  rmSync(join(tmp, ".."), { recursive: true, force: true });

  const e2 = sink();
  assert.equal(await main(["publish", "--now", NOW], { stdout: sink(), stderr: e2, processEnv: {}, companyDir: COMPANY_DIR }), EXIT.usage);
  assert.match(e2.text(), /--now <iso> is accepted only with --dry-run or IG_DRY_RUN=1/);
  const e3 = sink();
  assert.equal(await main(["publish", "--dry-run", "--now", "yesterday"], { stdout: sink(), stderr: e3, processEnv: {}, companyDir: COMPANY_DIR }), EXIT.usage);
  assert.match(e3.text(), /invalid ISO datetime/);

  // IG_DRY_RUN=1 without --dry-run writes to the given company dir (tests and scripts/dry-run-publish.mjs use a temp copy)
  const fx = copyFixture();
  try {
    const out4 = sink();
    assert.equal(await main(["publish", "--page", "job_rez", "--now", NOW], { stdout: out4, stderr: sink(), processEnv: { IG_DRY_RUN: "1" }, companyDir: fx.dir }), EXIT.ok);
    assert.equal(fx.published().length, 0);
    assert.equal(fx.runs().length, 1);
    assert.deepEqual(fx.runs()[0].publisher.pages, { rishtapatra: { outcome: "filtered" }, kaatdo: { outcome: "filtered" }, job_rez: { outcome: "idle" } });
    assert.ok(out4.lines.some((l) => l === "[publisher] job_rez: idle (no queued drafts)"), out4.text());
  } finally {
    fx.cleanup();
  }
  assert.equal(treeHash(COMPANY_DIR), before);
  assert.deepEqual([triggerFrom({ GITHUB_EVENT_NAME: "schedule" }), triggerFrom({ GITHUB_EVENT_NAME: "workflow_dispatch" }), triggerFrom({})], ["schedule", "dispatch", "local"]);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});
