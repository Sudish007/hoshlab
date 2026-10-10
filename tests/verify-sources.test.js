import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, tmpDir } from "./helpers.js";
import { verifyBrandFile, verifyCompany, parseArgs } from "../scripts/verify-sources.mjs";
import { parseBrand } from "../engine/lib/brand.js";

const SCRIPT = join(ROOT, "scripts", "verify-sources.mjs");
const WORKSPACE = join(ROOT, "..");
const SIBLINGS = ["shubhpatra", "kaatdo", "vitae-os"];

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
}

// A tiny fake workspace: <tmp>/repo/a.md has 3 lines; brand pointers may point past EOF.
function fakeCompany({ pointer, tokensPointer = "repo/a.md:1" }) {
  const root = tmpDir("hoshlab-verify-");
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(join(root, "repo", "a.md"), "line one\nline two\nline three\n", "utf8");
  const company = join(root, "company");
  mkdirSync(join(company, "brands"), { recursive: true });
  const base = readFileSync(join(ROOT, "company", "brands", "jobrez.md"), "utf8");
  // keep the real file's structure; rewrite every pointer to the fake repo, then plant the probe pointer on jr-f01
  let text = base.replace(/vitae-os\/[\w./-]+:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*/g, tokensPointer).replace("sourceRepo: vitae-os", "sourceRepo: repo");
  text = text.replace(/^\| jr-f01 \|([^|]*)\|[^|]*\|/m, `| jr-f01 |$1| ${pointer} |`);
  writeFileSync(join(company, "brands", "probe.md"), text, "utf8");
  return { root, company };
}

test("M4: a pointer past EOF makes the script exit 1 and name the line", () => {
  const { root, company } = fakeCompany({ pointer: "repo/a.md:2,10" });
  const r = run(["--company", company, "--root", root, "--quiet"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /0 missing files, 1 out-of-range lines/);
  assert.match(r.stdout, /jr-f01: repo\/a\.md:10 out of range \(file has 3 lines\)/);
});

test("a missing file is counted and exits 1; a valid fake company exits 0 and prints the referenced lines", () => {
  const missing = fakeCompany({ pointer: "repo/missing.md:1" });
  const r1 = run(["--company", missing.company, "--root", missing.root, "--quiet"]);
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /1 missing files, 0 out-of-range lines/);

  const ok = fakeCompany({ pointer: "repo/a.md:1-3" });
  const r2 = run(["--company", ok.company, "--root", ok.root]);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /0 missing files, 0 out-of-range lines/);
  assert.match(r2.stdout, /jr-f01\s+repo\/a\.md:2\s+line two/);
});

test("--write stamps sourceVerifiedAt (UTF-8, no BOM) only when there are no problems", () => {
  const bad = fakeCompany({ pointer: "repo/a.md:99" });
  const badProbe = join(bad.company, "brands", "probe.md");
  const before = readFileSync(badProbe, "utf8");
  const rb = run(["--company", bad.company, "--root", bad.root, "--quiet", "--write"]);
  assert.equal(rb.status, 1);
  assert.match(rb.stdout, /--write skipped/);
  assert.equal(readFileSync(badProbe, "utf8"), before, "unchanged when there are problems");

  const good = fakeCompany({ pointer: "repo/a.md:3" });
  const probe = join(good.company, "brands", "probe.md");
  writeFileSync(probe, readFileSync(probe, "utf8").replace(/^sourceVerifiedAt: .*$/m, "sourceVerifiedAt: null"), "utf8");
  const r = run(["--company", good.company, "--root", good.root, "--quiet", "--write"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /stamped sourceVerifiedAt: \d{4}-\d{2}-\d{2} into probe\.md/);
  const bytes = readFileSync(probe);
  assert.notEqual(bytes[0], 0xef, "no BOM");
  assert.match(parseBrand(bytes.toString("utf8")).frontMatter.sourceVerifiedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("verifyBrandFile counts pointers per range and parseArgs reads the flags", () => {
  const { root } = fakeCompany({ pointer: "repo/a.md:1" });
  const text = "---\nhandle: x\nsourceRepo: repo\n---\n## Facts\n| id | fact | source | status |\n|---|---|---|---|\n| x-f01 | a | repo/a.md:1-2 ; repo/a.md:3 | confirmed |\n## Pricing\n| sku | price | source |\n|---|---|---|\n| s | 1 | repo/b.md:1 |\n";
  const r = verifyBrandFile(text, { root, file: "x.md" });
  assert.equal(r.pointers, 3);
  assert.equal(r.missingFiles, 1);
  assert.equal(r.outOfRange, 0);
  assert.equal(r.lines.length, 3);
  const opts = parseArgs(["--company", "c", "--root", "r", "--write", "--quiet"]);
  assert.deepEqual(opts, { company: "c", root: "r", write: true, quiet: true });
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});

test("the real brands verify with 0 missing files and 0 out-of-range lines when the sibling folders exist", (t) => {
  const present = SIBLINGS.filter((s) => existsSync(join(WORKSPACE, s)));
  if (present.length !== SIBLINGS.length) {
    t.diagnostic(`skipped: sibling source folders not present under ${WORKSPACE} (missing ${SIBLINGS.filter((s) => !present.includes(s)).join(", ")}); the owner runs node scripts/verify-sources.mjs locally`);
    return;
  }
  const lines = [];
  const { ok, totals } = verifyCompany({ company: join(ROOT, "company"), root: WORKSPACE, log: (l) => lines.push(l), quiet: true });
  assert.equal(ok, true, lines.join("\n"));
  assert.equal(totals.missingFiles, 0);
  assert.equal(totals.outOfRange, 0);
  assert.ok(totals.pointers >= 100, `${totals.pointers} pointers`);
  assert.match(lines[lines.length - 1], /^\d+ pointers, 0 missing files, 0 out-of-range lines$/);
});
