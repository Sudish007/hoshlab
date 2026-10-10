// P1-23: size budgets are build failures. A temp copy of public/ whose styles.css is padded past 60 KB
// makes src/build.js exit non-zero with 'size budget exceeded'. The budgets themselves are read from build.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BUDGETS, ADMIN_SHARED_LIBS } from "../src/build.js";
import { ROOT, DIST, COMPANY_DIR, htmlFiles, tmpDir } from "./helpers.js";

test("budgets match design §14", () => {
  assert.equal(BUDGETS.css, 60 * 1024);
  assert.equal(BUDGETS.js, 40 * 1024);
  assert.equal(BUDGETS.page, 150 * 1024);
  assert.equal(BUDGETS.fonts, 600 * 1024);
  assert.equal(BUDGETS.adminJs, 100 * 1024);
  assert.equal(BUDGETS.media, 1024 * 1024 * 1024);
});

test("the fixture dist is inside every budget", () => {
  const size = (p) => statSync(p).size;
  const css = size(join(DIST, "styles.css"));
  const js = size(join(DIST, "main.js"));
  assert.ok(css <= BUDGETS.css, `styles.css ${css}`);
  assert.ok(js <= BUDGETS.js, `main.js ${js}`);
  for (const f of htmlFiles()) assert.ok(size(f) + css + js <= BUDGETS.page, `${f}: ${size(f) + css + js}`);
  const libs = ADMIN_SHARED_LIBS.reduce((s, [, name]) => s + size(join(DIST, "admin", "lib", name)), 0);
  assert.ok(libs <= BUDGETS.adminJs, `admin libs ${libs}`);
});

test("a styles.css padded past 60 KB fails the build with 'size budget exceeded'", () => {
  const dir = tmpDir("hoshlab-budget-");
  const pub = join(dir, "public");
  cpSync(join(ROOT, "public"), pub, { recursive: true });
  const cssPath = join(pub, "styles.css");
  const css = readFileSync(cssPath, "utf8");
  const pad = `/* ${"x".repeat(BUDGETS.css - Buffer.byteLength(css) + 64)} */\n`;
  writeFileSync(cssPath, css + pad);
  const r = spawnSync(process.execPath, [join(ROOT, "src", "build.js")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PUBLIC_DIR: pub, DIST_DIR: join(dir, "dist"), COMPANY_DIR, MEDIA_DIR: join(ROOT, "tests", "fixtures", "media") },
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /size budget exceeded: styles\.css is \d+ B \(limit 61440 B\)/);
});
