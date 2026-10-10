// Gemini generateContent adapter (design.md §7, review M7). Plain fetch, no SDK.
// POST {endpoint}/models/{model}:generateContent  header x-goog-api-key
// body { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
//        generationConfig: { [temperature], maxOutputTokens, responseMimeType: 'application/json',
//                            responseSchema: toJsonSchema(spec, 'gemini'), [thinkingConfig: { thinkingLevel }] } }
// The Gemini dialect carries no additionalProperties (the API rejects it). `reasoning` (config
// models table) maps to generationConfig.thinkingConfig.thinkingLevel — 'low' is the cheapest level
// gemini-3.8-flash accepts ('minimal' returns an error; the default is 'medium').
// maxOutputTokens includes thought tokens on Gemini 3; thought tokens are billed as output, so
// outputTokens = candidatesTokenCount + thoughtsTokenCount.
import { toJsonSchema } from "../lib/schema.js";
import { DEFAULT_TIMEOUT_MS, parseJson, requestJson, requireFields, toInt } from "./adapter.js";

export const provider = "gemini";

export function buildRequest({ system, user, spec, maxOutputTokens, temperature, model, apiKey, endpoint, reasoning }) {
  const generationConfig = { maxOutputTokens, responseMimeType: "application/json" };
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (spec) generationConfig.responseSchema = toJsonSchema(spec, "gemini");
  if (reasoning) generationConfig.thinkingConfig = { thinkingLevel: reasoning };
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  };
  return {
    url: `${String(endpoint).replace(/\/+$/, "")}/models/${model}:generateContent`,
    init: { method: "POST", headers: { "x-goog-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify(body) },
  };
}

export function textOf(json) {
  const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  return parts
    .filter((p) => p && typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

export async function complete(opts) {
  requireFields(opts, provider);
  const { fetchImpl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const { url, init } = buildRequest(opts);
  const { status, json, ms } = await requestJson({ fetchImpl, url, init, timeoutMs, provider, secrets: [apiKey] });
  const text = textOf(json);
  const usage = json.usageMetadata || {};
  const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
  return {
    text,
    json: parseJson(text),
    usage: { inputTokens: toInt(usage.promptTokenCount), outputTokens: toInt(usage.candidatesTokenCount) + toInt(usage.thoughtsTokenCount) },
    model: json.modelVersion || opts.model,
    provider,
    ms,
    raw: { status, id: json.responseId || null, finishReason: (candidate && candidate.finishReason) || null },
  };
}

// GET {endpoint}/models (paginated with nextPageToken) → model ids without the 'models/' prefix.
export async function listModels({ endpoint, apiKey, fetchImpl, timeoutMs = 30000 }) {
  const base = `${String(endpoint).replace(/\/+$/, "")}/models`;
  const ids = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(base);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const { json } = await requestJson({ fetchImpl, url: url.href, init: { method: "GET", headers: { "x-goog-api-key": apiKey } }, timeoutMs, provider, secrets: [apiKey] });
    for (const m of Array.isArray(json.models) ? json.models : []) {
      if (m && typeof m.name === "string") ids.push(m.name.replace(/^models\//, ""));
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return ids;
}
