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
import { runDesigner, designNote, mediaRows, SKIP_MEDIA_BRANCH_MISSING, FLAG_RENDER_FAILED } from "../engine/agents/designer.js";

const company = loadCompany({ companyDir: join(ROOT, "company"), warn: () => {} });
const { brands, config } = company;
const fixture = (id) => JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "drafts", `${id}.json`), "utf8"));
const written = (id) => ({ ...fixture(id), status: "written", media: [] });
const NOW = "2026-10-12T05:40:00+05:30";
const SHA = "7cfbae6d41f17cb1b34897046134304f36529e6e223ea96756052d2a70958af1";

// A renderer double: `plan` maps draft id → media entries | Error to throw.
function fakeRenderer(plan) {
  const calls = [];
  return {
    calls,
    async renderDraft(draft, brand, { outDir, relDir }) {
      calls.push({ id: draft.id, handle: brand.frontMatter.handle, outDir, relDir });
      const p = plan[draft.id];
      if (p instanceof Error) throw p;
      const n = draft.format === "carousel" ? draft.slides.length : 1;
      const media = Array.from({ length: n }, (_, i) => {
        const file = `${draft.format === "carousel" ? "slide" : "image"}-${i + 1}-${SHA.slice(0, 8)}.jpg`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, file), Buffer.from([0xff, 0xd8]));
        return { kind: "image", file, path: `${relDir}${file}`, bytes: 9432, width: 1080, height: 1350, sha256: SHA, variant: "A", palette: i === 0 ? "cover palette" : "body palette", minTextU: 30, minContrast: 4.6 };
      });
      return { media, variant: "A", palette: media[0].palette };
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

test("RenderError: the draft stays written with renderError { code, detail, at } and empty media; the run continues with the next draft", async () => {
  const rp = written("rp-2026-10-14-kundali-free");
  const kd = written("kd-2026-10-13-six-rules");
  const h = harness([rp, kd]);
  try {
    writeFileSync(join(h.mediaRoot, ".git"), "gitdir: x\n");
    const r = fakeRenderer({ [rp.id]: new RenderError("overflow", "div#canvas 1420 > 1350 px tall: “मुफ़्त जन्म कुंडली…”", { overflows: [] }) });
    const res = await runDesigner({ drafts: [rp, kd], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r, now: NOW });
    assert.equal(res.ok, true);
    assert.equal(res.rendered, 1);
    assert.equal(res.refused, 1);
    assert.deepEqual(res.flags, [FLAG_RENDER_FAILED], "design §11: a refused draft raises render_failed while the step stays ok");
    assert.equal(res.note, "1 rendered, 1 refused");
    assert.deepEqual(res.results.map((x) => [x.id, x.status, x.code || null]), [
      [rp.id, "written", "overflow"],
      [kd.id, "rendered", null],
    ]);
    const rpOut = h.state.readDraft(rp.id);
    assert.equal(rpOut.status, "written");
    assert.deepEqual(rpOut.media, []);
    assert.deepEqual(rpOut.renderError, { code: "overflow", detail: "div#canvas 1420 > 1350 px tall: “मुफ़्त जन्म कुंडली…”", at: NOW });
    assert.equal(rpOut.designNote, undefined);
    assert.deepEqual(validate(rpOut, DRAFT_SPEC), { ok: true, errors: [] });
    assert.equal(h.state.readDraft(kd.id).status, "rendered");
    assert.equal(readIndex(h.mediaRoot)[rp.id], undefined, "nothing indexed for a refused draft");
    // a later successful render clears renderError
    const r2 = fakeRenderer({});
    await runDesigner({ drafts: [h.state.readDraft(rp.id)], brands, config, state: h.state, mediaRoot: h.mediaRoot, renderer: r2, now: NOW });
    const again = h.state.readDraft(rp.id);
    assert.equal(again.status, "rendered");
    assert.equal(again.renderError, undefined);
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
