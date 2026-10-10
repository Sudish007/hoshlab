// engine/ig/client.js + engine/ig/dry-run.js (design §9, §11; plan D5) with a fake fetch — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS } from "./helpers.js";
import { IgError, MEDIA_FETCH_CODES, PARAM_ERROR_CODES, RATE_LIMIT_CODES, TOKEN_ERROR_CODES, classifyError, createClient, parseEnvelope } from "../engine/ig/client.js";
import { DRY_ME, DRY_USER_ID, LINE_PREFIX, createDryRunClient, formatCall, isDryRun, sha8 } from "../engine/ig/dry-run.js";

const config = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
const TOKEN = "FAKE-IG-TOKEN-" + "k".repeat(48);
const IG_USER = "17841400000000001";
const BASE = `${config.ig.host}/${config.ig.version}`;
const IMG = "https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/kd-x/image-1-7cfbae6d.jpg";

// A scripted fetch: `script` is an array of responders; each gets (url, init) and returns a Response.
function scriptedFetch(script) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const i = requests.length;
    requests.push({ url: String(url), init, body: init.body ? new URLSearchParams(String(init.body)) : null });
    const responder = script[i] || script[script.length - 1];
    if (typeof responder === "function") return responder(String(url), init, i);
    if (responder instanceof Response) return responder;
    return json(responder);
  };
  fn.requests = requests;
  return fn;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const envelope = (code, message, extra = {}) => json({ error: { message, type: "OAuthException", code, fbtrace_id: "AbCdEf", ...extra } }, 400);

test("config pins a current Graph API version (plan D5): v26.0, with its changelog source and verification date", () => {
  assert.equal(config.ig.version, "v26.0");
  assert.equal(config.ig.versionSource, "https://developers.facebook.com/docs/graph-api/changelog");
  assert.match(config.ig.versionVerifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(config.ig.host, "https://graph.instagram.com");
  assert.equal(BASE, "https://graph.instagram.com/v26.0");
});

test("image sequence: POST media (image_url, caption, alt_text) → POST media_publish (creation_id) → GET /{id}?fields=permalink,timestamp; the token travels only as the access_token form field / query param", async () => {
  const fetchImpl = scriptedFetch([{ id: "17890001" }, { id: "17990002" }, { id: "17990002", permalink: "https://www.instagram.com/p/C_abc123/", timestamp: "2026-10-13T02:46:00+0000" }]);
  const client = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl, now: () => new Date("2026-10-13T08:16:00+05:30") });
  const c = await client.createImageContainer({ imageUrl: IMG, caption: "Six rules.\n\n#KaatDo", altText: "Dark console card" });
  assert.deepEqual(c, { id: "17890001" });
  const p = await client.publish(c.id);
  assert.deepEqual(p, { id: "17990002" });
  const link = await client.getPermalink(p.id);
  assert.equal(link.permalink, "https://www.instagram.com/p/C_abc123/");
  assert.equal(link.timestamp, "2026-10-13T02:46:00+0000");

  const [r1, r2, r3] = fetchImpl.requests;
  assert.equal(r1.url, `${BASE}/${IG_USER}/media`);
  assert.equal(r1.init.method, "POST");
  assert.equal(r1.init.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(r1.init.headers.authorization, undefined, "no Authorization header");
  assert.equal(r1.init.headers.Authorization, undefined, "no Authorization header");
  assert.deepEqual(Object.fromEntries(r1.body), { image_url: IMG, caption: "Six rules.\n\n#KaatDo", alt_text: "Dark console card", access_token: TOKEN });
  assert.equal(r2.url, `${BASE}/${IG_USER}/media_publish`);
  assert.deepEqual(Object.fromEntries(r2.body), { creation_id: "17890001", access_token: TOKEN });
  assert.equal(r3.init.method, "GET");
  assert.equal(r3.body, null);
  const u3 = new URL(r3.url);
  assert.equal(`${u3.origin}${u3.pathname}`, `${BASE}/17990002`);
  assert.equal(u3.searchParams.get("fields"), "permalink,timestamp");
  assert.equal(u3.searchParams.get("access_token"), TOKEN);
  for (const r of fetchImpl.requests) {
    const u = new URL(r.url);
    assert.ok(!u.pathname.includes(TOKEN), "token never in the path");
    if (r.init.method === "POST") assert.ok(!r.url.includes(TOKEN), "token never in a POST URL");
  }
  // calls[] (what the run record / logs may see) never carries the token
  assert.deepEqual(
    client.calls.map((x) => [x.method, x.path, x.fields]),
    [
      ["POST", `/${IG_USER}/media`, { image_url: IMG, caption: "Six rules.\n\n#KaatDo", alt_text: "Dark console card" }],
      ["POST", `/${IG_USER}/media_publish`, { creation_id: "17890001" }],
      ["GET", "/17990002", { fields: "permalink,timestamp" }],
    ],
  );
  assert.ok(!JSON.stringify(client.calls).includes(TOKEN));
  assert.equal(FETCH_ATTEMPTS.length, 0, "the global fetch guard was never hit");
});

test("carousel sequence: N child containers with is_carousel_item=true (image_url, alt_text) → CAROUSEL container with children + caption → media_publish", async () => {
  const fetchImpl = scriptedFetch([{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "car9" }, { id: "m77" }]);
  const client = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl });
  const children = [];
  for (let i = 1; i <= 3; i++) children.push((await client.createCarouselItem({ imageUrl: `${IMG}?s=${i}`, altText: `Slide ${i}` })).id);
  assert.deepEqual(children, ["c1", "c2", "c3"]);
  const car = await client.createCarousel({ children, caption: "Nine templates." });
  assert.equal(car.id, "car9");
  assert.equal((await client.publish(car.id)).id, "m77");
  const bodies = fetchImpl.requests.map((r) => Object.fromEntries(r.body));
  for (let i = 0; i < 3; i++) {
    assert.equal(fetchImpl.requests[i].url, `${BASE}/${IG_USER}/media`);
    assert.deepEqual(bodies[i], { image_url: `${IMG}?s=${i + 1}`, is_carousel_item: "true", alt_text: `Slide ${i + 1}`, access_token: TOKEN });
  }
  assert.equal(fetchImpl.requests[3].url, `${BASE}/${IG_USER}/media`);
  assert.deepEqual(bodies[3], { media_type: "CAROUSEL", children: "c1,c2,c3", caption: "Nine templates.", access_token: TOKEN });
  assert.equal(fetchImpl.requests[4].url, `${BASE}/${IG_USER}/media_publish`);
  assert.deepEqual(bodies[4], { creation_id: "car9", access_token: TOKEN });
  await assert.rejects(() => client.createCarousel({ children: ["only-one"], caption: "x" }), TypeError);
});

test("publishingLimit parses { data: [ { quota_usage, config: { quota_total, quota_duration } } ] }; getMe returns id, user_id and username as strings", async () => {
  const fetchImpl = scriptedFetch([{ data: [{ quota_usage: 2, config: { quota_total: 50, quota_duration: 86400 } }] }, { id: "9876543210", user_id: "17841400000000001", username: "kaatdo" }]);
  const client = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl });
  const q = await client.publishingLimit();
  assert.equal(q.quotaUsage, 2);
  assert.equal(q.quotaTotal, 50);
  assert.equal(q.quotaDuration, 86400);
  const u = new URL(fetchImpl.requests[0].url);
  assert.equal(`${u.origin}${u.pathname}`, `${BASE}/${IG_USER}/content_publishing_limit`);
  assert.equal(u.searchParams.get("fields"), "quota_usage,config");
  const me = await client.getMe();
  assert.deepEqual(me, { id: "9876543210", user_id: "17841400000000001", username: "kaatdo" });
  const u2 = new URL(fetchImpl.requests[1].url);
  assert.equal(`${u2.origin}${u2.pathname}`, `${BASE}/me`);
  assert.equal(u2.searchParams.get("fields"), "id,user_id,username");
});

test("error mapping (design §11): 190 → tokenInvalid; 9004/2207052 → retryable media fetch at stage container; 4 → rate_limit; 100 → not retryable; 10/200 → tokenInvalid; unknown → retryable once", async () => {
  assert.deepEqual([MEDIA_FETCH_CODES, PARAM_ERROR_CODES, TOKEN_ERROR_CODES, RATE_LIMIT_CODES], [[9004], [100], [190, 10, 200], [4, 17, 32, 613, 9007]]);
  const run = async (responder, call = (c) => c.createImageContainer({ imageUrl: IMG, caption: "x", altText: "y" })) => {
    const client = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl: scriptedFetch([responder]) });
    try {
      await call(client);
    } catch (err) {
      return err;
    }
    throw new Error("expected an IgError");
  };
  const e190 = await run(envelope(190, "Invalid OAuth 2.0 Access Token", { type: "IGApiException" }));
  assert.ok(e190 instanceof IgError);
  assert.equal(e190.code, 190);
  assert.equal(e190.tokenInvalid, true);
  assert.equal(e190.retryable, false);
  assert.equal(e190.kind, "token");
  assert.equal(e190.stage, "container");
  assert.equal(e190.status, 400);
  assert.equal(e190.fbtraceId, "AbCdEf");
  assert.match(e190.message, /HTTP 400 IGApiException: Invalid OAuth 2\.0 Access Token \(code 190\)/);

  const e9004 = await run(envelope(9004, "Only photo or video can be accepted as media type.", { error_subcode: 2207052, is_transient: false, error_user_title: "Media download has failed", error_user_msg: `The media could not be fetched from this URI: ${IMG}` }));
  assert.equal(e9004.code, 9004);
  assert.equal(e9004.subcode, 2207052);
  assert.equal(e9004.kind, "media_fetch");
  assert.equal(e9004.retryable, true);
  assert.equal(e9004.tokenInvalid, false);
  assert.equal(e9004.stage, "container");
  assert.match(e9004.message, /Media download has failed/);
  assert.match(e9004.message, /\(code 9004\/2207052\)/);
  // subcode alone (code missing) still reads as a media fetch failure
  assert.equal(classifyError({ code: 1, subcode: 2207052 }).kind, "media_fetch");

  const e4 = await run(envelope(4, "Application request limit reached"));
  assert.equal(e4.kind, "rate_limit");
  assert.equal(e4.stage, "rate_limit");
  assert.equal(e4.retryable, true);
  for (const code of [17, 32, 613, 9007]) assert.equal(classifyError({ code }).stage, "rate_limit", String(code));

  const e100 = await run(envelope(100, "Invalid parameter", { error_subcode: 2207009 }));
  assert.equal(e100.kind, "param");
  assert.equal(e100.retryable, false);
  assert.equal(e100.tokenInvalid, false);

  for (const code of [10, 200]) {
    const e = await run(envelope(code, "Permission denied"));
    assert.equal(e.tokenInvalid, true, String(code));
    assert.equal(e.retryable, false);
  }
  const eOther = await run(envelope(2, "An unexpected error has occurred.", { is_transient: true }));
  assert.equal(eOther.kind, "other");
  assert.equal(eOther.retryable, true);
  assert.equal(eOther.tokenInvalid, false);

  // the publish stage is recorded on the error
  const ePublish = await run(envelope(9007, "Media not ready"), (c) => c.publish("17890001"));
  assert.equal(ePublish.stage, "rate_limit");
  const ePub2 = await run(envelope(100, "bad creation id"), (c) => c.publish("17890001"));
  assert.equal(ePub2.stage, "publish");

  // HTTP 502 without an envelope and a non-JSON 200 body: code null, retryable
  const e502 = await run(() => new Response("<html>bad gateway</html>", { status: 502 }));
  assert.equal(e502.code, null);
  assert.equal(e502.kind, "network");
  assert.equal(e502.retryable, true);
  assert.match(e502.message, /HTTP 502/);
  const eHtml = await run(() => new Response("<html>ok</html>", { status: 200 }));
  assert.match(eHtml.message, /non-JSON body/);
  // a 200 without an id is an error too
  const eNoId = await run(() => json({ ok: true }));
  assert.match(eNoId.message, /carries no id/);

  // parseEnvelope tolerates digit strings and missing fields
  assert.deepEqual(parseEnvelope({ error: { code: "190", message: "m" } }), { code: 190, subcode: null, type: null, fbtraceId: null, message: "m" });
  assert.equal(parseEnvelope({ id: "1" }), null);
});

test("the token never appears in error messages: envelopes echoing the token or a URL with ?access_token= are scrubbed", async () => {
  const leaky = envelope(190, `Bad token ${TOKEN} in ${BASE}/me?fields=id&access_token=${TOKEN}`, { error_user_msg: `Token ${encodeURIComponent(TOKEN)} rejected` });
  const client = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl: scriptedFetch([leaky]) });
  await assert.rejects(
    () => client.getMe(),
    (err) => {
      assert.ok(err instanceof IgError);
      assert.ok(!err.message.includes(TOKEN), err.message);
      assert.ok(!err.message.includes(encodeURIComponent(TOKEN)));
      assert.match(err.message, /•••/);
      assert.equal(err.code, 190);
      return true;
    },
  );
  // a network failure that quotes the request URL is scrubbed as well
  const netFail = scriptedFetch([(url) => Promise.reject(new Error(`getaddrinfo ENOTFOUND for ${url}`))]);
  const c2 = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl: netFail });
  await assert.rejects(
    () => c2.getMe(),
    (err) => {
      assert.ok(err instanceof IgError);
      assert.equal(err.code, null);
      assert.equal(err.kind, "network");
      assert.equal(err.retryable, true);
      assert.ok(!err.message.includes(TOKEN), err.message);
      assert.match(err.message, /network error: getaddrinfo ENOTFOUND/);
      return true;
    },
  );
});

test("timeout: every call aborts through AbortController (default 30 s; 20 ms here) → IgError kind network, retryable, no token in the message", async () => {
  const aborting = async (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const client = createClient({ config, token: TOKEN, igUserId: IG_USER, fetchImpl: aborting, timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(
    () => client.publishingLimit(),
    (err) => {
      assert.ok(err instanceof IgError);
      assert.equal(err.kind, "network");
      assert.equal(err.retryable, true);
      assert.equal(err.tokenInvalid, false);
      assert.match(err.message, /timeout after 20 ms/);
      assert.ok(!err.message.includes(TOKEN));
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000);
  const { DEFAULT_TIMEOUT_MS } = await import("../engine/ig/client.js");
  assert.equal(DEFAULT_TIMEOUT_MS, 30000);
  assert.throws(() => createClient({ config, token: "", igUserId: IG_USER, fetchImpl: aborting }), /token is required/);
  assert.throws(() => createClient({ config, token: TOKEN, igUserId: "", fetchImpl: aborting }), /igUserId is required/);
});

test("dry-run client: same surface, deterministic dry-<sha8> ids, DRYRUN permalink, every call recorded and printed as '[ig dry-run] METHOD /path k=v'; getMe → dry ids; nothing fetched", async () => {
  const lines = [];
  const client = createDryRunClient({ igUserId: "", stdout: (s) => lines.push(s), now: () => new Date("2026-10-13T08:16:00+05:30") });
  assert.equal(client.dryRun, true);
  assert.equal(client.igUserId, DRY_USER_ID);
  const q = await client.publishingLimit();
  assert.deepEqual([q.quotaUsage, q.quotaTotal], [0, 50]);
  const c = await client.createImageContainer({ imageUrl: IMG, caption: "Six rules. One kill switch.\n\n#KaatDo", altText: "Dark console card" });
  assert.match(c.id, /^dry-[0-9a-f]{8}$/);
  const p = await client.publish(c.id);
  assert.match(p.id, /^dry-[0-9a-f]{8}$/);
  assert.notEqual(p.id, c.id);
  const link = await client.getPermalink(p.id);
  assert.match(link.permalink, /^https:\/\/www\.instagram\.com\/p\/DRYRUN[0-9a-f]{8}\/$/);
  assert.deepEqual(await client.getMe(), DRY_ME);
  assert.deepEqual(
    client.calls.map((x) => [x.method, x.path]),
    [
      ["GET", "/dry-user/content_publishing_limit"],
      ["POST", "/dry-user/media"],
      ["POST", "/dry-user/media_publish"],
      ["GET", `/${p.id}`],
      ["GET", "/me"],
    ],
  );
  assert.deepEqual(client.calls[1].fields, { image_url: IMG, caption: "Six rules. One kill switch.\n\n#KaatDo", alt_text: "Dark console card" });
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => l.startsWith(`${LINE_PREFIX} `)), lines.join("\n"));
  assert.equal(lines[1].slice(0, `[ig dry-run] POST /dry-user/media image_url=${IMG}`.length), `[ig dry-run] POST /dry-user/media image_url=${IMG}`);
  assert.match(lines[1], / caption="Six rules\. One kill switch\./);
  assert.match(lines[2], /^\[ig dry-run\] POST \/dry-user\/media_publish creation_id=dry-[0-9a-f]{8}$/);

  // determinism: the same inputs → the same ids and permalink
  const again = createDryRunClient({ igUserId: "", stdout: null });
  const c2 = await again.createImageContainer({ imageUrl: IMG, caption: "Six rules. One kill switch.\n\n#KaatDo", altText: "Dark console card" });
  assert.equal(c2.id, c.id);
  assert.equal((await again.publish(c2.id)).id, p.id);
  assert.equal((await again.getPermalink(p.id)).permalink, link.permalink);
  const other = await again.createImageContainer({ imageUrl: IMG, caption: "different", altText: "Dark console card" });
  assert.notEqual(other.id, c.id);
  assert.equal(sha8("a"), sha8("a"));

  // carousel surface + preflight stand-in
  const car = createDryRunClient({ igUserId: "17841400000000001", stdout: null });
  const kids = [];
  for (let i = 1; i <= 2; i++) kids.push((await car.createCarouselItem({ imageUrl: `${IMG}?s=${i}`, altText: `Slide ${i}` })).id);
  const cc = await car.createCarousel({ children: kids, caption: "Nine templates." });
  assert.deepEqual(car.calls[0].fields, { image_url: `${IMG}?s=1`, is_carousel_item: "true", alt_text: "Slide 1" });
  assert.deepEqual(car.calls[2].fields, { media_type: "CAROUSEL", children: kids.join(","), caption: "Nine templates." });
  assert.match(cc.id, /^dry-/);
  const pre = await car.preflight([{ rawUrl: IMG, pagesUrl: "https://sudish007.github.io/hoshlab/media/kd-x/image-1-7cfbae6d.jpg" }], { prefer: "pages" });
  assert.deepEqual(pre, { urls: ["https://sudish007.github.io/hoshlab/media/kd-x/image-1-7cfbae6d.jpg"], used: "pages" });
  assert.equal(car.calls[3].method, "HEAD");
  assert.equal(formatCall({ method: "GET", path: "/me", fields: { fields: "id,user_id,username" } }), "[ig dry-run] GET /me fields=id,user_id,username");

  assert.equal(isDryRun({ IG_DRY_RUN: "1" }, {}), true);
  assert.equal(isDryRun({}, { "dry-run": true }), true);
  assert.equal(isDryRun({ IG_DRY_RUN: "0" }, {}), false);
  assert.equal(isDryRun({}, {}), false);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});
