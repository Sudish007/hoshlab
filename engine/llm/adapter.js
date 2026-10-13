// The one interface every LLM provider implements (design.md §7, review M7, plan D10).
//
//   complete({ system, user, spec, dialect, maxOutputTokens, temperature, timeoutMs, fetchImpl,
//              model, apiKey, endpoint, apiVersion, agent, reasoning, thinkingBudget })
//     → { text, json | null, usage: { inputTokens, outputTokens }, model, provider, ms, raw: { status, id } }
//
//   system          the envelope's system text (charter + generated house rules + context), see prompt.js
//   user            the task JSON as a string
//   spec            the agent's OUTPUT_SPEC in the assertShape DSL; each adapter converts it with
//                   toJsonSchema(spec, <its dialect>) — 'prompt' (Anthropic), 'gemini', 'openai'
//   maxOutputTokens the roster value (4000 / 2000), also the budget estimate's output guess
//   temperature     a finite number, or undefined to omit the field (models that return 400 on a
//                   non-default temperature carry acceptsTemperature:false in config.json)
//   reasoning       optional config.providers.<p>.models.<m>.reasoning: Gemini → thinkingConfig.thinkingLevel,
//                   OpenAI → reasoning_effort; Anthropic ignores it (adaptive thinking is its default)
//   thinkingBudget optional Gemini 2.5 integer control → thinkingConfig.thinkingBudget; models without it omit it
//   timeoutMs       AbortController timeout (default DEFAULT_TIMEOUT_MS)
//   fetchImpl       injected fetch (tests pass a fake; tests/helpers.js throws on the global one)
//   apiKey          the provider secret — sent in a header only, never in a URL, an Error or a log line
//
// Every adapter also exports `provider` (its name) and
//   listModels({ endpoint, apiKey, apiVersion, fetchImpl, timeoutMs }) → string[] of model ids
// which engine/commands/check-models.js uses.
//
// Failures are LlmError instances: `retryable` follows classify() — network errors, 408, 429 and
// 5xx may be retried / failed over by the router; 400, 401, 403 and 404 fall back immediately.
// A 429 carries `retryAfterMs` when the server said how long to wait (the Retry-After header in seconds or as
// an HTTP date, or Gemini's error.details[] RetryInfo.retryDelay such as "22s"); null otherwise. The router
// honours it (polish-gemini). The message is scrubbed with the api key, so it may be logged and stored in usage.jsonl.
import { scrub } from "../lib/log.js";

export const DEFAULT_TIMEOUT_MS = 120000;
export const RETRYABLE_STATUSES = [408, 429];
export const NON_RETRYABLE_STATUSES = [400, 401, 403, 404];

export class LlmError extends Error {
  // new LlmError({ provider, status, message, retryable?, secrets?, kind?, id?, retryAfterMs? })
  constructor({ provider, status = 0, message, retryable, secrets = [], kind, id = null, retryAfterMs = null }) {
    super(scrub(message, secrets));
    this.name = "LlmError";
    this.provider = provider;
    this.status = status;
    this.kind = kind || (status === 0 ? "network" : "http");
    this.retryable = typeof retryable === "boolean" ? retryable : classify(status, this.kind === "network" ? this : null);
    this.id = id;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.round(retryAfterMs) : null;
  }
}

// retryAfterMs({ headers, json, nowMs }) → the server's wait in ms, or null when it gave none.
//   Retry-After: '22'              → 22000        (delay-seconds, RFC 9110 §10.2.3)
//   Retry-After: <HTTP-date>       → date − now   (0 when the date has passed)
//   Gemini: json.error.details[].retryDelay '22s' | '22.5s' | '0.5s' (google.rpc.RetryInfo) → 22000 | 22500 | 500
// The header wins when both exist; a value that does not parse counts as absent.
export function retryAfterMs({ headers, json, nowMs = Date.now() } = {}) {
  const header = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  if (typeof header === "string" && header.trim() !== "") {
    const s = header.trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const at = Date.parse(s);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  const details = json && json.error && Array.isArray(json.error.details) ? json.error.details : [];
  for (const d of details) {
    const delay = d && typeof d.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim()) : null;
    if (delay) return Math.round(Number(delay[1]) * 1000);
  }
  return null;
}

// classify(status, err) → true when the failure may be retried on the same provider:
// a network/timeout error (err given), HTTP 408, 429 or any 5xx. 400/401/403/404 and every other
// 4xx are final for that provider.
export function classify(status, err) {
  if (err) return true;
  if (RETRYABLE_STATUSES.includes(status)) return true;
  return status >= 500 && status <= 599;
}

// withTimeout(fetchImpl, ms) → a fetch that aborts after `ms` (AbortController). The rejection
// carries name 'TimeoutError' so callers can tell a timeout from a connection failure.
export function withTimeout(fetchImpl, ms) {
  if (typeof fetchImpl !== "function") throw new TypeError("adapter: fetchImpl must be a function");
  return async function fetchWithTimeout(url, init = {}) {
    if (!(ms > 0) || !Number.isFinite(ms)) return fetchImpl(url, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        const e = new Error(`timeout after ${ms} ms`);
        e.name = "TimeoutError";
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

// First balanced {…} block in `text` (string- and escape-aware), or null when there is none.
export function extractJsonBlock(text) {
  const s = String(text);
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// JSON.parse the whole text, else the first balanced block (models sometimes add prose or fences).
export function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    const block = extractJsonBlock(text);
    if (block === null) return null;
    try {
      return JSON.parse(block);
    } catch {
      return null;
    }
  }
}

function errorMessageFrom(json, text, res) {
  if (json && json.error) {
    const e = json.error;
    if (typeof e === "string") return e;
    if (e.message) return `${e.type || e.status || e.code || "error"}: ${e.message}`;
  }
  const snippet = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return snippet || res.statusText || "no response body";
}

// Shared transport: one request → { status, json, text, ms, headers }; throws LlmError on a
// network/timeout failure or a non-2xx status (message scrubbed with `secrets`).
export async function requestJson({ fetchImpl, url, init, timeoutMs = DEFAULT_TIMEOUT_MS, provider, secrets = [] }) {
  const started = Date.now();
  let res;
  try {
    res = await withTimeout(fetchImpl, timeoutMs)(url, init);
  } catch (err) {
    throw new LlmError({ provider, status: 0, kind: "network", message: `${provider}: ${err && err.name === "TimeoutError" ? err.message : `network error: ${(err && err.message) || String(err)}`}`, secrets });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    throw new LlmError({ provider, status: res.status, message: `${provider}: HTTP ${res.status} ${errorMessageFrom(json, text, res)}`, secrets, id: (json && json.id) || null, retryAfterMs: retryAfterMs({ headers: res.headers, json }) });
  }
  if (json === null) {
    throw new LlmError({ provider, status: res.status, retryable: true, kind: "http", message: `${provider}: HTTP ${res.status} with a non-JSON body`, secrets });
  }
  return { status: res.status, json, text, ms, headers: res.headers };
}

export function requireFields({ fetchImpl, model, apiKey, endpoint }, provider) {
  if (typeof fetchImpl !== "function") throw new TypeError(`${provider}: fetchImpl is required`);
  if (!model) throw new TypeError(`${provider}: model is required`);
  if (!apiKey) throw new TypeError(`${provider}: apiKey is required`);
  if (!endpoint) throw new TypeError(`${provider}: endpoint is required`);
}

export function toInt(n) {
  return Number.isFinite(Number(n)) ? Math.max(0, Math.round(Number(n))) : 0;
}
