// brand.md parser and validator (design.md §4.3, §6; review M3/N12; plan D8/D12).
// Browser-safe: imports only ./schema.js (byte-copied into dist/admin/lib/ at build time).
//
// File shape (one file per page under company/brands/):
//   ---                       front matter: `key: value` lines; value = null | "quoted" | [a, "b"] | text
//   handle: rishtapatra
//   ---
//   ## Voice                  bullets
//   ## Facts                  | id | fact | source | status |      status ∈ confirmed | source-only | disputed
//   ## Pricing                | sku | price | source |
//   ## Disclaimers            - trigger: always | word | word      then one or more `require: a | b` lines
//   ## Forbidden              - `regex`  (one per line, compiled with flags iu)
//   ## Tokens                 - colour <name>: #rrggbb — <source>   also font/Devanagari/logo/gradient/note
//   ## Allowed domains        - host
//   ## Formats                - <format>: template <name> — <notes>
//                             - capture: verified YYYY-MM-DD — <notes>, then indented `- `/path` — <source>` bullets:
//                               the public product paths a capture reel may record (FEAT-201, plan D17)
// Every `source` cell is `<repo-folder>/<path>:<range>(,<range>)*` joined by ' ; ' (SOURCE_RE).
import { SOURCE_RE, parseSource } from "./schema.js";

export const FRONT_MATTER_KEYS = ["handle", "name", "nameDevanagari", "site", "contact", "languages", "emoji", "allowedDevanagari", "sourceRepo", "sourceRevision", "sourceVerifiedAt"];
export const BRAND_SECTIONS = ["Voice", "Facts", "Pricing", "Disclaimers", "Forbidden", "Tokens", "Allowed domains", "Formats"];
export const FACT_STATUSES = ["confirmed", "source-only", "disputed"];
export const EMOJI_POLICIES = ["none", "sparse"];
const LANGUAGES = ["hi", "en"];
const HANDLE_RE = /^[a-z0-9_.]{1,30}$/;
const FACT_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,119}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_KINDS = ["colour", "color", "font", "devanagari", "logo", "gradient", "note"];

export class BrandError extends Error {
  constructor(errors, file = "brand.md") {
    super(`${file}: ${errors.length} error${errors.length === 1 ? "" : "s"} — ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; …" : ""}`);
    this.name = "BrandError";
    this.errors = errors;
    this.file = file;
  }
}

function stripTicks(s) {
  const t = s.trim();
  return t.length >= 2 && t.startsWith("`") && t.endsWith("`") ? t.slice(1, -1).trim() : t;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

// Splits "a, "b, c", d" on commas outside quotes.
function splitList(s) {
  const out = [];
  let cur = "";
  let quote = null;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "" || out.length) out.push(cur);
  return out.map(unquote).filter((v, i, arr) => !(v === "" && arr.length === 1));
}

export function parseFrontMatterValue(raw) {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return v === "" ? "" : null;
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : splitList(inner);
  }
  return unquote(v);
}

function parseFrontMatter(lines) {
  const out = {};
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new BrandError([`front matter: cannot parse line ${JSON.stringify(line)}`]);
    out[m[1]] = parseFrontMatterValue(m[2]);
  }
  return out;
}

function splitSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of body) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }
  return sections;
}

function tableRows(lines) {
  const rows = lines.filter((l) => l.trim().startsWith("|")).map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  // drop the header row and the |---| separator row
  return rows.filter((cells, i) => !(i === 0) && !cells.every((c) => /^:?-{3,}:?$/.test(c)));
}

function bullets(lines) {
  return lines.filter((l) => /^\s*[-*] /.test(l)).map((l) => l.replace(/^\s*[-*] /, "").trim());
}

function parseVoice(lines) {
  return { bullets: bullets(lines), text: lines.join("\n").trim() };
}

function parseFacts(lines) {
  return tableRows(lines).map((cells) => ({ id: cells[0] || "", fact: cells[1] || "", source: stripTicks(cells[2] || ""), status: (cells[3] || "").replace(/\*/g, "").trim(), cells: cells.length }));
}

function parsePricing(lines) {
  return tableRows(lines).map((cells) => ({ sku: cells[0] || "", price: cells[1] || "", source: stripTicks(cells[2] || ""), cells: cells.length }));
}

const ALT_SEP = " | ";

function parseDisclaimers(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    let m;
    if ((m = /^- trigger:\s*(.+)$/.exec(line))) {
      const t = m[1].trim();
      cur = { trigger: t === "always" ? "always" : t.split(ALT_SEP).map((s) => s.trim()).filter(Boolean), fragments: [] };
      out.push(cur);
    } else if ((m = /^require:\s*(.+)$/.exec(line))) {
      if (cur) cur.fragments.push(m[1].split(ALT_SEP).map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

function parseForbidden(lines) {
  return bullets(lines).map(stripTicks).filter(Boolean);
}

function parseTokens(lines) {
  const tokens = { colours: {}, fonts: {}, devanagariFamily: null, logo: null, gradients: {}, notes: [], sources: {}, entries: [] };
  for (const b of bullets(lines)) {
    const colon = b.indexOf(":");
    if (colon < 0) continue;
    const head = b.slice(0, colon).trim();
    let rest = b.slice(colon + 1).trim();
    let source = null;
    const dash = rest.lastIndexOf(" — ");
    if (dash >= 0) {
      source = stripTicks(rest.slice(dash + 3));
      rest = rest.slice(0, dash).trim();
    }
    const [kindRaw, ...nameParts] = head.split(/\s+/);
    const kind = kindRaw.toLowerCase();
    const name = nameParts.join(" ");
    const entry = { kind: kind === "color" ? "colour" : kind, name, value: stripTicks(rest), source };
    tokens.entries.push(entry);
    const key = `${entry.kind}${name ? " " + name : ""}`;
    if (source) tokens.sources[key] = source;
    switch (entry.kind) {
      case "colour":
        tokens.colours[name] = entry.value;
        break;
      case "font":
        tokens.fonts[name] = entry.value;
        break;
      case "devanagari":
        tokens.devanagariFamily = entry.value;
        break;
      case "logo":
        tokens.logo = entry.value;
        break;
      case "gradient":
        tokens.gradients[name] = entry.value;
        break;
      case "note":
        tokens.notes.push(entry.value);
        break;
      default:
        break;
    }
  }
  return tokens;
}

function parseAllowedDomains(lines) {
  return bullets(lines).map(stripTicks).map((d) => d.toLowerCase()).filter(Boolean);
}

// ## Formats: top-level bullets `- <format>: template <name> — <notes>` plus, for reels (FEAT-201, plan D17),
// `- capture: verified YYYY-MM-DD — <notes>` followed by indented bullets, one public product path each:
//   `  - \`/kundali\` — shubhpatra/src/lib/routes.ts:12`   (path on the brand's allowed domain — source pointer)
// → { formats: { image: { template, notes }, … }, capture: { verifiedAt, notes, paths: [{ path, source }] } | null }
function parseFormats(lines) {
  const formats = {};
  let capture = null;
  let inCapture = false;
  for (const raw of lines) {
    const top = /^[-*] (.*)$/.exec(raw);
    const nested = /^\s+[-*] (.*)$/.exec(raw);
    if (top) {
      const b = top[1].trim();
      const m = /^([a-z]+):\s*(.*)$/.exec(b);
      inCapture = false;
      if (!m) continue;
      let rest = m[2].trim();
      if (m[1] === "capture") {
        inCapture = true;
        let verifiedAt = null;
        const v = /^verified\s+(\d{4}-\d{2}-\d{2})\s*(?:—\s*)?(.*)$/.exec(rest);
        if (v) {
          verifiedAt = v[1];
          rest = v[2].trim();
        }
        capture = { verifiedAt, notes: rest, paths: [] };
        continue;
      }
      let template = null;
      const t = /^template\s+`?([\w-]+)`?\s*(?:—\s*)?(.*)$/.exec(rest);
      if (t) {
        template = t[1];
        rest = t[2].trim();
      }
      formats[m[1]] = { template, notes: rest };
    } else if (nested && inCapture && capture) {
      const b = nested[1].trim();
      const dash = b.lastIndexOf(" — ");
      const path = stripTicks(dash >= 0 ? b.slice(0, dash) : b);
      const source = dash >= 0 ? stripTicks(b.slice(dash + 3)) : null;
      capture.paths.push({ path, source });
    }
  }
  return { formats, capture };
}

// parseBrand(markdown) → structured brand; throws BrandError only when the file has no front matter.
export function parseBrand(markdown, file = "brand.md") {
  const text = String(markdown).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== "---") throw new BrandError(["front matter: file must start with '---'"], file);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw new BrandError(["front matter: closing '---' missing"], file);
  const frontMatter = parseFrontMatter(lines.slice(1, end));
  const body = lines.slice(end + 1);
  const sections = splitSections(body);
  const get = (name) => sections.get(name) || [];
  const { formats, capture } = parseFormats(get("Formats"));
  return {
    file,
    frontMatter,
    sectionsPresent: [...sections.keys()],
    voice: parseVoice(get("Voice")),
    facts: parseFacts(get("Facts")),
    pricing: parsePricing(get("Pricing")),
    disclaimers: parseDisclaimers(get("Disclaimers")),
    forbidden: parseForbidden(get("Forbidden")),
    tokens: parseTokens(get("Tokens")),
    allowedDomains: parseAllowedDomains(get("Allowed domains")),
    formats,
    capture,
  };
}

function checkSource(cell, where, errors) {
  if (typeof cell !== "string" || cell === "") return void errors.push(`${where}: source missing`);
  if (!SOURCE_RE.test(cell)) return void errors.push(`${where}: source does not match SOURCE_RE: ${JSON.stringify(cell)}`);
  try {
    parseSource(cell);
  } catch (e) {
    errors.push(`${where}: ${e.message}`);
  }
}

// validateBrand(parsed) → errors[] ('' when valid). Pure; never throws for content errors.
export function validateBrand(parsed) {
  const errors = [];
  const fm = parsed.frontMatter || {};
  for (const key of FRONT_MATTER_KEYS) if (!(key in fm)) errors.push(`front matter: ${key} missing`);
  if ("handle" in fm && !HANDLE_RE.test(String(fm.handle))) errors.push(`front matter: handle must match ^[a-z0-9_.]{1,30}$`);
  if ("name" in fm && !fm.name) errors.push("front matter: name is empty");
  if ("site" in fm) {
    try {
      const u = new URL(fm.site);
      if (u.protocol !== "https:") errors.push("front matter: site must be https");
    } catch {
      errors.push("front matter: site is not a URL");
    }
  }
  if ("languages" in fm) {
    if (!Array.isArray(fm.languages) || fm.languages.length === 0 || fm.languages.some((l) => !LANGUAGES.includes(l))) errors.push(`front matter: languages must be a non-empty list from ${LANGUAGES.join("|")}`);
  }
  if ("emoji" in fm && !EMOJI_POLICIES.includes(fm.emoji)) errors.push(`front matter: emoji must be one of ${EMOJI_POLICIES.join("|")}`);
  if ("allowedDevanagari" in fm && fm.allowedDevanagari !== null && !Array.isArray(fm.allowedDevanagari)) errors.push("front matter: allowedDevanagari must be null (any) or a list");
  if ("sourceRepo" in fm && !/^[\w.-]+$/.test(String(fm.sourceRepo))) errors.push("front matter: sourceRepo must be a sibling folder name");
  if ("sourceVerifiedAt" in fm && fm.sourceVerifiedAt !== null && !DATE_RE.test(String(fm.sourceVerifiedAt))) errors.push("front matter: sourceVerifiedAt must be null or YYYY-MM-DD");

  for (const name of BRAND_SECTIONS) if (!parsed.sectionsPresent.includes(name)) errors.push(`section '## ${name}' missing`);

  if (parsed.facts.length === 0) errors.push("Facts: no rows");
  const ids = new Set();
  parsed.facts.forEach((f, i) => {
    const where = `Facts row ${i + 1}${f.id ? ` (${f.id})` : ""}`;
    if (f.cells !== 4) errors.push(`${where}: expected 4 cells | id | fact | source | status |`);
    if (!FACT_ID_RE.test(f.id)) errors.push(`${where}: bad id`);
    if (ids.has(f.id)) errors.push(`${where}: duplicate id`);
    ids.add(f.id);
    if (!f.fact) errors.push(`${where}: fact text missing`);
    checkSource(f.source, where, errors);
    if (!FACT_STATUSES.includes(f.status)) errors.push(`${where}: status must be one of ${FACT_STATUSES.join("|")}, got ${JSON.stringify(f.status)}`);
  });

  parsed.pricing.forEach((p, i) => {
    const where = `Pricing row ${i + 1}${p.sku ? ` (${p.sku})` : ""}`;
    if (p.cells !== 3) errors.push(`${where}: expected 3 cells | sku | price | source |`);
    if (!p.sku) errors.push(`${where}: sku missing`);
    checkSource(p.source, where, errors);
  });

  parsed.disclaimers.forEach((d, i) => {
    const where = `Disclaimers entry ${i + 1}`;
    if (d.trigger !== "always" && (!Array.isArray(d.trigger) || d.trigger.length === 0)) errors.push(`${where}: trigger missing`);
    if (d.fragments.length === 0) errors.push(`${where}: needs at least one require line`);
    d.fragments.forEach((g, j) => {
      if (g.length === 0) errors.push(`${where}: require group ${j + 1} is empty`);
    });
  });

  parsed.forbidden.forEach((src, i) => {
    try {
      new RegExp(src, "iu");
    } catch (e) {
      errors.push(`Forbidden line ${i + 1}: regex does not compile with flags iu: ${e.message}`);
    }
  });

  const tk = parsed.tokens;
  for (const [name, value] of Object.entries(tk.colours)) if (!HEX_RE.test(value)) errors.push(`Tokens colour ${name}: expected #rrggbb, got ${JSON.stringify(value)}`);
  for (const e of tk.entries) {
    if (!TOKEN_KINDS.includes(e.kind)) errors.push(`Tokens: unknown kind ${JSON.stringify(e.kind)} (expected ${TOKEN_KINDS.join("|")})`);
    if (["colour", "font", "devanagari", "logo", "gradient"].includes(e.kind)) {
      if (!e.value) errors.push(`Tokens ${e.kind} ${e.name}: value missing`);
      checkSource(e.source, `Tokens ${e.kind}${e.name ? " " + e.name : ""}`, errors);
    } else if (e.source) checkSource(e.source, `Tokens ${e.kind}`, errors);
  }
  if (Object.keys(tk.colours).length === 0) errors.push("Tokens: no colours");
  if (!tk.logo) errors.push("Tokens: logo missing");
  const needsDevanagari = fm.allowedDevanagari === null || (Array.isArray(fm.allowedDevanagari) && fm.allowedDevanagari.length > 0);
  if (needsDevanagari && !tk.devanagariFamily) errors.push("Tokens: brand allows Devanagari but names no Devanagari family (review N12)");

  if (parsed.allowedDomains.length === 0) errors.push("Allowed domains: empty");
  parsed.allowedDomains.forEach((d) => {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) errors.push(`Allowed domains: ${JSON.stringify(d)} is not a bare host`);
  });
  if (Object.keys(parsed.formats).length === 0) errors.push("Formats: empty");
  // Reel capture list (FEAT-201): the reel format needs it; every path is a site-relative path (optionally with
  // a #fragment) that stays on the brand's own domain, carries a source pointer, and the list is dated.
  const cap = parsed.capture;
  if (parsed.formats.reel && !cap) errors.push("Formats: reel listed but no `capture:` list of public product paths");
  if (cap) {
    if (!cap.verifiedAt) errors.push("Formats capture: missing 'verified YYYY-MM-DD'");
    else if (!DATE_RE.test(cap.verifiedAt)) errors.push(`Formats capture: verified date ${JSON.stringify(cap.verifiedAt)} is not YYYY-MM-DD`);
    if (cap.paths.length === 0) errors.push("Formats capture: no paths");
    const seen = new Set();
    cap.paths.forEach((p, i) => {
      const where = `Formats capture path ${i + 1}${p.path ? ` (${p.path})` : ""}`;
      if (!/^\/(?:[\w.~-]+\/?)*(?:#[\w-]+)?$/.test(p.path)) errors.push(`${where}: expected a site-relative path like /kundali or /#pricing`);
      if (seen.has(p.path)) errors.push(`${where}: duplicate path`);
      seen.add(p.path);
      checkSource(p.source, where, errors);
    });
  }
  return errors;
}

// capturePaths(parsed) → ['/', '/kundali', …] — the public product paths a capture reel may record (FEAT-201).
export function capturePaths(parsed) {
  return parsed && parsed.capture ? parsed.capture.paths.map((p) => p.path) : [];
}

export function assertBrand(parsed) {
  const errors = validateBrand(parsed);
  if (errors.length) throw new BrandError(errors, parsed.file);
  return parsed;
}

// Facts the Writer and QA may use: everything except status `disputed` (design §4.3, P1-04).
export function usableFacts(parsed) {
  return parsed.facts.filter((f) => f.status !== "disputed");
}

// Compiled forbidden patterns (flags iu).
export function forbiddenRegexes(parsed) {
  return parsed.forbidden.map((src) => new RegExp(src, "iu"));
}

// Number tokens that may appear in a caption (QA `numbers_sourced` allow-list, FEAT-104): every digit
// run in the usable facts, the pricing skus and prices, both as written ('2,599') and plain ('2599').
export function factNumbers(parsed) {
  const out = new Set();
  const add = (text) => {
    for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const raw = m[0].replace(/,$/, "");
      out.add(raw);
      out.add(raw.replace(/,/g, ""));
    }
  };
  for (const f of usableFacts(parsed)) add(f.fact);
  for (const p of parsed.pricing) {
    add(p.sku);
    add(p.price);
  }
  return [...out];
}

// Every source pointer in the file with where it came from: [{ where, id, cell, pointers: parseSource(cell) }].
export function sourcePointers(parsed, { tokens = true } = {}) {
  const out = [];
  const push = (where, id, cell) => {
    if (!cell || !SOURCE_RE.test(cell)) return;
    out.push({ where, id, cell, pointers: parseSource(cell) });
  };
  parsed.facts.forEach((f) => push("Facts", f.id, f.source));
  parsed.pricing.forEach((p) => push("Pricing", p.sku, p.source));
  if (tokens) parsed.tokens.entries.forEach((e) => push("Tokens", `${e.kind}${e.name ? " " + e.name : ""}`, e.source));
  return out;
}

// Returns the markdown with front matter `sourceVerifiedAt` set to `date` (YYYY-MM-DD); adds the key when absent.
export function stampSourceVerifiedAt(markdown, date) {
  if (!DATE_RE.test(date)) throw new BrandError([`stamp: date must be YYYY-MM-DD, got ${JSON.stringify(date)}`]);
  const text = String(markdown).replace(/^\uFEFF/, "");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (lines[0].trim() !== "---" || end < 0) throw new BrandError(["stamp: no front matter"]);
  let done = false;
  for (let i = 1; i < end; i++) {
    if (/^sourceVerifiedAt\s*:/.test(lines[i])) {
      lines[i] = `sourceVerifiedAt: ${date}`;
      done = true;
    }
  }
  if (!done) lines.splice(end, 0, `sourceVerifiedAt: ${date}`);
  return lines.join(nl);
}
