// Git helpers for the engine's commit + push step (design.md §3.1 step 9, §9.3 rebase-retry, §11 row
// "Git push"; review M16, N16). Every command runs through child_process.spawnSync without a shell;
// output is scrubbed before it lands in an error message. The engine never creates branches: the
// orphan `media` branch is made once by scripts/init-media-branch.ps1 and checked out as .media/
// (a worktree locally, a second checkout in Actions) — ensureMediaWorktree only reports whether it
// is there (M16).
//
// Every function takes an optional `run` so tests can replace the process spawn with a fake.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { mediaBranchPresent } from "./media.js";
import { scrub } from "./log.js";

export const BOT_NAME = "hoshlab-bot";
export const BOT_EMAIL = "hoshlab-bot@users.noreply.github.com";
export const PUSH_ATTEMPTS = 3;
export const PUSH_SLEEP_MS = 5000;

export class GitError extends Error {
  constructor(args, result) {
    const detail = scrub(String((result && (result.stderr || result.stdout)) || "").trim());
    super(`git ${args.join(" ")} failed (exit ${result ? result.status : "?"})${detail ? `: ${detail}` : ""}`);
    this.name = "GitError";
    this.args = args;
    this.status = result ? result.status : null;
    this.stderr = detail;
  }
}

export class PushConflictError extends Error {
  constructor(branch, attempts, last) {
    super(`push to ${branch} failed ${attempts} time${attempts === 1 ? "" : "s"} (rebase-retry exhausted)${last ? `: ${scrub(String(last)).trim()}` : ""}`);
    this.name = "PushConflictError";
    this.branch = branch;
    this.attempts = attempts;
    this.code = "push_conflict";
  }
}

// run('git', ['status', '--short'], { cwd }) → { status, stdout, stderr } (no shell, stdio captured).
export function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: "", stderr: scrub(`${r.error.name}: ${r.error.message}`) };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function git(exec, cwd, args, { allowFail = false } = {}) {
  const r = exec("git", args, { cwd });
  if (r.status !== 0 && !allowFail) throw new GitError(args, r);
  return r;
}

// Sets the bot identity on the repository at cwd (N16): commits made by Actions read "hoshlab-bot".
export function configureBot(cwd, { run: exec = run, name = BOT_NAME, email = BOT_EMAIL } = {}) {
  git(exec, cwd, ["config", "user.name", name]);
  git(exec, cwd, ["config", "user.email", email]);
  return { name, email };
}

// The repository that contains `dir` (git rev-parse --show-toplevel), or null outside a repository.
export function repoRootFor(dir, { run: exec = run } = {}) {
  const r = exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
  const top = r.status === 0 ? r.stdout.trim() : "";
  return top ? resolve(top) : null;
}

// Current branch name, or null when HEAD is detached.
export function currentBranch(cwd, { run: exec = run } = {}) {
  const r = git(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
  const name = r.stdout.trim();
  return r.status === 0 && name && name !== "HEAD" ? name : null;
}

// Stages ONLY the given paths (relative to cwd) and commits them. Returns false (nothing committed) when
// the staged tree equals HEAD; true after a commit. Never `git add -A`.
export function commitPaths(cwd, paths, message, { run: exec = run } = {}) {
  const list = [...new Set((paths || []).map((p) => String(p).replace(/\\/g, "/")).filter(Boolean))];
  if (!list.length) return false;
  if (typeof message !== "string" || !message.trim()) throw new TypeError("git: a commit message is required");
  // --ignore-removal:false is the default; deleted files among `paths` are staged as deletions too.
  git(exec, cwd, ["add", "--", ...list]);
  const staged = git(exec, cwd, ["diff", "--cached", "--quiet", "--", ...list], { allowFail: true });
  if (staged.status === 0) return false; // nothing staged for these paths
  if (staged.status !== 1) throw new GitError(["diff", "--cached", "--quiet"], staged);
  git(exec, cwd, ["commit", "--quiet", "-m", message, "--", ...list]);
  return true;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// pushWithRetry(cwd, branch, { attempts, sleepMs, sleep, run, remote })
//   push HEAD to origin/<branch>; when the remote moved (non-fast-forward) wait sleepMs, `git pull
//   --rebase origin <branch>`, push again — up to `attempts` pushes; then PushConflictError (§11:
//   recorded as errors ['push_conflict']; the state stays in the runner, the next run regenerates it).
//   Returns { pushed: true, attempts, rebases }.
export async function pushWithRetry(cwd, branch, { attempts = PUSH_ATTEMPTS, sleepMs = PUSH_SLEEP_MS, sleep = defaultSleep, run: exec = run, remote = "origin" } = {}) {
  if (!branch) throw new TypeError("git: a branch name is required to push");
  let last = "";
  let rebases = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = git(exec, cwd, ["push", remote, `HEAD:refs/heads/${branch}`], { allowFail: true });
    if (r.status === 0) return { pushed: true, attempts: attempt, rebases };
    last = r.stderr || r.stdout || "";
    if (attempt === attempts) break;
    await sleep(sleepMs);
    // the remote moved: replay our commit on top of it, then try again
    git(exec, cwd, ["pull", "--rebase", remote, branch]);
    rebases++;
  }
  throw new PushConflictError(branch, attempts, last);
}

// ensureMediaWorktree(repoRoot, mediaBranch) → true only when <repoRoot>/.media/.git exists. It never
// creates the branch or the worktree (M16): a missing worktree makes the Designer record
// `skipped: media_branch_missing` and the run continues.
export function ensureMediaWorktree(repoRoot, mediaBranch = "media", { mediaRoot = join(repoRoot, ".media") } = {}) {
  if (!mediaBranch) throw new TypeError("git: mediaBranch is required");
  return existsSync(mediaRoot) && mediaBranchPresent(mediaRoot);
}

// commitMedia(mediaRoot, draftId, files) — stages media/<draftId>/<file>… plus index.json in the media
// worktree, message 'media: <draftId> (<n> files)' (design §8.6). Returns false when nothing changed.
export function commitMedia(mediaRoot, draftId, files, { run: exec = run } = {}) {
  if (!Array.isArray(files) || !files.length) return false;
  const paths = files.map((f) => `media/${draftId}/${f}`);
  paths.push("index.json");
  return commitPaths(mediaRoot, paths, `media: ${draftId} (${files.length} file${files.length === 1 ? "" : "s"})`, { run: exec });
}

export function pushMedia(mediaRoot, mediaBranch = "media", opts = {}) {
  return pushWithRetry(mediaRoot, mediaBranch, opts);
}

// Appends `name=value` to $GITHUB_OUTPUT when set (the deploy job reads steps.engine.outputs.changed).
export function writeGithubOutput(name, value, processEnv = process.env) {
  const file = processEnv.GITHUB_OUTPUT;
  if (!file) return false;
  appendFileSync(file, `${name}=${String(value)}\n`, "utf8");
  return true;
}

// shouldCommit(processEnv, flags) — commit + push only inside Actions (CI=true) or with --commit.
export function shouldCommit(processEnv = process.env, flags = {}) {
  return processEnv.CI === "true" || flags.commit === true;
}

// commitAndPush({ repoRoot, config, changedFiles, message, mediaRoot, mediaCommits, stdout, run, sleep })
//   The shared tail of `daily` and `publish` (design §3.1 step 9, §3.2 step 5): media worktree first
//   (so the raw URLs the drafts name exist before the state lands), then the state commit on the current
//   branch (config.repo.branch when HEAD is detached). Throws PushConflictError after the retries.
//   changedFiles are repository-relative ('company/state/…'); mediaCommits = [{ draftId, files }].
//   → { committed, pushed, branch, mediaCommitted, mediaPushed }
export async function commitAndPush({ repoRoot, config, changedFiles = [], message, mediaRoot, mediaCommits = [], stdout = () => {}, run: exec = run, sleep } = {}) {
  const result = { committed: false, pushed: false, branch: null, mediaCommitted: 0, mediaPushed: false };
  const opts = { run: exec, sleep };
  if (mediaCommits.length && mediaRoot && mediaBranchPresent(mediaRoot)) {
    configureBot(mediaRoot, { run: exec });
    for (const m of mediaCommits) if (commitMedia(mediaRoot, m.draftId, m.files, { run: exec })) result.mediaCommitted++;
    if (result.mediaCommitted > 0) {
      await pushMedia(mediaRoot, config.repo.mediaBranch, opts);
      result.mediaPushed = true;
      stdout(`git: pushed ${result.mediaCommitted} media commit${result.mediaCommitted === 1 ? "" : "s"} to ${config.repo.mediaBranch}`);
    }
  }
  if (changedFiles.length) {
    configureBot(repoRoot, { run: exec });
    result.branch = currentBranch(repoRoot, { run: exec }) || config.repo.branch;
    result.committed = commitPaths(repoRoot, changedFiles, message, { run: exec });
    if (result.committed) {
      const p = await pushWithRetry(repoRoot, result.branch, opts);
      result.pushed = true;
      stdout(`git: committed ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} and pushed to ${result.branch}${p.rebases ? ` after ${p.rebases} rebase${p.rebases === 1 ? "" : "s"}` : ""}`);
    } else stdout("git: nothing to commit (state unchanged)");
  }
  return result;
}
