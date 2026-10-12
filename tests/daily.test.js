// engine/commands/daily.js on temp copies of tests/fixtures/company-populated (design §3.1, §4.12, §4.14,
// §11; review M5.4, M9, M16; P1-06, P1-08, P1-24). MOCK_LLM=1 answers every model call from fixtures; the
// renderer is a fake (no browser); the media worktree is a temp dir with a `.git` marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT, tmpDir, walk } from "./helpers.js";
import { EXIT, main } from "../engine/index.js";
import { createState } from "../engine/lib/state.js";
import { CALENDAR_SPEC, DRAFT_SPEC, RUN_SPEC, STATUS_SPEC, USAGE_SPEC, assertShape, validate } from "../engine/lib/schema.js";
import { monthUsedUsd } from "../engine/lib/budget.js";
import { AGENT_ORDER, SKIP_BUDGET, WORKFLOW, parseAgents, recentCaptionsFor, relinkCalendar, runDaily, slotsToWrite } from "../engine/commands/daily.js";
import { setPageMode } from "../engine/commands/set-page.js";
import { RenderError, RenderUnavailableError } from "../engine/render/render.js";

const MONDAY = "2026-10-12T05:31:00+05:30"; // the strategist fixtures' assignments name this Monday's open slots
const TUESDAY = "2026-10-13T05:31:00+05:30";
const KD = "kd-2026-10-13-six-rules";
const RP = "rp-2026-10-14-kundali-free";
const JR = "jr-2026-10-15-templates";
const MOCK = { MOCK_LLM: "1" };
const SHA = "7cfbae6d41f17cb1b34897046134304f36529e6e223ea96756052d2a70958af1";

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

function treeHash(dir, skip = () => false) {
  const h = createHash("sha256");
  for (const p of walk(dir).sort()) {
    const rel = relative(dir, p).replace(/\\/g, "/");
    if (skip(rel)) continue;
    h.update(rel);
    h.update(readFileSync(p));
  }
  return h.digest("hex");
}

// A temp copy of the populated fixture plus a media worktree marker (`.git` file like a git worktree).
function copyFixture({ media = true } = {}) {
  const base = tmpDir("hoshlab-daily-");
  const dir = join(base, "company");
  cpSync(COMPANY_DIR, dir, { recursive: true });
  const mediaRoot = join(base, ".media");
  mkdirSync(mediaRoot, { recursive: true });
  if (media) writeFileSync(join(mediaRoot, ".git"), "gitdir: ../.git/worktrees/media\n");
  const state = createState({ companyDir: dir, now: MONDAY });
  return {
    base,
    dir,
    mediaRoot,
    state,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    status: () => JSON.parse(readFileSync(join(dir, "state", "status.json"), "utf8")),
    draft: (id) => JSON.parse(readFileSync(join(dir, "state", "drafts", id, "draft.json"), "utf8")),
    drafts: () => state.listDrafts(),
    runs: () => state.readJsonl("state/runs/2026-10.jsonl"),
    usage: () => state.readJsonl("state/usage/2026-10.jsonl"),
    appendUsage: (row) => writeFileSync(join(dir, "state", "usage", "2026-10.jsonl"), readFileSync(join(dir, "state", "usage", "2026-10.jsonl"), "utf8") + JSON.stringify(row) + "\n", "utf8"),
  };
}

// Renderer double: writes a 2-byte file per media item and reports fixture-shaped rows (no browser).
// `refuse(draft, nth)` may return an Error to throw for that call (nth = how many times this draft was seen).
function fakeRenderer(refuse = () => null) {
  const calls = [];
  const drafts = []; // what each call received: { id, revision, reworkCount, qaReasons, nth }
  const seen = new Map();
  return {
    calls,
    drafts,
    async renderDraft(draft, brand, { outDir, relDir }) {
      calls.push(draft.id);
      const nth = (seen.get(draft.id) || 0) + 1;
      seen.set(draft.id, nth);
      drafts.push({ id: draft.id, revision: draft.revision, reworkCount: draft.reworkCount, qaReasons: draft.qaReasons, nth });
      const err = refuse(draft, nth);
      if (err) throw err;
      const n = draft.format === "carousel" ? draft.slides.length : 1;
      const media = Array.from({ length: n }, (_, i) => {
        const file = `${draft.format === "carousel" ? "slide" : "image"}-${i + 1}-${SHA.slice(0, 8)}.jpg`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, file), Buffer.from([0xff, 0xd8]));
        return { kind: "image", file, path: `${relDir}${file}`, bytes: 9432, width: 1080, height: 1350, sha256: SHA, variant: "A", palette: "test", minTextU: 30, minContrast: 4.6 };
      });
      return { media, variant: "A", palette: "test" };
    },
    async close() {
      calls.push("closed");
    },
  };
}

const agent = (r, name) => r.agents.find((a) => a.name === name);

test("Monday run on the fixture (MOCK_LLM): CEO memo, Strategist per page, Writer drafts for the lead window, Designer (fake renderer), QA fails mock drafts with mock_output, one inline rework loop; status.json / runs record / calendar re-link", async () => {
  const fx = copyFixture();
  const out = sink();
  try {
    const before = fx.drafts();
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: {}, renderer: fakeRenderer(), stdout: out });
    assert.equal(r.ok, true, out.text());
    assert.equal(r.changed, true);
    assert.deepEqual(validate(r.run, RUN_SPEC), { ok: true, errors: [] });
    assert.equal(r.run.workflow, WORKFLOW);
    assert.equal(r.run.trigger, "local");
    assert.match(r.run.id, /^engine-daily-20261012-0531-[0-9a-f]{6}$/);
    assert.deepEqual(r.agents.map((a) => a.name), AGENT_ORDER, "every agent has a record, in the design's order");

    // CEO: Monday → memo for ISO week 42 with the JSON block
    assert.equal(agent(r, "ceo").calls, 1);
    assert.match(agent(r, "ceo").note, /→ memos\/2026-W42\.md$/);
    assert.ok(fx.state.exists("state/memos/2026-W42.md"));
    assert.match(fx.state.readText("state/memos/2026-W42.md"), /```json\n[\s\S]+\n```\n$/);
    // HR: built (FEAT-204) but due on the 1st only — the fixture's September proposal is on file, so 12 October is not_due
    assert.equal(agent(r, "hr").skipped, "not_due");
    assert.equal(agent(r, "hr").calls, 0);
    assert.match(agent(r, "hr").note, /^skipped: not_due — not the 1st of the month and hr\/proposals\/2026-09\.json exists/);
    // Strategist: one call per page, calendar + ideas written
    assert.equal(agent(r, "strategist").calls, 3);
    const calendar = fx.state.readJson("state/calendar.json", CALENDAR_SPEC);
    assert.ok(calendar.slots.length >= 14, `${calendar.slots.length} slots`);
    assert.ok(fx.state.readJsonl("state/ideas.jsonl").length > 5);
    // Writer: slots within leadDays (3) that had no live draft → new drafts, every one mock:true
    const created = fx.drafts().filter((id) => !before.includes(id));
    assert.ok(created.length >= 3, created.join(","));
    assert.deepEqual(created.filter((id) => id.startsWith("kd-")), [], "kd's Tuesday slot already has the fixture draft; Thursday is outside the lead window");
    for (const id of created) {
      const d = fx.draft(id);
      assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] }, id);
      assert.equal(d.mock, true);
      assert.equal(d.status, "rework", `${id}: mock drafts never reach the queue (M5.4)`);
      assert.equal(d.reworkCount, 2, "first QA failure + one inline loop");
      assert.equal(d.revision, 2, "the inline Writer pass bumped the revision");
      const qa = fx.state.readQa(id);
      assert.deepEqual(qa.reasons, ["mock_output"]);
      assert.equal(qa.model, null, "the model is not called for a mock draft");
    }
    assert.equal(agent(r, "writer").calls, created.length * 2, "one call per new draft + one per inline rework");
    assert.match(agent(r, "writer").note, /rework loop: 0 written, \d+ reworked/);
    assert.match(agent(r, "designer").note, /^\d+ rendered, 0 refused \| rework loop: \d+ rendered, 0 refused$/);
    assert.equal(agent(r, "qa").calls, 0, "mock drafts fail before the model");
    assert.match(agent(r, "qa").note, /^0 queued, \d+ rework, 0 blocked \| rework loop: 0 queued, \d+ rework, 0 blocked$/);
    // the fixture's queued drafts are untouched
    assert.equal(fx.draft(KD).status, "queued");
    assert.equal(fx.draft(RP).status, "queued");
    assert.equal(fx.draft(JR).status, "blocked");

    // status.json (§4.12): counts recomputed, budget from the usage file, lastRuns prepended, flags
    const status = fx.status();
    assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
    assert.deepEqual(status.queue, { rishtapatra: 1, kaatdo: 1, job_rez: 0 });
    assert.deepEqual(status.blocked, { job_rez: 1 });
    assert.equal(status.budget.usedUsd, monthUsedUsd(fx.state, MONDAY));
    assert.equal(status.budget.month, "2026-10");
    assert.equal(status.budget.exhausted, false);
    assert.equal(status.lastRun.id, r.run.id);
    assert.equal(status.lastRuns[0].id, r.run.id);
    assert.equal(status.lastRuns.length, 4, "3 fixture runs + this one");
    assert.deepEqual(status.flags, [], "the fixture's spend is far below the warn threshold");
    assert.equal(status.pages.kaatdo.mode, "approve_first");
    // runs/<month>.jsonl got the record; changed[] lists every written file
    const runs = fx.runs();
    assert.deepEqual(runs.at(-1), r.run);
    assert.ok(r.run.changed.includes("company/state/memos/2026-W42.md"));
    assert.ok(r.run.changed.includes("company/state/calendar.json"));
    assert.ok(r.run.changed.includes("company/state/status.json"));
    assert.ok(r.run.changed.includes("company/state/runs/2026-10.jsonl"));
    for (const id of created) assert.ok(r.run.changed.includes(`company/state/drafts/${id}/qa.json`));
    // R2-05: the engine-owned draft index is rewritten with the run's clock and lists every folder as it stands — the
    // drafts created today (rework after the mock QA) as live entries beside the fixture's
    assert.ok(r.run.changed.includes("company/state/drafts/index.json"), "the index changed (new drafts)");
    const index = fx.state.readDraftIndex();
    assert.equal(index.updatedAt, MONDAY, "stamped with the run's clock");
    assert.deepEqual(index.drafts, fx.state.draftIndexEntries(), "entries mirror the folders");
    assert.deepEqual(index.drafts.map((e) => e.id), fx.drafts(), "one entry per folder, sorted like listDrafts");
    for (const id of created) {
      const e = index.drafts.find((x) => x.id === id);
      assert.equal(e.status, "rework");
      assert.equal(e.qa, true, "qa.json exists after the mock QA");
    }
    const live = index.drafts.filter((e) => !["published", "failed", "rejected", "expired", "blocked"].includes(e.status)).map((e) => e.id).sort();
    assert.deepEqual(live, [...created, KD, RP].sort(), "live = the new rework drafts + the two queued fixture drafts; published and blocked are terminal");
    // the calendar names the drafts written today (slot status derived from the draft)
    for (const id of created) {
      const slot = calendar.slots.find((s) => s.draftId === id);
      assert.ok(slot, `${id} linked to its slot`);
      assert.equal(slot.status, "rework");
    }
    // one scrubbed stdout line per agent (log.stepLine)
    for (const name of AGENT_ORDER) assert.ok(out.lines.some((l) => l.startsWith(`[${name}] `)), name);
    assert.ok(out.lines.at(-1).startsWith("[daily] ok "), out.lines.at(-1));
    // usage lines were appended for every mock call (mock:true, costUsd 0)
    const usage = fx.usage().filter((u) => u.runId === r.run.id);
    assert.equal(usage.length, agent(r, "ceo").calls + agent(r, "strategist").calls + agent(r, "writer").calls);
    for (const u of usage) {
      assertShape(u, USAGE_SPEC);
      assert.equal(u.mock, true);
      assert.equal(u.costUsd, 0);
    }
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("P1-06 / M5.4: a usage file at or over monthlyUsd → budget_exhausted flag, 'skipped: budget_exhausted' for CEO, Strategist, Writer and QA, no new drafts, status.budget.exhausted true", async () => {
  const fx = copyFixture();
  try {
    const limit = JSON.parse(readFileSync(join(fx.dir, "config.json"), "utf8")).budget.monthlyUsd;
    fx.appendUsage({ at: "2026-10-11T12:00:00+05:30", runId: "engine-daily-20261011-0531-f1a2b3", agent: "writer", page: "rishtapatra", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 1, costUsd: limit, ms: 1, ok: true, mock: false });
    const draftsBefore = fx.drafts();
    const treeBefore = treeHash(join(fx.dir, "state", "drafts"));
    const memoBefore = treeHash(join(fx.dir, "state", "memos"));
    const renderer = fakeRenderer();
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: {}, renderer, stdout: () => {} });
    assert.equal(r.ok, true, "a skipped step is not a failure");
    assert.ok(r.flags.includes("budget_exhausted"), r.flags.join());
    assert.ok(r.flags.includes("budget_warn"));
    for (const name of ["ceo", "strategist", "writer", "qa"]) {
      assert.equal(agent(r, name).note, SKIP_BUDGET, name);
      assert.equal(agent(r, name).skipped, "budget_exhausted", name);
      assert.equal(agent(r, name).calls, 0, name);
    }
    assert.deepEqual(fx.drafts(), draftsBefore, "no draft created");
    assert.equal(treeHash(join(fx.dir, "state", "drafts")), treeBefore, "no draft touched");
    assert.equal(renderer.calls.length, 0, "nothing to render");
    assert.equal(treeHash(join(fx.dir, "state", "memos")), memoBefore, "no memo written (Monday, but the CEO is skipped too)");
    const status = fx.status();
    assert.equal(status.budget.exhausted, true);
    assert.equal(status.budget.usedUsd, monthUsedUsd(fx.state, MONDAY));
    assert.ok(status.budget.usedUsd >= limit);
    assert.deepEqual(status.flags, ["budget_exhausted", "budget_warn"]);
    assert.equal(fx.usage().filter((u) => u.runId === r.run.id).length, 0, "no model call was attempted");
    // the designer still runs (deterministic) but has nothing written to render
    assert.equal(agent(r, "designer").note, "0 rendered, 0 refused");
  } finally {
    fx.cleanup();
  }
});

test("P1-08: a rendered draft failing QA (qa.fail fixture) goes to rework, the inline loop reworks it (mock → mock_output) and the next run blocks it after the second rework (reworkCount 2 → blocked)", async () => {
  const fx = copyFixture();
  try {
    // rp is queued in the fixture; put it back in front of QA as a non-mock rendered draft
    const rp = fx.draft(RP);
    fx.state.writeDraft({ ...rp, status: "rendered" });
    // its rendered file must exist under the media worktree for the deterministic media_spec check
    cpSync(join(ROOT, "tests", "fixtures", "media", RP), join(fx.mediaRoot, "media", RP), { recursive: true });
    const env = { MOCK_LLM: "1", MOCK_LLM_CASE_QA: "fail" };
    const flags = { agents: "writer,designer,qa", page: "rishtapatra" };
    const r1 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: TUESDAY, processEnv: env, flags, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(r1.ok, true);
    assert.equal(agent(r1, "qa").calls, 1, "the model judged the real (non-mock) draft once; the reworked mock copy failed before the model");
    let d = fx.draft(RP);
    assert.equal(d.status, "rework");
    assert.equal(d.reworkCount, 2, "QA failure (1) + inline loop failure (2)");
    assert.equal(d.revision, 2, "the inline Writer pass bumped the revision once");
    assert.equal(d.mock, true, "the mock Writer rewrote it");
    const qa1 = fx.state.readQa(RP);
    assert.deepEqual(qa1.reasons, ["mock_output"]);
    assert.match(agent(r1, "qa").note, /^0 queued, 1 rework, 0 blocked \| rework loop: 0 queued, 1 rework, 0 blocked$/);
    assert.match(agent(r1, "writer").note, /^0 written, 0 reworked \| rework loop: 0 written, 1 reworked$/, "nothing to write in the first pass; the loop reworks the draft QA failed");
    for (const name of ["ceo", "hr", "strategist"]) assert.equal(agent(r1, name).skipped, "not_selected", name);

    // next run: Writer reworks (revision 3) → Designer → QA fails → blocked (maxReworkLoops 2)
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-10-14T05:31:00+05:30", processEnv: env, flags, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(r2.ok, true);
    d = fx.draft(RP);
    assert.equal(d.status, "blocked");
    assert.equal(d.reworkCount, 2);
    assert.equal(d.revision, 3);
    assert.match(agent(r2, "qa").note, /^0 queued, 0 rework, 1 blocked$/);
    assert.equal(fx.status().blocked.rishtapatra, 1);
    assert.deepEqual(fx.status().queue, { rishtapatra: 0, kaatdo: 1, job_rez: 0 });
    // a third run leaves the blocked draft alone
    const r3 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-10-15T05:31:00+05:30", processEnv: env, flags, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(r3, "writer").note, "0 written, 0 reworked");
    assert.equal(fx.draft(RP).revision, 3);
  } finally {
    fx.cleanup();
  }
});

test("R1-02: a Designer refusal (RenderError missing_glyphs) sends the draft to rework with 'render: …' first in qaReasons and reworkCount + 1, the inline loop reworks it in the same run (Writer → Designer → QA); at maxReworkLoops the refusal blocks the draft; a RenderUnavailableError still leaves drafts written with the designer row ok:false", async () => {
  const DETAIL = "U+2192 not in Tiro Devanagari Hindi: “→ अभी बनाएं”";
  const fx = copyFixture();
  try {
    // rp is queued in the fixture; put it back in front of the Designer as a non-mock written draft
    const rp = fx.draft(RP);
    assert.equal(rp.reworkCount, 0);
    fx.state.writeDraft({ ...rp, status: "written", media: [] });
    const flags = { agents: "writer,designer,qa", page: "rishtapatra" };
    // the first render of rp is refused (an arrow no artwork font covers); every later render succeeds
    const renderer = fakeRenderer((draft, nth) => (draft.id === RP && nth === 1 ? new RenderError("missing_glyphs", DETAIL, { missingGlyphs: [0x2192] }) : null));
    const out = sink();
    const r1 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: TUESDAY, processEnv: MOCK, flags, renderer, stdout: out });
    assert.equal(r1.ok, true, out.text());
    assert.equal(agent(r1, "designer").ok, true, "a refusal is not a step failure (design §11)");
    assert.equal(agent(r1, "designer").note, "0 rendered, 1 refused (1 to rework, 0 blocked) | rework loop: 1 rendered, 0 refused");
    assert.equal(agent(r1, "writer").note, "0 written, 0 reworked | rework loop: 0 written, 1 reworked", "the Writer reworked the refused draft inside the same run");
    assert.equal(agent(r1, "writer").calls, 1);
    assert.equal(agent(r1, "qa").note, "0 queued, 0 rework, 0 blocked | rework loop: 0 queued, 1 rework, 0 blocked", "nothing was rendered for QA in the first pass; the reworked (mock) copy failed QA with mock_output");
    assert.ok(r1.flags.includes("render_failed"), r1.flags.join());
    assert.ok(out.lines.some((l) => l.startsWith(`[designer] ${RP} refused: missing_glyphs — ${DETAIL} → rework (1 of 2)`)), out.text());
    // what the Designer handed over: the second render saw the Writer's rework of the refused draft
    assert.deepEqual(renderer.calls, [RP, RP]);
    assert.deepEqual(renderer.drafts.map((d) => [d.revision, d.reworkCount, d.qaReasons]), [
      [1, 0, undefined],
      [2, 1, undefined],
    ], "the rework loop's render saw revision 2 with reworkCount 1 (the refusal) and the Writer had cleared the reasons");
    let d = fx.draft(RP);
    assert.equal(d.status, "rework", "QA failed the mock rework (mock_output) → rework again");
    assert.equal(d.reworkCount, 2, "refusal (1) + QA failure in the loop (2)");
    assert.equal(d.revision, 2);
    assert.equal(d.mock, true);
    assert.equal(d.renderError, undefined, "the successful render cleared renderError");
    assert.deepEqual(fx.state.readQa(RP).reasons, ["mock_output"]);
    assert.deepEqual(validate(d, DRAFT_SPEC), { ok: true, errors: [] });
    assert.deepEqual(fx.status().flags, ["render_failed"]);
    const cal = fx.state.readJson("state/calendar.json", CALENDAR_SPEC);
    assert.equal(cal.slots.find((s) => s.draftId === RP).status, "rework");

    // the refusal alone (no QA selected → no inline loop): the draft file shows exactly what the Designer wrote
    const fx2 = copyFixture();
    try {
      fx2.state.writeDraft({ ...fx2.draft(RP), status: "written", media: [] });
      const r2 = await runDaily({ companyDir: fx2.dir, mediaRoot: fx2.mediaRoot, now: TUESDAY, processEnv: MOCK, flags: { agents: "designer", page: "rishtapatra" }, renderer: fakeRenderer(() => new RenderError("missing_glyphs", DETAIL)), stdout: () => {} });
      assert.equal(r2.ok, true);
      const only = fx2.draft(RP);
      assert.equal(only.status, "rework");
      assert.equal(only.reworkCount, 1);
      assert.equal(only.revision, 1);
      assert.ok(only.qaReasons[0].startsWith("render: missing_glyphs"), only.qaReasons.join());
      assert.equal(only.qaReasons[0], `render: missing_glyphs — ${DETAIL}`);
      assert.deepEqual(only.media, []);
      assert.deepEqual(only.renderError, { code: "missing_glyphs", detail: DETAIL, at: TUESDAY });
      assert.deepEqual(validate(only, DRAFT_SPEC), { ok: true, errors: [] });
      assert.equal(agent(r2, "writer").skipped, "not_selected");
      // the next run's Writer picks it up like any rework (same path as a QA failure)
      const r3 = await runDaily({ companyDir: fx2.dir, mediaRoot: fx2.mediaRoot, now: "2026-10-14T05:31:00+05:30", processEnv: MOCK, flags: { agents: "writer", page: "rishtapatra" }, renderer: fakeRenderer(), stdout: () => {} });
      assert.equal(agent(r3, "writer").note, "0 written, 1 reworked");
      assert.equal(fx2.draft(RP).status, "written");
      assert.equal(fx2.draft(RP).revision, 2);
      assert.equal(fx2.draft(RP).qaReasons, undefined);
    } finally {
      fx2.cleanup();
    }

    // at the cap: reworkCount already maxReworkLoops → the refusal blocks the draft (the admin lists blocked drafts)
    const fx3 = copyFixture();
    try {
      const max = JSON.parse(readFileSync(join(fx3.dir, "config.json"), "utf8")).defaults.maxReworkLoops;
      fx3.state.writeDraft({ ...fx3.draft(RP), status: "written", media: [], reworkCount: max, revision: max + 1 });
      const r4 = await runDaily({ companyDir: fx3.dir, mediaRoot: fx3.mediaRoot, now: TUESDAY, processEnv: MOCK, flags, renderer: fakeRenderer(() => new RenderError("missing_glyphs", DETAIL)), stdout: () => {} });
      assert.equal(r4.ok, true);
      assert.equal(agent(r4, "designer").note, "0 rendered, 1 refused (0 to rework, 1 blocked)");
      assert.equal(agent(r4, "writer").note, "0 written, 0 reworked", "a blocked draft is not reworked");
      const capped = fx3.draft(RP);
      assert.equal(capped.status, "blocked");
      assert.equal(capped.reworkCount, max);
      assert.equal(capped.qaReasons[0], `render: missing_glyphs — ${DETAIL}`);
      assert.equal(capped.renderError.code, "missing_glyphs");
      assert.deepEqual(fx3.status().blocked, { rishtapatra: 1, job_rez: 1 });
      assert.deepEqual(fx3.status().queue, { rishtapatra: 0, kaatdo: 1, job_rez: 0 });
      assert.ok(fx3.status().flags.includes("render_failed"));
    } finally {
      fx3.cleanup();
    }

    // RenderUnavailableError (no Chromium): step-level failure, drafts stay written, nothing reworked
    const fx4 = copyFixture();
    try {
      fx4.state.writeDraft({ ...fx4.draft(RP), status: "written", media: [] });
      const r5 = await runDaily({ companyDir: fx4.dir, mediaRoot: fx4.mediaRoot, now: TUESDAY, processEnv: MOCK, flags, renderer: fakeRenderer(() => new RenderUnavailableError("Chromium could not be launched: spawn ENOENT")), stdout: () => {} });
      assert.equal(r5.ok, true, "run-level ok (design §11): the failed step is on its own row");
      assert.equal(agent(r5, "designer").ok, false);
      assert.match(agent(r5, "designer").note, /0 rendered, 0 refused, stopped: Chromium could not be launched/);
      assert.equal(fx4.draft(RP).status, "written");
      assert.equal(fx4.draft(RP).reworkCount, 0);
      assert.equal(agent(r5, "writer").note, "0 written, 0 reworked");
      assert.ok(r5.flags.includes("render_failed"));
    } finally {
      fx4.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test("R1-05: when every provider fails with retryable 503s the agent row is ok:false, the run stays ok, and status.flags carries provider_down:<name> for each provider that was actually attempted (not for the ones skipped for a missing secret); the flags are dropped by a later run that succeeds", async () => {
  const KEYS = { ANTHROPIC_API_KEY: "FAKE-anthropic-key-aaaaaaaaaaaaaaaaaaaaaaaa", GEMINI_API_KEY: "FAKE-gemini-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbb", OPENAI_API_KEY: "FAKE-openai-key-cccccccccccccccccccccccccccc" };
  const calls = [];
  const down = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } });
  };
  const noSleep = async () => {};
  const roster = JSON.parse(readFileSync(join(COMPANY_DIR, "roster.json"), "utf8"));
  const ceo = roster.agents.find((a) => a.name === "ceo");
  const chain = [ceo.provider, ...ceo.fallback];
  assert.equal(chain.length, 3, "the CEO has two fallbacks in the fixture roster");
  const fx = copyFixture();
  try {
    // every provider configured → each is attempted (3 tries each) → every one is flagged
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: KEYS, fetchImpl: down, sleep: noSleep, flags: { agents: "ceo" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(r.ok, true, "a failed agent step is not a run failure (design §11)");
    assert.equal(r.run.ok, true);
    assert.equal(agent(r, "ceo").ok, false);
    assert.match(agent(r, "ceo").note, /^AllProvidersFailedError: ceo: no provider answered — /);
    assert.equal(agent(r, "ceo").calls, 9, "3 attempts × 3 providers");
    assert.equal(calls.length, 9);
    assert.deepEqual([...r.flags].sort(), chain.map((p) => `provider_down:${p}`).sort());
    assert.deepEqual([...fx.status().flags].sort(), chain.map((p) => `provider_down:${p}`).sort());
    assert.deepEqual(validate(fx.status(), STATUS_SPEC), { ok: true, errors: [] });
    const usage = fx.usage().filter((u) => u.runId === r.run.id);
    assert.equal(usage.length, 9);
    assert.ok(usage.every((u) => u.ok === false && u.costUsd === 0 && !u.mock));
    for (const v of Object.values(KEYS)) assert.ok(!JSON.stringify([r.run, fx.status(), usage]).includes(v), "no key material in the state");

    // only the primary has a secret → only the primary is attempted and flagged; the skipped fallbacks are not "down"
    // (the Writer is given a draft in rework so it has one call to make; the writer's chain is anthropic → gemini, openai)
    fx.state.writeDraft({ ...fx.draft(RP), status: "rework", qaReasons: ["tone: too salesy"] });
    calls.length = 0;
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: TUESDAY, processEnv: { ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY }, fetchImpl: down, sleep: noSleep, flags: { agents: "writer", page: "rishtapatra" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(r2.ok, true);
    assert.equal(agent(r2, "writer").ok, false);
    assert.equal(agent(r2, "writer").calls, 3, "3 attempts on anthropic; gemini and openai skipped (secret missing) → not attempted, not flagged");
    assert.equal(calls.length, 3);
    assert.deepEqual(r2.flags, ["provider_down:anthropic"]);
    assert.deepEqual(fx.status().flags, ["provider_down:anthropic"], "the stale gemini/openai flags from the previous run are dropped");
    assert.equal(fx.draft(RP).status, "rework", "nothing was written for the draft");

    // a run with the mock adapter (every call answers) clears the provider flags — daily owns them
    const r3 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-10-14T05:31:00+05:30", processEnv: MOCK, flags: { agents: "hr" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(r3.ok, true);
    assert.deepEqual(fx.status().flags, []);
  } finally {
    fx.cleanup();
  }
  assert.equal(FETCH_ATTEMPTS.length, 0, "every call went through the injected fetchImpl, none through globalThis.fetch");
});

test("P1-24: a corrupted config.json → ok:false (CLI exit 1) and the ONLY write is runs/<month>.jsonl { ok:false, errors[] }", async () => {
  const fx = copyFixture();
  try {
    writeFileSync(join(fx.dir, "config.json"), "{ broken", "utf8");
    const notRuns = (rel) => rel.startsWith("state/runs/");
    const before = treeHash(fx.dir, notRuns);
    const out = sink();
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: {}, renderer: fakeRenderer(), stdout: out });
    assert.equal(r.ok, false);
    assert.equal(r.changed, false);
    assert.ok(r.errors.some((e) => e.includes("config.json")), r.errors.join());
    assert.match(out.text(), /\[daily\] error: config\.json/);
    const runs = fx.runs();
    assert.equal(runs.length, 4, "3 fixture records + this one");
    const run = runs.at(-1);
    assert.deepEqual(validate(run, RUN_SPEC), { ok: true, errors: [] });
    assert.equal(run.ok, false);
    assert.deepEqual(run.agents, []);
    assert.ok(run.errors.some((e) => e.includes("config.json")));
    assert.deepEqual(run.changed, ["company/state/runs/2026-10.jsonl"]);
    assert.equal(treeHash(fx.dir, notRuns), before, "nothing else changed");
    // a corrupted draft is fatal the same way
    const fx2 = copyFixture();
    try {
      writeFileSync(join(fx2.dir, "state", "drafts", KD, "draft.json"), JSON.stringify({ id: KD, status: "nope" }), "utf8");
      const r2 = await runDaily({ companyDir: fx2.dir, mediaRoot: fx2.mediaRoot, now: MONDAY, processEnv: MOCK, flags: {}, renderer: fakeRenderer(), stdout: () => {} });
      assert.equal(r2.ok, false);
      assert.ok(r2.errors.some((e) => e.includes(`drafts/${KD}/draft.json`)), r2.errors.join());
      assert.equal(fx2.runs().length, 4);
      assert.equal(fx2.runs().at(-1).ok, false);
    } finally {
      fx2.cleanup();
    }
    // CLI: exit 1
    const fx3 = copyFixture();
    try {
      writeFileSync(join(fx3.dir, "roster.json"), "[]", "utf8");
      const err = sink();
      const code = await main(["daily"], { stdout: sink(), stderr: err, processEnv: { ...MOCK, MEDIA_DIR: fx3.mediaRoot }, companyDir: fx3.dir });
      assert.equal(code, EXIT.failed);
    } finally {
      fx3.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test("M16: without .media/.git the Designer and QA are skipped with media_branch_missing, the flag is set, written drafts stay written and nothing is rendered", async () => {
  const fx = copyFixture({ media: false });
  try {
    const renderer = fakeRenderer();
    const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: {}, renderer, stdout: () => {} });
    assert.equal(r.ok, true, "a clean skip is not a failure");
    assert.equal(agent(r, "designer").skipped, "media_branch_missing");
    assert.match(agent(r, "designer").note, /media_branch_missing .*not configured yet/);
    assert.equal(agent(r, "qa").skipped, "media_branch_missing");
    assert.equal(renderer.calls.length, 0);
    assert.ok(r.flags.includes("media_branch_missing"));
    assert.deepEqual(fx.status().flags, ["media_branch_missing"]);
    const written = fx.drafts().filter((id) => fx.draft(id).status === "written");
    assert.ok(written.length >= 3, "the Writer's drafts wait for the worktree");
    assert.ok(!existsSync(join(fx.mediaRoot, "index.json")));
    // once the worktree exists the next run renders them and the flag clears
    writeFileSync(join(fx.mediaRoot, ".git"), "gitdir: x\n");
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: TUESDAY, processEnv: MOCK, flags: {}, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(r2, "designer").skipped, undefined);
    assert.match(agent(r2, "designer").note, /^\d+ rendered, 0 refused/);
    assert.ok(!fx.status().flags.includes("media_branch_missing"), "daily owns and clears its own flags");
  } finally {
    fx.cleanup();
  }
});

test("M9: status.json.lastRuns keeps at most 20 entries after 25 runs; runs/<month>.jsonl keeps them all", async () => {
  const fx = copyFixture();
  try {
    const base = fx.runs().length;
    for (let i = 0; i < 25; i++) {
      const now = new Date(Date.parse(MONDAY) + i * 60000);
      const r = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now, processEnv: MOCK, flags: { agents: "hr" }, renderer: fakeRenderer(), stdout: () => {} });
      assert.equal(r.ok, true);
      for (const name of AGENT_ORDER) if (name !== "hr") assert.equal(agent(r, name).skipped, "not_selected", name);
    }
    const status = fx.status();
    assert.equal(status.lastRuns.length, 20);
    assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
    assert.equal(fx.runs().length, base + 25);
    assert.equal(status.lastRuns[0].id, fx.runs().at(-1).id, "newest first");
  } finally {
    fx.cleanup();
  }
});

test("CEO cadence: runs on Monday even when the memo exists, skips Tuesday when this week's memo exists, runs on a weekday whose memo is missing; --page skips the company-wide CEO unless --agents names it", async () => {
  const fx = copyFixture();
  try {
    const only = { agents: "ceo" };
    const memo = join(fx.dir, "state", "memos", "2026-W42.md");
    assert.ok(existsSync(memo), "the fixture already carries this week's memo");
    const mon = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: only, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(mon, "ceo").calls, 1, "Monday always runs");
    const tue = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: TUESDAY, processEnv: MOCK, flags: only, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(tue, "ceo").calls, 0);
    assert.equal(agent(tue, "ceo").skipped, "not_due");
    assert.equal(agent(tue, "ceo").note, "skipped: not Monday and state/memos/2026-W42.md exists");
    rmSync(memo);
    const tue2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: TUESDAY, processEnv: MOCK, flags: only, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(tue2, "ceo").calls, 1, "memo missing → runs on a Tuesday");
    assert.ok(existsSync(memo), "memo written back");
    // another week: the single mock fixture is pinned to 2026-W42, so under MOCK_LLM the week rule is not
    // enforced (a real provider is always held to it) and the dry run still produces a memo file
    const w43 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: "2026-10-20T05:31:00+05:30", processEnv: MOCK, flags: only, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(w43, "ceo").ok, true);
    assert.equal(agent(w43, "ceo").calls, 1, "no repair call for the mock's fixed week");
    assert.ok(existsSync(join(fx.dir, "state", "memos", "2026-W43.md")));
    const paged = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { page: "kaatdo" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(paged, "ceo").skipped, "page_filter");
    assert.equal(agent(paged, "strategist").calls, 1, "one page only");
    assert.match(agent(paged, "strategist").note, /^kaatdo: /);
    assert.equal(agent(paged, "writer").note, "0 written, 0 reworked", "kd's Tuesday slot has a draft; Thursday is outside the lead window");
    const pagedCeo = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { page: "kaatdo", agents: "ceo" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(agent(pagedCeo, "ceo").calls, 1, "--agents ceo with --page still runs the CEO");
    await assert.rejects(runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { page: "nobody" }, renderer: fakeRenderer(), stdout: () => {} }), /unknown page "nobody"/);
    assert.throws(() => parseAgents("ceo,nobody"), /unknown agent "nobody"/);
    assert.equal(parseAgents(undefined), null);
    assert.deepEqual([...parseAgents(" writer, qa ")], ["writer", "qa"]);
  } finally {
    fx.cleanup();
  }
});

test("CLI: `daily --dry-run` runs on a temp copy and leaves the fixture byte-identical; --now needs --dry-run; the summary names the temp path; without --commit the real run says 'not committed'", async () => {
  const before = treeHash(COMPANY_DIR);
  const out = sink();
  const err = sink();
  const code = await main(["daily", "--dry-run", "--now", MONDAY, "--agents", "hr,strategist,designer"], { stdout: out, stderr: err, processEnv: { ...MOCK, MEDIA_DIR: "tests/fixtures/media" }, companyDir: COMPANY_DIR });
  assert.equal(code, EXIT.ok, out.text() + err.text());
  assert.equal(treeHash(COMPANY_DIR), before, "the fixture company is untouched");
  assert.equal(err.lines.length, 0);
  assert.match(out.lines[0], /^daily: --dry-run works on a temp copy .*hoshlab-daily-dry-run-/);
  assert.ok(out.lines.some((l) => l.startsWith("[strategist] ok ")), out.text());
  assert.ok(out.lines.some((l) => l.startsWith("[designer] ok ") && l.includes("skipped: media_branch_missing")), "tests/fixtures/media has no .git → the designer skips honestly");
  assert.match(out.lines.at(-1), /^daily: dry run complete — state written under .*; nothing committed$/);
  const tmp = out.lines[0].match(/temp copy (.+) \(the repo/)[1];
  assert.ok(existsSync(join(tmp, "state", "runs", "2026-10.jsonl")));
  assert.equal(JSON.parse(readFileSync(join(tmp, "state", "status.json"), "utf8")).lastRuns[0].dryRun, true);
  rmSync(join(tmp, ".."), { recursive: true, force: true });

  const e2 = sink();
  assert.equal(await main(["daily", "--now", MONDAY], { stdout: sink(), stderr: e2, processEnv: MOCK, companyDir: COMPANY_DIR }), EXIT.usage);
  assert.match(e2.text(), /--now <iso> is accepted only with --dry-run/);
  const e3 = sink();
  assert.equal(await main(["daily", "--agents", "frobnicate"], { stdout: sink(), stderr: e3, processEnv: MOCK, companyDir: COMPANY_DIR }), EXIT.usage);
  assert.match(e3.text(), /unknown agent "frobnicate"/);

  // a real (non dry-run) run on a temp copy writes there and reports 'not committed' without CI or --commit
  const fx = copyFixture();
  try {
    const out4 = sink();
    const code4 = await main(["daily", "--agents", "hr"], { stdout: out4, stderr: sink(), processEnv: { ...MOCK, MEDIA_DIR: fx.mediaRoot }, companyDir: fx.dir });
    assert.equal(code4, EXIT.ok, out4.text());
    assert.match(out4.lines.at(-1), /^daily: 2 files changed under .*, not committed \(pass --commit\)$/);
    assert.equal(fx.runs().length, 4);
  } finally {
    fx.cleanup();
  }
  assert.equal(treeHash(COMPANY_DIR), before);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("pure helpers: slotsToWrite (lead window, live drafts, dropped slots), recentCaptionsFor (newest first), relinkCalendar (links today's drafts, derives slot status)", () => {
  const page = { handle: "kaatdo" };
  const now = "2026-10-12T05:31:00+05:30";
  const slots = [
    { slotId: "kaatdo-2026-10-13-0815", page: "kaatdo", at: "2026-10-13T08:15:00+05:30", format: "image", ideaId: "kd-i0007", draftId: KD, status: "queued" },
    { slotId: "kaatdo-2026-10-15-0815", page: "kaatdo", at: "2026-10-15T08:15:00+05:30", format: "image", ideaId: "kd-i0008", status: "planned" }, // 3.1 days → outside leadDays 3
    { slotId: "kaatdo-2026-10-14-1100", page: "kaatdo", at: "2026-10-14T11:00:00+05:30", format: "carousel", ideaId: "kd-i0009", status: "planned" },
    { slotId: "kaatdo-2026-10-14-1500", page: "kaatdo", at: "2026-10-14T15:00:00+05:30", format: "image", ideaId: "kd-i0010", status: "dropped" },
    { slotId: "kaatdo-2026-10-11-0815", page: "kaatdo", at: "2026-10-11T08:15:00+05:30", format: "image", ideaId: "kd-i0011", status: "planned" }, // past
    { slotId: "rishtapatra-2026-10-12-1930", page: "rishtapatra", at: "2026-10-12T19:30:00+05:30", format: "image", ideaId: "rp-i0001", status: "planned" },
  ];
  const drafts = [
    { id: KD, page: "kaatdo", slotId: "kaatdo-2026-10-13-0815", status: "queued", createdAt: "2026-10-10T05:33:00+05:30", caption: "old" },
    { id: "kd-2026-10-14-x", page: "kaatdo", slotId: "kaatdo-2026-10-14-1100", status: "blocked", createdAt: "2026-10-11T05:33:00+05:30", caption: "blocked one" },
  ];
  assert.deepEqual(
    slotsToWrite({ slots }, drafts, page, now, 3).map((s) => s.slotId),
    ["kaatdo-2026-10-14-1100"],
    "the carousel slot's only draft is terminal, so it needs a Writer; queued/dropped/past/far/other-page slots do not",
  );
  assert.deepEqual(recentCaptionsFor(drafts, "kaatdo"), ["blocked one", "old"]);
  assert.deepEqual(recentCaptionsFor(drafts, "kaatdo", KD), ["blocked one"]);
  const fresh = { id: "kd-2026-10-14-y", page: "kaatdo", slotId: "kaatdo-2026-10-14-1100", status: "written", createdAt: "2026-10-12T05:35:00+05:30", caption: "new" };
  const relinked = relinkCalendar({ generatedAt: now, horizonDays: 14, slots }, [...drafts, fresh]);
  assert.ok(relinked);
  const by = Object.fromEntries(relinked.slots.map((s) => [s.slotId, s]));
  assert.equal(by["kaatdo-2026-10-14-1100"].draftId, fresh.id);
  assert.equal(by["kaatdo-2026-10-14-1100"].status, "written");
  assert.equal(by["kaatdo-2026-10-13-0815"].status, "queued");
  assert.equal(by["kaatdo-2026-10-14-1500"].status, "dropped", "dropped stays dropped");
  assert.equal(relinkCalendar({ generatedAt: now, horizonDays: 14, slots: relinked.slots }, [...drafts, fresh]), null, "idempotent");
  assert.equal(relinkCalendar(null, drafts), null);
});

test("set-page: rewrites config.json mode/modeChangedAt/modeChangedBy with key order preserved, validates, is idempotent; CLI prints the consequences and exits 2 on usage errors", async () => {
  const fx = copyFixture();
  try {
    const path = join(fx.dir, "config.json");
    const before = readFileSync(path, "utf8");
    const stateBefore = treeHash(join(fx.dir, "state"));
    const keysBefore = Object.keys(JSON.parse(before).pages[1]);
    const r = setPageMode({ companyDir: fx.dir, handle: "kaatdo", mode: "autopilot", now: "2026-10-12T10:00:00+05:30" });
    assert.deepEqual([r.changed, r.previous, r.mode, r.modeChangedAt], [true, "approve_first", "autopilot", "2026-10-12T10:00:00+05:30"]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    const kd = after.pages.find((p) => p.handle === "kaatdo");
    assert.deepEqual([kd.mode, kd.modeChangedAt, kd.modeChangedBy], ["autopilot", "2026-10-12T10:00:00+05:30", "owner-cli"]);
    assert.deepEqual(Object.keys(kd), keysBefore, "key order preserved");
    assert.equal(after.pages.find((p) => p.handle === "rishtapatra").mode, "approve_first", "other pages untouched");
    assert.ok(!readFileSync(path, "utf8").startsWith("\uFEFF"), "no BOM");
    assert.ok(readFileSync(path, "utf8").endsWith("\n"));
    const again = setPageMode({ companyDir: fx.dir, handle: "kaatdo", mode: "autopilot" });
    assert.equal(again.changed, false, "idempotent: nothing written when the mode is already set");
    assert.throws(() => setPageMode({ companyDir: fx.dir, handle: "kaatdo", mode: "yolo" }), /--mode must be one of approve_first\|autopilot/);
    assert.throws(() => setPageMode({ companyDir: fx.dir, handle: "nobody", mode: "autopilot" }), /unknown page "nobody"/);
    assert.equal(treeHash(join(fx.dir, "state")), stateBefore, "set-page writes config.json only; state/ is untouched");

    const out = sink();
    assert.equal(await main(["set-page", "--page", "kaatdo", "--mode", "approve_first"], { stdout: out, stderr: sink(), processEnv: {}, companyDir: fx.dir }), EXIT.ok);
    assert.match(out.lines[0], /^set-page: @kaatdo autopilot -> approve_first \(modeChangedAt .+, modeChangedBy owner-cli\)/);
    assert.ok(out.lines.some((l) => /Approve first stops unapproved posting immediately/.test(l)), out.text());
    const out2 = sink();
    assert.equal(await main(["set-page", "--page", "rishtapatra", "--mode", "autopilot"], { stdout: out2, stderr: sink(), processEnv: {}, companyDir: fx.dir }), EXIT.ok);
    assert.ok(out2.lines.some((l) => /Autopilot applies to drafts already in the queue/.test(l)), out2.text());
    const err = sink();
    assert.equal(await main(["set-page", "--page", "kaatdo"], { stdout: sink(), stderr: err, processEnv: {}, companyDir: fx.dir }), EXIT.usage);
    assert.match(err.text(), /usage: node engine\/index\.js set-page/);
    // the file still validates and the daily run reads the new mode into status.json
    const r2 = await runDaily({ companyDir: fx.dir, mediaRoot: fx.mediaRoot, now: MONDAY, processEnv: MOCK, flags: { agents: "hr" }, renderer: fakeRenderer(), stdout: () => {} });
    assert.equal(r2.ok, true);
    assert.equal(fx.status().pages.rishtapatra.mode, "autopilot");
    assert.equal(fx.status().pages.kaatdo.mode, "approve_first");
  } finally {
    fx.cleanup();
  }
});
