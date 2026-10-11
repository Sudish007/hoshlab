// render-sample (plan D19 — live proof without owner keys):
//   node engine/index.js render-sample --page <handle> [--out <dir>] [--format image|carousel|reel] [--style kinetic|capture]
// Renders the matching fixture draft from tests/fixtures/drafts/ (or, for a format the page has no draft
// fixture for, the page's tests/fixtures/llm/writer.ok*.json output) into <out or .media>/media/sample-<handle>/
// (reels: sample-<handle>-reel/) and records the files in <out>/index.json under that key with sample:true, so
// the verify step can push the media branch and prove the raw/Pages URLs. Writes NOTHING under company/.
// Prints every file's path, bytes and dimensions. Exit 0 rendered · 1 refused/unavailable/deferred · 2 usage.
// --format reel (FEAT-201) takes the page's tests/fixtures/drafts/<prefix>-reel-*.json; --style overrides the
// draft's reel.style (capture records the LIVE product site, so it needs the network; kinetic is offline).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadCompany } from "../../src/lib/company.js";
import { updateIndex } from "../lib/media.js";
import { REEL_STYLES } from "../lib/schema.js";
import { nowIst } from "../lib/time.js";
import { CaptureError } from "../render/capture.js";
import { RenderError, RenderUnavailableError, createRenderer } from "../render/render.js";

export const FORMATS = ["image", "carousel", "reel"];
export const STYLES = REEL_STYLES;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

// The draft to render for a page: a drafts/ fixture of the page (matching --format when given), else the
// page's writer.ok fixture output poured into that draft's shell for the requested format.
export function sampleDraft({ root, page, format }) {
  const draftsDir = join(root, "tests", "fixtures", "drafts");
  const drafts = existsSync(draftsDir)
    ? readdirSync(draftsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJson(join(draftsDir, f)))
        .filter((d) => d.page === page)
    : [];
  if (drafts.length === 0) return null;
  const exact = format ? drafts.find((d) => d.format === format) : drafts[0];
  if (exact) return exact;
  const llmDir = join(root, "tests", "fixtures", "llm");
  const candidates = [join(llmDir, `writer.ok.${page}.json`), join(llmDir, "writer.ok.json")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const fixture = readJson(file);
    if (fixture.page !== page || !fixture.output) continue;
    const out = fixture.output;
    const base = { ...drafts[0], format, caption: out.caption, hashtags: out.hashtags, altText: out.altText };
    delete base.artwork;
    delete base.slides;
    delete base.altTexts;
    delete base.reel;
    if (format === "carousel" && Array.isArray(out.slides)) return { ...base, slides: out.slides, altTexts: out.slides.map((s) => s.altText) };
    if (format === "image" && out.artwork) return { ...base, artwork: out.artwork };
    if (format === "reel" && out.reel) return { ...base, reel: out.reel };
  }
  return null;
}

// True when `child` is `parent` or below it.
function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function run({ root, companyDir, flags = {}, stdout = console.log, stderr = console.error, renderer } = {}) {
  const page = typeof flags.page === "string" ? flags.page : null;
  const format = flags.format === undefined ? null : String(flags.format);
  if (!page) {
    stderr("render-sample: --page <handle> is required (rishtapatra | kaatdo | job_rez)");
    return 2;
  }
  if (format !== null && !FORMATS.includes(format)) {
    stderr(`render-sample: --format must be one of ${FORMATS.join("|")}, got ${format}`);
    return 2;
  }
  const style = flags.style === undefined ? null : String(flags.style);
  if (style !== null && !STYLES.includes(style)) {
    stderr(`render-sample: --style must be one of ${STYLES.join("|")}, got ${style}`);
    return 2;
  }
  if (style !== null && format !== "reel") {
    stderr("render-sample: --style applies to --format reel only");
    return 2;
  }
  let company;
  try {
    company = loadCompany({ companyDir, warn: (m) => stderr(`warn: ${m}`) });
  } catch (err) {
    stderr(`render-sample: cannot load company at ${companyDir}: ${err.message}`);
    return 1;
  }
  const brand = company.brands[page];
  if (!brand) {
    stderr(`render-sample: unknown page ${page} (pages: ${Object.keys(company.brands).join(", ")})`);
    return 2;
  }
  const out = resolve(root, typeof flags.out === "string" ? flags.out : ".media");
  if (inside(companyDir, out)) {
    stderr(`render-sample: --out ${out} is inside the company folder; render-sample never writes under company/`);
    return 2;
  }
  let draft = sampleDraft({ root, page, format });
  if (!draft) {
    stderr(`render-sample: no fixture draft for ${page}${format ? ` in format ${format}` : ""} under tests/fixtures/ — not built yet`);
    return 2;
  }
  if (draft.format === "reel" && style) draft = { ...draft, reel: { ...draft.reel, style } };
  const key = draft.format === "reel" ? `sample-${page}-reel` : `sample-${page}`;
  const relDir = `media/${key}/`;
  const outDir = join(out, "media", key);
  const r = renderer || createRenderer();
  try {
    const result = await r.renderDraft(draft, brand, { outDir, relDir });
    const at = nowIst();
    updateIndex(out, key, result.media.map((m) => m.file), { sample: true, page, format: draft.format, at });
    for (const m of result.media) {
      const extra = m.kind === "video" ? `  ${m.durationSec} s  ${m.probe ? `${m.probe.codec} ${m.probe.pixFmt} ${m.probe.frameRate}${m.probe.faststart ? " faststart" : ""}` : ""}` : `  variant ${m.variant}${m.palette ? ` · ${m.palette}` : ""}  minTextU ${m.minTextU}  minContrast ${m.minContrast}`;
      stdout(`${join(outDir, m.file)}  ${m.bytes} bytes  ${m.width}x${m.height}  sha256 ${m.sha256.slice(0, 8)}…${extra}`);
    }
    const what = draft.format === "reel" ? `reel ${result.style} (${draft.id}, ${result.scenes} scenes, ${result.durationSec} s, ${result.frames} frames)` : `${draft.format} (${draft.id})`;
    stdout(`render-sample: ${page} ${what} → ${result.media.length} file${result.media.length === 1 ? "" : "s"} under ${outDir}; index ${join(out, "index.json")} [${key}] sample:true`);
    return 0;
  } catch (err) {
    if (err instanceof RenderError) {
      stderr(`render-sample: ${page} ${draft.format} refused — ${err.code}: ${err.detail}`);
      return 1;
    }
    if (err instanceof CaptureError) {
      stderr(`render-sample: ${page} reel capture deferred — ${err.code}: ${err.detail}`);
      return 1;
    }
    if (err instanceof RenderUnavailableError) {
      // code ffmpeg: the message already ends in '— reel: untested' (ffmpeg/ffprobe missing or the probe failed)
      stderr(err.code === "ffmpeg" ? `render-sample: ${page} reel deferred — ${err.message}` : `render-sample: renderer unavailable — ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    if (!renderer) await r.close();
  }
}
