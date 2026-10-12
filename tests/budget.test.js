import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpDir } from "./helpers.js";
import { billedUsd, canSpend, costUsd, estimateCostUsd, monthHasFreeTierUsage, monthPaidEquivalentUsd, monthUsedUsd, paidEquivalentUsd, round6 } from "../engine/lib/budget.js";
import { createState } from "../engine/lib/state.js";
import { USAGE_SPEC } from "../engine/lib/schema.js";

const SONNET = { inputPerMTok: 2, outputPerMTok: 10, maxOutputTokens: 128000 };
const FLASH = { inputPerMTok: 0.75, outputPerMTok: 3.75, maxOutputTokens: 65536 };
const LUNA = { inputPerMTok: 0.1, outputPerMTok: 0.5, maxOutputTokens: 128000 };
const budget = (overrides = {}) => ({ budget: { monthlyUsd: 25, warnAtPct: 80, hardStop: true, ...overrides } });

const line = (at, cost) => ({ at, runId: "engine-daily-20261012-0530-abcdef", agent: "writer", page: "rishtapatra", provider: "anthropic", model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 100, costUsd: cost, ms: 900, ok: true, mock: false });

test("costUsd = in × inputPerMTok / 1e6 + out × outputPerMTok / 1e6, rounded to 6 decimals", () => {
  assert.equal(costUsd(SONNET, 1234, 567), 0.008138); // 0.002468 + 0.00567
  assert.equal(costUsd(SONNET, 0, 0), 0);
  assert.equal(costUsd(LUNA, 1, 1), 0.000001); // 1e-7 + 5e-7 = 6e-7 → rounds up to 1e-6
  assert.equal(costUsd(FLASH, 1, 0), 0.000001); // 7.5e-7 → 1e-6
  assert.equal(costUsd(LUNA, 1, 0), 0); // 1e-7 → 0
  assert.equal(costUsd(FLASH, 6000, 1000), 0.00825); // 0.0045 + 0.00375
  for (const [i, o] of [
    [6000, 1000],
    [8123, 1511],
    [15017, 2999],
    [1, 1],
  ]) {
    const c = costUsd(FLASH, i, o);
    const decimals = (String(c).split(".")[1] || "").length;
    assert.ok(decimals <= 6, `${c} has ${decimals} decimals`);
    assert.equal(c, round6(c));
  }
  assert.equal(costUsd(SONNET, -5, Number.NaN), 0, "negative / NaN token counts count as 0");
  assert.throws(() => costUsd({ inputPerMTok: null, outputPerMTok: 10 }, 1, 1), /not configured yet/);
  assert.throws(() => costUsd(undefined, 1, 1), TypeError);
});

test("estimateCostUsd uses the prompt guess plus the FULL maxOutputTokens of the roster, not the model cap", () => {
  assert.equal(estimateCostUsd(SONNET, 6000, 4000), costUsd(SONNET, 6000, 4000));
  assert.equal(estimateCostUsd(SONNET, 6000, 4000), 0.052);
  assert.equal(estimateCostUsd(FLASH, 5000, 2000), 0.01125);
  assert.notEqual(estimateCostUsd(SONNET, 6000, 4000), estimateCostUsd(SONNET, 6000, SONNET.maxOutputTokens));
});

test("monthUsedUsd sums only the usage partition of the given IST month (M9)", () => {
  const dir = tmpDir("hoshlab-budget-");
  try {
    const state = createState({ companyDir: dir, now: "2026-10-15T10:00:00+05:30" });
    state.appendLog("usage", line("2026-10-02T05:31:00+05:30", 0.5), USAGE_SPEC);
    state.appendLog("usage", line("2026-10-09T05:31:00+05:30", 0.25), USAGE_SPEC);
    state.appendLog("usage", { ...line("2026-10-09T05:32:00+05:30", 0.1), ok: false, error: "anthropic: HTTP 429 rate limited", inputTokens: 0, outputTokens: 0, costUsd: 0 }, USAGE_SPEC);
    state.appendLog("usage", line("2026-11-01T00:10:00+05:30", 100), USAGE_SPEC, new Date("2026-11-01T00:10:00+05:30"));
    assert.equal(monthUsedUsd(state), 0.75, "default date = the state clock (October)");
    assert.equal(monthPaidEquivalentUsd(state), 0.75);
    assert.equal(monthHasFreeTierUsage(state), false);
    assert.equal(billedUsd({ costUsd: 0, paidEquivalentUsd: 0.12 }), 0);
    assert.equal(paidEquivalentUsd({ costUsd: 0, paidEquivalentUsd: 0.12 }), 0.12);
    state.appendLog("usage", { ...line("2026-10-10T05:31:00+05:30", 0), provider: "gemini", model: "gemini-3.8-flash", paidEquivalentUsd: 0.12 }, USAGE_SPEC);
    assert.equal(monthUsedUsd(state), 0.75, "a free-tier line does not move billed month spend");
    assert.equal(monthPaidEquivalentUsd(state), 0.87, "its paid-rate equivalent remains visible");
    assert.equal(monthHasFreeTierUsage(state), true);
    assert.equal(monthUsedUsd(state, new Date("2026-10-31T23:59:00+05:30")), 0.75);
    assert.equal(monthUsedUsd(state, new Date("2026-11-01T00:10:00+05:30")), 100, "1 Nov 00:10 IST is still 31 Oct in UTC, yet the November file is read");
    assert.equal(monthUsedUsd(state, new Date("2026-12-05T12:00:00+05:30")), 0, "missing partition → 0");
    // float noise is rounded away
    for (let i = 0; i < 10; i++) state.appendLog("usage", line("2026-10-20T05:31:00+05:30", 0.1), USAGE_SPEC);
    assert.equal(monthUsedUsd(state), 1.75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canSpend: ok below the limit, warn from warnAtPct, hard stop at/over the limit or when the call would cross it", () => {
  const fine = canSpend(budget(), 0, 0.052);
  assert.equal(fine.ok, true);
  assert.equal(fine.warn, false);
  assert.equal(fine.reason, null);
  assert.equal(fine.projected, 0.052);

  const warn = canSpend(budget(), 19.9, 0.2); // 20.1 / 25 = 80.4 %
  assert.equal(warn.ok, true);
  assert.equal(warn.warn, true);
  assert.equal(warn.reason, "budget_warn");
  assert.equal(warn.pct, 80.4);

  const justUnder = canSpend(budget(), 19.9, 0.05); // 19.95 / 25 = 79.8 %
  assert.equal(justUnder.warn, false);

  const exactlyWarn = canSpend(budget(), 20, 0); // 80.0 %
  assert.equal(exactlyWarn.warn, true);

  const crossing = canSpend(budget(), 24.95, 0.1); // would reach 25.05
  assert.equal(crossing.ok, false);
  assert.match(crossing.reason, /^budget_exhausted: USD 24\.95 of 25 used this month/);
  assert.equal(crossing.warn, true);

  const atLimit = canSpend(budget(), 25, 0);
  assert.equal(atLimit.ok, false, "at the limit with a free (mock) call is still a stop");
  const overLimit = canSpend(budget(), 30, 0.01);
  assert.equal(overLimit.ok, false);

  const reachingExactly = canSpend(budget(), 24.9, 0.1); // projected exactly 25.00 → allowed (≤ limit)
  assert.equal(reachingExactly.ok, true);
  assert.equal(reachingExactly.warn, true);

  const soft = canSpend(budget({ hardStop: false }), 30, 1);
  assert.equal(soft.ok, true, "hardStop off never blocks");
  assert.equal(soft.warn, true);
  assert.equal(soft.reason, "over_limit_soft");

  assert.equal(canSpend(budget(), Number.NaN, undefined).ok, true, "non-numbers count as 0");
});
