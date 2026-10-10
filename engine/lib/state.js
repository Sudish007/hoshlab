// The only code path through which the engine writes company/ (design.md §12 "File ownership
// split", review M9, plan D7). Every write validates against engine/lib/schema.js first,
// writes UTF-8 without BOM atomically, and refuses admin-owned paths.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { DRAFT_SPEC, QA_SPEC, SchemaError, validate } from "./schema.js";
import { istMonthKey } from "./time.js";

export class OwnershipError extends Error {
  constructor(rel) {
    super(`admin-owned path: ${rel} (the engine never writes it; design §12)`);
    this.name = "OwnershipError";
    this.path = rel;
  }
}

// Paths relative to company/. Globs: a trailing '/*' matches anything below that folder.
export const ADMIN_OWNED = ["config.json", "roster.json", "brands/*", "charters/*", "state/approvals.jsonl", "state/edits/*", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl"];
export const ENGINE_OWNED = ["state/status.json", "state/ideas.jsonl", "state/calendar.json", "state/drafts/*", "state/published.jsonl", "state/runs/*", "state/usage/*", "state/metrics/*", "state/memos/*", "state/reports/*", "state/hr/*", "state/tokens.json"];

export const LOG_KINDS = ["runs", "usage", "metrics"];

export function normalizeRel(rel) {
  const n = posix.normalize(String(rel).replace(/\\/g, "/")).replace(/^\.\//, "").replace(/^\/+/, "");
  if (n === ".." || n.startsWith("../") || isAbsolute(n)) throw new RangeError(`state: path escapes the company dir: ${rel}`);
  return n;
}

function matches(table, rel) {
  return table.some((entry) => (entry.endsWith("/*") ? rel.startsWith(entry.slice(0, -1)) : rel === entry));
}

export function isAdminOwned(rel) {
  return matches(ADMIN_OWNED, normalizeRel(rel));
}

export function isEngineOwned(rel) {
  const n = normalizeRel(rel);
  return !matches(ADMIN_OWNED, n) && matches(ENGINE_OWNED, n);
}

// Latest record per `key` (append-only logs: a later record with the same key supersedes).
export function latestByKey(records, key) {
  const out = new Map();
  for (const r of records) if (r && r[key] !== undefined) out.set(r[key], r);
  return out;
}

export function parseJsonl(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new SyntaxError(`jsonl: line ${i + 1}: ${e.message}`);
    }
  }
  return out;
}

function assertValidOrThrow(value, spec, rel) {
  if (!spec) return;
  const r = validate(value, spec);
  if (!r.ok) throw new SchemaError(r.errors.map((e) => `${rel} ${e}`));
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(tmp, text, "utf8"); // UTF-8, no BOM
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// createState({ companyDir, now }) — `now` is a Date, an ISO string or a function returning one.
export function createState({ companyDir = process.env.COMPANY_DIR || "company", now = () => new Date() } = {}) {
  const root = resolve(companyDir);
  const clock = () => {
    const v = typeof now === "function" ? now() : now;
    return v instanceof Date ? v : new Date(v);
  };
  const abs = (rel) => join(root, normalizeRel(rel));

  function readJson(rel, spec) {
    const path = abs(rel);
    let value;
    try {
      value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    } catch (e) {
      e.message = `${rel}: ${e.message}`;
      throw e;
    }
    assertValidOrThrow(value, spec, rel);
    return value;
  }

  function writeJson(rel, value, spec) {
    const n = normalizeRel(rel);
    if (isAdminOwned(n)) throw new OwnershipError(n);
    assertValidOrThrow(value, spec, n);
    writeAtomic(abs(n), JSON.stringify(value, null, 2) + "\n");
    return n;
  }

  function readJsonl(rel) {
    const path = abs(rel);
    if (!existsSync(path)) return [];
    return parseJsonl(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  }

  function appendJsonl(rel, record, spec) {
    const n = normalizeRel(rel);
    if (isAdminOwned(n)) throw new OwnershipError(n);
    assertValidOrThrow(record, spec, n);
    const path = abs(n);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
    return n;
  }

  // 'state/runs/2026-10.jsonl' for the IST month of `date` (default: the state clock).
  function monthLogPath(kind, date = clock()) {
    if (!LOG_KINDS.includes(kind)) throw new RangeError(`state: unknown log kind ${kind} (${LOG_KINDS.join("|")})`);
    return `state/${kind}/${istMonthKey(date)}.jsonl`;
  }

  function appendLog(kind, record, spec, date = clock()) {
    return appendJsonl(monthLogPath(kind, date), record, spec);
  }

  function listDrafts() {
    const dir = abs("state/drafts");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "draft.json")))
      .sort();
  }

  const draftRel = (id) => `state/drafts/${id}/draft.json`;
  const qaRel = (id) => `state/drafts/${id}/qa.json`;

  function readDraft(id) {
    return readJson(draftRel(id), DRAFT_SPEC);
  }

  function writeDraft(draft) {
    return writeJson(draftRel(draft.id), draft, DRAFT_SPEC);
  }

  function readQa(id) {
    const rel = qaRel(id);
    return existsSync(abs(rel)) ? readJson(rel, QA_SPEC) : null;
  }

  function writeQa(qa) {
    return writeJson(qaRel(qa.draftId), qa, QA_SPEC);
  }

  return {
    root,
    now: clock,
    resolve: abs,
    exists: (rel) => existsSync(abs(rel)),
    readJson,
    writeJson,
    readJsonl,
    appendJsonl,
    monthLogPath,
    appendLog,
    latestByKey,
    listDrafts,
    readDraft,
    writeDraft,
    readQa,
    writeQa,
    isAdminOwned,
    isEngineOwned,
  };
}
