// engine/lib/feedback.js — the owner-feedback digest in the Writer's and Strategist's prompts (design §4.11, §5
// envelope; plan D23; FEAT-205, P2-08) and the Designer's deterministic preferences from tagged feedback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { FEEDBACK_SPEC, assertShape } from "../engine/lib/schema.js";
import { createRouter } from "../engine/llm/router.js";
import { FEEDBACK_DIGEST_HEADING, estimateTokens } from "../engine/llm/prompt.js";
import { latestReport } from "../engine/agents/analyst.js";
import { runWriter } from "../engine/agents/writer.js";
import { runStrategist } from "../engine/agents/strategist.js";
import { DIGEST_ENTRIES, DIGEST_MAX_TOKENS, TRUNCATION_MARKER, buildDigest, designPreferences, entriesFor, entryLine, hasPreference, observationsFor, truncateToTokens } from "../engine/lib/feedback.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster, brands, charters } = company;
const MONDAY = "2026-10-12T05:31:00+05:30";
const RUN_ID = "engine-daily-20261012-0531-abc123";
const SECRET_NAMES = Object.values(config.providers).map((p) => p.secret);
const fixtureState = createState({ companyDir: COMPANY_DIR, now: MONDAY });
const FEEDBACK = fixtureState.readJsonl("state/feedback.jsonl");
const REPORT = latestReport(fixtureState);
const PHRASE = "Too salesy; keep to the six layout rules.";
const page = (handle) => config.pages.find((p) => p.handle === handle);

// The real router under MOCK_LLM=1, with every composed envelope ({ system, user }) captured as the model would see it.
function spyRouter(dir, now = MONDAY) {
  const state = createState({ companyDir: dir, now });
  const real = createRouter({ config, roster, state, env: readEnv(SECRET_NAMES, {}), fetchImpl: () => Promise.reject(new Error("no network in tests")), now, runId: RUN_ID, charters, processEnv: { MOCK_LLM: "1" } });
  const prompts = [];
  const router = {
    ...real,
    prompts,
    complete(agent, args) {
      prompts.push({ agent, ...real.envelope(agent, { task: args.task, context: args.context }) });
      return real.complete(agent, args);
    },
  };
  return { state, router };
}

test("fixture feedback: four entries, every one FEEDBACK_SPEC-valid; entriesFor() scopes by page (plus company-wide), drops future entries, newest first", () => {
  assert.equal(FEEDBACK.length, 4);
  for (const f of FEEDBACK) assertShape(f, FEEDBACK_SPEC);
  assert.deepEqual(entriesFor(FEEDBACK, "job_rez", MONDAY).map((f) => f.text), [PHRASE]);
  assert.deepEqual(entriesFor(FEEDBACK, "kaatdo", MONDAY).map((f) => f.at), ["2026-10-10T19:40:00+05:30", "2026-10-07T20:30:00+05:30"], "newest first");
  assert.deepEqual(entriesFor(FEEDBACK, "job_rez", "2026-10-08T13:04:59+05:30"), [], "a note from the future of a back-dated run is not seen");
  const wide = { at: "2026-10-09T09:00:00+05:30", by: "owner", kind: "note", text: "Shorter captions everywhere.", tags: [] };
  assertShape(wide, FEEDBACK_SPEC);
  assert.deepEqual(entriesFor([...FEEDBACK, wide], "job_rez", MONDAY).map((f) => f.text), [wide.text, PHRASE], "a company-wide note reaches every page");
  assert.equal(entryLine(wide), '- 2026-10-09 note (company-wide): "Shorter captions everywhere."');
  assert.equal(entryLine(FEEDBACK[1]), `- 2026-10-08 reject: "${PHRASE}" [tone]`);
  assert.equal(entryLine({ ...wide, text: "two\n  lines\twide", tags: ["a", "b"] }), '- 2026-10-09 note (company-wide): "two lines wide" [a, b]');
});

test("buildDigest: rejection reasons first then newest first, the page's report observations under 'Analyst observations (<week>)', '' when nothing exists (Phase 1 prompts unchanged)", () => {
  const kd = buildDigest({ feedback: FEEDBACK, page: "kaatdo", lastReport: REPORT.report, now: MONDAY });
  assert.equal(
    kd,
    [
      "Owner feedback (last 10 for @kaatdo)",
      '- 2026-10-07 reject: "Too salesy for KaatDo. Lead with the limitation (squared off within seconds, not prevented), not the feature list." [tone]',
      '- 2026-10-10 note: "Prefer variant B for @kaatdo: the smaller headline tier leaves more air above the mono fact rows." [design, variant]',
      "",
      "Analyst observations (2026-W41)",
      "- The reconnect post reached 412 accounts with 17 saves within 48 hours; comments stayed at 4.",
      "- Hypothesis: a routine-shaped post (do this every morning) gets saved rather than discussed.",
    ].join("\n"),
  );
  assert.ok(estimateTokens(kd) <= DIGEST_MAX_TOKENS && !kd.includes(TRUNCATION_MARKER));
  // the wrapper analyst.latestReport() returns is accepted too, and a page without a row gets no observations
  assert.equal(buildDigest({ feedback: FEEDBACK, page: "kaatdo", lastReport: REPORT, now: MONDAY }), kd);
  assert.deepEqual(observationsFor(REPORT, "job_rez"), { week: "2026-W41", observations: ["No post published in the window; nothing to measure yet."] });
  assert.deepEqual(observationsFor({ week: "2026-W50", perPage: [{ page: "kaatdo", observations: [] }] }, "kaatdo"), { week: "2026-W50", observations: [] });
  assert.deepEqual(observationsFor(null, "kaatdo"), { week: null, observations: [] });
  assert.equal(buildDigest({ feedback: [], page: "rishtapatra", lastReport: null, now: MONDAY }), "", "nothing → empty string");
  assert.equal(buildDigest({ feedback: [], page: "rishtapatra", lastReport: { week: "2026-W41", perPage: [{ page: "kaatdo", observations: ["x"] }] }, now: MONDAY }), "", "another page's observations are not this page's");
  assert.equal(buildDigest({ feedback: FEEDBACK, page: "rishtapatra", lastReport: null, now: MONDAY }), ['Owner feedback (last 10 for @rishtapatra)', '- 2026-10-11 note: "Keep RishtaPatra Hindi-first: the Hindi headline reads better for parents than the English one." [language]'].join("\n"));
  assert.throws(() => buildDigest({ feedback: FEEDBACK }), TypeError);
});

test("buildDigest respects the 1,500-token cap: 40 long entries → the last 10 only, trimmed at a line break, ending with the truncation marker", () => {
  const long = Array.from({ length: 40 }, (_, i) => ({
    at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00+05:30`,
    by: "owner",
    kind: i % 4 === 0 ? "reject" : "note",
    page: "job_rez",
    draftId: `jr-2026-09-${String(1 + (i % 28)).padStart(2, "0")}-entry-${i}`,
    text: `Entry ${i}: ${"keep the layout rules and drop the sales tone ".repeat(20)}`.trim().slice(0, 1000),
    tags: ["tone"],
  }));
  for (const f of long) assertShape(f, FEEDBACK_SPEC);
  const digest = buildDigest({ feedback: long, page: "job_rez", lastReport: REPORT.report, now: MONDAY });
  assert.ok(estimateTokens(digest) <= DIGEST_MAX_TOKENS, `${estimateTokens(digest)} tokens`);
  assert.ok(digest.endsWith(`\n${TRUNCATION_MARKER}`), digest.slice(-80));
  assert.ok(digest.startsWith("Owner feedback (last 10 for @job_rez)\n- "));
  const lines = digest.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.length < DIGEST_ENTRIES, `${lines.length} entries fit before the cut`);
  assert.ok(lines.every((l) => l.length > 800), "whole lines only — no entry is cut mid-sentence");
  // the untruncated digest would have carried the ten newest entries, rejects first
  const untruncated = buildDigest({ feedback: long, page: "job_rez", lastReport: REPORT.report, now: MONDAY, maxTokens: 1e6 });
  const kept = untruncated.split("\n").filter((l) => l.startsWith("- 2026-09"));
  assert.equal(kept.length, DIGEST_ENTRIES);
  const rejectsFirst = kept.map((l) => / reject: /.test(l));
  assert.deepEqual(rejectsFirst, [...rejectsFirst].sort((a, b) => Number(b) - Number(a)), "rejection reasons come first");
  assert.ok(untruncated.includes("Analyst observations (2026-W41)\n- No post published in the window; nothing to measure yet."));
  // the cut itself
  assert.equal(truncateToTokens("short", 10), "short");
  const cut = truncateToTokens("a".repeat(100) + "\n" + "b".repeat(100) + "\n" + "c".repeat(100), 40);
  assert.equal(cut, `${"a".repeat(100)}\n${TRUNCATION_MARKER}`);
  assert.ok(estimateTokens(cut) <= 40);
  assert.equal(DIGEST_MAX_TOKENS, 1500);
});

test("P2-08: the Writer prompt for @job_rez carries the rejection phrase (context block, under the generated heading); the Strategist prompt for @kaatdo carries the report observations", async () => {
  const dir = tmpDir("hoshlab-feedback-");
  try {
    const { state, router } = spyRouter(dir);
    const digest = buildDigest({ feedback: FEEDBACK, page: "job_rez", lastReport: REPORT.report, now: MONDAY });
    const jr = page("job_rez");
    const slot = { slotId: "job_rez-2026-10-13-1230", page: "job_rez", at: "2026-10-13T12:30:00+05:30", format: "carousel", status: "planned" };
    const idea = { id: "jr-i01", page: "job_rez", title: "Templates and free export", angle: "Nine templates, three free, PDF export without a watermark.", hook: "Three free.", format: "carousel", language: "en", facts: ["jr-f10", "jr-f09"], status: "scheduled", attempts: 0, createdAt: "2026-10-10T05:31:00+05:30", by: "strategist" };
    const res = await runWriter({ slot, idea, brand: brands.job_rez, page: jr, config, state, router, now: MONDAY, runId: RUN_ID, feedbackDigest: digest });
    assert.equal(res.ok, true);
    assert.equal(router.prompts.length, 1);
    const { system, user } = router.prompts[0];
    assert.ok(system.includes(PHRASE), "the rejection reason is in the system prompt");
    assert.ok(system.includes(`${FEEDBACK_DIGEST_HEADING}\nOwner feedback (last 10 for @job_rez)\n- 2026-10-08 reject: "${PHRASE}" [tone]`), "under the context block's generated heading, as the digest renders it");
    assert.ok(system.indexOf("## Context (generated)") < system.indexOf(FEEDBACK_DIGEST_HEADING) && system.indexOf(FEEDBACK_DIGEST_HEADING) < system.indexOf("## Output (generated)"));
    assert.ok(system.includes("Analyst observations (2026-W41)\n- No post published in the window; nothing to measure yet."));
    assert.ok(!system.includes("Too salesy for KaatDo"), "another page's feedback stays out");
    assert.equal(JSON.parse(user).feedback, digest, "the task JSON carries the same digest");

    // Strategist: @kaatdo's digest with the W41 observations
    const kdDigest = buildDigest({ feedback: FEEDBACK, page: "kaatdo", lastReport: REPORT.report, now: MONDAY });
    const kd = await runStrategist({ page: page("kaatdo"), brand: brands.kaatdo, memo: null, state, router, config, now: MONDAY, runId: RUN_ID, feedbackDigest: kdDigest });
    assert.equal(kd.modelCalled, true);
    const strategist = router.prompts.find((p) => p.agent === "strategist");
    assert.ok(strategist, "the Strategist called the model");
    assert.ok(strategist.system.includes("Analyst observations (2026-W41)\n- The reconnect post reached 412 accounts with 17 saves within 48 hours; comments stayed at 4.\n- Hypothesis: a routine-shaped post (do this every morning) gets saved rather than discussed."));
    assert.ok(strategist.system.includes('- 2026-10-07 reject: "Too salesy for KaatDo.'));
    assert.ok(!strategist.system.includes(PHRASE), "@job_rez's rejection is not in @kaatdo's prompt");
    // an empty digest leaves the Phase 1 prompt unchanged
    const bareDir = tmpDir("hoshlab-feedback-bare-");
    try {
      const bare = spyRouter(bareDir);
      await runWriter({ slot, idea, brand: brands.job_rez, page: jr, config, state: bare.state, router: bare.router, now: MONDAY, runId: RUN_ID, feedbackDigest: buildDigest({ feedback: [], page: "job_rez", lastReport: null, now: MONDAY }) });
      assert.ok(!bare.router.prompts[0].system.includes(FEEDBACK_DIGEST_HEADING), "no heading when the digest is empty");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("designPreferences (plan D23): tagged design/variant/palette entries whose text names a variant or palette — @kaatdo → B, @rishtapatra → none; untagged text and bare words are not read as preferences; the newest tagged entry wins", () => {
  const kd = designPreferences({ feedback: FEEDBACK, page: "kaatdo", now: MONDAY });
  assert.deepEqual(kd, { preferVariant: "B", preferPalette: null, reasons: ["variant B preferred by owner feedback 2026-10-10"], variantReason: "variant B preferred by owner feedback 2026-10-10", paletteReason: null });
  assert.equal(hasPreference(kd), true);
  const rp = designPreferences({ feedback: FEEDBACK, page: "rishtapatra", now: MONDAY });
  assert.deepEqual(rp, { preferVariant: null, preferPalette: null, reasons: [], variantReason: null, paletteReason: null });
  assert.equal(hasPreference(rp), false);
  assert.equal(designPreferences({ feedback: FEEDBACK, page: "job_rez", now: MONDAY }).preferVariant, null, "a tone reject says nothing about design");
  const at = (d, h = "10") => `2026-10-${d}T${h}:00:00+05:30`;
  const mk = (over) => ({ at: at("05"), by: "owner", kind: "note", page: "kaatdo", text: "", tags: [], ...over });
  // nothing inferred: the tag without a named variant, the variant without a tag, a bare "dark"
  assert.equal(designPreferences({ feedback: [mk({ tags: ["design"], text: "Make it bolder and bigger." })], page: "kaatdo" }).preferVariant, null);
  assert.equal(designPreferences({ feedback: [mk({ tags: ["tone"], text: "Use variant A here." })], page: "kaatdo" }).preferVariant, null, "untagged → ignored");
  assert.equal(designPreferences({ feedback: [mk({ tags: ["palette"], text: "Go dark." })], page: "kaatdo" }).preferPalette, null, '"dark palette" is required, not "dark"');
  assert.equal(designPreferences({ feedback: [mk({ tags: ["design"], text: "The variant Bold headline is fine." })], page: "kaatdo" }).preferVariant, null, "the letter must stand alone");
  // strict matches, case-insensitive on the words, any of the three tags, any kind
  const dark = designPreferences({ feedback: [mk({ tags: ["Palette"], kind: "praise", text: "Loved the dark palette on the carousel." })], page: "kaatdo" });
  assert.deepEqual([dark.preferPalette, dark.paletteReason], ["dark", "dark palette preferred by owner feedback 2026-10-05"]);
  assert.equal(designPreferences({ feedback: [mk({ tags: ["variant"], text: "variant: c please" })], page: "kaatdo" }).preferVariant, "C");
  const both = designPreferences({ feedback: [mk({ tags: ["design"], text: "Prefer variant A and the light palette." })], page: "kaatdo" });
  assert.deepEqual(both.reasons, ["variant A preferred by owner feedback 2026-10-05", "light palette preferred by owner feedback 2026-10-05"]);
  // newest wins; an older conflicting entry is ignored; company-wide notes count for every page; `now` bounds the entries
  const feed = [mk({ at: at("03"), tags: ["variant"], text: "variant A" }), mk({ at: at("09"), tags: ["variant"], text: "variant C" }), mk({ at: at("06"), page: undefined, tags: ["palette"], text: "dark palette on every page" })];
  const latest = designPreferences({ feedback: feed, page: "kaatdo", now: MONDAY });
  assert.deepEqual([latest.preferVariant, latest.preferPalette], ["C", "dark"]);
  assert.equal(designPreferences({ feedback: feed, page: "rishtapatra", now: MONDAY }).preferPalette, "dark", "company-wide");
  assert.equal(designPreferences({ feedback: feed, page: "rishtapatra", now: MONDAY }).preferVariant, null);
  assert.equal(designPreferences({ feedback: feed, page: "kaatdo", now: at("05") }).preferVariant, "A", "before the newer note was written");
  assert.throws(() => designPreferences({ feedback: feed }), TypeError);
});

test("a feedback.jsonl the admin wrote (tags: [] on rejects and notes) yields no design preference — only explicit tags steer the Designer", () => {
  const dir = tmpDir("hoshlab-feedback-admin-");
  try {
    mkdirSync(join(dir, "state"), { recursive: true });
    const rows = [
      { at: "2026-10-07T20:30:00+05:30", by: "owner", kind: "reject", page: "kaatdo", draftId: "kd-2026-10-08-x", text: "Variant A is too big; use variant B and the light palette.", tags: [] },
      { at: "2026-10-08T09:00:00+05:30", by: "owner", kind: "note", page: "kaatdo", text: "dark palette please", tags: [] },
    ];
    writeFileSync(join(dir, "state", "feedback.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const state = createState({ companyDir: dir, now: MONDAY });
    const prefs = designPreferences({ feedback: state.readJsonl("state/feedback.jsonl"), page: "kaatdo", now: MONDAY });
    assert.deepEqual([prefs.preferVariant, prefs.preferPalette, prefs.reasons], [null, null, []]);
    // …while the same lines do reach the Writer's digest verbatim
    const digest = buildDigest({ feedback: state.readJsonl("state/feedback.jsonl"), page: "kaatdo", lastReport: null, now: MONDAY });
    assert.ok(digest.includes('- 2026-10-07 reject: "Variant A is too big; use variant B and the light palette."'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
