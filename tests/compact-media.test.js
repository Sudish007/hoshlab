// scripts/compact-media.mjs (design §8.6 compaction; P2-10; FEAT-202) against a temp BARE repository under
// os.tmpdir(): a `main` with one commit and a `media` orphan branch with three commits → after compaction
// `git rev-list --count media` === 1, the tree is byte-identical, main's sha is unchanged; --dry-run pushes
// nothing; `main` is refused by name. Real git, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "./helpers.js";
import { CompactError, PROTECTED_BRANCHES, compactMedia, defaultBranch, main, parseArgs, pushRefspec, remoteSha } from "../scripts/compact-media.mjs";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// A bare remote with main (1 commit) and media (3 commits) → { base, remote, work, cleanup, count(branch), sha(branch), tree(branch) }
function fixture() {
  const base = tmpDir("hoshlab-compact-media-");
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  mkdirSync(remote);
  git(remote, "init", "--bare", "--quiet", "--initial-branch=main");
  mkdirSync(work);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.name", "test");
  git(work, "config", "user.email", "test@example.com");
  writeFileSync(join(work, "README.md"), "# main\n");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "main: init");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--quiet", "origin", "main");
  git(work, "checkout", "--quiet", "--orphan", "media");
  git(work, "rm", "-rf", "-q", ".");
  writeFileSync(join(work, "README.md"), "# media\n");
  git(work, "add", "README.md");
  git(work, "commit", "--quiet", "-m", "media: init");
  for (const [i, id] of ["rp-a", "kd-b"].entries()) {
    mkdirSync(join(work, "media", id), { recursive: true });
    writeFileSync(join(work, "media", id, `image-1-${String(i).repeat(8)}.jpg`), Buffer.alloc(64, i + 1));
    writeFileSync(join(work, "index.json"), JSON.stringify({ [id]: [`image-1-${String(i).repeat(8)}.jpg`] }, null, 2) + "\n");
    git(work, "add", "--", "media", "index.json");
    git(work, "commit", "--quiet", "-m", `media: ${id} (1 file)`);
  }
  git(work, "push", "--quiet", "origin", "media");
  return {
    base,
    remote,
    work,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    count: (branch) => Number(git(remote, "rev-list", "--count", `refs/heads/${branch}`)),
    sha: (branch) => git(remote, "rev-parse", `refs/heads/${branch}`),
    tree: (branch) => git(remote, "rev-parse", `refs/heads/${branch}^{tree}`),
    files: (branch) => git(remote, "ls-tree", "-r", "--name-only", `refs/heads/${branch}`).split(/\r?\n/).sort(),
  };
}

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

test("pushRefspec: only HEAD:refs/heads/<branch>; main/master (and the configured main branch) are refused by name; defaultBranch reads config.repo.mediaBranch", () => {
  assert.deepEqual(PROTECTED_BRANCHES, ["main", "master"]);
  assert.equal(pushRefspec("media"), "HEAD:refs/heads/media");
  assert.throws(() => pushRefspec("main"), /refusing to rewrite main/);
  assert.throws(() => pushRefspec("master"), /refusing to rewrite master/);
  assert.throws(() => pushRefspec("trunk", { protectedBranches: ["trunk"] }), /refusing to rewrite trunk/);
  assert.throws(() => pushRefspec("media:main"), /bad branch name/);
  assert.throws(() => pushRefspec(""), /bad branch name/);
  assert.throws(() => pushRefspec("refs/heads/*"), /bad branch name/);
  assert.equal(defaultBranch(), "media");
  assert.deepEqual(parseArgs(["--dry-run", "--remote", "x", "--branch=media"]), { dryRun: true, remote: "x", branch: "media", help: false });
  assert.throws(() => parseArgs(["--force"]), /unknown argument --force/);
});

// One fixture for the two git-backed tests below (each git spawn costs ~0.5 s on the owner's Windows machine).
let shared = null;
const sharedFixture = () => (shared = shared || fixture());
after(() => {
  if (shared) shared.cleanup();
});

test("compaction on a temp bare repo: --dry-run clones, builds the single commit and pushes nothing (3 commits stay); the real run leaves `git rev-list --count media` === 1 with the identical tree, and main's sha unchanged", async () => {
  const fx = sharedFixture();
  {
    assert.equal(fx.count("media"), 3);
    assert.equal(fx.count("main"), 1);
    const mainBefore = fx.sha("main");
    const mediaBefore = fx.sha("media");
    const treeBefore = fx.tree("media");
    const filesBefore = fx.files("media");
    assert.deepEqual(filesBefore, ["README.md", "index.json", "media/kd-b/image-1-11111111.jpg", "media/rp-a/image-1-00000000.jpg"]);
    assert.equal(remoteSha(fx.remote, "media"), mediaBefore);
    assert.equal(remoteSha(fx.remote, "nope"), null);

    const dry = sink();
    const d = await compactMedia({ remote: fx.remote, branch: "media", dryRun: true, log: dry, now: new Date("2027-01-04T07:31:00+05:30") });
    assert.equal(d.pushed, false);
    assert.equal(d.dryRun, true);
    assert.deepEqual(d.before, { commits: 3, sha: mediaBefore, tree: treeBefore });
    assert.equal(d.after.tree, treeBefore, "the compacted commit has the tip's tree");
    assert.equal(d.message, "media: compacted 2027-01-04 (3 commits -> 1, 4 files)");
    assert.equal(fx.count("media"), 3, "dry run pushes nothing");
    assert.equal(fx.sha("media"), mediaBefore);
    assert.equal(fx.sha("main"), mainBefore);
    assert.ok(dry.lines.some((l) => l.startsWith(`compact-media: dry run — would run: git push --force-with-lease=refs/heads/media:${mediaBefore.slice(0, 7)} ${fx.remote} HEAD:refs/heads/media; main untouched`)), dry.text());

    const out = sink();
    const r = await compactMedia({ remote: fx.remote, branch: "media", log: out, now: new Date("2027-01-04T07:31:00+05:30") });
    assert.equal(r.pushed, true);
    assert.equal(fx.count("media"), 1, "one commit after compaction");
    assert.equal(fx.tree("media"), treeBefore, "same tree");
    assert.deepEqual(fx.files("media"), filesBefore, "same files");
    assert.equal(fx.sha("main"), mainBefore, "main untouched");
    assert.equal(fx.count("main"), 1);
    assert.equal(r.after.sha, fx.sha("media"));
    assert.deepEqual(r.main, { before: mainBefore, after: mainBefore });
    assert.equal(git(fx.remote, "log", "-1", "--format=%s", "refs/heads/media"), "media: compacted 2027-01-04 (3 commits -> 1, 4 files)");
    assert.equal(git(fx.remote, "log", "-1", "--format=%an <%ae>", "refs/heads/media"), "hoshlab-bot <hoshlab-bot@users.noreply.github.com>");
    assert.ok(out.lines.some((l) => l.startsWith("compact-media: pushed HEAD:refs/heads/media to ")), out.text());
    assert.ok(out.lines.some((l) => /^compact-media: main [0-9a-f]{7} unchanged; media now [0-9a-f]{7} \(1 commit\)$/.test(l)), out.text());

    // main is refused before anything is cloned or pushed
    await assert.rejects(() => compactMedia({ remote: fx.remote, branch: "main" }), (err) => err instanceof CompactError && /refusing to rewrite main/.test(err.message));
    assert.equal(fx.sha("main"), mainBefore);
    assert.equal(fx.count("main"), 1);
    // a branch the remote does not have
    await assert.rejects(() => compactMedia({ remote: fx.remote, branch: "nope" }), /has no branch nope/);
    // the lease: if the branch moves between the clone and the push, nothing is overwritten
    const moved = await compactMedia({
      remote: fx.remote,
      branch: "media",
      log: () => {},
      run: (cmd, args, opts) => {
        if (args[0] === "push") {
          // simulate a push that lost the lease
          return { status: 1, stdout: "", stderr: "! [rejected] HEAD -> media (stale info)" };
        }
        const x = spawnSync(cmd, args, { ...opts, encoding: "utf8", shell: false, windowsHide: true });
        return { status: x.status, stdout: x.stdout || "", stderr: x.stderr || "" };
      },
    }).then(
      () => "resolved",
      (err) => err,
    );
    assert.ok(moved instanceof CompactError && /git push .* failed/.test(moved.message), String(moved));
    assert.equal(fx.count("media"), 1);
  }
});

test("main(): --help exits 0; an unknown argument exits 2; --dry-run against the (already compacted) temp remote exits 0, reports the plan and pushes nothing; --branch main exits 1 before touching anything", async () => {
  const fx = sharedFixture();
  const help = sink();
  assert.equal(await main(["--help"], { log: help, error: sink() }), 0);
  assert.match(help.text(), /^usage: node scripts\/compact-media\.mjs/);
  const err = sink();
  assert.equal(await main(["--force"], { log: sink(), error: err }), 2);
  assert.match(err.text(), /unknown argument --force/);
  const mediaBefore = fx.sha("media");
  const commits = fx.count("media");
  const out = sink();
  assert.equal(await main(["--dry-run", "--remote", fx.remote, "--branch", "media"], { log: out, error: sink(), repoRoot: fx.base }), 0);
  assert.ok(out.lines.some((l) => new RegExp(`^compact-media: .* media @ [0-9a-f]{7} — ${commits} commits?, 4 files, tree [0-9a-f]{7}$`).test(l)), out.text());
  assert.equal(fx.sha("media"), mediaBefore, "a dry run through main() pushes nothing");
  const bad = sink();
  assert.equal(await main(["--remote", fx.remote, "--branch", "main"], { log: sink(), error: bad, repoRoot: fx.base }), 1);
  assert.match(bad.text(), /refusing to rewrite main/);
  assert.equal(fx.count("main"), 1);
});
