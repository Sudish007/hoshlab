// Single source of truth for site values (plan D14): everything here is derived from
// company/config.json so the builder, the audits and the engine never drift.
// COMPANY_DIR (relative to the repo root, or absolute) selects a fixture company in tests.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const companyDir = process.env.COMPANY_DIR || "company";
const configPath = join(isAbsolute(companyDir) ? companyDir : join(ROOT, companyDir), "config.json");

// FALLBACK (FEAT-101 only): company/config.json is written by FEAT-102. Until then this
// clearly labelled object stands in when the file is missing. FEAT-102 must remove it and
// let a missing config.json throw.
const FALLBACK = {
  fallback: true,
  siteUrl: "https://sudish007.github.io/hoshlab",
  basePath: "/hoshlab/",
  title: "Hoshlab",
  titleDevanagari: "होशलैब",
  repo: { owner: "Sudish007", name: "hoshlab", branch: "main", mediaBranch: "media" },
  owner: { name: "Hoshlab", nameDevanagari: "होशलैब" },
};

function load() {
  if (!existsSync(configPath)) return FALLBACK;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
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
