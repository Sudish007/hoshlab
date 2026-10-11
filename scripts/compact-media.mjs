// compact-media — rewrite the orphan `media` branch as ONE commit holding its current tree (design.md §8.6
// "compaction", P2-10; FEAT-202). Owner-run, quarterly, after the weekly retention job has deleted old MP4s:
// the deleted blobs stay reachable through the branch's history until that history is gone, and only then
// does GitHub's garbage collection reclaim them.
//
//   node scripts/compact-media.mjs --dry-run            clone, build the single commit, report, push NOTHING
//   node scripts/compact-media.mjs                      … and force-push it to refs/heads/media (lease-guarded)
//   options: --remote <url|path> (default: origin of this repository), --branch <name> (default:
//            company/config.json repo.mediaBranch, i.e. media)
//
// Safety, in order: the branch name may never be `main` or the repository's config.repo.branch; the refspec is
// asserted to be exactly `HEAD:refs/heads/<branch>` before `git push`; the push uses
// --force-with-lease=refs/heads/<branch>:<sha seen in the clone>, so a branch that moved meanwhile is left
// alone; main's sha is read before and after and must be identical; the new commit's tree must equal the old
// tip's tree (same files, same bytes). Everything happens in a mkdtemp clone that is removed afterwards; the
// repository you run it from is not touched. A local .media worktree is reported, not reset: run the two
// printed commands yourself. Every git call goes through spawnSync without a shell.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PROTECTED_BRANCHES = ["main", "master"];

export class CompactError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompactError";
  }
}

// run('git', [...], { cwd }) → { status, stdout, stderr } — no shell, output captured.
export function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: "", stderr: `${r.error.name}: ${r.error.message}` };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function git(exec, cwd, args, { allowFail = false } = {}) {
  const r = exec("git", args, { cwd });
  if (r.status !== 0 && !allowFail) throw new CompactError(`git ${args.join(" ")} failed (exit ${r.status})${(r.stderr || r.stdout).trim() ? `: ${(r.stderr || r.stdout).trim()}` : ""}`);
  return r;
}

// `git ls-remote <remote> refs/heads/<branch>` → sha or null when the branch does not exist.
export function remoteSha(remote, branch, exec = run) {
  const r = exec("git", ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`], {});
  if (r.status === 2) return null;
  if (r.status !== 0) throw new CompactError(`git ls-remote ${remote} refs/heads/${branch} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  const sha = r.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// The refspec the push uses; asserted here and nowhere else so a typo cannot reach `git push`.
export function pushRefspec(branch, { protectedBranches = PROTECTED_BRANCHES } = {}) {
  if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)) throw new CompactError(`compact-media: bad branch name ${JSON.stringify(branch)}`);
  if (protectedBranches.includes(branch)) throw new CompactError(`compact-media: refusing to rewrite ${branch} — only the media branch is ever force-pushed`);
  const refspec = `HEAD:refs/heads/${branch}`;
  // belt and braces: the only ref a push may name is refs/heads/<branch>, never a protected one, never a wildcard
  if (!/^HEAD:refs\/heads\/[^*:\s]+$/.test(refspec) || protectedBranches.some((p) => refspec === `HEAD:refs/heads/${p}`)) throw new CompactError("compact-media: refspec assertion failed");
  return refspec;
}

export function defaultRemote(repoRoot = ROOT, exec = run) {
  const r = exec("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
  if (r.status !== 0 || !r.stdout.trim()) throw new CompactError("compact-media: no `origin` remote here; pass --remote <url>");
  return r.stdout.trim();
}

export function defaultBranch(repoRoot = ROOT) {
  const p = join(repoRoot, "company", "config.json");
  if (!existsSync(p)) return "media";
  const cfg = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  return (cfg.repo && cfg.repo.mediaBranch) || "media";
}

// compactMedia({ remote, branch, dryRun, mainBranch, log, run }) →
//   { branch, remote, before: { commits, sha, tree }, after: { commits, sha, tree }, main: { before, after }, pushed, dryRun, message }
export async function compactMedia({ remote, branch = "media", dryRun = false, mainBranch = "main", protectedBranches = [...new Set([...PROTECTED_BRANCHES, mainBranch])], log = (s) => process.stdout.write(s + "\n"), run: exec = run, now = new Date() } = {}) {
  if (!remote) throw new CompactError("compact-media: a remote is required");
  const refspec = pushRefspec(branch, { protectedBranches });
  const mainBefore = remoteSha(remote, mainBranch, exec);
  const tipBefore = remoteSha(remote, branch, exec);
  if (!tipBefore) throw new CompactError(`compact-media: ${remote} has no branch ${branch} — nothing to compact (run scripts/init-media-branch.ps1 first)`);
  const tmp = mkdtempSync(join(tmpdir(), "hoshlab-compact-media-"));
  const clone = join(tmp, "media");
  try {
    git(exec, tmp, ["clone", "--quiet", "--branch", branch, "--single-branch", remote, clone]);
    const commits = Number(git(exec, clone, ["rev-list", "--count", "HEAD"]).stdout.trim());
    const tree = git(exec, clone, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    const headSha = git(exec, clone, ["rev-parse", "HEAD"]).stdout.trim();
    if (headSha !== tipBefore) throw new CompactError(`compact-media: the clone's tip ${headSha.slice(0, 7)} differs from the remote's ${tipBefore.slice(0, 7)} — the branch moved; try again`);
    const files = git(exec, clone, ["ls-files"]).stdout.split(/\r?\n/).filter(Boolean).length;
    git(exec, clone, ["config", "user.name", "hoshlab-bot"]);
    git(exec, clone, ["config", "user.email", "hoshlab-bot@users.noreply.github.com"]);
    // The index already holds the tip's tree; an orphan branch gives it a parentless commit.
    git(exec, clone, ["checkout", "--quiet", "--orphan", `${branch}-compact`]);
    const date = now.toISOString().slice(0, 10);
    const message = `media: compacted ${date} (${commits} commit${commits === 1 ? "" : "s"} -> 1, ${files} file${files === 1 ? "" : "s"})`;
    git(exec, clone, ["commit", "--quiet", "--allow-empty", "-m", message]);
    const newTree = git(exec, clone, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    if (newTree !== tree) throw new CompactError(`compact-media: the compacted tree ${newTree.slice(0, 7)} differs from the tip's ${tree.slice(0, 7)} — aborting, nothing pushed`);
    const newSha = git(exec, clone, ["rev-parse", "HEAD"]).stdout.trim();
    log(`compact-media: ${remote} ${branch} @ ${tipBefore.slice(0, 7)} — ${commits} commit${commits === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}, tree ${tree.slice(0, 7)}`);
    log(`compact-media: single commit ${newSha.slice(0, 7)} '${message}' (same tree ${newTree.slice(0, 7)})`);
    let pushed = false;
    if (commits === 1 && !dryRun) log(`compact-media: ${branch} already has one commit — pushing anyway rewrites it to an identical tree`);
    if (dryRun) {
      log(`compact-media: dry run — would run: git push --force-with-lease=refs/heads/${branch}:${tipBefore.slice(0, 7)} ${remote} ${refspec}; ${mainBranch} untouched (${mainBefore ? mainBefore.slice(0, 7) : "absent"})`);
    } else {
      if (refspec !== `HEAD:refs/heads/${branch}` || protectedBranches.includes(branch)) throw new CompactError("compact-media: refspec assertion failed before push");
      git(exec, clone, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${tipBefore}`, remote, refspec]);
      pushed = true;
      log(`compact-media: pushed ${refspec} to ${remote} (lease on ${tipBefore.slice(0, 7)})`);
    }
    const mainAfter = remoteSha(remote, mainBranch, exec);
    if (mainAfter !== mainBefore) throw new CompactError(`compact-media: ${mainBranch} changed during the run (${mainBefore} -> ${mainAfter}) — investigate before doing anything else`);
    const tipAfter = pushed ? remoteSha(remote, branch, exec) : tipBefore;
    const after = { commits: pushed ? 1 : commits, sha: tipAfter, tree: newTree };
    log(`compact-media: ${mainBranch} ${mainBefore ? mainBefore.slice(0, 7) : "absent"} unchanged; ${branch} now ${pushed ? `${tipAfter.slice(0, 7)} (1 commit)` : `still ${tipBefore.slice(0, 7)} (${commits} commit${commits === 1 ? "" : "s"}; dry run)`}`);
    return { branch, remote, before: { commits, sha: tipBefore, tree }, after, main: { before: mainBefore, after: mainAfter }, pushed, dryRun, message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const out = { dryRun: false, remote: null, branch: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--remote" && argv[i + 1]) out.remote = argv[++i];
    else if (a === "--branch" && argv[i + 1]) out.branch = argv[++i];
    else if (a.startsWith("--remote=")) out.remote = a.slice("--remote=".length);
    else if (a.startsWith("--branch=")) out.branch = a.slice("--branch=".length);
    else throw new CompactError(`compact-media: unknown argument ${a}`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { log = (s) => process.stdout.write(s + "\n"), error = (s) => process.stderr.write(s + "\n"), repoRoot = ROOT } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    error(err.message);
    return 2;
  }
  if (args.help) {
    log("usage: node scripts/compact-media.mjs [--dry-run] [--remote <url|path>] [--branch <name>]");
    return 0;
  }
  try {
    const branch = args.branch || defaultBranch(repoRoot);
    const remote = args.remote || defaultRemote(repoRoot);
    const result = await compactMedia({ remote, branch, dryRun: args.dryRun, log });
    const worktree = join(repoRoot, ".media");
    if (result.pushed && existsSync(join(worktree, ".git"))) {
      log(`compact-media: your .media worktree still has the old history; bring it up to date with:`);
      log(`  git -C ${resolve(worktree)} fetch origin ${branch}`);
      log(`  git -C ${resolve(worktree)} reset --hard origin/${branch}`);
    }
    return 0;
  } catch (err) {
    error(err instanceof CompactError ? err.message : `compact-media: ${err && err.message ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main().then((code) => process.exit(code));
