import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, COMPANY_DIR } from "./helpers.js";
import { SOURCE_RE, validate, ROSTER_SPEC, CONFIG_SPEC } from "../engine/lib/schema.js";
import { parseBrand, validateBrand, usableFacts, factNumbers, forbiddenRegexes, sourcePointers, stampSourceVerifiedAt, FRONT_MATTER_KEYS, BRAND_SECTIONS } from "../engine/lib/brand.js";
import { loadCompany, validateCharter, CompanyError, CHARTER_HEADINGS, CHARTER_MAX_CHARS, resolveCompanyPath } from "../src/lib/company.js";

const REAL = join(ROOT, "company");
const quiet = { warn: () => {} };
const real = loadCompany({ companyDir: REAL, ...quiet });
const HANDLES = ["rishtapatra", "kaatdo", "job_rez"];
const AGENTS = ["ceo", "hr", "strategist", "writer", "designer", "qa", "publisher", "analyst"];

test("the REAL company/ loads without errors and names the three pages and eight agents", () => {
  assert.deepEqual(Object.keys(real.brands).sort(), [...HANDLES].sort());
  assert.deepEqual(Object.keys(real.charters).sort(), [...AGENTS].sort());
  assert.deepEqual(real.config.pages.map((p) => p.handle), HANDLES);
  assert.equal(validate(real.config, CONFIG_SPEC).ok, true);
  assert.equal(validate(real.roster, ROSTER_SPEC, real.config).ok, true);
  assert.deepEqual(real.warnings, [], "real brands are stamped by verify-sources --write, so no M4 warning");
});

test("the fixture company (COMPANY_DIR) loads without errors", () => {
  const fx = loadCompany({ companyDir: COMPANY_DIR, ...quiet });
  assert.deepEqual(Object.keys(fx.brands).sort(), [...HANDLES].sort());
  assert.equal(Object.keys(fx.charters).length, 8);
});

test("M3: every Facts/Pricing (and Tokens) source cell of the three real brand files matches SOURCE_RE", () => {
  let rows = 0;
  for (const handle of HANDLES) {
    const b = real.brands[handle];
    assert.ok(b.facts.length >= 10, `${handle}: ${b.facts.length} facts`);
    for (const f of b.facts) {
      assert.match(f.source, SOURCE_RE, `${handle} ${f.id}: ${f.source}`);
      rows++;
    }
    for (const p of b.pricing) {
      assert.match(p.source, SOURCE_RE, `${handle} pricing ${p.sku}: ${p.source}`);
      rows++;
    }
    for (const e of b.tokens.entries) if (e.kind !== "note") assert.match(e.source || "", SOURCE_RE, `${handle} token ${e.kind} ${e.name}`);
    // every pointer names the brand's own sibling folder
    for (const ref of sourcePointers(b)) for (const p of ref.pointers) assert.equal(p.repo, b.frontMatter.sourceRepo, `${handle} ${ref.id}: ${p.path}`);
  }
  assert.ok(rows >= 40, `${rows} Facts/Pricing rows checked`);
});

function brandWithSource(source) {
  const base = readFileSync(join(REAL, "brands", "kaatdo.md"), "utf8");
  const parsed = parseBrand(base);
  assert.deepEqual(validateBrand(parsed), []);
  return base.replace("kaatdo/web/index.html:31,34,776", source);
}

test("M3 negatives: 'README.md:3' and 'a.md:3, b.md:4' fail validateBrand", () => {
  for (const bad of ["README.md:3", "a.md:3, b.md:4"]) {
    const errors = validateBrand(parseBrand(brandWithSource(bad)));
    assert.ok(errors.some((e) => e.includes("kd-f01") && e.includes("SOURCE_RE")), `${bad}: ${errors.join("; ")}`);
  }
  assert.deepEqual(validateBrand(parseBrand(brandWithSource("kaatdo/web/index.html:21,34,445 ; kaatdo/README.md:3"))), []);
});

test("validateBrand reports bad status, bad colour, non-compiling regex, missing section and missing front matter key", () => {
  const base = readFileSync(join(REAL, "brands", "jobrez.md"), "utf8");
  const parsed = parseBrand(base);
  assert.deepEqual(validateBrand(parsed), []);
  const status = validateBrand(parseBrand(base.replace("| vitae-os/README.md:57 | source-only |", "| vitae-os/README.md:57 | maybe |")));
  assert.ok(status.some((e) => /jr-f13.*status/.test(e)), status.join("; "));
  const colour = validateBrand(parseBrand(base.replace("colour violet: #7c3aed", "colour violet: #7c3ae")));
  assert.ok(colour.some((e) => /colour violet.*#rrggbb/.test(e)), colour.join("; "));
  const regex = validateBrand(parseBrand(base.replace("- `beat the ATS`", "- `beat the ATS(`")));
  assert.ok(regex.some((e) => /Forbidden line \d+: regex does not compile/.test(e)), regex.join("; "));
  const section = validateBrand(parseBrand(base.replace("## Allowed domains", "## Domains")));
  assert.ok(section.some((e) => e.includes("'## Allowed domains' missing")), section.join("; "));
  const key = validateBrand(parseBrand(base.replace("emoji: none\n", "")));
  assert.ok(key.some((e) => e === "front matter: emoji missing"), key.join("; "));
  assert.deepEqual(FRONT_MATTER_KEYS.length, 11);
  assert.deepEqual(BRAND_SECTIONS.length, 8);
});

test("P1-04: rp-f12 is disputed and absent from usableFacts and factNumbers", () => {
  const rp = real.brands.rishtapatra;
  const f12 = rp.facts.find((f) => f.id === "rp-f12");
  assert.ok(f12, "rp-f12 exists");
  assert.equal(f12.status, "disputed");
  assert.match(f12.fact, /11 Indian languages/);
  const usable = usableFacts(rp);
  assert.equal(usable.length, rp.facts.length - 1);
  assert.ok(!usable.some((f) => f.id === "rp-f12"));
  assert.ok(!usable.some((f) => f.status === "disputed"));
  assert.ok(!factNumbers(rp).includes("12"), "the disputed '12 Indian languages' number is not in the allow-list");
  assert.ok(factNumbers(rp).includes("36") && factNumbers(rp).includes("499"), "Guna Milan 36 and Shubh Pass 499 are allowed");
});

test("N12: every brand that allows Devanagari names a Devanagari family in Tokens; KaatDo names Noto Sans Devanagari with its source", () => {
  for (const handle of HANDLES) {
    const b = real.brands[handle];
    const allows = b.frontMatter.allowedDevanagari === null || b.frontMatter.allowedDevanagari.length > 0;
    if (allows) assert.ok(b.tokens.devanagariFamily, `${handle} names a Devanagari family`);
  }
  const kd = real.brands.kaatdo;
  assert.deepEqual(kd.frontMatter.allowedDevanagari, ["काट दो"]);
  assert.equal(kd.tokens.devanagariFamily, "Noto Sans Devanagari");
  assert.equal(kd.tokens.sources["devanagari"], "kaatdo/README.md:225");
  assert.equal(real.brands.rishtapatra.tokens.devanagariFamily, "Tiro Devanagari Hindi");
  assert.equal(real.brands.job_rez.tokens.devanagariFamily, null);
  assert.deepEqual(real.brands.job_rez.frontMatter.allowedDevanagari, []);
  // a Devanagari-allowing brand without a family fails
  const kdText = readFileSync(join(REAL, "brands", "kaatdo.md"), "utf8").replace(/^- Devanagari: .*$/m, "");
  const errors = validateBrand(parseBrand(kdText));
  assert.ok(errors.some((e) => e.includes("N12")), errors.join("; "));
});

test("OF-2: JobRez Forbidden carries the India-specific tokens as regexes and no Devanagari/emoji allowance", () => {
  const jr = real.brands.job_rez;
  for (const src of ["\\bIndia\\b", "\\bIndian\\b", "\\bNaukri\\b", "B\\.?Tech\\b", "\\bGST\\b", "#India", "ATS[- ]certified", "beat the ATS", "AI[- ]powered"]) {
    assert.ok(jr.forbidden.includes(src), `forbidden has ${src}`);
  }
  const res = forbiddenRegexes(jr);
  for (const sample of ["Made in India", "Indian engineers", "Also on Naukri", "B.Tech grads", "BTech", "GST included", "#India", "ATS-certified", "beat the ATS", "AI-powered"]) {
    assert.ok(res.some((re) => re.test(sample)), `forbidden matches ${JSON.stringify(sample)}`);
  }
  for (const sample of ["Build the resume. Land the job.", "Job DNA scores each branch", "free to export"]) {
    assert.ok(!res.some((re) => re.test(sample)), `forbidden does not match ${JSON.stringify(sample)}`);
  }
  assert.equal(jr.frontMatter.emoji, "none");
  assert.deepEqual(jr.frontMatter.languages, ["en"]);
});

test("KaatDo: mandatory disclaimer groups are required on every caption and do not trip the forbidden list", () => {
  const kd = real.brands.kaatdo;
  assert.equal(kd.disclaimers.length, 1);
  assert.equal(kd.disclaimers[0].trigger, "always");
  assert.deepEqual(kd.disclaimers[0].fragments, [["not investment advice"], ["not registered with SEBI", "not SEBI-registered"], ["execution is never guaranteed", "always watch your positions with your broker"]]);
  const res = forbiddenRegexes(kd);
  const caption = "Not investment advice. KaatDo is not SEBI-registered and execution is never guaranteed. काट दो.";
  assert.ok(!res.some((re) => re.test(caption)), "the required fragments themselves are allowed");
  for (const bad of ["guaranteed exit", "SEBI registered", "registered with SEBI", "never lose again", "risk-free", "make profit daily", "₹50,000 profit", "12% returns", "500 traders"]) {
    assert.ok(res.some((re) => re.test(bad)), `forbidden matches ${JSON.stringify(bad)}`);
  }
});

test("RishtaPatra: kundali trigger requires the indicative + pandit fragments; Hindi alternative accepted", () => {
  const rp = real.brands.rishtapatra;
  assert.equal(rp.disclaimers.length, 1);
  assert.deepEqual(rp.disclaimers[0].trigger, ["kundali", "कुंडली", "horoscope", "guna milan"]);
  assert.deepEqual(rp.disclaimers[0].fragments, [["indicative"], ["consult your pandit", "अपने पंडित से सलाह लें"]]);
  assert.equal(rp.frontMatter.emoji, "sparse");
  assert.equal(rp.frontMatter.allowedDevanagari, null);
  assert.ok(rp.pricing.some((p) => p.sku === "shubh-pass" && p.price.includes("₹499")));
});

test("no fabricated social proof: no user counts, testimonials or ratings in any brand file", () => {
  for (const handle of HANDLES) {
    const text = readFileSync(real.brands[handle].path, "utf8");
    const body = text.slice(text.indexOf("## Facts"), text.indexOf("## Forbidden"));
    assert.doesNotMatch(body, /\b\d[\d,]*\+?\s*(?:users|members|traders|customers|families|downloads)\b/i, `${handle}: user count`);
    assert.doesNotMatch(body, /testimonial|rated \d|\d(?:\.\d)?\s*(?:stars|★)|\d(?:\.\d)?\/5\b/i, `${handle}: testimonial or rating`);
    assert.doesNotMatch(body, /trusted by|loved by/i, `${handle}: social proof`);
  }
});

test("every charter has the three headings in order and is at most 12,000 characters; no house rules inside", () => {
  assert.deepEqual(CHARTER_HEADINGS, ["## Identity", "## Method", "## Output"]);
  assert.equal(CHARTER_MAX_CHARS, 12000);
  const dir = join(REAL, "charters");
  assert.deepEqual(readdirSync(dir).sort(), AGENTS.map((a) => `${a}.md`).sort());
  for (const agent of AGENTS) {
    const text = real.charters[agent].text;
    assert.deepEqual(validateCharter(text, agent), []);
    assert.ok([...text].length <= 12000, `${agent} length`);
    assert.doesNotMatch(text, /^## House rules/m, `${agent}: house rules are generated by engine/llm/prompt.js, not stored`);
  }
  assert.match(real.charters.hr.text, /phase 2/i, "HR charter states the monthly review runs in phase 2");
  assert.deepEqual(validateCharter("## Identity\n## Output\n## Method\n", "x"), ["x: heading '## Output' out of order (Identity, Method, Output)"]);
  assert.deepEqual(validateCharter("## Identity\n## Method\n", "x"), ["x: heading '## Output' missing"]);
  assert.ok(validateCharter("## Identity\n## Method\n## Output\n" + "x".repeat(12001), "x")[0].includes("limit 12000"));
});

test("roster invariants: eight agents, qa/publisher deterministic-or-llm as designed, every llm model exists in its provider table, never[] non-empty", () => {
  const agents = Object.fromEntries(real.roster.agents.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(agents).sort(), [...AGENTS].sort());
  assert.equal(agents.designer.kind, "deterministic");
  assert.equal(agents.publisher.kind, "deterministic");
  assert.equal(agents.qa.kind, "llm");
  assert.equal(agents.qa.temperature, 0.0);
  assert.equal(agents.ceo.provider, "anthropic");
  assert.equal(agents.writer.provider, "anthropic");
  assert.equal(agents.hr.provider, "gemini");
  assert.equal(agents.qa.provider, "gemini");
  assert.equal(agents.strategist.provider, "openai");
  assert.equal(agents.analyst.provider, "openai");
  for (const a of real.roster.agents) {
    assert.ok(Array.isArray(a.never) && a.never.length > 0, `${a.name} never[]`);
    if (a.kind === "llm") {
      const p = real.config.providers[a.provider];
      assert.ok(p && p.enabled, `${a.name}: provider enabled`);
      assert.ok(a.model in p.models, `${a.name}: model ${a.model} in providers.${a.provider}.models`);
      for (const fb of a.fallback || []) assert.ok(real.config.providers[fb].enabled, `${a.name}: fallback ${fb}`);
    } else {
      assert.equal(a.provider, undefined);
      assert.equal(a.model, undefined);
    }
  }
  // the loader rejects a roster whose QA is disabled or whose model is unknown
  const broken = structuredClone(real.roster);
  broken.agents.find((a) => a.name === "qa").enabled = false;
  broken.agents.find((a) => a.name === "writer").model = "no-such-model";
  const r = validate(broken, ROSTER_SPEC, real.config);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("qa cannot be disabled")));
  assert.ok(r.errors.some((e) => e.includes("no-such-model")));
});

test("config.json: real model ids with priceSource + pricesVerifiedAt per provider, nothing left as a placeholder", () => {
  for (const [name, p] of Object.entries(real.config.providers)) {
    assert.equal(p.enabled, true, name);
    assert.match(p.priceSource, /^https:\/\//, `${name}.priceSource`);
    assert.match(p.pricesVerifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${name}.pricesVerifiedAt`);
    const ids = Object.keys(p.models);
    assert.ok(ids.length >= 1, `${name} has a model`);
    for (const id of ids) {
      assert.doesNotMatch(id, /[<>…]/, `${name}: ${id} is not a placeholder`);
      const m = p.models[id];
      assert.ok(m.inputPerMTok > 0 && m.outputPerMTok > 0 && m.maxOutputTokens > 0, `${name}/${id} prices`);
    }
  }
  assert.ok("claude-sonnet-5-5" in real.config.providers.anthropic.models);
  assert.ok("gemini-3.8-flash" in real.config.providers.gemini.models);
  assert.ok("gpt-6-luna" in real.config.providers.openai.models);
});

test("loadCompany throws CompanyError with every error for a broken company and resolves 'company/…' paths inside the given dir", () => {
  assert.equal(resolveCompanyPath("/x/fixture", "company/brands/a.md").replace(/\\/g, "/"), "/x/fixture/brands/a.md");
  assert.equal(resolveCompanyPath("/x/fixture", "brands/a.md").replace(/\\/g, "/"), "/x/fixture/brands/a.md");
  assert.throws(
    () => loadCompany({ companyDir: join(ROOT, "tests", "fixtures", "does-not-exist"), ...quiet }),
    (e) => e instanceof CompanyError && e.errors.some((x) => x.startsWith("config.json: file missing")) && e.errors.some((x) => x.startsWith("roster.json: file missing")),
  );
});

test("M4: loader warns (never fails) when sourceVerifiedAt is missing or older than 90 days", () => {
  const warnings = [];
  const fresh = loadCompany({ companyDir: REAL, now: () => new Date("2026-10-20T00:00:00+05:30"), warn: (m) => warnings.push(m) });
  assert.deepEqual(fresh.warnings, []);
  const stale = loadCompany({ companyDir: REAL, now: () => new Date("2027-02-01T00:00:00+05:30"), warn: (m) => warnings.push(m) });
  assert.equal(stale.warnings.length, 3);
  assert.match(stale.warnings[0], /older than 90 days/);
  assert.equal(warnings.length, 3, "warn() was called once per stale brand");
  const unstamped = stampSourceVerifiedAt(readFileSync(join(REAL, "brands", "jobrez.md"), "utf8"), "2026-10-10").replace("sourceVerifiedAt: 2026-10-10", "sourceVerifiedAt: null");
  assert.equal(parseBrand(unstamped).frontMatter.sourceVerifiedAt, null);
});
