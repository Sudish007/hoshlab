import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FETCH_ATTEMPTS, fetchIsGuarded, tmpDir } from "./helpers.js";
import { LlmError, classify, extractJsonBlock, parseJson, requestJson, retryAfterMs, withTimeout, DEFAULT_TIMEOUT_MS } from "../engine/llm/adapter.js";
import * as anthropic from "../engine/llm/anthropic.js";
import * as gemini from "../engine/llm/gemini.js";
import * as openai from "../engine/llm/openai.js";
import * as mock from "../engine/llm/mock.js";
import { toJsonSchema } from "../engine/lib/schema.js";

const KEY = "FAKE-provider-key-0123456789abcdefghijklmnop";
const SPEC = { caption: "str<=2200", score: "int", "note?": "str", tags: ["str", { max: 3 }], nested: { ok: "bool", kind: "enum[a|b]" } };
const OUTPUT = { caption: "hello", score: 4, note: null, tags: ["x"], nested: { ok: true, kind: "a" } };

// fakeFetch([{ status, body, headers }, …]) → fetch that answers the queue in order and records calls.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const next = responses[calls.length] || responses[responses.length - 1];
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(url, init);
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status || 200, headers: { "content-type": "application/json", ...(next.headers || {}) } });
  };
  fn.calls = calls;
  return fn;
}

const anthropicOk = { id: "msg_01", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "(hidden reasoning)" }, { type: "text", text: `Here is the JSON you asked for:\n${JSON.stringify(OUTPUT)}\nDone.` }], usage: { input_tokens: 1200, output_tokens: 180 } };
const geminiOk = { responseId: "resp-1", modelVersion: "gemini-3.8-flash", candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(OUTPUT) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 150, thoughtsTokenCount: 40 } };
const openaiOk = { id: "chatcmpl-1", model: "gpt-6-luna", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(OUTPUT) } }], usage: { prompt_tokens: 1000, completion_tokens: 120 } };

const common = { system: "SYSTEM TEXT", user: '{"task":"x"}', spec: SPEC, maxOutputTokens: 4000, temperature: 0.8, timeoutMs: 5000, apiKey: KEY, agent: "writer" };

test("the global fetch guard is active and the adapters only ever use the injected fetchImpl", () => {
  assert.equal(fetchIsGuarded(), true);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("anthropic: request shape (x-api-key, anthropic-version, body, prompt-embedded schema), text-block join, usage, raw", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: anthropicOk }]);
  const res = await anthropic.complete({ ...common, fetchImpl, model: "claude-sonnet-5-5", endpoint: "https://api.anthropic.com/v1/messages", apiVersion: "2023-06-01" });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["x-api-key"], KEY);
  assert.equal(call.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.body.model, "claude-sonnet-5-5");
  assert.equal(call.body.system, "SYSTEM TEXT");
  assert.equal(call.body.max_tokens, 4000);
  assert.equal(call.body.temperature, 0.8);
  assert.equal(call.body.messages.length, 1);
  assert.equal(call.body.messages[0].role, "user");
  assert.ok(call.body.messages[0].content.startsWith('{"task":"x"}\n\n'));
  assert.ok(call.body.messages[0].content.includes(toJsonSchema(SPEC, "prompt")), "schema example embedded in the prompt");
  assert.equal(call.body.response_format, undefined);
  assert.deepEqual(res.json, OUTPUT, "first balanced {…} block parsed out of the prose");
  assert.deepEqual(res.usage, { inputTokens: 1200, outputTokens: 180 });
  assert.equal(res.provider, "anthropic");
  assert.equal(res.model, "claude-sonnet-5-5");
  assert.deepEqual(res.raw, { status: 200, id: "msg_01", stopReason: "end_turn" });
  assert.ok(Number.isInteger(res.ms) && res.ms >= 0);
  assert.ok(!res.text.includes("(hidden reasoning)"), "thinking blocks are not part of text");
});

test("anthropic: temperature undefined → field omitted (acceptsTemperature:false models return 400 otherwise)", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: anthropicOk }]);
  await anthropic.complete({ ...common, temperature: undefined, fetchImpl, model: "claude-sonnet-5-5", endpoint: "https://api.anthropic.com/v1/messages" });
  assert.equal("temperature" in fetchImpl.calls[0].body, false);
  assert.equal(fetchImpl.calls[0].init.headers["anthropic-version"], anthropic.DEFAULT_API_VERSION);
});

test("gemini: URL, x-goog-api-key, systemInstruction/contents, generationConfig with responseSchema (no additionalProperties) and thinkingLevel; usage adds thought tokens", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: geminiOk }]);
  const res = await gemini.complete({ ...common, temperature: 0.3, fetchImpl, model: "gemini-3.8-flash", endpoint: "https://generativelanguage.googleapis.com/v1beta", reasoning: "low" });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(call.init.headers["x-goog-api-key"], KEY);
  assert.equal(call.init.headers.Authorization, undefined);
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: "SYSTEM TEXT" }] });
  assert.deepEqual(call.body.contents, [{ role: "user", parts: [{ text: '{"task":"x"}' }] }]);
  const gc = call.body.generationConfig;
  assert.equal(gc.temperature, 0.3);
  assert.equal(gc.maxOutputTokens, 4000);
  assert.equal(gc.responseMimeType, "application/json");
  assert.deepEqual(gc.thinkingConfig, { thinkingLevel: "low" });
  assert.deepEqual(gc.responseSchema, toJsonSchema(SPEC, "gemini"));
  assert.ok(!JSON.stringify(gc.responseSchema).includes("additionalProperties"), "Gemini dialect carries no additionalProperties (M7)");
  assert.equal(gc.responseSchema.properties.note.nullable, true);
  assert.deepEqual(res.json, OUTPUT);
  assert.deepEqual(res.usage, { inputTokens: 900, outputTokens: 190 }, "candidatesTokenCount + thoughtsTokenCount (thought tokens bill as output)");
  assert.equal(res.provider, "gemini");
  assert.deepEqual(res.raw, { status: 200, id: "resp-1", finishReason: "STOP" });
  assert.ok(!res.text.includes("thinking…"), "thought parts excluded from text");

  const plain = fakeFetch([{ status: 200, body: { ...geminiOk, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }]);
  const res2 = await gemini.complete({ ...common, temperature: undefined, fetchImpl: plain, model: "gemini-3.8-flash", endpoint: "https://generativelanguage.googleapis.com/v1beta/" });
  assert.equal(plain.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", "trailing slash tolerated");
  assert.equal("temperature" in plain.calls[0].body.generationConfig, false);
  assert.equal("thinkingConfig" in plain.calls[0].body.generationConfig, false);
  assert.deepEqual(res2.usage, { inputTokens: 10, outputTokens: 5 });
});

test("openai: Bearer auth, messages, max_completion_tokens, strict json_schema response_format, reasoning_effort; usage", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: openaiOk }]);
  const res = await openai.complete({ ...common, temperature: 0.7, fetchImpl, model: "gpt-6-luna", endpoint: "https://api.openai.com/v1/chat/completions", reasoning: "low" });
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.body.model, "gpt-6-luna");
  assert.equal(call.body.temperature, 0.7);
  assert.equal(call.body.max_completion_tokens, 4000);
  assert.equal(call.body.max_tokens, undefined);
  assert.deepEqual(call.body.messages, [
    { role: "system", content: "SYSTEM TEXT" },
    { role: "user", content: '{"task":"x"}' },
  ]);
  assert.equal(call.body.reasoning_effort, "low");
  const rf = call.body.response_format;
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.name, "writer_output");
  assert.equal(rf.json_schema.strict, true);
  assert.deepEqual(rf.json_schema.schema, toJsonSchema(SPEC, "openai"));
  assert.equal(rf.json_schema.schema.additionalProperties, false);
  assert.deepEqual(rf.json_schema.schema.required, ["caption", "score", "note", "tags", "nested"], "strict mode: every property required");
  assert.deepEqual(rf.json_schema.schema.properties.note.type, ["string", "null"]);
  assert.deepEqual(res.json, OUTPUT);
  assert.deepEqual(res.usage, { inputTokens: 1000, outputTokens: 120 });
  assert.equal(res.provider, "openai");
  assert.equal(res.model, "gpt-6-luna");
  assert.deepEqual(res.raw, { status: 200, id: "chatcmpl-1", finishReason: "stop", refusal: null });

  const noReasoning = fakeFetch([{ status: 200, body: openaiOk }]);
  await openai.complete({ ...common, temperature: undefined, fetchImpl: noReasoning, model: "gpt-6-luna", endpoint: "https://api.openai.com/v1/chat/completions" });
  assert.equal("reasoning_effort" in noReasoning.calls[0].body, false);
  assert.equal("temperature" in noReasoning.calls[0].body, false);
});

test("non-2xx → LlmError with the design's retryable classification; the api key never appears in error.message", async () => {
  const cases = [
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [529, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ];
  for (const [status, retryable] of cases) {
    const body = { error: { type: "api_error", message: `rejected key ${KEY} for ${status}` } };
    for (const [adapter, extra] of [
      [anthropic, { model: "claude-sonnet-5-5", endpoint: "https://api.anthropic.com/v1/messages" }],
      [gemini, { model: "gemini-3.8-flash", endpoint: "https://generativelanguage.googleapis.com/v1beta" }],
      [openai, { model: "gpt-6-luna", endpoint: "https://api.openai.com/v1/chat/completions" }],
    ]) {
      const fetchImpl = fakeFetch([{ status, body }]);
      await assert.rejects(
        adapter.complete({ ...common, fetchImpl, ...extra }),
        (e) => {
          assert.ok(e instanceof LlmError, `${adapter.provider} ${status}: LlmError`);
          assert.equal(e.status, status);
          assert.equal(e.retryable, retryable, `${adapter.provider} ${status} retryable`);
          assert.equal(e.provider, adapter.provider);
          assert.equal(e.kind, "http");
          assert.ok(e.message.includes(`HTTP ${status}`), e.message);
          assert.ok(!e.message.includes(KEY), "key scrubbed");
          assert.ok(e.message.includes("•••"), "scrub mask present");
          return true;
        },
        `${adapter.provider} ${status}`,
      );
    }
  }
  // Gemini-style error envelope ({ error: { code, message, status } }) and a plain-text body
  const g = fakeFetch([{ status: 429, headers: { "retry-after": "17" }, body: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } } }]);
  await assert.rejects(gemini.complete({ ...common, fetchImpl: g, model: "gemini-3.8-flash", endpoint: "https://generativelanguage.googleapis.com/v1beta" }), (e) => e instanceof LlmError && /gemini: HTTP 429 RESOURCE_EXHAUSTED: Resource exhausted/.test(e.message) && e.retryAfterMs === 17000);
  const t = fakeFetch([{ status: 502, body: "<html>Bad gateway</html>" }]);
  await assert.rejects(openai.complete({ ...common, fetchImpl: t, model: "gpt-6-luna", endpoint: "https://api.openai.com/v1/chat/completions" }), (e) => e instanceof LlmError && e.status === 502 && e.retryable === true && /Bad gateway/.test(e.message));
});

test("retryAfterMs parses Retry-After seconds/date first, then Gemini google.rpc.RetryInfo retryDelay", () => {
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "12" }) }), 12000);
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), nowMs: Date.parse("Wed, 21 Oct 2026 07:27:30 GMT") }), 30000);
  assert.equal(retryAfterMs({ json: { error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "22.5s" }] } } }), 22500);
  assert.equal(retryAfterMs({ headers: new Headers({ "retry-after": "bad" }), json: { error: { details: [{ retryDelay: "0.5s" }] } } }), 500);
  assert.equal(retryAfterMs({}), null);
});

test("network failure and timeout → LlmError status 0, kind network, retryable", async () => {
  const down = fakeFetch([new TypeError("fetch failed: ECONNRESET")]);
  await assert.rejects(anthropic.complete({ ...common, fetchImpl: down, model: "claude-sonnet-5-5", endpoint: "https://api.anthropic.com/v1/messages" }), (e) => e instanceof LlmError && e.status === 0 && e.kind === "network" && e.retryable === true && /network error: fetch failed/.test(e.message));

  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const started = Date.now();
  await assert.rejects(openai.complete({ ...common, timeoutMs: 40, fetchImpl: hanging, model: "gpt-6-luna", endpoint: "https://api.openai.com/v1/chat/completions" }), (e) => e instanceof LlmError && e.status === 0 && e.retryable === true && /timeout after 40 ms/.test(e.message));
  assert.ok(Date.now() - started < 2000);

  const wrapped = withTimeout(hanging, 30);
  await assert.rejects(wrapped("https://x.test/", {}), (e) => e.name === "TimeoutError");
  const passthrough = withTimeout(async () => new Response("{}", { status: 200 }), Infinity);
  assert.equal((await passthrough("https://x.test/")).status, 200);
  assert.throws(() => withTimeout(null, 10), TypeError);
  assert.equal(DEFAULT_TIMEOUT_MS, 120000);
});

test("classify(): network → retryable; 408/429/5xx retryable; 400/401/403/404 and other 4xx final", () => {
  assert.equal(classify(0, new Error("x")), true);
  for (const s of [408, 429, 500, 502, 503, 529, 599]) assert.equal(classify(s, null), true, String(s));
  for (const s of [400, 401, 403, 404, 402, 413, 422, 200]) assert.equal(classify(s, null), false, String(s));
});

test("extractJsonBlock / parseJson: balanced braces, strings with braces, fences, no object", () => {
  assert.equal(extractJsonBlock('prose {"a":"}","b":{"c":1}} trailing {"d":2}'), '{"a":"}","b":{"c":1}}');
  assert.equal(extractJsonBlock('escaped {"a":"\\"}\\\\","b":1}'), '{"a":"\\"}\\\\","b":1}');
  assert.equal(extractJsonBlock("no object here"), null);
  assert.equal(extractJsonBlock('{"unterminated": 1'), null);
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson("[1,2]"), null, "arrays are not agent outputs");
  assert.equal(parseJson(""), null);
  assert.equal(parseJson("{bad json}"), null);
  assert.equal(parseJson(null), null);
});

test("requestJson: non-JSON 2xx body is a retryable LlmError; a 2xx JSON body passes through with ms and headers", async () => {
  const bad = fakeFetch([{ status: 200, body: "not json" }]);
  await assert.rejects(requestJson({ fetchImpl: bad, url: "https://x.test/", init: {}, provider: "openai", secrets: [KEY] }), (e) => e instanceof LlmError && e.retryable === true && /non-JSON body/.test(e.message));
  const good = fakeFetch([{ status: 200, body: { ok: 1 }, headers: { "x-request-id": "r1" } }]);
  const r = await requestJson({ fetchImpl: good, url: "https://x.test/", init: {}, provider: "openai", secrets: [KEY] });
  assert.deepEqual(r.json, { ok: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-request-id"), "r1");
});

test("listModels: Anthropic (has_more/after_id), Gemini (nextPageToken, 'models/' prefix stripped), OpenAI (data[].id)", async () => {
  const a = fakeFetch([
    { status: 200, body: { data: [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5" }], has_more: true, last_id: "claude-haiku-5" } },
    { status: 200, body: { data: [{ id: "claude-opus-5" }], has_more: false, last_id: "claude-opus-5" } },
  ]);
  assert.deepEqual(await anthropic.listModels({ endpoint: "https://api.anthropic.com/v1/messages", apiKey: KEY, fetchImpl: a }), ["claude-sonnet-5-5", "claude-haiku-5", "claude-opus-5"]);
  assert.equal(a.calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(a.calls[1].url, "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-haiku-5");
  assert.equal(a.calls[0].init.method, "GET");
  assert.equal(a.calls[0].init.headers["x-api-key"], KEY);
  assert.equal(a.calls[0].init.headers["anthropic-version"], anthropic.DEFAULT_API_VERSION);

  const g = fakeFetch([
    { status: 200, body: { models: [{ name: "models/gemini-3.8-flash" }], nextPageToken: "p2" } },
    { status: 200, body: { models: [{ name: "models/gemini-3.1-pro" }] } },
  ]);
  assert.deepEqual(await gemini.listModels({ endpoint: "https://generativelanguage.googleapis.com/v1beta", apiKey: KEY, fetchImpl: g }), ["gemini-3.8-flash", "gemini-3.1-pro"]);
  assert.equal(g.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(g.calls[1].url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=p2");
  assert.equal(g.calls[0].init.headers["x-goog-api-key"], KEY);

  const o = fakeFetch([{ status: 200, body: { object: "list", data: [{ id: "gpt-6-luna", object: "model" }, { id: "gpt-6-astra" }] } }]);
  assert.deepEqual(await openai.listModels({ endpoint: "https://api.openai.com/v1/chat/completions", apiKey: KEY, fetchImpl: o }), ["gpt-6-luna", "gpt-6-astra"]);
  assert.equal(o.calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(o.calls[0].init.headers.Authorization, `Bearer ${KEY}`);

  const denied = fakeFetch([{ status: 401, body: { error: { message: `invalid x-api-key ${KEY}` } } }]);
  await assert.rejects(anthropic.listModels({ endpoint: "https://api.anthropic.com/v1/messages", apiKey: KEY, fetchImpl: denied }), (e) => e instanceof LlmError && e.status === 401 && !e.message.includes(KEY));
});

test("mock adapter: fixture by agent + case (MOCK_LLM_CASE, per-agent override), usage copied, mock:true; missing fixture throws (never fabricates)", async () => {
  const dir = tmpDir("hoshlab-llm-fixtures-");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "writer.ok.json"), JSON.stringify({ agent: "writer", case: "ok", output: OUTPUT, usage: { inputTokens: 5800, outputTokens: 900 } }), "utf8");
    writeFileSync(join(dir, "writer.bad.json"), JSON.stringify({ agent: "writer", case: "bad", output: { caption: 1 }, usage: { inputTokens: 1, outputTokens: 1 } }), "utf8");
    writeFileSync(join(dir, "qa.fail.json"), JSON.stringify({ agent: "qa", case: "fail", output: { verdict: "fail" } }), "utf8");

    const ok = await mock.complete({ agent: "writer", processEnv: { MOCK_LLM: "1" }, fixturesDir: dir });
    assert.deepEqual(ok.json, OUTPUT);
    assert.equal(ok.text, JSON.stringify(OUTPUT));
    assert.deepEqual(ok.usage, { inputTokens: 5800, outputTokens: 900 });
    assert.equal(ok.mock, true);
    assert.equal(ok.provider, "mock");
    assert.equal(ok.model, "mock");
    assert.deepEqual(ok.raw, { status: 200, id: "mock:writer.ok" });
    ok.json.caption = "mutated";
    assert.equal((await mock.complete({ agent: "writer", processEnv: {}, fixturesDir: dir })).json.caption, "hello", "fixture is cloned per call");

    const bad = await mock.complete({ agent: "writer", processEnv: { MOCK_LLM_CASE: "bad" }, fixturesDir: dir });
    assert.deepEqual(bad.json, { caption: 1 });
    const perAgent = await mock.complete({ agent: "qa", processEnv: { MOCK_LLM_CASE: "bad", MOCK_LLM_CASE_QA: "fail" }, fixturesDir: dir });
    assert.deepEqual(perAgent.json, { verdict: "fail" });
    assert.deepEqual(perAgent.usage, { inputTokens: 0, outputTokens: 0 }, "missing usage → zeros");
    assert.equal(mock.fixtureCase("qa", { MOCK_LLM_CASE: "bad", MOCK_LLM_CASE_QA: "fail" }), "fail");
    assert.equal(mock.fixtureCase("writer", {}), "ok");

    await assert.rejects(mock.complete({ agent: "strategist", processEnv: {}, fixturesDir: dir }), (e) => e instanceof mock.MockFixtureError && /fixture missing for strategist case ok/.test(e.message) && /never fabricates/.test(e.message));
    await assert.rejects(mock.complete({ agent: "writer", processEnv: { MOCK_LLM_CASE: "nope" }, fixturesDir: dir }), mock.MockFixtureError);
    await assert.rejects(mock.complete({ agent: "../etc", processEnv: {}, fixturesDir: dir }), mock.MockFixtureError);
    assert.equal(mock.isMockEnabled({ MOCK_LLM: "1" }), true);
    assert.equal(mock.isMockEnabled({ MOCK_LLM: "true" }), false, "only the exact value '1' enables the mock");
    assert.equal(mock.isMockEnabled({}), false);
    assert.ok(mock.DEFAULT_FIXTURES_DIR.replace(/\\/g, "/").endsWith("/tests/fixtures/llm/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
