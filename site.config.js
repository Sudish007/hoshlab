// Single source of truth for site values (plan D14): everything here is derived from
// company/config.json so the builder, the audits and the engine never drift.
// COMPANY_DIR (relative to the repo root, or absolute) selects a fixture company in tests.
// A missing config.json is an error: there is no fallback.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const companyDir = process.env.COMPANY_DIR || "company";
const configPath = join(isAbsolute(companyDir) ? companyDir : join(ROOT, companyDir), "config.json");

function load() {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`site.config.js: cannot read ${configPath} (${e.message})`);
  }
  return {
    siteUrl: config.site.url,
    basePath: config.site.basePath,
    title: config.company.name,
    titleDevanagari: config.company.nameDevanagari,
    repo: config.repo,
    owner: config.company,
  };
}

const siteConfig = load();
export default siteConfig;
