import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers.js";
import { ADMIN_OWNED, ENGINE_OWNED, HR_ENGINE_FILES, OwnershipError, createState, isAdminOwned, isEngineOwned, latestByKey, normalizeRel, parseJsonl, specFor } from "../engine/lib/state.js";
import { APPROVAL_SPEC, DRAFT_SPEC, HR_DECISION_SPEC, HR_PROPOSAL_SPEC, SchemaError, STATUS_SPEC, USAGE_SPEC } from "../engine/lib/schema.js";

const RUN_ID = "engine-daily-20261031-2350-a1b2c3";
const usageRecord = (at) => ({ at, runId: RUN_ID, agent: "writer", page: "rishtapatra", provider: "mock", model: "mock", inputTokens: 10, outputTokens: 5, costUsd: 0, ms: 12, ok: true, error: null, mock: true });

function fresh() {
  const dir = tmpDir("hoshlab-state-");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("monthLogPath / appendLog partition by IST month (M9 fixture clocks)", () => {
  const { dir, cleanup } = fresh();
  try {
    const late = createState({ companyDir: dir, now: "2026-10-31T23:50:00+05:30" });
    assert.equal(late.monthLogPath("usage"), "state/usage/2026-10.jsonl");
    assert.equal(late.monthLogPath("runs"), "state/runs/2026-10.jsonl");
    assert.equal(late.monthLogPath("metrics"), "state/metrics/2026-10.jsonl");
    assert.equal(late.appendLog("usage", usageRecord("2026-10-31T23:50:00+05:30"), USAGE_SPEC), "state/usage/2026-10.jsonl");

    const early = createState({ companyDir: dir, now: () => new Date("2026-11-01T00:10:00+05:30") });
    assert.equal(early.monthLogPath("usage"), "state/usage/2026-11.jsonl");
    assert.equal(early.appendLog("usage", usageRecord("2026-11-01T00:10:00+05:30"), USAGE_SPEC), "state/usage/2026-11.jsonl");
    // 00:10 IST on 1 Nov is still 31 Oct in UTC — the host/UTC date must not leak into the key
    assert.equal(new Date("2026-11-01T00:10:00+05:30").toISOString().slice(0, 10), "2026-10-31");

    assert.deepEqual(readdirSync(join(dir, "state", "usage")).sort(), ["2026-10.jsonl", "2026-11.jsonl"]);
    assert.equal(late.readJsonl("state/usage/2026-10.jsonl").length, 1);
    assert.equal(late.readJsonl("state/usage/2026-11.jsonl")[0].at, "2026-11-01T00:10:00+05:30");
    assert.equal(late.monthLogPath("usage", new Date("2026-12-31T19:00:00Z")), "state/usage/2027-01.jsonl");
    assert.throws(() => late.monthLogPath("approvals"), RangeError);
  } finally {
    cleanup();
  }
});

test("ownership: writeJson / appendJsonl refuse every admin-owned path with OwnershipError", () => {
  const { dir, cleanup } = fresh();
  try {
    const state = createState({ companyDir: dir, now: "2026-10-12T05:30:00+05:30" });
    const approval = { draftId: "rp-2026-10-14-kundali-free", decision: "approve", revision: 1, at: "2026-10-13T09:00:00+05:30", by: "owner" };
    assert.throws(() => state.appendJsonl("state/approvals.jsonl", approval, APPROVAL_SPEC), OwnershipError);
    assert.throws(() => state.writeJson("config.json", { version: 1 }), (e) => e instanceof OwnershipError && e.path === "config.json" && /admin-owned path/.test(e.message));
    for (const rel of ["roster.json", "brands/rishtapatra.md", "charters/ceo.md", "state/edits/rp-x.json", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl", "./state/approvals.jsonl", "state\\edits\\x.json"]) {
      assert.throws(() => state.writeJson(rel, {}), OwnershipError, rel);
      assert.throws(() => state.appendJsonl(rel, {}), OwnershipError, rel);
    }
    assert.equal(readdirSync(dir).length, 0, "nothing written");
    // engine-owned siblings are fine
    assert.equal(state.writeJson("state/hr/proposals/2026-10.json", { ok: true }), "state/hr/proposals/2026-10.json");
    assert.equal(state.appendJsonl("state/ideas.jsonl", { id: "x" }), "state/ideas.jsonl");
    // text files (memos, reports) follow the same ownership rule and are UTF-8 without BOM
    assert.throws(() => state.writeText("charters/ceo.md", "# x"), OwnershipError);
    assert.throws(() => state.writeText("state/memos/2026-W42.md", { not: "text" }), TypeError);
    assert.equal(state.writeText("state/memos/2026-W42.md", "# मेमो 2026-W42\n\n```json\n{}\n```\n"), "state/memos/2026-W42.md");
    const bytes = readFileSync(join(dir, "state", "memos", "2026-W42.md"));
    assert.notEqual(bytes[0], 0xef, "no BOM");
    assert.equal(state.readText("state/memos/2026-W42.md"), "# मेमो 2026-W42\n\n```json\n{}\n```\n");
    assert.throws(() => state.readText("state/memos/2026-W43.md"), /2026-W43\.md/);
    assert.equal(readdirSync(join(dir, "state", "memos")).length, 1, "atomic write leaves no temp file");
  } finally {
    cleanup();
  }
});

test("ownership tables: isAdminOwned / isEngineOwned / normalizeRel", () => {
  assert.equal(ADMIN_OWNED.length, 9);
  for (const rel of ["config.json", "roster.json", "brands/kaatdo.md", "charters/qa.md", "state/approvals.jsonl", "state/edits/a.json", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl"]) {
    assert.equal(isAdminOwned(rel), true, rel);
    assert.equal(isEngineOwned(rel), false, rel);
  }
  for (const rel of ["state/status.json", "state/ideas.jsonl", "state/calendar.json", "state/drafts/x/draft.json", "state/published.jsonl", "state/runs/2026-10.jsonl", "state/usage/2026-10.jsonl", "state/metrics/2026-10.jsonl", "state/memos/2026-W42.md", "state/reports/2026-W42.md", "state/hr/2026-10-review.md", "state/hr/proposals/2026-10.json", "state/tokens.json"]) {
    assert.equal(isAdminOwned(rel), false, rel);
    assert.equal(isEngineOwned(rel), true, rel);
  }
  assert.ok(ENGINE_OWNED.includes("state/hr/*"));
  assert.deepEqual(HR_ENGINE_FILES, ["state/hr/proposals/*", "state/hr/*-review.md"], "what state/hr/* stands for (N14 documentation)");
  assert.equal(normalizeRel("./state//drafts/../status.json"), "state/status.json");
  assert.throws(() => normalizeRel("../outside.json"), RangeError);
  assert.throws(() => normalizeRel("c:/abs/path.json"), RangeError);
  assert.throws(() => createState({ companyDir: "x" }).writeJson("state/../../escape.json", {}), RangeError);
});

// Review N14 / plan D13 (FEAT-204): the admin appends hr/decisions.jsonl and never edits a proposal; HR writes proposals
// and reviews and never a decision. Both tables say so, specFor knows the three kinds, and the engine state refuses the log.
test("N14: hr/decisions.jsonl is admin-owned; hr/proposals/* and hr/*-review.md are engine-owned", () => {
  assert.ok(ADMIN_OWNED.includes("state/hr/decisions.jsonl"));
  assert.ok(!ENGINE_OWNED.includes("state/hr/decisions.jsonl"));
  for (const rel of ["state/hr/proposals/2026-09.json", "state/hr/2026-09-review.md", "state/hr/proposals/2026-10.json"]) {
    assert.equal(isEngineOwned(rel), true, rel);
    assert.equal(isAdminOwned(rel), false, rel);
  }
  assert.equal(isEngineOwned("state/hr/decisions.jsonl"), false);
  assert.equal(isAdminOwned("state/hr/decisions.jsonl"), true);
  assert.equal(specFor("state/hr/decisions.jsonl").kind, "hrDecision");
  assert.equal(specFor("state/hr/proposals/2026-09.json").kind, "hrProposal");
  assert.equal(specFor("state/hr/2026-09-review.md").kind, "hrReview");
  assert.equal(specFor("state/hr/proposals/2026-9.json"), null, "a proposal file is named by its YYYY-MM month");
  assert.equal(specFor("state/hr/notes.md"), null, "nothing else lives under state/hr/");
  const { dir, cleanup } = fresh();
  try {
    const state = createState({ companyDir: dir, now: "2026-11-01T05:31:00+05:30" });
    const decision = { month: "2026-10", proposal: "hr/proposals/2026-10.json", decision: "apply", at: "2026-11-02T10:00:00+05:30", by: "owner" };
    assert.throws(() => state.appendJsonl("state/hr/decisions.jsonl", decision, HR_DECISION_SPEC), (e) => e instanceof OwnershipError && e.path === "state/hr/decisions.jsonl");
    const proposal = { month: "2026-10", at: "2026-11-01T05:31:40+05:30", runId: "engine-daily-20261101-0531-aaaaaa", status: "proposed", reviewPath: "hr/2026-10-review.md", review: [], changes: [] };
    assert.equal(state.writeJson("state/hr/proposals/2026-10.json", proposal, HR_PROPOSAL_SPEC), "state/hr/proposals/2026-10.json");
    assert.equal(state.writeText("state/hr/2026-10-review.md", "# HR review 2026-10\n"), "state/hr/2026-10-review.md");
    assert.throws(() => state.writeJson("state/hr/proposals/2026-10.json", { ...proposal, status: "applied" }, HR_PROPOSAL_SPEC), SchemaError, "a proposal's status is always 'proposed' — the decision lives in the admin's log");
    assert.equal(existsSync(join(dir, "state", "hr", "decisions.jsonl")), false);
  } finally {
    cleanup();
  }
});

test("writeJson validates first and writes nothing on failure; success writes UTF-8 without BOM, atomically", () => {
  const { dir, cleanup } = fresh();
  try {
    const state = createState({ companyDir: dir, now: "2026-10-12T05:30:00+05:30" });
    const bad = { updatedAt: "2026-10-12T05:36:00+05:30", lastRuns: [], queue: {}, blocked: {}, budget: { month: "2026-10", usedUsd: 0, limitUsd: 25, exhausted: false }, pages: {}, flags: ["not_a_flag"] };
    assert.throws(() => state.writeJson("state/status.json", bad, STATUS_SPEC), (e) => e instanceof SchemaError && /state\/status\.json \$\.flags\[0\]/.test(e.errors[0]));
    assert.equal(existsSync(join(dir, "state")), false, "no directory created on validation failure");

    const good = { ...bad, flags: [], pages: { rishtapatra: { mode: "approve_first", tokenState: "not_configured", tokenExpiresAt: null, lastPublishedAt: null } } };
    state.writeJson("state/status.json", good, STATUS_SPEC);
    const bytes = readFileSync(join(dir, "state", "status.json"));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "no BOM");
    assert.equal(bytes.toString("utf8").endsWith("}\n"), true);
    assert.deepEqual(state.readJson("state/status.json", STATUS_SPEC), good);
    assert.deepEqual(readdirSync(join(dir, "state")), ["status.json"], "no temp file left behind");

    // appendJsonl validates too and leaves the file untouched
    state.appendJsonl("state/usage/2026-10.jsonl", usageRecord("2026-10-12T05:31:00+05:30"), USAGE_SPEC);
    assert.throws(() => state.appendJsonl("state/usage/2026-10.jsonl", { ...usageRecord("2026-10-12T05:31:00+05:30"), mock: "yes" }, USAGE_SPEC), SchemaError);
    assert.equal(state.readJsonl("state/usage/2026-10.jsonl").length, 1);
    assert.deepEqual(state.readJsonl("state/usage/missing.jsonl"), []);
  } finally {
    cleanup();
  }
});

test("readJson validates with the given spec; Devanagari round-trips; BOM on read is tolerated", () => {
  const { dir, cleanup } = fresh();
  try {
    const state = createState({ companyDir: dir });
    state.writeJson("state/memo-meta.json", { title: "होशलैब", n: 1 });
    assert.deepEqual(state.readJson("state/memo-meta.json"), { title: "होशलैब", n: 1 });
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "bom.json"), "\uFEFF{\"a\":1}", "utf8");
    assert.deepEqual(state.readJson("state/bom.json"), { a: 1 });
    assert.throws(() => state.readJson("state/bom.json", { a: "str" }), SchemaError);
    assert.throws(() => state.readJson("state/missing.json"), /state\/missing\.json/);
  } finally {
    cleanup();
  }
});

test("drafts: listDrafts / writeDraft / readDraft / readQa with DRAFT_SPEC validation", () => {
  const { dir, cleanup } = fresh();
  try {
    const state = createState({ companyDir: dir });
    assert.deepEqual(state.listDrafts(), []);
    const draft = {
      id: "rp-2026-10-14-kundali-free",
      page: "rishtapatra",
      ideaId: "rp-i0031",
      slotId: "rishtapatra-2026-10-14-1930",
      slotAt: "2026-10-14T19:30:00+05:30",
      format: "image",
      language: "hi",
      status: "written",
      revision: 1,
      reworkCount: 0,
      mock: true,
      createdAt: "2026-10-12T05:35:00+05:30",
      updatedAt: "2026-10-12T05:35:00+05:30",
      by: "writer",
      runId: RUN_ID,
      caption: "कुंडली — free, on your device.",
      hashtags: ["#RishtaPatra"],
      altText: "Card",
      artwork: { headline: "Free Janam Kundali", subline: "Computed on your device", facts: ["North Indian method"], footer: "rishtapatra.com" },
      factsUsed: [{ factId: "rp-f07", quote: "North Indian method" }],
      media: [],
      publishAttempts: [],
    };
    assert.equal(state.writeDraft(draft), "state/drafts/rp-2026-10-14-kundali-free/draft.json");
    assert.throws(() => state.writeDraft({ ...draft, id: "rp-bad", status: "scheduled" }), SchemaError);
    assert.deepEqual(state.listDrafts(), ["rp-2026-10-14-kundali-free"]);
    assert.deepEqual(state.readDraft("rp-2026-10-14-kundali-free"), draft);
    assert.equal(state.readQa("rp-2026-10-14-kundali-free"), null);
    assert.ok(state.exists("state/drafts/rp-2026-10-14-kundali-free/draft.json"));
    assert.throws(() => state.writeJson("state/drafts/rp-2026-10-14-kundali-free/draft.json", { ...draft, revision: 0 }, DRAFT_SPEC), SchemaError);
  } finally {
    cleanup();
  }
});

test("latestByKey and parseJsonl", () => {
  const records = [
    { draftId: "a", decision: "approve" },
    { draftId: "b", decision: "approve" },
    { draftId: "a", decision: "reject" },
  ];
  const latest = latestByKey(records, "draftId");
  assert.equal(latest.get("a").decision, "reject");
  assert.equal(latest.get("b").decision, "approve");
  assert.equal(latest.size, 2);
  assert.deepEqual(parseJsonl('{"a":1}\r\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => parseJsonl('{"a":1}\n{broken'), /jsonl: line 2/);
});
