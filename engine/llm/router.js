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
// Per logical completion: resolve the roster's provider-level model ladder, then optional provider fallbacks.
// Each Gemini model gets one HTTP attempt, in configured order (maximum three); transient/capacity/rate errors
// and model-not-found semantics advance, while shared-key auth/permission failures stop the Gemini ladder.
// Retry-After / retryDelay is honoured before the next model, capped at 60 seconds. Paid provider fallbacks keep
// their existing bounded retries. After a model returns JSON, validation may make exactly one repair request on
// that same successful model. A missing or disabled provider is skipped without a call.
// Pacing from config.providers.<p>.minIntervalMs applies between every call to the same provider.
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
// Non-ladder paid providers retain the existing bounded retries. A Gemini ladder candidate is called once.
export const BACKOFF_MS = [2000, 8000];
export const MAX_ATTEMPTS_PER_PROVIDER = BACKOFF_MS.length + 1;
export const RATE_LIMIT_BACKOFF_MS = [10000, 20000, 40000];
export const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;
export const RATE_LIMIT_CAP_MS = 60000;
export const MAX_GEMINI_LADDER_ATTEMPTS = 3;
export const REPAIR_SENTENCE = (errors) => `Your previous output failed validation: ${errors.join("; ")}. Return only the corrected JSON.`;

// A server delay is honoured before moving to the next model. Without a hint, 429 uses the
// bounded rate-limit steps; other transient failures rely on the provider pacing floor.
export function rateLimitDelayMs(hintMs, retry) {
  const step = RATE_LIMIT_BACKOFF_MS[Math.min(retry, RATE_LIMIT_BACKOFF_MS.length - 1)];
  const hint = Number.isFinite(hintMs) && hintMs > 0 ? hintMs : 0;
  return Math.min(RATE_LIMIT_CAP_MS, Math.max(step, hint));
}

const GEMINI_MODEL_ERROR_RE = /(?:model(?:s\/[\w.-]+)?[\s\S]{0,100}(?:not found|not supported|unsupported|does not exist|not available|no longer available)|(?:not found|not supported|unsupported|not available|no longer available)[\s\S]{0,60}model)/i;
const GEMINI_TRANSIENT_RE = /(?:overload|high demand|capacity|temporar(?:y|ily)|unavailable|resource exhausted)/i;

// Shared-key auth/permission failures stop the Gemini ladder. A missing/unsupported model and
// capacity/rate/network failures move to the next configured model; other request errors stop it.
export function geminiFailureAction(err) {
  const status = Number(err && err.status) || 0;
  const message = String((err && err.message) || "");
  if (status === 401 || status === 403) return "stop_ladder";
  if ((status === 400 || status === 404) && GEMINI_MODEL_ERROR_RE.test(message)) return "next_model";
  if (status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599) || GEMINI_TRANSIENT_RE.test(message)) return "next_model";
  return "stop_ladder";
}

export function geminiLadderDelayMs(err, attempt) {
  if (geminiFailureAction(err) !== "next_model") return 0;
  if (Number.isFinite(err && err.retryAfterMs) && err.retryAfterMs > 0) return Math.min(RATE_LIMIT_CAP_MS, err.retryAfterMs);
  return Number(err && err.status) === 429 ? rateLimitDelayMs(null, attempt) : 0;
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
    thinkingBudget: price && Number.isInteger(price.thinkingBudget) ? price.thinkingBudget : undefined,
  };
}

// resolveAgent(roster, config, name) → { agent, chain: [candidate…], temperature, maxOutputTokens }
// A roster agent with modelLadder:true inherits the ordered model ids from its provider config; ids therefore
// live in config.json once rather than being copied into every agent. Optional fallback providers follow only
// after every model in that same-key ladder.
export function resolveAgent(roster, config, name) {
  const agent = (roster.agents || []).find((a) => a.name === name);
  if (!agent) throw new TypeError(`router: unknown agent ${name}`);
  if (agent.kind !== "llm") throw new TypeError(`router: agent ${name} is deterministic (kind ${agent.kind}) and never calls a model`);
  if (agent.enabled === false) throw new TypeError(`router: agent ${name} is disabled in the roster`);
  const providerConfig = config.providers[agent.provider];
  const configuredModels = agent.modelLadder === true ? (providerConfig && providerConfig.modelLadder) || [] : [agent.model || firstModel(providerConfig)].filter(Boolean);
  const models = agent.provider === "gemini" ? configuredModels.slice(0, MAX_GEMINI_LADDER_ATTEMPTS) : configuredModels;
  const chain = models.map((model) => candidate(config, agent.provider, model));
  if (!chain.length) chain.push(candidate(config, agent.provider, null));
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
  const completions = new Map();
  const mockEnabled = mockAdapter.isMockEnabled(processEnv);
  const secrets = () => (typeof environment.secrets === "function" ? environment.secrets() : []);
  const clean = (text) => scrub(text, secrets());
  // provider → nowMs() when its last call (success or failure) came back; the pacing floor counts from here
  const lastCallEndMs = new Map();

  function totalsFor(agent) {
    if (!totals.has(agent)) totals.set(agent, { calls: 0, ok: 0, failed: 0, costUsd: 0, paidEquivalentUsd: 0, freeTierCalls: 0, ms: 0, inputTokens: 0, outputTokens: 0 });
    return totals.get(agent);
  }

  function completionsFor(agent) {
    if (!completions.has(agent)) completions.set(agent, []);
    return completions.get(agent);
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
      model: isMock ? "mock" : c.model,
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

  // A Gemini ladder candidate is attempted exactly once. Other providers keep their bounded retries.
  // `oneAttempt` is also used for the single schema-repair completion on the model that succeeded.
  async function attemptProvider(agentName, c, { system, user, spec, tokensEstimate, maxOutputTokens, temperature, page }, failures, counter, { oneAttempt = false, ladderIndex = 0, repair = false } = {}) {
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
              thinkingBudget: c.thinkingBudget,
            });
      } catch (err) {
        const ms = Date.now() - started;
        if (!isMock) lastCallEndMs.set(c.provider, nowMs());
        if (!(err instanceof LlmError)) {
          record(agentName, page, c, null, { ok: false, error: clean(`${err.name}: ${err.message}`), ms, mock: isMock });
          throw err;
        }
        record(agentName, page, c, null, { ok: false, error: clean(err.message), ms, mock: isMock });
        if (err.status === 401 || err.status === 403) flags.add(`provider_down:${c.provider}`);
        if (oneAttempt) {
          const ladderAction = c.provider === "gemini" ? geminiFailureAction(err) : "stop_ladder";
          if (!repair) {
            const delay = c.provider === "gemini" ? geminiLadderDelayMs(err, ladderIndex) : 0;
            if (delay > 0) await sleep(delay);
          }
          failures.push({ provider: c.provider, model: c.model, status: err.status, retryable: err.retryable, reason: err.message, attempts, ladderAction });
          return null;
        }
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
    let geminiIndex = 0;
    const blockedProviders = new Set();
    for (const c of chain) {
      if (blockedProviders.has(c.provider)) continue;
      if (!c.enabled) {
        failures.push({ provider: c.provider, model: c.model, status: null, reason: "skipped: provider not enabled", attempts: 0 });
        blockedProviders.add(c.provider);
        continue;
      }
      if (c.provider !== "mock" && !environment.present[c.secret]) {
        failures.push({ provider: c.provider, model: c.model, status: null, reason: `skipped: secret ${c.secret} missing`, attempts: 0 });
        blockedProviders.add(c.provider);
        continue;
      }
      if (c.provider !== "mock" && !c.model) {
        failures.push({ provider: c.provider, model: null, status: null, reason: "skipped: no model configured", attempts: 0 });
        blockedProviders.add(c.provider);
        continue;
      }
      const isGemini = c.provider === "gemini";
      outcome = await attemptProvider(agentName, c, call, failures, counter, { oneAttempt: isGemini, ladderIndex: geminiIndex });
      if (isGemini) geminiIndex += 1;
      if (outcome) {
        used = c;
        break;
      }
      const failure = failures[failures.length - 1];
      if (isGemini && failure && failure.ladderAction === "stop_ladder") blockedProviders.add("gemini");
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
      const repair = await attemptProvider(agentName, used, { ...call, user: repairUser }, failures, counter, { oneAttempt: true, repair: true });
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
    completionsFor(agentName).push({ provider: used.provider, model: used.model, page });
    return {
      json,
      text: res.text,
      usage: res.usage,
      costUsd: cost,
      paidEquivalentUsd: paidEquivalent,
      provider: used.provider,
      model: used.model,
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
    completionsFor,
    runId: id,
    isMock: mockEnabled,
    resolve: (name) => resolveAgent(roster, config, name),
    envelope: (agentName, { task = {}, context = {} } = {}) => envelopeFor(agentName, task, context),
  };
}
