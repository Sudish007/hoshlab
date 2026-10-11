// Publisher reel path (design §9 column "Reel", §11 row "IG video status"; P2-03; FEAT-202) with a fake client,
// a fake clock and a recorded sleep: container → status poll → publish; IN_PROGRESS past pollMaxMs → attempt
// stage status / reason timeout and no publish; ERROR / EXPIRED → stage status; preflight of the MP4 (video/mp4)
// and the poster (image/jpeg) with the Pages fallback. No browser, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { createState } from "../engine/lib/state.js";
import { DRAFT_SPEC, PUBLISHED_SPEC, PUBLISH_ATTEMPT_SPEC, STATUS_REASONS, assertShape, validate } from "../engine/lib/schema.js";
import { fullCaption } from "../engine/lib/checks.js";
import { pagesUrl, rawUrl } from "../engine/lib/media.js";
import { IgError, CONTAINER_STATUS_CODES } from "../engine/ig/client.js";
import { createDryRunClient } from "../engine/ig/dry-run.js";
import { ContainerStatusError, publishDraft, waitForContainer } from "../engine/agents/publisher.js";
import { PAGE_OUTCOMES } from "../engine/commands/publish.js";

const config = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
const FIX = join(ROOT, "tests", "fixtures", "drafts");
const NOW = "2026-10-18T12:00:00+05:30"; // the kd reel slot (Sun 18 Oct 11:00) is due
const RUN_ID = "publisher-hourly-20261018-1200-ab12cd";
const PAGE = { ...config.pages.find((p) => p.handle === "kaatdo"), igUserId: "17841400000000001", mode: "autopilot" };
const SHA = "a".repeat(64);
const SHA_P = "b".repeat(64);

// The rendered reel: the fixture draft plus the two media rows the Designer writes (FEAT-201 findings (1)).
function reelDraft() {
  const d = JSON.parse(readFileSync(join(FIX, "kd-reel-2026-10-18-six-rules.json"), "utf8"));
  const video = `media/${d.id}/reel-${SHA.slice(0, 8)}.mp4`;
  const poster = `media/${d.id}/poster-${SHA_P.slice(0, 8)}.jpg`;
  return {
    ...d,
    status: "queued",
    revision: 1,
    media: [
      { kind: "video", path: video, bytes: 8_400_000, width: 1080, height: 1920, sha256: SHA, rawUrl: rawUrl(config, video), pagesUrl: pagesUrl(config, video), durationSec: 16, probe: { ok: true, codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", frameRate: "30/1", durationSec: 16, bytes: 8_400_000, faststart: true } },
      { kind: "poster", path: poster, bytes: 140_000, width: 1080, height: 1920, sha256: SHA_P, rawUrl: rawUrl(config, poster), pagesUrl: pagesUrl(config, poster) },
    ],
    publishAttempts: [],
  };
}

// A fake clock the fake sleep advances: no real waiting, exact elapsed times.
function fakeTime(start = 1_000_000) {
  let t = start;
  const slept = [];
  return {
    clock: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms) => (t += ms),
  };
}

// fakeClient({ statuses: ['IN_PROGRESS', 'FINISHED'], fail, preflight }) — `statuses` is answered in order
// (the last one repeats); without `preflight` the publisher's own HEAD preflight runs against fetchImpl.
function fakeClient({ statuses = ["IN_PROGRESS", "FINISHED"], fail = {}, preflight = true, dryRun = false } = {}) {
  const calls = [];
  let n = 0;
  let polls = 0;
  const client = {
    calls,
    dryRun,
    async publishingLimit() {
      calls.push(["publishingLimit"]);
      return { quotaUsage: 1, quotaTotal: 50, quotaDuration: 86400 };
    },
    async createReelContainer(args) {
      calls.push(["createReelContainer", args]);
      if (fail.createReelContainer) throw fail.createReelContainer;
      return { id: `reel-${++n}` };
    },
    async containerStatus(id) {
      calls.push(["containerStatus", id]);
      if (fail.containerStatus) throw fail.containerStatus;
      const code = statuses[Math.min(polls, statuses.length - 1)];
      polls++;
      return { statusCode: code, status: code === "ERROR" ? "Error: Media upload has failed with error code 2207026" : code === "FINISHED" ? "Finished" : "In progress", raw: { status_code: code } };
    },
    async createImageContainer() {
      throw new Error("a reel must never become an image container");
    },
    async publish(id) {
      calls.push(["publish", id]);
      if (fail.publish) throw fail.publish;
      return { id: `media-${++n}` };
    },
    async getPermalink(id) {
      calls.push(["getPermalink", id]);
      return { permalink: "https://www.instagram.com/reel/C_reel1/", timestamp: "2026-10-18T06:30:05+0000" };
    },
  };
  if (preflight) {
    client.preflight = async (media, opts) => {
      calls.push(["preflight", media.map((m) => m.kind), opts.prefer]);
      return { urls: media.map((m) => m.rawUrl), used: "raw" };
    };
  }
  return client;
}

function harness(draft) {
  const dir = tmpDir("hoshlab-publisher-reel-");
  const state = createState({ companyDir: dir, now: NOW });
  state.writeDraft(draft);
  return { dir, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// HEAD fetch table: url → { status, type } | Error
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

test("config: ig.pollIntervalMs / pollMaxMs are the design's 5 s / 300 s; the status enums exist; reel_not_built is gone from the page outcomes", () => {
  assert.equal(config.ig.pollIntervalMs, 5000);
  assert.equal(config.ig.pollMaxMs, 300000);
  assert.deepEqual(CONTAINER_STATUS_CODES, ["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"]);
  assert.deepEqual(STATUS_REASONS, ["timeout", "error", "expired"]);
  assert.ok(!PAGE_OUTCOMES.includes("reel_not_built"), PAGE_OUTCOMES.join());
  assertShape({ at: NOW, ok: false, stage: "status", reason: "timeout", message: "x" }, PUBLISH_ATTEMPT_SPEC);
  assert.throws(() => assertShape({ at: NOW, ok: false, stage: "status", reason: "slow" }, PUBLISH_ATTEMPT_SPEC), /reason/);
});

test("FINISHED after 2 polls → REELS container (video_url, cover_url = poster, share_to_feed, fullCaption) → one sleep of pollIntervalMs → publish → permalink; published.jsonl format reel; draft published", async () => {
  const draft = reelDraft();
  const h = harness(draft);
  const client = fakeClient({ statuses: ["IN_PROGRESS", "FINISHED"] });
  const time = fakeTime();
  const logs = [];
  try {
    const r = await publishDraft({ draft, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, log: (s) => logs.push(s), sleep: time.sleep, clock: time.clock });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      client.calls.map((c) => c[0]),
      ["publishingLimit", "preflight", "createReelContainer", "containerStatus", "containerStatus", "publish", "getPermalink"],
    );
    assert.deepEqual(client.calls[1][1], ["video", "poster"], "both rows are preflighted");
    assert.deepEqual(client.calls[2][1], { videoUrl: draft.media[0].rawUrl, caption: fullCaption(draft), coverUrl: draft.media[1].rawUrl, shareToFeed: true });
    assert.equal(client.calls[3][1], "reel-1");
    assert.equal(client.calls[5][1], "reel-1", "media_publish names the container");
    assert.deepEqual(time.slept, [config.ig.pollIntervalMs], "one wait between the two polls, none before the first");
    const rows = h.state.readJsonl("state/published.jsonl");
    assert.equal(rows.length, 1);
    assert.deepEqual(validate(rows[0], PUBLISHED_SPEC), { ok: true, errors: [] });
    assert.equal(rows[0].format, "reel");
    assert.equal(rows[0].igMediaId, "media-2");
    assert.equal(rows[0].permalink, "https://www.instagram.com/reel/C_reel1/");
    assert.equal(rows[0].mediaUrlUsed, "raw");
    assert.equal(rows[0].mode, "autopilot");
    const saved = h.state.readDraft(draft.id);
    assert.equal(saved.status, "published");
    assert.deepEqual(saved.publishAttempts, [{ at: NOW, ok: true, stage: "publish", mediaUrlUsed: "raw", runId: RUN_ID }]);
    assert.deepEqual(validate(saved, DRAFT_SPEC), { ok: true, errors: [] });
    assert.ok(logs.some((l) => l.includes("reel container reel-1 FINISHED after 2 polls")), logs.join("\n"));
    assert.ok(logs.some((l) => l.includes("published → media-2")), logs.join("\n"));
  } finally {
    h.cleanup();
  }
});

test("IN_PROGRESS beyond pollMaxMs (fake clock): polls every pollIntervalMs until the limit, then attempt { stage status, reason timeout }, no publish, draft stays queued, retry next hour", async () => {
  const draft = reelDraft();
  const h = harness(draft);
  const client = fakeClient({ statuses: ["IN_PROGRESS"] });
  const time = fakeTime();
  const logs = [];
  try {
    const r = await publishDraft({ draft, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, log: (s) => logs.push(s), sleep: time.sleep, clock: time.clock });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "status");
    assert.equal(r.reason, "timeout");
    assert.equal(r.retryable, true);
    assert.equal(r.failed, false);
    assert.equal(r.tokenInvalid, false);
    assert.equal(r.code, null);
    const names = client.calls.map((c) => c[0]);
    assert.ok(!names.includes("publish"), "never published");
    const polls = names.filter((x) => x === "containerStatus").length;
    // 60 sleeps of 5 s reach 300 s; the 61st poll sees elapsed >= pollMaxMs and gives up
    assert.equal(polls, config.ig.pollMaxMs / config.ig.pollIntervalMs + 1);
    assert.equal(time.slept.length, polls - 1);
    assert.ok(time.slept.every((ms) => ms === config.ig.pollIntervalMs));
    const saved = h.state.readDraft(draft.id);
    assert.equal(saved.status, "queued", "one failed attempt out of three keeps it queued");
    assert.equal(saved.publishAttempts.length, 1);
    const a = saved.publishAttempts[0];
    assertShape(a, PUBLISH_ATTEMPT_SPEC);
    assert.deepEqual([a.ok, a.stage, a.reason, a.mediaUrlUsed, a.runId], [false, "status", "timeout", "raw", RUN_ID]);
    assert.equal(a.code, undefined, "a timeout has no Graph error code");
    assert.match(a.message, /still IN_PROGRESS after 300 s and 61 polls/);
    assert.match(a.message, /new container is created next hour/);
    assert.deepEqual(validate(saved, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(h.state.readJsonl("state/published.jsonl").length, 0);
    assert.deepEqual(r.flags, []);
    assert.ok(logs.some((l) => /status failed \(reason timeout\) → retry next hour/.test(l)), logs.join("\n"));
  } finally {
    h.cleanup();
  }
});

test("ERROR → stage status / reason error with the status text; EXPIRED → reason expired; the third failure makes the draft failed with the publish_failed flag", async () => {
  const base = reelDraft();
  let h = harness(base);
  try {
    const client = fakeClient({ statuses: ["IN_PROGRESS", "ERROR"] });
    const time = fakeTime();
    const r = await publishDraft({ draft: base, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, sleep: time.sleep, clock: time.clock });
    assert.equal(r.ok, false);
    assert.deepEqual([r.stage, r.reason, r.retryable, r.failed], ["status", "error", true, false]);
    assert.match(r.message, /status_code ERROR — Error: Media upload has failed with error code 2207026/);
    assert.equal(client.calls.filter((c) => c[0] === "containerStatus").length, 2);
    assert.ok(!client.calls.some((c) => c[0] === "publish"));
    assert.deepEqual(time.slept, [config.ig.pollIntervalMs]);
    const saved = h.state.readDraft(base.id);
    assert.equal(saved.status, "queued");
    assert.equal(saved.publishAttempts[0].reason, "error");
  } finally {
    h.cleanup();
  }

  h = harness(base);
  try {
    const client = fakeClient({ statuses: ["EXPIRED"] });
    const time = fakeTime();
    const r = await publishDraft({ draft: base, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, sleep: time.sleep, clock: time.clock });
    assert.deepEqual([r.ok, r.stage, r.reason], [false, "status", "expired"]);
    assert.deepEqual(time.slept, [], "EXPIRED on the first poll: no wait");
    assert.equal(h.state.readDraft(base.id).publishAttempts[0].reason, "expired");
  } finally {
    h.cleanup();
  }

  // two earlier failed attempts + this timeout = maxPublishAttempts → failed + flag (design §11 "maxPublishAttempts reached")
  const twice = { ...base, publishAttempts: [1, 2].map((i) => ({ at: `2026-10-18T1${i}:00:00+05:30`, ok: false, stage: "status", reason: "timeout", message: "x", mediaUrlUsed: "raw" })) };
  h = harness(twice);
  try {
    const time = fakeTime();
    const r = await publishDraft({ draft: twice, page: PAGE, client: fakeClient({ statuses: ["IN_PROGRESS"] }), state: h.state, config, now: NOW, runId: RUN_ID, sleep: time.sleep, clock: time.clock });
    assert.equal(r.failed, true);
    assert.deepEqual(r.flags, [`publish_failed:${base.id}`]);
    assert.equal(h.state.readDraft(base.id).status, "failed");
    assert.equal(h.state.readDraft(base.id).publishAttempts.length, 3);
  } finally {
    h.cleanup();
  }
});

test("IgError paths around the poll: a 190 on the status GET pauses the page (tokenInvalid, draft queued); a 100 on the REELS container is not retryable → failed", async () => {
  const base = reelDraft();
  let h = harness(base);
  try {
    const time = fakeTime();
    const client = fakeClient({ fail: { containerStatus: new IgError({ code: 190, message: "Invalid OAuth 2.0 Access Token", stage: "status", status: 400 }) } });
    const r = await publishDraft({ draft: base, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, sleep: time.sleep, clock: time.clock });
    assert.deepEqual([r.ok, r.stage, r.code, r.tokenInvalid, r.failed], [false, "status", 190, true, false]);
    assert.equal(h.state.readDraft(base.id).status, "queued");
    assert.equal(h.state.readDraft(base.id).publishAttempts[0].reason, undefined);
  } finally {
    h.cleanup();
  }
  h = harness(base);
  try {
    const time = fakeTime();
    const client = fakeClient({ fail: { createReelContainer: new IgError({ code: 100, message: "Invalid parameter", stage: "container", status: 400 }) } });
    const r = await publishDraft({ draft: base, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, sleep: time.sleep, clock: time.clock });
    assert.deepEqual([r.ok, r.stage, r.code, r.failed], [false, "container", 100, true]);
    assert.ok(!client.calls.some((c) => c[0] === "containerStatus"), "no poll without a container");
  } finally {
    h.cleanup();
  }
});

test("preflight for a reel: HEAD rawUrl must be 200 video/mp4 for the MP4 and 200 image/jpeg for the poster; a wrong type on raw falls back to the Pages URL (mediaUrlUsed pages); neither → stage preflight", async () => {
  const draft = reelDraft();
  const [video, poster] = draft.media;

  // raw serves the MP4 as application/octet-stream → Pages copy; poster fine on raw → `used` is pages
  let h = harness(draft);
  try {
    const fetchImpl = headFetch({ [video.rawUrl]: { status: 200, type: "application/octet-stream" }, [video.pagesUrl]: { status: 200, type: "video/mp4" }, [poster.rawUrl]: { status: 200, type: "image/jpeg" } });
    const client = fakeClient({ preflight: false });
    const time = fakeTime();
    const r = await publishDraft({ draft, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, fetchImpl, sleep: time.sleep, clock: time.clock });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.mediaUrlUsed, "pages");
    assert.deepEqual(fetchImpl.calls.map((c) => [c.method, c.url]), [["HEAD", video.rawUrl], ["HEAD", video.pagesUrl], ["HEAD", poster.rawUrl]]);
    const container = client.calls.find((c) => c[0] === "createReelContainer")[1];
    assert.equal(container.videoUrl, video.pagesUrl, "the container gets the URL that passed");
    assert.equal(container.coverUrl, poster.rawUrl);
    assert.equal(h.state.readJsonl("state/published.jsonl")[0].mediaUrlUsed, "pages");
  } finally {
    h.cleanup();
  }

  // both hosts wrong for the MP4 → stage preflight, no container, draft waits
  h = harness(draft);
  try {
    const fetchImpl = headFetch({ [video.rawUrl]: { status: 200, type: "text/plain" }, [video.pagesUrl]: { status: 404, type: "text/html" }, [poster.rawUrl]: { status: 200, type: "image/jpeg" } });
    const client = fakeClient({ preflight: false });
    const r = await publishDraft({ draft, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, fetchImpl });
    assert.deepEqual([r.ok, r.stage, r.retryable], [false, "preflight", true]);
    assert.ok(!client.calls.some((c) => c[0] === "createReelContainer"));
    const a = h.state.readDraft(draft.id).publishAttempts[0];
    assert.equal(a.stage, "preflight");
    assert.match(a.message, /none answered 200 with the expected Content-Type/);
  } finally {
    h.cleanup();
  }

  // the poster is checked as image/jpeg too: an MP4 served fine but a missing poster still fails preflight
  h = harness(draft);
  try {
    const fetchImpl = headFetch({ [video.rawUrl]: { status: 200, type: "video/mp4" }, [poster.rawUrl]: { status: 404, type: "text/plain" }, [poster.pagesUrl]: { status: 404, type: "text/plain" } });
    const r = await publishDraft({ draft, page: PAGE, client: fakeClient({ preflight: false }), state: h.state, config, now: NOW, runId: RUN_ID, fetchImpl });
    assert.equal(r.stage, "preflight");
  } finally {
    h.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0, "the global fetch guard was never hit");
});

test("waitForContainer: PUBLISHED counts as finished; a null status_code keeps polling until the limit; ContainerStatusError carries stage status, reason and retryable", async () => {
  const time = fakeTime();
  const finished = fakeClient({ statuses: ["PUBLISHED"] });
  assert.deepEqual(await waitForContainer({ client: finished, containerId: "c1", config, sleep: time.sleep, clock: time.clock }), { statusCode: "PUBLISHED", polls: 1, elapsedMs: 0 });
  const odd = { async containerStatus() { return { statusCode: null, status: null, raw: {} }; } };
  const t2 = fakeTime();
  await assert.rejects(
    () => waitForContainer({ client: odd, containerId: "c2", config, sleep: t2.sleep, clock: t2.clock }),
    (err) => {
      assert.ok(err instanceof ContainerStatusError);
      assert.deepEqual([err.stage, err.reason, err.retryable, err.tokenInvalid, err.statusCode], ["status", "timeout", true, false, null]);
      assert.match(err.message, /reel container c2: still IN_PROGRESS after 300 s/);
      return true;
    },
  );
  assert.equal(t2.slept.length, config.ig.pollMaxMs / config.ig.pollIntervalMs);
  await assert.rejects(() => waitForContainer({ client: odd, containerId: "", config }), TypeError);
});

test("dry-run client: a reel publishes end to end without sleeping (IN_PROGRESS then FINISHED, interval 0), the REELS fields are recorded, DRYRUN permalink, dryRun:true record", async () => {
  const draft = reelDraft();
  const h = harness(draft);
  const lines = [];
  const client = createDryRunClient({ igUserId: PAGE.igUserId, stdout: (s) => lines.push(s), now: () => new Date(NOW) });
  const time = fakeTime();
  try {
    const r = await publishDraft({ draft, page: PAGE, client, state: h.state, config, now: NOW, runId: RUN_ID, sleep: time.sleep, clock: time.clock });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(time.slept, [0], "a dry-run client is polled without waiting");
    const reel = client.calls.find((c) => c.method === "POST" && c.fields.media_type === "REELS");
    assert.deepEqual(reel.fields, { media_type: "REELS", video_url: draft.media[0].rawUrl, caption: fullCaption(draft), cover_url: draft.media[1].rawUrl, share_to_feed: "true" });
    const statusPolls = client.calls.filter((c) => c.method === "GET" && c.fields.fields === "status_code,status");
    assert.equal(statusPolls.length, 2);
    assert.ok(lines.some((l) => /^\[ig dry-run\] POST \/17841400000000001\/media media_type=REELS video_url=/.test(l)), lines.join("\n"));
    const row = h.state.readJsonl("state/published.jsonl")[0];
    assert.equal(row.dryRun, true);
    assert.equal(row.format, "reel");
    assert.match(row.permalink, /^https:\/\/www\.instagram\.com\/p\/DRYRUN[0-9a-f]{8}\/$/);
    assert.match(row.igMediaId, /^dry-[0-9a-f]{8}$/);
  } finally {
    h.cleanup();
  }
});
