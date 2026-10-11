// N18 / plan D12: the browser-shared libraries are byte copies made at build time, never committed copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_SHARED_LIBS } from "../src/build.js";
import { ROOT, DIST } from "./helpers.js";

test("dist/admin/lib/* are byte-identical to their sources and import nothing from node:", () => {
  assert.deepEqual(ADMIN_SHARED_LIBS.map(([, n]) => n), ["schema.js", "checks.js", "brand.js", "labels.js"]);
  for (const [from, name] of ADMIN_SHARED_LIBS) {
    const src = readFileSync(join(ROOT, from));
    const copy = readFileSync(join(DIST, "admin", "lib", name));
    assert.ok(src.equals(copy), `${name} parity`);
    assert.doesNotMatch(src.toString("utf8"), /from\s+["']node:/, `${name} is browser-safe`);
    for (const m of src.toString("utf8").matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      assert.ok(ADMIN_SHARED_LIBS.some(([, n]) => `./${n}` === m[1]), `${name} imports ${m[1]}, which must also be copied`);
    }
  }
  // public/admin/lib holds only the admin's own libraries (github, store, base64, run-status, state, proposals); the
  // four shared files exist there in dist/ only.
  for (const [, name] of ADMIN_SHARED_LIBS) assert.ok(!existsSync(join(ROOT, "public", "admin", "lib", name)), `no committed copy public/admin/lib/${name}`);
  assert.deepEqual(readdirSync(join(ROOT, "public", "admin", "lib")).sort(), ["base64.js", "github.js", "proposals.js", "run-status.js", "state.js", "store.js"]);
});
