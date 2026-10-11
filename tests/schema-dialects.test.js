// Review M7 prove-by: every agent OUTPUT_SPEC converts to both provider dialects — Gemini without any
// `additionalProperties`, OpenAI strict with every object listing all its properties in `required`
// and additionalProperties:false — and every tests/fixtures/llm/<agent>.ok*.json output passes
// assertShape(OUTPUT_SPEC). The agent modules are discovered from engine/agents/ so a new agent
// (the Analyst in phase 2) joins automatically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.js";
import { assertShape, toJsonSchema } from "../engine/lib/schema.js";

const AGENTS_DIR = join(ROOT, "engine", "agents");
const LLM_FIXTURES = join(ROOT, "tests", "fixtures", "llm");
const EXPECTED_PHASE_1 = ["ceo", "hr", "qa", "strategist", "writer"];

async function agentModules() {
  const out = [];
  for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const mod = await import(pathToFileURL(join(AGENTS_DIR, file)).href);
    if (mod.OUTPUT_SPEC) out.push({ agent: file.replace(/\.js$/, ""), spec: mod.OUTPUT_SPEC });
  }
  return out;
}

// Walks a JSON Schema and yields every node that is an object (type 'object' or has properties),
// descending through properties, array items and anyOf branches (optional objects in the openai dialect).
function* objectNodes(schema, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (schema.type === "object" || schema.properties) yield { path, node: schema };
  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, sub] of Object.entries(schema.properties)) yield* objectNodes(sub, `${path}.${name}`);
  }
  if (schema.items) yield* objectNodes(schema.items, `${path}[]`);
  if (Array.isArray(schema.anyOf)) for (const [i, s] of schema.anyOf.entries()) yield* objectNodes(s, `${path}<anyOf ${i}>`);
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((v) => hasKeyDeep(v, key));
}

test("every engine/agents/*.js OUTPUT_SPEC exists for the Phase 1 LLM agents and converts to the gemini dialect without additionalProperties anywhere", async () => {
  const mods = await agentModules();
  const names = mods.map((m) => m.agent);
  for (const a of EXPECTED_PHASE_1) assert.ok(names.includes(a), `engine/agents/${a}.js exports OUTPUT_SPEC`);
  for (const { agent, spec } of mods) {
    const gemini = toJsonSchema(spec, "gemini");
    assert.equal(hasKeyDeep(gemini, "additionalProperties"), false, `${agent}: gemini schema has no additionalProperties`);
    assert.equal(hasKeyDeep(gemini, "$ref"), false, `${agent}: gemini schema has no $ref`);
    assert.equal(hasKeyDeep(gemini, "patternProperties"), false, `${agent}: gemini schema has no patternProperties`);
    assert.equal(gemini.type, "object");
    assert.ok(Object.keys(gemini.properties).length >= 2, `${agent}: gemini schema lists its properties`);
  }
});

test("openai strict dialect: every object node lists all its properties in required and has additionalProperties:false", async () => {
  const mods = await agentModules();
  for (const { agent, spec } of mods) {
    const openai = toJsonSchema(spec, "openai");
    let objects = 0;
    for (const { path, node } of objectNodes(openai)) {
      objects += 1;
      assert.equal(node.additionalProperties, false, `${agent} ${path}: additionalProperties:false`);
      const props = Object.keys(node.properties || {}).sort();
      assert.deepEqual([...(node.required || [])].sort(), props, `${agent} ${path}: required lists every property`);
    }
    assert.ok(objects >= 1, `${agent}: at least the root object`);
    assert.equal(typeof toJsonSchema(spec, "prompt"), "string", `${agent}: prompt dialect is a string`);
    assert.doesNotThrow(() => JSON.parse(toJsonSchema(spec, "prompt")), `${agent}: prompt example is JSON`);
  }
});

test("every tests/fixtures/llm/<agent>.ok*.json output passes assertShape(OUTPUT_SPEC) (page-keyed fixtures included)", async () => {
  const mods = await agentModules();
  const files = readdirSync(LLM_FIXTURES).filter((f) => f.endsWith(".json"));
  let checked = 0;
  for (const { agent, spec } of mods) {
    const mine = files.filter((f) => f === `${agent}.ok.json` || f.startsWith(`${agent}.ok.`));
    assert.ok(mine.length >= 1, `${agent}: at least one *.ok.json fixture`);
    for (const f of mine) {
      const fx = JSON.parse(readFileSync(join(LLM_FIXTURES, f), "utf8"));
      assert.equal(fx.agent, agent, `${f}: agent field`);
      assert.ok(fx.output && typeof fx.output === "object", `${f}: output object`);
      assert.doesNotThrow(() => assertShape(fx.output, spec), `${f}: assertShape(OUTPUT_SPEC)`);
      assert.ok(Number.isInteger(fx.usage.inputTokens) && Number.isInteger(fx.usage.outputTokens), `${f}: usage token counts`);
      checked += 1;
    }
  }
  assert.ok(checked >= 9, `checked ${checked} fixtures (ceo, hr, qa ×3, strategist ×3, writer ×3)`);
  // every fixture file names an agent that has an OUTPUT_SPEC (no orphan fixtures)
  const agents = new Set(mods.map((m) => m.agent));
  for (const f of files) assert.ok(agents.has(f.split(".")[0]), `${f}: names a known agent`);
});

test("the *.bad.json fixtures fail validation the way their note says (shape for strategist/writer, semantic for ceo and analyst)", async () => {
  const mods = Object.fromEntries((await agentModules()).map((m) => [m.agent, m.spec]));
  const bad = (name) => JSON.parse(readFileSync(join(LLM_FIXTURES, `${name}.bad.json`), "utf8")).output;
  assert.throws(() => assertShape(bad("strategist"), mods.strategist), /assignments: required/);
  assert.throws(() => assertShape(bad("writer"), mods.writer), /caption: longer than 2200 characters \(2300\)/);
  assert.doesNotThrow(() => assertShape(bad("ceo"), mods.ceo), "ceo.bad is shape-valid; the 120 % split is caught by validateCeoOutput");
  const split = bad("ceo").budgetSplitPct;
  assert.equal(Object.values(split).reduce((a, b) => a + b, 0), 120);
  // FEAT-203: analyst.bad is shape-valid; the 999 that no metrics record holds is caught by validateAnalystOutput (tests/analyst.test.js)
  assert.doesNotThrow(() => assertShape(bad("analyst"), mods.analyst), "analyst.bad is shape-valid");
  assert.equal(bad("analyst").perPage.find((p) => p.page === "kaatdo").reach, 999);
  assert.ok(bad("analyst").reportMarkdown.includes("reached 999 accounts"));
});
