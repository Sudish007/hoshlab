// engine/commands/retention.js + engine/lib/media.js retireFiles (design §8.6 retention; P2-10; FEAT-202) on a temp
// media dir: a reel published 91 days ago loses its MP4, keeps its poster, and index.json records removedAt; younger
// reels, images, dry-run records and samples are untouched; --dry-run removes nothing; the commit message is
// 'media: retention <date> (<n> files)'. No git, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, tmpDir } from "./helpers.js";
import { EXIT, main } from "../engine/index.js";
import { createState } from "../engine/lib/state.js";
import { PUBLISHED_SPEC, assertShape } from "../engine/lib/schema.js";
import { indexFiles, readIndex, retireFiles, updateIndex } from "../engine/lib/media.js";
import { MP4_RE, RETENTION_DAYS, ageDays, commitMessage, mp4sOf, retentionPlan, runRetention } from "../engine/commands/retention.js";

const NOW = "2027-01-18T07:31:00+05:30"; // a Monday, 91 days after the OLD reel below
const OLD = "kd-reel-2026-10-18-six-rules"; // published 2026-10-18 → 91 days before NOW
const YOUNG = "rp-reel-2027-01-09-kundali-free"; // published 9 days before NOW
const IMG = "kd-2026-10-13-six-rules"; // an image published long ago: images are never touched
const record = (draftId, page, format, publishedAt, extra = {}) => ({ draftId, page, igMediaId: `179${draftId.length}`, permalink: `https://www.instagram.com/p/${draftId.slice(0, 6)}/`, publishedAt, slotAt: publishedAt, late: false, mode: "approve_first", qaRevision: 1, format, mediaUrlUsed: "raw", runId: "publisher-hourly-20261018-1130-aa11bb", ...extra });

// A temp company (copy of the populated fixture with its own published.jsonl) + a temp media root with files.
function harness() {
  const base = tmpDir("hoshlab-retention-");
  const companyDir = join(base, "company");
  cpSync(COMPANY_DIR, companyDir, { recursive: true });
  const mediaRoot = join(base, ".media");
  const rows = [
    record(IMG, "kaatdo", "image", "2026-10-13T08:31:00+05:30"),
    record(OLD, "kaatdo", "reel", "2026-10-18T11:31:00+05:30"),
    record(YOUNG, "rishtapatra", "reel", "2027-01-09T19:31:00+05:30"),
    record("jr-reel-2026-09-01-dry", "job_rez", "reel", "2026-09-01T12:31:00+05:30", { dryRun: true }),
  ];
  for (const r of rows) assertShape(r, PUBLISHED_SPEC);
  writeFileSync(join(companyDir, "state", "published.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const put = (draftId, file, bytes = 16) => {
    mkdirSync(join(mediaRoot, "media", draftId), { recursive: true });
    writeFileSync(join(mediaRoot, "media", draftId, file), Buffer.alloc(bytes, 7));
  };
  put(IMG, "image-1-711972b4.jpg");
  put(OLD, "reel-aaaaaaaa.mp4", 4096);
  put(OLD, "poster-bbbbbbbb.jpg");
  put(YOUNG, "reel-cccccccc.mp4", 4096);
  put(YOUNG, "poster-dddddddd.jpg");
  put("jr-reel-2026-09-01-dry", "reel-eeeeeeee.mp4", 64);
  put("sample-kaatdo-reel", "reel-ffffffff.mp4", 64);
  updateIndex(mediaRoot, IMG, ["image-1-711972b4.jpg"]);
  updateIndex(mediaRoot, OLD, ["reel-aaaaaaaa.mp4", "poster-bbbbbbbb.jpg"]);
  updateIndex(mediaRoot, YOUNG, ["reel-cccccccc.mp4", "poster-dddddddd.jpg"]);
  updateIndex(mediaRoot, "jr-reel-2026-09-01-dry", ["reel-eeeeeeee.mp4"]);
  updateIndex(mediaRoot, "sample-kaatdo-reel", ["reel-ffffffff.mp4"], { sample: true, page: "kaatdo", format: "reel", at: "2026-10-11T12:00:00+05:30" });
  return { base, companyDir, mediaRoot, rows, state: createState({ companyDir, now: NOW }), cleanup: () => rmSync(base, { recursive: true, force: true }), has: (draftId, file) => existsSync(join(mediaRoot, "media", draftId, file)) };
}

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

test("helpers: 90 days, ageDays, the MP4 pattern, commit message, mp4sOf (index + disk)", () => {
  assert.equal(RETENTION_DAYS, 90);
  assert.equal(ageDays("2026-10-18T11:31:00+05:30", NOW), 91);
  assert.equal(ageDays("2027-01-09T19:31:00+05:30", NOW), 8);
  assert.ok(MP4_RE.test("reel-aaaaaaaa.mp4") && MP4_RE.test("x.MP4") && !MP4_RE.test("poster-b.jpg"));
  assert.equal(commitMessage(NOW, 1), "media: retention 2027-01-18 (1 file)");
  assert.equal(commitMessage(NOW, 3), "media: retention 2027-01-18 (3 files)");
  const h = harness();
  try {
    assert.deepEqual(mp4sOf(h.mediaRoot, OLD), ["reel-aaaaaaaa.mp4"]);
    assert.deepEqual(mp4sOf(h.mediaRoot, IMG), []);
    assert.deepEqual(mp4sOf(h.mediaRoot, "nobody"), []);
    // an MP4 on disk the index does not list is still found; one the index lists but disk lacks is not
    writeFileSync(join(h.mediaRoot, "media", OLD, "reel-stray000.mp4"), "x");
    updateIndex(h.mediaRoot, OLD, ["reel-aaaaaaaa.mp4", "reel-gone0000.mp4", "poster-bbbbbbbb.jpg"]);
    assert.deepEqual(mp4sOf(h.mediaRoot, OLD), ["reel-aaaaaaaa.mp4", "reel-stray000.mp4"]);
  } finally {
    h.cleanup();
  }
});

test("retireFiles: deletes the files, keeps the rest, turns the entry into { files, removed[{ file, removedAt }] }; sample entries keep their fields; index stays sorted; bad input throws", () => {
  const h = harness();
  try {
    const r = retireFiles(h.mediaRoot, OLD, ["reel-aaaaaaaa.mp4"], { at: NOW });
    assert.deepEqual(r.removed, ["reel-aaaaaaaa.mp4"]);
    assert.equal(h.has(OLD, "reel-aaaaaaaa.mp4"), false);
    assert.equal(h.has(OLD, "poster-bbbbbbbb.jpg"), true);
    const index = readIndex(h.mediaRoot);
    assert.deepEqual(index[OLD], { files: ["poster-bbbbbbbb.jpg"], removed: [{ file: "reel-aaaaaaaa.mp4", removedAt: NOW }] });
    assert.deepEqual(indexFiles(index[OLD]), ["poster-bbbbbbbb.jpg"]);
    assert.deepEqual(index[YOUNG], ["reel-cccccccc.mp4", "poster-dddddddd.jpg"], "other entries untouched");
    assert.deepEqual(Object.keys(index), Object.keys(index).slice().sort());
    // a second retirement appends to removed[]; a name already gone from disk but still indexed is dropped from files
    updateIndex(h.mediaRoot, YOUNG, ["reel-cccccccc.mp4", "reel-gone0000.mp4", "poster-dddddddd.jpg"]);
    const r2 = retireFiles(h.mediaRoot, YOUNG, ["reel-cccccccc.mp4", "reel-gone0000.mp4"], { at: NOW });
    assert.deepEqual(r2.removed, ["reel-cccccccc.mp4", "reel-gone0000.mp4"]);
    assert.deepEqual(readIndex(h.mediaRoot)[YOUNG], { files: ["poster-dddddddd.jpg"], removed: [{ file: "reel-cccccccc.mp4", removedAt: NOW }, { file: "reel-gone0000.mp4", removedAt: NOW }] });
    const s = retireFiles(h.mediaRoot, "sample-kaatdo-reel", ["reel-ffffffff.mp4"], { at: NOW });
    assert.deepEqual(readIndex(h.mediaRoot)["sample-kaatdo-reel"], { sample: true, files: [], page: "kaatdo", format: "reel", at: "2026-10-11T12:00:00+05:30", removed: [{ file: "reel-ffffffff.mp4", removedAt: NOW }] });
    assert.deepEqual(s.removed, ["reel-ffffffff.mp4"]);
    assert.throws(() => retireFiles(h.mediaRoot, OLD, [], { at: NOW }), TypeError);
    assert.throws(() => retireFiles(h.mediaRoot, OLD, ["../escape.mp4"], { at: NOW }), TypeError);
    assert.throws(() => retireFiles(h.mediaRoot, OLD, ["a.mp4"]), TypeError);
    assert.throws(() => retireFiles(h.mediaRoot, "Bad Id", ["a.mp4"], { at: NOW }), TypeError);
  } finally {
    h.cleanup();
  }
});

test("retentionPlan + runRetention: the 91-day-old reel loses its MP4 (poster kept, index updated); the 8-day-old reel, the image, the dry-run record and the sample are untouched; paths for the commit; --days changes the threshold", async () => {
  const h = harness();
  const out = sink();
  try {
    const plan = retentionPlan({ published: h.rows, mediaRoot: h.mediaRoot, now: NOW });
    assert.deepEqual(plan, [{ draftId: OLD, page: "kaatdo", publishedAt: "2026-10-18T11:31:00+05:30", ageDays: 91, files: ["reel-aaaaaaaa.mp4"] }]);
    const r = await runRetention({ companyDir: h.companyDir, mediaRoot: h.mediaRoot, now: NOW, stdout: out });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.deepEqual(r.removed, [{ draftId: OLD, files: ["reel-aaaaaaaa.mp4"] }]);
    assert.deepEqual(r.paths, [`media/${OLD}/reel-aaaaaaaa.mp4`, "index.json"]);
    assert.equal(r.message, "media: retention 2027-01-18 (1 file)");
    assert.equal(r.config.repo.mediaBranch, "media");
    assert.equal(h.has(OLD, "reel-aaaaaaaa.mp4"), false, "mp4 removed");
    assert.equal(h.has(OLD, "poster-bbbbbbbb.jpg"), true, "poster kept");
    assert.equal(h.has(YOUNG, "reel-cccccccc.mp4"), true, "8 days old: kept");
    assert.equal(h.has(IMG, "image-1-711972b4.jpg"), true);
    assert.equal(h.has("jr-reel-2026-09-01-dry", "reel-eeeeeeee.mp4"), true, "dry-run records are not real posts");
    assert.equal(h.has("sample-kaatdo-reel", "reel-ffffffff.mp4"), true, "samples are not published posts");
    const index = readIndex(h.mediaRoot);
    assert.deepEqual(index[OLD], { files: ["poster-bbbbbbbb.jpg"], removed: [{ file: "reel-aaaaaaaa.mp4", removedAt: NOW }] });
    assert.deepEqual(index[YOUNG], ["reel-cccccccc.mp4", "poster-dddddddd.jpg"]);
    assert.ok(out.lines.some((l) => l === `retention: removed media/${OLD}/reel-aaaaaaaa.mp4 (published 2026-10-18T11:31:00+05:30, 91 days ago); poster kept, index entry records removedAt`), out.text());
    // the company dir is untouched: published.jsonl and the drafts still say what they said
    assert.equal(h.state.readJsonl("state/published.jsonl").length, 4);
    // a second run finds nothing
    const out2 = sink();
    const r2 = await runRetention({ companyDir: h.companyDir, mediaRoot: h.mediaRoot, now: NOW, stdout: out2 });
    assert.equal(r2.changed, false);
    assert.deepEqual(r2.paths, []);
    assert.equal(out2.lines[0], "retention: 2 published reels, none older than 90 days with an MP4 left — nothing to remove", "the dry-run record is not a published reel");
    // --days 5 would also take the young reel
    const r3 = await runRetention({ companyDir: h.companyDir, mediaRoot: h.mediaRoot, now: NOW, days: 5, dryRun: true, stdout: sink() });
    assert.deepEqual(r3.plan.map((p) => p.draftId), [YOUNG]);
    assert.equal(h.has(YOUNG, "reel-cccccccc.mp4"), true, "dry run removes nothing");
    // exactly 90 days is kept (> 90 only)
    const edge = retentionPlan({ published: [record("x-reel-edge", "kaatdo", "reel", "2026-10-20T07:31:00+05:30")], mediaRoot: h.mediaRoot, now: NOW });
    assert.deepEqual(edge, [], "no files for that id anyway, and 90 days is not > 90");
  } finally {
    h.cleanup();
  }
});

test("--dry-run lists what would be removed and touches nothing; no media folder → nothing to do", async () => {
  const h = harness();
  const out = sink();
  try {
    const r = await runRetention({ companyDir: h.companyDir, mediaRoot: h.mediaRoot, now: NOW, dryRun: true, stdout: out });
    assert.equal(r.changed, false);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.plan.map((p) => p.draftId), [OLD]);
    assert.equal(r.message, "media: retention 2027-01-18 (1 file)");
    assert.equal(h.has(OLD, "reel-aaaaaaaa.mp4"), true);
    assert.deepEqual(readIndex(h.mediaRoot)[OLD], ["reel-aaaaaaaa.mp4", "poster-bbbbbbbb.jpg"]);
    assert.ok(out.lines.some((l) => l === `retention: would remove media/${OLD}/reel-aaaaaaaa.mp4 (published 2026-10-18T11:31:00+05:30, 91 days ago) — dry run`), out.text());
    const none = sink();
    const r2 = await runRetention({ companyDir: h.companyDir, mediaRoot: join(h.base, "no-such-media"), now: NOW, stdout: none });
    assert.equal(r2.changed, false);
    assert.match(none.text(), /no media folder under .* — nothing to do/);
  } finally {
    h.cleanup();
  }
});

test("CLI: retention is registered; --now without --dry-run exits 2; bad --days exits 2; --dry-run reports the plan; a run without --commit removes the file and says 'not committed'; --commit without a media checkout says not configured yet", async () => {
  const h = harness();
  try {
    const env = { MEDIA_DIR: h.mediaRoot };
    let err = sink();
    assert.equal(await main(["retention", "--now", NOW], { stdout: sink(), stderr: err, processEnv: env, companyDir: h.companyDir }), EXIT.usage);
    assert.match(err.text(), /--now <iso> is accepted only with --dry-run/);
    err = sink();
    assert.equal(await main(["retention", "--days", "soon"], { stdout: sink(), stderr: err, processEnv: env, companyDir: h.companyDir }), EXIT.usage);
    assert.match(err.text(), /--days must be a whole number/);
    const dry = sink();
    assert.equal(await main(["retention", "--dry-run", "--now", NOW], { stdout: dry, stderr: sink(), processEnv: env, companyDir: h.companyDir }), EXIT.ok);
    assert.equal(dry.lines.at(-1), "retention: dry run complete — 1 draft would lose 1 MP4 file; nothing removed, nothing committed");
    assert.equal(h.has(OLD, "reel-aaaaaaaa.mp4"), true);
    // --commit with a media dir that is not a git checkout: honest skip, exit 0, nothing removed
    const skip = sink();
    assert.equal(await main(["retention", "--commit"], { stdout: skip, stderr: sink(), processEnv: env, companyDir: h.companyDir }), EXIT.ok);
    assert.match(skip.text(), /media branch not configured yet .* — nothing to do/);
    assert.equal(h.has(OLD, "reel-aaaaaaaa.mp4"), true);
    // a plain run uses the real clock: re-date the old reel to 2025 so it is > 90 days old whatever today is
    // (the young reel's 2027 date stays in the future and must survive)
    const rows = h.rows.map((r) => (r.draftId === OLD ? { ...r, publishedAt: "2025-01-18T11:31:00+05:30", slotAt: "2025-01-18T11:00:00+05:30" } : r));
    writeFileSync(join(h.companyDir, "state", "published.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const out = sink();
    assert.equal(await main(["retention"], { stdout: out, stderr: sink(), processEnv: env, companyDir: h.companyDir }), EXIT.ok);
    assert.equal(h.has(OLD, "reel-aaaaaaaa.mp4"), false);
    assert.equal(h.has(OLD, "poster-bbbbbbbb.jpg"), true);
    assert.equal(h.has(YOUNG, "reel-cccccccc.mp4"), true);
    assert.match(out.lines.at(-1), /^retention: 1 file removed under .* and index\.json updated, not committed \(pass --commit\)$/);
    const missing = sink();
    assert.equal(await main(["retention"], { stdout: sink(), stderr: missing, processEnv: env, companyDir: join(h.base, "nope") }), EXIT.failed);
    assert.match(missing.text(), /does not exist/);
  } finally {
    h.cleanup();
  }
});
