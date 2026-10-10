// LLM router (design.md §5 envelope, §7 routing and budget; review M5.4/M7/M9; plan D7/D9/D10).
//
//   const router = createRouter({ config, roster, state, env, fetchImpl, sleep, now, runId, charters });
//   const result = await router.complete('writer', { task, spec: OUTPUT_SPEC, context: { brand, page, memoExcerpt, feedbackDigest, extra } });
//   // result: { json, text, usage, costUsd, provider, model, ms, mock, calls, repaired, raw, estimate }
//   router.flags      Set of status flags raised during this run (budget_warn, budget_exhausted, provider_down:<name>)
//   router.totals     Map agent → { calls, ok, failed, costUsd, ms, inputTokens, outputTokens }
//
// Per call: resolve provider/model/temperature/fallback from the roster → budget gate before EVERY
// attempt (BudgetExhaustedError, no call) → try the provider then each fallback: retryable failures
// retry twice on the same provider with backoff 2 s then 8 s; 400/401/403/404 fall back immediately
// (401 also flags provider_down:<name>); a provider whose secret is absent or which is not enabled is
// skipped without a call. Every attempt, success or failure, is one usage line. The JSON is validated
// with assertShape(spec); on failure exactly one repair call is made, then AgentOutputError.
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
export const BACKOFF_MS = [2000, 8000];
export const MAX_ATTEMPTS_PER_PROVIDER = BACKOFF_MS.length + 1;
export const REPAIR_SENTENCE = (errors) => `Your previous output failed validation: ${errors.join("; ")}. Return only the corrected JSON.`;

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
  if (!p) return { provider: providerName, enabled: false, model, price: null };
  const id = model || firstModel(p);
  const price = id && p.models ? p.models[id] || null : null;
  return {
    provider: providerName,
    enabled: p.enabled === true,
    model: id,
    price,
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
// provider's own table entry.
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

// validateOutput(json, spec) → errors[] ('' when valid).
export function validateOutput(json, spec) {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return ["$: no JSON object found in the model output"];
  if (!spec) return [];
  try {
    assertShape(json, spec);
    return [];
  } catch (e) {
    if (e instanceof SchemaError) return e.errors;
    throw e;
  }
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

export function createRouter({
  config,
  roster,
  state,
  env,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = () => new Date(),
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

  function totalsFor(agent) {
    if (!totals.has(agent)) totals.set(agent, { calls: 0, ok: 0, failed: 0, costUsd: 0, ms: 0, inputTokens: 0, outputTokens: 0 });
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
  // hardStop is on and the month is at/over the limit; flags budget_warn from warnAtPct.
  function gate(agentName, price, tokensEstimate, maxOutputTokens) {
    const used = monthUsedUsd(state, clock());
    const estimate = price ? estimateCostUsd(price, tokensEstimate, maxOutputTokens) : 0;
    const result = canSpend(config, used, estimate);
    if (result.warn) flags.add("budget_warn");
    if (!result.ok) {
      flags.add("budget_exhausted");
      throw new BudgetExhaustedError(agentName, result);
    }
    return result;
  }

  function record(agentName, page, c, res, { ok, error, ms, mock: isMock }) {
    const inputTokens = res && res.usage ? res.usage.inputTokens : 0;
    const outputTokens = res && res.usage ? res.usage.outputTokens : 0;
    // Failed attempts carry no token counts (no response body to bill); mock answers cost nothing.
    const cost = ok && !isMock && c.price ? costUsd(c.price, inputTokens, outputTokens) : 0;
    const { record: line } = logAttempt(state, {
      runId: id,
      agent: agentName,
      page,
      provider: isMock ? "mock" : c.provider,
      model: isMock ? "mock" : (res && res.model) || c.model,
      inputTokens,
      outputTokens,
      costUsd: cost,
      ms,
      ok,
      error,
      mock: isMock,
    });
    const t = totalsFor(agentName);
    t.calls += 1;
    t[ok ? "ok" : "failed"] += 1;
    t.costUsd = Math.round((t.costUsd + cost) * 1e6) / 1e6;
    t.ms += line.ms;
    t.inputTokens += line.inputTokens;
    t.outputTokens += line.outputTokens;
    return cost;
  }

  // One provider, up to MAX_ATTEMPTS_PER_PROVIDER attempts. Returns { res, costUsd, attempts } or
  // null after pushing the final reason onto `failures`.
  async function attemptProvider(agentName, c, { system, user, spec, tokensEstimate, maxOutputTokens, temperature, page }, failures, counter) {
    const isMock = c.provider === "mock";
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PROVIDER; attempt++) {
      const budget = gate(agentName, c.price, tokensEstimate, maxOutputTokens);
      counter.calls += 1;
      const started = Date.now();
      let res;
      try {
        res = isMock
          ? await mockAdapter.complete({ agent: agentName, processEnv, fixturesDir })
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
        if (!(err instanceof LlmError)) {
          record(agentName, page, c, null, { ok: false, error: clean(`${err.name}: ${err.message}`), ms, mock: isMock });
          throw err; // programming errors and missing mock fixtures surface unchanged
        }
        record(agentName, page, c, null, { ok: false, error: clean(err.message), ms, mock: isMock });
        if (err.status === 401) flags.add(`provider_down:${c.provider}`);
        if (err.retryable && attempt < MAX_ATTEMPTS_PER_PROVIDER - 1) {
          await sleep(BACKOFF_MS[attempt]);
          continue;
        }
        failures.push({ provider: c.provider, model: c.model, status: err.status, retryable: err.retryable, reason: err.message, attempts: attempt + 1 });
        return null;
      }
      const cost = record(agentName, page, c, res, { ok: true, ms: res.ms, mock: isMock });
      return { res, costUsd: cost, attempts: attempt + 1, budget };
    }
    return null;
  }

  // complete(agentName, { task, spec, context }) → result (see header).
  async function complete(agentName, { task = {}, spec = null, context = {} } = {}) {
    const resolved = resolveAgent(roster, config, agentName);
    const { system, user, tokensEstimate } = envelopeFor(agentName, task, context);
    const page = pageHandle(context.page) || (context.brand && context.brand.frontMatter && context.brand.frontMatter.handle) || undefined;
    const call = { system, user, spec, tokensEstimate, maxOutputTokens: resolved.maxOutputTokens, temperature: resolved.temperature, page };
    const counter = { calls: 0 };
    const failures = [];

    const chain = mockEnabled ? [{ provider: "mock", model: "mock", price: resolved.chain[0].price, enabled: true, acceptsTemperature: true }] : resolved.chain;
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
    let json = res.json !== undefined && res.json !== null ? res.json : parseJson(res.text);
    let errors = validateOutput(json, spec);
    let repaired = false;
    if (errors.length) {
      // Exactly one repair call, on the provider that answered, carrying the previous output.
      const repairUser = `${user}\n\n## Previous output\n${res.text}\n\n${REPAIR_SENTENCE(errors)}`;
      const repair = await attemptProvider(agentName, used, { ...call, user: repairUser }, failures, counter);
      if (!repair) throw new AllProvidersFailedError(agentName, failures);
      const repairJson = repair.res.json !== undefined && repair.res.json !== null ? repair.res.json : parseJson(repair.res.text);
      const repairErrors = validateOutput(repairJson, spec);
      cost = Math.round((cost + repair.costUsd) * 1e6) / 1e6;
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
