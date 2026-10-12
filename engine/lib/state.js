// The only code path through which the engine writes company/ (design.md §12 "File ownership
// split", review M9, plan D7). Every write validates against engine/lib/schema.js first,
// writes UTF-8 without BOM atomically, and refuses admin-owned paths.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { APPROVAL_SPEC, CALENDAR_SPEC, CONFIG_SPEC, DRAFT_INDEX_SPEC, DRAFT_SPEC, EDIT_SPEC, FEEDBACK_SPEC, HR_DECISION_SPEC, HR_PROPOSAL_SPEC, IDEA_SPEC, METRIC_SPEC, OVERRIDE_SPEC, PUBLISHED_SPEC, QA_SPEC, ROSTER_SPEC, RUN_SPEC, STATUS_SPEC, SchemaError, TOKENS_SPEC, USAGE_SPEC, validate } from "./schema.js";
import { istMonthKey, nowIst } from "./time.js";

// The engine-owned draft index (R1-04 → R2-05): state/drafts/index.json, one entry per draft folder.
export const DRAFT_INDEX_REL = "state/drafts/index.json";

export class OwnershipError extends Error {
  constructor(rel) {
    super(`admin-owned path: ${rel} (the engine never writes it; design §12)`);
    this.name = "OwnershipError";
    this.path = rel;
  }
}

// Paths relative to company/. Globs: a trailing '/*' matches anything below that folder. ADMIN_OWNED wins where both
// tables match: state/hr/decisions.jsonl (the owner's Apply/Dismiss log, review N14 / plan D13) is the admin's, while
// the rest of state/hr/ — hr/<month>-review.md and hr/proposals/<month>.json — is the engine's (HR writes a proposal once;
// the admin never edits it, it records its decision beside it).
export const ADMIN_OWNED = ["config.json", "roster.json", "brands/*", "charters/*", "state/approvals.jsonl", "state/edits/*", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl"];
export const ENGINE_OWNED = ["state/status.json", "state/ideas.jsonl", "state/calendar.json", "state/drafts/*", "state/published.jsonl", "state/runs/*", "state/usage/*", "state/metrics/*", "state/memos/*", "state/reports/*", "state/hr/*", "state/tokens.json"];
// What "state/hr/*" covers for the engine (documentation + tests/state.test.js N14 row): proposals and reviews.
export const HR_ENGINE_FILES = ["state/hr/proposals/*", "state/hr/*-review.md"];

export const LOG_KINDS = ["runs", "usage", "metrics"];

export function normalizeRel(rel) {
  const n = posix.normalize(String(rel).replace(/\\/g, "/")).replace(/^\.\//, "").replace(/^\/+/, "");
  // Windows drive paths are refused on every host (node:path isAbsolute is posix-only on Linux CI).
  if (n === ".." || n.startsWith("../") || isAbsolute(n) || /^[A-Za-z]:(\/|$)/.test(n)) throw new RangeError(`state: path escapes the company dir: ${rel}`);
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

  // Markdown/text state files (memos, reports, HR reviews): UTF-8 without BOM, same ownership rule.
  function readText(rel) {
    const path = abs(rel);
    try {
      return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      e.message = `${rel}: ${e.message}`;
      throw e;
    }
  }

  function writeText(rel, text) {
    const n = normalizeRel(rel);
    if (isAdminOwned(n)) throw new OwnershipError(n);
    if (typeof text !== "string") throw new TypeError(`state: writeText expects a string for ${n}`);
    writeAtomic(abs(n), text);
    return n;
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

  // The index entries as the folder stands now (R2-05): one row per draft folder, sorted by id, read from the
  // validated draft.json files — never from memory, so the index always mirrors what is on disk.
  function draftIndexEntries() {
    return listDrafts().map((id) => {
      const d = readDraft(id);
      return { id: d.id, page: d.page, status: d.status, format: d.format, slotId: d.slotId, slotAt: d.slotAt, revision: d.revision, updatedAt: d.updatedAt, qa: existsSync(abs(qaRel(id))) };
    });
  }

  // Rewrites state/drafts/index.json when its entries differ from the file on disk (or the file is missing / unreadable)
  // → the rel written, or null when nothing changed, so an idle run leaves the file — and the drafts tree — untouched.
  function writeDraftIndex(date = clock()) {
    const drafts = draftIndexEntries();
    const path = abs(DRAFT_INDEX_REL);
    if (existsSync(path)) {
      let current = null;
      try {
        current = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        current = null;
      }
      if (current && validate(current, DRAFT_INDEX_SPEC).ok && JSON.stringify(current.drafts) === JSON.stringify(drafts)) return null;
    }
    return writeJson(DRAFT_INDEX_REL, { updatedAt: nowIst(date), drafts }, DRAFT_INDEX_SPEC);
  }

  function readDraftIndex() {
    return existsSync(abs(DRAFT_INDEX_REL)) ? readJson(DRAFT_INDEX_REL, DRAFT_INDEX_SPEC) : null;
  }

  return {
    root,
    now: clock,
    resolve: abs,
    validateTree: () => validateTree(root),
    exists: (rel) => existsSync(abs(rel)),
    readJson,
    writeJson,
    readJsonl,
    appendJsonl,
    readText,
    writeText,
    monthLogPath,
    appendLog,
    latestByKey,
    listDrafts,
    readDraft,
    writeDraft,
    readQa,
    writeQa,
    draftIndexEntries,
    writeDraftIndex,
    readDraftIndex,
    isAdminOwned,
    isEngineOwned,
  };
}

// ---------------------------------------------------------------------------------------
// validateTree(companyDir) — every file under company/ that the engine or the admin writes, checked
// against its spec (design §12 "Every state write validates", P1-22/P1-24 proofs, fixtures-integrity
// test). Brands and charters are validated by src/lib/company.js (loadCompany) and are only listed here.
//   → { files: [{ rel, kind, ok, errors }], errors: ['<rel>: <message>', …], ok }
// Unknown files under state/ are errors: the tree must contain only what the specs describe.

const MONTH_FILE = /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/;
const WEEK_FILE = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])\.md$/;
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,119}$/;

function walkFiles(dir, out = [], base = dir) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out, base);
    else out.push(p.slice(base.length + 1).replace(/\\/g, "/"));
  }
  return out;
}

// What a state path is and which spec applies → { kind, spec, jsonl, text, context? } or null (unknown).
export function specFor(rel) {
  const n = normalizeRel(rel);
  if (n === "config.json") return { kind: "config", spec: CONFIG_SPEC };
  if (n === "roster.json") return { kind: "roster", spec: ROSTER_SPEC, needsConfig: true };
  if (/^brands\/[\w.-]+\.md$/.test(n)) return { kind: "brand", text: true };
  if (/^charters\/[\w.-]+\.md$/.test(n)) return { kind: "charter", text: true };
  if (n === "state/status.json") return { kind: "status", spec: STATUS_SPEC };
  if (n === "state/calendar.json") return { kind: "calendar", spec: CALENDAR_SPEC };
  if (n === "state/tokens.json") return { kind: "tokens", spec: TOKENS_SPEC };
  if (n === "state/ideas.jsonl") return { kind: "idea", spec: IDEA_SPEC, jsonl: true };
  if (n === "state/approvals.jsonl") return { kind: "approval", spec: APPROVAL_SPEC, jsonl: true };
  if (n === "state/overrides.jsonl") return { kind: "override", spec: OVERRIDE_SPEC, jsonl: true };
  if (n === "state/feedback.jsonl") return { kind: "feedback", spec: FEEDBACK_SPEC, jsonl: true };
  if (n === "state/published.jsonl") return { kind: "published", spec: PUBLISHED_SPEC, jsonl: true };
  if (n === "state/hr/decisions.jsonl") return { kind: "hrDecision", spec: HR_DECISION_SPEC, jsonl: true };
  if (n === DRAFT_INDEX_REL) return { kind: "draftIndex", spec: DRAFT_INDEX_SPEC };
  let m;
  if ((m = n.match(/^state\/(runs|usage|metrics)\/([^/]+)$/))) {
    if (!MONTH_FILE.test(m[2])) return null;
    return { kind: m[1] === "runs" ? "run" : m[1] === "usage" ? "usage" : "metric", spec: m[1] === "runs" ? RUN_SPEC : m[1] === "usage" ? USAGE_SPEC : METRIC_SPEC, jsonl: true };
  }
  if ((m = n.match(/^state\/drafts\/([^/]+)\/(draft|qa)\.json$/))) {
    if (!ID_RE.test(m[1])) return null;
    return m[2] === "draft" ? { kind: "draft", spec: DRAFT_SPEC, id: m[1], idKey: "id" } : { kind: "qa", spec: QA_SPEC, id: m[1], idKey: "draftId" };
  }
  if ((m = n.match(/^state\/edits\/([^/]+)\.json$/))) return ID_RE.test(m[1]) ? { kind: "edit", spec: EDIT_SPEC, id: m[1], idKey: "draftId" } : null;
  if ((m = n.match(/^state\/hr\/proposals\/([^/]+)\.json$/))) return MONTH_FILE.test(`${m[1]}.jsonl`) ? { kind: "hrProposal", spec: HR_PROPOSAL_SPEC } : null;
  if ((m = n.match(/^state\/hr\/([^/]+)-review\.md$/))) return MONTH_FILE.test(`${m[1]}.jsonl`) ? { kind: "hrReview", text: true } : null;
  if ((m = n.match(/^state\/(memos|reports)\/([^/]+)$/))) return WEEK_FILE.test(m[2]) ? { kind: m[1] === "memos" ? "memo" : "report", text: true } : null;
  return null;
}

export function validateTree(companyDir) {
  const root = resolve(companyDir);
  const files = [];
  const errors = [];
  const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/^\uFEFF/, "");
  let config = null;
  if (existsSync(join(root, "config.json"))) {
    try {
      config = JSON.parse(read("config.json"));
    } catch {
      config = null;
    }
  }
  const rels = [...walkFiles(join(root, "state")).map((r) => `state/${r}`)];
  for (const top of ["config.json", "roster.json"]) if (existsSync(join(root, top))) rels.unshift(top);
  for (const rel of rels) {
    const entry = { rel, kind: null, ok: true, errors: [] };
    const s = specFor(rel);
    if (!s) {
      entry.ok = false;
      entry.errors.push("unexpected file (no spec describes this path)");
    } else {
      entry.kind = s.kind;
      try {
        const text = read(rel);
        if (s.text) {
          if (!text.trim()) entry.errors.push("empty file");
        } else if (s.jsonl) {
          const rows = parseJsonl(text);
          rows.forEach((row, i) => {
            const r = validate(row, s.spec);
            for (const e of r.errors) entry.errors.push(`line ${i + 1}: ${e}`);
          });
        } else {
          const value = JSON.parse(text);
          const r = validate(value, s.spec, s.needsConfig ? config : undefined);
          entry.errors.push(...r.errors);
          if (s.idKey && value && value[s.idKey] !== s.id) entry.errors.push(`${s.idKey} ${JSON.stringify(value && value[s.idKey])} does not match the folder/file name ${s.id}`);
        }
      } catch (e) {
        entry.errors.push(e.message);
      }
      entry.ok = entry.errors.length === 0;
    }
    files.push(entry);
    for (const e of entry.errors) errors.push(`${rel}: ${e}`);
  }
  return { files, errors, ok: errors.length === 0 };
}
