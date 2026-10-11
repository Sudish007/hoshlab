// set-page-ids — owner helper called by scripts/setup-secrets.ps1 after a successful GET /me probe
// (design.md §16, review M15, plan D5): stores the NON-secret Instagram ids of one page in company/config.json.
//
//   node scripts/lib/set-page-ids.mjs --page <handle> --ig-user-id <digits> [--app-scoped-id <digits>]
//                                     [--reset-token-state] [--company <dir>]
//
// `user_id` from /me (the professional account that publishes) becomes pages[].igUserId and `id` (the
// app-scoped id) becomes pages[].appScopedId. config.json is admin-owned, so like engine/commands/set-page.js
// this is a plain-fs JSON round-trip that keeps key order and indent, validates against CONFIG_SPEC first and
// writes UTF-8 without BOM. With --reset-token-state a stored company/state/status.json pages[h].tokenState
// 'invalid' becomes 'unknown' and the token_invalid:<h> flag is dropped in the LOCAL checkout. The publisher
// in Actions clears a stored 'invalid' by itself once the replaced secret answers content_publishing_limit
// (R1-01), so this local reset is a convenience for the owner's own status.json; committing it is optional
// and needs a `git pull` first because the bot rewrites status.json every hour.
// Nothing is committed and no id is printed: output names the page and the digit counts only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_SPEC, STATUS_SPEC, validate } from "../../engine/lib/schema.js";
import { nowIst } from "../../engine/lib/time.js";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIGITS_RE = /^\d+$/;

function readJson(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return { text, json: JSON.parse(text), indent: /\n {4}"/.test(text) ? 4 : 2 };
}

function writeJson(path, value, indent) {
  writeFileSync(path, JSON.stringify(value, null, indent) + "\n", "utf8"); // UTF-8, no BOM
}

// setPageIds({ companyDir, handle, igUserId, appScopedId, resetTokenState, now })
//   → { handle, configChanged, statusChanged, igUserIdDigits, appScopedIdDigits, tokenStateBefore, configPath, statusPath }
// TypeError on an unknown page or a non-digit id; Error when the result would not validate (nothing written).
export function setPageIds({ companyDir, handle, igUserId, appScopedId = null, resetTokenState = false, now = new Date() } = {}) {
  if (typeof igUserId !== "string" || !DIGITS_RE.test(igUserId)) throw new TypeError("set-page-ids: --ig-user-id must be the digits of /me user_id");
  if (appScopedId !== null && (typeof appScopedId !== "string" || !DIGITS_RE.test(appScopedId))) throw new TypeError("set-page-ids: --app-scoped-id must be the digits of /me id");
  const configPath = join(companyDir, "config.json");
  const { json: config, indent } = readJson(configPath);
  const page = (config.pages || []).find((p) => p.handle === handle);
  if (!page) throw new TypeError(`set-page-ids: unknown page ${JSON.stringify(handle)} (--page takes ${(config.pages || []).map((p) => p.handle).join("|")})`);
  const result = { handle, configChanged: false, statusChanged: false, igUserIdDigits: igUserId.length, appScopedIdDigits: appScopedId ? appScopedId.length : 0, tokenStateBefore: null, configPath, statusPath: null };
  if (page.igUserId !== igUserId || (appScopedId !== null && page.appScopedId !== appScopedId)) {
    page.igUserId = igUserId;
    if (appScopedId !== null) page.appScopedId = appScopedId;
    const r = validate(config, CONFIG_SPEC);
    if (!r.ok) throw new Error(`set-page-ids: config.json would not validate after the change — ${r.errors.join("; ")}`);
    writeJson(configPath, config, indent);
    result.configChanged = true;
  }
  if (resetTokenState) {
    const statusPath = join(companyDir, "state", "status.json");
    if (existsSync(statusPath)) {
      const { json: status, indent: sIndent } = readJson(statusPath);
      const ps = status.pages && status.pages[handle];
      result.tokenStateBefore = ps ? ps.tokenState : null;
      const flag = `token_invalid:${handle}`;
      const hadFlag = Array.isArray(status.flags) && status.flags.includes(flag);
      if ((ps && ps.tokenState === "invalid") || hadFlag) {
        if (ps && ps.tokenState === "invalid") ps.tokenState = "unknown";
        if (hadFlag) status.flags = status.flags.filter((f) => f !== flag);
        status.updatedAt = nowIst(now);
        const r = validate(status, STATUS_SPEC);
        if (!r.ok) throw new Error(`set-page-ids: status.json would not validate after the change — ${r.errors.join("; ")}`);
        writeJson(statusPath, status, sIndent);
        result.statusChanged = true;
        result.statusPath = statusPath;
      }
    }
  }
  return result;
}

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === "reset-token-state") flags[key] = true;
    else if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return flags;
}

export function main(argv = process.argv.slice(2), { stdout = (s) => process.stdout.write(s + "\n"), stderr = (s) => process.stderr.write(s + "\n"), processEnv = process.env } = {}) {
  const flags = parseArgs(argv);
  const handle = typeof flags.page === "string" ? flags.page : null;
  const igUserId = typeof flags["ig-user-id"] === "string" ? flags["ig-user-id"] : null;
  const appScopedId = typeof flags["app-scoped-id"] === "string" ? flags["app-scoped-id"] : null;
  if (!handle || !igUserId) {
    stderr("usage: node scripts/lib/set-page-ids.mjs --page <handle> --ig-user-id <digits> [--app-scoped-id <digits>] [--reset-token-state] [--company <dir>]");
    return 2;
  }
  const companyDir = resolve(ROOT, typeof flags.company === "string" ? flags.company : processEnv.COMPANY_DIR || "company");
  let r;
  try {
    r = setPageIds({ companyDir, handle, igUserId, appScopedId, resetTokenState: flags["reset-token-state"] === true });
  } catch (err) {
    stderr(err.message);
    return err instanceof TypeError ? 2 : 1;
  }
  const ids = `igUserId (${r.igUserIdDigits} digits)${appScopedId ? `, appScopedId (${r.appScopedIdDigits} digits)` : ""}`;
  stdout(r.configChanged ? `set-page-ids: @${handle} ${ids} written to ${r.configPath}` : `set-page-ids: @${handle} ${ids} already in ${r.configPath}; nothing written`);
  if (flags["reset-token-state"] === true) {
    if (r.statusChanged) stdout(`set-page-ids: @${handle} tokenState ${r.tokenStateBefore} -> unknown in ${r.statusPath} (the next publisher run retries the page)`);
    else stdout(`set-page-ids: @${handle} tokenState ${r.tokenStateBefore || "not recorded"}; status.json unchanged`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exit(main());
