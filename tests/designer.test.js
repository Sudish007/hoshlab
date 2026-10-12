// Designer agent (design.md §5/§10/§11; review M16) with a fake renderer — no browser needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { DRAFT_SPEC, validate } from "../engine/lib/schema.js";
import { mediaPaths, pagesUrl, rawUrl, readIndex, updateIndex } from "../engine/lib/media.js";
import { RenderError, RenderUnavailableError } from "../engine/render/render.js";
import { CaptureError } from "../engine/render/capture.js";
import { runDesigner, designNote, isDeferral, mediaRows, preferFor, preferenceNote, renderReason, RENDER_REASON_PREFIX, SKIP_MEDIA_BRANCH_MISSING, FLAG_RENDER_FAILED, PREFERENCE_FORMATS } from "../engine/agents/designer.js";
import { designPreferences } from "../engine/lib/feedback.js";

const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { brands, config } = company;
const fixture = (id) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "drafts", `${id}.json`), "utf8"));
const written = (id) => ({ ...fixture(id), status: "written", media: [] });
const NOW = "2026-10-12T05:40:00+05:30";
const SHA = "7cfbae6d41f17cb1b34897046134304f36529e6e223ea96756052d2a70958af1";

// A renderer double: `plan` maps draft id → media entries | Error to throw. Like the real renderer it sets the
// preferred tier when `prefer.variant` is given (FEAT-205) and reports `applied`; `preferPlan[id]` is an Error thrown
// only for the preferred render (the fallback without `prefer` then succeeds) or a palette kind the fake "offers".
function fakeRenderer(plan, preferPlan = {}) {
  const calls = [];
  return {
    calls,
    async renderDraft(draft, brand, { outDir, relDir, prefer = null }) {
      calls.push({ id: draft.id, handle: brand.frontMatter.handle, outDir, relDir, prefer });
      const p = plan[draft.id];
      if (p instanceof Error) throw p;
      const pp = preferPlan[draft.id];
      if (prefer && pp instanceof Error) throw pp;
      const n = draft.format === "carousel" ? draft.slides.length : 1;
      const variant = prefer && prefer.variant ? prefer.variant : "A";
      const media = Array.from({ length: n }, (_, i) => {
        const file = `${draft.format === "carousel" ? "slide" : "image"}-${i + 1}-${SHA.slice(0, 8)}.jpg`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, file), Buffer.from([0xff, 0xd8]));
        return { kind: "image", file, path: `${relDir}${file}`, bytes: 9432, width: 1080, height: 1350, sha256: SHA, variant, palette: i === 0 ? "cover palette" : "body palette", paletteKind: typeof pp === "string" ? pp : "dark", minTextU: 30, minContrast: 4.6 };
      });
      const applied = prefer ? { variant: prefer.variant ? media.every((m) => m.variant === prefer.variant) : null, palette: prefer.palette ? media.some((m) => m.paletteKind === prefer.palette) : null } : null;
      return { media, variant: media[0].variant, palette: media[0].palette, prefer, applied };
    },
    async close() {
      calls.push({ closed: true });
    },
  };
}

function harness(drafts) {
  const dir = tmpDir("hoshlab-designer-");
  const companyDir = join(dir, "company");
  mkdirSync(join(companyDir, "state"), { recursive: true });
  const state = createState({ companyDir, now: NOW });
  for (const d of drafts) state.writeDraft(d);
  const mediaRoot = join(dir, ".media");
  mkdirSync(mediaRoot, { recursive: true });
  return { dir, companyDir, state, mediaRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("media.js: mediaPaths, rawUrl and pagesUrl follow design §8; updateIndex keeps draft lists and sample objects sorted", () => {
  assert.deepEqual(mediaPaths("rp-2026-10-14-kundali-free").dir, "media/rp-2026-10-14-kundali-free/");
  assert.equal(mediaPaths("kd-x").rel("image-1-abcd1234.jpg"), "media/kd-x/image-1-abcd1234.jpg");
  assert.throws(() => mediaPaths("../etc"), TypeError);
  assert.equal(rawUrl(config, "media/kd-x/image-1-abcd1234.jpg"), "https://raw.githubusercontent.com/Sudish007/hoshlab/media/media/kd-x/image-1-abcd1234.jpg");
  assert.equal(pagesUrl(config, "media/kd-x/image-1-abcd1234.jpg"), "https://sudish007.github.io/hoshlab/media/kd-x/image-1-abcd1234.jpg");
  const root = tmpDir("hoshlab-media-index-");
  try {
    assert.deepEqual(readIndex(root), {});
    updateIndex(root, "rp-b", ["image-1-aaaaaaaa.jpg"]);
    updateIndex(root, "sample-kaatdo", ["image-1-bbbbbbbb.jpg"], { sample: true, page: "kaatdo", format: "image", at: NOW });
    const index = updateIndex(root, "jr-a", ["slide-1-cccccccc.jpg", "slide-2-dddddddd.jpg"]);
    assert.deepEqual(Object.keys(index), ["jr-a", "rp-b", "sample-kaatdo"]);
    assert.deepEqual(index["rp-b"], ["image-1-aaaaaaaa.jpg"]);
    assert.deepEqual(index["sample-kaatdo"], { sample: true, files: ["image-1-bbbbbbbb.jpg"], page: "kaatdo", format: "image", at: NOW });
    assert.deepEqual(JSON.parse(readFileSync(join(root, "index.json"), "utf8")), index);
    updateIndex(root, "rp-b", ["image-1-eeeeeeee.jpg"]);
    assert.deepEqual(readIndex(root)["rp-b"], ["image-1-eeeeeeee.jpg"], "a re-render replaces the entry");
    assert.throws(() => updateIndex(root, "x", ["ok.jpg", 7]), TypeError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mediaRoot without .git → { skipped: 'media_branch_missing' }, flag set, renderer never called, no draft changed (M16)", async () => {
  const h = harness([written("rp-2026-10-14-kundali-free"), written("kd-2026-10-13-six-rules")]);
  try {
    const before = h.state.listDrafts().map((id) => JSON.stringify(h.state.readDraft(id)));
    const r = fakeRenderer({});
    const res = await runDesigner({ drafts: h.state.listDrafts().map((id) => h.state.readDraft(id)), brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW });
    assert.equal(res.skipped, SKIP_MEDIA_BRANCH_MISSING);
    assert.equal(res.ok, true);
    assert.deepEqual(res.flags, ["media_branch_missing"]);
    assert.equal(res.rendered, 0);
    assert.deepEqual(res.changed, []);
    assert.match(res.note, /not configured yet/);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(h.state.listDrafts().map((id) => JSON.stringify(h.state.readDraft(id))), before, "drafts untouched");
    assert.equal(existsSync(join(h.mediaRoot, "index.json")), false);
  } finally {
    h.cleanup();
  }
});

test("success: status rendered, media[] rows carry rawUrl/pagesUrl from config, designNote records variant + palette, index.json lists the files, only `written` drafts are rendered", async () => {
  const rp = written("rp-2026-10-14-kundali-free");
  const jr = written("jr-2026-10-15-templates");
  const queued = { ...fixture("kd-2026-10-13-six-rules"), status: "queued" };
  const h = harness([rp, jr, queued]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: ../.git/worktrees/media\n");
    const r = fakeRenderer({});
    const res = await runDesigner({ drafts: [rp, jr, queued], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW, runId: "engine-daily-20261012-0540-abcdef" });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, undefined);
    assert.equal(res.rendered, 2);
    assert.equal(res.refused, 0);
    assert.equal(res.note, "2 rendered, 0 refused");
    assert.deepEqual(res.flags, []);
    assert.deepEqual(r.calls.filter((c) => c.id).map((c) => [c.id, c.handle, c.relDir]), [
      ["rp-2026-10-14-kundali-free", "rishtapatra", "media/rp-2026-10-14-kundali-free/"],
      ["jr-2026-10-15-templates", "job_rez", "media/jr-2026-10-15-templates/"],
    ]);
    assert.equal(r.calls[0].outDir, join(h.mediaRoot, "media", "rp-2026-10-14-kundali-free"));
    assert.ok(!r.calls.some((c) => c.closed), "an injected renderer is not closed by the Designer");

    const rpOut = h.state.readDraft(rp.id);
    assert.equal(rpOut.status, "rendered");
    assert.equal(rpOut.updatedAt, NOW);
    assert.equal(rpOut.runId, "engine-daily-20261012-0540-abcdef");
    assert.equal(rpOut.designNote, "variant A · cover palette");
    assert.equal(rpOut.renderError, undefined);
    assert.deepEqual(rpOut.media, [
      {
        kind: "image",
        path: `media/${rp.id}/image-1-7cfbae6d.jpg`,
        bytes: 9432,
        width: 1080,
        height: 1350,
        sha256: SHA,
        rawUrl: `https://raw.githubusercontent.com/${config.repo.owner}/${config.repo.name}/${config.repo.mediaBranch}/media/${rp.id}/image-1-7cfbae6d.jpg`,
        pagesUrl: `${config.site.url}/media/${rp.id}/image-1-7cfbae6d.jpg`,
      },
    ]);
    assert.deepEqual(validate(rpOut, DRAFT_SPEC), { ok: true, errors: [] });
    const jrOut = h.state.readDraft(jr.id);
    assert.equal(jrOut.status, "rendered");
    assert.equal(jrOut.media.length, 4);
    assert.equal(jrOut.designNote, "4 slides · variant A · cover palette");
    assert.deepEqual(jrOut.media.map((m) => m.path.split("/").pop().replace(/-[0-9a-f]{8}\.jpg$/, "")), ["slide-1", "slide-2", "slide-3", "slide-4"]);
    assert.deepEqual(h.state.readDraft(queued.id), queued, "a queued draft is left alone");
    const index = readIndex(h.mediaRoot);
    assert.deepEqual(index[rp.id], ["image-1-7cfbae6d.jpg"]);
    assert.equal(index[jr.id].length, 4);
    assert.deepEqual(res.changed, [`state/drafts/${rp.id}/draft.json`, `state/drafts/${jr.id}/draft.json`]);
    assert.deepEqual(mediaRows({ media: [{ path: "media/x/image-1-abcdef12.jpg", bytes: 1, width: 1080, height: 1350, sha256: SHA }] }, config)[0].rawUrl, rawUrl(config, "media/x/image-1-abcdef12.jpg"));
    assert.equal(designNote({ media: [{ variant: "B", palette: "dark console palette" }] }, { format: "image" }), "variant B · dark console palette");
  } finally {
    h.cleanup();
  }
});

test("RenderError (R1-02): the draft goes to rework like a failed QA check — qaReasons[0] 'render: <code> — <detail>', reworkCount + 1, empty media, renderError kept for the admin card; at maxReworkLoops it is blocked; the run continues with the next draft", async () => {
  const rp = written("rp-2026-10-14-kundali-free");
  const kd = written("kd-2026-10-13-six-rules");
  const h = harness([rp, kd]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const detail = "div#canvas 1420 > 1350 px tall: “मुफ़्त जन्म कुंडली…”";
    const r = fakeRenderer({ [rp.id]: new RenderError("overflow", detail, { overflows: [] }) });
    const res = await runDesigner({ drafts: [rp, kd], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW, runId: "engine-daily-20261012-0540-abcdef" });
    assert.equal(res.ok, true);
    assert.equal(res.rendered, 1);
    assert.equal(res.refused, 1);
    assert.equal(res.toRework, 1);
    assert.equal(res.blocked, 0);
    assert.deepEqual(res.flags, [FLAG_RENDER_FAILED], "design §11: a refused draft raises render_failed while the step stays ok");
    assert.equal(res.note, "1 rendered, 1 refused (1 to rework, 0 blocked)");
    assert.deepEqual(res.results.map((x) => [x.id, x.status, x.code || null]), [
      [rp.id, "rework", "overflow"],
      [kd.id, "rendered", null],
    ]);
    const rpOut = h.state.readDraft(rp.id);
    assert.equal(rpOut.status, "rework", "R1-02: a refusal is routed through the rework path, not left `written`");
    assert.equal(rpOut.reworkCount, (rp.reworkCount || 0) + 1);
    assert.equal(rpOut.revision, rp.revision, "the Designer never bumps the revision — the Writer does");
    assert.deepEqual(rpOut.qaReasons, [`render: overflow — ${detail}`]);
    assert.equal(renderReason(new RenderError("overflow", detail)), `${RENDER_REASON_PREFIX}overflow — ${detail}`);
    assert.deepEqual(rpOut.media, []);
    assert.deepEqual(rpOut.renderError, { code: "overflow", detail, at: NOW });
    assert.equal(rpOut.runId, "engine-daily-20261012-0540-abcdef");
    assert.equal(rpOut.designNote, undefined);
    assert.deepEqual(validate(rpOut, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(h.state.readDraft(kd.id).status, "rendered");
    assert.equal(readIndex(h.mediaRoot)[rp.id], undefined, "nothing indexed for a refused draft");
    assert.ok(!r.calls.some((c) => c.closed), "an injected renderer is not closed by the Designer");

    // the Writer's rework hands a `written` draft back; a successful render then clears renderError and the reason
    const reworked = { ...rpOut, status: "written", revision: rpOut.revision + 1 };
    delete reworked.qaReasons;
    delete reworked.renderError;
    h.state.writeDraft(reworked);
    const r2 = fakeRenderer({});
    await runDesigner({ drafts: [h.state.readDraft(rp.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r2, now: NOW });
    const again = h.state.readDraft(rp.id);
    assert.equal(again.status, "rendered");
    assert.equal(again.renderError, undefined);
    assert.equal(again.qaReasons, undefined);

    // at the cap (reworkCount === maxReworkLoops) a refusal blocks the draft for the owner — same rule as QA
    const max = config.defaults.maxReworkLoops;
    const capped = { ...written("rp-2026-10-14-kundali-free"), reworkCount: max, revision: max + 1 };
    h.state.writeDraft(capped);
    const r3 = fakeRenderer({ [capped.id]: new RenderError("missing_glyphs", "U+2192 not in Inter: “→ अभी”", { missingGlyphs: [0x2192] }) });
    const res3 = await runDesigner({ drafts: [h.state.readDraft(capped.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r3, now: NOW });
    assert.deepEqual([res3.rendered, res3.refused, res3.toRework, res3.blocked], [0, 1, 0, 1]);
    assert.equal(res3.note, "0 rendered, 1 refused (0 to rework, 1 blocked)");
    assert.deepEqual(res3.results.map((x) => [x.id, x.status, x.code]), [[capped.id, "blocked", "missing_glyphs"]]);
    const blocked = h.state.readDraft(capped.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reworkCount, max, "the counter is not bumped past the cap");
    assert.deepEqual(blocked.qaReasons, ["render: missing_glyphs — U+2192 not in Inter: “→ अभी”"]);
    assert.equal(blocked.renderError.code, "missing_glyphs");
    assert.deepEqual(validate(blocked, DRAFT_SPEC), { ok: true, errors: [] });
  } finally {
    h.cleanup();
  }
});

test("RenderUnavailableError: the step stops with ok:false and flag render_failed; the failing and later drafts stay written and untouched, earlier successes are kept", async () => {
  const rp = written("rp-2026-10-14-kundali-free");
  const kd = written("kd-2026-10-13-six-rules");
  const jr = written("jr-2026-10-15-templates");
  const h = harness([rp, kd, jr]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const r = fakeRenderer({ [kd.id]: new RenderUnavailableError("Chromium could not be launched: spawn ENOENT") });
    const res = await runDesigner({ drafts: [rp, kd, jr], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW });
    assert.equal(res.ok, false);
    assert.deepEqual(res.flags, [FLAG_RENDER_FAILED]);
    assert.equal(res.rendered, 1);
    assert.equal(res.refused, 0);
    assert.match(res.note, /^1 rendered, 0 refused, stopped: Chromium could not be launched/);
    assert.ok(res.error instanceof RenderUnavailableError);
    assert.equal(h.state.readDraft(rp.id).status, "rendered");
    assert.deepEqual(h.state.readDraft(kd.id), kd, "the draft that hit the unavailable renderer is untouched");
    assert.deepEqual(h.state.readDraft(jr.id), jr, "later drafts are not attempted");
    assert.equal(r.calls.filter((c) => c.id).length, 2);
  } finally {
    h.cleanup();
  }
});

// FEAT-201: reels — media rows (video with the probe summary + poster), the design note, and the two deferrals that
// leave the draft `written` (capture_unreachable, ffmpeg) while images in the same run still render.
const REEL = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "drafts", "kd-reel-2026-10-18-six-rules.json"), "utf8"));
const PROBE = { ok: true, codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p", frameRate: "30/1", durationSec: 16, bytes: 2457600, faststart: true };
function reelResult(relDir) {
  const v = "a1b2c3d4".repeat(8);
  const p = "e5f6a7b8".repeat(8);
  return {
    media: [
      { kind: "video", file: `reel-${v.slice(0, 8)}.mp4`, path: `${relDir}reel-${v.slice(0, 8)}.mp4`, bytes: 2457600, width: 1080, height: 1920, durationSec: 16, sha256: v, probe: PROBE, variant: "A", palette: "dark console palette" },
      { kind: "poster", file: `poster-${p.slice(0, 8)}.jpg`, path: `${relDir}poster-${p.slice(0, 8)}.jpg`, bytes: 88000, width: 1080, height: 1920, sha256: p, variant: "A", palette: "dark console palette" },
    ],
    style: "kinetic",
    scenes: 4,
    durationSec: 16,
    frames: 480,
    variant: "A",
    palette: "dark console palette",
  };
}

test("reel rendered: media[] = video row (durationSec + ffprobe summary) and poster row, both URLs, designNote 'reel kinetic · 4 scenes · 16 s · 480 frames · palette', DRAFT_SPEC valid, index lists both files", async () => {
  const h = harness([REEL]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const r = {
      calls: [],
      async renderDraft(draft, brand, { outDir, relDir }) {
        this.calls.push(draft.id);
        mkdirSync(outDir, { recursive: true });
        const res = reelResult(relDir);
        for (const m of res.media) writeFileSync(join(outDir, m.file), Buffer.from([0]));
        return res;
      },
      async close() {},
    };
    const res = await runDesigner({ drafts: [REEL], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW, runId: "engine-daily-20261015-0540-abcdef" });
    assert.deepEqual([res.ok, res.rendered, res.refused, res.deferred], [true, 1, 0, 0]);
    assert.equal(res.note, "1 rendered, 0 refused");
    const out = h.state.readDraft(REEL.id);
    assert.equal(out.status, "rendered");
    assert.equal(out.designNote, "reel kinetic · 4 scenes · 16 s · 480 frames · dark console palette");
    assert.deepEqual(validate(out, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(out.media.length, 2);
    assert.deepEqual(out.media.map((m) => m.kind), ["video", "poster"]);
    assert.equal(out.media[0].durationSec, 16);
    assert.deepEqual(out.media[0].probe, PROBE);
    assert.equal(out.media[1].probe, undefined);
    assert.equal(out.media[1].durationSec, undefined);
    assert.equal(out.media[0].rawUrl, rawUrl(config, out.media[0].path));
    assert.equal(out.media[1].pagesUrl, pagesUrl(config, out.media[1].path));
    assert.deepEqual(readIndex(h.mediaRoot)[REEL.id], out.media.map((m) => m.path.split("/").pop()));
    assert.equal(designNote({ media: [{ palette: "cream and maroon" }], style: "capture", scenes: 3, durationSec: 15, frames: 450 }, { format: "reel" }), "reel capture · 3 scenes · 15 s · 450 frames · cream and maroon");
  } finally {
    h.cleanup();
  }
});

test("reel deferrals (FEAT-201): capture_unreachable and a missing ffmpeg leave the draft `written` with renderError and empty media, flag render_failed, the note says 'reel: untested — ffmpeg not installed', and the next image still renders", async () => {
  const rp = written("rp-2026-10-14-kundali-free");
  const captureReel = { ...REEL, id: "kd-reel-capture", reel: { ...REEL.reel, style: "capture" } };
  const h = harness([REEL, captureReel, rp]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const plan = {
      [REEL.id]: new RenderUnavailableError("ffmpeg not installed (spawn ENOENT) — reel: untested", null, "ffmpeg"),
      [captureReel.id]: new CaptureError("https://kaatdo.com/status: HTTP 503", { path: "/status", url: "https://kaatdo.com/status", status: 503, reason: "http_error" }),
    };
    const r = fakeRenderer(plan);
    const res = await runDesigner({ drafts: [REEL, captureReel, rp], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW, runId: "engine-daily-20261015-0540-abcdef" });
    assert.equal(res.ok, true, "a deferral never stops the step");
    assert.deepEqual([res.rendered, res.refused, res.deferred, res.toRework, res.blocked], [1, 0, 2, 0, 0]);
    assert.deepEqual(res.flags, [FLAG_RENDER_FAILED]);
    assert.equal(res.note, "1 rendered, 0 refused, 2 deferred (still written) — reel: untested — ffmpeg not installed");
    assert.deepEqual(res.results.map((x) => [x.id, x.status, x.code || null, x.deferred || false]), [
      [REEL.id, "written", "ffmpeg", true],
      [captureReel.id, "written", "capture_unreachable", true],
      [rp.id, "rendered", null, false],
    ]);
    const kinetic = h.state.readDraft(REEL.id);
    assert.equal(kinetic.status, "written", "stays written — not the Writer's fault");
    assert.equal(kinetic.reworkCount, 0);
    assert.equal(kinetic.qaReasons, undefined, "no QA reason: the copy is fine");
    assert.deepEqual(kinetic.media, []);
    assert.deepEqual(kinetic.renderError, { code: "ffmpeg", detail: "ffmpeg not installed (spawn ENOENT) — reel: untested", at: NOW });
    assert.equal(kinetic.runId, "engine-daily-20261015-0540-abcdef");
    assert.deepEqual(validate(kinetic, DRAFT_SPEC), { ok: true, errors: [] });
    const capture = h.state.readDraft(captureReel.id);
    assert.equal(capture.status, "written");
    assert.deepEqual(capture.renderError, { code: "capture_unreachable", detail: "https://kaatdo.com/status: HTTP 503", at: NOW });
    assert.deepEqual(validate(capture, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(h.state.readDraft(rp.id).status, "rendered", "the image after the deferred reels still rendered");
    assert.equal(readIndex(h.mediaRoot)[REEL.id], undefined);
    assert.ok(isDeferral(plan[REEL.id]) && isDeferral(plan[captureReel.id]));
    assert.ok(!isDeferral(new RenderUnavailableError("Chromium could not be launched")), "a dead browser is still a step failure");
    assert.ok(!isDeferral(new RenderError("overflow", "x")));
    // a later run with ffmpeg present renders it and clears renderError
    const r2 = {
      async renderDraft(draft, brand, { outDir, relDir }) {
        mkdirSync(outDir, { recursive: true });
        const out = reelResult(relDir);
        for (const m of out.media) writeFileSync(join(outDir, m.file), Buffer.from([0]));
        return out;
      },
      async close() {},
    };
    await runDesigner({ drafts: [h.state.readDraft(REEL.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r2, now: NOW });
    const again = h.state.readDraft(REEL.id);
    assert.equal(again.status, "rendered");
    assert.equal(again.renderError, undefined);
    assert.equal(again.media.length, 2);
  } finally {
    h.cleanup();
  }
});

test("runDesigner validates its inputs and never writes admin-owned files", async () => {
  await assert.rejects(runDesigner({ drafts: [] }), TypeError);
  const h = harness([]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const res = await runDesigner({ drafts: [], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: fakeRenderer({}), now: NOW });
    assert.deepEqual([res.ok, res.rendered, res.refused, res.note], [true, 0, 0, "0 rendered, 0 refused"]);
    assert.equal(existsSync(join(h.companyDir, "config.json")), false);
  } finally {
    h.cleanup();
  }
});

// FEAT-205 (plan D23): owner feedback tagged design / variant / palette steers the variant and palette deterministically —
// no model call — through the renderer's `prefer`, and every outcome lands in designNote.
const FEEDBACK = [
  { at: "2026-10-10T19:40:00+05:30", by: "owner", kind: "note", page: "kaatdo", text: "Prefer variant B for @kaatdo: more air above the fact rows.", tags: ["design", "variant"] },
  { at: "2026-10-11T09:00:00+05:30", by: "owner", kind: "note", page: "job_rez", text: "Variant A and the dark palette for JobRez.", tags: ["design"] },
  { at: "2026-10-11T21:05:00+05:30", by: "owner", kind: "note", page: "rishtapatra", text: "Keep RishtaPatra Hindi-first.", tags: ["language"] },
];

test("D23: a tagged 'variant B' note for @kaatdo reaches the renderer as prefer { variant: 'B' }, the tier is applied and designNote records it; untagged pages render as before; the preferences are read from state/feedback.jsonl when not injected", async () => {
  const kd = written("kd-2026-10-13-six-rules");
  const rp = written("rp-2026-10-14-kundali-free");
  const h = harness([kd, rp]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const r = fakeRenderer({});
    const res = await runDesigner({ drafts: [kd, rp], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW, runId: "engine-daily-20261012-0540-abcdef", feedback: FEEDBACK });
    assert.deepEqual([res.ok, res.rendered, res.refused, res.preferred, res.fellBack], [true, 2, 0, 1, 0]);
    assert.equal(res.note, "2 rendered, 0 refused, 1 with owner design preference");
    assert.deepEqual(r.calls.filter((c) => c.id).map((c) => [c.id, c.prefer]), [
      [kd.id, { variant: "B", palette: null }],
      [rp.id, null],
    ]);
    const kdOut = h.state.readDraft(kd.id);
    assert.equal(kdOut.status, "rendered");
    assert.equal(kdOut.designNote, "variant B · cover palette · variant B preferred by owner feedback 2026-10-10");
    assert.deepEqual(validate(kdOut, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(h.state.readDraft(rp.id).designNote, "variant A · cover palette", "no tagged feedback for @rishtapatra → the measured tier, the Phase 1 note");
    assert.deepEqual(res.results.map((x) => [x.id, x.prefer, x.fallback]), [
      [kd.id, { variant: "B", palette: null }, null],
      [rp.id, null, null],
    ]);
    assert.equal(existsSync(join(h.companyDir, "state", "feedback.jsonl")), false, "the Designer never writes the admin-owned feedback file");

    // not injected → read from the state's feedback.jsonl (seeded with plain fs, as the admin would write it)
    writeFileSync(join(h.companyDir, "state", "feedback.jsonl"), FEEDBACK.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
    h.state.writeDraft({ ...kd, status: "written" });
    const r2 = fakeRenderer({});
    await runDesigner({ drafts: [h.state.readDraft(kd.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r2, now: NOW });
    assert.deepEqual(r2.calls[0].prefer, { variant: "B", palette: null });
    assert.equal(h.state.readDraft(kd.id).designNote, "variant B · cover palette · variant B preferred by owner feedback 2026-10-10");
  } finally {
    h.cleanup();
  }
});

test("D23: when the preferred tier overflows, the Designer renders once more without the preference (the measured tier) and designNote says so; a palette the template does not offer is recorded as such; reels take no preference", async () => {
  const jr = written("jr-2026-10-15-templates"); // carousel, 4 slides; feedback asks for variant A + dark palette
  const h = harness([jr, REEL]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const overflow = new RenderError("overflow", "h2.headline 1180 > 936 px wide: “Nine templates, three of them free”", { overflows: [] });
    const r = fakeRenderer({}, { [jr.id]: overflow });
    const reelRenderer = {
      async renderDraft(draft, brand, opts) {
        r.calls.push({ id: draft.id, prefer: opts.prefer === undefined ? "absent" : opts.prefer });
        mkdirSync(opts.outDir, { recursive: true });
        const out = reelResult(opts.relDir);
        for (const m of out.media) writeFileSync(join(opts.outDir, m.file), Buffer.from([0]));
        return out;
      },
    };
    const both = { calls: r.calls, renderDraft: (d, b, o) => (d.format === "reel" ? reelRenderer.renderDraft(d, b, o) : r.renderDraft(d, b, o)), close: r.close };
    const res = await runDesigner({ drafts: [jr, REEL], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: both, now: NOW, feedback: FEEDBACK });
    assert.deepEqual([res.ok, res.rendered, res.refused, res.preferred, res.fellBack], [true, 2, 0, 1, 1]);
    assert.equal(res.note, "2 rendered, 0 refused, 1 with owner design preference (1 fell back to the measured tier)");
    // two renders for the carousel: the preferred one (overflow) then the plain one; the reel gets no preference at all
    assert.deepEqual(r.calls.filter((c) => c.id).map((c) => [c.id, c.prefer]), [
      [jr.id, { variant: "A", palette: "dark" }],
      [jr.id, null],
      [REEL.id, "absent"],
    ]);
    const out = h.state.readDraft(jr.id);
    assert.equal(out.status, "rendered");
    assert.equal(out.media.length, 4);
    assert.equal(out.designNote, "4 slides · variant A · cover palette · variant A preferred by owner feedback 2026-10-11 and dark palette preferred by owner feedback 2026-10-11 — did not fit (overflow), measured tier and brand palette kept");
    assert.equal(out.renderError, undefined, "a fallback that renders is not a refusal");
    assert.equal(out.reworkCount, jr.reworkCount || 0);
    assert.deepEqual(validate(out, DRAFT_SPEC), { ok: true, errors: [] });
    assert.deepEqual(res.results.find((x) => x.id === jr.id).fallback, "overflow");
    assert.equal(h.state.readDraft(REEL.id).designNote, "reel kinetic · 4 scenes · 16 s · 480 frames · dark console palette", "reel note unchanged");
    assert.deepEqual(validate(h.state.readDraft(REEL.id), DRAFT_SPEC), { ok: true, errors: [] });

    // the same preference on a template that offers the dark palette (the fake reports paletteKind 'dark'): applied
    h.state.writeDraft({ ...jr, status: "written" });
    const r3 = fakeRenderer({}, { [jr.id]: "dark" });
    await runDesigner({ drafts: [h.state.readDraft(jr.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r3, now: NOW, feedback: FEEDBACK });
    assert.equal(h.state.readDraft(jr.id).designNote, "4 slides · variant A · cover palette · variant A preferred by owner feedback 2026-10-11 · dark palette preferred by owner feedback 2026-10-11");
    // …and on one that does not (paletteKind 'light' everywhere): recorded as not offered, brand palette kept
    h.state.writeDraft({ ...jr, status: "written" });
    const r4 = fakeRenderer({}, { [jr.id]: "light" });
    await runDesigner({ drafts: [h.state.readDraft(jr.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r4, now: NOW, feedback: FEEDBACK });
    assert.equal(h.state.readDraft(jr.id).designNote, "4 slides · variant A · cover palette · variant A preferred by owner feedback 2026-10-11 · dark palette preferred by owner feedback 2026-10-11 — not offered by this template, brand palette kept");

    // a preference whose fallback ALSO fails is a refusal like any other (the copy itself does not fit)
    h.state.writeDraft({ ...jr, status: "written" });
    const r5 = fakeRenderer({ [jr.id]: overflow }, {});
    const res5 = await runDesigner({ drafts: [h.state.readDraft(jr.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r5, now: NOW, feedback: FEEDBACK });
    assert.deepEqual([res5.rendered, res5.refused, res5.toRework, res5.preferred], [0, 1, 1, 0]);
    assert.equal(h.state.readDraft(jr.id).status, "rework");
    assert.deepEqual(r5.calls.filter((c) => c.id).map((c) => c.prefer), [{ variant: "A", palette: "dark" }, null], "the preferred render and the plain fallback both failed → the fallback's error is the refusal");
    assert.deepEqual(h.state.readDraft(jr.id).qaReasons, [`render: overflow — ${overflow.detail}`]);
  } finally {
    h.cleanup();
  }
});

test("preferFor / preferenceNote / designNote: image and carousel only, nothing without a tagged preference, the three note shapes", () => {
  const prefs = designPreferences({ feedback: FEEDBACK, page: "job_rez" });
  assert.deepEqual([prefs.preferVariant, prefs.preferPalette], ["A", "dark"]);
  assert.deepEqual(PREFERENCE_FORMATS, ["image", "carousel"]);
  assert.deepEqual(preferFor({ format: "image" }, prefs), { variant: "A", palette: "dark" });
  assert.deepEqual(preferFor({ format: "carousel" }, prefs), { variant: "A", palette: "dark" });
  assert.equal(preferFor({ format: "reel" }, prefs), null);
  assert.equal(preferFor({ format: "image" }, designPreferences({ feedback: FEEDBACK, page: "rishtapatra" })), null);
  assert.equal(preferFor({ format: "image" }, null), null);
  const kd = designPreferences({ feedback: FEEDBACK, page: "kaatdo" });
  const applied = { media: [{ variant: "B", palette: "dark console palette", paletteKind: "dark" }], variant: "B", applied: { variant: true, palette: null } };
  assert.equal(preferenceNote(kd, applied), "variant B preferred by owner feedback 2026-10-10");
  assert.equal(designNote(applied, { format: "image" }, { prefs: kd }), "variant B · dark console palette · variant B preferred by owner feedback 2026-10-10");
  assert.equal(designNote(applied, { format: "image" }), "variant B · dark console palette", "no prefs → the Phase 1 note");
  assert.equal(designNote(applied, { format: "image" }, { prefs: designPreferences({ feedback: FEEDBACK, page: "rishtapatra" }) }), "variant B · dark console palette");
  // a renderer that reports no `applied` is judged by the media variants it returned
  assert.equal(preferenceNote(kd, { media: [{ variant: "B" }], variant: "B" }), "variant B preferred by owner feedback 2026-10-10");
  assert.equal(preferenceNote(kd, { media: [{ variant: "A" }], variant: "A" }), "variant B preferred by owner feedback 2026-10-10 — not applied by this template, measured tier kept");
  assert.equal(preferenceNote(kd, { media: [{ variant: "A" }] }, new RenderError("overflow", "x")), "variant B preferred by owner feedback 2026-10-10 — did not fit (overflow), measured tier kept");
  assert.equal(preferenceNote(prefs, { media: [{ variant: "C" }] }, new RenderError("overflow", "x")), "variant A preferred by owner feedback 2026-10-11 and dark palette preferred by owner feedback 2026-10-11 — did not fit (overflow), measured tier and brand palette kept");
  assert.equal(preferenceNote(null, applied), "");
});
