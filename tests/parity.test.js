// N18 / plan D12: the browser-shared libraries are byte copies made at build time, never committed copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  assert.ok(!existsSync(join(ROOT, "public", "admin", "lib")), "no committed copies under public/admin/lib");
});
