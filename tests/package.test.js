import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ROOT, read, fetchIsGuarded } from "./helpers.js";

const pkg = JSON.parse(read(join(ROOT, "package.json")));

// P1-01 scripts + build:fonts (review N8)
const SCRIPTS = {
  build: "node src/build.js",
  "build:fonts": "node scripts/build-fonts.mjs",
  test: "node scripts/test.mjs",
  serve: "node scripts/serve.mjs",
  audit: "node scripts/audit.mjs",
  "audit:admin": "node scripts/audit-admin.mjs",
  engine: "node engine/index.js",
  publish: "node engine/index.js publish",
  "check-models": "node engine/index.js check-models",
  dryrun: "node scripts/dry-run-publish.mjs",
};

const APPROVED = {
  marked: "18.1.0",
  playwright: "1.64.0",
  "@fontsource/inter": "5.3.0",
  "@fontsource/noto-sans-devanagari": "5.3.0",
  "@fontsource/cormorant-garamond": "5.3.0",
  "@fontsource/tiro-devanagari-hindi": "5.3.0",
  "@fontsource/mukta": "5.3.0",
  "@fontsource/space-grotesk": "5.3.0",
  "@fontsource/cascadia-code": "5.3.0",
  "@fontsource/dm-sans": "5.3.0",
  "@fontsource/manrope": "5.3.0",
  "@fontsource/dm-mono": "5.3.0",
};
const APPROVED_DEV = { "fast-xml-parser": "5.11.2" };

test("package.json: name, private, ESM, engines.node >=22.2", () => {
  assert.equal(pkg.name, "hoshlab");
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22.2");
});

test("package.json: the ten final scripts exist with the agreed commands", () => {
  assert.deepEqual(Object.keys(pkg.scripts).sort(), Object.keys(SCRIPTS).sort());
  for (const [name, cmd] of Object.entries(SCRIPTS)) assert.equal(pkg.scripts[name], cmd, `script ${name}`);
});

test("package.json: every dependency is an exact pin (no ^ or ~ or ranges)", () => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(Object.keys(all).length > 0);
  for (const [name, version] of Object.entries(all)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name}@${version} is not an exact pin`);
  }
});

test("package.json: only approved dependencies at their verified versions", () => {
  assert.deepEqual(pkg.dependencies, APPROVED);
  assert.deepEqual(pkg.devDependencies, APPROVED_DEV);
});

test("package-lock.json exists and pins the same root dependencies", () => {
  const lock = JSON.parse(read(join(ROOT, "package-lock.json")));
  assert.equal(lock.name, "hoshlab");
  assert.deepEqual(lock.packages[""].dependencies, APPROVED);
  assert.deepEqual(lock.packages[""].devDependencies, APPROVED_DEV);
});

test("fetch guard is installed for the whole suite (P1-02)", () => {
  assert.equal(fetchIsGuarded(), true);
  assert.throws(() => globalThis.fetch("https://example.com/"), /network call attempted in tests: https:\/\/example.com\//);
});

test("env defaults set by scripts/test.mjs are present", () => {
  assert.equal(process.env.MOCK_LLM, "1");
  assert.equal(process.env.IG_DRY_RUN, "1");
  assert.ok(process.env.COMPANY_DIR, "COMPANY_DIR");
});
