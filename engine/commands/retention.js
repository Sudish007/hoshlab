// retention — media retention on the orphan `media` branch (design.md §8.6; P2-10; FEAT-202), run weekly by
// .github/workflows/token-refresh.yml after refresh-tokens:
//   node engine/index.js retention [--dry-run] [--commit] [--days 90] [--now <iso>, dry-run only]
//
//   For every published reel (state/published.jsonl, format reel, not a dry run) whose publishedAt is more
//   than RETENTION_DAYS (90) days ago, the MP4(s) under <mediaRoot>/media/<draftId>/ are deleted; the poster
//   JPEG stays (the Published page and the admin show it), the draft record stays, and the index.json entry
//   becomes { files: [poster…], removed: [{ file, removedAt }] } (engine/lib/media.js retireFiles). The
//   Instagram copy is unaffected. --commit stages exactly the deleted paths + index.json in the media
//   worktree as 'media: retention <YYYY-MM-DD> (<n> files)' and pushes the media branch (rebase-retry); the
//   blobs leave the repository for good only after scripts/compact-media.mjs rewrites the branch (quarterly,
//   owner-run). Nothing under company/ changes. --dry-run lists what would be removed and touches nothing.
//   `changed` (→ $GITHUB_OUTPUT) is true after a commit, so the deploy job refreshes dist/media/.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CompanyError, loadCompany } from "../../src/lib/company.js";
import { commitPaths, configureBot, PushConflictError, pushMedia, shouldCommit, writeGithubOutput } from "../lib/git.js";
import { scrub } from "../lib/log.js";
import { indexFiles, mediaBranchPresent, readIndex, retireFiles } from "../lib/media.js";
import { SchemaError } from "../lib/schema.js";
import { hoursBetween, istDate, nowIst, parseIso } from "../lib/time.js";

export const RETENTION_DAYS = 90;
export const MP4_RE = /\.mp4$/i;

function toDate(v) {
  const d = v instanceof Date ? v : typeof v === "string" ? parseIso(v) : v === undefined || v === null ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError(`retention: invalid date ${String(v)}`);
  return d;
}

// Whole days from publishedAt to now.
export function ageDays(publishedAt, now) {
  return Math.floor(hoursBetween(publishedAt, now) / 24);
}

// The MP4 files of one draft folder: those the index lists plus any on disk the index does not know about.
export function mp4sOf(mediaRoot, draftId, index = readIndex(mediaRoot)) {
  const dir = join(mediaRoot, "media", draftId);
  const onDisk = existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => MP4_RE.test(f) && statSync(join(dir, f)).isFile()) : [];
  const listed = indexFiles(index[draftId]).filter((f) => MP4_RE.test(f));
  return [...new Set([...onDisk, ...listed.filter((f) => existsSync(join(dir, f)))])].sort();
}

// retentionPlan({ published, mediaRoot, now, days }) → [{ draftId, page, publishedAt, ageDays, files }]
//   published reels older than `days` that still have an MP4 in the media folder (dry-run records and the
//   fixture samples are never considered — samples are not published posts).
export function retentionPlan({ published, mediaRoot, now, days = RETENTION_DAYS } = {}) {
  const index = readIndex(mediaRoot);
  const plan = [];
  const seen = new Set();
  for (const r of published || []) {
    if (!r || r.format !== "reel" || r.dryRun === true || !r.draftId || seen.has(r.draftId)) continue;
    seen.add(r.draftId);
    const age = ageDays(r.publishedAt, now);
    if (age <= days) continue;
    const files = mp4sOf(mediaRoot, r.draftId, index);
    if (!files.length) continue;
    plan.push({ draftId: r.draftId, page: r.page, publishedAt: r.publishedAt, ageDays: age, files });
  }
  return plan.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.draftId.localeCompare(b.draftId));
}

export function commitMessage(now, fileCount) {
  return `media: retention ${istDate(now)} (${fileCount} file${fileCount === 1 ? "" : "s"})`;
}

// runRetention({ companyDir, mediaRoot, now, dryRun, days, stdout })
//   → { ok, changed, removed: [{ draftId, files }], paths (media-root-relative, for the commit), message, plan }
export async function runRetention({ companyDir, mediaRoot, now, dryRun = false, days = RETENTION_DAYS, stdout = (s) => process.stdout.write(s + "\n") } = {}) {
  if (!companyDir || !mediaRoot) throw new TypeError("retention: companyDir and mediaRoot are required");
  const at = toDate(now);
  const company = loadCompany({ companyDir, now: () => at, warn: () => {} });
  const { config } = company;
  const published = company.state.readJsonl("state/published.jsonl");
  if (!existsSync(join(mediaRoot, "media"))) {
    stdout(`retention: no media folder under ${mediaRoot} — nothing to do`);
    return { ok: true, changed: false, removed: [], paths: [], message: null, plan: [], config };
  }
  const plan = retentionPlan({ published, mediaRoot, now: at, days });
  if (!plan.length) {
    const reels = published.filter((r) => r && r.format === "reel" && r.dryRun !== true).length;
    stdout(`retention: ${reels} published reel${reels === 1 ? "" : "s"}, none older than ${days} days with an MP4 left — nothing to remove`);
    return { ok: true, changed: false, removed: [], paths: [], message: null, plan, config };
  }
  const removed = [];
  const paths = [];
  const stamp = nowIst(at);
  for (const p of plan) {
    if (dryRun) {
      stdout(`retention: would remove ${p.files.map((f) => `media/${p.draftId}/${f}`).join(", ")} (published ${p.publishedAt}, ${p.ageDays} days ago) — dry run`);
      continue;
    }
    const r = retireFiles(mediaRoot, p.draftId, p.files, { at: stamp });
    removed.push({ draftId: p.draftId, files: r.removed });
    for (const f of r.removed) paths.push(`media/${p.draftId}/${f}`);
    stdout(`retention: removed ${r.removed.map((f) => `media/${p.draftId}/${f}`).join(", ")} (published ${p.publishedAt}, ${p.ageDays} days ago); poster kept, index entry records removedAt`);
  }
  if (dryRun) return { ok: true, changed: false, removed: [], paths: [], message: commitMessage(at, plan.reduce((n, p) => n + p.files.length, 0)), plan, config };
  if (paths.length) paths.push("index.json");
  return { ok: true, changed: paths.length > 0, removed, paths, message: commitMessage(at, paths.length ? paths.length - 1 : 0), plan, config };
}

// CLI entry: ctx from engine/index.js → exit code (0 ok, 1 failed, 2 usage).
export async function run({ root, companyDir, processEnv = process.env, stdout = console.log, stderr = console.error, flags = {} } = {}) {
  const dryRun = flags["dry-run"] === true;
  let now;
  if (flags.now !== undefined) {
    if (!dryRun) {
      stderr("retention: --now <iso> is accepted only with --dry-run");
      return 2;
    }
    try {
      now = parseIso(String(flags.now));
    } catch (err) {
      stderr(`retention: ${err.message}`);
      return 2;
    }
  }
  let days = RETENTION_DAYS;
  if (flags.days !== undefined) {
    if (!/^\d{1,4}$/.test(String(flags.days)) || Number(flags.days) < 1) {
      stderr("retention: --days must be a whole number of days (>= 1)");
      return 2;
    }
    days = Number(flags.days);
  }
  if (!existsSync(companyDir)) {
    stderr(`retention: company dir ${companyDir} does not exist`);
    return 1;
  }
  const repoRoot = root || resolve(companyDir, "..");
  const mediaRoot = processEnv.MEDIA_DIR ? resolve(repoRoot, processEnv.MEDIA_DIR) : join(repoRoot, ".media");
  const commit = shouldCommit(processEnv, flags) && !dryRun;
  if (commit && !mediaBranchPresent(mediaRoot)) {
    stdout(`retention: media branch not configured yet (${mediaRoot} is not a checkout of the media branch) — nothing to do`);
    writeGithubOutput("changed", false, processEnv);
    return 0;
  }
  let result;
  try {
    result = await runRetention({ companyDir, mediaRoot, now, dryRun, days, stdout });
  } catch (err) {
    if (err instanceof CompanyError || err instanceof SchemaError || err instanceof SyntaxError) {
      stderr(scrub(`retention: ${err.message}`));
      return 1;
    }
    stderr(scrub(`retention: ${err && err.message ? err.message : String(err)}`));
    return 1;
  }
  if (dryRun) {
    stdout(`retention: dry run complete — ${result.plan.length} draft${result.plan.length === 1 ? "" : "s"} would lose ${result.plan.reduce((n, p) => n + p.files.length, 0)} MP4 file${result.plan.reduce((n, p) => n + p.files.length, 0) === 1 ? "" : "s"}; nothing removed, nothing committed`);
    return 0;
  }
  if (!result.changed) {
    writeGithubOutput("changed", false, processEnv);
    return 0;
  }
  if (!commit) {
    stdout(`retention: ${result.paths.length - 1} file${result.paths.length - 1 === 1 ? "" : "s"} removed under ${mediaRoot} and index.json updated, not committed (pass --commit)`);
    writeGithubOutput("changed", false, processEnv);
    return 0;
  }
  try {
    configureBot(mediaRoot);
    const committed = commitPaths(mediaRoot, result.paths, result.message);
    if (committed) {
      const mediaBranch = result.config.repo.mediaBranch;
      await pushMedia(mediaRoot, mediaBranch);
      stdout(`retention: committed '${result.message}' and pushed ${mediaBranch}`);
    } else stdout("retention: nothing to commit (media unchanged)");
    writeGithubOutput("changed", committed, processEnv);
  } catch (err) {
    if (err instanceof PushConflictError) {
      stderr(scrub(`retention: ${err.message} — errors: push_conflict (the deletions stay in this checkout; the next weekly run redoes them)`));
      writeGithubOutput("changed", false, processEnv);
      return 1;
    }
    stderr(scrub(`retention: git step failed — ${err.message}`));
    return 1;
  }
  return 0;
}
