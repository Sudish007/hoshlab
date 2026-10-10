import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_DIR, FETCH_ATTEMPTS, ROOT } from "./helpers.js";
import { COMMANDS, EXIT, main, parseArgs, usage } from "../engine/index.js";
import { checkModels, NOT_CONFIGURED } from "../engine/commands/check-models.js";
import { readEnv } from "../engine/lib/env.js";

const config = JSON.parse(readFileSync(join(COMPANY_DIR, "config.json"), "utf8"));
const KEYS = { ANTHROPIC_API_KEY: "sk-ant-FAKE-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", GEMINI_API_KEY: "AIzaFAKE-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", OPENAI_API_KEY: "sk-proj-FAKE-cccccccccccccccccccccccccc" };
const SECRET_VALUES = Object.values(KEYS);

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.lines = lines;
  fn.text = () => lines.join("\n");
  return fn;
}

function modelLists({ anthropic = ["claude-sonnet-5-5"], gemini = ["gemini-3.8-flash"], openai = ["gpt-6-luna"], fail = {} } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://api.anthropic.com/v1/models")) return fail.anthropic ? answer({ error: { message: `bad key ${KEYS.ANTHROPIC_API_KEY}` } }, fail.anthropic) : answer({ data: anthropic.map((id) => ({ id })), has_more: false });
    if (u.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) return fail.gemini ? answer({ error: { message: "denied" } }, fail.gemini) : answer({ models: gemini.map((id) => ({ name: `models/${id}` })) });
    if (u.startsWith("https://api.openai.com/v1/models")) return fail.openai ? answer({ error: { message: "denied" } }, fail.openai) : answer({ data: openai.map((id) => ({ id })) });
    throw new Error(`unexpected url ${u}`);
  };
  fn.calls = calls;
  return fn;
}

test("parseArgs: command, --key value, --key=value, --flag booleans, positional rest", () => {
  assert.deepEqual(parseArgs(["check-models"]), { command: "check-models", flags: {}, rest: [] });
  assert.deepEqual(parseArgs(["daily", "--page", "kaatdo", "--dry-run", "--agents=ceo,writer", "--commit", "extra"]), { command: "daily", flags: { page: "kaatdo", "dry-run": true, agents: "ceo,writer", commit: true }, rest: ["extra"] });
  assert.deepEqual(parseArgs(["--dry-run", "publish"]).command, "publish");
  assert.deepEqual(parseArgs([]), { command: null, flags: {}, rest: [] });
});

test("registry: every designed command is listed; unbuilt ones print 'not built yet (planned in …)' and exit 2", async () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), ["analyst", "check-models", "daily", "hr", "publish", "refresh-tokens", "render-sample", "retention", "set-page"]);
  assert.equal(typeof COMMANDS["check-models"].load, "function");
  const expected = { daily: "FEAT-108", publish: "FEAT-107", "render-sample": "FEAT-106", "set-page": "FEAT-108", analyst: "FEAT-203 / phase 2", hr: "FEAT-204 / phase 2", "refresh-tokens": "FEAT-202 / phase 2", retention: "FEAT-202 / phase 2" };
  for (const [name, planned] of Object.entries(expected)) {
    const out = sink();
    const err = sink();
    const code = await main([name, "--dry-run"], { stdout: out, stderr: err, processEnv: {} });
    assert.equal(code, EXIT.usage, name);
    assert.equal(err.text(), `${name}: not built yet (planned in ${planned})`);
    assert.equal(out.lines.length, 0);
  }
  const unknown = sink();
  assert.equal(await main(["frobnicate"], { stdout: sink(), stderr: unknown, processEnv: {} }), EXIT.usage);
  assert.match(unknown.text(), /^frobnicate: unknown command/);
  const none = sink();
  assert.equal(await main([], { stdout: sink(), stderr: none, processEnv: {} }), EXIT.usage);
  assert.match(none.text(), /^usage: node engine\/index\.js <command>/);
  const help = sink();
  assert.equal(await main(["help"], { stdout: help, stderr: sink(), processEnv: {} }), EXIT.ok);
  assert.equal(help.text(), usage());
  assert.ok(usage().includes("retention") && usage().includes("not built yet (planned in FEAT-202 / phase 2)"));
});

test("check-models without keys: one 'not configured yet (secret <NAME> missing)' line per enabled provider, exit 1, no network, no key material", async () => {
  const out = sink();
  const err = sink();
  const fetchImpl = modelLists();
  const code = await main(["check-models"], { stdout: out, stderr: err, processEnv: {}, fetchImpl, companyDir: COMPANY_DIR });
  assert.equal(code, 1);
  assert.deepEqual(out.lines, [NOT_CONFIGURED("anthropic", "ANTHROPIC_API_KEY"), NOT_CONFIGURED("gemini", "GEMINI_API_KEY"), NOT_CONFIGURED("openai", "OPENAI_API_KEY"), "check-models: 0 of 3 enabled providers validated"]);
  assert.equal(out.lines[0], "anthropic: not configured yet (secret ANTHROPIC_API_KEY missing)");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(err.lines.length, 0);
  assert.equal(FETCH_ATTEMPTS.length, 0);
});

test("check-models with keys (fake fetch): model ids verified against the provider lists, notes for ignored temperature / reasoning level, exit 0; unknown id or failing list → exit 1; keys never printed", async () => {
  const fetchImpl = modelLists();
  const out = sink();
  const code = await main(["check-models"], { stdout: out, stderr: sink(), processEnv: { ...KEYS }, fetchImpl, companyDir: COMPANY_DIR });
  assert.equal(code, 0, out.text());
  assert.ok(out.lines.includes("anthropic: claude-sonnet-5-5 ok (temperature ignored by model (not sent))"), out.text());
  assert.ok(out.lines.includes("gemini: gemini-3.8-flash ok (reasoning low)"), out.text());
  assert.ok(out.lines.includes("openai: gpt-6-luna ok (reasoning low)"), out.text());
  assert.ok(out.lines.includes("anthropic: prices verified 2026-10-10 (https://platform.claude.com/docs/en/docs/about-claude/pricing)"));
  assert.equal(out.lines.at(-1), "check-models: 3 of 3 enabled providers validated");
  assert.equal(fetchImpl.calls.length, 3);
  for (const c of fetchImpl.calls) assert.equal(c.init.method, "GET");
  for (const v of SECRET_VALUES) assert.ok(!out.text().includes(v), "no key material on stdout");

  // unknown model id on one provider → that provider fails, exit 1
  const env = readEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], KEYS);
  const r1 = await checkModels({ config, env, fetchImpl: modelLists({ openai: ["gpt-6-astra", "gpt-6-sol"] }) });
  assert.equal(r1.ok, false);
  assert.deepEqual(
    r1.providers.map((p) => [p.name, p.ok]),
    [
      ["anthropic", true],
      ["gemini", true],
      ["openai", false],
    ],
  );
  assert.ok(r1.lines.includes("openai: gpt-6-luna unknown model id (2 models listed by the provider)"), r1.lines.join("\n"));
  assert.equal(r1.summary, "check-models: 2 of 3 enabled providers validated");

  // a 401 on the list call → failure line with the scrubbed reason
  const r2 = await checkModels({ config, env, fetchImpl: modelLists({ fail: { anthropic: 401 } }) });
  assert.equal(r2.ok, false);
  const line = r2.lines.find((l) => l.startsWith("anthropic: model list request failed"));
  assert.ok(line, r2.lines.join("\n"));
  assert.match(line, /HTTP 401/);
  assert.ok(!line.includes(KEYS.ANTHROPIC_API_KEY));

  // prices null → 'prices not configured yet' (the schema would reject this config, so checkModels is called directly)
  const noPrice = structuredClone(config);
  noPrice.providers.gemini.models["gemini-3.8-flash"].inputPerMTok = null;
  const r3 = await checkModels({ config: noPrice, env, fetchImpl: modelLists() });
  assert.equal(r3.ok, false);
  assert.ok(r3.lines.includes("gemini: gemini-3.8-flash prices not configured yet (inputPerMTok / outputPerMTok / maxOutputTokens)"));

  // a secret that is set but malformed is reported as not configured, without a call
  const shortKey = modelLists();
  const r4 = await checkModels({ config, env: readEnv(["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"], { ...KEYS, OPENAI_API_KEY: "short" }), fetchImpl: shortKey });
  assert.equal(r4.ok, false);
  assert.ok(r4.lines.some((l) => /^openai: OPENAI_API_KEY does not look like a key .* — not configured yet$/.test(l)), r4.lines.join("\n"));
  assert.equal(shortKey.calls.length, 2);

  // a disabled provider is not checked at all
  const partial = structuredClone(config);
  partial.providers.openai.enabled = false;
  const r5 = await checkModels({ config: partial, env, fetchImpl: modelLists() });
  assert.equal(r5.ok, true);
  assert.equal(r5.summary, "check-models: 2 of 2 enabled providers validated");
});

test("check-models: an unloadable company dir → exit 1 with a message", async () => {
  const err = sink();
  const code = await main(["check-models"], { stdout: sink(), stderr: err, processEnv: {}, fetchImpl: modelLists(), companyDir: join(ROOT, "tests", "fixtures", "does-not-exist") });
  assert.equal(code, 1);
  assert.match(err.text(), /check-models: cannot load company/);
});
