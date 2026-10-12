import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { USAGE_SPEC, validate } from "../engine/lib/schema.js";
import { AgentOutputError, AllProvidersFailedError, BACKOFF_MS, BudgetExhaustedError, MAX_RATE_LIMIT_RETRIES, RATE_LIMIT_CAP_MS, REPAIR_SENTENCE, createRouter, providerTier, rateLimitDelayMs, resolveAgent, validateOutput } from "../engine/llm/router.js";
import { buildEnvelope, houseRules, HOUSE_RULES_HEADING, CONTEXT_HEADING, OUTPUT_HEADING } from "../engine/llm/prompt.js";
import { costUsd } from "../engine/lib/budget.js";

const company = loadCompany({ companyDir: COMPANY_DIR, warn: () => {} });
const { config, roster, charters, brands } = company;
const PRICES = { anthropic: config.providers.anthropic.models["claude-sonnet-5-5"], gemini: config.providers.gemini.models["gemini-3.8-flash"], openai: config.providers.openai.models["gpt-6-luna"] };
const KEYS = { ANTHROPIC_API_KEY: "FAKE-anthropic-key-aaaaaaaaaaaaaaaaaaaaaaaa", GEMINI_API_KEY: "FAKE-gemini-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbb", OPENAI_API_KEY: "FAKE-openai-key-cccccccccccccccccccccccccccc" };
const NOW = "2026-10-12T05:31:00+05:30"; // Monday
const RUN_ID = "engine-daily-20261012-0531-abc123";
const SPEC = { caption: "str<=2200", hashtags: ["str", { max: 8 }], factsUsed: [{ factId: "id", quote: "str" }, { min: 1 }] };
const GOOD = { caption: "Free Janam Kundali, computed on your device.", hashtags: ["#RishtaPatra"], factsUsed: [{ factId: "rp-f07", quote: "North Indian method" }] };
const BAD = { caption: 42, hashtags: "nope" };
const TASK = { idea: { title: "Free kundali", factIds: ["rp-f07"] }, format: "image" };

const anthropicBody = (output, usage = { input_tokens: 6000, output_tokens: 900 }) => ({ id: "msg_1", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(output) }], usage });
const geminiBody = (output, usage = { promptTokenCount: 5000, candidatesTokenCount: 700 }) => ({ responseId: "g1", candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(output) }] } }], usageMetadata: usage });
const openaiBody = (output, usage = { prompt_tokens: 7000, completion_tokens: 800 }) => ({ id: "c1", model: "gpt-6-luna", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }], usage });

function providerOf(url) {
  if (url.startsWith("https://api.anthropic.com/")) return "anthropic";
  if (url.startsWith("https://generativelanguage.googleapis.com/")) return "gemini";
  if (url.startsWith("https://api.openai.com/")) return "openai";
  throw new Error(`unexpected url ${url}`);
}

// fakeFetch({ anthropic: [resp, …], gemini: […], openai: […] }) — per-provider answer queues (last answer repeats).
function fakeFetch(queues) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const provider = providerOf(String(url));
    const q = queues[provider] || [];
    const idx = calls.filter((c) => c.provider === provider).length;
    const next = q[Math.min(idx, q.length - 1)];
    calls.push({ provider, url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (!next) throw new Error(`no fake answer queued for ${provider}`);
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status || 200, headers: { "content-type": "application/json", ...(next.headers || {}) } });
  };
  fn.calls = calls;
  return fn;
}

function harness({ keys = KEYS, processEnv = {}, queues = {}, usageSeed = [], now = NOW, fixturesDir, companyConfig = config, companyRoster = roster } = {}) {
  const dir = tmpDir("hoshlab-router-");
  const state = createState({ companyDir: dir, now });
  for (const row of usageSeed) state.appendLog("usage", row, USAGE_SPEC);
  const sleeps = [];
  let elapsedMs = 0;
  const fetchImpl = fakeFetch(queues);
  const env = readEnv(Object.values(companyConfig.providers).map((p) => p.secret), keys);
  const sleep = async (ms) => {
    sleeps.push(ms);
    elapsedMs += ms;
  };
  const router = createRouter({ config: companyConfig, roster: companyRoster, state, env, fetchImpl, sleep, now, nowMs: () => elapsedMs, runId: RUN_ID, charters, processEnv, fixturesDir });
  const usage = () => state.readJsonl(state.monthLogPath("usage"));
  return { dir, state, router, fetchImpl, sleeps, elapsedMs: () => elapsedMs, usage, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const seedLine = (cost, at = "2026-10-05T05:31:00+05:30") => ({ at, runId: "engine-daily-20261005-0531-aaaaaa", agent: "writer", page: "kaatdo", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 1, costUsd: cost, ms: 1, ok: true, mock: false });

test("resolveAgent: every LLM agent is Gemini first with Anthropic/OpenAI fallback models, free tier and pacing from config", () => {
  const writer = resolveAgent(roster, config, "writer");
  assert.deepEqual(
    writer.chain.map((c) => [c.provider, c.model]),
    [
      ["gemini", "gemini-3.8-flash"],
      ["anthropic", "claude-sonnet-5-5"],
      ["openai", "gpt-6-luna"],
    ],
  );
  assert.equal(writer.temperature, 0.8);
  assert.equal(writer.maxOutputTokens, 4000);
  assert.equal(writer.chain[0].acceptsTemperature, true);
  assert.equal(writer.chain[0].reasoning, "low");
  assert.equal(writer.chain[0].tier, "free");
  assert.equal(writer.chain[0].minIntervalMs, 7000);
  assert.equal(writer.chain[0].secret, "GEMINI_API_KEY");
  assert.equal(writer.chain[1].acceptsTemperature, false, "claude-sonnet-5-5 returns 400 on a non-default temperature");
  assert.equal(writer.chain[1].apiVersion, "2023-06-01");
  assert.equal(writer.chain[1].tier, "paid");
  for (const name of ["ceo", "hr", "strategist", "writer", "qa", "analyst"]) {
    assert.deepEqual(resolveAgent(roster, config, name).chain.map((c) => c.provider), ["gemini", "anthropic", "openai"], name);
  }
  assert.equal(resolveAgent(roster, config, "qa").temperature, 0);
  assert.equal(resolveAgent(roster, config, "qa").maxOutputTokens, 2000);
  assert.equal(providerTier({ tier: "free" }), "free");
  assert.equal(providerTier({}), "paid", "tier defaults to paid when absent");
  assert.throws(() => resolveAgent(roster, config, "designer"), /deterministic/);
  assert.throws(() => resolveAgent(roster, config, "publisher"), /deterministic/);
  assert.throws(() => resolveAgent(roster, config, "nobody"), /unknown agent/);
});

test("happy path: Gemini free tier answers; usage records USD 0 billed plus the paid-equivalent price-table figure", async () => {
  const h = harness({ queues: { gemini: [{ body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: config.pages[0] } });
    assert.deepEqual(res.json, GOOD);
    assert.equal(res.provider, "gemini");
    assert.equal(res.model, "gemini-3.8-flash");
    assert.equal(res.mock, false);
    assert.equal(res.calls, 1);
    assert.equal(res.repaired, false);
    assert.equal(res.costUsd, 0, "free-tier bill");
    assert.equal(res.paidEquivalentUsd, costUsd(PRICES.gemini, 5000, 700));
    assert.equal(res.paidEquivalentUsd, 0.006375);
    assert.equal(h.fetchImpl.calls.length, 1);
    const body = h.fetchImpl.calls[0].body;
    assert.equal(body.generationConfig.temperature, 0.8);
    assert.equal(body.generationConfig.maxOutputTokens, 4000);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: "low" });
    assert.ok(body.systemInstruction.parts[0].text.includes("# Writer"), "charter first");
    assert.ok(body.systemInstruction.parts[0].text.includes(HOUSE_RULES_HEADING));
    assert.ok(body.systemInstruction.parts[0].text.includes("| rp-f07 |"), "usable facts table in the context block");
    assert.ok(!body.systemInstruction.parts[0].text.includes("| rp-f12 |"), "disputed fact excluded (P1-04)");
    assert.equal(body.contents[0].parts[0].text.startsWith(JSON.stringify(TASK)), true, "user = JSON.stringify(task)");
    const lines = h.usage();
    assert.equal(lines.length, 1);
    assert.equal(validate(lines[0], USAGE_SPEC).ok, true);
    assert.equal(lines[0].ok, true);
    assert.equal(lines[0].agent, "writer");
    assert.equal(lines[0].page, "rishtapatra");
    assert.equal(lines[0].provider, "gemini");
    assert.equal(lines[0].model, "gemini-3.8-flash");
    assert.equal(lines[0].inputTokens, 5000);
    assert.equal(lines[0].outputTokens, 700);
    assert.equal(lines[0].costUsd, 0);
    assert.equal(lines[0].paidEquivalentUsd, 0.006375);
    assert.equal(lines[0].mock, false);
    assert.equal(lines[0].runId, RUN_ID);
    assert.equal(lines[0].at, NOW);
    assert.equal(h.state.monthLogPath("usage"), "state/usage/2026-10.jsonl");
    assert.deepEqual(h.router.totalsFor("writer"), { calls: 1, ok: 1, failed: 0, costUsd: 0, paidEquivalentUsd: 0.006375, freeTierCalls: 1, ms: lines[0].ms, inputTokens: 5000, outputTokens: 700 });
    assert.deepEqual([...h.router.flags], []);
    assert.equal(h.sleeps.length, 0);
    assert.equal(FETCH_ATTEMPTS.length, 0, "no call reached the guarded global fetch");
  } finally {
    h.cleanup();
  }
});

test("429 honours Retry-After, retries three times on Gemini, then preserves fallback order; every attempt has a usage line", async () => {
  const h = harness({ queues: { gemini: [{ status: 429, headers: { "retry-after": "12" }, body: { error: { status: "RESOURCE_EXHAUSTED", message: `slow down ${KEYS.GEMINI_API_KEY}` } } }], anthropic: [{ body: anthropicBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } });
    assert.equal(res.provider, "anthropic");
    assert.equal(res.model, "claude-sonnet-5-5");
    assert.equal(res.calls, 5);
    assert.deepEqual(h.sleeps, [12000, 20000, 40000], "Retry-After 12 s beats only the first 10 s exponential step");
    assert.equal(MAX_RATE_LIMIT_RETRIES, 3);
    assert.deepEqual(
      h.fetchImpl.calls.map((c) => c.provider),
      ["gemini", "gemini", "gemini", "gemini", "anthropic"],
      "fallback stays Gemini → Anthropic → OpenAI and begins only after the third retry",
    );
    const aBody = h.fetchImpl.calls[4].body;
    assert.equal("temperature" in aBody, false, "roster temperature is omitted for the Anthropic fallback model");
    const lines = h.usage();
    assert.equal(lines.length, 5);
    for (const l of lines) assert.equal(validate(l, USAGE_SPEC).ok, true);
    assert.deepEqual(lines.map((l) => [l.provider, l.ok]), [["gemini", false], ["gemini", false], ["gemini", false], ["gemini", false], ["anthropic", true]]);
    for (const l of lines.slice(0, 4)) {
      assert.match(l.error, /gemini: HTTP 429/);
      assert.ok(!l.error.includes(KEYS.GEMINI_API_KEY), "key scrubbed from the usage line");
      assert.equal(l.costUsd, 0);
      assert.equal(l.paidEquivalentUsd, 0);
      assert.equal(l.inputTokens, 0);
    }
    assert.equal(lines[4].costUsd, costUsd(PRICES.anthropic, 6000, 900));
    assert.equal(res.costUsd, lines[4].costUsd);
    assert.equal(res.paidEquivalentUsd, lines[4].costUsd);
    assert.deepEqual([...h.router.flags], [], "429 is not provider_down");
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].attempts, 4);
    assert.equal(h.router.totalsFor("writer").failed, 4);
  } finally {
    h.cleanup();
  }
});

test("Gemini minIntervalMs is enforced between consecutive calls in one process with an injected clock", async () => {
  const h = harness({ queues: { gemini: [{ body: geminiBody(GOOD) }, { body: geminiBody(GOOD) }] } });
  try {
    await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.deepEqual(h.sleeps, [], "first call has no predecessor");
    await h.router.complete("qa", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.deepEqual(h.sleeps, [7000]);
    assert.equal(h.elapsedMs(), 7000);
    assert.deepEqual(h.fetchImpl.calls.map((c) => c.provider), ["gemini", "gemini"]);
  } finally {
    h.cleanup();
  }
});

test("429 Gemini retryDelay is honoured and an oversized server hint is capped at 60 seconds before fallback", async () => {
  const h = harness({
    queues: {
      gemini: [{ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }] } } }],
      anthropic: [{ body: anthropicBody(GOOD) }],
    },
  });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "anthropic");
    assert.deepEqual(h.sleeps, [RATE_LIMIT_CAP_MS, RATE_LIMIT_CAP_MS, RATE_LIMIT_CAP_MS]);
    assert.equal(RATE_LIMIT_CAP_MS, 60000);
    assert.equal(rateLimitDelayMs(90000, 0), 60000);
    assert.equal(rateLimitDelayMs(null, 0), 10000);
    assert.equal(h.fetchImpl.calls.filter((c) => c.provider === "gemini").length, 4, "initial call plus max 3 retries");
  } finally {
    h.cleanup();
  }
});

test("401 flags provider_down:<name> and falls back immediately (no sleep); 400/403/404 fall back immediately without the flag", async () => {
  const h = harness({ queues: { gemini: [{ status: 401, body: { error: { message: "invalid x-goog-api-key" } } }], anthropic: [{ body: anthropicBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "anthropic");
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(
      h.fetchImpl.calls.map((c) => c.provider),
      ["gemini", "anthropic"],
    );
    assert.deepEqual([...h.router.flags], ["provider_down:gemini"]);
    assert.equal(h.usage().length, 2);
    assert.equal(h.usage()[0].page, "rishtapatra", "page taken from the brand when context.page is absent");
  } finally {
    h.cleanup();
  }
  for (const status of [400, 403, 404]) {
    const h2 = harness({ queues: { gemini: [{ status, body: { error: { message: "nope" } } }], anthropic: [{ body: anthropicBody(GOOD) }] } });
    try {
      const res = await h2.router.complete("qa", { task: TASK, spec: SPEC, context: { brand: brands.kaatdo, page: "kaatdo" } });
      assert.equal(res.provider, "anthropic", `qa falls back gemini → anthropic on ${status}`);
      assert.deepEqual(h2.sleeps, []);
      assert.deepEqual([...h2.router.flags], [], `${status} is not provider_down`);
      assert.equal(h2.usage().length, 2);
    } finally {
      h2.cleanup();
    }
  }
});

test("a provider whose secret is absent is skipped without a call and without a usage line; a disabled provider is skipped too", async () => {
  const h = harness({ keys: { ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, OPENAI_API_KEY: KEYS.OPENAI_API_KEY }, queues: { anthropic: [{ body: anthropicBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } });
    assert.equal(res.provider, "anthropic");
    assert.deepEqual(
      h.fetchImpl.calls.map((c) => c.provider),
      ["anthropic"],
    );
    assert.equal(h.usage().length, 1);
    assert.deepEqual(res.failures, [{ provider: "gemini", model: "gemini-3.8-flash", status: null, reason: "skipped: secret GEMINI_API_KEY missing", attempts: 0 }]);
  } finally {
    h.cleanup();
  }
  const disabledConfig = structuredClone(config);
  disabledConfig.providers.gemini.enabled = false;
  const dir = tmpDir("hoshlab-router-");
  try {
    const state = createState({ companyDir: dir, now: NOW });
    const fetchImpl = fakeFetch({ anthropic: [{ body: anthropicBody(GOOD) }] });
    const router = createRouter({ config: disabledConfig, roster, state, env: readEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], KEYS), fetchImpl, sleep: async () => {}, now: NOW, runId: RUN_ID, charters, processEnv: {} });
    const res = await router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "anthropic");
    assert.equal(res.failures[0].reason, "skipped: provider not enabled");
    assert.equal(fetchImpl.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every provider failing or skipped → AllProvidersFailedError with per-provider reasons; usage lines for every attempt", async () => {
  const h = harness({
    keys: { ANTHROPIC_API_KEY: KEYS.ANTHROPIC_API_KEY, GEMINI_API_KEY: KEYS.GEMINI_API_KEY },
    queues: { anthropic: [{ status: 500, body: { error: { message: "overloaded" } } }], gemini: [{ status: 403, body: { error: { message: "forbidden" } } }] },
  });
  try {
    await assert.rejects(h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), (e) => {
      assert.ok(e instanceof AllProvidersFailedError);
      assert.equal(e.agent, "writer");
      assert.deepEqual(
        e.failures.map((f) => [f.provider, f.status, f.attempts]),
        [
          ["gemini", 403, 1],
          ["anthropic", 500, 3],
          ["openai", null, 0],
        ],
      );
      assert.match(e.failures[2].reason, /secret OPENAI_API_KEY missing/);
      assert.match(e.message, /no provider answered/);
      return true;
    });
    assert.deepEqual(h.sleeps, BACKOFF_MS);
    assert.equal(h.usage().length, 4);
    assert.ok(h.usage().every((l) => l.ok === false));
  } finally {
    h.cleanup();
  }
});

test("invalid output → exactly one repair call carrying the design sentence and the previous output; a second failure → AgentOutputError", async () => {
  const h = harness({ queues: { gemini: [{ body: geminiBody(BAD) }, { body: geminiBody({ ...BAD, caption: "still bad" }) }, { body: geminiBody(GOOD) }] } });
  try {
    await assert.rejects(h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } }), (e) => {
      assert.ok(e instanceof AgentOutputError, e.message);
      assert.equal(e.agent, "writer");
      assert.equal(e.provider, "gemini");
      assert.equal(e.model, "gemini-3.8-flash");
      assert.equal(e.calls, 2);
      assert.ok(e.errors.some((x) => /\$\.caption: expected string/.test(x)), e.errors.join("; "));
      assert.ok(e.errors.some((x) => /\$\.factsUsed: required/.test(x)));
      assert.ok(e.repairErrors.length >= 1);
      assert.match(e.message, /after one repair call/);
      return true;
    });
    assert.equal(h.fetchImpl.calls.length, 2, "exactly one repair call, never a third");
    const repair = h.fetchImpl.calls[1].body.contents[0].parts[0].text;
    const sentence = REPAIR_SENTENCE(["$.caption: expected string"]).split("$.caption")[0];
    assert.ok(repair.includes("Your previous output failed validation: "), repair);
    assert.ok(repair.includes("$.caption: expected string"));
    assert.ok(repair.includes("Return only the corrected JSON."));
    assert.ok(repair.includes(sentence));
    assert.ok(repair.includes("## Previous output"));
    assert.ok(repair.includes(JSON.stringify(BAD)), "previous output quoted so the model can correct it");
    assert.ok(repair.startsWith(JSON.stringify(TASK)), "task still first");
    assert.equal(h.fetchImpl.calls[1].provider, "gemini", "repair goes to the provider that answered");
    const lines = h.usage();
    assert.equal(lines.length, 2, "both completions are usage lines");
    assert.ok(lines.every((l) => l.ok === true), "a validation failure is not a transport failure");
    assert.ok(lines.every((l) => l.costUsd === 0 && Number.isFinite(l.paidEquivalentUsd)), "both free-tier lines preserve paid equivalents");
    assert.deepEqual(h.sleeps, [7000], "the repair is a consecutive Gemini call and observes minIntervalMs");
  } finally {
    h.cleanup();
  }
});

test("invalid output then a valid repair → free-tier result combines billed and paid-equivalent costs", async () => {
  const h = harness({ queues: { gemini: [{ body: geminiBody(BAD) }, { body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("strategist", { task: TASK, spec: SPEC, context: { brand: brands.jobrez, page: "job_rez" } });
    assert.equal(res.repaired, true);
    assert.deepEqual(res.json, GOOD);
    assert.equal(res.calls, 2);
    assert.equal(res.provider, "gemini");
    assert.equal(res.costUsd, 0);
    assert.equal(res.paidEquivalentUsd, Math.round(2 * costUsd(PRICES.gemini, 5000, 700) * 1e6) / 1e6);
    const bodies = h.fetchImpl.calls.map((c) => c.body);
    assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, "low");
    assert.equal(bodies[0].generationConfig.temperature, 0.7);
    assert.ok(bodies[1].contents[0].parts[0].text.includes("Return only the corrected JSON."));
    assert.ok(bodies[0].systemInstruction.parts[0].text.includes("This page is JobRez: no India-specific branding tokens"), "OF-2 rule phrased for the page");
    assert.equal(h.usage().length, 2);
    assert.equal(h.router.totalsFor("strategist").costUsd, 0);
    assert.equal(h.router.totalsFor("strategist").paidEquivalentUsd, res.paidEquivalentUsd);
    assert.deepEqual(h.sleeps, [7000]);
  } finally {
    h.cleanup();
  }
});

test("budget gate sums billed cost only: free Gemini projects USD 0, while a paid provider still projects its price-table cost", async () => {
  const h = harness({ usageSeed: [seedLine(20), seedLine(5)], queues: { gemini: [{ body: geminiBody(GOOD) }] }, processEnv: {} });
  try {
    await assert.rejects(h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), (e) => {
      assert.ok(e instanceof BudgetExhaustedError, e.message);
      assert.equal(e.agent, "writer");
      assert.equal(e.used, 25);
      assert.equal(e.limit, 25);
      assert.equal(e.estimate, 0, "a free-tier call adds no billed projection");
      assert.equal(e.flag, "budget_exhausted");
      assert.match(e.message, /budget_exhausted: USD 25\.00 of 25 used/);
      return true;
    });
    assert.equal(h.fetchImpl.calls.length, 0, "a spent month stops even a free call");
    assert.equal(h.usage().length, 2, "no new usage line");
    assert.deepEqual([...h.router.flags].sort(), ["budget_exhausted", "budget_warn"]);
  } finally {
    h.cleanup();
  }

  const h2 = harness({ usageSeed: [seedLine(24.97)], queues: { gemini: [{ body: geminiBody(GOOD) }] } });
  try {
    const res = await h2.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.costUsd, 0, "free Gemini does not cross the billed budget");
    assert.equal(h2.fetchImpl.calls.length, 1);
  } finally {
    h2.cleanup();
  }

  // The gate also runs before a repair, but both successful Gemini calls bill zero and preserve paid equivalents.
  const h3 = harness({ usageSeed: [seedLine(24.9)], queues: { gemini: [{ body: geminiBody(BAD, { promptTokenCount: 10000, candidatesTokenCount: 10000 }) }, { body: geminiBody(GOOD, { promptTokenCount: 10000, candidatesTokenCount: 10000 }) }] } });
  try {
    const res = await h3.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.repaired, true);
    assert.equal(res.costUsd, 0);
    assert.equal(res.paidEquivalentUsd, 0.09);
    assert.equal(h3.fetchImpl.calls.length, 2);
    assert.equal(h3.usage()[1].costUsd, 0);
    assert.equal(h3.usage()[1].paidEquivalentUsd, 0.045);
  } finally {
    h3.cleanup();
  }

  const paidRoster = structuredClone(roster);
  Object.assign(paidRoster.agents.find((a) => a.name === "writer"), { provider: "anthropic", model: "claude-sonnet-5-5", fallback: ["gemini", "openai"] });
  const h4 = harness({ usageSeed: [seedLine(24.97)], companyRoster: paidRoster, queues: { anthropic: [{ body: anthropicBody(GOOD) }] } });
  try {
    await assert.rejects(h4.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), (e) => e instanceof BudgetExhaustedError && e.estimate > 0);
    assert.equal(h4.fetchImpl.calls.length, 0, "the paid provider's estimate would cross the budget");
  } finally {
    h4.cleanup();
  }
});

test("budget: from warnAtPct the call proceeds and flags budget_warn", async () => {
  const h = harness({ usageSeed: [seedLine(21)], queues: { gemini: [{ body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.deepEqual(res.json, GOOD);
    assert.deepEqual([...h.router.flags], ["budget_warn"]);
    assert.equal(h.usage().length, 2);
  } finally {
    h.cleanup();
  }
  const soft = structuredClone(config);
  soft.budget.hardStop = false;
  const dir = tmpDir("hoshlab-router-");
  try {
    const state = createState({ companyDir: dir, now: NOW });
    state.appendLog("usage", seedLine(40), USAGE_SPEC);
    const fetchImpl = fakeFetch({ gemini: [{ body: geminiBody(GOOD) }] });
    const router = createRouter({ config: soft, roster, state, env: readEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], KEYS), fetchImpl, now: NOW, runId: RUN_ID, charters, processEnv: {} });
    const res = await router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "gemini", "hardStop:false never blocks");
    assert.deepEqual([...router.flags], ["budget_warn"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MOCK_LLM=1 → every agent is served from tests/fixtures/llm with mock:true, costUsd 0, provider mock, no fetch; the budget gate still applies", async () => {
  const fixtures = tmpDir("hoshlab-llm-fixtures-");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "writer.ok.json"), JSON.stringify({ agent: "writer", case: "ok", output: GOOD, usage: { inputTokens: 5800, outputTokens: 900 } }), "utf8");
  writeFileSync(join(fixtures, "writer.bad.json"), JSON.stringify({ agent: "writer", case: "bad", output: BAD, usage: { inputTokens: 1, outputTokens: 1 } }), "utf8");
  const h = harness({ keys: {}, processEnv: { MOCK_LLM: "1" }, fixturesDir: fixtures });
  try {
    assert.equal(h.router.isMock, true);
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } });
    assert.deepEqual(res.json, GOOD);
    assert.equal(res.mock, true);
    assert.equal(res.provider, "mock");
    assert.equal(res.model, "mock");
    assert.equal(res.costUsd, 0);
    assert.equal(h.fetchImpl.calls.length, 0, "no network even though no keys are set");
    const lines = h.usage();
    assert.equal(lines.length, 1);
    assert.equal(validate(lines[0], USAGE_SPEC).ok, true);
    assert.equal(lines[0].mock, true);
    assert.equal(lines[0].provider, "mock");
    assert.equal(lines[0].costUsd, 0);
    assert.deepEqual([lines[0].inputTokens, lines[0].outputTokens], [5800, 900]);
    assert.deepEqual(res.raw, { status: 200, id: "mock:writer.ok" });
  } finally {
    h.cleanup();
  }
  // a bad fixture → one repair (same fixture again) → AgentOutputError after exactly two mock calls
  const hb = harness({ keys: {}, processEnv: { MOCK_LLM: "1", MOCK_LLM_CASE_WRITER: "bad" }, fixturesDir: fixtures });
  try {
    await assert.rejects(hb.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), (e) => e instanceof AgentOutputError && e.calls === 2 && e.provider === "mock");
    assert.equal(hb.usage().length, 2);
  } finally {
    hb.cleanup();
  }
  // a missing fixture surfaces as MockFixtureError (never fabricated); the failed attempt is still a usage line
  const hm = harness({ keys: {}, processEnv: { MOCK_LLM: "1" }, fixturesDir: fixtures });
  try {
    await assert.rejects(hm.router.complete("strategist", { task: TASK, spec: SPEC, context: { brand: brands.jobrez } }), (e) => e.name === "MockFixtureError");
    assert.equal(hm.usage().length, 1);
    assert.equal(hm.usage()[0].ok, false);
    assert.match(hm.usage()[0].error, /MockFixtureError: mock: fixture missing/);
  } finally {
    hm.cleanup();
  }
  // M5.4: with the budget spent, MOCK_LLM unset → BudgetExhaustedError, never a mock answer
  const hx = harness({ keys: KEYS, processEnv: {}, usageSeed: [seedLine(25)], fixturesDir: fixtures });
  try {
    await assert.rejects(hx.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), BudgetExhaustedError);
    assert.equal(hx.fetchImpl.calls.length, 0);
  } finally {
    hx.cleanup();
  }
  // MOCK_LLM must be exactly '1'
  const hn = harness({ keys: {}, processEnv: { MOCK_LLM: "true" }, fixturesDir: fixtures });
  try {
    assert.equal(hn.router.isMock, false);
    await assert.rejects(hn.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), AllProvidersFailedError);
  } finally {
    hn.cleanup();
    rmSync(fixtures, { recursive: true, force: true });
  }
});

test("createRouter guards: deterministic agents, missing charter, missing config; default runId and env", async () => {
  const h = harness({ queues: {} });
  try {
    await assert.rejects(h.router.complete("designer", { task: {}, spec: SPEC }), /deterministic/);
    const dir = tmpDir("hoshlab-router-");
    try {
      const bare = createRouter({ config, roster, state: createState({ companyDir: dir, now: NOW }), fetchImpl: h.fetchImpl, processEnv: {}, now: NOW });
      await assert.rejects(bare.complete("writer", { task: {}, spec: SPEC }), /no charter for agent writer/);
      assert.match(bare.runId, /^engine-local-20261012-0531-[0-9a-f]{6}$/);
      assert.equal(bare.isMock, false);
      const envelope = bare.envelope("writer", { task: TASK, context: { charterMarkdown: "## Identity\nx\n## Method\ny\n## Output\nz", brand: brands.kaatdo, page: config.pages[1] } });
      assert.ok(envelope.system.startsWith("## Identity"));
      assert.ok(envelope.system.includes("The only Devanagari allowed on this page: \"काट दो\"."));
      assert.ok(envelope.tokensEstimate > 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.throws(() => createRouter({ config, roster }), /config, roster and state are required/);
  } finally {
    h.cleanup();
  }
});

test("validateOutput: null / array / shape errors; an agent's semantic validate() runs only on a valid shape", () => {
  assert.deepEqual(validateOutput(null, SPEC), ["$: no JSON object found in the model output"]);
  assert.deepEqual(validateOutput([1], SPEC), ["$: no JSON object found in the model output"]);
  assert.deepEqual(validateOutput(GOOD, SPEC), []);
  assert.ok(validateOutput(BAD, SPEC).length >= 2);
  assert.deepEqual(validateOutput({ anything: 1 }, null), [], "no spec → no validation");
  const semantic = (json) => (json.factsUsed.some((f) => f.factId === "rp-f12") ? ["$.factsUsed[0].factId: rp-f12 is disputed"] : []);
  assert.deepEqual(validateOutput(GOOD, SPEC, semantic), []);
  assert.deepEqual(validateOutput({ ...GOOD, factsUsed: [{ factId: "rp-f12", quote: "x" }] }, SPEC, semantic), ["$.factsUsed[0].factId: rp-f12 is disputed"]);
  assert.deepEqual(validateOutput(BAD, SPEC, () => { throw new Error("never reached on a bad shape"); }).length >= 2, true);
  assert.deepEqual(validateOutput(GOOD, SPEC, () => "one string"), ["one string"]);
  assert.deepEqual(validateOutput(GOOD, SPEC, () => null), []);
  assert.deepEqual(validateOutput(GOOD, SPEC, () => [null, "", "x"]), ["x"]);
});

test("complete({ validate }): a shape-valid answer that fails the agent's semantic check gets the single repair call with those errors; a valid repair → repaired:true, a second failure → AgentOutputError", async () => {
  const disputed = { ...GOOD, factsUsed: [{ factId: "rp-f12", quote: "12 languages" }] };
  const semantic = (json) => json.factsUsed.filter((f) => f.factId === "rp-f12").map((_, i) => `$.factsUsed[${i}].factId: rp-f12 is not a usable fact of @rishtapatra`);
  const h = harness({ queues: { gemini: [{ body: geminiBody(disputed) }, { body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra }, validate: semantic });
    assert.equal(res.repaired, true);
    assert.equal(res.calls, 2);
    assert.deepEqual(res.json, GOOD);
    const repair = h.fetchImpl.calls[1].body.contents[0].parts[0].text;
    assert.ok(repair.includes("Your previous output failed validation: $.factsUsed[0].factId: rp-f12 is not a usable fact of @rishtapatra. Return only the corrected JSON."), repair);
    assert.deepEqual(h.sleeps, [7000]);
  } finally {
    h.cleanup();
  }
  const h2 = harness({ queues: { gemini: [{ body: geminiBody(disputed) }] } });
  try {
    await assert.rejects(h2.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra }, validate: semantic }), (e) => e instanceof AgentOutputError && e.calls === 2 && e.repairErrors[0].includes("rp-f12"));
    assert.equal(h2.fetchImpl.calls.length, 2, "never a third call");
  } finally {
    h2.cleanup();
  }
});

test("prompt envelope: charter + seven house rules + context (today IST, page, voice, usable facts, pricing, disclaimers, forbidden, domains, memo, digest) + output", () => {
  const brand = brands.kaatdo;
  const page = config.pages.find((p) => p.handle === "kaatdo");
  const env = buildEnvelope({ agent: "writer", charterMarkdown: charters.writer.text, brand, config, page, todayIst: new Date(NOW), memoExcerpt: "Lead with the kill switch.", feedbackDigest: "Owner rejected rp-x: tone too salesy.", extra: { slotAt: "2026-10-13T08:15:00+05:30" }, task: TASK });
  assert.equal(env.user, JSON.stringify(TASK));
  assert.equal(env.tokensEstimate, Math.ceil(env.system.length / 4) + Math.ceil(env.user.length / 4));
  const order = [env.system.indexOf("# Writer"), env.system.indexOf(HOUSE_RULES_HEADING), env.system.indexOf(CONTEXT_HEADING), env.system.indexOf(OUTPUT_HEADING)];
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `section order ${order}`);
  const rules = houseRules({ brand, page });
  assert.equal(rules.length, 7);
  for (const r of rules) assert.ok(env.system.includes(r), r);
  assert.match(rules[0], /fact id/);
  assert.match(rules[1], /Never invent numbers, counts, testimonials, ratings, awards, prices or dates/);
  assert.equal(rules[2], "Emoji: none — do not use emoji anywhere (caption, hashtags, alt text, artwork).");
  assert.equal(rules[3], 'Write only in the page\'s languages: English. The only Devanagari allowed on this page: "काट दो".');
  assert.match(rules[4], /Never mention Hoshlab, agents, models or AI/);
  assert.match(rules[5], /^JobRez \(@job_rez\) only: no India-specific branding tokens/);
  assert.match(rules[6], /Disclaimers table verbatim/);
  assert.ok(env.system.includes("- Today (IST): 2026-10-12 (Monday)"));
  assert.ok(env.system.includes("- Page: @kaatdo — KaatDo (काट दो), site https://kaatdo.com, languages: English, emoji: none, mode: approve_first"));
  assert.ok(env.system.includes("### Voice\n- Terse, console-like"));
  assert.ok(env.system.includes("| kd-f10 |"));
  assert.ok(env.system.includes("| monthly | ₹999 |"));
  assert.ok(env.system.includes('- always → include one of: "not investment advice"; and one of: "not registered with SEBI" | "not SEBI-registered"; and one of: "execution is never guaranteed" | "always watch your positions with your broker"'));
  assert.ok(env.system.includes("- `(?<!never\\s)\\bguaranteed\\b`"));
  assert.ok(env.system.includes("### Allowed link domains\n- kaatdo.com"));
  assert.ok(env.system.includes("### CEO memo (excerpt)\nLead with the kill switch."));
  assert.ok(env.system.includes("### Owner feedback and observations\nOwner rejected rp-x: tone too salesy."));
  assert.ok(env.system.includes('"slotAt": "2026-10-13T08:15:00+05:30"'));
  assert.ok(env.system.includes("Return a single JSON object and nothing else"));

  // RishtaPatra: sparse emoji, two languages, trigger-based disclaimers; disputed rp-f12 excluded
  const rp = buildEnvelope({ agent: "writer", charterMarkdown: charters.writer.text, brand: brands.rishtapatra, config, page: "rishtapatra", todayIst: "2026-10-12", task: {} });
  assert.ok(rp.system.includes("Emoji: sparse — at most 2 per caption"));
  assert.ok(rp.system.includes("Write only in the page's languages: Hindi (Devanagari script) and English."));
  assert.ok(!rp.system.includes("| rp-f12 |"));
  assert.ok(rp.system.includes('- when the caption contains any of "kundali" | "कुंडली" | "horoscope" | "guna milan" → include one of: "indicative"; and one of: "consult your pandit" | "अपने पंडित से सलाह लें"'));
  assert.ok(rp.system.includes("- Today (IST): 2026-10-12\n"));
  assert.ok(!rp.system.includes("### Owner feedback and observations"), "digest omitted when empty");
  assert.ok(!rp.system.includes("### CEO memo"), "memo omitted when empty");

  // company-wide task (CEO) without a brand
  const ceo = buildEnvelope({ agent: "ceo", charterMarkdown: charters.ceo.text, todayIst: new Date(NOW), task: { brands: ["rishtapatra"] } });
  assert.ok(ceo.system.includes("- Page: none (company-wide task)"));
  assert.ok(ceo.system.includes("No single brand for this task"));
  assert.ok(ceo.system.includes("Emoji: none unless the brand's `emoji` policy"));
  assert.throws(() => buildEnvelope({ agent: "ceo", charterMarkdown: "", task: {} }), /charterMarkdown is required/);
});
