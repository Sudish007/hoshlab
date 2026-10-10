// The one prompt envelope every LLM agent gets (design.md §5 "House rules", §7; plan D23).
//   system = charter markdown
//          + '## House rules (generated)'  the seven common rules, phrased for the page's brand
//          + '## Context (generated)'      today IST, page, Voice, usable facts (disputed excluded),
//                                          pricing, disclaimers, forbidden, allowed domains,
//                                          memo excerpt, feedback digest (when non-empty), extra
//          + '## Output (generated)'       JSON-only instruction
//   user   = JSON.stringify(task)
// The charter is owner-editable and never contains the house rules (FEAT-102); they are generated here.
import { usableFacts } from "../lib/brand.js";
import { dowIst, istDate, parseIso } from "../lib/time.js";

export const HOUSE_RULES_HEADING = "## House rules (generated)";
export const CONTEXT_HEADING = "## Context (generated)";
export const OUTPUT_HEADING = "## Output (generated)";
export const JOBREZ_HANDLE = "job_rez";

const LANGUAGE_NAMES = { hi: "Hindi (Devanagari script)", en: "English" };
const DOW_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

// Rough token estimate for logging and the budget gate (chars / 4).
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function handleOf(page, brand) {
  if (typeof page === "string") return page;
  if (page && typeof page.handle === "string") return page.handle;
  if (brand && brand.frontMatter && typeof brand.frontMatter.handle === "string") return brand.frontMatter.handle;
  return null;
}

function languagesOf(page, brand) {
  if (page && Array.isArray(page.languages)) return page.languages;
  if (brand && brand.frontMatter && Array.isArray(brand.frontMatter.languages)) return brand.frontMatter.languages;
  return [];
}

function languageList(codes) {
  return codes.map((c) => LANGUAGE_NAMES[c] || c).join(" and ");
}

function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function quoteList(items) {
  return items.map((s) => `"${s}"`).join(" | ");
}

// The seven common rules (design.md §5), phrased with the brand's own policy values.
export function houseRules({ brand, page } = {}) {
  const fm = (brand && brand.frontMatter) || {};
  const handle = handleOf(page, brand);
  const langs = languagesOf(page, brand);

  let emojiRule;
  if (fm.emoji === "sparse") emojiRule = "Emoji: sparse — at most 2 per caption, never in a headline or on artwork.";
  else if (fm.emoji === "none") emojiRule = "Emoji: none — do not use emoji anywhere (caption, hashtags, alt text, artwork).";
  else emojiRule = "Emoji: none unless the brand's `emoji` policy in its brand file allows it (`sparse` means at most 2 per caption).";

  let languageRule = langs.length ? `Write only in the page's languages: ${languageList(langs)}.` : "Write only in the page's languages as listed in its brand file.";
  if (Array.isArray(fm.allowedDevanagari)) {
    languageRule += fm.allowedDevanagari.length ? ` The only Devanagari allowed on this page: ${quoteList(fm.allowedDevanagari)}.` : " No Devanagari on this page.";
  }

  const jobrezRule =
    handle === JOBREZ_HANDLE
      ? "This page is JobRez: no India-specific branding tokens anywhere — no country names, no local job boards, no local degree or tax acronyms, no country hashtags (OF-2). Write \"live jobs panel\", never a country."
      : "JobRez (@job_rez) only: no India-specific branding tokens — no country names, local job boards, local degree or tax acronyms, country hashtags (OF-2). Other pages are unaffected.";

  return [
    "Use only facts that carry an id in the Facts table below; quote the fact id for every claim you make (factsUsed / factIds).",
    "Never invent numbers, counts, testimonials, ratings, awards, prices or dates. Prices come only from the Pricing table and only with \"at the time of posting\".",
    emojiRule,
    languageRule,
    "Never mention Hoshlab, agents, models or AI in captions, hashtags, alt text or artwork — the page speaks as the product.",
    jobrezRule,
    "Respect the Disclaimers table verbatim: when a trigger fires (or always), include one alternative from every `require` group exactly as written, unweakened.",
  ];
}

export function houseRulesBlock(opts) {
  return `${HOUSE_RULES_HEADING}\n\n${houseRules(opts)
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join("\n")}`;
}

function todayLine(todayIst) {
  if (!todayIst) return "- Today (IST): not given";
  if (typeof todayIst === "string" && /^\d{4}-\d{2}-\d{2}$/.test(todayIst)) return `- Today (IST): ${todayIst}`;
  const d = todayIst instanceof Date ? todayIst : parseIso(String(todayIst));
  return `- Today (IST): ${istDate(d)} (${DOW_NAMES[dowIst(d)]})`;
}

function factsTable(brand) {
  const facts = usableFacts(brand);
  if (!facts.length) return "No usable facts.";
  return ["| id | fact | status |", "|---|---|---|", ...facts.map((f) => `| ${f.id} | ${cell(f.fact)} | ${f.status} |`)].join("\n");
}

function pricingTable(brand) {
  if (!brand.pricing || !brand.pricing.length) return "No pricing rows — quote no prices.";
  return ["| sku | price |", "|---|---|", ...brand.pricing.map((p) => `| ${cell(p.sku)} | ${cell(p.price)} |`)].join("\n");
}

function disclaimerLines(brand) {
  const rows = brand.disclaimers || [];
  if (!rows.length) return "No mandatory disclaimers.";
  return rows
    .map((d) => {
      const when = d.trigger === "always" ? "always" : `when the caption contains any of ${quoteList(d.trigger)}`;
      const groups = d.fragments.map((g) => `one of: ${quoteList(g)}`).join("; and ");
      return `- ${when} → include ${groups}`;
    })
    .join("\n");
}

function forbiddenLines(brand) {
  const rows = brand.forbidden || [];
  if (!rows.length) return "No forbidden patterns.";
  return rows.map((re) => `- \`${re}\``).join("\n");
}

function pageLine(handle, page, brand) {
  if (!handle) return "- Page: none (company-wide task)";
  const fm = (brand && brand.frontMatter) || {};
  const parts = [`- Page: @${handle}`];
  if (fm.name) parts.push(` — ${fm.name}${fm.nameDevanagari ? ` (${fm.nameDevanagari})` : ""}`);
  if (fm.site) parts.push(`, site ${fm.site}`);
  const langs = languagesOf(page, brand);
  if (langs.length) parts.push(`, languages: ${langs.map((c) => LANGUAGE_NAMES[c] || c).join(", ")}`);
  if (fm.emoji) parts.push(`, emoji: ${fm.emoji}`);
  if (page && page.mode) parts.push(`, mode: ${page.mode}`);
  return parts.join("");
}

// The generated context block (design.md §5 envelope).
export function contextBlock({ brand, page, todayIst, memoExcerpt = "", feedbackDigest = "", extra } = {}) {
  const handle = handleOf(page, brand);
  const out = [CONTEXT_HEADING, "", todayLine(todayIst), pageLine(handle, page, brand)];
  if (brand) {
    out.push("", "### Voice", brand.voice && brand.voice.bullets && brand.voice.bullets.length ? brand.voice.bullets.map((b) => `- ${b}`).join("\n") : (brand.voice && brand.voice.text) || "No voice notes.");
    out.push("", "### Facts (usable; disputed rows excluded — these are the only facts you may use)", factsTable(brand));
    out.push("", '### Pricing (quote only from here and only with "at the time of posting")', pricingTable(brand));
    out.push("", "### Disclaimers (required fragments, verbatim)", disclaimerLines(brand));
    out.push("", "### Forbidden (regular expressions, flags iu; any match fails QA)", forbiddenLines(brand));
    out.push("", "### Allowed link domains", brand.allowedDomains && brand.allowedDomains.length ? brand.allowedDomains.map((d) => `- ${d}`).join("\n") : "No links allowed.");
  } else {
    out.push("", "### Brand", "No single brand for this task; brand summaries, if any, are inside the task JSON.");
  }
  if (memoExcerpt && String(memoExcerpt).trim()) out.push("", "### CEO memo (excerpt)", String(memoExcerpt).trim());
  if (feedbackDigest && String(feedbackDigest).trim()) out.push("", "### Owner feedback digest", String(feedbackDigest).trim());
  if (extra !== undefined && extra !== null && extra !== "") out.push("", "### Extra", typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
  return out.join("\n");
}

export function outputBlock() {
  return `${OUTPUT_HEADING}\n\nReturn a single JSON object and nothing else: no Markdown fences, no prose before or after it. Match the output shape in your charter exactly; the engine validates every field and asks once for a correction when it does not fit.`;
}

// buildEnvelope({ agent, charterMarkdown, brand, config, memoExcerpt, todayIst, page, extra, feedbackDigest, task })
//   → { system, user, tokensEstimate, sections }
export function buildEnvelope({ agent, charterMarkdown, brand = null, config = null, memoExcerpt = "", todayIst, page = null, extra, feedbackDigest = "", task = {} } = {}) {
  if (typeof charterMarkdown !== "string" || !charterMarkdown.trim()) throw new TypeError(`prompt: charterMarkdown is required for agent ${agent}`);
  const resolvedPage = typeof page === "string" && config && Array.isArray(config.pages) ? config.pages.find((p) => p.handle === page) || page : page;
  const sections = {
    charter: charterMarkdown.replace(/^\uFEFF/, "").trim(),
    houseRules: houseRulesBlock({ brand, page: resolvedPage }),
    context: contextBlock({ brand, page: resolvedPage, todayIst, memoExcerpt, feedbackDigest, extra }),
    output: outputBlock(),
  };
  const system = [sections.charter, sections.houseRules, sections.context, sections.output].join("\n\n");
  const user = JSON.stringify(task === undefined ? {} : task);
  return { system, user, tokensEstimate: estimateTokens(system) + estimateTokens(user), sections };
}
