// engine/commands/refresh-tokens.js (design §3.4, §4.12, §11 row "Token refresh"; P2-09; FEAT-202) on a temp copy
// of the populated fixture with a fake fetch and a fake `gh` spawner: the new token appears ONLY on gh's stdin —
// never in argv, a log line, tokens.json, status.json or the run record; < 20 days triggers, > 20 days skips,
// < 7 days flags token_expiring; 190 → invalid; no PAT → no refresh; dry run → no call, no write. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, tmpDir, walk } from "./helpers.js";
import { EXIT, main } from "../engine/index.js";
import { createState } from "../engine/lib/state.js";
import { RUN_SPEC, STATUS_SPEC, TOKENS_SPEC, validate } from "../engine/lib/schema.js";
import { EXPIRING_DAYS, EXPIRY_UNKNOWN, OUTCOMES, PAT_NAME, REFRESH_WHEN_DAYS_LEFT, WORKFLOW, daysLeft, isExpiring, needsRefresh, runRefreshTokens, storeSecret, wholeDaysLeft } from "../engine/commands/refresh-tokens.js";

const NOW = "2026-10-19T07:30:00+05:30"; // a Monday 02:00 UTC
const RUN_ID = "token-refresh-20261019-0730-aa11bb";
const PAT = "github_pat_FAKE_" + "p".repeat(70);
const TOKENS = { IG_TOKEN_RISHTAPATRA: "FAKE-IG-RP-" + "r".repeat(60), IG_TOKEN_KAATDO: "FAKE-IG-KD-" + "k".repeat(60), IG_TOKEN_JOB_REZ: "FAKE-IG-JR-" + "j".repeat(60) };
const NEW = { rishtapatra: "IGQVJ-NEW-RP-" + "R".repeat(70), kaatdo: "IGQVJ-NEW-KD-" + "K".repeat(70), job_rez: "IGQVJ-NEW-JR-" + "J".repeat(70) };
const SECRET_VALUES = [PAT, ...Object.values(TOKENS), ...Object.values(NEW)];
const ENV = { ...TOKENS, [PAT_NAME]: PAT };
const EXPIRES_IN = 5184000; // 60 days
const iso = (daysFromNow) => new Date(Date.parse(NOW) + daysFromNow * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

// A temp copy of the populated fixture, optionally with status pages / tokens.json seeded.
function copyFixture({ tokenStates = {}, tokens = null } = {}) {
  const base = tmpDir("hoshlab-refresh-tokens-");
  const dir = join(base, "company");
  cpSync(COMPANY_DIR, dir, { recursive: true });
  const statusPath = join(dir, "state", "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  for (const [h, s] of Object.entries(tokenStates)) status.pages[h] = { ...status.pages[h], ...s };
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n", "utf8");
  if (tokens) writeFileSync(join(dir, "state", "tokens.json"), JSON.stringify(tokens, null, 2) + "\n", "utf8");
  const state = createState({ companyDir: dir, now: NOW });
  return {
    dir,
    state,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    status: () => JSON.parse(readFileSync(statusPath, "utf8")),
    tokens: () => (existsSync(join(dir, "state", "tokens.json")) ? JSON.parse(readFileSync(join(dir, "state", "tokens.json"), "utf8")) : null),
    runs: () => state.readJsonl("state/runs/2026-10.jsonl"),
    // every byte written under the company dir
    text: () => walk(dir).map((p) => readFileSync(p, "utf8")).join("\n"),
  };
}

// A fetch that answers per page token: /me → username; /refresh_access_token → the new token (or the scripted failure).
function fakeFetch({ fail = {}, me = true } = {}) {
  const requests = [];
  const byToken = Object.fromEntries(Object.entries(TOKENS).map(([name, value]) => [value, name.replace("IG_TOKEN_", "").toLowerCase()]));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    const token = u.searchParams.get("access_token");
    const handle = byToken[token];
    requests.push({ url: `${u.origin}${u.pathname}`, params: Object.fromEntries(u.searchParams), method: init.method, handle });
    if (!handle) return json({ error: { message: "Invalid OAuth 2.0 Access Token", type: "OAuthException", code: 190 } }, 400);
    if (u.pathname === "/v26.0/me") {
      if (!me) return json({ error: { message: "unavailable", code: 2 } }, 500);
      return json({ id: "9876", user_id: "17841400000000001", username: handle });
    }
    if (u.pathname === "/refresh_access_token") {
      const f = fail[handle];
      if (f === 190) return json({ error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 } }, 400);
      if (f === 500) return new Response("<html>bad gateway</html>", { status: 502 });
      if (f === "young") return json({ error: { message: "The access token could not be refreshed (less than 24 hours old)", type: "OAuthException", code: 100 } }, 400);
      return json({ access_token: NEW[handle], token_type: "bearer", expires_in: EXPIRES_IN });
    }
    throw new Error(`unexpected url ${u.pathname}`);
  };
  fn.requests = requests;
  return fn;
}

// A fake `gh` spawner recording every call (args, stdin, env) and answering `status`.
function fakeGh({ status = 0, stderr = "" } = {}) {
  const calls = [];
  const fn = (cmd, args, { input, env } = {}) => {
    calls.push({ cmd, args: [...args], input, env: { ...env } });
    return { status, stdout: status === 0 ? "✓ Set Actions secret\n" : "", stderr };
  };
  fn.calls = calls;
  return fn;
}

const ok = (fx) => ({ rishtapatra: { tokenState: "ok" }, kaatdo: { tokenState: "ok" }, job_rez: { tokenState: "ok" } });

test("constants and pure helpers: 20-day refresh threshold, 7-day flag, days left (null when unknown)", () => {
  assert.equal(REFRESH_WHEN_DAYS_LEFT, 20);
  assert.equal(EXPIRING_DAYS, 7);
  assert.equal(WORKFLOW, "token-refresh");
  assert.equal(PAT_NAME, "HOSHLAB_SECRETS_PAT");
  assert.equal(EXPIRY_UNKNOWN, "expiry not known yet");
  assert.equal(daysLeft(null, NOW), null);
  assert.equal(daysLeft(iso(12.5), NOW), 12.5);
  assert.equal(wholeDaysLeft(iso(12.5), NOW), 12);
  assert.equal(wholeDaysLeft(iso(-0.5), NOW), -1);
  assert.equal(needsRefresh(null, NOW), true, "unknown expiry → refresh");
  assert.equal(needsRefresh(iso(19.9), NOW), true);
  assert.equal(needsRefresh(iso(20), NOW), false, "exactly 20 days is not < 20");
  assert.equal(needsRefresh(iso(45), NOW), false);
  assert.equal(isExpiring(iso(6.9), NOW), true);
  assert.equal(isExpiring(iso(7), NOW), false);
  assert.equal(isExpiring(null, NOW), false, "an unknown expiry raises no flag");
  for (const o of ["refreshed", "fresh", "would_refresh", "pat_not_configured", "refresh_failed", "store_failed", "token_invalid", "not_configured", "filtered"]) assert.ok(OUTCOMES.includes(o), o);
});

test("storeSecret: gh secret set <NAME> --repo owner/name with the VALUE ON STDIN and GH_TOKEN = the PAT in the child's env only; failures are reported scrubbed; bad inputs throw", () => {
  const gh = fakeGh();
  const r = storeSecret({ name: "IG_TOKEN_KAATDO", value: NEW.kaatdo, repo: "Sudish007/hoshlab", pat: PAT, processEnv: { PATH: "x" }, run: gh });
  assert.deepEqual(r, { ok: true, detail: "gh secret set IG_TOKEN_KAATDO --repo Sudish007/hoshlab ok" });
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].cmd, "gh");
  assert.deepEqual(gh.calls[0].args, ["secret", "set", "IG_TOKEN_KAATDO", "--repo", "Sudish007/hoshlab"]);
  assert.ok(!gh.calls[0].args.some((a) => a.includes(NEW.kaatdo) || a.includes(PAT)), "neither secret in argv");
  assert.ok(!gh.calls[0].args.includes("--body"), "never --body");
  assert.equal(gh.calls[0].input, NEW.kaatdo, "the value travels on stdin");
  assert.equal(gh.calls[0].env.GH_TOKEN, PAT);
  assert.equal(gh.calls[0].env.PATH, "x", "the rest of the environment is passed through");
  const bad = storeSecret({ name: "IG_TOKEN_KAATDO", value: NEW.kaatdo, repo: "Sudish007/hoshlab", pat: PAT, run: fakeGh({ status: 1, stderr: `HTTP 403: Resource not accessible by personal access token ${PAT} ${NEW.kaatdo}` }) });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /^gh secret set IG_TOKEN_KAATDO --repo Sudish007\/hoshlab failed \(exit 1\): HTTP 403/);
  assert.ok(!bad.detail.includes(PAT) && !bad.detail.includes(NEW.kaatdo), bad.detail);
  const spawnFail = storeSecret({ name: "IG_TOKEN_KAATDO", value: NEW.kaatdo, repo: "Sudish007/hoshlab", pat: PAT, run: () => ({ status: null, stdout: "", stderr: "Error: spawn gh ENOENT" }) });
  assert.match(spawnFail.detail, /failed \(exit spawn\): Error: spawn gh ENOENT/);
  assert.throws(() => storeSecret({ name: "lower", value: "v", repo: "a/b", pat: PAT, run: gh }), /bad secret name/);
  assert.throws(() => storeSecret({ name: "IG_TOKEN_KAATDO", value: "", repo: "a/b", pat: PAT, run: gh }), /value is required/);
  assert.throws(() => storeSecret({ name: "IG_TOKEN_KAATDO", value: "v", repo: "nope", pat: PAT, run: gh }), /owner\/name/);
  assert.throws(() => storeSecret({ name: "IG_TOKEN_KAATDO", value: "v", repo: "a/b", pat: "", run: gh }), /PAT is required/);
});

test("first run (no tokens.json, every expiry unknown): /me for the username, refresh_access_token, gh secret set per page on stdin; tokens.json written without secret material (expiresAt = now + expires_in, refreshedAt, username, state ok); status mirrors tokenExpiresAt; run record validates; changed", async () => {
  const fx = copyFixture({ tokenStates: ok() });
  const fetchImpl = fakeFetch();
  const gh = fakeGh();
  const out = sink();
  try {
    const r = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: ENV, fetchImpl, ghRun: gh, stdout: out, runId: RUN_ID });
    assert.equal(r.ok, true, out.text());
    assert.equal(r.changed, true);
    assert.deepEqual(Object.fromEntries(Object.entries(r.pages).map(([h, p]) => [h, p.outcome])), { rishtapatra: "refreshed", kaatdo: "refreshed", job_rez: "refreshed" });
    // calls: /me then /refresh_access_token per page, the OLD token on each
    assert.deepEqual(fetchImpl.requests.map((q) => [q.handle, q.url.replace("https://graph.instagram.com", "")]), [
      ["rishtapatra", "/v26.0/me"],
      ["rishtapatra", "/refresh_access_token"],
      ["kaatdo", "/v26.0/me"],
      ["kaatdo", "/refresh_access_token"],
      ["job_rez", "/v26.0/me"],
      ["job_rez", "/refresh_access_token"],
    ]);
    assert.ok(fetchImpl.requests.filter((q) => q.url.endsWith("/refresh_access_token")).every((q) => q.params.grant_type === "ig_refresh_token"));
    // gh: one call per page, the new token only on stdin, GH_TOKEN = PAT
    assert.equal(gh.calls.length, 3);
    assert.deepEqual(gh.calls.map((c) => c.args), [
      ["secret", "set", "IG_TOKEN_RISHTAPATRA", "--repo", "Sudish007/hoshlab"],
      ["secret", "set", "IG_TOKEN_KAATDO", "--repo", "Sudish007/hoshlab"],
      ["secret", "set", "IG_TOKEN_JOB_REZ", "--repo", "Sudish007/hoshlab"],
    ]);
    assert.deepEqual(gh.calls.map((c) => c.input), [NEW.rishtapatra, NEW.kaatdo, NEW.job_rez]);
    for (const c of gh.calls) {
      assert.equal(c.env.GH_TOKEN, PAT);
      for (const v of SECRET_VALUES) assert.ok(!c.args.some((a) => a.includes(v)), "argv carries no secret");
    }
    // tokens.json: metadata only
    const tokens = fx.tokens();
    assert.deepEqual(validate(tokens, TOKENS_SPEC), { ok: true, errors: [] });
    const expected = new Date(Date.parse(NOW) + EXPIRES_IN * 1000);
    for (const h of ["rishtapatra", "kaatdo", "job_rez"]) {
      const e = tokens.pages[h];
      assert.equal(e.state, "ok", h);
      assert.equal(e.refreshedAt, NOW);
      assert.equal(Date.parse(e.expiresAt), expected.getTime(), `${h} expiresAt = now + expires_in`);
      assert.match(e.expiresAt, /\+05:30$/, "IST offset");
      assert.equal(e.username, h);
      assert.deepEqual(Object.keys(e).sort(), ["expiresAt", "refreshedAt", "state", "username"]);
    }
    assert.equal(tokens.updatedAt.slice(0, 16), NOW.slice(0, 16));
    // status.json mirrors it; no flags
    const status = fx.status();
    assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
    for (const h of Object.keys(NEW)) {
      assert.equal(status.pages[h].tokenState, "ok");
      assert.equal(Date.parse(status.pages[h].tokenExpiresAt), expected.getTime());
    }
    assert.deepEqual(status.flags, []);
    assert.equal(status.lastRun.workflow, WORKFLOW);
    assert.equal(status.lastRuns[0].id, RUN_ID);
    // run record
    const runs = fx.runs();
    const run = runs.at(-1);
    assert.deepEqual(validate(run, RUN_SPEC), { ok: true, errors: [] });
    assert.deepEqual([run.id, run.workflow, run.trigger, run.ok], [RUN_ID, WORKFLOW, "local", true]);
    assert.equal(run.agents[0].name, "publisher");
    assert.match(run.agents[0].note, /^tokens: 3 refreshed, 0 expiring, 0 expiry not known yet$/);
    assert.deepEqual(run.changed, ["company/state/tokens.json", "company/state/status.json", "company/state/runs/2026-10.jsonl"]);
    assert.equal(run.tokens.kaatdo.outcome, "refreshed");
    assert.equal(run.tokens.kaatdo.daysLeft, 60);
    assert.deepEqual(r.changedFiles, ["state/tokens.json", "state/status.json", "state/runs/2026-10.jsonl"]);
    // NO secret material anywhere: files, stdout, result
    const everything = fx.text() + "\n" + out.text() + "\n" + JSON.stringify(r);
    for (const v of SECRET_VALUES) assert.ok(!everything.includes(v), "a secret value leaked");
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] kaatdo: refreshed — IG_TOKEN_KAATDO replaced in Sudish007\/hoshlab \(gh secret set IG_TOKEN_KAATDO --repo Sudish007\/hoshlab ok\); new expiry .* \(60 days\)$/.test(l)), out.text());
    assert.ok(out.lines.at(-1).startsWith("[publisher] ok "), out.lines.at(-1));

    // a second run right after: every token is fresh (60 days) → no call, no gh, nothing changed
    const fetch2 = fakeFetch();
    const gh2 = fakeGh();
    const r2 = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: ENV, fetchImpl: fetch2, ghRun: gh2, stdout: sink(), runId: "token-refresh-20261019-0731-cc22dd" });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false, "same expiries, same states, same flags");
    assert.equal(fetch2.requests.length, 0);
    assert.equal(gh2.calls.length, 0);
    assert.deepEqual(Object.values(r2.pages).map((p) => p.outcome), ["fresh", "fresh", "fresh"]);
    assert.equal(fx.status().lastRuns.length, 5, "the run is still recorded");
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("thresholds: > 20 days skips; < 20 days refreshes (and clears an earlier expiring flag); < 7 days with a failing refresh → token_expiring flag, tokenState expiring, old expiry kept, run not ok; the filtered page is untouched", async () => {
  const seeded = {
    updatedAt: NOW,
    pages: {
      rishtapatra: { username: "rishtapatra", expiresAt: iso(45), refreshedAt: iso(-15), state: "ok" },
      kaatdo: { username: "kaatdo", expiresAt: iso(12), refreshedAt: iso(-48), state: "ok" },
      job_rez: { username: "job_rez", expiresAt: iso(3), refreshedAt: iso(-57), state: "ok" },
    },
  };
  const fx = copyFixture({ tokenStates: ok(), tokens: seeded });
  const fetchImpl = fakeFetch({ fail: { job_rez: 500 } });
  const gh = fakeGh();
  const out = sink();
  try {
    // an earlier flag for kaatdo must be cleared by its refresh
    const st = fx.status();
    st.flags = ["token_expiring:kaatdo"];
    st.pages.kaatdo.tokenState = "expiring";
    writeFileSync(join(fx.dir, "state", "status.json"), JSON.stringify(st, null, 2) + "\n", "utf8");
    const r = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: ENV, fetchImpl, ghRun: gh, stdout: out, runId: RUN_ID });
    assert.equal(r.ok, false, "the job_rez refresh failed");
    assert.deepEqual(Object.fromEntries(Object.entries(r.pages).map(([h, p]) => [h, p.outcome])), { rishtapatra: "fresh", kaatdo: "refreshed", job_rez: "refresh_failed" });
    assert.deepEqual(fetchImpl.requests.map((q) => q.handle), ["kaatdo", "job_rez"], "only the two pages under 20 days are called (usernames known → no /me)");
    assert.deepEqual(gh.calls.map((c) => c.args[2]), ["IG_TOKEN_KAATDO"], "only the successful refresh is stored");
    assert.equal(gh.calls[0].input, NEW.kaatdo);
    const tokens = fx.tokens();
    assert.equal(tokens.pages.rishtapatra.expiresAt, seeded.pages.rishtapatra.expiresAt, "untouched");
    assert.equal(tokens.pages.rishtapatra.state, "ok");
    assert.equal(Date.parse(tokens.pages.kaatdo.expiresAt), Date.parse(NOW) + EXPIRES_IN * 1000, "kaatdo renewed for 60 days");
    assert.equal(tokens.pages.kaatdo.refreshedAt, NOW);
    assert.equal(tokens.pages.kaatdo.state, "ok");
    assert.equal(tokens.pages.job_rez.expiresAt, seeded.pages.job_rez.expiresAt, "a failed refresh keeps the old expiry");
    assert.equal(tokens.pages.job_rez.refreshedAt, seeded.pages.job_rez.refreshedAt);
    assert.equal(tokens.pages.job_rez.state, "expiring");
    const status = fx.status();
    assert.deepEqual(status.flags, ["token_expiring:job_rez"], "kaatdo's flag cleared, job_rez's raised");
    assert.equal(status.pages.kaatdo.tokenState, "ok");
    assert.equal(status.pages.job_rez.tokenState, "expiring");
    assert.equal(status.pages.job_rez.tokenExpiresAt, seeded.pages.job_rez.expiresAt);
    assert.equal(r.pages.job_rez.daysLeft, 3);
    assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
    const run = fx.runs().at(-1);
    assert.equal(run.ok, false);
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0], /^job_rez: refresh failed — ig GET \/refresh_access_token: HTTP 502/);
    assert.match(run.agents[0].note, /^tokens: 1 refreshed, 1 expiring, 0 expiry not known yet, 1 error$/);
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] rishtapatra: 45 days left \(expires .*\) — no refresh before 20 days$/.test(l)), out.text());
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] job_rez: 3 days left — token_expiring flag set/.test(l)), out.text());
    const everything = fx.text() + "\n" + out.text();
    for (const v of SECRET_VALUES) assert.ok(!everything.includes(v), "a secret value leaked");
  } finally {
    fx.cleanup();
  }
});

test("190 during the refresh → tokenState invalid + token_invalid flag (the publisher re-probes hourly); a token already marked invalid is not refreshed; a page without its secret is not_configured", async () => {
  const fx = copyFixture({ tokenStates: { rishtapatra: { tokenState: "ok" }, kaatdo: { tokenState: "invalid" }, job_rez: { tokenState: "ok" } } });
  const fetchImpl = fakeFetch({ fail: { rishtapatra: 190 } });
  const gh = fakeGh();
  const out = sink();
  try {
    const env = { ...ENV };
    delete env.IG_TOKEN_JOB_REZ;
    const r = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: env, fetchImpl, ghRun: gh, stdout: out, runId: RUN_ID });
    assert.equal(r.ok, true, "a 190 is a state, not a run error");
    assert.deepEqual(Object.fromEntries(Object.entries(r.pages).map(([h, p]) => [h, p.outcome])), { rishtapatra: "token_invalid", kaatdo: "token_invalid", job_rez: "not_configured" });
    assert.deepEqual(fetchImpl.requests.map((q) => [q.handle, q.url.split("/").pop()]), [["rishtapatra", "me"], ["rishtapatra", "refresh_access_token"]], "the invalid and the unconfigured page make no call");
    assert.equal(gh.calls.length, 0);
    const status = fx.status();
    assert.equal(status.pages.rishtapatra.tokenState, "invalid");
    assert.equal(status.pages.kaatdo.tokenState, "invalid");
    assert.equal(status.pages.job_rez.tokenState, "not_configured");
    assert.deepEqual(status.flags, ["token_invalid:rishtapatra"]);
    const tokens = fx.tokens();
    assert.deepEqual(tokens.pages.rishtapatra, { username: "rishtapatra", expiresAt: null, state: "invalid" });
    assert.deepEqual(tokens.pages.kaatdo, { expiresAt: null, state: "invalid" });
    assert.deepEqual(tokens.pages.job_rez, { expiresAt: null, state: "not_configured" });
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] rishtapatra: code 190 during refresh — token invalid, page paused/.test(l)), out.text());
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] kaatdo: token is marked invalid/.test(l)), out.text());
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] job_rez: IG_TOKEN_JOB_REZ not configured yet/.test(l)), out.text());
    assert.match(fx.runs().at(-1).agents[0].note, /1 not configured$/);
  } finally {
    fx.cleanup();
  }
});

test("without HOSHLAB_SECRETS_PAT nothing is refreshed (a new token could not be stored): no call, no gh; a page whose token works but has no tokens.json entry is recorded with expiresAt null and 'expiry not known yet'; < 7 days still flags", async () => {
  const fx = copyFixture({ tokenStates: ok(), tokens: { updatedAt: NOW, pages: { job_rez: { username: "job_rez", expiresAt: iso(5), refreshedAt: iso(-55), state: "ok" } } } });
  const fetchImpl = fakeFetch();
  const gh = fakeGh();
  const out = sink();
  try {
    const r = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: { ...TOKENS }, fetchImpl, ghRun: gh, stdout: out, runId: RUN_ID });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.fromEntries(Object.entries(r.pages).map(([h, p]) => [h, p.outcome])), { rishtapatra: "pat_not_configured", kaatdo: "pat_not_configured", job_rez: "pat_not_configured" });
    assert.equal(fetchImpl.requests.length, 0, "no refresh call without a place to store the result");
    assert.equal(gh.calls.length, 0);
    const tokens = fx.tokens();
    assert.deepEqual(tokens.pages.rishtapatra, { expiresAt: null, state: "ok" });
    assert.deepEqual(tokens.pages.kaatdo, { expiresAt: null, state: "ok" });
    assert.equal(tokens.pages.job_rez.state, "expiring");
    const status = fx.status();
    assert.deepEqual(status.flags, ["token_expiring:job_rez"]);
    assert.equal(status.pages.rishtapatra.tokenExpiresAt, null);
    assert.equal(status.pages.rishtapatra.tokenState, "ok");
    assert.equal(status.pages.job_rez.tokenState, "expiring");
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] rishtapatra: HOSHLAB_SECRETS_PAT not configured yet — refresh skipped \(a refreshed token could not be stored\); expiry not known yet$/.test(l)), out.text());
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] rishtapatra: expiry not known yet \(recorded as expiresAt null; the next successful refresh sets it\)$/.test(l)), out.text());
    assert.match(fx.runs().at(-1).agents[0].note, /^tokens: 0 refreshed, 1 expiring, 2 expiry not known yet$/);
    // GH_TOKEN alone (what the workflow maps) is accepted as the PAT
    const fetch2 = fakeFetch();
    const gh2 = fakeGh();
    const r2 = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: { ...TOKENS, GH_TOKEN: PAT }, fetchImpl: fetch2, ghRun: gh2, stdout: sink(), runId: "token-refresh-20261019-0732-ee33ff" });
    assert.deepEqual(Object.values(r2.pages).map((p) => p.outcome), ["refreshed", "refreshed", "refreshed"]);
    assert.equal(gh2.calls.length, 3);
    assert.ok(gh2.calls.every((c) => c.env.GH_TOKEN === PAT));
    assert.deepEqual(fx.status().flags, [], "the job_rez flag clears once its token is renewed");
    assert.equal(fx.status().pages.job_rez.tokenState, "ok");
  } finally {
    fx.cleanup();
  }
});

test("gh failure after a successful refresh → store_failed: the old expiry is kept, the run is not ok, the new token is in no file and no line; a /me failure only drops the username", async () => {
  const fx = copyFixture({ tokenStates: ok(), tokens: { updatedAt: NOW, pages: { kaatdo: { username: "kaatdo", expiresAt: iso(10), refreshedAt: iso(-50), state: "ok" } } } });
  const fetchImpl = fakeFetch({ me: false });
  const gh = fakeGh({ status: 1, stderr: `HTTP 403: Resource not accessible by personal access token ${PAT}` });
  const out = sink();
  try {
    const r = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: ENV, fetchImpl, ghRun: gh, stdout: out, runId: RUN_ID, page: "kaatdo" });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.fromEntries(Object.entries(r.pages).map(([h, p]) => [h, p.outcome])), { rishtapatra: "filtered", kaatdo: "store_failed", job_rez: "filtered" });
    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0].input, NEW.kaatdo);
    const tokens = fx.tokens();
    assert.equal(tokens.pages.kaatdo.expiresAt, iso(10).replace("Z", "Z"), "old expiry kept");
    assert.equal(tokens.pages.kaatdo.refreshedAt, iso(-50));
    assert.equal(tokens.pages.rishtapatra, undefined, "filtered pages get no entry");
    assert.match(fx.runs().at(-1).errors[0], /^kaatdo: refreshed but gh secret set IG_TOKEN_KAATDO --repo Sudish007\/hoshlab failed \(exit 1\): HTTP 403: Resource not accessible by personal access token •••$/);
    const everything = fx.text() + "\n" + out.text() + "\n" + JSON.stringify(r);
    for (const v of SECRET_VALUES) assert.ok(!everything.includes(v), "a secret value leaked");
    assert.ok(out.lines.some((l) => /refresh answered \(expires_in 5184000 s\) but the secret could not be stored/.test(l)), out.text());
  } finally {
    fx.cleanup();
  }
  // username unknown and /me failing with a non-token error → refresh still happens, username stays absent
  const fx2 = copyFixture({ tokenStates: { kaatdo: { tokenState: "ok" } } });
  try {
    const fetchImpl = fakeFetch({ me: false });
    const gh2 = fakeGh();
    const out2 = sink();
    const r = await runRefreshTokens({ companyDir: fx2.dir, now: NOW, processEnv: ENV, fetchImpl, ghRun: gh2, stdout: out2, runId: RUN_ID, page: "kaatdo" });
    assert.equal(r.pages.kaatdo.outcome, "refreshed");
    assert.equal(fx2.tokens().pages.kaatdo.username, undefined);
    assert.ok(out2.lines.some((l) => /GET \/me failed — .*\(username not recorded\)/.test(l)), out2.text());
  } finally {
    fx2.cleanup();
  }
});

test("--dry-run: no call, no gh, nothing written (no tokens.json, status untouched, no run record); the plan is printed", async () => {
  const fx = copyFixture({ tokenStates: ok() });
  const before = fx.text();
  const fetchImpl = fakeFetch();
  const gh = fakeGh();
  const out = sink();
  try {
    const r = await runRefreshTokens({ companyDir: fx.dir, now: NOW, processEnv: ENV, fetchImpl, ghRun: gh, stdout: out, runId: RUN_ID, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.deepEqual(r.changedFiles, []);
    assert.deepEqual(Object.values(r.pages).map((p) => p.outcome), ["would_refresh", "would_refresh", "would_refresh"]);
    assert.equal(fetchImpl.requests.length, 0);
    assert.equal(gh.calls.length, 0);
    assert.equal(fx.tokens(), null);
    assert.equal(fx.text(), before, "nothing under company/ changed");
    assert.ok(out.lines.some((l) => /\[refresh-tokens\] kaatdo: would refresh \(expiry not known yet\) — dry run, no call made$/.test(l)), out.text());
    assert.match(out.lines.at(-1), /\(dry run, nothing written\)$/);
  } finally {
    fx.cleanup();
  }
});

test("CLI: refresh-tokens is registered (no longer 'not built yet'); --now without --dry-run exits 2; --dry-run --now exits 0 and writes nothing; a real run without --commit writes the three files and says 'not committed'", async () => {
  const fx = copyFixture({ tokenStates: ok() });
  try {
    const err = sink();
    assert.equal(await main(["refresh-tokens", "--now", NOW], { stdout: sink(), stderr: err, processEnv: {}, companyDir: fx.dir }), EXIT.usage);
    assert.match(err.text(), /--now <iso> is accepted only with --dry-run/);
    const out = sink();
    assert.equal(await main(["refresh-tokens", "--dry-run", "--now", NOW], { stdout: out, stderr: sink(), processEnv: { ...TOKENS }, companyDir: fx.dir }), EXIT.ok);
    assert.equal(out.lines.at(-1), "refresh-tokens: dry run complete — no call made, nothing written");
    assert.equal(fx.tokens(), null);
    // no PAT, no network: every page is pat_not_configured, the files are written, nothing committed
    const out2 = sink();
    const code = await main(["refresh-tokens"], { stdout: out2, stderr: sink(), processEnv: { ...TOKENS }, companyDir: fx.dir });
    assert.equal(code, EXIT.ok, out2.text());
    assert.ok(fx.tokens() !== null);
    assert.match(out2.lines.at(-1), /^refresh-tokens: 3 files changed under .*, not committed \(pass --commit\)$/);
    const missing = sink();
    assert.equal(await main(["refresh-tokens"], { stdout: sink(), stderr: missing, processEnv: {}, companyDir: join(fx.dir, "nope") }), EXIT.failed);
    assert.match(missing.text(), /does not exist/);
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});
