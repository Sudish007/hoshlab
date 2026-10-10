// Hoshlab state schemas (design.md §4, §12; review M3/M5/M7/M9/N3; plan D8/D10).
// Browser-safe: no node: imports. This file is byte-copied into dist/admin/lib/ at build
// time so the admin validates with identical rules (plan D12).
//
// DSL (plain data, so specs can be serialised and copied):
//   'str' | 'str<=N' (code-point max) | 'int' | 'int[min..max]' | 'num' | 'num[min..max]' | 'bool'
//   'enum[a|b|c]' | 'iso-datetime' (explicit offset, e.g. +05:30) | 'date' (YYYY-MM-DD)
//   'handle' (^[a-z0-9_.]{1,30}$) | 'id' | 'url' (http/https) | 'pattern:<regex>' (u flag)
//   'obj' (free-form plain object) | 'any' (anything but undefined)
//   any token + '?'  → the value may also be null/undefined
//   [itemSpec] or [itemSpec, { min, max }] → array
//   { key: spec, 'optKey?': spec, '*': spec } → object; 'key?' may be absent or null;
//   '*' is a map: every other key is validated against that spec. Unknown keys are errors.

export class SchemaError extends Error {
  constructor(errors, path = "$") {
    super(`schema: ${errors.length} error${errors.length === 1 ? "" : "s"} — ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; …" : ""}`);
    this.name = "SchemaError";
    this.errors = errors;
    this.path = path;
  }
}

const RE = {
  handle: /^[a-z0-9_.]{1,30}$/,
  id: /^[a-z0-9][a-z0-9_.-]{0,119}$/,
  date: /^(\d{4})-(\d{2})-(\d{2})$/,
  isoDatetime: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/,
  enumToken: /^enum\[(.*)\]$/,
  strMax: /^str<=(\d+)$/,
  numRange: /^(int|num)\[(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)\]$/,
};

const SCALARS = new Set(["str", "int", "num", "bool", "iso-datetime", "date", "handle", "id", "url", "obj", "any"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function codePoints(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

// Parses a scalar token into { base, nullable, max, min, enum, regex, source }.
export function parseToken(token) {
  if (typeof token !== "string") throw new SchemaError([`spec: token must be a string, got ${typeof token}`]);
  let t = token;
  let nullable = false;
  if (t.endsWith("?")) {
    nullable = true;
    t = t.slice(0, -1);
  }
  if (t.startsWith("pattern:")) {
    const source = t.slice("pattern:".length);
    let regex;
    try {
      regex = new RegExp(source, "u");
    } catch (e) {
      throw new SchemaError([`spec: invalid pattern ${source}: ${e.message}`]);
    }
    return { base: "pattern", nullable, regex, source };
  }
  let m;
  if ((m = RE.enumToken.exec(t))) {
    const values = m[1].split("|").filter((v) => v.length > 0);
    if (values.length === 0) throw new SchemaError([`spec: empty enum ${token}`]);
    return { base: "enum", nullable, enum: values };
  }
  if ((m = RE.strMax.exec(t))) return { base: "str", nullable, max: Number(m[1]) };
  if ((m = RE.numRange.exec(t))) return { base: m[1], nullable, min: Number(m[2]), max: Number(m[3]) };
  if (SCALARS.has(t)) return { base: t, nullable };
  throw new SchemaError([`spec: unknown token ${token}`]);
}

function checkScalar(value, token, path, errors) {
  const tk = parseToken(token);
  if (value === null || value === undefined) {
    if (!tk.nullable) errors.push(`${path}: required ${tk.base}`);
    return;
  }
  switch (tk.base) {
    case "any":
      return;
    case "obj":
      if (!isPlainObject(value)) errors.push(`${path}: expected object`);
      return;
    case "str":
      if (typeof value !== "string") return void errors.push(`${path}: expected string`);
      if (tk.max !== undefined && codePoints(value) > tk.max) errors.push(`${path}: longer than ${tk.max} characters (${codePoints(value)})`);
      return;
    case "int":
      if (!Number.isInteger(value)) return void errors.push(`${path}: expected integer`);
      if (tk.min !== undefined && (value < tk.min || value > tk.max)) errors.push(`${path}: expected integer in ${tk.min}..${tk.max}`);
      return;
    case "num":
      if (typeof value !== "number" || !Number.isFinite(value)) return void errors.push(`${path}: expected number`);
      if (tk.min !== undefined && (value < tk.min || value > tk.max)) errors.push(`${path}: expected number in ${tk.min}..${tk.max}`);
      return;
    case "bool":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return;
    case "enum":
      if (!tk.enum.includes(value)) errors.push(`${path}: expected one of ${tk.enum.join("|")}, got ${JSON.stringify(value)}`);
      return;
    case "iso-datetime": {
      if (typeof value !== "string") return void errors.push(`${path}: expected ISO datetime string`);
      const m = RE.isoDatetime.exec(value);
      if (!m) return void errors.push(`${path}: expected ISO datetime with explicit offset (e.g. 2026-10-14T19:30:00+05:30)`);
      if (!validDate(+m[1], +m[2], +m[3]) || +m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59) || Number.isNaN(Date.parse(value))) {
        errors.push(`${path}: invalid datetime ${value}`);
      }
      return;
    }
    case "date": {
      if (typeof value !== "string") return void errors.push(`${path}: expected YYYY-MM-DD string`);
      const m = RE.date.exec(value);
      if (!m || !validDate(+m[1], +m[2], +m[3])) errors.push(`${path}: expected a valid YYYY-MM-DD date`);
      return;
    }
    case "handle":
      if (typeof value !== "string" || !RE.handle.test(value)) errors.push(`${path}: expected handle ^[a-z0-9_.]{1,30}$`);
      return;
    case "id":
      if (typeof value !== "string" || !RE.id.test(value)) errors.push(`${path}: expected id ^[a-z0-9][a-z0-9_.-]{0,119}$`);
      return;
    case "url": {
      if (typeof value !== "string") return void errors.push(`${path}: expected URL string`);
      try {
        const u = new URL(value);
        if (u.protocol !== "https:" && u.protocol !== "http:") errors.push(`${path}: URL must be http(s)`);
      } catch {
        errors.push(`${path}: invalid URL`);
      }
      return;
    }
    case "pattern":
      if (typeof value !== "string" || !tk.regex.test(value)) errors.push(`${path}: does not match /${tk.source}/`);
      return;
    default:
      errors.push(`${path}: unknown token ${token}`);
  }
}

function arrayOptions(spec) {
  if (spec.length < 1 || spec.length > 2) throw new SchemaError([`spec: array spec must be [itemSpec] or [itemSpec, {min,max}]`]);
  const opts = spec[1] || {};
  return { item: spec[0], min: opts.min, max: opts.max };
}

function check(value, spec, path, errors) {
  if (typeof spec === "string") return checkScalar(value, spec, path, errors);
  if (Array.isArray(spec)) {
    const { item, min, max } = arrayOptions(spec);
    if (!Array.isArray(value)) return void errors.push(`${path}: expected array`);
    if (min !== undefined && value.length < min) errors.push(`${path}: expected at least ${min} item${min === 1 ? "" : "s"} (${value.length})`);
    if (max !== undefined && value.length > max) errors.push(`${path}: expected at most ${max} item${max === 1 ? "" : "s"} (${value.length})`);
    value.forEach((v, i) => check(v, item, `${path}[${i}]`, errors));
    return;
  }
  if (isPlainObject(spec)) {
    if (!isPlainObject(value)) return void errors.push(`${path}: expected object`);
    const known = new Set();
    for (const [rawKey, sub] of Object.entries(spec)) {
      if (rawKey === "*") continue;
      const optional = rawKey.endsWith("?");
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      known.add(key);
      const v = value[key];
      if (v === undefined || v === null) {
        if (!optional) {
          // A nullable scalar token accepts null/undefined for a required key too.
          if (typeof sub === "string" && parseToken(sub).nullable) continue;
          errors.push(`${path}.${key}: required`);
        }
        continue;
      }
      check(v, sub, `${path}.${key}`, errors);
    }
    const wildcard = spec["*"];
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      if (wildcard !== undefined) check(value[key], wildcard, `${path}.${key}`, errors);
      else errors.push(`${path}.${key}: unknown key`);
    }
    return;
  }
  throw new SchemaError([`spec: unsupported spec at ${path}`]);
}

// Throws SchemaError (errors[] of '<path>: <message>') when value does not match spec.
export function assertShape(value, spec, path = "$") {
  const errors = [];
  check(value, spec, path, errors);
  if (errors.length) throw new SchemaError(errors, path);
  return value;
}

// ---------------------------------------------------------------------------------------
// Cross-field rules that the DSL cannot express (design §4.1, §4.2, §4.8, §12).

const AGENT_NAMES = ["ceo", "hr", "strategist", "writer", "designer", "qa", "publisher", "analyst"];
const PROVIDER_NAMES = ["anthropic", "gemini", "openai"];

export function configRules(config) {
  const errors = [];
  const handles = new Set();
  const prefixes = new Set();
  for (const [i, page] of (config.pages || []).entries()) {
    if (handles.has(page.handle)) errors.push(`$.pages[${i}].handle: duplicate handle ${page.handle}`);
    handles.add(page.handle);
    if (prefixes.has(page.prefix)) errors.push(`$.pages[${i}].prefix: duplicate prefix ${page.prefix}`);
    prefixes.add(page.prefix);
    for (const [j, slot] of ((page.cadence && page.cadence.slots) || []).entries()) {
      if (Array.isArray(page.formats) && !page.formats.includes(slot.format)) {
        errors.push(`$.pages[${i}].cadence.slots[${j}].format: ${slot.format} not in page formats`);
      }
    }
  }
  const providers = config.providers || {};
  for (const name of PROVIDER_NAMES) {
    const p = providers[name];
    if (p && p.enabled && Object.keys(p.models || {}).length === 0) errors.push(`$.providers.${name}.models: enabled provider needs at least one model`);
  }
  return errors;
}

export function rosterRules(roster, config) {
  const errors = [];
  const seen = new Map();
  for (const [i, agent] of (roster.agents || []).entries()) {
    if (seen.has(agent.name)) errors.push(`$.agents[${i}].name: duplicate agent ${agent.name}`);
    seen.set(agent.name, agent);
    if (agent.kind === "llm") {
      if (!agent.provider) errors.push(`$.agents[${i}].provider: required for kind llm`);
      if (!agent.model) errors.push(`$.agents[${i}].model: required for kind llm`);
      if (config && agent.provider) {
        const p = (config.providers || {})[agent.provider];
        if (!p || !p.enabled) errors.push(`$.agents[${i}].provider: ${agent.provider} is not an enabled provider`);
        else if (agent.model && !(agent.model in (p.models || {}))) errors.push(`$.agents[${i}].model: ${agent.model} not in providers.${agent.provider}.models`);
        for (const fb of agent.fallback || []) {
          const fp = (config.providers || {})[fb];
          if (!fp || !fp.enabled) errors.push(`$.agents[${i}].fallback: ${fb} is not an enabled provider`);
        }
      }
    }
  }
  for (const name of AGENT_NAMES) if (!seen.has(name)) errors.push(`$.agents: missing agent ${name}`);
  for (const name of ["qa", "publisher"]) {
    const a = seen.get(name);
    if (a && a.enabled === false) errors.push(`$.agents: ${name} cannot be disabled`);
  }
  return errors;
}

export function approvalRules(record) {
  const errors = [];
  if (record.decision === "reject") {
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (codePoints(reason) < 3) errors.push("$.reason: required for reject (3-500 characters)");
  }
  return errors;
}

// Specs with cross-field rules; validate()/assertValid() apply them automatically.
const SPEC_RULES = new Map();

// Validates DSL shape plus the cross-field rules registered for that spec → { ok, errors }.
export function validate(value, spec, context) {
  const errors = [];
  check(value, spec, "$", errors);
  const rules = SPEC_RULES.get(spec);
  if (errors.length === 0 && rules) errors.push(...rules(value, context));
  return { ok: errors.length === 0, errors };
}

export function assertValid(value, spec, context) {
  const r = validate(value, spec, context);
  if (!r.ok) throw new SchemaError(r.errors);
  return value;
}

// ---------------------------------------------------------------------------------------
// Source pointers (review M3, plan D8): `<repo-folder>/<path>:<range>(,<range>)*` joined by
// ' ; ', relative to the owner's workspace folder. A path needs at least one '/', so a bare
// 'README.md:3' (no repo folder) is rejected.
const POINTER_SRC = String.raw`[\w.-]+(?:/[\w.-]+)+:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*`;
export const SOURCE_RE = new RegExp(`^${POINTER_SRC}(?: ; ${POINTER_SRC})*$`);

// 'kaatdo/web/index.html:21,34,445 ; kaatdo/README.md:3' →
// [{ path: 'kaatdo/web/index.html', repo: 'kaatdo', file: 'web/index.html', ranges: [[21,21],[34,34],[445,445]] }, …]
export function parseSource(cell) {
  if (typeof cell !== "string" || !SOURCE_RE.test(cell)) throw new SchemaError([`source: does not match SOURCE_RE: ${JSON.stringify(cell)}`]);
  return cell.split(" ; ").map((pointer) => {
    const colon = pointer.lastIndexOf(":");
    const path = pointer.slice(0, colon);
    const slash = path.indexOf("/");
    const ranges = pointer
      .slice(colon + 1)
      .split(",")
      .map((r) => {
        const [from, to] = r.split("-").map(Number);
        const range = [from, to === undefined ? from : to];
        if (range[1] < range[0]) throw new SchemaError([`source: range end before start in ${pointer}`]);
        return range;
      });
    return { path, repo: path.slice(0, slash), file: path.slice(slash + 1), ranges };
  });
}

// ---------------------------------------------------------------------------------------
// JSON Schema dialects (review M7, plan D10). Parsed model output is ALWAYS re-validated
// with assertShape regardless of dialect, so each dialect only needs what the provider accepts.
//   openai : every property required, additionalProperties:false on every object, optional → [T,'null']
//   gemini : only type / properties / required / items / enum / nullable
//   prompt : pretty JSON example string

const JSON_TYPE = { str: "string", int: "integer", num: "number", bool: "boolean", "iso-datetime": "string", date: "string", handle: "string", id: "string", url: "string", pattern: "string", enum: "string" };

function scalarSchema(token, dialect) {
  const tk = parseToken(token);
  if (tk.base === "any" || tk.base === "obj") {
    if (dialect === "openai") throw new SchemaError([`toJsonSchema: '${token}' is not representable in the OpenAI strict dialect; spell out the properties`]);
    return tk.base === "obj" ? { type: "object" } : {};
  }
  const type = JSON_TYPE[tk.base];
  const out = {};
  if (dialect === "openai") out.type = tk.nullable ? [type, "null"] : type;
  else {
    out.type = type;
    if (tk.nullable) out.nullable = true;
  }
  if (tk.base === "enum") out.enum = dialect === "openai" && tk.nullable ? [...tk.enum, null] : tk.enum;
  return out;
}

function toSchema(spec, dialect) {
  if (typeof spec === "string") return scalarSchema(spec, dialect);
  if (Array.isArray(spec)) {
    const { item, min, max } = arrayOptions(spec);
    const out = { type: "array", items: toSchema(item, dialect) };
    if (dialect === "openai") {
      if (min !== undefined) out.minItems = min;
      if (max !== undefined) out.maxItems = max;
    }
    return out;
  }
  if (isPlainObject(spec)) {
    if ("*" in spec) {
      if (dialect === "openai") throw new SchemaError(["toJsonSchema: map specs ('*') are not representable in the OpenAI strict dialect"]);
      return { type: "object" };
    }
    const properties = {};
    const required = [];
    for (const [rawKey, sub] of Object.entries(spec)) {
      const optional = rawKey.endsWith("?");
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      let s = toSchema(sub, dialect);
      if (optional) {
        if (dialect === "openai") {
          if (typeof sub === "string") s = scalarSchema(sub.endsWith("?") ? sub : sub + "?", dialect);
          else s = { anyOf: [s, { type: "null" }] };
        } else s = { ...s, nullable: true };
      }
      properties[key] = s;
      if (dialect === "openai" || !optional) required.push(key);
    }
    const out = { type: "object", properties, required };
    if (dialect === "openai") out.additionalProperties = false;
    return out;
  }
  throw new SchemaError(["toJsonSchema: unsupported spec"]);
}

function exampleValue(spec) {
  if (typeof spec === "string") {
    const tk = parseToken(spec);
    switch (tk.base) {
      case "str":
        return tk.max !== undefined ? `string (max ${tk.max} characters)` : "string";
      case "int":
        return tk.min !== undefined ? Math.round(tk.min) : 0;
      case "num":
        return tk.min !== undefined ? tk.min : 0;
      case "bool":
        return true;
      case "enum":
        return tk.enum.join("|");
      case "iso-datetime":
        return "2026-10-14T19:30:00+05:30";
      case "date":
        return "2026-10-14";
      case "handle":
        return "handle";
      case "id":
        return "id";
      case "url":
        return "https://example.com/";
      case "pattern":
        return `string matching /${tk.source}/`;
      case "obj":
        return {};
      default:
        return null;
    }
  }
  if (Array.isArray(spec)) return [exampleValue(spec[0])];
  const out = {};
  for (const [rawKey, sub] of Object.entries(spec)) {
    if (rawKey === "*") {
      out["<key>"] = exampleValue(sub);
      continue;
    }
    const optional = rawKey.endsWith("?");
    out[optional ? rawKey.slice(0, -1) : rawKey] = exampleValue(sub);
  }
  return out;
}

export function toJsonSchema(spec, dialect) {
  if (dialect === "prompt") return JSON.stringify(exampleValue(spec), null, 2);
  if (dialect !== "openai" && dialect !== "gemini") throw new SchemaError([`toJsonSchema: unknown dialect ${dialect}`]);
  return toSchema(spec, dialect);
}

// ---------------------------------------------------------------------------------------
// Shared tokens

export const AGENT = `enum[${AGENT_NAMES.join("|")}]`;
export const PROVIDER = `enum[${PROVIDER_NAMES.join("|")}]`;
export const FORMAT = "enum[image|carousel|reel]";
export const LANGUAGE = "enum[hi|en]";
export const MODE = "enum[approve_first|autopilot]";
export const DOW = "enum[mon|tue|wed|thu|fri|sat|sun]";
export const CRON = "pattern:^\\S+(?: \\S+){4}$";
export const HHMM = "pattern:^(?:[01]\\d|2[0-3]):[0-5]\\d$";
export const MONTH_KEY = "pattern:^\\d{4}-(?:0[1-9]|1[0-2])$";
export const WEEK_ID = "pattern:^\\d{4}-W(?:0[1-9]|[1-4]\\d|5[0-3])$";
export const HEX_COLOR = "pattern:^#[0-9a-fA-F]{6}$";
export const SECRET_NAME = "pattern:^[A-Z][A-Z0-9_]{2,60}$";
export const DIGITS = "pattern:^\\d*$";
// design §12 writes ^#[\p{L}\p{N}_]{2,40}$; \p{M} is added because Devanagari matras and the
// virama are combining marks, so '#रिश्ता' would otherwise be rejected (RishtaPatra posts in Hindi).
export const HASHTAG = "pattern:^#[\\p{L}\\p{M}\\p{N}_]{2,40}$";
export const SHA256 = "pattern:^[0-9a-f]{64}$";

export const DRAFT_STATUSES = ["written", "rendered", "queued", "rework", "blocked", "published", "failed", "rejected", "expired"];
export const SLOT_STATUSES = ["planned", "written", "rendered", "queued", "rework", "blocked", "published", "rejected", "expired", "failed", "dropped"];
export const IDEA_STATUSES = ["open", "scheduled", "used", "dropped"];
export const TERMINAL_DRAFT_STATUSES = ["published", "failed", "rejected", "expired", "blocked"];
export const TOKEN_STATES = ["ok", "expiring", "invalid", "unknown", "not_configured"];
export const STATUS_FLAG = "pattern:^(?:budget_warn|budget_exhausted|token_invalid:[a-z0-9_.]{1,30}|token_expiring:[a-z0-9_.]{1,30}|render_failed|provider_down:(?:anthropic|gemini|openai)|media_branch_missing|publish_failed:[a-z0-9][a-z0-9_.-]{0,119})$";

// ---------------------------------------------------------------------------------------
// §4.1 config.json (+ N3 features.reels, D5 altTextMax/appScopedId, D9 expireAfterHours, §12)

// acceptsTemperature:false = the model returns 400 on a non-default temperature, so the adapter omits
// the field (claude-sonnet-5-5, see providers.anthropic.priceNote). reasoning = the cheapest thinking
// level the model accepts: Gemini thinkingConfig.thinkingLevel, OpenAI reasoning_effort (FEAT-102 findings).
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_PRICE_SPEC = {
  inputPerMTok: "num[0..10000]",
  outputPerMTok: "num[0..10000]",
  maxOutputTokens: "int[1..1000000]",
  "acceptsTemperature?": "bool",
  "reasoning?": `enum[${REASONING_LEVELS.join("|")}]`,
};
const PROVIDER_SPEC = {
  enabled: "bool",
  secret: SECRET_NAME,
  endpoint: "url",
  "apiVersion?": "str",
  models: { "*": MODEL_PRICE_SPEC },
  priceSource: "str",
  pricesVerifiedAt: "date",
  // Free text copied from the official page beside the price (scheduled changes, tiers); never parsed.
  "priceNote?": "str<=500",
};

export const CONFIG_SPEC = {
  version: "int[1..1]",
  company: { name: "str", nameDevanagari: "str", owner: "str", ownerGithub: "str", timezone: "enum[Asia/Kolkata]" },
  site: { url: "url", basePath: "pattern:^/(?:[\\w.-]+/)*$" },
  repo: { owner: "str", name: "str", branch: "str", mediaBranch: "str" },
  schedule: { engineCron: CRON, engineLabel: "str", publisherCron: CRON, publisherLabel: "str", actionsDelayNote: "str" },
  budget: { monthlyUsd: "num[1..1000]", warnAtPct: "int[1..100]", hardStop: "bool" },
  features: { reels: "bool" },
  providers: { anthropic: PROVIDER_SPEC, gemini: PROVIDER_SPEC, openai: PROVIDER_SPEC },
  defaults: {
    leadDays: "int[0..30]",
    backlogWeeks: "int[1..12]",
    maxReworkLoops: "int[0..5]",
    maxPublishAttempts: "int[1..10]",
    minGapHours: "int[0..168]",
    lateAfterHours: "int[0..168]",
    expireAfterHours: "int[1..720]",
    hashtagCap: "int[0..30]",
    captionMax: "int[1..2200]",
    altTextMax: "int[1..200]",
  },
  ig: { host: "url", version: "pattern:^v\\d+\\.\\d+$", pollIntervalMs: "int[100..60000]", pollMaxMs: "int[1000..3600000]" },
  pages: [
    {
      handle: "handle",
      prefix: "pattern:^[a-z]{2,4}$",
      displayName: "str",
      brand: "str",
      igUserId: DIGITS,
      "appScopedId?": DIGITS,
      tokenSecret: SECRET_NAME,
      mode: MODE,
      modeChangedAt: "iso-datetime",
      modeChangedBy: "str",
      languages: [LANGUAGE, { min: 1, max: 2 }],
      formats: [FORMAT, { min: 1, max: 3 }],
      brandColor: HEX_COLOR,
      cadence: { slots: [{ dow: DOW, time: HHMM, format: FORMAT }, { min: 1, max: 7 }] },
    },
    { min: 1 },
  ],
};
SPEC_RULES.set(CONFIG_SPEC, configRules);

// §4.2 roster.json
export const ROSTER_SPEC = {
  version: "int[1..1]",
  agents: [
    {
      name: AGENT,
      "title?": "str",
      group: "enum[leadership|studio|operations]",
      kind: "enum[llm|deterministic]",
      "provider?": PROVIDER,
      "model?": "str",
      "fallback?": [PROVIDER, { max: 2 }],
      "temperature?": "num[0..2]",
      "maxOutputTokens?": "int[1..1000000]",
      charter: "str",
      schedule: "enum[daily|hourly|weekly-monday|weekly-sunday|monthly-1st]",
      never: ["str", { min: 1 }],
      "enabled?": "bool",
    },
    { min: 8, max: 8 },
  ],
};
SPEC_RULES.set(ROSTER_SPEC, rosterRules);

// §4.4 ideas.jsonl
export const IDEA_SPEC = {
  id: "id",
  page: "handle",
  title: "str<=120",
  angle: "str",
  "hook?": "str",
  format: FORMAT,
  language: LANGUAGE,
  facts: ["id"],
  status: `enum[${IDEA_STATUSES.join("|")}]`,
  attempts: "int[0..100]",
  createdAt: "iso-datetime",
  by: "str",
  runId: "id",
};

// §4.5 calendar.json (M5 lifecycle)
export const SLOT_SPEC = {
  slotId: "id",
  page: "handle",
  at: "iso-datetime",
  format: FORMAT,
  "ideaId?": "id",
  "draftId?": "id",
  status: `enum[${SLOT_STATUSES.join("|")}]`,
  "reason?": "str",
};
export const CALENDAR_SPEC = { generatedAt: "iso-datetime", horizonDays: "int[1..90]", slots: [SLOT_SPEC] };

// §4.6 drafts/<id>/draft.json (M5 enums, D9)
export const MEDIA_ITEM_SPEC = {
  kind: "enum[image|video]",
  path: "str",
  bytes: "int[1..1000000000]",
  width: "int[1..10000]",
  height: "int[1..10000]",
  sha256: SHA256,
  rawUrl: "url",
  pagesUrl: "url",
  "durationSec?": "num[0..600]",
};
export const PUBLISH_ATTEMPT_SPEC = {
  at: "iso-datetime",
  ok: "bool",
  stage: "enum[preflight|container|status|publish|rate_limit|skip]",
  "code?": "int",
  "message?": "str",
  "mediaUrlUsed?": "enum[raw|pages]",
  "runId?": "id",
};
export const ARTWORK_SPEC = { headline: "str<=60", subline: "str<=110", facts: ["str<=70", { max: 3 }], footer: "str", "variant?": "enum[A|B|C]" };
// Designer refusal (design §10 guards, §11 "Render" row; FEAT-106): the draft stays `written` and carries why.
export const RENDER_ERROR_CODES = ["overflow", "missing_glyphs", "text_floor", "contrast", "media_spec", "render_failed"];
export const RENDER_ERROR_SPEC = { code: `enum[${RENDER_ERROR_CODES.join("|")}]`, "detail?": "str<=1000", at: "iso-datetime" };
export const SLIDE_SPEC = { heading: "str<=40", body: "str<=160", altText: "str<=200" };
export const REEL_SPEC = { style: "enum[kinetic|capture]", durationSec: "num[1..90]", scenes: [{ text: "str<=60", seconds: "num[1..10]" }, { min: 3, max: 6 }] };

export const DRAFT_SPEC = {
  id: "id",
  page: "handle",
  ideaId: "id",
  slotId: "id",
  slotAt: "iso-datetime",
  format: FORMAT,
  language: LANGUAGE,
  status: `enum[${DRAFT_STATUSES.join("|")}]`,
  revision: "int[1..100]",
  reworkCount: "int[0..10]",
  mock: "bool",
  createdAt: "iso-datetime",
  updatedAt: "iso-datetime",
  by: "str",
  runId: "id",
  caption: "str<=2200",
  hashtags: [HASHTAG, { max: 30 }],
  altText: "str<=200",
  "altTexts?": ["str<=200", { max: 10 }],
  "artwork?": ARTWORK_SPEC,
  "slides?": [SLIDE_SPEC, { min: 2, max: 10 }],
  "reel?": REEL_SPEC,
  factsUsed: [{ factId: "id", quote: "str" }],
  "writerNote?": "str",
  "designNote?": "str",
  "renderError?": RENDER_ERROR_SPEC,
  media: [MEDIA_ITEM_SPEC, { max: 10 }],
  publishAttempts: [PUBLISH_ATTEMPT_SPEC],
  "qaRef?": "str",
  // QA's reasons[] kept on a failed draft so the Writer's rework task can read them (§4.7, FEAT-104).
  "qaReasons?": ["str"],
};

// §4.7 drafts/<id>/qa.json
export const QA_CHECK_IDS = ["caption_length", "hashtags", "disclaimer", "forbidden", "numbers_sourced", "alt_text", "language", "media_spec", "links", "emoji", "duplicate", "brand_lint"];
export const QA_CHECK_SPEC = { id: `enum[${QA_CHECK_IDS.join("|")}]`, ok: "bool", "detail?": "str" };
export const QA_SPEC = {
  draftId: "id",
  revision: "int[1..100]",
  at: "iso-datetime",
  passed: "bool",
  deterministic: { passed: "bool", checks: [QA_CHECK_SPEC, { min: QA_CHECK_IDS.length, max: QA_CHECK_IDS.length }] },
  "model?": {
    provider: "enum[anthropic|gemini|openai|mock]",
    model: "str",
    verdict: "enum[pass|fail]",
    toneScore: "int[1..5]",
    claims: [{ claim: "str", "factId?": "id", ok: "bool" }],
    "reasons?": ["str"],
    "notes?": "str",
  },
  reasons: ["str"],
  "mock?": "bool",
  "runId?": "id",
};

// §4.8 admin-owned records (M5: approvals carry revision)
export const APPROVAL_SPEC = { draftId: "id", decision: "enum[approve|reject]", revision: "int[1..100]", at: "iso-datetime", by: "str", "reason?": "str<=500" };
SPEC_RULES.set(APPROVAL_SPEC, approvalRules);

export const EDIT_SPEC = {
  draftId: "id",
  baseRevision: "int[1..100]",
  caption: "str<=2200",
  hashtags: [HASHTAG, { max: 30 }],
  altText: "str<=200",
  "altTexts?": ["str<=200", { max: 10 }],
  at: "iso-datetime",
  by: "str",
  checks: { passed: "bool", checks: [QA_CHECK_SPEC] },
};

export const OVERRIDE_SPEC = { draftId: "id", slotAt: "iso-datetime", at: "iso-datetime", by: "str" };

// §4.11 feedback.jsonl
export const FEEDBACK_SPEC = {
  at: "iso-datetime",
  by: "str",
  kind: "enum[reject|note|praise]",
  "page?": "handle",
  "draftId?": "id",
  text: "str<=1000",
  tags: ["str<=40", { max: 10 }],
};

// §4.9 published.jsonl
export const PUBLISHED_SPEC = {
  draftId: "id",
  page: "handle",
  igMediaId: "str",
  permalink: "url",
  publishedAt: "iso-datetime",
  slotAt: "iso-datetime",
  late: "bool",
  mode: MODE,
  "approvedBy?": "str",
  "approvedAt?": "iso-datetime",
  qaRevision: "int[1..100]",
  format: FORMAT,
  mediaUrlUsed: "enum[raw|pages]",
  runId: "id",
  "dryRun?": "bool",
};

// §4.10 metrics/YYYY-MM.jsonl (Phase 2)
export const METRIC_SPEC = {
  draftId: "id",
  igMediaId: "str",
  page: "handle",
  at: "iso-datetime",
  window: "enum[48h|7d]",
  metrics: { reach: "int", views: "int", likes: "int", comments: "int", saved: "int", shares: "int" },
  source: "enum[ig-insights]",
  "raw?": "obj",
  "runId?": "id",
};

// §4.13 usage/YYYY-MM.jsonl
export const USAGE_SPEC = {
  at: "iso-datetime",
  runId: "id",
  agent: AGENT,
  "page?": "handle",
  provider: "enum[anthropic|gemini|openai|mock]",
  model: "str",
  inputTokens: "int[0..100000000]",
  outputTokens: "int[0..100000000]",
  costUsd: "num[0..100000]",
  ms: "int[0..86400000]",
  ok: "bool",
  "error?": "str",
  mock: "bool",
};

// §4.14 runs/YYYY-MM.jsonl
export const RUN_AGENT_SPEC = { name: AGENT, ok: "bool", ms: "int[0..86400000]", calls: "int[0..10000]", costUsd: "num[0..100000]", "note?": "str", "skipped?": "str" };
export const RUN_SPEC = {
  id: "id",
  workflow: "pattern:^[a-z][a-z0-9-]{1,40}$",
  trigger: "enum[schedule|dispatch|local]",
  startedAt: "iso-datetime",
  endedAt: "iso-datetime",
  ok: "bool",
  agents: [RUN_AGENT_SPEC],
  changed: ["str"],
  errors: ["str"],
  budgetUsedUsd: "num[0..100000]",
  "dryRun?": "bool",
};

// §4.12 status.json (M9 lastRuns ≤ 20)
export const STATUS_SPEC = {
  updatedAt: "iso-datetime",
  "lastRun?": { id: "id", workflow: "pattern:^[a-z][a-z0-9-]{1,40}$", ok: "bool", at: "iso-datetime" },
  lastRuns: [RUN_SPEC, { max: 20 }],
  queue: { "*": "int[0..10000]" },
  blocked: { "*": "int[0..10000]" },
  budget: { month: MONTH_KEY, usedUsd: "num[0..100000]", limitUsd: "num[1..1000]", exhausted: "bool", "warn?": "bool" },
  pages: {
    "*": {
      mode: MODE,
      tokenState: `enum[${TOKEN_STATES.join("|")}]`,
      "tokenExpiresAt?": "iso-datetime",
      "lastPublishedAt?": "iso-datetime",
    },
  },
  flags: [STATUS_FLAG, { max: 50 }],
};

// §3.4 tokens.json (Phase 2; non-secret metadata only)
export const TOKENS_SPEC = {
  updatedAt: "iso-datetime",
  pages: {
    "*": {
      "username?": "str",
      "expiresAt?": "iso-datetime",
      "refreshedAt?": "iso-datetime",
      "daysLeft?": "int",
      state: `enum[${TOKEN_STATES.join("|")}]`,
    },
  },
};

// §5 HR (Phase 2): hr/proposals/YYYY-MM.json and hr/decisions.jsonl (D13)
export const HR_PROPOSAL_SPEC = {
  month: MONTH_KEY,
  at: "iso-datetime",
  runId: "id",
  status: "enum[proposed]",
  reviewPath: "str",
  review: [{ agent: AGENT, verdict: "enum[keep|tune|swap]", evidence: "obj", proposal: "str" }],
  changes: [{ agent: AGENT, field: "enum[model|provider|temperature|charterAppend]", from: "any", to: "any", why: "str" }],
};
export const HR_DECISION_SPEC = {
  month: MONTH_KEY,
  proposal: "str",
  decision: "enum[apply|dismiss]",
  at: "iso-datetime",
  by: "str",
  "reason?": "str<=500",
  "applied?": ["str"],
};

// Spec lookup by state file kind (used by state.js helpers and the admin).
export const SPECS = {
  config: CONFIG_SPEC,
  roster: ROSTER_SPEC,
  idea: IDEA_SPEC,
  calendar: CALENDAR_SPEC,
  draft: DRAFT_SPEC,
  qa: QA_SPEC,
  approval: APPROVAL_SPEC,
  edit: EDIT_SPEC,
  override: OVERRIDE_SPEC,
  feedback: FEEDBACK_SPEC,
  published: PUBLISHED_SPEC,
  metric: METRIC_SPEC,
  usage: USAGE_SPEC,
  run: RUN_SPEC,
  status: STATUS_SPEC,
  tokens: TOKENS_SPEC,
  hrProposal: HR_PROPOSAL_SPEC,
  hrDecision: HR_DECISION_SPEC,
};
