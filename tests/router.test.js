import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, tmpDir } from "./helpers.js";
import { loadCompany } from "../src/lib/company.js";
import { createState } from "../engine/lib/state.js";
import { readEnv } from "../engine/lib/env.js";
import { USAGE_SPEC, validate } from "../engine/lib/schema.js";
import { AgentOutputError, AllProvidersFailedError, BACKOFF_MS, BudgetExhaustedError, REPAIR_SENTENCE, createRouter, resolveAgent, validateOutput } from "../engine/llm/router.js";
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
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status || 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

function harness({ keys = KEYS, processEnv = {}, queues = {}, usageSeed = [], now = NOW, fixturesDir } = {}) {
  const dir = tmpDir("hoshlab-router-");
  const state = createState({ companyDir: dir, now });
  for (const row of usageSeed) state.appendLog("usage", row, USAGE_SPEC);
  const sleeps = [];
  const fetchImpl = fakeFetch(queues);
  const env = readEnv(Object.values(config.providers).map((p) => p.secret), keys);
  const router = createRouter({ config, roster, state, env, fetchImpl, sleep: async (ms) => void sleeps.push(ms), now, runId: RUN_ID, charters, processEnv, fixturesDir });
  const usage = () => state.readJsonl(state.monthLogPath("usage"));
  return { dir, state, router, fetchImpl, sleeps, usage, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const seedLine = (cost, at = "2026-10-05T05:31:00+05:30") => ({ at, runId: "engine-daily-20261005-0531-aaaaaa", agent: "writer", page: "kaatdo", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 1, costUsd: cost, ms: 1, ok: true, mock: false });

test("resolveAgent: fallback order from the roster, fallback models = the provider's own table entry, temperature/maxOutputTokens per roster, acceptsTemperature from config", () => {
  const writer = resolveAgent(roster, config, "writer");
  assert.deepEqual(
    writer.chain.map((c) => [c.provider, c.model]),
    [
      ["anthropic", "claude-sonnet-5-5"],
      ["gemini", "gemini-3.8-flash"],
      ["openai", "gpt-6-luna"],
    ],
  );
  assert.equal(writer.temperature, 0.8);
  assert.equal(writer.maxOutputTokens, 4000);
  assert.equal(writer.chain[0].acceptsTemperature, false, "claude-sonnet-5-5 returns 400 on a non-default temperature (FEAT-102 findings)");
  assert.equal(writer.chain[1].acceptsTemperature, true);
  assert.equal(writer.chain[1].reasoning, "low");
  assert.equal(writer.chain[2].reasoning, "low");
  assert.equal(writer.chain[0].secret, "ANTHROPIC_API_KEY");
  assert.equal(writer.chain[0].apiVersion, "2023-06-01");
  assert.deepEqual(resolveAgent(roster, config, "ceo").chain.map((c) => c.provider), ["anthropic", "openai", "gemini"]);
  assert.deepEqual(resolveAgent(roster, config, "qa").chain.map((c) => c.provider), ["gemini", "anthropic"]);
  assert.equal(resolveAgent(roster, config, "qa").temperature, 0);
  assert.equal(resolveAgent(roster, config, "qa").maxOutputTokens, 2000);
  assert.throws(() => resolveAgent(roster, config, "designer"), /deterministic/);
  assert.throws(() => resolveAgent(roster, config, "publisher"), /deterministic/);
  assert.throws(() => resolveAgent(roster, config, "nobody"), /unknown agent/);
});

test("happy path: primary provider answers; one usage line ok:true with costUsd from the config price table (P1-05); totals; no temperature sent to claude-sonnet-5-5", async () => {
  const h = harness({ queues: { anthropic: [{ body: anthropicBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: config.pages[0] } });
    assert.deepEqual(res.json, GOOD);
    assert.equal(res.provider, "anthropic");
    assert.equal(res.model, "claude-sonnet-5-5");
    assert.equal(res.mock, false);
    assert.equal(res.calls, 1);
    assert.equal(res.repaired, false);
    assert.equal(res.costUsd, costUsd(PRICES.anthropic, 6000, 900));
    assert.equal(res.costUsd, 0.021);
    assert.equal(h.fetchImpl.calls.length, 1);
    const body = h.fetchImpl.calls[0].body;
    assert.equal("temperature" in body, false, "roster 0.8 omitted for an acceptsTemperature:false model");
    assert.equal(body.max_tokens, 4000);
    assert.ok(body.system.includes("# Writer"), "charter first");
    assert.ok(body.system.includes(HOUSE_RULES_HEADING));
    assert.ok(body.system.includes("| rp-f07 |"), "usable facts table in the context block");
    assert.ok(!body.system.includes("| rp-f12 |"), "disputed fact excluded (P1-04)");
    assert.equal(body.messages[0].content.startsWith(JSON.stringify(TASK)), true, "user = JSON.stringify(task)");
    const lines = h.usage();
    assert.equal(lines.length, 1);
    assert.equal(validate(lines[0], USAGE_SPEC).ok, true);
    assert.equal(lines[0].ok, true);
    assert.equal(lines[0].agent, "writer");
    assert.equal(lines[0].page, "rishtapatra");
    assert.equal(lines[0].provider, "anthropic");
    assert.equal(lines[0].model, "claude-sonnet-5-5");
    assert.equal(lines[0].inputTokens, 6000);
    assert.equal(lines[0].outputTokens, 900);
    assert.equal(lines[0].costUsd, 0.021);
    assert.equal(lines[0].mock, false);
    assert.equal(lines[0].runId, RUN_ID);
    assert.equal(lines[0].at, NOW);
    assert.equal(h.state.monthLogPath("usage"), "state/usage/2026-10.jsonl");
    assert.deepEqual(h.router.totalsFor("writer"), { calls: 1, ok: 1, failed: 0, costUsd: 0.021, ms: lines[0].ms, inputTokens: 6000, outputTokens: 900 });
    assert.deepEqual([...h.router.flags], []);
    assert.equal(h.sleeps.length, 0);
    assert.equal(FETCH_ATTEMPTS.length, 0, "no call reached the guarded global fetch");
  } finally {
    h.cleanup();
  }
});

test("429 is retried twice on the same provider with sleeps [2000, 8000], then the first fallback answers; a usage line per attempt incl. failures; the api key never appears in an error", async () => {
  const h = harness({ queues: { anthropic: [{ status: 429, body: { error: { type: "rate_limit_error", message: `slow down ${KEYS.ANTHROPIC_API_KEY}` } } }], gemini: [{ body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } });
    assert.equal(res.provider, "gemini");
    assert.equal(res.model, "gemini-3.8-flash");
    assert.equal(res.calls, 4);
    assert.deepEqual(h.sleeps, BACKOFF_MS);
    assert.deepEqual(BACKOFF_MS, [2000, 8000]);
    assert.deepEqual(
      h.fetchImpl.calls.map((c) => c.provider),
      ["anthropic", "anthropic", "anthropic", "gemini"],
    );
    const gBody = h.fetchImpl.calls[3].body;
    assert.equal(gBody.generationConfig.temperature, 0.8, "roster temperature travels to the fallback model");
    assert.deepEqual(gBody.generationConfig.thinkingConfig, { thinkingLevel: "low" });
    const lines = h.usage();
    assert.equal(lines.length, 4);
    for (const l of lines) assert.equal(validate(l, USAGE_SPEC).ok, true);
    assert.deepEqual(
      lines.map((l) => [l.provider, l.ok]),
      [
        ["anthropic", false],
        ["anthropic", false],
        ["anthropic", false],
        ["gemini", true],
      ],
    );
    for (const l of lines.slice(0, 3)) {
      assert.match(l.error, /anthropic: HTTP 429/);
      assert.ok(!l.error.includes(KEYS.ANTHROPIC_API_KEY), "key scrubbed from the usage line");
      assert.equal(l.costUsd, 0);
      assert.equal(l.inputTokens, 0);
    }
    assert.equal(lines[3].costUsd, costUsd(PRICES.gemini, 5000, 700));
    assert.equal(res.costUsd, lines[3].costUsd);
    assert.deepEqual([...h.router.flags], [], "429 is not provider_down");
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].attempts, 3);
    assert.equal(h.router.totalsFor("writer").failed, 3);
  } finally {
    h.cleanup();
  }
});

test("401 flags provider_down:<name> and falls back immediately (no sleep); 400/403/404 fall back immediately without the flag", async () => {
  const h = harness({ queues: { anthropic: [{ status: 401, body: { error: { message: "invalid x-api-key" } } }], gemini: [{ body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "gemini");
    assert.deepEqual(h.sleeps, []);
    assert.deepEqual(
      h.fetchImpl.calls.map((c) => c.provider),
      ["anthropic", "gemini"],
    );
    assert.deepEqual([...h.router.flags], ["provider_down:anthropic"]);
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
  const h = harness({ keys: { GEMINI_API_KEY: KEYS.GEMINI_API_KEY, OPENAI_API_KEY: KEYS.OPENAI_API_KEY }, queues: { gemini: [{ body: geminiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } });
    assert.equal(res.provider, "gemini");
    assert.deepEqual(
      h.fetchImpl.calls.map((c) => c.provider),
      ["gemini"],
    );
    assert.equal(h.usage().length, 1);
    assert.deepEqual(res.failures, [{ provider: "anthropic", model: "claude-sonnet-5-5", status: null, reason: "skipped: secret ANTHROPIC_API_KEY missing", attempts: 0 }]);
  } finally {
    h.cleanup();
  }
  const disabledConfig = structuredClone(config);
  disabledConfig.providers.anthropic.enabled = false;
  const dir = tmpDir("hoshlab-router-");
  try {
    const state = createState({ companyDir: dir, now: NOW });
    const fetchImpl = fakeFetch({ gemini: [{ body: geminiBody(GOOD) }] });
    const router = createRouter({ config: disabledConfig, roster, state, env: readEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], KEYS), fetchImpl, sleep: async () => {}, now: NOW, runId: RUN_ID, charters, processEnv: {} });
    const res = await router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "gemini");
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
          ["anthropic", 500, 3],
          ["gemini", 403, 1],
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
  const h = harness({ queues: { anthropic: [{ body: anthropicBody(BAD) }, { body: anthropicBody({ ...BAD, caption: "still bad" }) }, { body: anthropicBody(GOOD) }] } });
  try {
    await assert.rejects(h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra, page: "rishtapatra" } }), (e) => {
      assert.ok(e instanceof AgentOutputError, e.message);
      assert.equal(e.agent, "writer");
      assert.equal(e.provider, "anthropic");
      assert.equal(e.model, "claude-sonnet-5-5");
      assert.equal(e.calls, 2);
      assert.ok(e.errors.some((x) => /\$\.caption: expected string/.test(x)), e.errors.join("; "));
      assert.ok(e.errors.some((x) => /\$\.factsUsed: required/.test(x)));
      assert.ok(e.repairErrors.length >= 1);
      assert.match(e.message, /after one repair call/);
      return true;
    });
    assert.equal(h.fetchImpl.calls.length, 2, "exactly one repair call, never a third");
    const repair = h.fetchImpl.calls[1].body.messages[0].content;
    const sentence = REPAIR_SENTENCE(["$.caption: expected string"]).split("$.caption")[0];
    assert.ok(repair.includes("Your previous output failed validation: "), repair);
    assert.ok(repair.includes("$.caption: expected string"));
    assert.ok(repair.includes("Return only the corrected JSON."));
    assert.ok(repair.includes(sentence));
    assert.ok(repair.includes("## Previous output"));
    assert.ok(repair.includes(JSON.stringify(BAD)), "previous output quoted so the model can correct it");
    assert.ok(repair.startsWith(JSON.stringify(TASK)), "task still first");
    assert.equal(h.fetchImpl.calls[1].provider, "anthropic", "repair goes to the provider that answered");
    const lines = h.usage();
    assert.equal(lines.length, 2, "both completions are usage lines");
    assert.ok(lines.every((l) => l.ok === true), "a validation failure is not a transport failure");
    assert.equal(h.sleeps.length, 0);
  } finally {
    h.cleanup();
  }
});

test("invalid output then a valid repair → result.repaired true with the combined costUsd", async () => {
  const h = harness({ queues: { openai: [{ body: openaiBody(BAD) }, { body: openaiBody(GOOD) }] } });
  try {
    const res = await h.router.complete("strategist", { task: TASK, spec: SPEC, context: { brand: brands.jobrez, page: "job_rez" } });
    assert.equal(res.repaired, true);
    assert.deepEqual(res.json, GOOD);
    assert.equal(res.calls, 2);
    assert.equal(res.provider, "openai");
    assert.equal(res.costUsd, Math.round(2 * costUsd(PRICES.openai, 7000, 800) * 1e6) / 1e6);
    const bodies = h.fetchImpl.calls.map((c) => c.body);
    assert.equal(bodies[0].reasoning_effort, "low");
    assert.equal(bodies[0].temperature, 0.7);
    assert.equal(bodies[0].response_format.json_schema.name, "strategist_output");
    assert.ok(bodies[1].messages[1].content.includes("Return only the corrected JSON."));
    assert.ok(bodies[0].messages[0].content.includes("This page is JobRez: no India-specific branding tokens"), "OF-2 rule phrased for the page");
    assert.equal(h.usage().length, 2);
    assert.equal(h.router.totalsFor("strategist").costUsd, res.costUsd);
  } finally {
    h.cleanup();
  }
});

test("budget: at/over the monthly limit → BudgetExhaustedError before any call, flag budget_exhausted, no usage line, and NO mock output (M5.4)", async () => {
  const h = harness({ usageSeed: [seedLine(20), seedLine(5)], queues: { anthropic: [{ body: anthropicBody(GOOD) }] }, processEnv: {} });
  try {
    await assert.rejects(h.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), (e) => {
      assert.ok(e instanceof BudgetExhaustedError, e.message);
      assert.equal(e.agent, "writer");
      assert.equal(e.used, 25);
      assert.equal(e.limit, 25);
      assert.ok(e.estimate > 0);
      assert.equal(e.flag, "budget_exhausted");
      assert.match(e.message, /budget_exhausted: USD 25\.00 of 25 used/);
      return true;
    });
    assert.equal(h.fetchImpl.calls.length, 0, "no call");
    assert.equal(h.usage().length, 2, "no new usage line");
    assert.deepEqual([...h.router.flags].sort(), ["budget_exhausted", "budget_warn"]);
  } finally {
    h.cleanup();
  }
  // crossing the limit with the estimate of this call also stops; the estimate uses the roster maxOutputTokens
  const h2 = harness({ usageSeed: [seedLine(24.97)], queues: { anthropic: [{ body: anthropicBody(GOOD) }] } });
  try {
    await assert.rejects(h2.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), BudgetExhaustedError);
    assert.equal(h2.fetchImpl.calls.length, 0);
  } finally {
    h2.cleanup();
  }
  // the gate runs before EVERY attempt, the repair call included: the first answer bills USD 0.12
  // (10000 in × $2 + 10000 out × $10 per MTok) on top of 24.90, so the repair is refused.
  const h3 = harness({ usageSeed: [seedLine(24.9)], queues: { anthropic: [{ body: anthropicBody(BAD, { input_tokens: 10000, output_tokens: 10000 }) }] } });
  try {
    await assert.rejects(h3.router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } }), (e) => e instanceof BudgetExhaustedError && e.used === 25.02);
    assert.equal(h3.fetchImpl.calls.length, 1, "the first call went out, the repair did not");
    assert.equal(h3.usage().length, 2);
    assert.equal(h3.usage()[1].costUsd, 0.12);
    assert.ok(h3.router.flags.has("budget_exhausted"));
  } finally {
    h3.cleanup();
  }
});

test("budget: from warnAtPct the call proceeds and flags budget_warn", async () => {
  const h = harness({ usageSeed: [seedLine(21)], queues: { anthropic: [{ body: anthropicBody(GOOD) }] } });
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
    const fetchImpl = fakeFetch({ anthropic: [{ body: anthropicBody(GOOD) }] });
    const router = createRouter({ config: soft, roster, state, env: readEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], KEYS), fetchImpl, now: NOW, runId: RUN_ID, charters, processEnv: {} });
    const res = await router.complete("writer", { task: TASK, spec: SPEC, context: { brand: brands.rishtapatra } });
    assert.equal(res.provider, "anthropic", "hardStop:false never blocks");
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

test("validateOutput: null / array / shape errors", () => {
  assert.deepEqual(validateOutput(null, SPEC), ["$: no JSON object found in the model output"]);
  assert.deepEqual(validateOutput([1], SPEC), ["$: no JSON object found in the model output"]);
  assert.deepEqual(validateOutput(GOOD, SPEC), []);
  assert.ok(validateOutput(BAD, SPEC).length >= 2);
  assert.deepEqual(validateOutput({ anything: 1 }, null), [], "no spec → no validation");
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
  assert.ok(env.system.includes("### Owner feedback digest\nOwner rejected rp-x: tone too salesy."));
  assert.ok(env.system.includes('"slotAt": "2026-10-13T08:15:00+05:30"'));
  assert.ok(env.system.includes("Return a single JSON object and nothing else"));

  // RishtaPatra: sparse emoji, two languages, trigger-based disclaimers; disputed rp-f12 excluded
  const rp = buildEnvelope({ agent: "writer", charterMarkdown: charters.writer.text, brand: brands.rishtapatra, config, page: "rishtapatra", todayIst: "2026-10-12", task: {} });
  assert.ok(rp.system.includes("Emoji: sparse — at most 2 per caption"));
  assert.ok(rp.system.includes("Write only in the page's languages: Hindi (Devanagari script) and English."));
  assert.ok(!rp.system.includes("| rp-f12 |"));
  assert.ok(rp.system.includes('- when the caption contains any of "kundali" | "कुंडली" | "horoscope" | "guna milan" → include one of: "indicative"; and one of: "consult your pandit" | "अपने पंडित से सलाह लें"'));
  assert.ok(rp.system.includes("- Today (IST): 2026-10-12\n"));
  assert.ok(!rp.system.includes("### Owner feedback digest"), "digest omitted when empty");
  assert.ok(!rp.system.includes("### CEO memo"), "memo omitted when empty");

  // company-wide task (CEO) without a brand
  const ceo = buildEnvelope({ agent: "ceo", charterMarkdown: charters.ceo.text, todayIst: new Date(NOW), task: { brands: ["rishtapatra"] } });
  assert.ok(ceo.system.includes("- Page: none (company-wide task)"));
  assert.ok(ceo.system.includes("No single brand for this task"));
  assert.ok(ceo.system.includes("Emoji: none unless the brand's `emoji` policy"));
  assert.throws(() => buildEnvelope({ agent: "ceo", charterMarkdown: "", task: {} }), /charterMarkdown is required/);
});
