// Node loader for the company folder (design.md §4, §12; review M4). Used by the builder, the
// engine and the tests. Validates config.json (CONFIG_SPEC + cross-field rules), roster.json
// (ROSTER_SPEC against the config), every brand file (brand.js) and every charter (three
// headings, ≤ 12,000 characters); throws CompanyError carrying ALL errors when anything is invalid.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CONFIG_SPEC, ROSTER_SPEC, validate } from "../../engine/lib/schema.js";
import { parseBrand, validateBrand, usableFacts, factNumbers, BrandError } from "../../engine/lib/brand.js";
import { createState } from "../../engine/lib/state.js";
import { istDate } from "../../engine/lib/time.js";
import { cronLabel } from "./labels.js";

export const CHARTER_HEADINGS = ["## Identity", "## Method", "## Output"];
export const CHARTER_MAX_CHARS = 12000;
export const SOURCE_STALE_DAYS = 90;
// config.schedule: each cron (UTC) beside the IST label the site, the README and the workflow comments print.
export const SCHEDULE_PAIRS = [
  ["engineCron", "engineLabel"],
  ["publisherCron", "publisherLabel"],
  ["tokenRefreshCron", "tokenRefreshLabel"],
];

// The cadence labels are derived from their crons (src/lib/labels.js cronLabel): a label that is not the derivation of
// its cron is a load error, so the public pages, the README and the workflow comments can never name a time the cron
// does not fire at. → errors[] in the schema's "$.path: message" form.
export function scheduleErrors(schedule) {
  const errors = [];
  if (!schedule || typeof schedule !== "object") return errors;
  for (const [cronKey, labelKey] of SCHEDULE_PAIRS) {
    let derived;
    try {
      derived = cronLabel(schedule[cronKey]);
    } catch (e) {
      errors.push(`$.schedule.${cronKey}: ${e.message}`);
      continue;
    }
    if (schedule[labelKey] !== derived) errors.push(`$.schedule.${labelKey}: ${JSON.stringify(schedule[labelKey])} is not the label of cron ${schedule[cronKey]} (${derived})`);
  }
  return errors;
}

export class CompanyError extends Error {
  constructor(errors, companyDir) {
    super(`company ${companyDir}: ${errors.length} error${errors.length === 1 ? "" : "s"}\n  - ${errors.join("\n  - ")}`);
    this.name = "CompanyError";
    this.errors = errors;
    this.companyDir = companyDir;
  }
}

function codePoints(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// config/roster paths are written as 'company/brands/x.md' (relative to the repo root); inside a
// fixture company the same string resolves against that company dir instead.
export function resolveCompanyPath(companyDir, p) {
  if (isAbsolute(p)) return p;
  const rel = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return join(companyDir, rel.startsWith("company/") ? rel.slice("company/".length) : rel);
}

function readText(path) {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

function readJsonFile(path, errors, label) {
  if (!existsSync(path)) {
    errors.push(`${label}: file missing (${path})`);
    return null;
  }
  try {
    return JSON.parse(readText(path));
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
    return null;
  }
}

// Validates one charter text → errors[] (headings present, in order, size cap).
export function validateCharter(text, label = "charter") {
  const errors = [];
  const n = codePoints(text);
  if (n > CHARTER_MAX_CHARS) errors.push(`${label}: ${n} characters, limit ${CHARTER_MAX_CHARS}`);
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  let last = -1;
  for (const h of CHARTER_HEADINGS) {
    const i = lines.indexOf(h);
    if (i < 0) errors.push(`${label}: heading '${h}' missing`);
    else if (i < last) errors.push(`${label}: heading '${h}' out of order (Identity, Method, Output)`);
    else last = i;
  }
  return errors;
}

function daysBetween(fromDate, toDate) {
  return Math.floor((Date.parse(toDate + "T00:00:00Z") - Date.parse(fromDate + "T00:00:00Z")) / 86400000);
}

// loadCompany({ companyDir, now, warn }) → { dir, config, roster, brands, charters, state, warnings }.
//   brands:   { [handle]: parsed brand + { path, usableFacts(), factNumbers(), page } }
//   charters: { [agent]: { path, text, agent } }
//   state:    engine/lib/state.js createState() bound to the same dir (status.json etc.)
export function loadCompany({ companyDir = process.env.COMPANY_DIR || "company", now = () => new Date(), warn = (msg) => console.warn(msg) } = {}) {
  const dir = resolve(companyDir);
  const errors = [];
  const warnings = [];

  const config = readJsonFile(join(dir, "config.json"), errors, "config.json");
  if (config) {
    const r = validate(config, CONFIG_SPEC);
    errors.push(...r.errors.map((e) => `config.json ${e}`));
    if (r.ok) errors.push(...scheduleErrors(config.schedule).map((e) => `config.json ${e}`));
  }

  const roster = readJsonFile(join(dir, "roster.json"), errors, "roster.json");
  if (roster) {
    const r = validate(roster, ROSTER_SPEC, config || undefined);
    errors.push(...r.errors.map((e) => `roster.json ${e}`));
  }

  const brands = {};
  const today = istDate(typeof now === "function" ? now() : now);
  for (const page of (config && Array.isArray(config.pages) && config.pages) || []) {
    const path = resolveCompanyPath(dir, page.brand || "");
    const label = `brands/${basename(path)}`;
    if (!page.brand || !existsSync(path)) {
      errors.push(`${label}: brand file missing for page ${page.handle} (${path})`);
      continue;
    }
    let parsed;
    try {
      parsed = parseBrand(readText(path), label);
    } catch (e) {
      errors.push(...(e instanceof BrandError ? e.errors.map((x) => `${label}: ${x}`) : [`${label}: ${e.message}`]));
      continue;
    }
    const brandErrors = validateBrand(parsed);
    errors.push(...brandErrors.map((x) => `${label}: ${x}`));
    if (parsed.frontMatter.handle !== page.handle) errors.push(`${label}: front matter handle ${JSON.stringify(parsed.frontMatter.handle)} does not match page ${page.handle}`);
    const verified = parsed.frontMatter.sourceVerifiedAt;
    if (!verified) warnings.push(`brand ${page.handle}: sources not verified yet (run node scripts/verify-sources.mjs --write)`);
    else if (daysBetween(String(verified), today) > SOURCE_STALE_DAYS) warnings.push(`brand ${page.handle}: sourceVerifiedAt ${verified} older than ${SOURCE_STALE_DAYS} days (run node scripts/verify-sources.mjs --write)`);
    brands[page.handle] = {
      ...parsed,
      path,
      page,
      usableFacts: () => usableFacts(parsed),
      factNumbers: () => factNumbers(parsed),
    };
  }

  const charters = {};
  for (const agent of (roster && Array.isArray(roster.agents) && roster.agents) || []) {
    const path = resolveCompanyPath(dir, agent.charter || "");
    const label = `charters/${basename(path)}`;
    if (!agent.charter || !existsSync(path)) {
      errors.push(`${label}: charter missing for agent ${agent.name} (${path})`);
      continue;
    }
    const text = readText(path);
    errors.push(...validateCharter(text, label));
    charters[agent.name] = { agent: agent.name, path, text };
  }

  if (errors.length) throw new CompanyError(errors, dir);
  for (const w of warnings) warn(w);
  return {
    dir,
    config,
    roster,
    brands,
    charters,
    warnings,
    state: createState({ companyDir: dir, now }),
    statusPath: join(dir, "state", "status.json"),
  };
}
