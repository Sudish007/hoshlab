// Windows-safe test runner (plan D15): sets the offline defaults, builds the fixture company
// when the builder exists, then runs node --test. No shell string, no cross-env.
// Usage: npm test   (any of the env vars below may be pre-set to override the defaults)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const DEFAULTS = {
  MOCK_LLM: "1",
  IG_DRY_RUN: "1",
  COMPANY_DIR: "tests/fixtures/company-populated",
  MEDIA_DIR: "tests/fixtures/media",
  DIST_DIR: "dist",
};
const env = { ...process.env };
for (const [name, value] of Object.entries(DEFAULTS)) {
  if (env[name] === undefined || env[name] === "") env[name] = value;
}

const buildScript = join(ROOT, "src", "build.js");
if (existsSync(buildScript)) {
  const build = spawnSync(process.execPath, [buildScript], { cwd: ROOT, stdio: "inherit", env });
  if (build.status !== 0) {
    console.error(`build: failed (exit ${build.status === null ? build.signal : build.status})`);
    process.exit(build.status === null ? 1 : build.status);
  }
} else {
  console.log("build: not built yet (src/build.js missing)");
}

const tests = spawnSync(process.execPath, ["--test", "tests/**/*.test.js"], { cwd: ROOT, stdio: "inherit", env });
process.exit(tests.status === null ? 1 : tests.status);
