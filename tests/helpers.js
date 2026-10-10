// Shared test helpers. Importing this file installs the no-network fetch guard (P1-02):
// any call to globalThis.fetch during tests throws and is recorded in FETCH_ATTEMPTS.
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = process.env.DIST_DIR ? resolveFromRoot(process.env.DIST_DIR) : join(ROOT, "dist");
export const COMPANY_DIR = process.env.COMPANY_DIR ? resolveFromRoot(process.env.COMPANY_DIR) : join(ROOT, "company");

function resolveFromRoot(p) {
  return isAbsolute(p) ? p : join(ROOT, p);
}

export function walk(dir, filter = () => true, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

export function htmlFiles() {
  return walk(DIST, (p) => p.endsWith(".html"));
}

export function read(p) {
  return readFileSync(p, "utf8");
}

// A fresh scratch directory under the OS temp dir (never inside the repo).
export function tmpDir(prefix = "hoshlab-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const FETCH_ATTEMPTS = [];

export function installFetchGuard() {
  const guard = function fetchGuard(input) {
    const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
    FETCH_ATTEMPTS.push(url);
    throw new Error("network call attempted in tests: " + url);
  };
  guard.isHoshlabFetchGuard = true;
  globalThis.fetch = guard;
  return guard;
}

export function fetchIsGuarded() {
  return typeof globalThis.fetch === "function" && globalThis.fetch.isHoshlabFetchGuard === true;
}

installFetchGuard();
