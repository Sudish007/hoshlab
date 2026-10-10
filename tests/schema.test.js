import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import {
  APPROVAL_SPEC,
  CALENDAR_SPEC,
  CONFIG_SPEC,
  DRAFT_SPEC,
  HASHTAG,
  IDEA_SPEC,
  ROSTER_SPEC,
  RUN_SPEC,
  SOURCE_RE,
  STATUS_SPEC,
  USAGE_SPEC,
  SchemaError,
  SPECS,
  assertShape,
  parseSource,
  toJsonSchema,
  validate,
} from "../engine/lib/schema.js";

const ok = (value, spec) => assert.doesNotThrow(() => assertShape(value, spec), `expected ${JSON.stringify(value)} to match ${JSON.stringify(spec)}`);
const bad = (value, spec, re) => {
  assert.throws(
    () => assertShape(value, spec),
    (e) => {
      assert.ok(e instanceof SchemaError, "SchemaError");
      assert.ok(Array.isArray(e.errors) && e.errors.length > 0, "errors[]");
      if (re) assert.match(e.errors.join("\n"), re);
      return true;
    },
    `expected ${JSON.stringify(value)} to fail ${JSON.stringify(spec)}`,
  );
};

test("DSL: str / str? / str<=N", () => {
  ok("x", "str");
  bad(1, "str", /expected string/);
  bad(null, "str", /required str/);
  ok(null, "str?");
  ok(undefined, "str?");
  ok("कुंडली", "str<=6"); // 6 code points, 18 UTF-8 bytes
  bad("कुंडलीx", "str<=6", /longer than 6/);
  ok("😀😀", "str<=2");
});

test("DSL: int / int? / int[min..max] / num / bool", () => {
  ok(3, "int");
  bad(3.5, "int", /expected integer/);
  bad("3", "int", /expected integer/);
  ok(null, "int?");
  ok(25, "num[1..1000]");
  bad(0, "num[1..1000]", /in 1\.\.1000/);
  bad(1001, "int[1..1000]", /in 1\.\.1000/);
  ok(0.5, "num");
  bad(NaN, "num", /expected number/);
  ok(true, "bool");
  bad("true", "bool", /expected boolean/);
});

test("DSL: enum[a|b|c]", () => {
  ok("approve_first", "enum[approve_first|autopilot]");
  bad("Approve first", "enum[approve_first|autopilot]", /expected one of approve_first\|autopilot/);
  ok(null, "enum[a|b]?");
});

test("DSL: iso-datetime needs an explicit offset", () => {
  ok("2026-10-14T19:30:00+05:30", "iso-datetime");
  ok("2026-10-14T19:30:00Z", "iso-datetime");
  ok("2026-10-14T19:30:00.123+05:30", "iso-datetime");
  bad("2026-10-14T19:30:00", "iso-datetime", /explicit offset/);
  bad("2026-10-14", "iso-datetime", /explicit offset/);
  bad("2026-13-01T00:00:00+05:30", "iso-datetime", /invalid datetime/);
  bad("2026-02-30T00:00:00+05:30", "iso-datetime", /invalid datetime/);
});

test("DSL: date / handle / id / url / pattern", () => {
  ok("2026-10-14", "date");
  bad("2026-2-1", "date", /YYYY-MM-DD/);
  bad("2026-02-30", "date", /YYYY-MM-DD/);
  ok("job_rez", "handle");
  ok("rishtapatra", "handle");
  bad("Job_Rez", "handle", /handle/);
  bad("a".repeat(31), "handle", /handle/);
  ok("rp-2026-10-14-kundali-free", "id");
  ok("engine-daily-20261012-0001-a1b2c3", "id");
  bad("-leading", "id", /expected id/);
  ok("https://rishtapatra.com", "url");
  bad("ftp://x", "url", /http/);
  bad("not a url", "url", /invalid URL/);
  ok("v21.0", "pattern:^v\\d+\\.\\d+$");
  bad("21.0", "pattern:^v\\d+\\.\\d+$", /does not match/);
  ok("#JanamKundali", "pattern:^#[\\p{L}\\p{N}_]{2,40}$");
  bad("#a b", "pattern:^#[\\p{L}\\p{N}_]{2,40}$");
  // HASHTAG adds \p{M}: the design's \p{L}-only class rejects Devanagari matras/virama
  bad("#रिश्ता", "pattern:^#[\\p{L}\\p{N}_]{2,40}$");
  ok("#रिश्ता", HASHTAG);
  ok("#JanamKundali", HASHTAG);
  bad("#a b", HASHTAG);
  bad("#x", HASHTAG);
  bad("#" + "x".repeat(41), HASHTAG);
  assert.throws(() => assertShape("x", "pattern:("), SchemaError);
  assert.throws(() => assertShape("x", "nonsense"), /unknown token/);
});

test("DSL: arrays with {min,max}, nested objects, optional keys, maps, unknown keys", () => {
  ok([], ["str"]);
  ok(["a", "b"], ["str", { min: 1, max: 2 }]);
  bad([], ["str", { min: 1 }], /at least 1 item/);
  bad(["a", "b", "c"], ["str", { max: 2 }], /at most 2 items/);
  bad(["a", 1], ["str"], /\$\[1\]: expected string/);
  bad("nope", ["str"], /expected array/);

  const spec = { a: "int", "b?": { c: "str" }, d: ["bool"] };
  ok({ a: 1, d: [true] }, spec);
  ok({ a: 1, b: null, d: [] }, spec);
  ok({ a: 1, b: { c: "x" }, d: [] }, spec);
  bad({ a: 1, b: { c: 2 }, d: [] }, spec, /\$\.b\.c: expected string/);
  bad({ d: [] }, spec, /\$\.a: required/);
  bad({ a: 1, d: [], extra: 1 }, spec, /\$\.extra: unknown key/);
  bad({ a: 1, b: {} }, spec, /\$\.b\.c: required/);

  const map = { "*": { n: "int" }, fixed: "str" };
  ok({ fixed: "x", rishtapatra: { n: 1 }, kaatdo: { n: 0 } }, map);
  bad({ fixed: "x", kaatdo: { n: "1" } }, map, /\$\.kaatdo\.n: expected integer/);

  const r = validate({ a: "x" }, spec);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["$.a: expected integer", "$.d: required"]);
  assert.deepEqual(validate({ a: 1, d: [] }, spec), { ok: true, errors: [] });
});

// --- SOURCE_RE (review M3, plan D8) -------------------------------------------------------

test("SOURCE_RE accepts repo-relative pointers with ranges, comma lists and ' ; ' joins", () => {
  for (const cell of ["kaatdo/README.md:9-11", "kaatdo/web/index.html:21,34,445 ; kaatdo/README.md:3", "shubhpatra/src/lib/brand.ts:4-9", "vitae-os/public/favicon.svg:1", "shubhpatra/.agents/tasks/rishta-auth/design-brief.md:9"]) {
    assert.match(cell, SOURCE_RE, cell);
  }
});

test("SOURCE_RE rejects bare paths and comma-space joins (M3 negative fixtures)", () => {
  for (const cell of ["README.md:3", "a.md:3, b.md:4", "kaatdo/README.md", "kaatdo/README.md:", "kaatdo/README.md:3;kaatdo/README.md:4", "kaatdo/README.md:3 ; README.md:4", "kaatdo/README.md:a"]) {
    assert.doesNotMatch(cell, SOURCE_RE, cell);
  }
});

test("parseSource splits pointers, repo folder and ranges", () => {
  assert.deepEqual(parseSource("kaatdo/web/index.html:21,34,445 ; kaatdo/README.md:9-11"), [
    { path: "kaatdo/web/index.html", repo: "kaatdo", file: "web/index.html", ranges: [[21, 21], [34, 34], [445, 445]] },
    { path: "kaatdo/README.md", repo: "kaatdo", file: "README.md", ranges: [[9, 11]] },
  ]);
  assert.throws(() => parseSource("README.md:3"), SchemaError);
  assert.throws(() => parseSource("kaatdo/README.md:11-9"), /range end before start/);
});

// --- CONFIG_SPEC (§4.1, N3, §12) ---------------------------------------------------------

const PROVIDER = (secret, endpoint, extra = {}) => ({
  enabled: true,
  secret,
  endpoint,
  models: { "model-x": { inputPerMTok: 3, outputPerMTok: 15, maxOutputTokens: 8192 } },
  priceSource: "https://example.com/pricing",
  pricesVerifiedAt: "2026-10-10",
  ...extra,
});

function sampleConfig() {
  return {
    version: 1,
    company: { name: "Hoshlab", nameDevanagari: "होशलैब", owner: "Owner Name", ownerGithub: "Sudish007", timezone: "Asia/Kolkata" },
    site: { url: "https://sudish007.github.io/hoshlab", basePath: "/hoshlab/" },
    repo: { owner: "Sudish007", name: "hoshlab", branch: "main", mediaBranch: "media" },
    schedule: { engineCron: "0 0 * * *", engineLabel: "Daily 05:30 IST", publisherCron: "0 * * * *", publisherLabel: "Hourly at :30 IST", actionsDelayNote: "Actions cron may start 10–30 min late" },
    budget: { monthlyUsd: 25, warnAtPct: 80, hardStop: true },
    features: { reels: false },
    providers: {
      anthropic: PROVIDER("ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/messages", { apiVersion: "2023-06-01" }),
      gemini: PROVIDER("GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta"),
      openai: PROVIDER("OPENAI_API_KEY", "https://api.openai.com/v1/chat/completions"),
    },
    defaults: { leadDays: 3, backlogWeeks: 2, maxReworkLoops: 2, maxPublishAttempts: 3, minGapHours: 6, lateAfterHours: 6, expireAfterHours: 48, hashtagCap: 8, captionMax: 2200, altTextMax: 100 },
    ig: { host: "https://graph.instagram.com", version: "v24.0", pollIntervalMs: 5000, pollMaxMs: 300000 },
    pages: [
      {
        handle: "rishtapatra",
        prefix: "rp",
        displayName: "RishtaPatra · रिश्तापत्र",
        brand: "company/brands/rishtapatra.md",
        igUserId: "",
        tokenSecret: "IG_TOKEN_RISHTAPATRA",
        mode: "approve_first",
        modeChangedAt: "2026-10-10T00:00:00+05:30",
        modeChangedBy: "owner",
        languages: ["hi", "en"],
        formats: ["image", "carousel", "reel"],
        brandColor: "#7a1f2b",
        cadence: { slots: [{ dow: "mon", time: "19:30", format: "image" }, { dow: "wed", time: "19:30", format: "carousel" }] },
      },
      {
        handle: "job_rez",
        prefix: "jr",
        displayName: "JobRez",
        brand: "company/brands/jobrez.md",
        igUserId: "17841400000000000",
        appScopedId: "",
        tokenSecret: "IG_TOKEN_JOB_REZ",
        mode: "autopilot",
        modeChangedAt: "2026-10-10T00:00:00+05:30",
        modeChangedBy: "owner",
        languages: ["en"],
        formats: ["image", "carousel"],
        brandColor: "#7c3aed",
        cadence: { slots: [{ dow: "mon", time: "12:30", format: "image" }] },
      },
    ],
  };
}

test("CONFIG_SPEC accepts the §4.1 shape and rejects a config lacking features.reels (N3)", () => {
  const config = sampleConfig();
  assert.deepEqual(validate(config, CONFIG_SPEC), { ok: true, errors: [] });
  const noReels = sampleConfig();
  delete noReels.features.reels;
  assert.match(validate(noReels, CONFIG_SPEC).errors.join("\n"), /\$\.features\.reels: required/);
  const noFeatures = sampleConfig();
  delete noFeatures.features;
  assert.match(validate(noFeatures, CONFIG_SPEC).errors.join("\n"), /\$\.features: required/);
});

test("CONFIG_SPEC enforces the §12 rules: unique handles, ig.version, igUserId digits, 5-field crons, mode enum, budget range", () => {
  const dup = sampleConfig();
  dup.pages[1].handle = "rishtapatra";
  assert.match(validate(dup, CONFIG_SPEC).errors.join("\n"), /duplicate handle rishtapatra/);

  const ver = sampleConfig();
  ver.ig.version = "21.0";
  assert.match(validate(ver, CONFIG_SPEC).errors.join("\n"), /\$\.ig\.version/);

  const uid = sampleConfig();
  uid.pages[0].igUserId = "abc";
  assert.match(validate(uid, CONFIG_SPEC).errors.join("\n"), /\$\.pages\[0\]\.igUserId/);

  const cron = sampleConfig();
  cron.schedule.publisherCron = "30 * * *";
  assert.match(validate(cron, CONFIG_SPEC).errors.join("\n"), /\$\.schedule\.publisherCron/);

  const mode = sampleConfig();
  mode.pages[0].mode = "manual";
  assert.match(validate(mode, CONFIG_SPEC).errors.join("\n"), /\$\.pages\[0\]\.mode/);

  const budget = sampleConfig();
  budget.budget.monthlyUsd = 0;
  assert.match(validate(budget, CONFIG_SPEC).errors.join("\n"), /\$\.budget\.monthlyUsd/);

  const fmt = sampleConfig();
  fmt.pages[1].cadence.slots[0].format = "reel";
  assert.match(validate(fmt, CONFIG_SPEC).errors.join("\n"), /format: reel not in page formats/);

  const eight = sampleConfig();
  eight.pages[0].cadence.slots = Array.from({ length: 8 }, () => ({ dow: "mon", time: "10:00", format: "image" }));
  assert.match(validate(eight, CONFIG_SPEC).errors.join("\n"), /at most 7 items/);

  const price = sampleConfig();
  delete price.providers.gemini.pricesVerifiedAt;
  assert.match(validate(price, CONFIG_SPEC).errors.join("\n"), /\$\.providers\.gemini\.pricesVerifiedAt: required/);
});

// --- ROSTER_SPEC (§4.2) ------------------------------------------------------------------

function sampleRoster() {
  const llm = (name, group, provider, schedule, fallback = []) => ({ name, group, kind: "llm", provider, model: "model-x", fallback, temperature: 0.4, charter: `company/charters/${name}.md`, schedule, never: ["something"] });
  const det = (name, group, schedule) => ({ name, group, kind: "deterministic", charter: `company/charters/${name}.md`, schedule, never: ["something"] });
  return {
    version: 1,
    agents: [
      { ...llm("ceo", "leadership", "anthropic", "weekly-monday", ["openai", "gemini"]), title: "Chief Executive", maxOutputTokens: 4000 },
      llm("hr", "leadership", "gemini", "monthly-1st", ["anthropic"]),
      llm("strategist", "studio", "openai", "daily"),
      llm("writer", "studio", "anthropic", "daily"),
      det("designer", "studio", "daily"),
      llm("qa", "studio", "gemini", "daily"),
      det("publisher", "operations", "hourly"),
      llm("analyst", "operations", "openai", "weekly-sunday"),
    ],
  };
}

test("ROSTER_SPEC: eight fixed names, kind enum, never[] non-empty, qa/publisher cannot be disabled", () => {
  const roster = sampleRoster();
  assert.deepEqual(validate(roster, ROSTER_SPEC, sampleConfig()), { ok: true, errors: [] });

  const seven = sampleRoster();
  seven.agents.pop();
  assert.match(validate(seven, ROSTER_SPEC).errors.join("\n"), /at least 8 items/);

  const renamed = sampleRoster();
  renamed.agents[7].name = "intern";
  assert.match(validate(renamed, ROSTER_SPEC).errors.join("\n"), /\$\.agents\[7\]\.name: expected one of/);

  const dup = sampleRoster();
  dup.agents[7].name = "writer";
  const errs = validate(dup, ROSTER_SPEC).errors.join("\n");
  assert.match(errs, /duplicate agent writer/);
  assert.match(errs, /missing agent analyst/);

  const never = sampleRoster();
  never.agents[3].never = [];
  assert.match(validate(never, ROSTER_SPEC).errors.join("\n"), /\$\.agents\[3\]\.never: expected at least 1 item/);

  const qaOff = sampleRoster();
  qaOff.agents[5].enabled = false;
  assert.match(validate(qaOff, ROSTER_SPEC).errors.join("\n"), /qa cannot be disabled/);

  const kind = sampleRoster();
  kind.agents[4].kind = "human";
  assert.match(validate(kind, ROSTER_SPEC).errors.join("\n"), /\$\.agents\[4\]\.kind/);

  const badModel = sampleRoster();
  badModel.agents[3].model = "model-y";
  assert.match(validate(badModel, ROSTER_SPEC, sampleConfig()).errors.join("\n"), /model-y not in providers\.anthropic\.models/);

  const disabledProvider = sampleConfig();
  disabledProvider.providers.openai.enabled = false;
  assert.match(validate(sampleRoster(), ROSTER_SPEC, disabledProvider).errors.join("\n"), /openai is not an enabled provider/);
});

// --- Records (§4.4–4.14, M5) -------------------------------------------------------------

function sampleDraft() {
  return {
    id: "rp-2026-10-14-kundali-free",
    page: "rishtapatra",
    ideaId: "rp-i0031",
    slotId: "rishtapatra-2026-10-14-1930",
    slotAt: "2026-10-14T19:30:00+05:30",
    format: "image",
    language: "hi",
    status: "queued",
    revision: 2,
    reworkCount: 1,
    mock: true,
    createdAt: "2026-10-12T05:35:00+05:30",
    updatedAt: "2026-10-12T05:36:00+05:30",
    by: "writer",
    runId: "engine-daily-20261012-0001-a1b2c3",
    caption: "कुंडली — free, on your device.",
    hashtags: ["#RishtaPatra", "#JanamKundali"],
    altText: "Card with the headline Free Janam Kundali",
    artwork: { headline: "Free Janam Kundali", subline: "Computed on your device", facts: ["North Indian method"], footer: "rishtapatra.com", variant: "A" },
    factsUsed: [{ factId: "rp-f07", quote: "North Indian method" }],
    writerNote: "leads with the free product",
    media: [
      {
        kind: "image",
        path: "media/rp-2026-10-14-kundali-free/image-1-3fa9c2d1.jpg",
        bytes: 141203,
        width: 1080,
        height: 1350,
        sha256: "3fa9c2d1".repeat(8),
        rawUrl: "https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/rp-2026-10-14-kundali-free/image-1-3fa9c2d1.jpg",
        pagesUrl: "https://sudish007.github.io/hoshlab/media/rp-2026-10-14-kundali-free/image-1-3fa9c2d1.jpg",
      },
    ],
    publishAttempts: [{ at: "2026-10-14T20:01:00+05:30", ok: false, stage: "container", code: 9004, message: "fetch failed" }],
    qaRef: "drafts/rp-2026-10-14-kundali-free/qa.json",
  };
}

test("DRAFT_SPEC: M5 lifecycle enum incl. rejected/expired, reel shape, caps", () => {
  const draft = sampleDraft();
  assert.deepEqual(validate(draft, DRAFT_SPEC), { ok: true, errors: [] });
  for (const status of ["written", "rendered", "queued", "rework", "blocked", "published", "failed", "rejected", "expired"]) ok({ ...draft, status }, DRAFT_SPEC);
  bad({ ...draft, status: "planned" }, DRAFT_SPEC, /\$\.status/);
  bad({ ...draft, caption: "x".repeat(2201) }, DRAFT_SPEC, /\$\.caption: longer than 2200/);
  bad({ ...draft, hashtags: ["no-hash"] }, DRAFT_SPEC, /\$\.hashtags\[0\]/);
  ok({ ...draft, format: "reel", reel: { style: "kinetic", durationSec: 18, scenes: [{ text: "a", seconds: 4 }, { text: "b", seconds: 4 }, { text: "c", seconds: 4 }] } }, DRAFT_SPEC);
  bad({ ...draft, reel: { style: "slides", durationSec: 18, scenes: [{ text: "a", seconds: 4 }, { text: "b", seconds: 4 }, { text: "c", seconds: 4 }] } }, DRAFT_SPEC, /\$\.reel\.style/);
  bad({ ...draft, reel: { style: "capture", durationSec: 18, scenes: [{ text: "a", seconds: 4 }] } }, DRAFT_SPEC, /\$\.reel\.scenes: expected at least 3/);
  const { mock, ...noMock } = draft;
  bad(noMock, DRAFT_SPEC, /\$\.mock: required/);
  ok({ ...draft, renderError: "overflow in headline", designNote: "variant B", status: "written", media: [] }, DRAFT_SPEC);
});

test("CALENDAR_SPEC slot statuses and nullable draftId; IDEA_SPEC status + attempts", () => {
  const slot = { slotId: "rishtapatra-2026-10-14-1930", page: "rishtapatra", at: "2026-10-14T19:30:00+05:30", format: "image", ideaId: "rp-i0031", draftId: null, status: "planned", reason: "memo 2026-W42 priority 1" };
  ok({ generatedAt: "2026-10-12T05:33:00+05:30", horizonDays: 14, slots: [slot] }, CALENDAR_SPEC);
  for (const status of ["planned", "written", "rendered", "queued", "rework", "blocked", "published", "rejected", "expired", "failed", "dropped"]) ok({ generatedAt: "2026-10-12T05:33:00+05:30", horizonDays: 14, slots: [{ ...slot, status }] }, CALENDAR_SPEC);
  bad({ generatedAt: "2026-10-12T05:33:00+05:30", horizonDays: 14, slots: [{ ...slot, status: "scheduled" }] }, CALENDAR_SPEC, /\$\.slots\[0\]\.status/);

  const idea = { id: "rp-i0031", page: "rishtapatra", title: "Free Janam Kundali", angle: "lead with the free product", format: "image", language: "hi", facts: ["rp-f07"], status: "open", attempts: 0, createdAt: "2026-10-12T05:31:00+05:30", by: "strategist", runId: "engine-daily-20261012-0001-a1b2c3" };
  ok(idea, IDEA_SPEC);
  bad({ ...idea, status: "archived" }, IDEA_SPEC, /\$\.status/);
  bad({ ...idea, title: "x".repeat(121) }, IDEA_SPEC, /\$\.title: longer than 120/);
  const { attempts, ...noAttempts } = idea;
  bad(noAttempts, IDEA_SPEC, /\$\.attempts: required/);
});

test("APPROVAL_SPEC: revision required (M5), reject needs a reason ≤ 500", () => {
  const approve = { draftId: "rp-2026-10-14-kundali-free", decision: "approve", revision: 2, at: "2026-10-13T09:00:00+05:30", by: "owner" };
  assert.deepEqual(validate(approve, APPROVAL_SPEC), { ok: true, errors: [] });
  const { revision, ...noRev } = approve;
  assert.match(validate(noRev, APPROVAL_SPEC).errors.join("\n"), /\$\.revision: required/);
  assert.match(validate({ ...approve, decision: "reject" }, APPROVAL_SPEC).errors.join("\n"), /\$\.reason: required for reject/);
  assert.match(validate({ ...approve, decision: "reject", reason: "no" }, APPROVAL_SPEC).errors.join("\n"), /\$\.reason: required for reject/);
  assert.equal(validate({ ...approve, decision: "reject", reason: "Too salesy." }, APPROVAL_SPEC).ok, true);
  assert.match(validate({ ...approve, decision: "reject", reason: "x".repeat(501) }, APPROVAL_SPEC).errors.join("\n"), /\$\.reason: longer than 500/);
});

test("STATUS_SPEC: lastRuns ≤ 20 (M9), flag grammar, USAGE_SPEC mock flag, RUN_SPEC", () => {
  const run = { id: "engine-daily-20261012-0001-a1b2c3", workflow: "engine-daily", trigger: "schedule", startedAt: "2026-10-12T05:30:00+05:30", endedAt: "2026-10-12T05:36:00+05:30", ok: true, agents: [{ name: "strategist", ok: true, ms: 9120, calls: 3, costUsd: 0.04, note: "6 ideas, 9 slots" }], changed: ["company/state/calendar.json"], errors: [], budgetUsedUsd: 4.12 };
  ok(run, RUN_SPEC);
  bad({ ...run, trigger: "cron" }, RUN_SPEC, /\$\.trigger/);

  const status = {
    updatedAt: "2026-10-12T05:36:00+05:30",
    lastRun: { id: run.id, workflow: "engine-daily", ok: true, at: run.endedAt },
    lastRuns: [run],
    queue: { rishtapatra: 3, kaatdo: 1, job_rez: 1 },
    blocked: { job_rez: 1 },
    budget: { month: "2026-10", usedUsd: 4.12, limitUsd: 25, exhausted: false },
    pages: { rishtapatra: { mode: "approve_first", tokenState: "ok", tokenExpiresAt: null, lastPublishedAt: "2026-10-10T19:31:12+05:30" } },
    flags: ["budget_warn", "token_invalid:job_rez", "token_expiring:kaatdo", "render_failed", "provider_down:gemini", "media_branch_missing", "publish_failed:rp-2026-10-14-kundali-free", "budget_exhausted"],
  };
  ok(status, STATUS_SPEC);
  ok({ ...status, lastRun: null, lastRuns: [], queue: {}, blocked: {}, pages: {}, flags: [] }, STATUS_SPEC);
  bad({ ...status, lastRuns: Array.from({ length: 21 }, () => run) }, STATUS_SPEC, /\$\.lastRuns: expected at most 20/);
  bad({ ...status, flags: ["token_invalid"] }, STATUS_SPEC, /\$\.flags\[0\]/);
  bad({ ...status, flags: ["provider_down:mock"] }, STATUS_SPEC, /\$\.flags\[0\]/);
  bad({ ...status, budget: { month: "2026-13", usedUsd: 0, limitUsd: 25, exhausted: false } }, STATUS_SPEC, /\$\.budget\.month/);

  const usage = { at: "2026-10-12T05:31:00+05:30", runId: run.id, agent: "writer", page: "rishtapatra", provider: "anthropic", model: "model-x", inputTokens: 5120, outputTokens: 880, costUsd: 0.0286, ms: 4210, ok: true, error: null, mock: false };
  ok(usage, USAGE_SPEC);
  const { mock, ...noMock } = usage;
  bad(noMock, USAGE_SPEC, /\$\.mock: required/);
  ok({ ...usage, ok: false, error: "429 rate limited", mock: true, costUsd: 0 }, USAGE_SPEC);
});

test("every exported spec is well-formed (converts to both provider dialects or is a map/obj spec)", () => {
  for (const [kind, spec] of Object.entries(SPECS)) {
    assert.doesNotThrow(() => toJsonSchema(spec, "gemini"), `${kind} → gemini`);
    assert.doesNotThrow(() => toJsonSchema(spec, "prompt"), `${kind} → prompt`);
  }
});

// --- toJsonSchema (review M7, plan D10) -------------------------------------------------

const NESTED = {
  verdict: "enum[pass|fail]",
  toneScore: "int[1..5]",
  claims: [{ claim: "str<=200", "factId?": "id", ok: "bool" }, { min: 1 }],
  "notes?": "str",
  "retry?": { reason: "str", count: "int" },
  reasons: ["str"],
};

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === "object") {
    visit(node);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

test("toJsonSchema gemini: only type/properties/required/items/enum/nullable, no additionalProperties anywhere", () => {
  const schema = toJsonSchema(NESTED, "gemini");
  const allowed = new Set(["type", "properties", "required", "items", "enum", "nullable"]);
  walk(schema, (node) => {
    assert.equal("additionalProperties" in node, false, JSON.stringify(node));
    if ("type" in node || "properties" in node) for (const k of Object.keys(node)) assert.ok(allowed.has(k), `unexpected key ${k} in ${JSON.stringify(node)}`);
  });
  assert.deepEqual(schema.required, ["verdict", "toneScore", "claims", "reasons"]);
  assert.equal(schema.properties.notes.nullable, true);
  assert.equal(schema.properties.retry.nullable, true);
  assert.equal(schema.properties.retry.type, "object");
  assert.deepEqual(schema.properties.verdict, { type: "string", enum: ["pass", "fail"] });
  assert.deepEqual(schema.properties.claims.items.required, ["claim", "ok"]);
  assert.deepEqual(schema.properties.claims.items.properties.factId, { type: "string", nullable: true });
});

test("toJsonSchema openai: every object lists all properties in required with additionalProperties:false; optional → [T,'null']", () => {
  const schema = toJsonSchema(NESTED, "openai");
  walk(schema, (node) => {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, JSON.stringify(node));
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), JSON.stringify(node));
    }
    assert.equal("nullable" in node, false);
  });
  assert.deepEqual(schema.properties.notes, { type: ["string", "null"] });
  assert.deepEqual(schema.properties.toneScore, { type: "integer" });
  assert.deepEqual(schema.properties.claims.items.properties.factId, { type: ["string", "null"] });
  assert.deepEqual(schema.properties.claims.minItems, 1);
  assert.deepEqual(schema.properties.retry.anyOf[1], { type: "null" });
  assert.equal(schema.properties.retry.anyOf[0].additionalProperties, false);
  assert.deepEqual(schema.properties.retry.anyOf[0].required, ["reason", "count"]);
  assert.throws(() => toJsonSchema({ raw: "obj" }, "openai"), /not representable in the OpenAI strict dialect/);
  assert.throws(() => toJsonSchema({ "*": "int" }, "openai"), /map specs/);
});

test("toJsonSchema prompt: a pretty JSON example string", () => {
  const text = toJsonSchema(NESTED, "prompt");
  assert.equal(typeof text, "string");
  const example = JSON.parse(text);
  assert.equal(example.verdict, "pass|fail");
  assert.equal(example.toneScore, 1);
  assert.deepEqual(example.reasons, ["string"]);
  assert.equal(example.claims[0].claim, "string (max 200 characters)");
  assert.ok(text.includes("\n  "), "pretty-printed");
  assert.throws(() => toJsonSchema(NESTED, "yaml"), /unknown dialect/);
});
