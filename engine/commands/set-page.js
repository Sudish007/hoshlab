// set-page — the owner's local mode switch (design.md §9 "Mode semantics", §4.1; review M5):
//   node engine/index.js set-page --page <handle> --mode approve_first|autopilot
// An OWNER tool, so it is allowed to write the admin-owned config.json (state.js would refuse): the
// file is read with plain fs, changed through a JSON round-trip that keeps the key order, validated
// against CONFIG_SPEC (with the cross-field rules) and written back UTF-8 without BOM. Nothing else
// changes; status.json mirrors the mode at the next engine or publisher run.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SPEC, validate } from "../lib/schema.js";
import { nowIst } from "../lib/time.js";

export const MODES = ["approve_first", "autopilot"];
export const CHANGED_BY = "owner-cli";

// What the owner must understand before the switch lands (design §9, binding).
export const CONSEQUENCES = {
  autopilot: ["Autopilot applies to drafts already in the queue: they post at their slots without an approval.", "Nothing posts without a QA pass; a reject on a draft still blocks it."],
  approve_first: ["Approve first stops unapproved posting immediately: only drafts with an approve record for their current revision post.", "Drafts already in the queue wait for your approval in the admin."],
};

// setPageMode({ companyDir, handle, mode, now }) → { changed, page, previous, mode, modeChangedAt, path }
// Throws TypeError on an unknown handle or mode; SchemaError-like Error when the result would not validate.
export function setPageMode({ companyDir, handle, mode, now = new Date() } = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`set-page: --mode must be one of ${MODES.join("|")} (got ${JSON.stringify(mode)})`);
  const path = join(companyDir, "config.json");
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const config = JSON.parse(text); // key order is preserved by the round-trip
  const page = (config.pages || []).find((p) => p.handle === handle);
  if (!page) throw new TypeError(`set-page: unknown page ${JSON.stringify(handle)} (--page takes ${(config.pages || []).map((p) => p.handle).join("|")})`);
  const previous = page.mode;
  if (previous === mode) return { changed: false, page: handle, previous, mode, modeChangedAt: page.modeChangedAt, path };
  const modeChangedAt = nowIst(now);
  page.mode = mode;
  page.modeChangedAt = modeChangedAt;
  page.modeChangedBy = CHANGED_BY;
  const r = validate(config, CONFIG_SPEC);
  if (!r.ok) throw new Error(`set-page: config.json would not validate after the change — ${r.errors.join("; ")}`);
  const indent = /\n {4}"/.test(text) ? 4 : 2;
  writeFileSync(path, JSON.stringify(config, null, indent) + "\n", "utf8");
  return { changed: true, page: handle, previous, mode, modeChangedAt, path };
}

export async function run({ companyDir, stdout = console.log, stderr = console.error, flags = {} } = {}) {
  const handle = typeof flags.page === "string" ? flags.page : null;
  const mode = typeof flags.mode === "string" ? flags.mode : null;
  if (!handle || !mode) {
    stderr(`set-page: usage: node engine/index.js set-page --page <handle> --mode ${MODES.join("|")}`);
    return 2;
  }
  let r;
  try {
    r = setPageMode({ companyDir, handle, mode });
  } catch (err) {
    if (err instanceof TypeError) {
      stderr(err.message);
      return 2;
    }
    stderr(`set-page: ${err.message}`);
    return 1;
  }
  if (!r.changed) {
    stdout(`set-page: @${handle} is already ${mode}; nothing written`);
    return 0;
  }
  stdout(`set-page: @${handle} ${r.previous} -> ${mode} (modeChangedAt ${r.modeChangedAt}, modeChangedBy ${CHANGED_BY}) written to ${r.path}`);
  for (const line of CONSEQUENCES[mode]) stdout(`  ${line}`);
  stdout(`  Commit and push config.json for the change to reach GitHub Actions; the site and admin show the new mode after the next engine or publisher run.`);
  return 0;
}
