// The admin libraries driven by a fake fetch (FEAT-111): state.js appends/writes admin-owned paths only, with
// schema validation and one 409 retry; github.js dispatches workflows on the branch and keeps the token in the
// Authorization header; userMessage strings; store.js session/local behaviour; run-status.js classifyRun.
// state.js imports ./schema.js, which exists next to it only in dist/admin/lib (N18) — so the built copies are tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DIST, COMPANY_DIR, FETCH_ATTEMPTS } from "./helpers.js";

const lib = (name) => import(pathToFileURL(join(DIST, "admin", "lib", name)).href);
const { createClient, GitHubError, scrub, RAW_HOST } = await lib("github.js");
const { createAdminState, ADMIN_OWNED, OwnershipError, ValidationError, isAdminOwned, specFor, normalizeRel } = await lib("state.js");
const { createStore, KEY } = await lib("store.js");
const { classifyRun, describeLatest, relativeTime } = await lib("run-status.js");
const { encodeUtf8, decodeUtf8 } = await lib("base64.js");
const { DECISIONS_REL, applyProposal, buildApply, describeChange, dismissProposal, latestDecisions, proposalStatus } = await lib("proposals.js");
const { ROSTER_SPEC, validate } = await lib("schema.js");

const TOKEN = "ghp_FAKE_admin_lib_test_token";
const OWNER = "Sudish007";
const REPO = "hoshlab";

// A fake api.github.com: an in-memory file map with shas, recording every request.
function fakeGitHub({ files = {}, conflictOnce = [] } = {}) {
  const store = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: `sha-${p}-1` }]));
  const requests = [];
  const pending409 = new Set(conflictOnce);
  const res = (status, json, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => json,
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method, url: u.pathname + u.search, headers: init.headers, body });
    if (!init.headers || init.headers.Authorization !== `Bearer ${TOKEN}`) return res(401, { message: "Bad credentials" });
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m || m[1] !== OWNER || m[2] !== REPO) return res(404, { message: "Not Found" });
    const rest = m[3] || "";
    if (rest === "" && init.method === "GET") return res(200, { permissions: { push: true } });
    if (rest.startsWith("/contents/")) {
      const path = decodeURIComponent(rest.slice("/contents/".length));
      if (init.method === "GET") {
        const f = store.get(path);
        if (!f) return res(404, { message: "Not Found" });
        return res(200, { content: encodeUtf8(f.text), sha: f.sha, type: "file" });
      }
      if (init.method === "PUT") {
        const f = store.get(path);
        if (f && body.sha !== f.sha) return res(409, { message: "is at ... but expected ..." });
        if (pending409.has(path)) {
          pending409.delete(path);
          // Someone else committed between our GET and PUT: the file moved on.
          store.set(path, { text: (f ? f.text : "") + '{"other":"line"}\n', sha: `sha-${path}-moved` });
          return res(409, { message: "is at moved but expected" });
        }
        const text = decodeUtf8(body.content);
        const sha = `sha-${path}-${(f ? Number(f.sha.split("-").pop()) || 1 : 0) + 1}`;
        store.set(path, { text, sha, message: body.message, branch: body.branch });
        return res(200, { content: { sha }, commit: { sha: `c${sha}` } });
      }
    }
    if (/^\/actions\/workflows\/[^/]+\/dispatches$/.test(rest) && init.method === "POST") return res(204, null);
    if (/^\/actions\/workflows\/[^/]+\/runs/.test(rest)) return res(200, { workflow_runs: [{ id: 7, status: "completed", conclusion: "success", html_url: "https://github.com/Sudish007/hoshlab/actions/runs/7", created_at: "2026-10-12T04:00:00Z", head_sha: "abc" }] });
    return res(404, { message: "Not Found" });
  };
  return { fetchImpl, requests, store };
}

const APPROVAL = { draftId: "rp-2026-10-14-kundali-free", decision: "approve", revision: 1, at: "2026-10-12T10:00:00+05:30", by: "owner" };

test("ownership mirrors engine/lib/state.js ADMIN_OWNED; engine-owned and unknown paths throw before any request", async () => {
  assert.deepEqual(ADMIN_OWNED, ["config.json", "roster.json", "brands/*", "charters/*", "state/approvals.jsonl", "state/edits/*", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl"]);
  for (const rel of ["config.json", "roster.json", "brands/kaatdo.md", "charters/ceo.md", "state/approvals.jsonl", "state/edits/x.json", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl", "company/state/approvals.jsonl"]) assert.equal(isAdminOwned(rel), true, rel);
  for (const rel of ["state/status.json", "state/drafts/x/draft.json", "state/published.jsonl", "state/runs/2026-10.jsonl", "state/hr/proposals/2026-10.json", "state/calendar.json", "state/ideas.jsonl", "state/tokens.json", "brands/sub/x.md", "README.md"]) assert.equal(isAdminOwned(rel), false, rel);
  assert.equal(normalizeRel("company/state/edits/a.json"), "state/edits/a.json");
  assert.throws(() => normalizeRel("../secrets"), RangeError);
  assert.equal(specFor("state/approvals.jsonl").kind, "approval");
  assert.equal(specFor("brands/kaatdo.md").text, true);
  assert.equal(specFor("state/status.json"), null);
  const gh = fakeGitHub();
  const client = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl });
  const state = createAdminState(client);
  await assert.rejects(state.appendLine("state/published.jsonl", APPROVAL), OwnershipError);
  await assert.rejects(state.appendLine("state/drafts/x/draft.json", APPROVAL), OwnershipError);
  await assert.rejects(state.writeJson("state/status.json", {}), OwnershipError);
  await assert.rejects(state.writeText("state/memos/2026-W42.md", "x"), OwnershipError);
  await assert.rejects(state.appendLine("config.json", APPROVAL), OwnershipError, "config.json is not an append-only log");
  await assert.rejects(state.writeJson("state/approvals.jsonl", APPROVAL), OwnershipError, "a log is not a JSON document");
  assert.equal(gh.requests.length, 0, "ownership is decided before any request");
});

test("appendLine: GET sha → PUT old + new line with that sha; a missing file (404) starts empty; the record is validated first", async () => {
  const old = '{"draftId":"kd-2026-10-13-six-rules","decision":"approve","revision":1,"at":"2026-10-12T10:00:00+05:30","by":"owner"}\n';
  const gh = fakeGitHub({ files: { "company/state/approvals.jsonl": old } });
  const client = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl });
  const state = createAdminState(client);
  const r = await state.appendLine("state/approvals.jsonl", APPROVAL, { message: "approve: rp-2026-10-14-kundali-free (rev 1)" });
  const put = gh.requests.find((q) => q.method === "PUT");
  assert.equal(put.url, "/repos/Sudish007/hoshlab/contents/company/state/approvals.jsonl");
  assert.equal(put.body.sha, "sha-company/state/approvals.jsonl-1", "the current sha travels with the PUT");
  assert.equal(put.body.branch, "main");
  assert.equal(put.body.message, "approve: rp-2026-10-14-kundali-free (rev 1)");
  assert.equal(decodeUtf8(put.body.content), old + JSON.stringify(APPROVAL) + "\n");
  assert.equal(r.commitSha, "csha-company/state/approvals.jsonl-2");
  assert.equal(gh.store.get("company/state/approvals.jsonl").text, old + JSON.stringify(APPROVAL) + "\n");
  // 404 → the log starts with this line
  const r2 = await state.appendLine("state/feedback.jsonl", { at: APPROVAL.at, by: "owner", kind: "note", text: "Keep RishtaPatra Hindi-first.", tags: [] }, { message: "feedback: note" });
  assert.ok(r2.commitSha);
  const put2 = gh.requests.filter((q) => q.method === "PUT").pop();
  assert.equal(put2.body.sha, undefined, "no sha for a new file");
  assert.equal(decodeUtf8(put2.body.content), '{"at":"2026-10-12T10:00:00+05:30","by":"owner","kind":"note","text":"Keep RishtaPatra Hindi-first.","tags":[]}\n');
  // validation happens before any request: a reject without a reason, a bad revision, an unknown key
  const before = gh.requests.length;
  await assert.rejects(state.appendLine("state/approvals.jsonl", { ...APPROVAL, decision: "reject" }), ValidationError);
  await assert.rejects(state.appendLine("state/approvals.jsonl", { ...APPROVAL, revision: 0 }), ValidationError);
  await assert.rejects(state.appendLine("state/approvals.jsonl", { ...APPROVAL, extra: 1 }), ValidationError);
  await assert.rejects(state.appendLine("state/overrides.jsonl", { draftId: "x", slotAt: "tomorrow", at: APPROVAL.at, by: "owner" }), ValidationError);
  assert.equal(gh.requests.length, before, "invalid records never reach GitHub");
  for (const q of gh.requests) assert.ok(q.url.startsWith("/repos/") && q.headers.Authorization === `Bearer ${TOKEN}`);
  assert.equal(FETCH_ATTEMPTS.length, 0, "no real network call");
});

test("appendLine on 409 reloads the file and retries exactly once, appending to the moved content", async () => {
  const path = "company/state/overrides.jsonl";
  const gh = fakeGitHub({ files: { [path]: '{"draftId":"a","slotAt":"2026-10-15T18:30:00+05:30","at":"2026-10-11T21:00:00+05:30","by":"owner"}\n' }, conflictOnce: [path] });
  const client = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl });
  const state = createAdminState(client);
  const rec = { draftId: "rp-2026-10-14-kundali-free", slotAt: "2026-10-16T19:30:00+05:30", at: "2026-10-12T10:00:00+05:30", by: "owner" };
  const r = await state.appendLine("state/overrides.jsonl", rec, { message: "override: rp -> 16 Oct" });
  const seq = gh.requests.map((q) => q.method);
  assert.deepEqual(seq, ["GET", "PUT", "GET", "PUT"], "GET, PUT (409), reload, PUT");
  const puts = gh.requests.filter((q) => q.method === "PUT");
  assert.equal(puts[1].body.sha, `sha-${path}-moved`, "the retry carries the fresh sha");
  assert.ok(decodeUtf8(puts[1].body.content).includes('{"other":"line"}'), "the other writer's line is kept");
  assert.ok(decodeUtf8(puts[1].body.content).endsWith(JSON.stringify(rec) + "\n"));
  assert.ok(r.commitSha);
  // A second 409 is surfaced, not retried forever.
  const gh2 = fakeGitHub({ files: { [path]: "" }, conflictOnce: [path] });
  let puts2 = 0;
  const twice = async (url, init) => {
    if (init.method === "PUT") {
      puts2++;
      return { ok: false, status: 409, statusText: "Conflict", headers: { get: () => null }, json: async () => ({ message: "conflict" }) };
    }
    return gh2.fetchImpl(url, init);
  };
  const state2 = createAdminState(createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: twice }));
  await assert.rejects(state2.appendLine("state/overrides.jsonl", rec), (err) => err instanceof GitHubError && err.status === 409 && err.userMessage() === "This file changed in the meantime");
  assert.equal(puts2, 2, "exactly one retry");
});

test("writeJson validates config/roster/edits and writes 2-space JSON with the current sha; writeText serves brands and charters only", async () => {
  const config = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
  const gh = fakeGitHub({ files: { "company/config.json": JSON.stringify(config, null, 2) + "\n", "company/brands/kaatdo.md": "---\nhandle: kaatdo\n---\n" } });
  const client = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl });
  const state = createAdminState(client);
  const next = JSON.parse(JSON.stringify(config));
  next.pages[1].mode = "autopilot";
  next.pages[1].modeChangedAt = "2026-10-12T10:30:00+05:30";
  next.pages[1].modeChangedBy = "owner";
  const r = await state.writeJson("config.json", next, { message: "config: @kaatdo -> autopilot" });
  const put = gh.requests.filter((q) => q.method === "PUT").pop();
  assert.equal(put.url, "/repos/Sudish007/hoshlab/contents/company/config.json");
  assert.equal(put.body.message, "config: @kaatdo -> autopilot");
  assert.equal(put.body.sha, "sha-company/config.json-1");
  const written = JSON.parse(decodeUtf8(put.body.content));
  assert.equal(written.pages[1].mode, "autopilot");
  assert.equal(written.pages[1].modeChangedBy, "owner");
  assert.equal(decodeUtf8(put.body.content), JSON.stringify(next, null, 2) + "\n");
  assert.ok(r.contentSha && r.commitSha);
  // invalid config (unknown mode) never reaches GitHub
  const before = gh.requests.length;
  await assert.rejects(state.writeJson("config.json", { ...next, pages: [{ ...next.pages[0], mode: "manual" }] }), ValidationError);
  await assert.rejects(state.writeJson("state/edits/x.json", { draftId: "x", baseRevision: 1 }), ValidationError, "an edit needs caption, hashtags, altText, at, by, checks");
  assert.equal(gh.requests.length, before);
  const edit = { draftId: "rp-2026-10-14-kundali-free", baseRevision: 1, caption: "मुफ़्त जन्म कुंडली — अपने डिवाइस पर।", hashtags: ["#RishtaPatra"], altText: "Cream card", at: APPROVAL.at, by: "owner", checks: { passed: true, checks: [{ id: "caption_length", ok: true, detail: "40/2200" }] } };
  await state.writeJson("state/edits/rp-2026-10-14-kundali-free.json", edit, { message: "edit: rp (base rev 1)" });
  const putEdit = gh.requests.filter((q) => q.method === "PUT").pop();
  assert.equal(putEdit.url, "/repos/Sudish007/hoshlab/contents/company/state/edits/rp-2026-10-14-kundali-free.json");
  assert.equal(putEdit.body.sha, undefined, "new file");
  assert.deepEqual(JSON.parse(decodeUtf8(putEdit.body.content)), edit, "UTF-8 Devanagari survives the base64 round trip");
  // text files
  await state.writeText("brands/kaatdo.md", "---\nhandle: kaatdo\n---\n## Voice\n", { message: "brand: kaatdo" });
  const putBrand = gh.requests.filter((q) => q.method === "PUT").pop();
  assert.equal(putBrand.body.sha, "sha-company/brands/kaatdo.md-1");
  assert.equal(decodeUtf8(putBrand.body.content), "---\nhandle: kaatdo\n---\n## Voice\n");
  await assert.rejects(state.writeText("config.json", "{}"), OwnershipError, "config is JSON, not text");
  await assert.rejects(state.writeJson("brands/kaatdo.md", {}), OwnershipError, "a brand is text, not JSON");
  assert.deepEqual(state.errorsFor("state/approvals.jsonl", APPROVAL), []);
  assert.ok(state.errorsFor("state/approvals.jsonl", { ...APPROVAL, by: 7 }).length > 0);
});

// FEAT-204 (P2-06, N14 / D13): Apply PUTs roster.json (validated) + appends hr/decisions.jsonl; Dismiss appends the log only;
// the proposal file is never PUT; a proposal that would leave the roster without a valid qa is refused before any request.
const fixtureProposal = () => JSON.parse(readFileSync(join(COMPANY_DIR, "state", "hr", "proposals", "2026-09.json"), "utf8"));
const fixtureRoster = () => JSON.parse(readFileSync(join(COMPANY_DIR, "roster.json"), "utf8"));
const fixtureConfig = () => JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
const AT = "2026-10-12T10:30:00+05:30";

test("proposals.js: status from the decisions log (latest per month wins), describeChange wording", () => {
  const p = fixtureProposal();
  assert.equal(proposalStatus(p, []), "proposed");
  const apply = { month: "2026-09", proposal: "hr/proposals/2026-09.json", decision: "apply", at: "2026-10-02T10:00:00+05:30", by: "owner" };
  const dismiss = { ...apply, decision: "dismiss", at: "2026-10-03T10:00:00+05:30" };
  assert.equal(proposalStatus(p, [apply]), "applied");
  assert.equal(proposalStatus(p, [apply, dismiss]), "dismissed", "the later decision wins");
  assert.equal(proposalStatus(p, [dismiss, apply]), "dismissed", "by `at`, not by file order");
  assert.equal(proposalStatus({ month: "2026-10" }, [apply]), "proposed", "another month's decision does not count");
  assert.equal(latestDecisions([apply, dismiss]).get("2026-09").decision, "dismiss");
  assert.equal(describeChange(p.changes[0]), `writer · temperature: 0.8 → 0.7 — ${p.changes[0].why}`);
  assert.equal(describeChange({ agent: "designer", field: "charterAppend", from: "", to: "Prefer variant A.", why: "shorter headlines" }), "designer · charterAppend: — → Prefer variant A. — shorter headlines");
});

test("proposals.js: Apply → roster.json PUT (writer 0.8 → 0.7, ROSTER_SPEC-valid) then one decisions.jsonl line; the proposal file is never written; Dismiss → decisions.jsonl only", async () => {
  const proposal = fixtureProposal();
  const roster = fixtureRoster();
  const config = fixtureConfig();
  const files = { "company/roster.json": JSON.stringify(roster, null, 2) + "\n", "company/state/hr/proposals/2026-09.json": JSON.stringify(proposal, null, 2) + "\n" };
  const gh = fakeGitHub({ files });
  const client = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl });
  const state = createAdminState(client);
  const r = await applyProposal(state, { proposal, roster, config, at: AT });
  assert.deepEqual(r.applied, ["roster.json"]);
  const puts = gh.requests.filter((q) => q.method === "PUT");
  assert.deepEqual(puts.map((q) => q.url), ["/repos/Sudish007/hoshlab/contents/company/roster.json", "/repos/Sudish007/hoshlab/contents/company/state/hr/decisions.jsonl"], "roster first, the decision last, nothing else");
  assert.equal(puts[0].body.message, "roster: apply hr proposal 2026-09");
  assert.equal(puts[0].body.sha, "sha-company/roster.json-1");
  const written = JSON.parse(decodeUtf8(puts[0].body.content));
  assert.equal(written.agents.find((a) => a.name === "writer").temperature, 0.7);
  assert.deepEqual(written.agents.map((a) => a.name), roster.agents.map((a) => a.name), "no agent added or removed");
  assert.deepEqual(validate(written, ROSTER_SPEC, config), { ok: true, errors: [] });
  assert.equal(puts[1].body.message, "hr: apply proposal 2026-09");
  assert.equal(puts[1].body.sha, undefined, "decisions.jsonl did not exist yet");
  assert.equal(decodeUtf8(puts[1].body.content), JSON.stringify({ month: "2026-09", proposal: "hr/proposals/2026-09.json", decision: "apply", at: AT, by: "owner", applied: ["roster.json"] }) + "\n");
  assert.deepEqual(r.decision, { month: "2026-09", proposal: "hr/proposals/2026-09.json", decision: "apply", at: AT, by: "owner", applied: ["roster.json"] });
  assert.equal(gh.store.get("company/state/hr/proposals/2026-09.json").text, files["company/state/hr/proposals/2026-09.json"], "the proposal file is untouched (N14)");
  assert.ok(gh.requests.every((q) => !(q.method === "PUT" && q.url.includes("hr/proposals"))));
  assert.equal(proposalStatus(proposal, [r.decision]), "applied");
  // Dismiss: one append, nothing else
  const gh2 = fakeGitHub({ files: { ...files, [`company/${DECISIONS_REL}`]: JSON.stringify(r.decision) + "\n" } });
  const state2 = createAdminState(createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh2.fetchImpl }));
  const d = await dismissProposal(state2, { proposal: { ...proposal, month: "2026-10" }, at: AT, reason: "not this month" });
  const puts2 = gh2.requests.filter((q) => q.method === "PUT");
  assert.deepEqual(puts2.map((q) => q.url), [`/repos/Sudish007/hoshlab/contents/company/${DECISIONS_REL}`]);
  assert.equal(puts2[0].body.message, "hr: dismiss proposal 2026-10");
  assert.equal(puts2[0].body.sha, `sha-company/${DECISIONS_REL}-1`, "appended to the existing log with its sha");
  const lines = decodeUtf8(puts2[0].body.content).trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], { month: "2026-10", proposal: "hr/proposals/2026-10.json", decision: "dismiss", at: AT, by: "owner", reason: "not this month" });
  assert.deepEqual(d.decision, lines[1]);
  assert.equal(gh2.store.get("company/roster.json").text, files["company/roster.json"], "Dismiss never touches the roster");
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("proposals.js: a proposal whose result has no valid qa — or that no longer matches the roster — is refused client-side before any request; charterAppend is applied to the charter text", async () => {
  const proposal = fixtureProposal();
  const roster = fixtureRoster();
  const config = fixtureConfig();
  const gh = fakeGitHub({ files: { "company/roster.json": JSON.stringify(roster, null, 2) + "\n" } });
  const state = createAdminState(createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl }));
  // a swap of qa's provider leaves its model outside the new provider's table → ROSTER_SPEC refuses
  const qaSwap = { ...proposal, changes: [{ agent: "qa", field: "provider", from: "gemini", to: "openai", why: "x" }] };
  const plan = buildApply({ proposal: qaSwap, roster, config });
  assert.match(plan.errors.join("\n"), /roster after the proposal: \$\.agents\[5\]\.model: gemini-3\.8-flash not in providers\.openai\.models/);
  await assert.rejects(applyProposal(state, { proposal: qaSwap, roster, config, at: AT }), /cannot apply the 2026-09 proposal: roster after the proposal/);
  // a roster that already lacks qa can never be the base of an apply
  const noQa = { ...roster, agents: roster.agents.filter((a) => a.name !== "qa") };
  assert.match(buildApply({ proposal, roster: noQa, config }).errors.join("\n"), /roster after the proposal: \$\.agents: expected at least 8 items \(7\)/, "the shape rule (exactly eight agents) fires before the by-name rule");
  await assert.rejects(applyProposal(state, { proposal, roster: noQa, config, at: AT }), /expected at least 8 items \(7\)/);
  const qaRenamed = { ...roster, agents: roster.agents.map((a) => (a.name === "qa" ? { ...a, name: "ceo" } : a)) };
  assert.match(buildApply({ proposal, roster: qaRenamed, config }).errors.join("\n"), /missing agent qa/, "eight agents but no qa → the by-name rule");
  // qa disabled in the base roster → refused too (qa and publisher cannot be disabled)
  const qaOff = { ...roster, agents: roster.agents.map((a) => (a.name === "qa" ? { ...a, enabled: false } : a)) };
  assert.match(buildApply({ proposal, roster: qaOff, config }).errors.join("\n"), /qa cannot be disabled/);
  // the roster moved on since HR wrote the proposal (owner set the writer to 0.75) → refused, nothing clobbered
  const moved = { ...roster, agents: roster.agents.map((a) => (a.name === "writer" ? { ...a, temperature: 0.75 } : a)) };
  assert.match(buildApply({ proposal, roster: moved, config }).errors.join("\n"), /writer temperature is "0\.75" now, the proposal expected "0\.8" — the roster changed since HR wrote it/);
  // an unknown agent, a non-proposal
  assert.match(buildApply({ proposal: { ...proposal, changes: [{ ...proposal.changes[0], agent: "intern" }] }, roster, config }).errors.join("\n"), /^proposal: \$\.changes\[0\]\.agent: expected one of ceo\|hr\|/, "an unknown agent name fails the proposal's own shape (AGENT enum) first");
  assert.match(buildApply({ proposal: { ...proposal, changes: [{ ...proposal.changes[0], agent: "analyst" }] }, roster: { ...roster, agents: roster.agents.filter((a) => a.name !== "analyst") }, config }).errors.join("\n"), /change 1: analyst is not in the roster/);
  assert.match(buildApply({ proposal: { month: "2026-09" }, roster, config }).errors.join("\n"), /^proposal: /);
  assert.equal(gh.requests.filter((q) => q.method === "PUT").length, 0, "every refusal happened before any request");
  // charterAppend: the paragraph is appended to the charter text, validated with the editor's rule, and PUT as a charter
  const append = { ...proposal, changes: [{ agent: "designer", field: "charterAppend", from: "", to: "Prefer variant A whenever the headline fits 36 characters.", why: "x" }] };
  const charter = "# Designer\n\n## Identity\nx\n\n## Method\ny\n\n## Output\nz\n";
  const plan2 = buildApply({ proposal: append, roster, config, charters: { designer: charter }, validateCharter: (t) => (t.includes("## Output") ? [] : ["heading '## Output' missing"]) });
  assert.deepEqual(plan2.errors, []);
  assert.equal(plan2.rosterChanged, false, "charterAppend does not touch roster.json");
  assert.deepEqual(plan2.applied, ["charters/designer.md"]);
  assert.equal(plan2.charters["charters/designer.md"], `${charter.trimEnd()}\n\nPrefer variant A whenever the headline fits 36 characters.\n`);
  assert.match(buildApply({ proposal: append, roster, config }).errors.join("\n"), /the designer charter is not loaded/);
  assert.match(buildApply({ proposal: append, roster, config, charters: { designer: charter }, validateCharter: () => ["12001 characters, limit 12000"] }).errors.join("\n"), /designer charter after the append: 12001 characters/);
  const gh3 = fakeGitHub({ files: { "company/roster.json": JSON.stringify(roster, null, 2) + "\n", "company/charters/designer.md": charter } });
  const state3 = createAdminState(createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh3.fetchImpl }));
  const r3 = await applyProposal(state3, { proposal: append, roster, config, charters: { designer: charter }, at: AT });
  const puts3 = gh3.requests.filter((q) => q.method === "PUT");
  assert.deepEqual(puts3.map((q) => q.url.replace("/repos/Sudish007/hoshlab/contents/", "")), ["company/charters/designer.md", `company/${DECISIONS_REL}`], "no roster PUT when no roster field changed");
  assert.equal(puts3[0].body.message, "charter: designer (hr proposal 2026-09)");
  assert.deepEqual(r3.decision.applied, ["charters/designer.md"]);
});

test("github.js: dispatchWorkflow posts to /actions/workflows/<file>/dispatches with ref = branch and string inputs; latestWorkflowRun; rawUrl has no token", async () => {
  const gh = fakeGitHub();
  const client = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: gh.fetchImpl });
  const r = await client.dispatchWorkflow("engine-daily.yml", { dry_run: false });
  assert.ok(r.dispatchedAt);
  const post = gh.requests.find((q) => q.method === "POST");
  assert.equal(post.url, "/repos/Sudish007/hoshlab/actions/workflows/engine-daily.yml/dispatches");
  assert.deepEqual(post.body, { ref: "main", inputs: { dry_run: "false" } });
  assert.equal(post.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(post.headers["X-GitHub-Api-Version"], "2022-11-28");
  const run = await client.latestWorkflowRun("publisher-hourly.yml");
  assert.equal(run.id, 7);
  assert.ok(gh.requests.pop().url.startsWith("/repos/Sudish007/hoshlab/actions/workflows/publisher-hourly.yml/runs?per_page=1"));
  assert.equal(client.rawUrl("media/x/image-1.jpg", "media"), `${RAW_HOST}/Sudish007/hoshlab/media/media/x/image-1.jpg`);
  assert.equal(client.rawUrl("company/brands/kaatdo.md"), `${RAW_HOST}/Sudish007/hoshlab/main/company/brands/kaatdo.md`);
  assert.ok(!client.rawUrl("x").includes(TOKEN));
  const info = await client.repoInfo();
  assert.equal(info.permissions.push, true);
  const dir = await client.listDir("company/state/missing");
  assert.deepEqual(dir, [], "404 directory listing → []");
  for (const q of gh.requests) assert.ok(!q.url.includes(TOKEN), "the token is never in a URL");
});

test("github.js: userMessage strings and scrub()", async () => {
  assert.equal(new GitHubError(401, "Bad credentials").userMessage(), "Token invalid or expired");
  assert.equal(new GitHubError(403, "Forbidden").userMessage(), "Token lacks access to this repository");
  assert.equal(new GitHubError(404, "Not Found").userMessage(), "Token lacks access to this repository");
  assert.equal(new GitHubError(403, "no push", { kind: "push" }).userMessage(), "Token has no write access to this repository");
  assert.match(new GitHubError(403, "rate", { rateLimitReset: 1760244600 }).userMessage(), /^GitHub rate limit — try again at \d{2}:\d{2} IST$/);
  assert.equal(new GitHubError(409, "conflict").userMessage(), "This file changed in the meantime");
  assert.equal(new GitHubError(422, "Invalid request.").userMessage(), "Invalid request.");
  assert.equal(new GitHubError(0, "network", { kind: "network" }).userMessage(), "No network — try again");
  assert.equal(new GitHubError(500, "boom").userMessage(), "GitHub 500: boom");
  assert.equal(scrub(`token ${TOKEN} leaked`, TOKEN), "token ••• leaked");
  assert.equal(scrub("plain", null), "plain");
  // a thrown TypeError from fetch is a network error; a 403 with x-ratelimit-remaining 0 carries the reset
  const net = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(net.repoInfo(), (e) => e instanceof GitHubError && e.kind === "network");
  const limited = createClient({ token: TOKEN, owner: OWNER, repo: REPO, branch: "main", fetchImpl: async () => ({ ok: false, status: 403, statusText: "Forbidden", headers: { get: (k) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760244600" })[k] ?? null }, json: async () => ({ message: "API rate limit exceeded" }) }) });
  await assert.rejects(limited.repoInfo(), (e) => e instanceof GitHubError && e.status === 403 && e.rateLimitReset === 1760244600);
});

test("store.js: sessionStorage by default, localStorage when remembered, clear() empties both, key hoshlab.admin.token", () => {
  assert.equal(KEY, "hoshlab.admin.token");
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m };
  };
  const session = mem();
  const local = mem();
  const store = createStore({ session, local });
  assert.equal(store.get(), null);
  assert.deepEqual(store.set("t1", false), { persisted: true });
  assert.equal(session.m.get(KEY), "t1");
  assert.equal(local.m.has(KEY), false);
  assert.equal(store.remembered(), false);
  assert.deepEqual(store.set("t2", true), { persisted: true });
  assert.equal(local.m.get(KEY), "t2");
  assert.equal(session.m.has(KEY), false, "switching to remembered removes the session copy");
  assert.equal(store.get(), "t2");
  assert.equal(store.remembered(), true);
  store.clear();
  assert.equal(store.get(), null);
  assert.equal(local.m.size + session.m.size, 0);
  const broken = createStore({ session: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } }, local });
  assert.deepEqual(broken.set("t3", false), { persisted: false });
  assert.equal(broken.get(), null);
});

test("run-status.js: classifyRun by commit or by dispatch time; describeLatest; relativeTime", () => {
  const run = (over) => ({ id: 1, status: "completed", conclusion: "success", html_url: "https://github.com/Sudish007/hoshlab/actions/runs/1", head_sha: "abc", created_at: "2026-10-12T04:00:00Z", updated_at: "2026-10-12T04:05:00Z", ...over });
  assert.deepEqual(classifyRun(null, { commitSha: "abc" }), { state: "waiting", label: "run not started yet", url: null });
  assert.equal(classifyRun(run({ head_sha: "other" }), { commitSha: "abc" }).state, "waiting");
  assert.equal(classifyRun(run(), { since: "2026-10-12T04:30:00Z" }).state, "waiting", "a run created before the dispatch is not ours");
  assert.deepEqual(classifyRun(run(), { since: "2026-10-12T03:59:00Z" }), { state: "success", label: "succeeded", url: run().html_url });
  assert.deepEqual(classifyRun(run({ status: "queued", conclusion: null }), { commitSha: "abc" }), { state: "queued", label: "queued", url: run().html_url });
  assert.equal(classifyRun(run({ status: "in_progress", conclusion: null }), { commitSha: "abc" }).label, "running");
  assert.equal(classifyRun(run({ conclusion: "failure" }), { commitSha: "abc" }).label, "failed (failure)");
  assert.equal(classifyRun(run({ conclusion: "cancelled" }), { commitSha: "abc" }).state, "failure");
  assert.equal(classifyRun(run({ status: "weird" }), {}).state, "queued");
  const now = new Date("2026-10-12T04:19:00Z");
  assert.deepEqual(describeLatest(run(), { now }), { text: "Last Pages deploy: succeeded · 14 min ago", url: run().html_url, state: "succeeded" });
  assert.equal(describeLatest(run({ status: "in_progress", conclusion: null }), { now, what: "engine run" }).text, "Last engine run: running · 14 min ago");
  assert.equal(describeLatest(null), null);
  assert.equal(relativeTime("2026-10-12T01:00:00Z", now), "3 h ago");
  assert.equal(relativeTime("2026-10-10T01:00:00Z", now), "2026-10-10");
  assert.equal(relativeTime("garbage", now), "");
});
