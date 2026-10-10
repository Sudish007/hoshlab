// Anthropic Messages API adapter (design.md §7). Plain fetch, no SDK.
// POST {endpoint}  headers x-api-key, anthropic-version, content-type
// body { model, system, max_tokens, [temperature], messages: [{ role: 'user', content: user + schema prompt }] }
// The output schema is embedded in the prompt (toJsonSchema(spec, 'prompt')) and the first balanced
// {…} block of the text blocks is parsed. Thinking blocks (adaptive thinking is on by default for
// Sonnet 5.5) are skipped; only `text` blocks are joined.
import { toJsonSchema } from "../lib/schema.js";
import { DEFAULT_TIMEOUT_MS, parseJson, requestJson, requireFields, toInt } from "./adapter.js";

export const provider = "anthropic";
export const DEFAULT_API_VERSION = "2023-06-01";

export function schemaPrompt(spec) {
  if (!spec) return "";
  return `Return only a JSON object with exactly this shape (no Markdown fences, no prose):\n${toJsonSchema(spec, "prompt")}`;
}

export function buildRequest({ system, user, spec, maxOutputTokens, temperature, model, apiKey, apiVersion = DEFAULT_API_VERSION, endpoint }) {
  const prompt = schemaPrompt(spec);
  const body = {
    model,
    system,
    max_tokens: maxOutputTokens,
    messages: [{ role: "user", content: prompt ? `${user}\n\n${prompt}` : user }],
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  return {
    url: endpoint,
    init: {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": apiVersion || DEFAULT_API_VERSION, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

export function textOf(json) {
  return (Array.isArray(json.content) ? json.content : [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export async function complete(opts) {
  requireFields(opts, provider);
  const { fetchImpl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const { url, init } = buildRequest(opts);
  const { status, json, ms } = await requestJson({ fetchImpl, url, init, timeoutMs, provider, secrets: [apiKey] });
  const text = textOf(json);
  const usage = json.usage || {};
  return {
    text,
    json: parseJson(text),
    usage: { inputTokens: toInt(usage.input_tokens), outputTokens: toInt(usage.output_tokens) },
    model: json.model || opts.model,
    provider,
    ms,
    raw: { status, id: json.id || null, stopReason: json.stop_reason || null },
  };
}

// GET /v1/models (paginated with has_more / last_id) → model ids.
export async function listModels({ endpoint, apiKey, apiVersion = DEFAULT_API_VERSION, fetchImpl, timeoutMs = 30000 }) {
  const base = new URL("/v1/models", endpoint);
  const ids = [];
  let afterId = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(base);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const { json } = await requestJson({
      fetchImpl,
      url: url.href,
      init: { method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": apiVersion || DEFAULT_API_VERSION } },
      timeoutMs,
      provider,
      secrets: [apiKey],
    });
    const data = Array.isArray(json.data) ? json.data : [];
    for (const m of data) if (m && typeof m.id === "string") ids.push(m.id);
    if (!json.has_more || !json.last_id || data.length === 0) break;
    afterId = json.last_id;
  }
  return ids;
}
