// Mock adapter: answers from tests/fixtures/llm/<agent>.<case>.json (design.md §7, review M5.4).
// Selected by the router ONLY when process.env.MOCK_LLM === '1' — never as a budget fallback.
// Case: MOCK_LLM_CASE_<AGENT> (per agent) else MOCK_LLM_CASE else 'ok'. A missing fixture throws
// MockFixtureError: the mock never fabricates output.
// Fixture shape (see tests/fixtures/llm/README.md):
//   { "agent": "writer", "case": "ok", "output": { … }, "usage": { "inputTokens": 0, "outputTokens": 0 } }
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toInt } from "./adapter.js";

export const provider = "mock";
export const DEFAULT_CASE = "ok";
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../../tests/fixtures/llm/", import.meta.url));

export class MockFixtureError extends Error {
  constructor(message, path) {
    super(message);
    this.name = "MockFixtureError";
    this.path = path;
  }
}

export function isMockEnabled(processEnv = process.env) {
  return processEnv.MOCK_LLM === "1";
}

export function fixtureCase(agent, processEnv = process.env) {
  const perAgent = processEnv[`MOCK_LLM_CASE_${String(agent).toUpperCase()}`];
  if (perAgent) return perAgent;
  return processEnv.MOCK_LLM_CASE || DEFAULT_CASE;
}

export function fixturePath(agent, { processEnv = process.env, fixturesDir = DEFAULT_FIXTURES_DIR, caseName = fixtureCase(agent, processEnv) } = {}) {
  if (!/^[a-z][a-z0-9_-]*$/.test(String(agent))) throw new MockFixtureError(`mock: bad agent name ${JSON.stringify(agent)}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(String(caseName))) throw new MockFixtureError(`mock: bad case name ${JSON.stringify(caseName)}`);
  return { path: join(fixturesDir, `${agent}.${caseName}.json`), caseName };
}

export function loadFixture(agent, opts = {}) {
  const { path, caseName } = fixturePath(agent, opts);
  if (!existsSync(path)) throw new MockFixtureError(`mock: fixture missing for ${agent} case ${caseName} (${path}); the mock adapter never fabricates output`, path);
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new MockFixtureError(`mock: fixture ${path} is not valid JSON: ${e.message}`, path);
  }
  if (!fixture || typeof fixture !== "object" || !fixture.output || typeof fixture.output !== "object") {
    throw new MockFixtureError(`mock: fixture ${path} needs an object "output" key`, path);
  }
  return { fixture, path, caseName };
}

// complete({ agent, processEnv, fixturesDir }) → adapter result + mock:true. Other adapter fields are ignored.
export async function complete({ agent, processEnv = process.env, fixturesDir = DEFAULT_FIXTURES_DIR, model = "mock" }) {
  const started = Date.now();
  const { fixture, caseName } = loadFixture(agent, { processEnv, fixturesDir });
  const usage = fixture.usage || {};
  return {
    text: JSON.stringify(fixture.output),
    json: structuredClone(fixture.output),
    usage: { inputTokens: toInt(usage.inputTokens), outputTokens: toInt(usage.outputTokens) },
    model,
    provider,
    ms: Date.now() - started,
    raw: { status: 200, id: `mock:${agent}.${caseName}` },
    mock: true,
  };
}
