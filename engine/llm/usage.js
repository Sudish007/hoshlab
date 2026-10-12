// usage/<IST month>.jsonl writer (design.md §4.13, §7; review M9; P1-05): one line per attempt,
// failures included, written through state.js (validation + ownership + month partition).
import { USAGE_SPEC } from "../lib/schema.js";
import { nowIst } from "../lib/time.js";
import { toInt } from "./adapter.js";

export const ERROR_MAX_CHARS = 500;

// Normalises the fields into a USAGE_SPEC record (optional keys omitted when empty). `paidEquivalentUsd` is
// written only when given (a free-tier line: costUsd 0 billed, this figure at the price table's paid rates).
export function usageRecord({ at, runId, agent, page, provider, model, inputTokens, outputTokens, costUsd, paidEquivalentUsd, ms, ok, error, mock }) {
  const record = {
    at,
    runId,
    agent,
    provider,
    model: String(model || provider),
    inputTokens: toInt(inputTokens),
    outputTokens: toInt(outputTokens),
    costUsd: Number.isFinite(costUsd) ? Math.round(costUsd * 1e6) / 1e6 : 0,
    ms: toInt(ms),
    ok: ok === true,
    mock: mock === true,
  };
  if (Number.isFinite(paidEquivalentUsd)) record.paidEquivalentUsd = Math.round(paidEquivalentUsd * 1e6) / 1e6;
  if (typeof page === "string" && page) record.page = page;
  if (typeof error === "string" && error) record.error = error.slice(0, ERROR_MAX_CHARS);
  return record;
}

// logAttempt(state, fields) → { rel, record }: appends to state/usage/<month of the state clock>.jsonl.
// `error` must already be scrubbed (LlmError.message is; the router scrubs everything else).
export function logAttempt(state, fields) {
  const record = usageRecord({ at: nowIst(state.now()), ...fields });
  const rel = state.appendLog("usage", record, USAGE_SPEC);
  return { rel, record };
}
