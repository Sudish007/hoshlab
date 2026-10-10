// OpenAI Chat Completions adapter (design.md §7, review M7). Plain fetch, no SDK.
// POST {endpoint}  header Authorization: Bearer
// body { model, [temperature], max_completion_tokens, messages: [{ role: 'system' }, { role: 'user' }],
//        response_format: { type: 'json_schema', json_schema: { name: '<agent>_output', strict: true,
//        schema: toJsonSchema(spec, 'openai') } }, [reasoning_effort] }
// The OpenAI strict dialect lists every property in `required` and sets additionalProperties:false
// on every object. `reasoning` (config models table) maps to reasoning_effort ('low' keeps the
// Strategist/Analyst cheap; reasoning tokens bill as output and count against max_completion_tokens).
import { toJsonSchema } from "../lib/schema.js";
import { DEFAULT_TIMEOUT_MS, parseJson, requestJson, requireFields, toInt } from "./adapter.js";

export const provider = "openai";

export function schemaName(agent) {
  const base = String(agent || "agent").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${base}_output`;
}

export function buildRequest({ system, user, spec, maxOutputTokens, temperature, model, apiKey, endpoint, agent, reasoning }) {
  const body = {
    model,
    max_completion_tokens: maxOutputTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (spec) body.response_format = { type: "json_schema", json_schema: { name: schemaName(agent), strict: true, schema: toJsonSchema(spec, "openai") } };
  if (reasoning) body.reasoning_effort = reasoning;
  return {
    url: endpoint,
    init: { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) },
  };
}

export function textOf(json) {
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const message = choice && choice.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
  return "";
}

export async function complete(opts) {
  requireFields(opts, provider);
  const { fetchImpl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const { url, init } = buildRequest(opts);
  const { status, json, ms } = await requestJson({ fetchImpl, url, init, timeoutMs, provider, secrets: [apiKey] });
  const text = textOf(json);
  const usage = json.usage || {};
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  return {
    text,
    json: parseJson(text),
    usage: { inputTokens: toInt(usage.prompt_tokens), outputTokens: toInt(usage.completion_tokens) },
    model: json.model || opts.model,
    provider,
    ms,
    raw: { status, id: json.id || null, finishReason: (choice && choice.finish_reason) || null, refusal: (choice && choice.message && choice.message.refusal) || null },
  };
}

// GET /v1/models → model ids.
export async function listModels({ endpoint, apiKey, fetchImpl, timeoutMs = 30000 }) {
  const url = new URL("/v1/models", endpoint).href;
  const { json } = await requestJson({ fetchImpl, url, init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } }, timeoutMs, provider, secrets: [apiKey] });
  return (Array.isArray(json.data) ? json.data : []).filter((m) => m && typeof m.id === "string").map((m) => m.id);
}
