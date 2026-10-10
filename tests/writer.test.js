// engine/agents/writer.js — new drafts (status written, revision 1), rework (revision + 1, reworkCount
// untouched: QA owns it), the task JSON (QA reasons, last 10 captions, usable facts only), invalid output
// after the router's single repair call → invalid_output (design §3.1 step 5, §4.6, §5, §11, §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { DRAFT_SPEC, USAGE_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { codePoints, fullCaption, runChecks } from "../engine/lib/checks.js";
import { AgentOutputError, BudgetExhaustedError, createRouter } from "../engine/llm/router.js";
import { AGENT, DEFAULT_CAPS, INVALID_OUTPUT_REASON, OUTPUT_SPEC, RECENT_CAPTIONS, buildTask, capsOf, draftFromOutput, formatSpecText, outputSpec, runWriter, validateWriterOutput } from "../engine/agents/writer.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster, brands, charters } = company;
const NOW = "2026-10-12T05:40:00+05:30";
const RUN_ID = "engine-daily-20261012-0531-abc123";
const SECRET_NAMES = Object.values(config.providers).map((p) => p.secret);
const FIX = join(ROOT, "tests", "fixtures");
const JPEG = new Uint8Array(readFileSync(join(FIX, "media", "fixture-1080x1350.jpg")));
const llm = (name) => JSON.parse(readFileSync(join(FIX, "llm", `${name}.json`), "utf8"));
const pageOf = (handle) => config.pages.find((p) => p.handle === handle);
const RP = pageOf("rishtapatra");
const KD = pageOf("kaatdo");
const JR = pageOf("job_rez");

const SLOTS = {
  rpImage: { slotId: "rishtapatra-2026-10-12-1930", page: "rishtapatra", at: "2026-10-12T19:30:00+05:30", format: "image", status: "planned", ideaId: "rp-i0001" },
  rpCarousel: { slotId: "rishtapatra-2026-10-14-1930", page: "rishtapatra", at: "2026-10-14T19:30:00+05:30", format: "carousel", status: "planned", ideaId: "rp-i0002" },
  kdImage: { slotId: "kaatdo-2026-10-13-0815", page: "kaatdo", at: "2026-10-13T08:15:00+05:30", format: "image", status: "planned", ideaId: "kd-i0001" },
  kdCarousel: { slotId: "kaatdo-2026-10-17-1100", page: "kaatdo", at: "2026-10-17T11:00:00+05:30", format: "carousel", status: "planned", ideaId: "kd-i0003" },
  jrImage: { slotId: "job_rez-2026-10-12-1230", page: "job_rez", at: "2026-10-12T12:30:00+05:30", format: "image", status: "planned", ideaId: "jr-i0001" },
  jrCarousel: { slotId: "job_rez-2026-10-14-1230", page: "job_rez", at: "2026-10-14T12:30:00+05:30", format: "carousel", status: "planned", ideaId: "jr-i0003" },
};
const IDEAS = {
  rp: { id: "rp-i0001", page: "rishtapatra", title: "Free kundali, no account", angle: "Lead with the free product.", hook: "मुफ़्त जन्म कुंडली — अपने डिवाइस पर।", format: "image", language: "hi", facts: ["rp-f04", "rp-f07", "rp-f05"], status: "scheduled", attempts: 0, createdAt: "2026-10-12T05:31:00+05:30", by: "strategist", runId: RUN_ID },
  kd: { id: "kd-i0001", page: "kaatdo", title: "Six rules one kill switch", angle: "Name the six rules.", hook: "Six rules. One kill switch.", format: "image", language: "en", facts: ["kd-f04", "kd-f05"], status: "scheduled", attempts: 0, createdAt: "2026-10-12T05:31:00+05:30", by: "strategist", runId: RUN_ID },
  jr: { id: "jr-i0001", page: "job_rez", title: "Nine templates three free", angle: "List the templates.", hook: "Nine templates. Three are free.", format: "image", language: "en", facts: ["jr-f10", "jr-f09"], status: "scheduled", attempts: 0, createdAt: "2026-10-12T05:31:00+05:30", by: "strategist", runId: RUN_ID },
};

function harness({ now = NOW, processEnv = { MOCK_LLM: "1" }, fixturesDir } = {}) {
  const dir = tmpDir("hoshlab-writer-");
  const state = createState({ companyDir: dir, now });
  const router = createRouter({ config, roster, state, env: readEnv(SECRET_NAMES, {}), fetchImpl: () => Promise.reject(new Error("no network in tests")), now, runId: RUN_ID, charters, processEnv, fixturesDir });
  return { dir, state, router, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A router stand-in that returns a fixture output (or throws `fail`) and records the call.
function fakeRouter(output, { fail } = {}) {
  const calls = [];
  return {
    calls,
    runId: RUN_ID,
    async complete(agent, args) {
      calls.push({ agent, args });
      if (fail) throw fail;
      return { json: structuredClone(output), text: JSON.stringify(output), usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, provider: "mock", model: "mock", ms: 1, mock: true, calls: 1, repaired: false, raw: {}, failures: [] };
    },
  };
}

function mediaFor(draft) {
  const n = draft.format === "carousel" ? draft.slides.length : 1;
  return Array.from({ length: n }, () => ({ kind: "image", bytes: JPEG, width: 1080, height: 1350 }));
}

test("new draft under MOCK_LLM=1 (rp image slot): id <prefix>-<slot date>-<slug>, status written, revision 1, reworkCount 0, mock true, artwork kept and slides dropped, DRAFT_SPEC valid, one usage line", async () => {
  const h = harness();
  try {
    const res = await runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state: h.state, router: h.router, now: NOW, runId: RUN_ID });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.modelCalled, true);
    assert.equal(res.mock, true);
    assert.equal(res.calls, 1);
    assert.equal(res.repaired, false);
    const d = res.draft;
    assert.equal(d.id, "rp-2026-10-12-free-kundali-no-account");
    assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] });
    assert.deepEqual(h.state.readDraft(d.id), d, "written to drafts/<id>/draft.json");
    assert.equal(d.page, "rishtapatra");
    assert.equal(d.ideaId, "rp-i0001");
    assert.equal(d.slotId, SLOTS.rpImage.slotId);
    assert.equal(d.slotAt, SLOTS.rpImage.at);
    assert.equal(d.format, "image");
    assert.equal(d.language, "hi");
    assert.equal(d.status, "written");
    assert.equal(d.revision, 1);
    assert.equal(d.reworkCount, 0);
    assert.equal(d.mock, true, "mock from the router result");
    assert.equal(d.createdAt, NOW);
    assert.equal(d.updatedAt, NOW);
    assert.equal(d.by, AGENT);
    assert.equal(d.runId, RUN_ID);
    const fx = llm("writer.ok").output;
    assert.equal(d.caption, fx.caption);
    assert.deepEqual(d.hashtags, fx.hashtags);
    assert.equal(d.altText, fx.altText);
    assert.deepEqual(d.artwork, fx.artwork, "image: artwork kept (the Designer adds the variant)");
    assert.equal(d.slides, undefined, "image: the fixture's slides are dropped");
    assert.equal(d.altTexts, undefined);
    assert.equal(d.reel, undefined);
    assert.deepEqual(d.factsUsed, fx.factsUsed);
    assert.equal(d.writerNote, fx.writerNote);
    assert.deepEqual(d.media, []);
    assert.deepEqual(d.publishAttempts, []);
    assert.equal(d.qaReasons, undefined);
    assert.equal(d.qaRef, undefined);
    const usage = h.state.readJsonl(h.state.monthLogPath("usage"));
    assert.equal(usage.length, 1);
    assert.equal(validate(usage[0], USAGE_SPEC).ok, true);
    assert.equal(usage[0].agent, AGENT);
    assert.equal(usage[0].page, "rishtapatra");
    assert.equal(usage[0].mock, true);
    // a second draft with the same title on the same date is de-duplicated with -2
    const again = await runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state: h.state, router: h.router, now: NOW, runId: RUN_ID });
    assert.equal(again.draft.id, "rp-2026-10-12-free-kundali-no-account-2");
    assert.deepEqual(h.state.listDrafts(), ["rp-2026-10-12-free-kundali-no-account", "rp-2026-10-12-free-kundali-no-account-2"]);
  } finally {
    h.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("carousel slot: slides kept with one altText per slide (altTexts[]), artwork dropped; page-keyed fixtures answer kaatdo and job_rez; every draft validates and passes runChecks against the real brand", async () => {
  const h = harness();
  try {
    const cases = [
      [SLOTS.rpCarousel, { ...IDEAS.rp, id: "rp-i0002", title: "Biodata in seven steps", format: "carousel" }, brands.rishtapatra, RP, "writer.ok"],
      [SLOTS.kdImage, IDEAS.kd, brands.kaatdo, KD, "writer.ok.kaatdo"],
      [SLOTS.kdCarousel, { ...IDEAS.kd, id: "kd-i0003", title: "What the switch cannot do", format: "carousel" }, brands.kaatdo, KD, "writer.ok.kaatdo"],
      [SLOTS.jrImage, IDEAS.jr, brands.job_rez, JR, "writer.ok.job_rez"],
      [SLOTS.jrCarousel, { ...IDEAS.jr, id: "jr-i0003", title: "Six layout rules", format: "carousel" }, brands.job_rez, JR, "writer.ok.job_rez"],
    ];
    for (const [slot, idea, brand, page, fixture] of cases) {
      const res = await runWriter({ slot, idea, brand, page, config, state: h.state, router: h.router, now: NOW, runId: RUN_ID });
      assert.equal(res.ok, true, `${slot.slotId}`);
      const d = res.draft;
      assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] }, d.id);
      const fx = llm(fixture).output;
      assert.equal(d.caption, fx.caption, `${d.id}: page-keyed fixture`);
      if (slot.format === "carousel") {
        assert.deepEqual(d.slides, fx.slides);
        assert.deepEqual(d.altTexts, fx.slides.map((s) => s.altText), "one alt text per slide");
        assert.equal(d.artwork, undefined, "carousel: artwork dropped");
        assert.ok(d.slides.length >= 2 && d.slides.length <= 10);
      } else {
        assert.deepEqual(d.artwork, fx.artwork);
        assert.equal(d.slides, undefined);
      }
      const checks = runChecks(d, brand, { config, media: mediaFor(d) });
      assert.equal(checks.passed, true, `${d.id}: ${checks.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join(" | ")}`);
    }
    assert.equal(h.state.listDrafts().length, 5);
    assert.ok(h.state.listDrafts().includes("jr-2026-10-14-six-layout-rules"));
  } finally {
    h.cleanup();
  }
});

test("rework: revision + 1, status written, reworkCount untouched (QA owns the counter), qaReasons cleared, old media dropped, identity and publishAttempts kept", async () => {
  const h = harness();
  try {
    const first = (await runWriter({ slot: SLOTS.kdImage, idea: IDEAS.kd, brand: brands.kaatdo, page: KD, config, state: h.state, router: h.router, now: NOW, runId: RUN_ID })).draft;
    // what QA leaves behind after a failed revision (FEAT-104): status rework, reworkCount 1, qaReasons, qaRef, media
    const sentBack = {
      ...first,
      status: "rework",
      reworkCount: 1,
      qaReasons: ["disclaimer: always: missing not registered with SEBI | not SEBI-registered"],
      qaRef: `drafts/${first.id}/qa.json`,
      updatedAt: "2026-10-12T05:50:00+05:30",
      media: [{ kind: "image", path: `media/${first.id}/image-1-7cfbae6d.jpg`, bytes: 9432, width: 1080, height: 1350, sha256: "7cfbae6d41f17cb1b34897046134304f36529e6e223ea96756052d2a70958af1", rawUrl: "https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/x/image-1-7cfbae6d.jpg", pagesUrl: "https://sudish007.github.io/hoshlab/media/x/image-1-7cfbae6d.jpg" }],
      publishAttempts: [{ at: "2026-10-12T05:55:00+05:30", ok: false, stage: "skip", message: "not yet" }],
    };
    h.state.writeDraft(sentBack);
    const later = "2026-10-13T05:40:00+05:30";
    const res = await runWriter({ slot: SLOTS.kdImage, idea: IDEAS.kd, brand: brands.kaatdo, page: KD, config, state: h.state, router: h.router, draft: sentBack, now: later, runId: "engine-daily-20261013-0531-def456" });
    assert.equal(res.ok, true);
    assert.equal(res.created, false);
    const d = res.draft;
    assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] });
    assert.deepEqual(h.state.readDraft(first.id), d);
    assert.equal(d.id, first.id, "same draft");
    assert.equal(d.revision, 2, "revision bumped");
    assert.equal(d.reworkCount, 1, "QA already counted this loop; the Writer leaves it");
    assert.equal(d.status, "written");
    assert.equal(d.qaReasons, undefined, "consumed");
    assert.deepEqual(d.media, [], "stale media dropped; the Designer re-renders");
    assert.equal(d.createdAt, NOW);
    assert.equal(d.updatedAt, later);
    assert.equal(d.runId, "engine-daily-20261013-0531-def456");
    assert.equal(d.by, AGENT);
    assert.deepEqual(d.publishAttempts, sentBack.publishAttempts);
    assert.equal(d.qaRef, sentBack.qaRef, "qa.json of the previous revision stays referenced (QA_SPEC carries revision)");
    assert.equal(d.ideaId, first.ideaId);
    assert.equal(d.slotId, first.slotId);
    assert.equal(h.state.listDrafts().length, 1);
    // the pure builder agrees
    const pure = draftFromOutput({ output: llm("writer.ok.kaatdo").output, slot: SLOTS.kdImage, idea: IDEAS.kd, page: KD, existing: sentBack, now: later, runId: d.runId, mock: true });
    assert.deepEqual(pure, d);
  } finally {
    h.cleanup();
  }
});

test("task JSON on rework: QA reasons and the previous output are in `rework`, only the last 10 captions are offered, usable facts only, the format spec text carries the live caps", async () => {
  const router = fakeRouter(llm("writer.ok.kaatdo").output);
  const dir = tmpDir("hoshlab-writer-task-");
  try {
    const state = createState({ companyDir: dir, now: NOW });
    const existing = { ...draftFromOutput({ output: llm("writer.ok.kaatdo").output, slot: SLOTS.kdImage, idea: IDEAS.kd, page: KD, now: NOW, runId: RUN_ID, mock: true }), status: "rework", reworkCount: 1, qaReasons: ["disclaimer: always: missing not registered with SEBI | not SEBI-registered", 'claim without a fact id: "x"'] };
    const captions = Array.from({ length: 12 }, (_, i) => `caption ${i + 1}`);
    await runWriter({ slot: SLOTS.kdImage, idea: IDEAS.kd, brand: brands.kaatdo, page: KD, config, state, router, draft: existing, recentCaptions: captions, now: NOW, runId: RUN_ID, feedbackDigest: "owner: shorter" });
    assert.equal(router.calls.length, 1);
    const { agent, args } = router.calls[0];
    assert.equal(agent, AGENT);
    assert.deepEqual(args.spec, outputSpec(capsOf(config)));
    assert.equal(args.context.brand, brands.kaatdo);
    assert.equal(args.context.page, KD);
    assert.equal(args.context.feedbackDigest, "owner: shorter");
    assert.equal(typeof args.validate, "function");
    const task = args.task;
    assert.deepEqual(task.rework.reasons, existing.qaReasons);
    assert.equal(task.rework.revision, 1);
    assert.equal(task.rework.previous.caption, existing.caption);
    assert.deepEqual(task.rework.previous.factsUsed, existing.factsUsed);
    assert.equal(task.rework.previous.status, undefined, "lifecycle fields stay out");
    assert.equal(RECENT_CAPTIONS, 10);
    assert.deepEqual(task.recentCaptions, captions.slice(-10), "last 10 of 12");
    assert.deepEqual(task.idea, { id: "kd-i0001", title: "Six rules one kill switch", angle: "Name the six rules.", format: "image", language: "en", factIds: ["kd-f04", "kd-f05"], hook: "Six rules. One kill switch." });
    assert.deepEqual(task.slot, { slotId: SLOTS.kdImage.slotId, at: SLOTS.kdImage.at, format: "image" });
    assert.deepEqual(task.page, { handle: "kaatdo", languages: ["en"], emoji: "none", site: "https://kaatdo.com" });
    assert.equal(task.format.name, "image");
    assert.equal(task.format.caps.captionMax, 2200);
    assert.equal(task.format.caps.altTextMax, 100);
    assert.equal(task.format.spec, formatSpecText("image", capsOf(config)));
    assert.match(task.format.spec, /artwork\.headline ≤ 60 characters/);
    assert.match(task.format.spec, /caption ≤ 2200 characters including the hashtag line; ≤ 8 hashtags/);
    assert.match(task.format.spec, /altText ≤ 100 characters/);
    assert.match(formatSpecText("carousel", capsOf(config)), /3–7 slides \(the engine accepts 2–10\), each heading ≤ 40 and body ≤ 160/);
    assert.match(formatSpecText("reel"), /3–6 scenes of ≤ 60 characters, 3–5 seconds each/);
    assert.ok(task.brand.facts.some((f) => f.id === "kd-f04"));
    assert.ok(task.brand.facts.every((f) => typeof f.fact === "string"));
    assert.ok(task.brand.pricing.some((p) => p.sku === "monthly"));
    assert.equal(task.brand.disclaimers.length, 1);
    assert.deepEqual(task.brand.allowedDomains, ["kaatdo.com"]);
    assert.equal(task.feedback, "owner: shorter");
    // a fresh draft has no rework block and no reasons
    const fresh = buildTask({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, recentCaptions: [{ caption: "a" }, "b"] });
    assert.equal(fresh.rework, null);
    assert.deepEqual(fresh.recentCaptions, ["a", "b"]);
    assert.ok(!fresh.brand.facts.some((f) => f.id === "rp-f12"), "disputed fact never offered (P1-04)");
    // when qaReasons are not passed they are taken from the draft
    const r2 = fakeRouter(llm("writer.ok.kaatdo").output);
    await runWriter({ slot: SLOTS.kdImage, idea: IDEAS.kd, brand: brands.kaatdo, page: KD, config, state, router: r2, draft: existing, now: NOW });
    assert.deepEqual(r2.calls[0].args.task.rework.reasons, existing.qaReasons);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer.bad (2,300-char caption) → the real router makes exactly one repair call → AgentOutputError → result invalid_output; a new slot writes nothing, a rework draft stays rework with the reason recorded", async () => {
  assert.equal(codePoints(llm("writer.bad").output.caption), 2300);
  const h = harness({ processEnv: { MOCK_LLM: "1", MOCK_LLM_CASE_WRITER: "bad" } });
  try {
    const res = await runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state: h.state, router: h.router, now: NOW, runId: RUN_ID });
    assert.equal(res.ok, false);
    assert.equal(res.reason, INVALID_OUTPUT_REASON);
    assert.equal(INVALID_OUTPUT_REASON, "invalid_output");
    assert.ok(res.error instanceof AgentOutputError, String(res.error));
    assert.equal(res.error.agent, AGENT);
    assert.equal(res.error.calls, 2, "first answer + exactly one repair call");
    assert.equal(res.error.provider, "mock");
    assert.ok(res.error.errors.some((x) => /\$\.caption: longer than 2200 characters \(2300\)/.test(x)), res.error.errors.join("; "));
    assert.equal(res.draft, null);
    assert.equal(res.created, false);
    assert.equal(res.modelCalled, true);
    assert.deepEqual(h.state.listDrafts(), [], "nothing written for a new slot");
    assert.equal(h.state.readJsonl(h.state.monthLogPath("usage")).length, 2, "both attempts are usage lines");

    // rework: the existing draft stays `rework` with the reason invalid_output; revision and reworkCount untouched
    const existing = { ...draftFromOutput({ output: llm("writer.ok").output, slot: SLOTS.rpImage, idea: IDEAS.rp, page: RP, now: NOW, runId: RUN_ID, mock: true }), status: "rework", reworkCount: 1, qaReasons: ["tone score 2 below 3", "invalid_output: stale from an earlier failure"] };
    h.state.writeDraft(existing);
    const res2 = await runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state: h.state, router: h.router, draft: existing, now: "2026-10-13T05:40:00+05:30", runId: RUN_ID });
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, INVALID_OUTPUT_REASON);
    const d = h.state.readDraft(existing.id);
    assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(d.status, "rework");
    assert.equal(d.revision, 1);
    assert.equal(d.reworkCount, 1);
    assert.equal(d.caption, existing.caption, "the previous revision is untouched");
    assert.equal(d.updatedAt, "2026-10-13T05:40:00+05:30");
    assert.equal(d.qaReasons.length, 2, "QA's reason kept, the stale invalid_output replaced by this run's");
    assert.equal(d.qaReasons[0], "tone score 2 below 3");
    assert.match(d.qaReasons[1], /^invalid_output: \$\.caption: longer than 2200 characters \(2300\)/);
    assert.deepEqual(res2.draft, d);
  } finally {
    h.cleanup();
  }
});

test("validateWriterOutput: a factsUsed id that is disputed, foreign or unknown is invalid; the format block must match the slot; caption + hashtag line is measured against captionMax", async () => {
  const offered = new Set(brands.rishtapatra.usableFacts().map((f) => f.id));
  const ok = llm("writer.ok").output;
  const caps = capsOf(config);
  assert.deepEqual(validateWriterOutput(ok, { format: "image", offeredIds: offered, caps }), []);
  assert.deepEqual(validateWriterOutput(ok, { format: "carousel", offeredIds: offered, caps }), []);
  const disputed = { ...ok, factsUsed: [...ok.factsUsed, { factId: "rp-f12", quote: "12 languages" }] };
  assert.deepEqual(validateWriterOutput(disputed, { format: "image", offeredIds: offered, caps }), ["$.factsUsed[4].factId: rp-f12 was not offered (usable facts only)"]);
  const foreign = { ...ok, factsUsed: [{ factId: "kd-f04", quote: "x" }] };
  assert.deepEqual(validateWriterOutput(foreign, { format: "image", offeredIds: offered, caps }), ["$.factsUsed[0].factId: kd-f04 was not offered (usable facts only)"]);
  const { artwork, ...noArtwork } = ok;
  assert.deepEqual(validateWriterOutput(noArtwork, { format: "image", offeredIds: offered, caps }), ["$.artwork: required for format image"]);
  const { slides, ...noSlides } = ok;
  assert.deepEqual(validateWriterOutput(noSlides, { format: "carousel", offeredIds: offered, caps }), ["$.slides: required for format carousel"]);
  assert.deepEqual(validateWriterOutput(ok, { format: "reel", offeredIds: offered, caps }), ["$.reel: required for format reel"]);
  const long = { ...ok, caption: "x".repeat(2190), hashtags: ["#RishtaPatra", "#Biodata"] };
  assert.equal(codePoints(fullCaption(long)), 2190 + 2 + "#RishtaPatra #Biodata".length);
  assert.deepEqual(validateWriterOutput(long, { format: "image", offeredIds: offered, caps }), [`$.caption: ${2190 + 2 + "#RishtaPatra #Biodata".length} characters with the hashtag line, limit 2200`]);
  assert.deepEqual(validateWriterOutput(long, { format: "image", offeredIds: offered, caps: { ...caps, captionMax: 2220 } }), []);

  // through the real router: a fixture citing the disputed rp-f12 is repaired once, then AgentOutputError → invalid_output
  const fixtures = tmpDir("hoshlab-writer-fixtures-");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "writer.ok.json"), JSON.stringify({ agent: "writer", case: "ok", output: disputed, usage: { inputTokens: 1, outputTokens: 1 } }), "utf8");
  const h = harness({ fixturesDir: fixtures });
  try {
    const res = await runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state: h.state, router: h.router, now: NOW, runId: RUN_ID });
    assert.equal(res.ok, false);
    assert.equal(res.reason, INVALID_OUTPUT_REASON);
    assert.equal(res.error.calls, 2);
    assert.deepEqual(res.error.errors, ["$.factsUsed[4].factId: rp-f12 was not offered (usable facts only)"]);
    assert.deepEqual(h.state.listDrafts(), []);
  } finally {
    h.cleanup();
    rmSync(fixtures, { recursive: true, force: true });
  }
});

test("router errors other than AgentOutputError propagate and nothing is written; caps come from config.defaults; OUTPUT_SPEC uses the design caps", async () => {
  const dir = tmpDir("hoshlab-writer-err-");
  try {
    const state = createState({ companyDir: dir, now: NOW });
    const err = new BudgetExhaustedError(AGENT, { reason: "budget_exhausted: USD 25.00 of 25 used", used: 25, estimate: 0.01, limit: 25 });
    const router = fakeRouter(null, { fail: err });
    await assert.rejects(runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state, router, now: NOW }), (e) => e === err);
    assert.deepEqual(state.listDrafts(), []);
    await assert.rejects(runWriter({ slot: SLOTS.rpImage, idea: IDEAS.rp, brand: brands.rishtapatra, page: RP, config, state, now: NOW }), /router/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(capsOf(config), { captionMax: 2200, hashtagCap: 8, altTextMax: 100 });
  assert.deepEqual(capsOf({ defaults: { captionMax: 1000, hashtagCap: 5, altTextMax: 200 } }), { captionMax: 1000, hashtagCap: 5, altTextMax: 200 });
  assert.deepEqual(capsOf({}), DEFAULT_CAPS);
  const spec = outputSpec({ captionMax: 1000, hashtagCap: 5, altTextMax: 200 });
  assert.equal(spec.caption, "str<=1000");
  assert.deepEqual(spec.hashtags[1], { max: 5 });
  assert.equal(spec.altText, "str<=200");
  assert.equal(spec["slides?"][0].altText, "str<=200");
  assert.equal(OUTPUT_SPEC.caption, "str<=2200");
  assert.deepEqual(OUTPUT_SPEC.hashtags[1], { max: 8 });
  assert.equal(OUTPUT_SPEC.altText, "str<=100");
  assert.equal(OUTPUT_SPEC["artwork?"].headline, "str<=60");
  assert.equal(OUTPUT_SPEC["artwork?"].subline, "str<=110");
  assert.deepEqual(OUTPUT_SPEC["artwork?"].facts, ["str<=70", { max: 3 }]);
  assert.deepEqual(OUTPUT_SPEC["slides?"][1], { min: 2, max: 10 });
  assert.equal(OUTPUT_SPEC["slides?"][0].heading, "str<=40");
  assert.equal(OUTPUT_SPEC["slides?"][0].body, "str<=160");
  assert.deepEqual(OUTPUT_SPEC.factsUsed[1], { min: 1 });
  assert.throws(() => assertShape({ ...llm("writer.ok").output, hashtags: ["#a"] }, OUTPUT_SPEC), /hashtags\[0\]: does not match/);
  assert.doesNotThrow(() => assertShape({ ...llm("writer.ok").output, hashtags: ["#रिश्ता"] }, OUTPUT_SPEC), "Devanagari hashtag with a matra validates (schema HASHTAG)");
});

test("the drafts implied by every writer.ok fixture pass runChecks against the real brand files in both formats (consistent with the fact tables)", () => {
  const cases = [
    ["writer.ok", brands.rishtapatra, RP, IDEAS.rp, SLOTS.rpImage, SLOTS.rpCarousel],
    ["writer.ok.kaatdo", brands.kaatdo, KD, IDEAS.kd, SLOTS.kdImage, SLOTS.kdCarousel],
    ["writer.ok.job_rez", brands.job_rez, JR, IDEAS.jr, SLOTS.jrImage, SLOTS.jrCarousel],
  ];
  for (const [fixture, brand, page, idea, imageSlot, carouselSlot] of cases) {
    const output = llm(fixture).output;
    assertShape(output, OUTPUT_SPEC);
    assert.deepEqual(validateWriterOutput(output, { format: "image", offeredIds: new Set(brand.usableFacts().map((f) => f.id)), caps: capsOf(config) }), []);
    for (const slot of [imageSlot, carouselSlot]) {
      const d = draftFromOutput({ output, slot, idea: { ...idea, format: slot.format }, page, now: NOW, runId: RUN_ID });
      assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] }, `${fixture} ${slot.format}`);
      const r = runChecks(d, brand, { config, media: mediaFor(d) });
      assert.equal(r.passed, true, `${fixture} ${slot.format}: ${r.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join(" | ")}`);
      assert.equal(r.checks.length, 12);
    }
  }
});
