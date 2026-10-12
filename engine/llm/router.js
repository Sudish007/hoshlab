// LLM router (design.md §5 envelope, §7 routing and budget; review M5.4/M7/M9; plan D7/D9/D10; polish-gemini).
//
//   const router = createRouter({ config, roster, state, env, fetchImpl, sleep, now, nowMs, runId, charters });
//   const result = await router.complete('writer', { task, spec: OUTPUT_SPEC, context: { brand, page, memoExcerpt, feedbackDigest, extra }, validate });
//   // result: { json, text, usage, costUsd, paidEquivalentUsd, provider, model, ms, mock, calls, repaired, raw, estimate }
//   // validate(json) → errors[] is an optional semantic check (fact ids offered, sums ≤ 100 …) that
//   // runs after assertShape(spec) and feeds the same single repair call.
//   router.flags      Set of status flags raised during this run (budget_warn, budget_exhausted, provider_down:<name>)
//   router.totals     Map agent → { calls, ok, failed, costUsd, paidEquivalentUsd, ms, inputTokens, outputTokens }
//
// Per call: resolve provider/model/temperature/fallback from the roster → budget gate before EVERY
// attempt (BudgetExhaustedError, no call) → try the provider then each fallback. Failures on one provider:
//   HTTP 429 (rate limit) is retried up to MAX_RATE_LIMIT_RETRIES times on the same provider, waiting the server's
//   Retry-After / Gemini retryDelay hint or the exponential RATE_LIMIT_BACKOFF_MS step, whichever is longer, never
//   more than RATE_LIMIT_CAP_MS — a free tier allows few requests a minute, so the wait is worth more than a fallover;
//   other retryable failures (network, 408, 5xx) retry twice on the same provider with backoff 2 s then 8 s;
//   400/401/403/404 fall back immediately (401 also flags provider_down:<name>).
// Only then does the next provider get its turn; when none answers the call ends with AllProvidersFailedError.
// A provider whose secret is absent or which is not enabled is skipped without a call. Pacing: with
// config.providers.<p>.minIntervalMs the router waits so that two consecutive calls to that provider (any agent,
// this process) are at least that far apart, measured from the end of the previous call.
// Every attempt, success or failure, is one usage line: costUsd is what the provider bills — 0 on a free-tier
// provider (config tier 'free'), whose lines also carry paidEquivalentUsd (the price table's figure) so nothing
// is lost; the budget gate sums billed cost only, and a free-tier call adds 0 to its projection.
// The JSON is validated with assertShape(spec); on failure exactly one repair call is made, then AgentOutputError.
// MOCK_LLM=1 routes every agent to mock.js (usage lines mock:true, costUsd 0) — and nothing else does.
import { SchemaError, assertShape } from "../lib/schema.js";
import { readEnv } from "../lib/env.js";
import { scrub } from "../lib/log.js";
import { runId as makeRunId } from "../lib/ids.js";
import { canSpend, costUsd, estimateCostUsd, monthUsedUsd } from "../lib/budget.js";
import { DEFAULT_TIMEOUT_MS, LlmError, parseJson } from "./adapter.js";
import { buildEnvelope } from "./prompt.js";
import { logAttempt } from "./usage.js";
import * as anthropic from "./anthropic.js";
import * as gemini from "./gemini.js";
import * as openai from "./openai.js";
import * as mock from "./mock.js";

export const ADAPTERS = { anthropic, gemini, openai };
// Network / 408 / 5xx: two retries on the same provider, then the next provider.
export const BACKOFF_MS = [2000, 8000];
export const MAX_ATTEMPTS_PER_PROVIDER = BACKOFF_MS.length + 1;
// HTTP 429: three retries on the same provider; wait max(server hint, step), capped (polish-gemini).
export const RATE_LIMIT_BACKOFF_MS = [10000, 20000, 40000];
export const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;
export const RATE_LIMIT_CAP_MS = 60000;
export const REPAIR_SENTENCE = (errors) => `Your previous output failed validation: ${errors.join("; ")}. Return only the corrected JSON.`;

// rateLimitDelayMs(hintMs, retry) → how long to wait before 429 retry number `retry` (0-based): the server's
// Retry-After / retryDelay when it is longer than the exponential step, never more than RATE_LIMIT_CAP_MS.
export function rateLimitDelayMs(hintMs, retry) {
  const step = RATE_LIMIT_BACKOFF_MS[Math.min(retry, RATE_LIMIT_BACKOFF_MS.length - 1)];
  const hint = Number.isFinite(hintMs) && hintMs > 0 ? hintMs : 0;
  return Math.min(RATE_LIMIT_CAP_MS, Math.max(step, hint));
}

// providerTier(providerConfig) → 'free' | 'paid' ('paid' when the config says nothing).
export function providerTier(providerConfig) {
  return providerConfig && providerConfig.tier === "free" ? "free" : "paid";
}

export class BudgetExhaustedError extends Error {
  constructor(agent, gate) {
    super(`${agent}: ${gate.reason}`);
    this.name = "BudgetExhaustedError";
    this.agent = agent;
    this.used = gate.used;
    this.estimate = gate.estimate;
    this.limit = gate.limit;
    this.flag = "budget_exhausted";
  }
}

export class AgentOutputError extends Error {
  constructor({ agent, provider, model, errors, repairErrors = [], text = "", calls = 0 }) {
    super(`${agent}: output failed validation after one repair call (${provider}/${model}) — ${repairErrors.length ? repairErrors.slice(0, 5).join("; ") : errors.slice(0, 5).join("; ")}`);
    this.name = "AgentOutputError";
    this.agent = agent;
    this.provider = provider;
    this.model = model;
    this.errors = errors;
    this.repairErrors = repairErrors;
    this.text = text;
    this.calls = calls;
  }
}

export class AllProvidersFailedError extends Error {
  constructor(agent, failures) {
    super(`${agent}: no provider answered — ${failures.map((f) => `${f.provider}: ${f.reason}`).join(" | ") || "no provider configured"}`);
    this.name = "AllProvidersFailedError";
    this.agent = agent;
    this.failures = failures;
  }
}

function firstModel(providerConfig) {
  const ids = Object.keys((providerConfig && providerConfig.models) || {});
  return ids.length ? ids[0] : null;
}

function candidate(config, providerName, model) {
  const p = config.providers[providerName];
  if (!p) return { provider: providerName, enabled: false, model, price: null, tier: "paid", minIntervalMs: 0 };
  const id = model || firstModel(p);
  const price = id && p.models ? p.models[id] || null : null;
  return {
    provider: providerName,
    enabled: p.enabled === true,
    model: id,
    price,
    tier: providerTier(p),
    minIntervalMs: Number.isFinite(p.minIntervalMs) && p.minIntervalMs > 0 ? p.minIntervalMs : 0,
    secret: p.secret,
    endpoint: p.endpoint,
    apiVersion: p.apiVersion,
    acceptsTemperature: !(price && price.acceptsTemperature === false),
    reasoning: (price && price.reasoning) || undefined,
  };
}

// resolveAgent(roster, config, name) → { agent, chain: [candidate…], temperature, maxOutputTokens }
// chain = the agent's provider (its roster model) followed by each fallback provider (that provider's
// first configured model). Roster fallbacks name providers only (ROSTER_SPEC), so the model is the
// provider's own table entry. Each candidate carries the provider's tier ('free' | 'paid') and minIntervalMs.
export function resolveAgent(roster, config, name) {
  const agent = (roster.agents || []).find((a) => a.name === name);
  if (!agent) throw new TypeError(`router: unknown agent ${name}`);
  if (agent.kind !== "llm") throw new TypeError(`router: agent ${name} is deterministic (kind ${agent.kind}) and never calls a model`);
  if (agent.enabled === false) throw new TypeError(`router: agent ${name} is disabled in the roster`);
  const chain = [candidate(config, agent.provider, agent.model)];
  for (const fb of agent.fallback || []) if (!chain.some((c) => c.provider === fb)) chain.push(candidate(config, fb));
  return {
    agent,
    chain,
    temperature: Number.isFinite(agent.temperature) ? agent.temperature : undefined,
    maxOutputTokens: Number.isInteger(agent.maxOutputTokens) ? agent.maxOutputTokens : 4000,
  };
}

// validateOutput(json, spec, validate) → errors[] ('' when valid). `validate(json)` is an optional
// semantic check an agent adds on top of the shape (fact ids offered, budget split ≤ 100 …); it runs
// only when the shape is valid and returns a list of '<path>: <message>' strings (or nothing).
export function validateOutput(json, spec, validate) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return ["$: no JSON object found in the model output"];
  if (spec) {
    try {
      assertShape(json, spec);
    } catch (e) {
      if (e instanceof SchemaError) return e.errors;
      throw e;
    }
  }
  if (typeof validate !== "function") return [];
  const extra = validate(json);
  if (!extra) return [];
  return (Array.isArray(extra) ? extra : [extra]).filter((x) => x !== undefined && x !== null && x !== "").map(String);
}

function pageHandle(page) {
  if (typeof page === "string") return page;
  return page && typeof page.handle === "string" ? page.handle : undefined;
}

function clockOf(now) {
  return () => {
    const v = typeof now === "function" ? now() : now;
    return v instanceof Date ? v : new Date(v);
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// `now` is the business clock (IST month of the usage line, the envelope's today); `nowMs` is the elapsed-time
// clock the pacing floor uses (a daily run pins `now` to its start, so pacing cannot read it). Tests inject both.
export function createRouter({
  config,
  roster,
  state,
  env,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = () => new Date(),
  nowMs = () => Date.now(),
  runId,
  charters = {},
  processEnv = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fixturesDir,
  adapters = ADAPTERS,
  mockAdapter = mock,
} = {}) {
  if (!config || !roster || !state) throw new TypeError("router: config, roster and state are required");
  const clock = clockOf(now);
  const secretNames = Object.values(config.providers || {}).map((p) => p.secret);
  const environment = env || readEnv(secretNames, processEnv);
  const id = runId || makeRunId("engine-local", clock());
  const flags = new Set();
  const totals = new Map();
  const mockEnabled = mockAdapter.isMockEnabled(processEnv);
  const secrets = () => (typeof environment.secrets === "function" ? environment.secrets() : []);
  const clean = (text) => scrub(text, secrets());
  // provider → nowMs() when its last call (success or failure) came back; the pacing floor counts from here
  const lastCallEndMs = new Map();

  function totalsFor(agent) {
    if (!totals.has(agent)) totals.set(agent, { calls: 0, ok: 0, failed: 0, costUsd: 0, paidEquivalentUsd: 0, freeTierCalls: 0, ms: 0, inputTokens: 0, outputTokens: 0 });
    return totals.get(agent);
  }

  function charterFor(agentName, context) {
    if (typeof context.charterMarkdown === "string") return context.charterMarkdown;
    const c = charters[agentName];
    if (typeof c === "string") return c;
    if (c && typeof c.text === "string") return c.text;
    throw new TypeError(`router: no charter for agent ${agentName} (pass charters[agent] or context.charterMarkdown)`);
  }

  // The envelope (prompt.js) for one call: charter + house rules + context + output, user = task JSON.
  function envelopeFor(agentName, task, context) {
    return buildEnvelope({
      agent: agentName,
      charterMarkdown: charterFor(agentName, context),
      brand: context.brand || null,
      config,
      memoExcerpt: context.memoExcerpt || "",
      todayIst: context.todayIst || clock(),
      page: context.page || null,
      extra: context.extra,
      feedbackDigest: context.feedbackDigest || "",
      task,
    });
  }

  // Budget gate — before EVERY attempt. Throws BudgetExhaustedError (flag budget_exhausted) when
  // hardStop is on and the month is at/over the limit; flags budget_warn from warnAtPct. The estimate is
  // the call's worst case at the provider's billed rate: 0 on a free tier (nothing is billed), the price
  // table's figure otherwise — a spent month still stops a free-tier call (used ≥ limit).
  function gate(agentName, c, tokensEstimate, maxOutputTokens) {
    const used = monthUsedUsd(state, clock());
    const estimate = c.price && c.tier !== "free" ? estimateCostUsd(c.price, tokensEstimate, maxOutputTokens) : 0;
    const result = canSpend(config, used, estimate);
    if (result.warn) flags.add("budget_warn");
    if (!result.ok) {
      flags.add("budget_exhausted");
      throw new BudgetExhaustedError(agentName, result);
    }
    return result;
  }

  // Pacing floor (config providers.<p>.minIntervalMs): wait until the previous call to this provider ended at
  // least that long ago. Returns the ms waited (0 when no wait was needed or no floor is set).
  async function pace(c) {
    if (!(c.minIntervalMs > 0)) return 0;
    const last = lastCallEndMs.get(c.provider);
    if (last === undefined) return 0;
    const wait = last + c.minIntervalMs - nowMs();
    if (wait <= 0) return 0;
    await sleep(wait);
    return wait;
  }

  // One usage line + the agent's totals. Returns { costUsd, paidEquivalentUsd } of the attempt: on a free-tier
  // provider the bill is 0 and the price table's figure goes to paidEquivalentUsd (0 for a failed attempt, which
  // carries no tokens); on a paid tier both are the same figure; mock answers cost nothing either way.
  function record(agentName, page, c, res, { ok, error, ms, mock: isMock }) {
    const inputTokens = res && res.usage ? res.usage.inputTokens : 0;
    const outputTokens = res && res.usage ? res.usage.outputTokens : 0;
    // Failed attempts carry no token counts (no response body to bill); mock answers cost nothing.
    const atPaidRates = ok && !isMock && c.price ? costUsd(c.price, inputTokens, outputTokens) : 0;
    const free = !isMock && c.tier === "free";
    const cost = free ? 0 : atPaidRates;
    const { record: line } = logAttempt(state, {
      runId: id,
      agent: agentName,
      page,
      provider: isMock ? "mock" : c.provider,
      model: isMock ? "mock" : (res && res.model) || c.model,
      inputTokens,
      outputTokens,
      costUsd: cost,
      paidEquivalentUsd: free ? atPaidRates : undefined,
      ms,
      ok,
      error,
      mock: isMock,
    });
    const t = totalsFor(agentName);
    t.calls += 1;
    t[ok ? "ok" : "failed"] += 1;
    t.costUsd = round6(t.costUsd + cost);
    t.paidEquivalentUsd = round6(t.paidEquivalentUsd + (isMock ? 0 : atPaidRates));
    if (free) t.freeTierCalls += 1;
    t.ms += line.ms;
    t.inputTokens += line.inputTokens;
    t.outputTokens += line.outputTokens;
    return { costUsd: cost, paidEquivalentUsd: isMock ? 0 : atPaidRates };
  }

  // One provider: a 429 is retried up to MAX_RATE_LIMIT_RETRIES times (server hint / RATE_LIMIT_BACKOFF_MS, capped),
  // any other retryable failure up to BACKOFF_MS.length times; 400/401/403/404 end the provider at once.
  // Returns { res, costUsd, paidEquivalentUsd, attempts, budget } or null after pushing the final reason onto `failures`.
  async function attemptProvider(agentName, c, { system, user, spec, tokensEstimate, maxOutputTokens, temperature, page }, failures, counter) {
    const isMock = c.provider === "mock";
    let attempts = 0;
    let retries = 0;
    let rateLimitRetries = 0;
    for (;;) {
      const budget = gate(agentName, c, tokensEstimate, maxOutputTokens);
      if (!isMock) await pace(c);
      counter.calls += 1;
      attempts += 1;
      const started = Date.now();
      let res;
      try {
        res = isMock
          ? await mockAdapter.complete({ agent: agentName, processEnv, fixturesDir, page })
          : await adapters[c.provider].complete({
              system,
              user,
              spec,
              maxOutputTokens,
              temperature: c.acceptsTemperature ? temperature : undefined,
              timeoutMs,
              fetchImpl,
              model: c.model,
              apiKey: environment.get(c.secret),
              endpoint: c.endpoint,
              apiVersion: c.apiVersion,
              agent: agentName,
              reasoning: c.reasoning,
            });
      } catch (err) {
        const ms = Date.now() - started;
        if (!isMock) lastCallEndMs.set(c.provider, nowMs());
        if (!(err instanceof LlmError)) {
          record(agentName, page, c, null, { ok: false, error: clean(`${err.name}: ${err.message}`), ms, mock: isMock });
          throw err; // programming errors and missing mock fixtures surface unchanged
        }
        record(agentName, page, c, null, { ok: false, error: clean(err.message), ms, mock: isMock });
        if (err.status === 401) flags.add(`provider_down:${c.provider}`);
        if (err.status === 429) {
          if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
            await sleep(rateLimitDelayMs(err.retryAfterMs, rateLimitRetries));
            rateLimitRetries += 1;
            continue;
          }
        } else if (err.retryable && retries < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[retries]);
          retries += 1;
          continue;
        }
        failures.push({ provider: c.provider, model: c.model, status: err.status, retryable: err.retryable, reason: err.message, attempts });
        return null;
      }
      if (!isMock) lastCallEndMs.set(c.provider, nowMs());
      const cost = record(agentName, page, c, res, { ok: true, ms: res.ms, mock: isMock });
      return { res, costUsd: cost.costUsd, paidEquivalentUsd: cost.paidEquivalentUsd, attempts, budget };
    }
  }

  // complete(agentName, { task, spec, context, validate }) → result (see header). `validate(json)`
  // is the agent's optional semantic check; its errors go through the same single repair call.
  async function complete(agentName, { task = {}, spec = null, context = {}, validate } = {}) {
    const resolved = resolveAgent(roster, config, agentName);
    const { system, user, tokensEstimate } = envelopeFor(agentName, task, context);
    const page = pageHandle(context.page) || (context.brand && context.brand.frontMatter && context.brand.frontMatter.handle) || undefined;
    const call = { system, user, spec, tokensEstimate, maxOutputTokens: resolved.maxOutputTokens, temperature: resolved.temperature, page };
    const counter = { calls: 0 };
    const failures = [];

    const chain = mockEnabled ? [{ provider: "mock", model: "mock", price: resolved.chain[0].price, enabled: true, acceptsTemperature: true, tier: "paid", minIntervalMs: 0 }] : resolved.chain;
    let outcome = null;
    let used = null;
    for (const c of chain) {
      if (!c.enabled) {
        failures.push({ provider: c.provider, model: c.model, status: null, reason: "skipped: provider not enabled", attempts: 0 });
        continue;
      }
      if (c.provider !== "mock" && !environment.present[c.secret]) {
        failures.push({ provider: c.provider, model: c.model, status: null, reason: `skipped: secret ${c.secret} missing`, attempts: 0 });
        continue;
      }
      if (c.provider !== "mock" && !c.model) {
        failures.push({ provider: c.provider, model: null, status: null, reason: "skipped: no model configured", attempts: 0 });
        continue;
      }
      outcome = await attemptProvider(agentName, c, call, failures, counter);
      if (outcome) {
        used = c;
        break;
      }
    }
    if (!outcome) throw new AllProvidersFailedError(agentName, failures);

    let { res } = outcome;
    let cost = outcome.costUsd;
    let paidEquivalent = outcome.paidEquivalentUsd;
    let json = res.json !== undefined && res.json !== null ? res.json : parseJson(res.text);
    let errors = validateOutput(json, spec, validate);
    let repaired = false;
    if (errors.length) {
      // Exactly one repair call, on the provider that answered, carrying the previous output.
      const repairUser = `${user}\n\n## Previous output\n${res.text}\n\n${REPAIR_SENTENCE(errors)}`;
      const repair = await attemptProvider(agentName, used, { ...call, user: repairUser }, failures, counter);
      if (!repair) throw new AllProvidersFailedError(agentName, failures);
      const repairJson = repair.res.json !== undefined && repair.res.json !== null ? repair.res.json : parseJson(repair.res.text);
      const repairErrors = validateOutput(repairJson, spec, validate);
      cost = round6(cost + repair.costUsd);
      paidEquivalent = round6(paidEquivalent + repair.paidEquivalentUsd);
      if (repairErrors.length) {
        throw new AgentOutputError({ agent: agentName, provider: used.provider, model: used.model, errors, repairErrors, text: repair.res.text, calls: counter.calls });
      }
      res = repair.res;
      json = repairJson;
      repaired = true;
    }
    return {
      json,
      text: res.text,
      usage: res.usage,
      costUsd: cost,
      paidEquivalentUsd: paidEquivalent,
      provider: res.provider,
      model: res.model,
      ms: res.ms,
      mock: res.mock === true,
      calls: counter.calls,
      repaired,
      raw: res.raw,
      tokensEstimate,
      failures,
    };
  }

  return {
    complete,
    flags,
    totals,
    totalsFor,
    runId: id,
    isMock: mockEnabled,
    resolve: (name) => resolveAgent(roster, config, name),
    envelope: (agentName, { task = {}, context = {} } = {}) => envelopeFor(agentName, task, context),
  };
}
