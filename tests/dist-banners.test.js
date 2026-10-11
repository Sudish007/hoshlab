// Token banners on Home (design §4.12 "the site shows each flag as a plain sentence", §11 row "IG container create /
// publish"; P2-09; FEAT-202): a temp copy of the populated fixture whose status.json carries token_expiring (with a
// known expiry, and with an unknown one) and token_invalid is built into a temp DIST_DIR with a pinned clock; the
// sentences must render verbatim from labels.js, the normal fixture build must print no flag block at all, and the
// admin template must carry the banner element the admin script fills.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { COMPANY_DIR, DIST, ROOT, read, tmpDir } from "./helpers.js";
import { STATUS_SPEC, TOKENS_SPEC, validate } from "../engine/lib/schema.js";
import { flagSentence, tokenDaysLeft } from "../src/lib/labels.js";
import { flagOptions } from "../src/templates/home.js";

const NOW = "2026-10-12T09:30:00+05:30"; // the same clock scripts/test.mjs pins for the fixture build
const KD_EXPIRES = "2026-10-17T20:00:00+05:30"; // 5 days 10.5 h after NOW → 'expires in 5 days'
let dist;
let build;
let companyDir;

before(() => {
  const base = tmpDir("hoshlab-dist-banners-");
  companyDir = join(base, "company");
  cpSync(COMPANY_DIR, companyDir, { recursive: true });
  const statusPath = join(companyDir, "state", "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.pages.kaatdo.tokenState = "expiring";
  status.pages.kaatdo.tokenExpiresAt = KD_EXPIRES;
  status.pages.rishtapatra.tokenState = "expiring";
  status.pages.rishtapatra.tokenExpiresAt = null;
  status.pages.job_rez.tokenState = "invalid";
  status.flags = ["token_expiring:kaatdo", "token_expiring:rishtapatra", "token_invalid:job_rez"];
  assert.deepEqual(validate(status, STATUS_SPEC), { ok: true, errors: [] });
  writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n", "utf8");
  const tokens = { updatedAt: NOW, pages: { kaatdo: { username: "kaatdo", expiresAt: KD_EXPIRES, refreshedAt: "2026-08-18T07:31:00+05:30", state: "expiring" }, rishtapatra: { expiresAt: null, state: "expiring" }, job_rez: { expiresAt: null, state: "invalid" } } };
  assert.deepEqual(validate(tokens, TOKENS_SPEC), { ok: true, errors: [] });
  writeFileSync(join(companyDir, "state", "tokens.json"), JSON.stringify(tokens, null, 2) + "\n", "utf8");
  dist = join(base, "dist");
  build = spawnSync(process.execPath, [join(ROOT, "src", "build.js")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, COMPANY_DIR: companyDir, MEDIA_DIR: join(ROOT, "tests", "fixtures", "media"), DIST_DIR: dist, BUILD_NOW: NOW },
  });
});

const page = (rel) => read(join(dist, ...rel.split("/")));

test("the fixture with tokens.json and both token flags builds (tokens.json is a spec'd state file)", () => {
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.ok(existsSync(join(dist, "index.html")));
});

test("Home prints one plain sentence per flag: 'expires in 5 days' from pages[kaatdo].tokenExpiresAt at the build clock, 'expires soon' for an unknown expiry, 'is invalid' for the dead token — no token, no handle-less text", () => {
  const home = page("index.html");
  const block = home.match(/<div class="flags span-all" aria-label="Status notes">([\s\S]*?)<\/div>/);
  assert.ok(block, "the flags block renders when flags are set");
  // the band is the hero's first child, spanning both columns (OF-4: a stack inside .hero-side left the hero copy's column empty at 1920/2560)
  assert.ok(home.indexOf('<section class="hero">') < block.index && block.index < home.indexOf('<div class="status-strip"'), "band inside the hero, before the copy and the status box");
  const sentences = [...block[1].matchAll(/<p class="flag">([^<]*)<\/p>/g)].map((m) => m[1]);
  assert.deepEqual(sentences, [
    "Token for @kaatdo expires in 5 days — run setup-secrets or wait for the weekly refresh.",
    "Token for @rishtapatra expires soon — run setup-secrets or wait for the weekly refresh.",
    "Token for @job_rez is invalid — run setup-secrets.",
  ]);
  assert.equal(tokenDaysLeft(KD_EXPIRES, new Date(NOW)), 5);
  assert.ok(!/token_expiring|token_invalid|tokenState|expiring:/.test(home), "no config token on the public page (OF-5)");
  // the sentence inputs come from the view: the budget month and the page's expiry
  const view = { usage: { month: "2026-10" }, status: { pages: { kaatdo: { tokenExpiresAt: KD_EXPIRES } } }, now: new Date(NOW) };
  assert.deepEqual(flagOptions(view, "token_expiring:kaatdo"), { month: "October 2026", daysLeft: 5 });
  assert.deepEqual(flagOptions(view, "token_expiring:rishtapatra"), { month: "October 2026", daysLeft: null });
  assert.deepEqual(flagOptions(view, "token_invalid:job_rez"), { month: "October 2026" });
  assert.equal(flagSentence("token_expiring:kaatdo", flagOptions(view, "token_expiring:kaatdo")), sentences[0]);
});

test("the normal fixture build (no flags) prints no flag block and the status box carries no digit from a banner", () => {
  const home = read(join(DIST, "index.html"));
  assert.ok(!home.includes('class="flags"'), "no flag sentences without flags");
  assert.ok(!home.includes("Token for @"), "no token sentence without a flag");
  const fixtureStatus = JSON.parse(readFileSync(join(COMPANY_DIR, "state", "status.json"), "utf8"));
  assert.deepEqual(fixtureStatus.flags, [], "the committed fixture has no flags (the banner build is a temp copy)");
});

test("the admin carries the banner element the script fills from status.json (hidden until flags exist), above the views", () => {
  const admin = read(join(DIST, "admin", "index.html"));
  const at = admin.indexOf('<div class="flags" id="status-flags" role="status" aria-label="Status notes" hidden></div>');
  assert.ok(at > 0, "banner element present");
  assert.ok(at < admin.indexOf('<section id="view-queue"'), "above the first view");
  assert.ok(at > admin.indexOf('<nav class="admin-tabs"'), "below the tabs");
  const script = read(join(ROOT, "public", "admin", "admin.js"));
  assert.match(script, /import \{[^}]*\bflagSentence\b[^}]*\} from "\.\/lib\/labels\.js"/, "the admin uses the shared labels.js sentences");
  assert.match(script, /function renderFlags\(\)/);
  assert.match(script, /tokenDaysLeft\(pageState && pageState\.tokenExpiresAt, new Date\(\)\)/, "the admin counts the days at load time");
  assert.match(script, /renderFlags\(\);/, "called after the state loads");
  assert.ok(!/style=/.test(script), "no inline styles (M2)");
});
