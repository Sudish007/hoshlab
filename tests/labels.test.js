// src/lib/labels.js — the only token→text mapping (design OF-5; review M6, N2, N5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.js";
import { modeLabel, providerLabel, tokenStateLabel, slotLabel, cadenceLine, flagSentence, tokenDaysLeft, isApproved, windowLabel, metricLabel, cronLabel, TERMINAL, SLOT_WORDS } from "../src/lib/labels.js";
import { SCHEDULE_PAIRS, scheduleErrors } from "../src/lib/company.js";
import { DRAFT_STATUSES, METRIC_SPEC, METRIC_WINDOWS, SLOT_STATUSES, TOKEN_STATES } from "../engine/lib/schema.js";

const config = JSON.parse(readFileSync(join(ROOT, "company", "config.json"), "utf8"));
const page = (handle) => config.pages.find((p) => p.handle === handle);

test("labels.js is browser-safe: no node: imports, no imports at all", () => {
  const src = readFileSync(join(ROOT, "src", "lib", "labels.js"), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:/);
  assert.doesNotMatch(src, /^import\s/m);
});

test("modeLabel / providerLabel / tokenStateLabel map every token and throw on unknown ones (N5)", () => {
  assert.equal(modeLabel("approve_first"), "Approve first");
  assert.equal(modeLabel("autopilot"), "Autopilot");
  assert.throws(() => modeLabel("manual"), /unknown mode/);
  assert.equal(providerLabel("anthropic"), "Anthropic");
  assert.equal(providerLabel("gemini"), "Google Gemini");
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.throws(() => providerLabel("Anthropic"), /unknown provider/);
  assert.equal(tokenStateLabel("ok"), "token ok");
  assert.equal(tokenStateLabel("invalid"), "token invalid");
  assert.equal(tokenStateLabel("not_configured"), "not configured yet");
  assert.equal(tokenStateLabel("expiring"), "token expiring");
  for (const s of TOKEN_STATES) assert.ok(tokenStateLabel(s), s);
  assert.throws(() => tokenStateLabel("nope"), /unknown token state/);
  // FEAT-203: insights windows and metric names (the Reports page prints these, never the record tokens)
  assert.equal(windowLabel("48h"), "48 hours");
  assert.equal(windowLabel("7d"), "7 days");
  for (const w of METRIC_WINDOWS) assert.ok(windowLabel(w), w);
  assert.throws(() => windowLabel("24h"), /unknown insights window/);
  assert.equal(metricLabel("saved"), "saves");
  for (const m of Object.keys(METRIC_SPEC.metrics)) assert.ok(metricLabel(m), m);
  assert.throws(() => metricLabel("impressions"), /unknown insights metric/);
});

test("cronLabel (OF-7/D1, M1): hourly, daily and weekly GitHub crons (UTC) → the one IST label; the config's labels are its derivations; other shapes throw", () => {
  // the off-peak cadence live since 2026-10-12
  assert.equal(cronLabel("17 * * * *"), "Hourly at :47 IST");
  assert.equal(cronLabel("23 0 * * *"), "Daily 05:53 IST");
  assert.equal(cronLabel("13 2 * * 1"), "Mondays 07:43 IST");
  // the top-of-hour cadence it replaced, and the shapes around it
  assert.equal(cronLabel("0 * * * *"), "Hourly at :30 IST");
  assert.equal(cronLabel("30 * * * *"), "Hourly at :00 IST");
  assert.equal(cronLabel("0 0 * * *"), "Daily 05:30 IST");
  assert.equal(cronLabel("0 2 * * 1"), "Mondays 07:30 IST");
  assert.equal(cronLabel("30 18 * * *"), "Daily 00:00 IST", "wraps past midnight");
  assert.equal(cronLabel("45 19 * * 0"), "Mondays 01:15 IST", "19:45 UTC Sunday is 01:15 IST Monday — the weekday shifts with the date");
  assert.equal(cronLabel("45 19 * * 7"), "Mondays 01:15 IST", "7 is Sunday too");
  assert.equal(cronLabel("0 12 * * 6"), "Saturdays 17:30 IST");
  assert.equal(cronLabel(" 17  *  * * * "), "Hourly at :47 IST", "whitespace tolerated");
  for (const [cronKey, labelKey] of SCHEDULE_PAIRS) assert.equal(cronLabel(config.schedule[cronKey]), config.schedule[labelKey], `${labelKey}`);
  assert.deepEqual(scheduleErrors(config.schedule), []);
  // a label that drifts from its cron, or an unparseable cron, is a company load error (src/lib/company.js)
  assert.deepEqual(scheduleErrors({ ...config.schedule, publisherLabel: "Hourly at :30 IST" }), ['$.schedule.publisherLabel: "Hourly at :30 IST" is not the label of cron 17 * * * * (Hourly at :47 IST)']);
  assert.match(scheduleErrors({ ...config.schedule, engineCron: "*/5 * * * *" })[0], /^\$\.schedule\.engineCron: labels: cron minute must be a fixed 0–59/);
  for (const bad of ["* * * * *", "*/15 * * * *", "0,30 * * * *", "0 0 1 * *", "0 0 * 1 *", "0 0 * * 1-5", "0 0 * * mon", "60 * * * *", "0 24 * * *", "0 * * * 1", "0 0 * *", "0 0 * * * *", "", null, 17]) {
    assert.throws(() => cronLabel(bad), TypeError, JSON.stringify(bad));
  }
});

// M6 truth table: every (draft status × approval × mode) cell, written out — not derived from the code.
const APPROVALS = {
  none: undefined,
  approve: { decision: "approve", revision: 1 },
  stale: { decision: "approve", revision: 0 }, // written against an older revision (M5.5)
  reject: { decision: "reject", revision: 1, reason: "no" },
};
const EXPECTED = {
  // status:        { approve_first: { none, approve, stale, reject }, autopilot: { ... } }
  written: { approve_first: { none: "in progress", approve: "in progress", stale: "in progress", reject: null }, autopilot: { none: "in progress", approve: "in progress", stale: "in progress", reject: null } },
  rendered: { approve_first: { none: "in progress", approve: "in progress", stale: "in progress", reject: null }, autopilot: { none: "in progress", approve: "in progress", stale: "in progress", reject: null } },
  rework: { approve_first: { none: "in progress", approve: "in progress", stale: "in progress", reject: null }, autopilot: { none: "in progress", approve: "in progress", stale: "in progress", reject: null } },
  queued: { approve_first: { none: "in review", approve: "scheduled", stale: "in review", reject: null }, autopilot: { none: "scheduled", approve: "scheduled", stale: "scheduled", reject: null } },
  published: { approve_first: { none: "published", approve: "published", stale: "published", reject: "published" }, autopilot: { none: "published", approve: "published", stale: "published", reject: "published" } },
  blocked: { approve_first: { none: null, approve: null, stale: null, reject: null }, autopilot: { none: null, approve: null, stale: null, reject: null } },
  failed: { approve_first: { none: null, approve: null, stale: null, reject: null }, autopilot: { none: null, approve: null, stale: null, reject: null } },
  rejected: { approve_first: { none: null, approve: null, stale: null, reject: null }, autopilot: { none: null, approve: null, stale: null, reject: null } },
  expired: { approve_first: { none: null, approve: null, stale: null, reject: null }, autopilot: { none: null, approve: null, stale: null, reject: null } },
};

test("M6: slotLabel covers every draft status × approval × mode cell", () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...DRAFT_STATUSES].sort(), "the table names every draft status");
  let cells = 0;
  for (const [status, byMode] of Object.entries(EXPECTED)) {
    for (const [mode, byApproval] of Object.entries(byMode)) {
      for (const [name, approval] of Object.entries(APPROVALS)) {
        const draft = { id: "x", status, revision: 1 };
        const slot = { slotId: "s", status, draftId: "x" };
        assert.equal(slotLabel(slot, draft, approval, mode), byApproval[name], `${status} × ${name} × ${mode}`);
        cells++;
      }
    }
  }
  assert.equal(cells, 9 * 2 * 4);
  for (const word of Object.values(EXPECTED).flatMap((m) => Object.values(m).flatMap((a) => Object.values(a)))) {
    if (word !== null) assert.ok(SLOT_WORDS.includes(word), word);
  }
});

test("M6: slots without a draft — planned, dropped, and a slot whose draft folder is gone", () => {
  for (const mode of ["approve_first", "autopilot"]) {
    assert.equal(slotLabel({ slotId: "s", status: "planned" }, null, undefined, mode), "planned");
    assert.equal(slotLabel({ slotId: "s" }, null, undefined, mode), "planned", "no status at all");
    assert.equal(slotLabel({ slotId: "s", status: "dropped" }, null, undefined, mode), null, "dropped slots are hidden (M5.2)");
    assert.equal(slotLabel({ slotId: "s", status: "published", draftId: "gone" }, null, undefined, mode), "published");
    assert.equal(slotLabel({ slotId: "s", status: "written", draftId: "gone" }, null, undefined, mode), "in progress");
    for (const s of ["blocked", "failed", "rejected", "expired"]) assert.equal(slotLabel({ slotId: "s", status: s, draftId: "gone" }, null, undefined, mode), null, s);
  }
  assert.equal(slotLabel({ slotId: "s", status: "queued", draftId: "gone" }, null, undefined, "approve_first"), "in review");
  assert.equal(slotLabel({ slotId: "s", status: "queued", draftId: "gone" }, null, { decision: "approve" }, "approve_first"), "scheduled", "an approval without a revision counts when there is no draft to compare");
  assert.equal(slotLabel({ slotId: "s", status: "queued", draftId: "gone" }, null, undefined, "autopilot"), "scheduled");
  assert.deepEqual(SLOT_STATUSES.filter((s) => slotLabel({ slotId: "s", status: s }, null, undefined, "approve_first") === null).sort(), ["blocked", "dropped", "expired", "failed", "rejected"]);
  assert.deepEqual(TERMINAL, ["rejected", "blocked", "failed", "expired"]);
});

test("isApproved requires an approve record for the draft's current revision", () => {
  assert.equal(isApproved({ revision: 2 }, { decision: "approve", revision: 2 }), true);
  assert.equal(isApproved({ revision: 2 }, { decision: "approve", revision: 1 }), false);
  assert.equal(isApproved({ revision: 2 }, { decision: "reject", revision: 2 }), false);
  assert.equal(isApproved({ revision: 2 }, undefined), false);
});

test("N2: cadenceLine counts posts and carousels from the cadence and reels only when features.reels (true since FEAT-201: '· 1 reel' per page)", () => {
  assert.equal(config.features.reels, true);
  assert.equal(cadenceLine(page("rishtapatra"), config.features), "4 posts / week · 1 carousel · 1 reel");
  assert.equal(cadenceLine(page("kaatdo"), config.features), "4 posts / week · 1 carousel · 1 reel");
  assert.equal(cadenceLine(page("job_rez"), config.features), "5 posts / week · 1 carousel · 1 reel");
  assert.equal(cadenceLine(page("rishtapatra"), { reels: false }), "3 posts / week · 1 carousel", "the reel slot is not counted while reels are off");
  const withReel = { cadence: { slots: [...page("rishtapatra").cadence.slots.filter((s) => s.format !== "reel"), { dow: "sun", time: "11:00", format: "reel" }] } };
  assert.equal(cadenceLine(withReel, { reels: false }), "3 posts / week · 1 carousel", "a reel slot is not counted while reels are off");
  assert.equal(cadenceLine(withReel, { reels: true }), "4 posts / week · 1 carousel · 1 reel");
  assert.equal(cadenceLine({ cadence: { slots: [{ dow: "mon", time: "09:00", format: "image" }] } }), "1 post / week");
  assert.equal(cadenceLine({ cadence: { slots: [{ dow: "mon", time: "09:00", format: "carousel" }, { dow: "wed", time: "09:00", format: "carousel" }] } }), "2 posts / week · 2 carousels");
  for (const p of config.pages) assert.equal((cadenceLine(p, config.features).match(/reel/g) || []).length, p.cadence.slots.filter((s) => s.format === "reel").length, p.handle);
});

test("flagSentence: one plain sentence per status flag, unknown flags throw", () => {
  assert.equal(flagSentence("budget_exhausted", { month: "October 2026" }), "Budget for October 2026 is spent; drafting paused.");
  assert.equal(flagSentence("budget_exhausted"), "Budget for this month is spent; drafting paused.");
  assert.equal(flagSentence("budget_warn", { month: "October 2026" }), "Budget for October 2026 is past the warning level.");
  assert.equal(flagSentence("token_invalid:kaatdo"), "Token for @kaatdo is invalid — run setup-secrets.");
  assert.match(flagSentence("token_expiring:job_rez"), /^Token for @job_rez expires soon/);
  // FEAT-202 (P2-09): with the whole days left the sentence counts down; unknown → 'expires soon'
  assert.equal(flagSentence("token_expiring:job_rez"), "Token for @job_rez expires soon — run setup-secrets or wait for the weekly refresh.");
  assert.equal(flagSentence("token_expiring:kaatdo", { daysLeft: 5 }), "Token for @kaatdo expires in 5 days — run setup-secrets or wait for the weekly refresh.");
  assert.equal(flagSentence("token_expiring:kaatdo", { daysLeft: 1 }), "Token for @kaatdo expires in 1 day — run setup-secrets or wait for the weekly refresh.");
  assert.equal(flagSentence("token_expiring:kaatdo", { daysLeft: 0 }), "Token for @kaatdo expires today — run setup-secrets.");
  assert.equal(flagSentence("token_expiring:kaatdo", { daysLeft: -2 }), "Token for @kaatdo has passed its expiry date — run setup-secrets.");
  assert.equal(flagSentence("token_expiring:kaatdo", { daysLeft: null }), flagSentence("token_expiring:kaatdo"));
  assert.equal(flagSentence("token_expiring:kaatdo", { daysLeft: 5.5 }), flagSentence("token_expiring:kaatdo"), "only whole days count");
  assert.equal(tokenDaysLeft("2026-10-17T20:00:00+05:30", new Date("2026-10-12T09:30:00+05:30")), 5);
  assert.equal(tokenDaysLeft("2026-10-12T20:00:00+05:30", new Date("2026-10-12T09:30:00+05:30")), 0);
  assert.equal(tokenDaysLeft("2026-10-11T20:00:00+05:30", new Date("2026-10-12T09:30:00+05:30")), -1);
  assert.equal(tokenDaysLeft("2026-12-11T07:30:00+05:30", Date.parse("2026-10-12T07:30:00+05:30")), 60);
  assert.equal(tokenDaysLeft(null, new Date()), null);
  assert.equal(tokenDaysLeft("not a date", new Date()), null);
  assert.equal(tokenDaysLeft("2026-10-17T20:00:00+05:30", "garbage"), null);
  assert.match(flagSentence("render_failed"), /Designer refused/);
  // R1-02: a refused draft goes back to the Writer (or is blocked at the cap); it never "stays with the Writer"
  assert.ok(!flagSentence("render_failed").includes("stays with the Writer"), flagSentence("render_failed"));
  assert.match(flagSentence("render_failed"), /goes back to the Writer/);
  assert.match(flagSentence("render_failed"), /blocked for the owner/);
  assert.match(flagSentence("provider_down:gemini"), /^Google Gemini was unreachable/);
  // R1-05: the sentence claims nothing about a fallback — every fallback may have failed too
  assert.equal(flagSentence("provider_down:anthropic"), "Anthropic was unreachable in the last run.");
  assert.ok(!flagSentence("provider_down:anthropic").includes("was used"));
  assert.match(flagSentence("media_branch_missing"), /not configured yet/);
  assert.match(flagSentence("publish_failed:kd-2026-10-13-six-rules"), /^Publishing failed for kd-2026-10-13-six-rules/);
  for (const f of ["budget_warn", "budget_exhausted", "token_invalid:kaatdo", "token_expiring:kaatdo", "render_failed", "provider_down:anthropic", "media_branch_missing", "publish_failed:x-1"]) {
    const s = flagSentence(f);
    assert.ok(/[.]$/.test(s) && !/[_:]/.test(s.replace(/setup-secrets|x-1/g, "")), `${f}: plain sentence, no tokens: ${s}`);
  }
  assert.throws(() => flagSentence("made_up"), /unknown flag/);
});
