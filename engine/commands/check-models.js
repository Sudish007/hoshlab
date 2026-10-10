// check-models (design.md §16 "optionally validates", plan D20): for every enabled provider, report
// whether its secret is present, whether each configured model id is in the provider's model list,
// whether its prices are configured, and which request fields the model ignores. Exit 0 only when
// every enabled provider validated. Never prints key material: secrets live in variables and every
// line goes through log.scrub().
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
  return notes.length ? ` (${notes.join("; ")})` : "";
}

// checkModels({ config, env, fetchImpl, timeoutMs, adapters }) → { ok, providers: [{ name, ok, lines[] }], lines[] }
export async function checkModels({ config, env, fetchImpl, timeoutMs = 30000, adapters = ADAPTERS }) {
  const providers = [];
  const secrets = typeof env.secrets === "function" ? env.secrets() : [];
  const clean = (s) => scrub(s, secrets);
  for (const [name, p] of Object.entries(config.providers || {})) {
    if (!p.enabled) continue;
    const lines = [];
    let ok = true;
    const fail = (line) => {
      ok = false;
      lines.push(clean(line));
    };
    if (!env.present[p.secret]) {
      fail(NOT_CONFIGURED(name, p.secret));
      providers.push({ name, ok, lines });
      continue;
    }
    const shape = env.shape(p.secret);
    if (!shape.ok) {
      fail(`${name}: ${shape.reason} — not configured yet`);
      providers.push({ name, ok, lines });
      continue;
    }
    const adapter = adapters[name];
    if (!adapter || typeof adapter.listModels !== "function") {
      fail(`${name}: no adapter for this provider`);
      providers.push({ name, ok, lines });
      continue;
    }
    let ids = null;
    try {
      ids = await adapter.listModels({ endpoint: p.endpoint, apiKey: env.get(p.secret), apiVersion: p.apiVersion, fetchImpl, timeoutMs });
    } catch (err) {
      const reason = err instanceof LlmError ? err.message : `${err.name}: ${err.message}`;
      fail(`${name}: model list request failed — ${reason}`);
    }
    for (const [modelId, price] of Object.entries(p.models || {})) {
      if (ids) {
        if (ids.includes(modelId)) lines.push(clean(`${name}: ${modelId} ok${modelNotes(price)}`));
        else fail(`${name}: ${modelId} unknown model id (${ids.length} model${ids.length === 1 ? "" : "s"} listed by the provider)`);
      }
      if (!priceConfigured(price)) fail(`${name}: ${modelId} prices not configured yet (inputPerMTok / outputPerMTok / maxOutputTokens)`);
    }
    if (p.pricesVerifiedAt) lines.push(`${name}: prices verified ${p.pricesVerifiedAt} (${p.priceSource || "source not recorded"})`);
    providers.push({ name, ok, lines });
  }
  const validated = providers.filter((p) => p.ok).length;
  const summary = `check-models: ${validated} of ${providers.length} enabled provider${providers.length === 1 ? "" : "s"} validated`;
  return { ok: providers.length > 0 && validated === providers.length, providers, lines: [...providers.flatMap((p) => p.lines), summary], summary };
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
