// engine/lib/git.js with a fake run() (no git process, no network): rebase-retry push, PushConflictError,
// commitPaths staging only the given paths, the media worktree check (M16), $GITHUB_OUTPUT, bot identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FETCH_ATTEMPTS, tmpDir } from "./helpers.js";
import { BOT_EMAIL, BOT_NAME, GitError, PUSH_ATTEMPTS, PUSH_SLEEP_MS, PushConflictError, commitAndPush, commitMedia, commitPaths, configureBot, currentBranch, ensureMediaWorktree, pushWithRetry, run, shouldCommit, writeGithubOutput } from "../engine/lib/git.js";

// A scripted git: `plan` maps the first argument(s) to a result or a function; records every argv.
function fakeGit(plan = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts && opts.cwd });
    const key = args.slice(0, 2).join(" ");
    const handler = plan[key] || plan[args[0]];
    const r = typeof handler === "function" ? handler(args, calls) : handler;
    return r || { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}
const REJECTED = { status: 1, stdout: "", stderr: "To github.com:Sudish007/hoshlab.git\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not have locally" };

test("pushWithRetry: two non-fast-forward rejections then success → 3 pushes, 2 rebases, sleeps [5000, 5000]", async () => {
  let pushes = 0;
  const git = fakeGit({ push: () => (++pushes < 3 ? REJECTED : { status: 0, stdout: "", stderr: "" }) });
  const sleeps = [];
  const r = await pushWithRetry("/repo", "main", { run: git, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(r, { pushed: true, attempts: 3, rebases: 2 });
  assert.deepEqual(sleeps, [5000, 5000]);
  const argv = git.calls.map((c) => c.args.join(" "));
  assert.deepEqual(argv, ["push origin HEAD:refs/heads/main", "pull --rebase origin main", "push origin HEAD:refs/heads/main", "pull --rebase origin main", "push origin HEAD:refs/heads/main"]);
  assert.ok(git.calls.every((c) => c.cmd === "git" && c.cwd === "/repo"));
  assert.equal(PUSH_ATTEMPTS, 3);
  assert.equal(PUSH_SLEEP_MS, 5000);
});

test("pushWithRetry: three rejections → PushConflictError (code push_conflict) after 3 pushes and 2 rebases; a failing rebase surfaces as GitError", async () => {
  const git = fakeGit({ push: REJECTED });
  const sleeps = [];
  await assert.rejects(pushWithRetry("/repo", "media", { run: git, sleep: async (ms) => void sleeps.push(ms) }), (e) => e instanceof PushConflictError && e.code === "push_conflict" && e.branch === "media" && e.attempts === 3 && /rebase-retry exhausted/.test(e.message));
  assert.equal(git.calls.filter((c) => c.args[0] === "push").length, 3);
  assert.equal(git.calls.filter((c) => c.args[0] === "pull").length, 2);
  assert.deepEqual(sleeps, [5000, 5000]);
  const broken = fakeGit({ push: REJECTED, pull: { status: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in company/state/status.json" } });
  await assert.rejects(pushWithRetry("/repo", "main", { run: broken, sleep: async () => {} }), (e) => e instanceof GitError && /pull --rebase origin main failed \(exit 1\): CONFLICT/.test(e.message));
  await assert.rejects(pushWithRetry("/repo", "", { run: fakeGit() }), /branch name is required/);
});

test("commitPaths stages ONLY the given paths (git add -- <paths>), commits with the message, returns false when nothing is staged", () => {
  const git = fakeGit({ "diff --cached": { status: 1, stdout: "", stderr: "" } });
  const ok = commitPaths("/repo", ["company/state/status.json", "company\\state\\runs\\2026-10.jsonl", "company/state/status.json"], "state: engine-daily x", { run: git });
  assert.equal(ok, true);
  const argv = git.calls.map((c) => c.args);
  assert.deepEqual(argv[0], ["add", "--", "company/state/status.json", "company/state/runs/2026-10.jsonl"], "de-duplicated, forward slashes, never -A");
  assert.deepEqual(argv[1], ["diff", "--cached", "--quiet", "--", "company/state/status.json", "company/state/runs/2026-10.jsonl"]);
  assert.deepEqual(argv[2], ["commit", "--quiet", "-m", "state: engine-daily x", "--", "company/state/status.json", "company/state/runs/2026-10.jsonl"]);
  assert.ok(!git.calls.some((c) => c.args.includes("-A") || c.args.includes("--all")));

  const clean = fakeGit({ "diff --cached": { status: 0, stdout: "", stderr: "" } });
  assert.equal(commitPaths("/repo", ["company/state/status.json"], "noop", { run: clean }), false);
  assert.deepEqual(clean.calls.map((c) => c.args[0]), ["add", "diff"], "no commit when the staged tree equals HEAD");
  assert.equal(commitPaths("/repo", [], "nothing", { run: fakeGit() }), false);
  assert.throws(() => commitPaths("/repo", ["x"], "", { run: fakeGit() }), /commit message is required/);
  const failing = fakeGit({ add: { status: 128, stdout: "", stderr: "fatal: pathspec 'nope' did not match any files" } });
  assert.throws(() => commitPaths("/repo", ["nope"], "m", { run: failing }), (e) => e instanceof GitError && e.status === 128 && /pathspec/.test(e.message));
});

test("commitMedia: media/<draftId>/<file>… plus index.json, message 'media: <draftId> (<n> files)'; configureBot sets the hoshlab-bot identity (N16); currentBranch handles detached HEAD", () => {
  const git = fakeGit({ "diff --cached": { status: 1, stdout: "", stderr: "" } });
  assert.equal(commitMedia("/repo/.media", "rp-2026-10-14-kundali-free", ["image-1-fc09aa36.jpg"], { run: git }), true);
  assert.deepEqual(git.calls[0].args, ["add", "--", "media/rp-2026-10-14-kundali-free/image-1-fc09aa36.jpg", "index.json"]);
  assert.equal(git.calls[2].args[3], "media: rp-2026-10-14-kundali-free (1 file)");
  const four = fakeGit({ "diff --cached": { status: 1, stdout: "", stderr: "" } });
  commitMedia("/repo/.media", "jr-2026-10-15-templates", ["slide-1-a.jpg", "slide-2-b.jpg", "slide-3-c.jpg", "slide-4-d.jpg"], { run: four });
  assert.equal(four.calls[2].args[3], "media: jr-2026-10-15-templates (4 files)");
  assert.equal(commitMedia("/repo/.media", "x", [], { run: fakeGit() }), false);

  const bot = fakeGit();
  assert.deepEqual(configureBot("/repo", { run: bot }), { name: BOT_NAME, email: BOT_EMAIL });
  assert.deepEqual(bot.calls.map((c) => c.args), [["config", "user.name", "hoshlab-bot"], ["config", "user.email", "hoshlab-bot@users.noreply.github.com"]]);
  assert.equal(currentBranch("/repo", { run: fakeGit({ "rev-parse --abbrev-ref": { status: 0, stdout: "main\n", stderr: "" } }) }), "main");
  assert.equal(currentBranch("/repo", { run: fakeGit({ "rev-parse --abbrev-ref": { status: 0, stdout: "HEAD\n", stderr: "" } }) }), null, "detached");
  assert.equal(currentBranch("/repo", { run: fakeGit({ "rev-parse --abbrev-ref": { status: 128, stdout: "", stderr: "fatal: not a git repository" } }) }), null);
});

test("ensureMediaWorktree is true only when .media/.git exists (file or dir) and never creates anything (M16)", () => {
  const root = tmpDir("hoshlab-git-");
  try {
    assert.equal(ensureMediaWorktree(root, "media"), false, "no .media at all");
    mkdirSync(join(root, ".media"));
    assert.equal(ensureMediaWorktree(root, "media"), false, ".media without .git");
    assert.equal(existsSync(join(root, ".media", ".git")), false, "nothing created");
    writeFileSync(join(root, ".media", ".git"), "gitdir: ../.git/worktrees/media\n");
    assert.equal(ensureMediaWorktree(root, "media"), true, "worktree marker file");
    rmSync(join(root, ".media", ".git"));
    mkdirSync(join(root, ".media", ".git"));
    assert.equal(ensureMediaWorktree(root, "media"), true, "a second checkout in Actions has a .git directory");
    assert.equal(ensureMediaWorktree(root, "media", { mediaRoot: join(root, "elsewhere") }), false);
    assert.throws(() => ensureMediaWorktree(root, ""), /mediaBranch is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeGithubOutput appends name=value to $GITHUB_OUTPUT and is a no-op without it; shouldCommit only with CI=true or --commit", () => {
  const dir = tmpDir("hoshlab-gh-out-");
  try {
    const file = join(dir, "output.txt");
    assert.equal(writeGithubOutput("changed", true, {}), false);
    assert.equal(writeGithubOutput("changed", true, { GITHUB_OUTPUT: file }), true);
    assert.equal(writeGithubOutput("changed", false, { GITHUB_OUTPUT: file }), true);
    assert.equal(readFileSync(file, "utf8"), "changed=true\nchanged=false\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(shouldCommit({ CI: "true" }, {}), true);
  assert.equal(shouldCommit({}, { commit: true }), true);
  assert.equal(shouldCommit({ CI: "1" }, {}), false, "GitHub sets CI=true literally");
  assert.equal(shouldCommit({}, {}), false);
});

test("commitAndPush: media worktree first (bot identity, one commit per draft, push to the media branch), then the state commit on the current branch; nothing to commit → no push", async () => {
  const root = tmpDir("hoshlab-git-cap-");
  try {
    const mediaRoot = join(root, ".media");
    mkdirSync(mediaRoot);
    writeFileSync(join(mediaRoot, ".git"), "gitdir: x\n");
    const config = { repo: { owner: "Sudish007", name: "hoshlab", branch: "main", mediaBranch: "media" } };
    const git = fakeGit({ "diff --cached": { status: 1, stdout: "", stderr: "" }, "rev-parse --abbrev-ref": { status: 0, stdout: "main\n", stderr: "" } });
    const lines = [];
    const r = await commitAndPush({ repoRoot: root, config, changedFiles: ["company/state/status.json", "company/state/runs/2026-10.jsonl"], message: "state: engine-daily r1", mediaRoot, mediaCommits: [{ draftId: "rp-x", files: ["image-1-aaaaaaaa.jpg"] }, { draftId: "jr-y", files: ["slide-1-b.jpg", "slide-2-c.jpg"] }], stdout: (s) => lines.push(s), run: git, sleep: async () => {} });
    assert.deepEqual(r, { committed: true, pushed: true, branch: "main", mediaCommitted: 2, mediaPushed: true });
    const seq = git.calls.map((c) => `${c.cwd === mediaRoot ? "media" : "repo"}: ${c.args.slice(0, 2).join(" ")}`);
    const firstRepo = seq.findIndex((s) => s.startsWith("repo:"));
    assert.ok(seq.slice(0, firstRepo).every((s) => s.startsWith("media:")), "every media command precedes the first repo command");
    assert.deepEqual(seq.slice(0, 2), ["media: config user.name", "media: config user.email"]);
    assert.ok(seq.includes("media: push origin") && seq.includes("repo: push origin"));
    assert.equal(git.calls.find((c) => c.cwd === mediaRoot && c.args[0] === "push").args.join(" "), "push origin HEAD:refs/heads/media");
    assert.equal(git.calls.find((c) => c.cwd === root && c.args[0] === "push").args.join(" "), "push origin HEAD:refs/heads/main");
    assert.equal(git.calls.filter((c) => c.cwd === mediaRoot && c.args[0] === "commit").length, 2);
    assert.deepEqual(lines, ["git: pushed 2 media commits to media", "git: committed 2 files and pushed to main"]);

    // nothing staged → no push, no media when the worktree is absent
    const clean = fakeGit({ "diff --cached": { status: 0, stdout: "", stderr: "" }, "rev-parse --abbrev-ref": { status: 0, stdout: "HEAD\n", stderr: "" } });
    const r2 = await commitAndPush({ repoRoot: root, config, changedFiles: ["company/state/status.json"], message: "m", mediaRoot: join(root, "nope"), mediaCommits: [{ draftId: "rp-x", files: ["a.jpg"] }], run: clean });
    assert.deepEqual(r2, { committed: false, pushed: false, branch: "main", mediaCommitted: 0, mediaPushed: false });
    assert.ok(!clean.calls.some((c) => c.args[0] === "push"));
    assert.equal(r2.branch, "main", "detached HEAD falls back to config.repo.branch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real git on a temp bare remote: `daily --commit` commits as hoshlab-bot, stages only state files, pushes to the current branch; a remote that moved is rebased onto; a second run with nothing new still pushes its run record", async () => {
  const base = tmpDir("hoshlab-git-real-");
  const sh = (args, cwd) => {
    const r = run("git", args, { cwd });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const remote = join(base, "remote.git");
    const work = join(base, "work");
    const other = join(base, "other");
    sh(["init", "-q", "--bare", "--initial-branch=main", remote]);
    sh(["clone", "-q", remote, work]);
    sh(["-C", work, "config", "user.name", "owner"]);
    sh(["-C", work, "config", "user.email", "owner@example.invalid"]);
    const { cpSync } = await import("node:fs");
    const { COMPANY_DIR } = await import("./helpers.js");
    cpSync(COMPANY_DIR, join(work, "company"), { recursive: true });
    writeFileSync(join(work, "README.md"), "# scratch\n");
    sh(["-C", work, "add", "-A"]);
    sh(["-C", work, "commit", "-q", "-m", "seed"]);
    sh(["-C", work, "push", "-q", "-u", "origin", "main"]);
    // someone else moves the remote so the first push is non-fast-forward
    sh(["clone", "-q", remote, other]);
    sh(["-C", other, "config", "user.name", "someone"]);
    sh(["-C", other, "config", "user.email", "someone@example.invalid"]);
    writeFileSync(join(other, "NOTES.md"), "remote moved\n");
    sh(["-C", other, "add", "NOTES.md"]);
    sh(["-C", other, "commit", "-q", "-m", "remote moved"]);
    sh(["-C", other, "push", "-q", "origin", "main"]);

    const { main } = await import("../engine/index.js");
    const out = [];
    const ghOut = join(base, "gh-output.txt");
    const code = await main(["daily", "--commit", "--agents", "hr"], { stdout: (s) => out.push(s), stderr: (s) => out.push(`ERR ${s}`), processEnv: { MOCK_LLM: "1", MEDIA_DIR: join(base, "no-media"), GITHUB_OUTPUT: ghOut }, companyDir: join(work, "company") });
    assert.equal(code, 0, out.join("\n"));
    assert.ok(out.some((l) => /^git: committed 2 files and pushed to main after 1 rebase$/.test(l)), out.join("\n"));
    assert.equal(readFileSync(ghOut, "utf8"), "changed=true\n");
    const log = sh(["-C", work, "log", "--format=%an <%ae> %s", "-n", "3"]).split("\n");
    assert.match(log[0], /^hoshlab-bot <hoshlab-bot@users\.noreply\.github\.com> state: engine-daily engine-daily-\d{8}-\d{4}-[0-9a-f]{6}$/);
    assert.equal(log[1], "someone <someone@example.invalid> remote moved", "rebased onto the moved remote");
    assert.deepEqual(sh(["-C", work, "show", "--name-only", "--format=", "HEAD"]).split("\n").sort(), ["company/state/runs/2026-10.jsonl", "company/state/status.json"], "only the state files");
    assert.equal(sh(["-C", remote, "rev-parse", "main"]), sh(["-C", work, "rev-parse", "HEAD"]), "pushed");
    assert.equal(sh(["-C", work, "status", "--porcelain"]), "", "clean working tree");
    // second run: the run record and status.json change again → another commit
    const code2 = await main(["daily", "--commit", "--agents", "hr"], { stdout: () => {}, stderr: (s) => out.push(`ERR ${s}`), processEnv: { MOCK_LLM: "1", MEDIA_DIR: join(base, "no-media"), GITHUB_OUTPUT: ghOut }, companyDir: join(work, "company") });
    assert.equal(code2, 0, out.join("\n"));
    assert.equal(sh(["-C", remote, "rev-list", "--count", "main"]), "4", "seed + moved + two engine commits");
    assert.equal(readFileSync(ghOut, "utf8"), "changed=true\nchanged=true\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("run() spawns without a shell and reports a missing binary as status null with a scrubbed message", () => {
  const r = run("hoshlab-definitely-not-a-command-" + process.pid, ["--version"], { cwd: process.cwd() });
  assert.equal(r.status, null);
  assert.match(r.stderr, /ENOENT/);
  const v = run("git", ["--version"], { cwd: process.cwd() });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^git version /);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});
