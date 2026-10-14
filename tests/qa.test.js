// engine/agents/qa.js — deterministic checks first, the model only when they pass, mock drafts fail with
// mock_output, qa.json + draft transitions queued / rework / blocked (design §4.7, §5; M5; P1-08 unit level).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FETCH_ATTEMPTS, ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { DRAFT_SPEC, QA_CHECK_IDS, QA_SPEC, USAGE_SPEC, assertShape, toJsonSchema, validate } from "../engine/lib/schema.js";
import { BudgetExhaustedError, createRouter } from "../engine/llm/router.js";
import { loadFixture } from "../engine/llm/mock.js";
import { AGENT, MIN_TONE_SCORE, MOCK_OUTPUT_REASON, OUTPUT_SPEC, buildTask, claimSourceIds, judge, loadMedia, nextStatus, runQa } from "../engine/agents/qa.js";

const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { config, roster, brands, charters } = company;
const NOW = "2026-10-12T05:40:00+05:30";
const RUN_ID = "engine-daily-20261012-0531-abc123";
const FIX = join(ROOT, "tests", "fixtures");
const JPEG = new Uint8Array(readFileSync(join(FIX, "media", "fixture-1080x1350.jpg")));
const draftFixture = (name) => JSON.parse(readFileSync(join(FIX, "drafts", `${name}.json`), "utf8"));
const RP = draftFixture("rp-2026-10-14-kundali-free");
const KD = draftFixture("kd-2026-10-13-six-rules");
const JR = draftFixture("jr-2026-10-15-templates");
const llm = (name) => JSON.parse(readFileSync(join(FIX, "llm", `${name}.json`), "utf8"));
const SECRET_NAMES = Object.values(config.providers).map((p) => p.secret);

function mediaFor(draft) {
  return draft.media.map((m) => ({ kind: m.kind, bytes: JPEG, width: m.width, height: m.height, path: m.path }));
}

// A router stand-in that answers from an LLM fixture and counts calls (or throws `fail`).
function fakeRouter(fixtureName, { fail } = {}) {
  const calls = [];
  return {
    calls,
    runId: RUN_ID,
    async complete(agent, args) {
      calls.push({ agent, args });
      if (fail) throw fail;
      const fx = llm(fixtureName);
      return { json: structuredClone(fx.output), text: JSON.stringify(fx.output), usage: fx.usage, costUsd: 0, provider: "mock", model: "mock", ms: 1, mock: true, calls: 1, repaired: false, raw: { status: 200, id: `mock:${fixtureName}` }, failures: [] };
    },
  };
}

function harness() {
  const dir = tmpDir("hoshlab-qa-");
  const state = createState({ companyDir: dir, now: NOW });
  return { dir, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const noSebi = { ...structuredClone(KD), caption: KD.caption.replace("KaatDo is not registered with SEBI. ", "") };

test("deterministic failure → the model is NOT called, qa.json has model:null and the failing checks as reasons; the draft goes to rework with reworkCount 1 and qaReasons", async () => {
  const h = harness();
  const router = fakeRouter("qa.ok");
  try {
    const res = await runQa({ draft: noSebi, brand: brands.kaatdo, config, router, state: h.state, media: mediaFor(KD) });
    assert.equal(res.passed, false);
    assert.equal(res.modelCalled, false);
    assert.equal(router.calls.length, 0, "0 model calls");
    assert.equal(res.status, "rework");
    const qa = h.state.readQa(KD.id);
    assert.deepEqual(validate(qa, QA_SPEC), { ok: true, errors: [] });
    assert.equal(qa.model, null);
    assert.equal(qa.passed, false);
    assert.equal(qa.deterministic.passed, false);
    assert.equal(qa.deterministic.checks.length, 12);
    assert.deepEqual(qa.reasons, ["disclaimer: always: missing not registered with SEBI | not SEBI-registered"]);
    assert.deepEqual(res.reasons, qa.reasons);
    assert.equal(qa.revision, KD.revision);
    assert.equal(qa.at, NOW);
    assert.equal(qa.mock, false);
    assert.equal(qa.runId, RUN_ID, "runId from the router when not passed");
    const draft = h.state.readDraft(KD.id);
    assert.deepEqual(validate(draft, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(draft.status, "rework");
    assert.equal(draft.reworkCount, 1);
    assert.equal(draft.revision, 1, "QA never bumps the revision (the Writer does on rework)");
    assert.deepEqual(draft.qaReasons, qa.reasons);
    assert.equal(draft.qaRef, `drafts/${KD.id}/qa.json`);
    assert.equal(draft.updatedAt, NOW);
    assert.equal(draft.caption, noSebi.caption, "QA never edits the draft");
  } finally {
    h.cleanup();
  }
});

test("JobRez parser guarantee fails deterministic forbidden QA and never calls the QA model", async () => {
  const h = harness();
  const router = fakeRouter("qa.ok");
  const draft = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "regressions", "jobrez-parser-claim.json"), "utf8"));
  try {
    const res = await runQa({ draft, brand: brands.job_rez, config, router, state: h.state, media: mediaFor(draft), runId: RUN_ID });
    assert.equal(res.passed, false);
    assert.equal(res.modelCalled, false);
    assert.equal(router.calls.length, 0, "deterministic rejection stops before router.complete");
    assert.equal(res.status, "rework");
    assert.deepEqual(res.qa.deterministic.checks.filter((check) => !check.ok).map((check) => check.id), ["forbidden"]);
    assert.equal(res.reasons.length, 1);
    assert.match(res.reasons[0], /^forbidden: caption: "parseable by construction" matches/);
    assert.equal(res.qa.model, null);
    const updated = h.state.readDraft(draft.id);
    assert.equal(updated.caption, draft.caption, "QA transitions state without editing generated copy");
    assert.equal(updated.revision, draft.revision);
    assert.equal(updated.reworkCount, 1);
  } finally {
    h.cleanup();
  }
});

test("deterministic pass + qa.ok fixture → the model is called once with the task JSON (draft, media metadata, brand rules, 12 deterministic results) and the draft is queued", async () => {
  const h = harness();
  const router = fakeRouter("qa.ok");
  try {
    const res = await runQa({ draft: RP, brand: brands.rishtapatra, config, router, state: h.state, media: mediaFor(RP), recentCaptions: [KD.caption], runId: RUN_ID });
    assert.equal(res.passed, true);
    assert.equal(res.modelCalled, true);
    assert.equal(res.status, "queued");
    assert.deepEqual(res.reasons, []);
    assert.equal(router.calls.length, 1);
    const [{ agent, args }] = router.calls;
    assert.equal(agent, AGENT);
    assert.equal(args.spec, OUTPUT_SPEC);
    assert.equal(args.context.brand, brands.rishtapatra);
    assert.equal(args.context.page, "rishtapatra");
    const task = args.task;
    assert.equal(task.draft.caption, RP.caption);
    assert.deepEqual(task.draft.factsUsed, RP.factsUsed);
    assert.equal(task.draft.status, undefined, "lifecycle fields stay out of the task");
    assert.deepEqual(task.media, [{ kind: "image", bytes: 9432, width: 1080, height: 1350, path: RP.media[0].path }], "metadata only, never pixels");
    assert.ok(task.brand.facts.some((f) => f.id === "rp-f08"));
    assert.ok(!task.brand.facts.some((f) => f.id === "rp-f12"), "disputed fact excluded (P1-04)");
    assert.ok(task.brand.pricing.some((p) => p.sku === "shubh-pass"));
    assert.equal(task.brand.disclaimers.length, 1);
    assert.deepEqual(task.brand.allowedDomains, ["rishtapatra.com"]);
    assert.deepEqual(
      task.deterministic.map((c) => c.id),
      QA_CHECK_IDS,
    );
    assert.ok(task.deterministic.every((c) => c.ok === true));
    const qa = h.state.readQa(RP.id);
    assert.deepEqual(validate(qa, QA_SPEC), { ok: true, errors: [] });
    assert.equal(qa.passed, true);
    assert.equal(qa.deterministic.passed, true);
    assert.equal(qa.model.provider, "mock");
    assert.equal(qa.model.verdict, "pass");
    assert.equal(qa.model.toneScore, 4);
    assert.equal(qa.model.claims.length, 4);
    assert.ok(qa.model.claims.every((c) => typeof c.factId === "string" && c.ok === true));
    assert.deepEqual(qa.model.reasons, []);
    assert.deepEqual(qa.reasons, []);
    assert.equal(qa.mock, true, "the model answer came from the mock adapter");
    assert.equal(qa.runId, RUN_ID);
    const draft = h.state.readDraft(RP.id);
    assert.equal(draft.status, "queued");
    assert.equal(draft.reworkCount, 0);
    assert.equal(draft.qaReasons, undefined);
    assert.equal(draft.qaRef, `drafts/${RP.id}/qa.json`);
    assert.equal(draft.revision, 1);
  } finally {
    h.cleanup();
  }
});

test("qa.fail fixture → rework with reworkCount 1; reasons = the model's reason + the unsourced claim; the claim without a fact id is recorded without one", async () => {
  const h = harness();
  const router = fakeRouter("qa.fail");
  try {
    const res = await runQa({ draft: RP, brand: brands.rishtapatra, config, router, state: h.state, media: mediaFor(RP) });
    assert.equal(res.passed, false);
    assert.equal(res.modelCalled, true);
    assert.equal(res.status, "rework");
    assert.equal(router.calls.length, 1);
    const qa = h.state.readQa(RP.id);
    assert.equal(qa.passed, false);
    assert.equal(qa.deterministic.passed, true);
    assert.equal(qa.model.verdict, "fail");
    assert.deepEqual(qa.reasons, ['Remove "trusted by thousands of families": no fact supports a user count.', 'claim without a fact id: "trusted by thousands of families"']);
    assert.deepEqual(qa.model.claims[1], { claim: "trusted by thousands of families", ok: false });
    assert.deepEqual(qa.model.claims[0], { claim: "Janam Kundali is free on RishtaPatra", ok: true, factId: "rp-f04" });
    const draft = h.state.readDraft(RP.id);
    assert.equal(draft.status, "rework");
    assert.equal(draft.reworkCount, 1);
    assert.deepEqual(draft.qaReasons, qa.reasons);
  } finally {
    h.cleanup();
  }
});

test("third failure (reworkCount already 2 = maxReworkLoops) → blocked, reworkCount unchanged; nextStatus truth table", async () => {
  assert.equal(config.defaults.maxReworkLoops, 2);
  const h = harness();
  const router = fakeRouter("qa.fail");
  try {
    const third = { ...structuredClone(RP), revision: 3, reworkCount: 2, status: "rendered" };
    const res = await runQa({ draft: third, brand: brands.rishtapatra, config, router, state: h.state, media: mediaFor(RP) });
    assert.equal(res.status, "blocked");
    const draft = h.state.readDraft(RP.id);
    assert.equal(draft.status, "blocked");
    assert.equal(draft.reworkCount, 2);
    assert.equal(draft.revision, 3);
    assert.ok(draft.qaReasons.length >= 1);
    assert.equal(h.state.readQa(RP.id).revision, 3);
  } finally {
    h.cleanup();
  }
  assert.equal(nextStatus({ reworkCount: 0 }, true, config), "queued");
  assert.equal(nextStatus({ reworkCount: 2 }, true, config), "queued");
  assert.equal(nextStatus({ reworkCount: 0 }, false, config), "rework");
  assert.equal(nextStatus({ reworkCount: 1 }, false, config), "rework");
  assert.equal(nextStatus({ reworkCount: 2 }, false, config), "blocked");
  assert.equal(nextStatus({ reworkCount: 0 }, false, { defaults: { maxReworkLoops: 0 } }), "blocked");
});

test("draft.mock === true → qa.json passed:false, reasons ['mock_output'], model null, mock true, 0 model calls (M5 / P1-06 path); deterministic results are still recorded", async () => {
  const h = harness();
  const router = fakeRouter("qa.ok");
  try {
    const mockDraft = { ...structuredClone(RP), mock: true };
    const res = await runQa({ draft: mockDraft, brand: brands.rishtapatra, config, router, state: h.state, media: mediaFor(RP) });
    assert.equal(res.passed, false);
    assert.equal(res.modelCalled, false);
    assert.equal(router.calls.length, 0);
    assert.deepEqual(res.reasons, [MOCK_OUTPUT_REASON]);
    assert.equal(MOCK_OUTPUT_REASON, "mock_output");
    const qa = h.state.readQa(RP.id);
    assert.deepEqual(validate(qa, QA_SPEC), { ok: true, errors: [] });
    assert.equal(qa.passed, false);
    assert.equal(qa.model, null);
    assert.equal(qa.mock, true);
    assert.deepEqual(qa.reasons, ["mock_output"]);
    assert.equal(qa.deterministic.passed, true, "the mechanical checks still ran");
    assert.equal(qa.deterministic.checks.length, 12);
    const draft = h.state.readDraft(RP.id);
    assert.equal(draft.status, "rework");
    assert.equal(draft.mock, true);
    assert.deepEqual(draft.qaReasons, ["mock_output"]);
  } finally {
    h.cleanup();
  }
});

test("judge(): tone < 3 fails; unknown or disputed fact ids make a claim unsourced; a pricing sku is a valid source; ok:false claims fail; model verdict fail is kept", () => {
  const good = { verdict: "pass", toneScore: 4, claims: [{ claim: "Janam Kundali is free", factId: "rp-f04", ok: true }], reasons: [], notes: "fine" };
  assert.deepEqual(judge(good, brands.rishtapatra), { verdict: "pass", toneScore: 4, claims: [{ claim: "Janam Kundali is free", ok: true, factId: "rp-f04" }], reasons: [], notes: "fine" });
  const tone = judge({ ...good, toneScore: 2 }, brands.rishtapatra);
  assert.equal(tone.verdict, "fail");
  assert.deepEqual(tone.reasons, [`tone score 2 below ${MIN_TONE_SCORE}`]);
  assert.equal(MIN_TONE_SCORE, 3);
  const disputed = judge({ ...good, claims: [{ claim: "12 Indian languages", factId: "rp-f12", ok: true }] }, brands.rishtapatra);
  assert.equal(disputed.verdict, "fail");
  assert.deepEqual(disputed.claims, [{ claim: "12 Indian languages", ok: false }]);
  assert.deepEqual(disputed.reasons, ['claim cites rp-f12, which is not a usable fact of this brand: "12 Indian languages"']);
  const unknown = judge({ ...good, claims: [{ claim: "x", factId: "rp-f99", ok: true }] }, brands.rishtapatra);
  assert.equal(unknown.verdict, "fail");
  assert.match(unknown.reasons[0], /rp-f99, which is not a usable fact/);
  const otherBrand = judge({ ...good, claims: [{ claim: "x", factId: "kd-f04", ok: true }] }, brands.rishtapatra);
  assert.equal(otherBrand.verdict, "fail", "another brand's id is not a source here");
  const sku = judge({ ...good, claims: [{ claim: "Monthly ₹999", factId: "monthly", ok: true }] }, brands.kaatdo);
  assert.equal(sku.verdict, "pass");
  assert.ok(claimSourceIds(brands.kaatdo).has("monthly") && claimSourceIds(brands.kaatdo).has("kd-f10") && !claimSourceIds(brands.kaatdo).has("rp-f04"));
  assert.ok(!claimSourceIds(brands.rishtapatra).has("rp-f12"), "disputed id is never a source");
  const notOk = judge({ ...good, claims: [{ claim: "every broker", factId: "rp-f04", ok: false }], reasons: ["Six brokers, not every broker."] }, brands.rishtapatra);
  assert.equal(notOk.verdict, "fail");
  assert.deepEqual(notOk.reasons, ["Six brokers, not every broker."]);
  const notOkSilent = judge({ ...good, claims: [{ claim: "every broker", factId: "rp-f04", ok: false }] }, brands.rishtapatra);
  assert.deepEqual(notOkSilent.reasons, ['claim overstates rp-f04: "every broker"']);
  const saidFail = judge({ ...good, verdict: "fail" }, brands.rishtapatra);
  assert.deepEqual(saidFail.reasons, ["model verdict fail"]);
  const passWithNoise = judge({ ...good, reasons: ["nitpick"] }, brands.rishtapatra);
  assert.deepEqual(passWithNoise.reasons, [], "reasons are empty on a pass");
  assert.equal(judge({ ...good, notes: undefined }, brands.rishtapatra).notes, undefined);
});

test("router errors (budget exhausted) propagate and nothing is written: no qa.json, no draft write", async () => {
  const h = harness();
  const err = new BudgetExhaustedError(AGENT, { reason: "budget_exhausted: USD 25.00 of 25 used", used: 25, estimate: 0.01, limit: 25 });
  const router = fakeRouter("qa.ok", { fail: err });
  try {
    await assert.rejects(runQa({ draft: RP, brand: brands.rishtapatra, config, router, state: h.state, media: mediaFor(RP) }), (e) => e === err);
    assert.equal(router.calls.length, 1);
    assert.equal(h.state.exists(`state/drafts/${RP.id}/qa.json`), false);
    assert.equal(h.state.exists(`state/drafts/${RP.id}/draft.json`), false);
    await assert.rejects(runQa({ draft: RP, brand: brands.rishtapatra, config, state: h.state, media: mediaFor(RP) }), /router is required/);
  } finally {
    h.cleanup();
  }
});

test("end to end with the real router under MOCK_LLM=1: qa.ok.json answers RishtaPatra, page-keyed qa.ok.kaatdo.json / qa.ok.job_rez.json answer the other pages; one usage line mock:true per call; no network", async () => {
  for (const [draft, brand] of [
    [RP, brands.rishtapatra],
    [KD, brands.kaatdo],
    [JR, brands.job_rez],
  ]) {
    const h = harness();
    try {
      const router = createRouter({ config, roster, state: h.state, env: readEnv(SECRET_NAMES, {}), fetchImpl: () => Promise.reject(new Error("no network in tests")), now: NOW, runId: RUN_ID, charters, processEnv: { MOCK_LLM: "1" } });
      const res = await runQa({ draft, brand, config, router, state: h.state, media: mediaFor(draft) });
      assert.equal(res.passed, true, `${draft.id}: ${res.reasons.join(" | ")}`);
      assert.equal(res.status, "queued");
      const qa = h.state.readQa(draft.id);
      assert.equal(qa.model.provider, "mock");
      assert.equal(qa.model.model, "mock");
      assert.ok(qa.model.claims.length >= 4);
      assert.ok(qa.model.claims.every((c) => c.ok && typeof c.factId === "string"));
      const usage = h.state.readJsonl(h.state.monthLogPath("usage"));
      assert.equal(usage.length, 1);
      assert.equal(validate(usage[0], USAGE_SPEC).ok, true);
      assert.equal(usage[0].agent, "qa");
      assert.equal(usage[0].page, draft.page);
      assert.equal(usage[0].mock, true);
      assert.equal(usage[0].costUsd, 0);
    } finally {
      h.cleanup();
    }
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
  assert.ok(loadFixture("qa", { page: "kaatdo", processEnv: {} }).path.endsWith("qa.ok.kaatdo.json"));
  assert.equal(loadFixture("qa", { page: "kaatdo", processEnv: {} }).caseName, "ok.kaatdo");
  assert.ok(loadFixture("qa", { page: "job_rez", processEnv: {} }).path.endsWith("qa.ok.job_rez.json"));
  assert.ok(loadFixture("qa", { page: "rishtapatra", processEnv: {} }).path.endsWith(`${"qa.ok.json"}`), "no keyed file → the generic fixture");
  assert.ok(loadFixture("qa", { processEnv: {} }).path.endsWith("qa.ok.json"));
  assert.ok(loadFixture("qa", { page: "kaatdo", processEnv: { MOCK_LLM_CASE: "fail" } }).path.endsWith(`${"qa.fail.json"}`), "no keyed fail fixture → the generic one");
});

test("OUTPUT_SPEC converts to both dialects (M7) and every qa fixture output passes assertShape and judge() against its brand", () => {
  const openai = toJsonSchema(OUTPUT_SPEC, "openai");
  assert.equal(openai.additionalProperties, false);
  assert.deepEqual(openai.required.sort(), ["claims", "notes", "reasons", "toneScore", "verdict"]);
  assert.equal(JSON.stringify(toJsonSchema(OUTPUT_SPEC, "gemini")).includes("additionalProperties"), false);
  assert.equal(typeof toJsonSchema(OUTPUT_SPEC, "prompt"), "string");
  for (const [name, brand] of [
    ["qa.ok", brands.rishtapatra],
    ["qa.ok.kaatdo", brands.kaatdo],
    ["qa.ok.job_rez", brands.job_rez],
    ["qa.fail", brands.rishtapatra],
  ]) {
    const fx = llm(name);
    assert.equal(fx.agent, "qa");
    assertShape(fx.output, OUTPUT_SPEC);
    const verdict = judge(fx.output, brand).verdict;
    assert.equal(verdict, name === "qa.fail" ? "fail" : "pass", name);
  }
  assert.ok(llm("qa.fail").output.claims.some((c) => c.factId === null), "one claim without a fact id");
  // N19: the JobRez QA fixture lists a fact id for each claim
  assert.ok(llm("qa.ok.job_rez").output.claims.every((c) => typeof c.factId === "string"));
});

test("loadMedia reads the rendered files from a media root (either .media/ or a media/ folder) and marks missing files so media_spec fails; buildTask summarises bytes as numbers", async () => {
  const root = tmpDir("hoshlab-qa-media-");
  try {
    const under = join(root, "media", RP.id);
    mkdirSync(under, { recursive: true });
    writeFileSync(join(under, "image-1-7cfbae6d.jpg"), JPEG);
    const [item] = loadMedia(RP, root);
    assert.ok(item.bytes instanceof Uint8Array);
    assert.equal(item.bytes.byteLength, 9432);
    assert.equal(item.path, RP.media[0].path);
    const [flat] = loadMedia(RP, join(root, "media"));
    assert.equal(flat.bytes.byteLength, 9432, "root may already be the media/ folder (tests/fixtures/media layout)");
    const [missing] = loadMedia(KD, root);
    assert.equal(missing.bytes, null);
    const h = harness();
    try {
      const res = await runQa({ draft: KD, brand: brands.kaatdo, config, router: fakeRouter("qa.ok.kaatdo"), state: h.state, mediaRoot: root });
      assert.equal(res.passed, false);
      assert.equal(res.modelCalled, false);
      assert.deepEqual(res.reasons, ["media_spec: image-1-7cfbae6d.jpg: media bytes not available"]);
      const ok = await runQa({ draft: RP, brand: brands.rishtapatra, config, router: fakeRouter("qa.ok"), state: h.state, mediaRoot: root });
      assert.equal(ok.passed, true);
      assert.equal(ok.qa.deterministic.checks.find((c) => c.id === "media_spec").detail, "1080x1350 jpeg 9 KB");
      assert.deepEqual(buildTask({ draft: RP, brand: brands.rishtapatra, media: loadMedia(RP, root) }).media, [{ kind: "image", bytes: 9432, width: 1080, height: 1350, path: RP.media[0].path }]);
    } finally {
      h.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
