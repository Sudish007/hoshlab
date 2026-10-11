// HR proposals in the admin (design §13 "Charter / roster editor" row, §4.2 invariants; review N14; plan D13; FEAT-204).
// Pure helpers plus the two owner decisions, both written through ./state.js (admin-owned paths only, schema-validated):
//   Apply   → builds the roster.json the proposal asks for with schema.applyRosterChanges(), validates it against
//             ROSTER_SPEC with the live config (exactly the eight agents, qa and publisher present and enabled, every
//             model in its enabled provider's table), appends each charterAppend paragraph to charters/<agent>.md,
//             PUTs those files ('roster: apply hr proposal <month>'), then appends hr/decisions.jsonl
//             { month, proposal, decision: 'apply', at, by, applied: [paths] } ('hr: apply proposal <month>').
//   Dismiss → appends hr/decisions.jsonl { decision: 'dismiss' } and nothing else.
// hr/proposals/<month>.json is engine-owned and is never PUT from here: a proposal's status (proposed / applied /
// dismissed) is derived from the decisions log — the latest decision for its month wins.
import { HR_PROPOSAL_SPEC, ROSTER_SPEC, applyRosterChanges, validate } from "./schema.js";

export const DECISIONS_REL = "state/hr/decisions.jsonl";
export const STATUSES = ["proposed", "applied", "dismissed"];
export const DECISION_STATUS = { apply: "applied", dismiss: "dismissed" };

// latestDecisions(records) → Map month → the latest decision for that month (by `at`, then file order).
export function latestDecisions(records = []) {
  const out = new Map();
  for (const r of records) {
    if (!r || !r.month) continue;
    const prev = out.get(r.month);
    if (!prev || String(r.at) >= String(prev.at)) out.set(r.month, r);
  }
  return out;
}

// proposalStatus(proposal, decisions) → 'proposed' | 'applied' | 'dismissed' (decisions: records or the Map above).
export function proposalStatus(proposal, decisions = []) {
  const map = decisions instanceof Map ? decisions : latestDecisions(decisions);
  const d = map.get(proposal.month);
  return d ? DECISION_STATUS[d.decision] || "proposed" : "proposed";
}

// 'writer · temperature: 0.8 → 0.7 — two rework loops on one draft' (charterAppend: from is empty → '—').
export function describeChange(c) {
  const from = c.from === "" || c.from === undefined || c.from === null ? "—" : String(c.from);
  return `${c.agent} · ${c.field}: ${from} → ${String(c.to)} — ${c.why}`;
}

const charterRel = (agent) => `charters/${String((agent && agent.charter) || `company/charters/${agent.name}.md`).split("/").pop()}`;

// buildApply({ proposal, roster, config, charters, validateCharter })
//   → { errors: [], roster, rosterChanged, charters: { <rel>: text }, applied: [paths] }
// `charters` maps an agent name to the CURRENT charter text (needed only for charterAppend changes); `validateCharter`
// (text → errors[]) is the editor's heading/length rule. Refuses when the proposal no longer matches the roster
// (`from` ≠ the current value — the owner edited the roster since), when the resulting roster breaks an invariant, or
// when the shape of the proposal itself is off. Pure: nothing is written.
export function buildApply({ proposal, roster, config, charters = {}, validateCharter = () => [] } = {}) {
  const errors = [];
  const shape = validate(proposal, HR_PROPOSAL_SPEC);
  if (!shape.ok) return { errors: shape.errors.map((e) => `proposal: ${e}`), roster: null, rosterChanged: false, charters: {}, applied: [] };
  const byName = new Map(((roster && roster.agents) || []).map((a) => [a.name, a]));
  const changes = proposal.changes || [];
  const texts = {};
  for (const [i, c] of changes.entries()) {
    const a = byName.get(c.agent);
    if (!a) {
      errors.push(`change ${i + 1}: ${c.agent} is not in the roster`);
      continue;
    }
    if (c.field === "charterAppend") {
      const rel = charterRel(a);
      const current = texts[rel] !== undefined ? texts[rel] : charters[c.agent];
      if (typeof current !== "string") {
        errors.push(`change ${i + 1}: the ${c.agent} charter is not loaded`);
        continue;
      }
      const next = `${current.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n\n${String(c.to).trim()}\n`;
      const bad = validateCharter(next);
      if (bad.length) errors.push(`change ${i + 1}: ${c.agent} charter after the append: ${bad.join("; ")}`);
      else texts[rel] = next;
      continue;
    }
    const current = a[c.field] === undefined ? "" : String(a[c.field]);
    if (String(c.from) !== current) errors.push(`change ${i + 1}: ${c.agent} ${c.field} is ${JSON.stringify(current)} now, the proposal expected ${JSON.stringify(String(c.from))} — the roster changed since HR wrote it`);
  }
  let next = null;
  let rosterChanged = false;
  if (!errors.length) {
    try {
      next = applyRosterChanges(roster, changes);
    } catch (err) {
      errors.push(`roster: ${err.message}`);
    }
  }
  if (next) {
    const r = validate(next, ROSTER_SPEC, config);
    for (const e of r.errors) errors.push(`roster after the proposal: ${e}`);
    rosterChanged = JSON.stringify(next) !== JSON.stringify(roster);
  }
  if (errors.length) return { errors, roster: null, rosterChanged: false, charters: {}, applied: [] };
  const applied = [...(rosterChanged ? ["roster.json"] : []), ...Object.keys(texts)];
  return { errors: [], roster: next, rosterChanged, charters: texts, applied };
}

function decisionRecord(proposal, decision, { at, by = "owner", applied, reason } = {}) {
  const rec = { month: proposal.month, proposal: `hr/proposals/${proposal.month}.json`, decision, at, by };
  if (reason) rec.reason = reason;
  if (applied) rec.applied = applied;
  return rec;
}

// applyProposal(adminState, { proposal, roster, config, charters, validateCharter, at, by })
//   → { applied: [paths], results: { <path>: { commitSha, contentSha } }, decision }
// Writes roster.json (when it changes) and every appended charter first, the decision line last — a failed PUT leaves
// no decision claiming it was applied. Throws before any request when buildApply() reports errors.
export async function applyProposal(adminState, { proposal, roster, config, charters, validateCharter, at, by = "owner" } = {}) {
  const plan = buildApply({ proposal, roster, config, charters, validateCharter });
  if (plan.errors.length) throw new Error(`cannot apply ${proposal && proposal.month ? `the ${proposal.month} proposal` : "the proposal"}: ${plan.errors.join("; ")}`);
  const results = {};
  if (plan.rosterChanged) results["roster.json"] = await adminState.writeJson("roster.json", plan.roster, { message: `roster: apply hr proposal ${proposal.month}`, context: config });
  for (const [rel, text] of Object.entries(plan.charters)) results[rel] = await adminState.writeText(rel, text, { message: `charter: ${rel.split("/").pop().replace(/\.md$/, "")} (hr proposal ${proposal.month})` });
  const decision = decisionRecord(proposal, "apply", { at, by, applied: plan.applied });
  results[DECISIONS_REL] = await adminState.appendLine(DECISIONS_REL, decision, { message: `hr: apply proposal ${proposal.month}` });
  return { applied: plan.applied, results, decision };
}

// dismissProposal(adminState, { proposal, at, by, reason }) → { result, decision } — the decisions log only.
export async function dismissProposal(adminState, { proposal, at, by = "owner", reason } = {}) {
  const decision = decisionRecord(proposal, "dismiss", { at, by, reason });
  const result = await adminState.appendLine(DECISIONS_REL, decision, { message: `hr: dismiss proposal ${proposal.month}` });
  return { result, decision };
}
