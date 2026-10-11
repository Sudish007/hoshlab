// Launch-day empty state (review M11, design §14): tests/fixtures/company-empty (status.json seed only,
// no drafts/runs/published/calendar) built into a temp DIST_DIR with a pinned clock.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, read, tmpDir } from "./helpers.js";

const EMPTY = join(ROOT, "tests", "fixtures", "company-empty");
// Thu 1 Oct 2026, 09:30 IST: KaatDo's 08:15 slot that day has passed, JobRez's 12:30 slot has not.
const NOW = "2026-10-01T09:30:00+05:30";
let dist;
let build;

before(() => {
  dist = join(tmpDir("hoshlab-dist-empty-"), "dist");
  build = spawnSync(process.execPath, [join(ROOT, "src", "build.js")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, COMPANY_DIR: EMPTY, MEDIA_DIR: join(dist, "..", "no-media"), DIST_DIR: dist, BUILD_NOW: NOW },
  });
});

const page = (rel) => read(join(dist, ...rel.split("/")));

test("the empty company builds (no media folder, no state besides status.json)", () => {
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.ok(existsSync(join(dist, "index.html")));
  assert.ok(!existsSync(join(dist, "media")), "nothing copied when the media folder is absent");
  assert.match(build.stdout, /media\/: not copied/);
  assert.match(build.stdout, /0 drafts, 0 published posts, 0 runs/);
});

test("Home status box has no digit characters and prints '—' / 'No runs yet' in every cell (design §14, M11)", () => {
  const home = page("index.html");
  const strip = home.match(/<div class="status-strip"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.doesNotMatch(strip, /\d/, strip);
  assert.equal((strip.match(/<span class="v">—<\/span>/g) || []).length, 4);
  assert.equal((strip.match(/No runs yet/g) || []).length, 4);
  assert.ok(!home.includes('class="flags"'), "no flag sentences without flags");
});

test("'Next up' lists four cadence slots labelled planned, in time order, with the cadence note", () => {
  const home = page("index.html");
  const nextUp = home.match(/<div class="next-up" aria-label="Next scheduled posts">[\s\S]*?<\/div>/)[0];
  const items = nextUp.match(/<li[\s\S]*?<\/li>/g);
  assert.equal(items.length, 4);
  for (const li of items) assert.ok(/>((carousel|reel) · )?planned</.test(li), li);
  const times = items.map((li) => li.match(/datetime="([^"]+)"/)[1]);
  // Thu 1 Oct JobRez image, Fri 2 Oct JobRez reel (the Phase 2 reel slot, plan D22), Fri 2 Oct RishtaPatra image, Sat 3 Oct KaatDo carousel
  assert.deepEqual(times, ["2026-10-01T12:30:00+05:30", "2026-10-02T12:30:00+05:30", "2026-10-02T19:30:00+05:30", "2026-10-03T11:00:00+05:30"]);
  assert.ok(/data-page="job_rez"><time datetime="2026-10-02T12:30:00\+05:30">[\s\S]*?reel · planned/.test(items[1]), items[1]);
  assert.ok(nextUp.includes("From the posting cadence; the Strategist has not planned these slots yet."));
});

test("Calendar 'This month' prints '0 published · N planned' per page from the cadence (hand-counted for October 2026)", () => {
  const cal = page("calendar/index.html");
  const month = cal.match(/<div class="next-up" aria-label="This month">[\s\S]*?<\/div>/)[0];
  // Oct 2026 starts on a Thursday. RishtaPatra Mon/Wed/Fri: 4 + 4 + 5 = 13, plus the Sat 19:30 reel slot (5 Saturdays) = 18.
  // KaatDo Tue/Thu/Sat: 4 + 5 + 5 = 14, minus Thu 1 Oct 08:15 (before the 09:30 clock) = 13, plus Sun 11:00 reels (4 Sundays) = 17.
  // JobRez Mon–Thu: 4 + 4 + 4 + 5 = 17 (Thu 1 Oct 12:30 counts), plus Fri 12:30 reels (5 Fridays) = 22.
  assert.ok(month.includes('data-page="rishtapatra"><span class="mono">@rishtapatra</span><span class="who">0 published · 18 planned</span>'), month);
  assert.ok(month.includes('data-page="kaatdo"><span class="mono">@kaatdo</span><span class="who">0 published · 17 planned</span>'), month);
  assert.ok(month.includes('data-page="job_rez"><span class="mono">@job_rez</span><span class="who">0 published · 22 planned</span>'), month);
  assert.equal((cal.match(/<span class="slot" data-page="/g) || []).length, 57, "18 + 17 + 22 planned slots drawn in the grid");
  assert.ok(!cal.includes("slot-link"), "nothing published, so no permalinks");
  assert.ok(cal.includes("No calendar has been generated yet"));
  const grid = cal.match(/<div class="calendar" role="grid"[\s\S]*?<\/div>\s*<p class="meta cal-note">/)[0];
  assert.ok(!grid.includes("scheduled") && !grid.includes("in review") && !grid.includes("in progress"), "only planned slots in the grid");
});

test("Published shows one 'Nothing published yet — first slot <date>' card per page, computed from the cadence", () => {
  const html = page("published/index.html");
  const cards = html.match(/<article class="card post-card post-empty"[\s\S]*?<\/article>/g) || [];
  assert.equal(cards.length, 3);
  assert.ok(cards[0].includes("Nothing published yet — first slot Fri 2 Oct · 19:30 IST"), cards[0]);
  assert.ok(cards[1].includes("Nothing published yet — first slot Sat 3 Oct · 11:00 IST"), cards[1]);
  assert.ok(cards[2].includes("Nothing published yet — first slot Thu 1 Oct · 12:30 IST"), cards[2]);
  assert.ok(!html.includes('<article class="card post-card" data-page'), "no real post cards");
  assert.ok(html.includes("0 posts"));
});

test("Reports prints the phase-2 sentence; Activity says No runs yet; Team cards say not run yet", () => {
  assert.ok(page("reports/index.html").includes("No reports yet — the Analyst starts in phase 2"));
  const activity = page("activity/index.html");
  assert.ok(activity.includes('<p class="empty">No runs yet.</p>'));
  assert.ok(!activity.includes('<article class="run'));
  assert.equal((page("team/index.html").match(/not run yet/g) || []).length, 8);
  const feed = page("feed.xml");
  assert.ok(!feed.includes("<entry>"));
  assert.ok(feed.includes(`<updated>${NOW}</updated>`), "an empty feed is dated by the build clock");
});
