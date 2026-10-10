// Budget arithmetic (design.md §7, review M5.4/M9, plan D7/D9).
// costUsd = inputTokens × inputPerMTok / 1e6 + outputTokens × outputPerMTok / 1e6, rounded to 6 decimals.
// The month's spend is the sum of state/usage/<IST month>.jsonl only (one partition file).
// Browser-safe arithmetic; monthUsedUsd takes a state object from engine/lib/state.js.

export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function priceOk(price) {
  return price && Number.isFinite(price.inputPerMTok) && Number.isFinite(price.outputPerMTok);
}

// costUsd({ inputPerMTok, outputPerMTok }, inputTokens, outputTokens) → USD rounded to 6 decimals.
export function costUsd(price, inputTokens, outputTokens) {
  if (!priceOk(price)) throw new TypeError("budget: model price not configured yet (inputPerMTok / outputPerMTok must be numbers)");
  const inTok = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
  const outTok = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
  return round6((inTok * price.inputPerMTok) / 1e6 + (outTok * price.outputPerMTok) / 1e6);
}

// Worst-case cost of one call: the prompt estimate plus the full maxOutputTokens (roster value).
export function estimateCostUsd(price, inputTokensGuess, maxOutputTokens) {
  return costUsd(price, inputTokensGuess, maxOutputTokens);
}

// Σ costUsd of the usage partition for the IST month of `date` (default: the state clock).
export function monthUsedUsd(state, date = state.now()) {
  const rows = state.readJsonl(state.monthLogPath("usage", date));
  return round6(rows.reduce((sum, r) => sum + (r && Number.isFinite(r.costUsd) ? r.costUsd : 0), 0));
}

// canSpend(config, used, estimate) → { ok, reason, warn, used, estimate, projected, pct, limit }
// ok is false only when hardStop is on and the month is at/over the limit or this call would cross it.
// warn is true from warnAtPct of the limit (budget_warn flag).
export function canSpend(config, used, estimate) {
  const { monthlyUsd, warnAtPct, hardStop } = config.budget;
  const u = Number.isFinite(used) ? used : 0;
  const e = Number.isFinite(estimate) ? estimate : 0;
  const projected = round6(u + e);
  const pct = monthlyUsd > 0 ? (projected / monthlyUsd) * 100 : Infinity;
  const over = u >= monthlyUsd || projected > monthlyUsd;
  const warn = pct >= warnAtPct;
  const base = { used: round6(u), estimate: round6(e), projected, pct: Math.round(pct * 10) / 10, limit: monthlyUsd, warn };
  if (over && hardStop) {
    return { ok: false, reason: `budget_exhausted: USD ${u.toFixed(2)} of ${monthlyUsd} used this month; this call would add about USD ${e.toFixed(4)}`, ...base, warn: true };
  }
  return { ok: true, reason: over ? "over_limit_soft" : warn ? "budget_warn" : null, ...base };
}
