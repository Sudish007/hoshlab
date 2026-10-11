// scripts/lib/set-page-ids.mjs — the Node half of setup-secrets.ps1 (review M15, plan D5): writes /me user_id
// as igUserId and id as appScopedId into config.json by a validated JSON round-trip, and resets a stored
// tokenState 'invalid' to 'unknown' (FEAT-107: the publisher never clears it itself). Works on a temp copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, tmpDir } from "./helpers.js";
import { main, parseArgs, setPageIds } from "../scripts/lib/set-page-ids.mjs";
import { CONFIG_SPEC, STATUS_SPEC, validate } from "../engine/lib/schema.js";

function copyFixture() {
  const dir = join(tmpDir("hoshlab-set-page-ids-"), "company");
  cpSync(COMPANY_DIR, dir, { recursive: true });
  return dir;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("writes igUserId = user_id and appScopedId = id for one page only, keeps key order and indent, validates, UTF-8 without BOM; a second call writes nothing", () => {
  const dir = copyFixture();
  try {
    const before = readJson(join(dir, "config.json"));
    const r = setPageIds({ companyDir: dir, handle: "kaatdo", igUserId: "17841400000000001", appScopedId: "9876543210", now: new Date("2026-10-12T12:00:00+05:30") });
    assert.equal(r.configChanged, true);
    assert.equal(r.igUserIdDigits, 17);
    assert.equal(r.appScopedIdDigits, 10);
    const buf = readFileSync(join(dir, "config.json"));
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb), "no BOM");
    const after = JSON.parse(buf.toString("utf8"));
    assert.deepEqual(validate(after, CONFIG_SPEC), { ok: true, errors: [] });
    const kd = after.pages.find((p) => p.handle === "kaatdo");
    assert.equal(kd.igUserId, "17841400000000001");
    assert.equal(kd.appScopedId, "9876543210");
    assert.deepEqual(Object.keys(kd), Object.keys(before.pages.find((p) => p.handle === "kaatdo")), "key order kept");
    for (const h of ["rishtapatra", "job_rez"]) assert.deepEqual(after.pages.find((p) => p.handle === h), before.pages.find((p) => p.handle === h), `${h} untouched`);
    assert.deepEqual({ ...after, pages: null }, { ...before, pages: null }, "everything outside pages[] untouched");
    const again = setPageIds({ companyDir: dir, handle: "kaatdo", igUserId: "17841400000000001", appScopedId: "9876543210" });
    assert.equal(again.configChanged, false);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("--reset-token-state: 'invalid' → 'unknown' and the token_invalid:<page> flag dropped, status.json re-validated; other states untouched; nothing written when there is nothing to reset", () => {
  const dir = copyFixture();
  try {
    const statusPath = join(dir, "state", "status.json");
    const status = readJson(statusPath);
    status.pages.kaatdo.tokenState = "invalid";
    status.flags = ["token_invalid:kaatdo", "budget_warn"];
    writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n");
    const r = setPageIds({ companyDir: dir, handle: "kaatdo", igUserId: "17841400000000001", resetTokenState: true, now: new Date("2026-10-12T12:00:00+05:30") });
    assert.equal(r.statusChanged, true);
    assert.equal(r.tokenStateBefore, "invalid");
    const after = readJson(statusPath);
    assert.deepEqual(validate(after, STATUS_SPEC), { ok: true, errors: [] });
    assert.equal(after.pages.kaatdo.tokenState, "unknown");
    assert.deepEqual(after.flags, ["budget_warn"]);
    assert.equal(after.updatedAt, "2026-10-12T12:00:00+05:30");
    assert.equal(after.pages.rishtapatra.tokenState, status.pages.rishtapatra.tokenState);
    // nothing to reset → status untouched
    const untouched = readFileSync(statusPath, "utf8");
    const r2 = setPageIds({ companyDir: dir, handle: "rishtapatra", igUserId: "1", resetTokenState: true });
    assert.equal(r2.statusChanged, false);
    assert.equal(r2.tokenStateBefore, "not_configured");
    assert.equal(readFileSync(statusPath, "utf8"), untouched);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("refuses an unknown page, a non-digit id or an invalid result without writing; CLI exit codes 2 (usage) / 0, output names digit counts only", () => {
  const dir = copyFixture();
  try {
    const before = readFileSync(join(dir, "config.json"), "utf8");
    assert.throws(() => setPageIds({ companyDir: dir, handle: "nope", igUserId: "1" }), /unknown page "nope"/);
    assert.throws(() => setPageIds({ companyDir: dir, handle: "kaatdo", igUserId: "12a" }), TypeError);
    assert.throws(() => setPageIds({ companyDir: dir, handle: "kaatdo", igUserId: "" }), TypeError);
    assert.throws(() => setPageIds({ companyDir: dir, handle: "kaatdo", igUserId: "1", appScopedId: "x" }), TypeError);
    assert.equal(readFileSync(join(dir, "config.json"), "utf8"), before, "nothing written");
    const out = [];
    const err = [];
    assert.equal(main([], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }), 2);
    assert.match(err[0], /^usage:/);
    assert.equal(main(["--page", "kaatdo", "--ig-user-id", "17841400000000001", "--app-scoped-id", "42", "--reset-token-state", "--company", dir], { stdout: (s) => out.push(s), stderr: (s) => err.push(s), processEnv: {} }), 0);
    assert.match(out[0], /^set-page-ids: @kaatdo igUserId \(17 digits\), appScopedId \(2 digits\) written to /);
    assert.ok(!out.join("\n").includes("17841400000000001"), "ids are never printed");
    assert.match(out[1], /tokenState not_configured; status\.json unchanged$/);
    assert.deepEqual(parseArgs(["--page", "kaatdo", "--reset-token-state", "--ig-user-id", "7"]), { page: "kaatdo", "reset-token-state": true, "ig-user-id": "7" });
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
