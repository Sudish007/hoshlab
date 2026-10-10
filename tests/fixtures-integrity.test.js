// tests/fixtures/company-populated is the company the site and admin build from, so every number in it
// must be computed, not typed (coder rule 7): media rows match the committed JPEGs byte for byte,
// budget.usedUsd is the sum of the usage lines, queue/blocked counts come from the drafts, and every
// state file validates against its spec (engine/lib/state.js validateTree).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, ROOT } from "./helpers.js";
import { createState, validateTree } from "../engine/lib/state.js";
import { round6 } from "../engine/lib/budget.js";
import { jpegSize } from "../engine/lib/checks.js";
import { MAX_MEDIA_BYTES } from "../engine/lib/checks.js";
import { pagesUrl, rawUrl } from "../engine/lib/media.js";
import { parseMemo, outputSpec, validateCeoOutput } from "../engine/agents/ceo.js";
import { assertShape } from "../engine/lib/schema.js";
import { loadCompany } from "../src/lib/company.js";
import { usableFacts } from "../engine/lib/brand.js";
import { queueCounts } from "../engine/commands/publish.js";

const MEDIA = join(ROOT, "tests", "fixtures", "media");
const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, brands } = company;
const state = createState({ companyDir: COMPANY_DIR, now: "2026-10-12T09:04:40+05:30" });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const drafts = state.listDrafts().map((id) => state.readDraft(id));

test("every fixture draft's media[] names an existing file under tests/fixtures/media/<draftId>/ with matching bytes, sha256, sha8 file name, 1080×1350 SOF and the config's raw/pages URLs", () => {
  assert.ok(drafts.length >= 5, drafts.map((d) => d.id).join());
  let files = 0;
  for (const d of drafts) {
    assert.ok(d.media.length >= 1, `${d.id}: no media`);
    assert.equal(d.media.length, d.format === "carousel" ? d.slides.length : 1, `${d.id}: one file per slide / one image`);
    for (const [i, m] of d.media.entries()) {
      const file = m.path.split("/").pop();
      assert.equal(m.path, `media/${d.id}/${file}`);
      const abs = join(MEDIA, d.id, file);
      assert.ok(existsSync(abs), `${abs} missing`);
      const buf = readFileSync(abs);
      assert.equal(m.bytes, buf.length, `${d.id} ${file}: bytes`);
      assert.equal(m.sha256, sha256(buf), `${d.id} ${file}: sha256`);
      assert.equal(file, `${d.format === "carousel" ? "slide" : "image"}-${i + 1}-${m.sha256.slice(0, 8)}.jpg`, "sha8-named");
      assert.deepEqual(jpegSize(buf), { width: 1080, height: 1350 });
      assert.deepEqual([m.width, m.height], [1080, 1350]);
      assert.ok(buf.length <= MAX_MEDIA_BYTES);
      assert.equal(m.rawUrl, rawUrl(config, m.path));
      assert.equal(m.pagesUrl, pagesUrl(config, m.path));
      files++;
    }
  }
  // and nothing under tests/fixtures/media/<id>/ is orphaned (the flat fixture-1080x1350.jpg at the root is the QA unit fixture)
  const onDisk = readdirSync(MEDIA)
    .filter((n) => statSync(join(MEDIA, n)).isDirectory())
    .flatMap((id) => readdirSync(join(MEDIA, id)).map((f) => `media/${id}/${f}`))
    .sort();
  assert.deepEqual(onDisk, drafts.flatMap((d) => d.media.map((m) => m.path)).sort());
  assert.equal(files, onDisk.length);
});

test("status.json: budget.usedUsd equals the sum of usage/2026-10.jsonl costUsd (6 decimals), queue/blocked equal the draft counts, lastRuns mirror runs/2026-10.jsonl newest first, lastPublishedAt matches published.jsonl", () => {
  const status = state.readJson("state/status.json");
  const usage = state.readJsonl("state/usage/2026-10.jsonl");
  assert.ok(usage.length >= 6, `${usage.length} usage lines`);
  assert.equal(status.budget.usedUsd, round6(usage.reduce((s, u) => s + u.costUsd, 0)));
  assert.equal(status.budget.month, "2026-10");
  assert.equal(status.budget.limitUsd, config.budget.monthlyUsd);
  assert.equal(status.budget.exhausted, false);
  // every costUsd is the price-table arithmetic for its tokens; the mock line costs nothing
  for (const u of usage) {
    if (u.mock) {
      assert.equal(u.costUsd, 0);
      assert.equal(u.provider, "mock");
      continue;
    }
    const price = config.providers[u.provider].models[u.model];
    assert.ok(price, `${u.provider}/${u.model} has a price row`);
    assert.equal(u.costUsd, round6((u.inputTokens * price.inputPerMTok) / 1e6 + (u.outputTokens * price.outputPerMTok) / 1e6), `${u.agent} ${u.at}`);
  }
  assert.deepEqual(new Set(usage.map((u) => u.provider)), new Set(["anthropic", "gemini", "openai", "mock"]), "all providers + one mock line");
  assert.equal(usage.filter((u) => u.mock).length, 1);
  const counts = queueCounts(drafts, config);
  assert.deepEqual(status.queue, counts.queue);
  assert.deepEqual(status.blocked, counts.blocked);
  assert.deepEqual(status.queue, { rishtapatra: 1, kaatdo: 1, job_rez: 0 });
  assert.deepEqual(status.blocked, { job_rez: 1 });
  const runs = state.readJsonl("state/runs/2026-10.jsonl");
  assert.equal(runs.length, 3);
  assert.deepEqual(new Set(runs.map((r) => r.workflow)), new Set(["engine-daily", "publisher-hourly"]));
  assert.deepEqual(status.lastRuns, [...runs].sort((a, b) => b.endedAt.localeCompare(a.endedAt)), "newest first");
  assert.deepEqual(status.lastRun, { id: status.lastRuns[0].id, workflow: status.lastRuns[0].workflow, ok: status.lastRuns[0].ok, at: status.lastRuns[0].endedAt });
  for (const r of runs) {
    for (const a of r.agents) assert.ok(typeof a.note === "string" && a.note.length > 0, `${r.id} ${a.name}: note`);
    // agents' calls / costUsd are the usage lines of that run
    for (const a of r.agents) {
      const rows = usage.filter((u) => u.runId === r.id && u.agent === a.name);
      assert.equal(a.calls, rows.length, `${r.id} ${a.name}: calls`);
      assert.equal(a.costUsd, round6(rows.reduce((s, u) => s + u.costUsd, 0)), `${r.id} ${a.name}: costUsd`);
    }
    assert.equal(r.budgetUsedUsd, round6(usage.filter((u) => u.at <= r.endedAt).reduce((s, u) => s + u.costUsd, 0)), `${r.id}: budgetUsedUsd is the spend up to its end`);
  }
  const published = state.readJsonl("state/published.jsonl");
  assert.equal(published.length, 2);
  assert.deepEqual(new Set(published.map((p) => p.page)), new Set(["rishtapatra", "kaatdo"]));
  for (const p of published) {
    assert.equal(p.mediaUrlUsed, "raw");
    assert.match(p.permalink, /^https:\/\/www\.instagram\.com\/p\/FIXTURE/, "visibly fixture permalinks");
    const d = drafts.find((x) => x.id === p.draftId);
    assert.ok(d, `${p.draftId} has a draft dir`);
    assert.equal(d.status, "published");
    assert.equal(d.publishAttempts.at(-1).ok, true);
    assert.equal(d.publishAttempts.at(-1).runId, p.runId);
    assert.equal(status.pages[p.page].lastPublishedAt, p.publishedAt);
    assert.ok(state.readQa(p.draftId).passed);
  }
  assert.equal(status.pages.job_rez.lastPublishedAt, null);
  const feedback = state.readJsonl("state/feedback.jsonl");
  assert.equal(feedback.length, 2);
  assert.ok(feedback.some((f) => f.kind === "reject" && f.tags.includes("tone")));
  assert.ok(feedback.some((f) => f.kind === "note"));
  const reject = feedback.find((f) => f.kind === "reject");
  assert.ok(state.readJsonl("state/approvals.jsonl").some((a) => a.decision === "reject" && a.draftId === reject.draftId && a.reason === reject.text), "the reject has its approvals record");
  assert.equal(state.readJsonl("state/overrides.jsonl").length, 1);
});

test("every fixture state file validates against its spec; memos carry a CEO JSON block that validates; the fixture tree is exactly what validateTree knows", () => {
  const tree = validateTree(COMPANY_DIR);
  assert.deepEqual(tree.errors, []);
  assert.ok(tree.files.length >= 23, `${tree.files.length} files`);
  const kinds = new Set(tree.files.map((f) => f.kind));
  for (const k of ["config", "roster", "status", "calendar", "idea", "approval", "override", "feedback", "published", "run", "usage", "draft", "qa", "memo"]) assert.ok(kinds.has(k), k);
  const memos = tree.files.filter((f) => f.kind === "memo").map((f) => f.rel);
  assert.deepEqual(memos, ["state/memos/2026-W41.md", "state/memos/2026-W42.md"]);
  const handles = config.pages.map((p) => p.handle);
  const pages = config.pages.map((p) => ({ handle: p.handle, factIds: new Set(usableFacts(brands[p.handle]).map((f) => f.id)) }));
  for (const rel of memos) {
    const json = parseMemo(state.readText(rel));
    assert.ok(json, `${rel}: JSON block`);
    assertShape(json, outputSpec(handles));
    assert.deepEqual(validateCeoOutput(json, { week: rel.match(/(\d{4}-W\d{2})/)[1], pages }), []);
  }
  // the calendar links every live draft to its slot with the draft's status
  const calendar = state.readJson("state/calendar.json");
  for (const d of drafts) {
    const slot = calendar.slots.find((s) => s.draftId === d.id);
    assert.ok(slot, `${d.id} has a calendar slot`);
    assert.equal(slot.status, d.status);
    assert.equal(slot.slotId, d.slotId);
  }
});
