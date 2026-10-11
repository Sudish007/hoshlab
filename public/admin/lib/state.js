// Admin-owned writes only (design §12 ownership split, §13 "all admin writes go through state.js").
// Mirror of engine/lib/state.js ADMIN_OWNED: this module knows exactly these company/ paths and throws
// OwnershipError for anything else, so the browser can never touch an engine-owned file. Every JSON
// record is validated against its schema.js spec BEFORE the PUT; text files (brands, charters) are
// validated by the caller (brand.js / charter rules) and only ownership is checked here.
//   appendLine(rel, record, { message })  → getFile (404 → empty) → PUT old + line with sha → on 409 reload + retry once
//   writeJson(rel, obj, { message, context }) → validate → PUT (sha of the current file when it exists) → 409 retry once
//   writeText(rel, text, { message })      → brands/*, charters/* only
// `rel` is relative to company/ ('state/approvals.jsonl'); the repo path is company/<rel>.
import { APPROVAL_SPEC, CONFIG_SPEC, EDIT_SPEC, FEEDBACK_SPEC, HR_DECISION_SPEC, OVERRIDE_SPEC, ROSTER_SPEC, validate } from "./schema.js";

// state/hr/decisions.jsonl is the one admin-owned file under state/hr/ (review N14, plan D13): the owner's Apply /
// Dismiss log. hr/proposals/*.json and hr/*-review.md are the engine's and are never written from the browser.
export const ADMIN_OWNED = ["config.json", "roster.json", "brands/*", "charters/*", "state/approvals.jsonl", "state/edits/*", "state/overrides.jsonl", "state/feedback.jsonl", "state/hr/decisions.jsonl"];
export const COMPANY_PREFIX = "company/";

export class OwnershipError extends Error {
  constructor(rel) {
    super(`not an admin-owned path: ${rel} (the admin writes only ${ADMIN_OWNED.join(", ")})`);
    this.name = "OwnershipError";
    this.rel = rel;
  }
}

export class ValidationError extends Error {
  constructor(rel, errors) {
    super(`${rel}: ${errors.length} validation error${errors.length === 1 ? "" : "s"} — ${errors.slice(0, 5).join("; ")}`);
    this.name = "ValidationError";
    this.rel = rel;
    this.errors = errors;
  }
}

export function normalizeRel(rel) {
  const parts = [];
  for (const p of String(rel).replace(/\\/g, "/").replace(/^\/+/, "").split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") throw new RangeError(`state: path escapes the company dir: ${rel}`);
    parts.push(p);
  }
  const n = parts.join("/");
  return n.startsWith(COMPANY_PREFIX) ? n.slice(COMPANY_PREFIX.length) : n;
}

export function isAdminOwned(rel) {
  const n = normalizeRel(rel);
  return ADMIN_OWNED.some((g) => (g.endsWith("/*") ? n.startsWith(g.slice(0, -1)) && n.length > g.length - 1 && !n.slice(g.length - 1).includes("/") : n === g));
}

// Which spec applies to an admin-owned path → { kind, spec, jsonl, text } (ownership already implied).
export function specFor(rel) {
  const n = normalizeRel(rel);
  if (n === "config.json") return { kind: "config", spec: CONFIG_SPEC, jsonl: false, text: false };
  if (n === "roster.json") return { kind: "roster", spec: ROSTER_SPEC, jsonl: false, text: false };
  if (n === "state/approvals.jsonl") return { kind: "approval", spec: APPROVAL_SPEC, jsonl: true, text: false };
  if (n === "state/overrides.jsonl") return { kind: "override", spec: OVERRIDE_SPEC, jsonl: true, text: false };
  if (n === "state/feedback.jsonl") return { kind: "feedback", spec: FEEDBACK_SPEC, jsonl: true, text: false };
  if (n === "state/hr/decisions.jsonl") return { kind: "hrDecision", spec: HR_DECISION_SPEC, jsonl: true, text: false };
  if (/^state\/edits\/[^/]+\.json$/.test(n)) return { kind: "edit", spec: EDIT_SPEC, jsonl: false, text: false };
  if (/^brands\/[^/]+\.md$/.test(n)) return { kind: "brand", spec: null, jsonl: false, text: true };
  if (/^charters\/[^/]+\.md$/.test(n)) return { kind: "charter", spec: null, jsonl: false, text: true };
  return null;
}

function assertOwned(rel) {
  const n = normalizeRel(rel);
  if (!isAdminOwned(n)) throw new OwnershipError(n);
  const s = specFor(n);
  if (!s) throw new OwnershipError(n);
  return { rel: n, path: COMPANY_PREFIX + n, ...s };
}

function assertRecord(rel, record, spec, context) {
  const r = validate(record, spec, context);
  if (!r.ok) throw new ValidationError(rel, r.errors);
}

const is409 = (err) => err && err.name === "GitHubError" && err.status === 409;

// createAdminState(client) — `client` is public/admin/lib/github.js createClient().
export function createAdminState(client) {
  async function current(path) {
    try {
      return await client.getFile(path);
    } catch (err) {
      if (err && err.name === "GitHubError" && err.status === 404) return { text: "", sha: undefined, missing: true };
      throw err;
    }
  }

  // One read-modify-write with a single retry on 409 (the file moved between our GET and PUT).
  async function rmw(path, message, next) {
    let file = await current(path);
    try {
      return await client.putFile(path, { content: next(file), message, sha: file.sha });
    } catch (err) {
      if (!is409(err)) throw err;
      file = await current(path);
      return client.putFile(path, { content: next(file), message, sha: file.sha });
    }
  }

  return {
    ADMIN_OWNED,
    isAdminOwned,
    specFor,
    // Validates a record/object for an admin-owned path without writing → errors[] ([] when valid).
    errorsFor(rel, value, context) {
      const o = assertOwned(rel);
      if (!o.spec) return [];
      return validate(value, o.spec, context).errors;
    },
    async appendLine(rel, record, { message } = {}) {
      const o = assertOwned(rel);
      if (!o.jsonl) throw new OwnershipError(`${o.rel} is not an append-only log`);
      assertRecord(o.rel, record, o.spec);
      const line = JSON.stringify(record);
      return rmw(o.path, message || `${o.kind}: ${record.draftId || record.kind || "append"}`, (file) => {
        const old = String(file.text || "");
        return (old === "" || old.endsWith("\n") ? old : old + "\n") + line + "\n";
      });
    },
    async writeJson(rel, obj, { message, context } = {}) {
      const o = assertOwned(rel);
      if (o.jsonl || o.text) throw new OwnershipError(`${o.rel} is not a JSON document`);
      assertRecord(o.rel, obj, o.spec, context);
      const text = JSON.stringify(obj, null, 2) + "\n";
      return rmw(o.path, message || `${o.kind}: update`, () => text);
    },
    async writeText(rel, text, { message } = {}) {
      const o = assertOwned(rel);
      if (!o.text) throw new OwnershipError(`${o.rel} is not a text document`);
      const body = String(text).replace(/\r\n/g, "\n");
      return rmw(o.path, message || `${o.kind}: update`, () => (body.endsWith("\n") ? body : body + "\n"));
    },
  };
}
