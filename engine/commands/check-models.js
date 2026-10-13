// check-models: reports every configured model id and price without printing key material. A provider
// with a model ladder is required; paid fallback providers are cleanly skipped when their secret is absent.
// A ladder validates when its primary and at least one alternate are listed by the provider.
import { loadCompany } from "../../src/lib/company.js";
import { readEnv } from "../lib/env.js";
import { scrub } from "../lib/log.js";
import { LlmError } from "../llm/adapter.js";
import { ADAPTERS } from "../llm/router.js";

export const NOT_CONFIGURED = (provider, secret) => `${provider}: not configured yet (secret ${secret} missing)`;

function priceConfigured(price) {
  return price && Number.isFinite(price.inputPerMTok) && Number.isFinite(price.outputPerMTok) && Number.isInteger(price.maxOutputTokens);
}

function modelNotes(price) {
  const notes = [];
  if (price && price.acceptsTemperature === false) notes.push("temperature ignored by model (not sent)");
  if (price && price.reasoning) notes.push(`reasoning ${price.reasoning}`);
  if (price && Number.isInteger(price.thinkingBudget)) notes.push(`thinking budget ${price.thinkingBudget}`);
  return notes.length ? ` (${notes.join("; ")})` : "";
}

// A provider with modelLadder is required; providers used only as paid fallbacks are optional when their
// secret is absent. A ladder is ready when its primary and at least one alternate are listed. Every configured
// ladder model is still reported, and every price row is validated.
export async function checkModels({ config, env, fetchImpl, timeoutMs = 30000, adapters = ADAPTERS }) {
  const providers = [];
  const secrets = typeof env.secrets === "function" ? env.secrets() : [];
  const clean = (s) => scrub(s, secrets);
  for (const [name, p] of Object.entries(config.providers || {})) {
    if (!p.enabled) continue;
    const lines = [];
    const ladder = Array.isArray(p.modelLadder) ? p.modelLadder : [];
    const required = ladder.length > 0;
    let ok = true;
    let skipped = false;
    const fail = (line) => {
      ok = false;
      lines.push(clean(line));
    };
    if (!env.present[p.secret]) {
      if (required) fail(NOT_CONFIGURED(name, p.secret));
      else {
        skipped = true;
        lines.push(clean(`${name}: optional paid fallback skipped (secret ${p.secret} missing)`));
      }
      providers.push({ name, ok, skipped, required, lines });
      continue;
    }
    const shape = env.shape(p.secret);
    if (!shape.ok) {
      fail(`${name}: ${shape.reason} — not configured yet`);
      providers.push({ name, ok, skipped, required, lines });
      continue;
    }
    const adapter = adapters[name];
    if (!adapter || typeof adapter.listModels !== "function") {
      fail(`${name}: no adapter for this provider`);
      providers.push({ name, ok, skipped, required, lines });
      continue;
    }
    let ids = null;
    try {
      ids = await adapter.listModels({ endpoint: p.endpoint, apiKey: env.get(p.secret), apiVersion: p.apiVersion, fetchImpl, timeoutMs });
    } catch (err) {
      const reason = err instanceof LlmError ? err.message : `${err.name}: ${err.message}`;
      fail(`${name}: model list request failed — ${reason}`);
    }
    const available = new Set(ids || []);
    for (const [modelId, price] of Object.entries(p.models || {})) {
      if (ids) {
        if (available.has(modelId)) lines.push(clean(`${name}: ${modelId} available${modelNotes(price)}`));
        else if (ladder.includes(modelId)) lines.push(clean(`${name}: ${modelId} unavailable (${ids.length} model${ids.length === 1 ? "" : "s"} listed by the provider)`));
        else fail(`${name}: ${modelId} unknown model id (${ids.length} model${ids.length === 1 ? "" : "s"} listed by the provider)`);
      }
      if (!priceConfigured(price)) fail(`${name}: ${modelId} prices not configured yet (inputPerMTok / outputPerMTok / maxOutputTokens)`);
    }
    if (ids && ladder.length) {
      const primary = ladder[0];
      const alternates = ladder.slice(1);
      const availableAlternates = alternates.filter((id) => available.has(id));
      if (!available.has(primary)) fail(`${name}: ladder primary ${primary} is unavailable`);
      if (availableAlternates.length < 1) fail(`${name}: ladder has no available alternate (${alternates.join(", ") || "none configured"})`);
      if (available.has(primary) && availableAlternates.length > 0) lines.push(`${name}: automatic free-model ladder ready (primary ${primary}; ${availableAlternates.length} of ${alternates.length} alternates available)`);
    }
    if (p.pricesVerifiedAt) lines.push(`${name}: prices verified ${p.pricesVerifiedAt} (${p.priceSource || "source not recorded"})`);
    providers.push({ name, ok, skipped, required, lines });
  }
  const validated = providers.filter((p) => p.ok && !p.skipped).length;
  const skipped = providers.filter((p) => p.skipped).length;
  const checked = providers.length - skipped;
  const summary = skipped
    ? `check-models: ${validated} of ${checked} configured provider${checked === 1 ? "" : "s"} validated; ${skipped} optional provider${skipped === 1 ? "" : "s"} skipped`
    : `check-models: ${validated} of ${providers.length} enabled provider${providers.length === 1 ? "" : "s"} validated`;
  return { ok: checked > 0 && providers.every((p) => p.ok), providers, lines: [...providers.flatMap((p) => p.lines), summary], summary };
}

// CLI entry: ctx from engine/index.js → exit code.
export async function run({ companyDir, processEnv = process.env, fetchImpl = globalThis.fetch, stdout = console.log, stderr = console.error, flags = {} } = {}) {
  let company;
  try {
    company = loadCompany({ companyDir, warn: (m) => stderr(`warn: ${m}`) });
  } catch (err) {
    stderr(scrub(`check-models: cannot load company at ${companyDir}: ${err.message}`));
    return 1;
  }
  const { config } = company;
  const env = readEnv(Object.values(config.providers).map((p) => p.secret), processEnv);
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 30000;
  const result = await checkModels({ config, env, fetchImpl, timeoutMs });
  for (const line of result.lines) stdout(line);
  return result.ok ? 0 : 1;
}
