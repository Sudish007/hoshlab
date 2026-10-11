// Hoshlab admin UI (design §13; review M2/M9/M12/N1/N6/N11/N20). Runs only in the owner's browser and
// talks to api.github.com directly with a fine-grained token; thumbnails are plain <img> loads from
// raw.githubusercontent.com without the token (N6). Markup is static (src/templates/admin.js); this
// module toggles `hidden`, classes and dataset and builds nodes with createElement/textContent — no HTML
// strings are parsed into the page and NO element ever gets a style attribute (M2). Every write goes
// through ./lib/state.js (admin-owned paths only, schema-validated, 409 retry). Activity reads
// status.json.lastRuns only — never state/runs/ (M9). Human labels come from ./lib/labels.js (OF-5);
// the raw JSON view is the one place a config token appears as written.
import { createClient, GitHubError, scrub } from "./lib/github.js";
import { createStore } from "./lib/store.js";
import { classifyRun, describeLatest } from "./lib/run-status.js";
import { createAdminState } from "./lib/state.js";
import { applyProposal, describeChange, dismissProposal, latestDecisions, proposalStatus } from "./lib/proposals.js";
import { ROSTER_SPEC, TERMINAL_DRAFT_STATUSES, validate } from "./lib/schema.js";
import { runChecks, fullCaption, codePoints } from "./lib/checks.js";
import { parseBrand, validateBrand } from "./lib/brand.js";
import { modeLabel, slotLabel, isApproved, tokenStateLabel, flagSentence, tokenDaysLeft } from "./lib/labels.js";

const cfg = JSON.parse(document.getElementById("admin-config").textContent);
const store = createStore();
const $ = (id) => document.getElementById(id);
const POLL_MS = 10000;
const MAX_POLLS = 60;
const STATE = "company/state";
const VIEWS = ["queue", "blocked", "calendar", "modes", "run", "brand", "roster", "charter", "tell-ceo", "activity", "json"];
const TITLES = { queue: "Approval queue", blocked: "Blocked, failed, expired", calendar: "Calendar", modes: "Publishing modes", run: "Run now", brand: "Brand charter", roster: "Roster", charter: "Agent charter", "tell-ceo": "Tell the CEO", activity: "Activity", json: "Raw file" };

const S = {
  token: null,
  client: null,
  adminState: null,
  data: null, // { drafts: Map<id,{draft,qa}>, approvals, latest: Map, edits: Map, overrides: Map, calendar, config, status }
  brands: new Map(), // handle → parseBrand() of the committed file
  files: new Map(), // path → { text, sha } (editors)
  view: null,
  param: "",
  calMonth: null,
  pollTimer: 0,
  busy: false,
};

/* ---------- IST (fixed +05:30; the host zone never matters) ---------- */
const IST_MIN = 330;
const pad2 = (n) => String(n).padStart(2, "0");
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function istParts(d) {
  const t = new Date(new Date(d).getTime() + IST_MIN * 60000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), ss: t.getUTCSeconds(), dow: t.getUTCDay() };
}
const nowIst = (d = new Date()) => {
  const p = istParts(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}+05:30`;
};
const fmtIst = (iso) => {
  const p = istParts(iso);
  return `${DOWS[p.dow]} ${p.d} ${MONTHS[p.m - 1].slice(0, 3)} · ${pad2(p.hh)}:${pad2(p.mm)} IST`;
};
const fmtIstDay = (iso) => {
  const p = istParts(iso);
  return `${p.d} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}`;
};
const istKey = (iso) => {
  const p = istParts(iso);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
};
const toLocalValue = (iso) => {
  const p = istParts(iso);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}`;
};
const fromLocalValue = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+05:30` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v) ? `${v}+05:30` : null);
const hhmm = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const byteLength = (s) => new TextEncoder().encode(s).length;

/* ---------- DOM helpers ---------- */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}
const txt = (s) => document.createTextNode(String(s));
const clear = (node) => node.replaceChildren();
const show = (node, on = true) => node.toggleAttribute("hidden", !on);
const chip = (text, kind = "", extra = {}) => el("span", { class: `chip chip-plain${kind ? ` chip-${kind}` : ""}`, ...extra }, [hi(text)]);
function setError(node, message) {
  node.textContent = message || "";
  show(node, Boolean(message));
}
// Devanagari runs get <span lang="hi"> so the Devanagari face is used (same rule as the site).
const DEV_RUN = /([\u0900-\u097F\u1CD0-\u1CF9\uA8E0-\uA8FF][\u0900-\u097F\u1CD0-\u1CF9\uA8E0-\uA8FF\u200C\u200D\s.,!?।॥\-:;·]*)/g;
function hi(text) {
  const s = String(text ?? "");
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(DEV_RUN)) {
    const run = m[0].trimEnd();
    frag.append(txt(s.slice(last, m.index)), el("span", { lang: "hi", text: run }), txt(m[0].slice(run.length)));
    last = m.index + m[0].length;
  }
  frag.append(txt(s.slice(last)));
  return frag;
}
const userMessage = (err) => (err instanceof GitHubError ? err.userMessage() : scrub(String(err && err.message ? err.message : err), S.token));
function log(text) {
  $("activity-list").prepend(el("li", {}, [el("time", { text: hhmm() }), el("span", { text: scrub(text, S.token) })]));
}
function fail(err, context) {
  const msg = userMessage(err);
  log(`${context}: ${msg}`);
  if (!(err instanceof GitHubError)) console.error(scrub(String(err && err.stack ? err.stack : err), S.token));
  return msg;
}
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}
const pageOf = (handle) => (S.data && S.data.config ? S.data.config.pages : cfg.pages).find((p) => p.handle === handle) || null;
const modeOf = (handle) => (pageOf(handle) || {}).mode || "approve_first";
const isTerminal = (draft) => TERMINAL_DRAFT_STATUSES.includes(draft.status);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ---------- views / lock ---------- */
function showView(name) {
  show($("lock"), false);
  show($("lock-help"), false);
  show($("dashboard"), true);
  for (const v of VIEWS) show($(`view-${v}`), v === name);
  for (const a of document.querySelectorAll(".admin-tabs a")) {
    if (a.dataset.view === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("view-title").textContent = TITLES[name];
  S.view = name;
}
function showLock() {
  show($("lock"), true);
  show($("lock-help"), true);
  show($("dashboard"), false);
}
function lock(message) {
  clearInterval(S.pollTimer);
  S.token = null;
  S.client = null;
  S.adminState = null;
  S.data = null;
  S.brands.clear();
  S.files.clear();
  showLock();
  setError($("signin-error"), message);
  if (message) $("token").focus();
}

/* ---------- sign-in / out ---------- */
async function validateToken(token) {
  const client = createClient({ token, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch });
  const r = await client.repoInfo();
  if (!r || !r.permissions || r.permissions.push !== true) throw new GitHubError(403, "no push", { kind: "push" });
  return client;
}
async function signIn(event) {
  event.preventDefault();
  const input = $("token");
  const btn = $("signin-btn");
  const token = input.value.trim();
  setError($("signin-error"), "");
  if (!token) return setError($("signin-error"), "Paste a token first");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const client = await validateToken(token);
    const { persisted } = store.set(token, $("remember").checked);
    S.token = token;
    S.client = client;
    S.adminState = createAdminState(client);
    input.value = "";
    log("signed in");
    if (!persisted) log("storage unavailable — the token lives in this page only");
    route();
  } catch (err) {
    setError($("signin-error"), userMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}
function signOut() {
  store.clear();
  log("signed out");
  location.hash = "";
  lock("");
}

/* ---------- state loading (Contents API, 6-way pool; never state/runs/ — M9) ---------- */
async function getJson(path, { optional = false } = {}) {
  try {
    const { text, sha } = await S.client.getFile(path);
    return { value: JSON.parse(text), sha };
  } catch (err) {
    if (optional && err instanceof GitHubError && err.status === 404) return { value: null, sha: null };
    throw err;
  }
}
async function getText(path, { optional = false } = {}) {
  try {
    return await S.client.getFile(path);
  } catch (err) {
    if (optional && err instanceof GitHubError && err.status === 404) return { text: "", sha: null };
    throw err;
  }
}
function parseJsonl(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
function latestByDraft(records) {
  const m = new Map();
  for (const r of [...records].sort((a, b) => String(a.at).localeCompare(String(b.at)))) if (r && r.draftId) m.set(r.draftId, r);
  return m;
}
async function loadData() {
  show($("loading"), true);
  setError($("dash-error"), "");
  const c = S.client;
  const d = { drafts: new Map(), approvals: [], edits: new Map(), overrides: new Map(), calendar: null, config: null, status: null };
  const dirs = await c.listDir(`${STATE}/drafts`);
  const editFiles = await c.listDir(`${STATE}/edits`);
  const jobs = [
    async () => (d.approvals = parseJsonl((await getText(`${STATE}/approvals.jsonl`, { optional: true })).text)),
    async () => (d.overrides = latestByDraft(parseJsonl((await getText(`${STATE}/overrides.jsonl`, { optional: true })).text))),
    async () => (d.calendar = (await getJson(`${STATE}/calendar.json`, { optional: true })).value),
    async () => (d.config = (await getJson("company/config.json")).value),
    async () => (d.status = (await getJson(`${STATE}/status.json`, { optional: true })).value),
    ...dirs.filter((x) => x.type === "dir").map((x) => async () => {
      const draft = (await getJson(`${STATE}/drafts/${x.name}/draft.json`)).value;
      const qa = (await getJson(`${STATE}/drafts/${x.name}/qa.json`, { optional: true })).value;
      d.drafts.set(draft.id, { draft, qa });
    }),
    ...editFiles.filter((x) => x.type === "file" && x.name.endsWith(".json")).map((x) => async () => {
      const edit = (await getJson(`${STATE}/edits/${x.name}`)).value;
      d.edits.set(edit.draftId, edit);
    }),
  ];
  await pool(jobs, 6, (job) => job());
  d.latest = latestByDraft(d.approvals);
  S.data = d;
  show($("loading"), false);
  renderFlags();
  const q = queueDrafts().length;
  $("queue-count").textContent = String(q);
  show($("queue-count"), true);
  log(`loaded ${d.drafts.size} drafts, ${d.approvals.length} approvals, ${d.edits.size} edits from company/state`);
}
// status.json flags as plain sentences above every view — the same words the Home page prints (labels.js is
// byte-copied into dist/admin/lib/). token_expiring:<page> counts the days from pages[<page>].tokenExpiresAt.
function renderFlags() {
  const box = $("status-flags");
  clear(box);
  const status = S.data && S.data.status;
  const flags = (status && status.flags) || [];
  for (const flag of flags) {
    const [kind, page] = String(flag).split(":");
    const opts = { month: status.budget && status.budget.month ? monthLabel(status.budget.month) : "this month" };
    if (kind === "token_expiring") {
      const pageState = status.pages && status.pages[page];
      opts.daysLeft = tokenDaysLeft(pageState && pageState.tokenExpiresAt, new Date());
    }
    let text;
    try {
      text = flagSentence(flag, opts);
    } catch {
      text = "The engine raised a status flag this admin has no sentence for yet; see Raw file → state/status.json.";
    }
    box.append(el("p", { class: "flag", text }));
  }
  show(box, flags.length > 0);
}
// 'October 2026' from a 'YYYY-MM' budget month key.
function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "this month";
}
async function ensureData() {
  if (S.data) return true;
  try {
    await loadData();
    loadDeployStatus();
    return true;
  } catch (err) {
    show($("loading"), false);
    if (err instanceof GitHubError && err.status === 401) {
      store.clear();
      lock(fail(err, "load"));
      return false;
    }
    setError($("dash-error"), fail(err, "load"));
    return false;
  }
}
async function reload() {
  S.data = null;
  S.brands.clear();
  S.files.clear();
  if (await ensureData()) route();
}
async function loadDeployStatus() {
  const node = $("deploy-status");
  clear(node);
  try {
    const info = describeLatest(await S.client.latestWorkflowRun(cfg.workflows.pages));
    if (!info) return;
    node.append(txt(`${info.text} `));
    if (info.url) node.append(el("a", { href: info.url, rel: "noopener", text: "run" }));
  } catch (err) {
    fail(err, "deploy status");
  }
}

/* ---------- derived data ---------- */
const effectiveSlotAt = (draft) => {
  const o = S.data.overrides.get(draft.id);
  if (o) return o.slotAt;
  const slot = S.data.calendar && S.data.calendar.slots.find((s) => s.slotId === draft.slotId);
  return (slot && slot.at) || draft.slotAt;
};
// The draft with a current owner edit merged over it (design §4.8: only when baseRevision === revision).
function effectiveDraft(draft) {
  const e = S.data.edits.get(draft.id);
  if (!e || e.baseRevision !== draft.revision) return draft;
  return { ...draft, caption: e.caption, hashtags: e.hashtags, altText: e.altText, ...(e.altTexts ? { altTexts: e.altTexts } : {}) };
}
const rejected = (draft) => {
  const a = S.data.latest.get(draft.id);
  return Boolean(a && a.decision === "reject");
};
function queueDrafts() {
  return [...S.data.drafts.values()].filter(({ draft }) => draft.status === "queued" && !rejected(draft)).sort((a, b) => effectiveSlotAt(a.draft).localeCompare(effectiveSlotAt(b.draft)));
}
function blockedDrafts() {
  return [...S.data.drafts.values()].filter(({ draft }) => (isTerminal(draft) && draft.status !== "published") || (draft.status === "queued" && rejected(draft))).sort((a, b) => String(b.draft.updatedAt).localeCompare(String(a.draft.updatedAt)));
}
async function brandFor(handle) {
  if (S.brands.has(handle)) return S.brands.get(handle);
  const page = cfg.pages.find((p) => p.handle === handle);
  const { text } = await S.client.getFile(page.brand);
  const parsed = parseBrand(text, page.brand);
  S.brands.set(handle, parsed);
  return parsed;
}
const recentCaptionsFor = (draft) => [...S.data.drafts.values()].filter(({ draft: d }) => d.page === draft.page && d.id !== draft.id).map(({ draft: d }) => d.caption);

/* ---------- queue cards ---------- */
function thumb(card, draft) {
  const a = card.querySelector('[data-slot="open"]');
  const img = card.querySelector('[data-slot="img"]');
  const missing = card.querySelector('[data-slot="img-missing"]');
  // a reel's thumbnail is its poster JPEG (the MP4 row cannot be an <img>)
  const m = (draft.media || []).find((x) => x.kind === "poster") || (draft.media && draft.media[0]);
  if (!m) {
    img.classList.add("missing");
    show(missing, true);
    a.removeAttribute("href");
    a.setAttribute("aria-label", "artwork not rendered yet");
    return;
  }
  a.href = m.rawUrl;
  a.setAttribute("aria-label", `Open ${draft.id} full size`);
  img.alt = draft.altText || "";
  let tried = 0;
  img.addEventListener("error", () => {
    tried++;
    if (tried === 1 && m.pagesUrl) img.src = m.pagesUrl;
    else {
      img.classList.add("missing");
      missing.textContent = "artwork not reachable yet (media branch)";
      show(missing, true);
    }
  });
  img.src = m.rawUrl;
}
function sizeChip(draft) {
  const media = draft.media || [];
  if (!media.length) return chip(`${draft.format} · not rendered yet`);
  const bytes = media.reduce((s, m) => s + (m.bytes || 0), 0);
  const dims = media[0].width && media[0].height ? `${media[0].width}×${media[0].height}` : "";
  return chip(draft.format === "carousel" ? `carousel · ${media.length} slides · ${kb(bytes)}` : `${draft.format} · ${dims} · ${kb(bytes)}`);
}
function qaChips(container, qa) {
  clear(container);
  if (!qa) return container.append(chip("QA not run yet", "warn"));
  for (const c of qa.deterministic.checks) container.append(chip(`${c.id.replace(/_/g, " ")} · ${c.detail || (c.ok ? "ok" : "failed")}`, c.ok ? "ok" : "bad", { title: c.detail || "" }));
  if (qa.model) container.append(chip(`model: ${qa.model.verdict} · tone ${qa.model.toneScore}/5`, qa.model.verdict === "pass" ? "ok" : "bad"));
  else container.append(chip("model: not run"));
}
function card({ draft, qa }, { terminal = false } = {}) {
  const node = $("card-template").content.firstElementChild.cloneNode(true);
  node.dataset.draft = draft.id;
  node.dataset.page = draft.page;
  if (terminal) node.classList.add("is-terminal");
  thumb(node, draft);
  const head = node.querySelector('[data-slot="head"]');
  const approval = S.data.latest.get(draft.id);
  const edit = S.data.edits.get(draft.id);
  const moved = S.data.overrides.has(draft.id);
  head.append(chip(`@${draft.page}`, "", { class: "chip chip-plain chip-handle", "data-page": draft.page }), sizeChip(draft), chip(`slot: ${fmtIst(effectiveSlotAt(draft))}${moved ? " · moved" : ""}`), chip(`rev ${draft.revision}`));
  if (terminal) head.append(chip(rejected(draft) && draft.status === "queued" ? "rejected by owner" : draft.status, "bad"));
  else if (approval && approval.decision === "approve") head.append(isApproved(draft, approval) ? chip(`approved rev ${approval.revision} · ${fmtIst(approval.at)}`, "ok") : chip(`approval stale (rev ${approval.revision})`, "warn"));
  else head.append(chip(modeOf(draft.page) === "autopilot" ? "scheduled (Autopilot)" : "awaiting approval", "accent"));
  if (edit) head.append(edit.baseRevision === draft.revision ? chip(`edited (base rev ${edit.baseRevision})`, "accent") : chip(`edit superseded (base rev ${edit.baseRevision})`, "warn"));
  if (draft.mock) head.append(chip("mock draft", "warn"));
  node.querySelector('[data-slot="id"]').textContent = draft.id;
  const eff = effectiveDraft(draft);
  const cap = node.querySelector('[data-slot="caption"]');
  cap.append(hi(fullCaption(eff)));
  if (draft.language === "hi") cap.setAttribute("lang", "hi");
  qaChips(node.querySelector('[data-slot="qa"]'), qa);
  const note = node.querySelector('[data-slot="note"]');
  const notes = [];
  if (draft.writerNote) notes.push(`Writer note: ${draft.writerNote}`);
  if (draft.designNote) notes.push(`Designer: ${draft.designNote}`);
  notes.push(`alt text: ${eff.altText || "—"}`);
  note.append(hi(notes.join(" · ")));
  const reasons = node.querySelector('[data-slot="reasons"]');
  const why = [...((qa && qa.reasons) || []), ...(draft.renderError ? [`render: ${draft.renderError.code}${draft.renderError.detail ? ` — ${draft.renderError.detail}` : ""}`] : [])];
  if (approval && approval.decision === "reject" && approval.reason) why.unshift(`Owner: ${approval.reason}`);
  if (why.length) {
    reasons.append(hi(`Reasons: ${why.join(" · ")}`));
    show(reasons, true);
  }
  const actions = node.querySelector('[data-slot="actions"]');
  const btn = (text, cls, onClick) => {
    const b = el("button", { type: "button", class: `btn ${cls}`.trim(), text });
    b.addEventListener("click", () => onClick(b));
    return b;
  };
  if (!terminal) {
    if (!(approval && isApproved(draft, approval))) actions.append(btn("Approve", "btn-primary", (b) => approve(draft, b)));
    actions.append(btn("Edit caption", "", () => openEdit(draft)), btn("Move slot", "", () => openMove(draft)), btn("Reject with reason", "btn-danger", () => openReject(draft)));
  }
  if (draft.media && draft.media[0]) actions.append(el("a", { class: "btn btn-quiet", href: draft.media[0].rawUrl, rel: "noopener", target: "_blank", text: "Open full size" }));
  actions.append(el("a", { class: "btn btn-quiet", href: `#/json/state/drafts/${encodeURIComponent(draft.id)}/draft.json`, text: "Raw draft" }));
  return node;
}
function renderQueue() {
  const list = $("queue");
  clear(list);
  const items = queueDrafts();
  for (const item of items) list.append(card(item));
  show($("queue-empty"), items.length === 0);
  $("queue-count").textContent = String(items.length);
  const awaiting = items.filter(({ draft }) => !(S.data.latest.get(draft.id) && isApproved(draft, S.data.latest.get(draft.id))) && modeOf(draft.page) !== "autopilot").length;
  const perPage = cfg.pages.map((p) => `@${p.handle} ${items.filter(({ draft }) => draft.page === p.handle).length}`).join(" · ");
  $("queue-summary").textContent = `${items.length} in the queue (${perPage}) · ${awaiting} awaiting your approval · ${blockedDrafts().length} blocked, failed, expired or rejected`;
}
function renderBlocked() {
  const list = $("blocked");
  clear(list);
  const items = blockedDrafts();
  for (const item of items) list.append(card(item, { terminal: true }));
  show($("blocked-empty"), items.length === 0);
}

/* ---------- approve / reject ---------- */
async function approve(draft, button) {
  button.disabled = true;
  const rec = { draftId: draft.id, decision: "approve", revision: draft.revision, at: nowIst(), by: "owner" };
  try {
    const { commitSha } = await S.adminState.appendLine("state/approvals.jsonl", rec, { message: `approve: ${draft.id} (rev ${draft.revision})` });
    S.data.approvals.push(rec);
    S.data.latest = latestByDraft(S.data.approvals);
    log(`approved ${draft.id} rev ${draft.revision} (${commitSha.slice(0, 7)})`);
    renderQueue();
  } catch (err) {
    button.disabled = false;
    setError($("dash-error"), fail(err, `approve ${draft.id}`));
  }
}
function openReject(draft) {
  const dlg = $("reject-dialog");
  const reason = $("reject-reason");
  const go = $("reject-go");
  $("reject-text").textContent = `${draft.id} (@${draft.page}, rev ${draft.revision}) — the slot is freed; the reason is appended to feedback.jsonl for the Writer.`;
  reason.value = "";
  go.disabled = true;
  setError($("reject-error"), "");
  const update = () => {
    const n = codePoints(reason.value.trim());
    $("reject-count").textContent = `${n} / 500`;
    go.disabled = n < 3 || n > 500;
  };
  update();
  reason.oninput = update;
  dlg.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (go.disabled) return;
    go.disabled = true;
    const text = reason.value.trim();
    const at = nowIst();
    try {
      const rec = { draftId: draft.id, decision: "reject", revision: draft.revision, at, by: "owner", reason: text };
      await S.adminState.appendLine("state/approvals.jsonl", rec, { message: `reject: ${draft.id} (rev ${draft.revision})` });
      S.data.approvals.push(rec);
      S.data.latest = latestByDraft(S.data.approvals);
      await S.adminState.appendLine("state/feedback.jsonl", { at, by: "owner", kind: "reject", page: draft.page, draftId: draft.id, text, tags: [] }, { message: `feedback: reject ${draft.id}` });
      log(`rejected ${draft.id} rev ${draft.revision}`);
      dlg.close("ok");
      renderQueue();
    } catch (err) {
      setError($("reject-error"), fail(err, `reject ${draft.id}`));
      update();
    }
  };
  $("reject-cancel").onclick = () => dlg.close("cancel");
  dlg.showModal();
  reason.focus();
}

/* ---------- edit caption (in-browser checks.js) ---------- */
const parseTags = (v) => v.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith("#") ? t : `#${t}`));
// Line diff (LCS) of two texts → [{ kind: 'same'|'del'|'ins', line }].
function diffLines(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) out.push({ kind: "same", line: A[i++] }), j++;
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: "del", line: A[i++] });
    else out.push({ kind: "ins", line: B[j++] });
  }
  while (i < A.length) out.push({ kind: "del", line: A[i++] });
  while (j < B.length) out.push({ kind: "ins", line: B[j++] });
  return out;
}
async function openEdit(draft) {
  const dlg = $("edit-dialog");
  const save = $("edit-save");
  save.disabled = true;
  setError($("edit-error"), "");
  $("edit-text").textContent = `${draft.id} (@${draft.page}, rev ${draft.revision}) — loading the brand charter…`;
  let brand;
  try {
    brand = await brandFor(draft.page);
  } catch (err) {
    return setError($("dash-error"), fail(err, "brand"));
  }
  const base = effectiveDraft(draft);
  const caption = $("edit-caption");
  const tagsIn = $("edit-hashtags");
  const alt = $("edit-alt");
  caption.value = base.caption;
  tagsIn.value = (base.hashtags || []).join(" ");
  alt.value = base.altText || "";
  $("edit-text").textContent = `${draft.id} (@${draft.page}, rev ${draft.revision}) — saves company/state/edits/${draft.id}.json with baseRevision ${draft.revision}; the Publisher applies it only while the draft stays at this revision.`;
  const original = `${fullCaption(draft)}\nalt: ${draft.altText || ""}`;
  let result = null;
  let next = null;
  const update = () => {
    const tags = parseTags(tagsIn.value);
    next = { ...draft, caption: caption.value.replace(/\r\n/g, "\n"), hashtags: tags, altText: alt.value.trim() };
    const tagList = $("edit-tags");
    clear(tagList);
    for (const t of tags) tagList.append(el("li", {}, [chip(t)]));
    $("edit-caption-count").textContent = `${codePoints(fullCaption(next))} / ${cfg.caps.captionMax} with hashtags`;
    $("edit-alt-count").textContent = `${codePoints(next.altText)} / ${cfg.caps.altTextMax}`;
    try {
      result = runChecks(next, brand, { config: S.data.config, recentCaptions: recentCaptionsFor(draft), media: draft.media });
    } catch (err) {
      result = { passed: false, checks: [{ id: "caption_length", ok: false, detail: err.message }] };
    }
    const list = $("edit-checks");
    clear(list);
    for (const c of result.checks) list.append(el("li", {}, [chip(`${c.id.replace(/_/g, " ")} · ${c.detail}`, c.ok ? "ok" : "bad")]));
    const current = `${fullCaption(next)}\nalt: ${next.altText}`;
    const diff = $("edit-diff");
    clear(diff);
    for (const d of diffLines(original, current)) diff.append(el("span", { class: d.kind, text: `${d.kind === "del" ? "− " : d.kind === "ins" ? "+ " : "  "}${d.line}` }));
    save.disabled = !result.passed || current === original;
  };
  caption.oninput = tagsIn.oninput = alt.oninput = update;
  update();
  dlg.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    const edit = { draftId: draft.id, baseRevision: draft.revision, caption: next.caption, hashtags: next.hashtags, altText: next.altText, ...(draft.altTexts ? { altTexts: draft.altTexts } : {}), at: nowIst(), by: "owner", checks: result };
    try {
      await S.adminState.writeJson(`state/edits/${draft.id}.json`, edit, { message: `edit: ${draft.id} (base rev ${draft.revision})` });
      S.data.edits.set(draft.id, edit);
      log(`edit saved for ${draft.id} (base rev ${draft.revision})`);
      dlg.close("ok");
      renderQueue();
    } catch (err) {
      setError($("edit-error"), fail(err, `edit ${draft.id}`));
      save.disabled = false;
    }
  };
  $("edit-cancel").onclick = () => dlg.close("cancel");
  dlg.showModal();
}

/* ---------- move slot ---------- */
// Other slots of the page at their effective times (calendar + queued drafts, overrides applied).
function otherSlotTimes(draft) {
  const times = new Map();
  for (const s of (S.data.calendar && S.data.calendar.slots) || []) {
    if (s.page !== draft.page || s.slotId === draft.slotId || s.draftId === draft.id || s.status === "dropped") continue;
    const d = s.draftId && S.data.drafts.get(s.draftId);
    times.set(s.slotId, d ? effectiveSlotAt(d.draft) : s.at);
  }
  for (const { draft: d } of S.data.drafts.values()) if (d.page === draft.page && d.id !== draft.id && !isTerminal(d) && !times.has(d.slotId)) times.set(d.slotId, effectiveSlotAt(d));
  return times;
}
function openMove(draft) {
  const dlg = $("move-dialog");
  const input = $("move-at");
  const go = $("move-go");
  $("move-text").textContent = `${draft.id} (@${draft.page}) is at ${fmtIst(effectiveSlotAt(draft))}. The move is appended to overrides.jsonl; the Publisher and the Strategist honour the latest one.`;
  $("move-hint").textContent = `Must be in the future (IST) and at least ${cfg.caps.minGapHours} h away from the page's other slots.`;
  input.value = toLocalValue(effectiveSlotAt(draft));
  let iso = null;
  const validateMove = () => {
    iso = fromLocalValue(input.value);
    let error = "";
    if (!iso) error = "Pick a date and time";
    else if (Date.parse(iso) <= Date.now()) error = "The new slot must be in the future";
    else {
      for (const [slotId, at] of otherSlotTimes(draft)) {
        const hours = Math.abs(Date.parse(iso) - Date.parse(at)) / 3600000;
        if (hours < cfg.caps.minGapHours) error = `Within ${cfg.caps.minGapHours} h of ${slotId} (${fmtIst(at)})`;
      }
    }
    setError($("move-error"), error);
    go.disabled = Boolean(error);
  };
  input.oninput = validateMove;
  validateMove();
  dlg.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (go.disabled) return;
    go.disabled = true;
    const rec = { draftId: draft.id, slotAt: iso, at: nowIst(), by: "owner" };
    try {
      await S.adminState.appendLine("state/overrides.jsonl", rec, { message: `override: ${draft.id} -> ${iso}` });
      S.data.overrides.set(draft.id, rec);
      log(`moved ${draft.id} to ${fmtIst(iso)}`);
      dlg.close("ok");
      if (S.view === "calendar") renderCalendar();
      else renderQueue();
    } catch (err) {
      setError($("move-error"), fail(err, `move ${draft.id}`));
      validateMove();
    }
  };
  $("move-cancel").onclick = () => dlg.close("cancel");
  dlg.showModal();
}

/* ---------- calendar (role=grid/row/columnheader/gridcell like the public page) ---------- */
function renderCalendar() {
  if (!S.calMonth) {
    const p = istParts(new Date());
    S.calMonth = { y: p.y, m: p.m };
  }
  const { y, m } = S.calMonth;
  $("cal-title").textContent = `Calendar · ${MONTHS[m - 1]} ${y}`;
  const grid = $("cal-grid");
  clear(grid);
  const header = el("div", { class: "cal-row", role: "row" });
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) header.append(el("div", { class: "dow", role: "columnheader", text: d }));
  grid.append(header);
  const byDay = new Map();
  const today = istKey(new Date());
  for (const s of (S.data.calendar && S.data.calendar.slots) || []) {
    const entry = S.data.drafts.get(s.draftId);
    const draft = entry ? entry.draft : null;
    const label = slotLabel(s, draft, S.data.latest.get(s.draftId), modeOf(s.page));
    if (!label) continue;
    const at = draft ? effectiveSlotAt(draft) : s.at;
    const key = istKey(at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ s, draft, label, at });
  }
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Monday-first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = offset + days;
  const rows = Math.ceil(cells / 7);
  for (let r = 0; r < rows; r++) {
    const row = el("div", { class: "cal-row", role: "row" });
    for (let c = 0; c < 7; c++) {
      const idx = r * 7 + c;
      const dayNum = idx - offset + 1;
      const inMonth = dayNum >= 1 && dayNum <= days;
      const date = new Date(Date.UTC(y, m - 1, dayNum));
      const key = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
      const cell = el("div", { class: `day${inMonth ? "" : " pad"}${key === today ? " today" : ""}`, role: "gridcell" }, [el("span", { class: "n", text: String(date.getUTCDate()) })]);
      for (const e of (byDay.get(key) || []).sort((a, b) => a.at.localeCompare(b.at))) {
        const p = istParts(e.at);
        const st = `${pad2(p.hh)}:${pad2(p.mm)} · ${e.s.format} · ${e.label}`;
        const movable = e.draft && !isTerminal(e.draft) && e.draft.status !== "published";
        const slot = movable
          ? el("button", { type: "button", class: "slot", "data-page": e.s.page, "aria-label": `Move ${e.draft.id} (${st})` }, [el("span", { text: `@${e.s.page}` }), el("span", { class: "st", text: st })])
          : el("span", { class: "slot", "data-page": e.s.page }, [el("span", { text: `@${e.s.page}` }), el("span", { class: "st", text: st })]);
        if (movable) slot.addEventListener("click", () => openMove(e.draft));
        cell.append(slot);
      }
      row.append(cell);
    }
    grid.append(row);
  }
}
function shiftMonth(delta) {
  const { y, m } = S.calMonth;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  S.calMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  renderCalendar();
}

/* ---------- modes (labels only — N1; segmented buttons are 44 px — N11) ---------- */
function renderModes() {
  const rows = $("mode-rows");
  clear(rows);
  const status = S.data.status;
  for (const page of S.data.config.pages) {
    const inQueue = queueDrafts().filter(({ draft }) => draft.page === page.handle).length;
    const tokenState = status && status.pages && status.pages[page.handle] ? status.pages[page.handle].tokenState : "unknown";
    const seg = el("div", { class: "seg", role: "group", "aria-label": `Mode for @${page.handle}` });
    for (const mode of ["approve_first", "autopilot"]) {
      const b = el("button", { type: "button", "aria-pressed": String(page.mode === mode), "data-mode": mode, text: modeLabel(mode) });
      b.addEventListener("click", () => {
        if (page.mode === mode || S.busy) return;
        if (mode === "autopilot") openModeDialog(page);
        else if (window.confirm(`${cfg.consequences.approve_first.join(" ")}\n\nSwitch @${page.handle} to ${modeLabel("approve_first")}?`)) void writeMode(page.handle, "approve_first");
      });
      seg.append(b);
    }
    rows.append(
      el("div", { class: "mode-row", "data-page": page.handle }, [
        el("span", { class: "who", text: `@${page.handle}` }),
        el("span", { class: "meta", text: `${inQueue} in queue · ${tokenStateLabel(tokenState)} · last change ${fmtIstDay(page.modeChangedAt)} by ${page.modeChangedBy}` }),
        seg,
      ]),
    );
  }
}
function openModeDialog(page) {
  const dlg = $("mode-dialog");
  const input = $("mode-handle");
  const go = $("mode-go");
  $("mode-heading").textContent = `Switch @${page.handle} to ${modeLabel("autopilot")}?`;
  input.value = "";
  input.placeholder = `@${page.handle}`;
  go.disabled = true;
  setError($("mode-error"), "");
  input.oninput = () => (go.disabled = input.value !== `@${page.handle}`);
  dlg.querySelector("form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (go.disabled) return;
    go.disabled = true;
    const r = await writeMode(page.handle, "autopilot");
    if (r.ok) dlg.close("ok");
    else {
      setError($("mode-error"), r.message);
      go.disabled = input.value !== `@${page.handle}`;
    }
  };
  $("mode-cancel").onclick = () => dlg.close("cancel");
  dlg.showModal();
  input.focus();
}
// One commit 'config: @<handle> -> <mode>' (design §13); returns { ok, message } and never throws.
async function writeMode(handle, mode) {
  S.busy = true;
  try {
    const next = JSON.parse(JSON.stringify(S.data.config));
    const page = next.pages.find((p) => p.handle === handle);
    page.mode = mode;
    page.modeChangedAt = nowIst();
    page.modeChangedBy = "owner";
    const { commitSha } = await S.adminState.writeJson("config.json", next, { message: `config: @${handle} -> ${mode}` });
    S.data.config = next;
    log(`@${handle} is now ${modeLabel(mode)} (${commitSha.slice(0, 7)})`);
    renderModes();
    return { ok: true, message: "" };
  } catch (err) {
    const message = fail(err, `mode @${handle}`);
    setError($("dash-error"), message);
    return { ok: false, message };
  } finally {
    S.busy = false;
  }
}

/* ---------- run now (workflow_dispatch + poll) ---------- */
// dispatch(file, button, inputs): workflow_dispatch with { dry_run: false, ...inputs } (every value is sent as a
// string by github.js). "Run analyst" passes { agents: "analyst" } to engine-daily.yml (FEAT-203); the status line
// names the inputs so the owner sees which run the strip follows.
async function dispatch(file, button, inputs = {}) {
  const status = $("run-status");
  const link = $("run-link");
  const label = Object.keys(inputs).length ? `${file} (${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(", ")})` : file;
  clearInterval(S.pollTimer);
  button.disabled = true;
  show(link, false);
  const since = new Date(Date.now() - 60000).toISOString();
  try {
    await S.client.dispatchWorkflow(file, { ...inputs, dry_run: false });
  } catch (err) {
    button.disabled = false;
    status.textContent = fail(err, `dispatch ${label}`);
    return;
  }
  log(`dispatched ${label} on ${cfg.branch}`);
  status.textContent = `${label}: dispatched — run not started yet`;
  let polls = 0;
  let last = "";
  const tick = async () => {
    polls++;
    let run = null;
    try {
      run = await S.client.latestWorkflowRun(file);
    } catch (err) {
      fail(err, "run status");
    }
    const c = classifyRun(run, { since });
    if (c.label !== last) {
      last = c.label;
      log(`${label}: ${c.label}`);
    }
    status.textContent = `${label}: ${c.label}`;
    if (c.url && c.state !== "waiting") {
      link.href = c.url;
      show(link, true);
    }
    if (c.state === "success" || c.state === "failure" || polls >= MAX_POLLS) {
      clearInterval(S.pollTimer);
      button.disabled = false;
      if (polls >= MAX_POLLS && c.state !== "success" && c.state !== "failure") status.textContent = `${label}: still ${c.label} after ${Math.round((POLL_MS * MAX_POLLS) / 60000)} min — open Actions`;
      if (c.state === "success") loadDeployStatus();
    }
  };
  S.pollTimer = setInterval(tick, POLL_MS);
  tick();
}

/* ---------- editors: brand / roster / charter ---------- */
function renderErrors(list, errors, okText) {
  clear(list);
  list.classList.toggle("valid", errors.length === 0);
  if (!errors.length) return list.append(el("li", { class: "ok", text: okText }));
  for (const e of errors) list.append(el("li", { text: e }));
}
function validateCharterText(text) {
  const errors = [];
  const n = codePoints(text);
  if (n > cfg.charter.maxChars) errors.push(`${n} characters, limit ${cfg.charter.maxChars}`);
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  let last = -1;
  for (const h of cfg.charter.headings) {
    const i = lines.indexOf(h);
    if (i < 0) errors.push(`heading '${h}' missing`);
    else if (i < last) errors.push(`heading '${h}' out of order (${cfg.charter.headings.join(", ")})`);
    else last = i;
  }
  return errors;
}
// One text editor: load → validate on input → Save (disabled while errors or unchanged) → writeText.
async function textEditor({ path, rel, textarea, errorsList, saveBtn, stateNode, validateText, message, onInput, onSaved }) {
  const ta = $(textarea);
  const errs = $(errorsList);
  const save = $(saveBtn);
  const state = $(stateNode);
  save.disabled = true;
  state.textContent = "loading…";
  let file;
  try {
    file = S.files.get(path) || (await S.client.getFile(path));
    S.files.set(path, file);
  } catch (err) {
    state.textContent = fail(err, path);
    return;
  }
  ta.value = file.text;
  state.textContent = `${byteLength(file.text)} B · sha ${file.sha.slice(0, 7)}`;
  const update = () => {
    const errors = validateText(ta.value);
    renderErrors(errs, errors, "valid");
    save.disabled = errors.length > 0 || ta.value === file.text;
    if (onInput) onInput(ta.value);
  };
  ta.oninput = update;
  update();
  save.onclick = async () => {
    save.disabled = true;
    state.textContent = "saving…";
    try {
      const r = await S.adminState.writeText(rel, ta.value, { message: message() });
      file = { text: ta.value.replace(/\r\n/g, "\n"), sha: r.contentSha };
      S.files.set(path, file);
      ta.value = file.text;
      state.textContent = `saved · commit ${r.commitSha.slice(0, 7)}`;
      log(`${message()} (${r.commitSha.slice(0, 7)})`);
      if (onSaved) onSaved(file.text);
      update();
    } catch (err) {
      state.textContent = fail(err, rel);
      update();
    }
  };
}
function brandErrors(text) {
  try {
    return validateBrand(parseBrand(text));
  } catch (err) {
    return [err.message];
  }
}
function renderFacts(handle, text) {
  const body = $("brand-facts").querySelector("tbody");
  clear(body);
  let parsed;
  try {
    parsed = parseBrand(text);
  } catch {
    return;
  }
  for (const f of parsed.facts) {
    const bad = /source/.test(brandErrors(text).find((e) => e.includes(`(${f.id})`)) || "");
    const tr = el("tr", { class: `${f.status === "disputed" ? "disputed" : ""}${bad ? " bad" : ""}`.trim() || null }, [
      el("td", { class: "mono", text: f.id }),
      el("td", {}, [hi(f.fact)]),
      el("td", { class: "mono", text: f.source }),
      el("td", {}, [chip(f.status, f.status === "confirmed" ? "ok" : f.status === "disputed" ? "warn" : "")]),
    ]);
    const td = el("td");
    if (f.status === "disputed") {
      const b = el("button", { type: "button", class: "btn", text: "Confirm" });
      b.addEventListener("click", () => confirmFact(handle, f.id, b));
      td.append(b);
    }
    tr.append(td);
    body.append(tr);
  }
}
function confirmRow(text, factId) {
  const re = new RegExp(`^(\\|\\s*${escapeRe(factId)}\\s*\\|.*\\|\\s*)disputed(\\s*\\|?)\\s*$`);
  let done = false;
  const out = text.split(/\r?\n/).map((l) => {
    const m = done ? null : re.exec(l);
    if (!m) return l;
    done = true;
    return `${m[1]}confirmed${m[2]}`;
  });
  if (!done) throw new Error(`no disputed row ${factId} in the file`);
  return out.join("\n");
}
async function confirmFact(handle, factId, button) {
  const page = cfg.pages.find((p) => p.handle === handle);
  const path = page.brand;
  button.disabled = true;
  try {
    const file = S.files.get(path) || (await S.client.getFile(path));
    const next = confirmRow(file.text, factId);
    const errors = brandErrors(next);
    if (errors.length) throw new Error(`cannot confirm: ${errors[0]}`);
    const r = await S.adminState.writeText(`brands/${path.split("/").pop()}`, next, { message: `brand: ${handle} confirm ${factId}` });
    S.files.set(path, { text: next, sha: r.contentSha });
    S.brands.delete(handle);
    log(`brand: ${handle} confirm ${factId} (${r.commitSha.slice(0, 7)})`);
    renderBrand(handle);
  } catch (err) {
    button.disabled = false;
    setError($("dash-error"), fail(err, `confirm ${factId}`));
  }
}
function renderBrand(handle) {
  const page = cfg.pages.find((p) => p.handle === handle) || cfg.pages[0];
  for (const a of document.querySelectorAll("[data-brand-link]")) a.setAttribute("aria-pressed", String(a.dataset.brandLink === page.handle));
  $("brand-path").textContent = page.brand;
  $("brand-heading").textContent = `Brand charter · @${page.handle}`;
  textEditor({
    path: page.brand,
    rel: `brands/${page.brand.split("/").pop()}`,
    textarea: "brand-text",
    errorsList: "brand-errors",
    saveBtn: "brand-save",
    stateNode: "brand-state",
    validateText: brandErrors,
    message: () => `brand: ${page.handle}`,
    onInput: (text) => renderFacts(page.handle, text),
    onSaved: () => S.brands.delete(page.handle),
  });
}
function renderRoster() {
  const ta = $("roster-text");
  const errs = $("roster-errors");
  const save = $("roster-save");
  const state = $("roster-state");
  save.disabled = true;
  state.textContent = "loading…";
  renderProposals();
  S.client
    .getFile("company/roster.json")
    .then((file) => {
      ta.value = file.text;
      state.textContent = `${byteLength(file.text)} B · sha ${file.sha.slice(0, 7)}`;
      let obj = null;
      const update = () => {
        let errors = [];
        try {
          obj = JSON.parse(ta.value);
          errors = validate(obj, ROSTER_SPEC, S.data.config).errors;
        } catch (err) {
          obj = null;
          errors = [`JSON: ${err.message}`];
        }
        renderErrors(errs, errors, "valid");
        save.disabled = errors.length > 0 || ta.value === file.text;
      };
      ta.oninput = update;
      update();
      save.onclick = async () => {
        save.disabled = true;
        state.textContent = "saving…";
        try {
          const r = await S.adminState.writeJson("roster.json", obj, { message: "roster: update", context: S.data.config });
          file = { text: `${JSON.stringify(obj, null, 2)}\n`, sha: r.contentSha };
          ta.value = file.text;
          state.textContent = `saved · commit ${r.commitSha.slice(0, 7)}`;
          log(`roster: update (${r.commitSha.slice(0, 7)})`);
          update();
        } catch (err) {
          state.textContent = fail(err, "roster.json");
          update();
        }
      };
    })
    .catch((err) => (state.textContent = fail(err, "roster.json")));
}

/* ---------- HR proposals (FEAT-204; review N14 / plan D13) ---------- */
// company/state/hr/proposals/*.json (engine-owned, read only) + hr/decisions.jsonl (admin-owned) → one card per proposal,
// newest month first, status derived from the latest decision for its month. Apply / Dismiss go through lib/proposals.js:
// Apply PUTs roster.json (+ charters for charterAppend changes) and appends the decision; Dismiss appends the decision only.
async function loadProposals() {
  const dir = await S.client.listDir(`${STATE}/hr/proposals`);
  const files = dir.filter((x) => x.type === "file" && /^\d{4}-\d{2}\.json$/.test(x.name)).sort((a, b) => b.name.localeCompare(a.name));
  const proposals = [];
  await pool(files, 4, async (x) => {
    const { value } = await getJson(`${STATE}/hr/proposals/${x.name}`);
    proposals.push(value);
  });
  proposals.sort((a, b) => String(b.month).localeCompare(String(a.month)));
  const decisions = parseJsonl((await getText(`${STATE}/hr/decisions.jsonl`, { optional: true })).text);
  return { proposals, decisions: latestDecisions(decisions) };
}
async function renderProposals() {
  const list = $("proposal-list");
  const err = $("proposals-error");
  setError(err, "");
  list.setAttribute("aria-busy", "true");
  let data;
  try {
    data = await loadProposals();
  } catch (e) {
    list.setAttribute("aria-busy", "false");
    return setError(err, fail(e, "hr proposals"));
  }
  clear(list);
  for (const proposal of data.proposals) list.append(proposalCard(proposal, data.decisions));
  show($("proposals-empty"), data.proposals.length === 0);
  list.setAttribute("aria-busy", "false");
}
function proposalCard(proposal, decisions) {
  const status = proposalStatus(proposal, decisions);
  const decision = decisions.get(proposal.month);
  const changes = proposal.changes || [];
  const li = el("li", { class: "proposal", "data-month": proposal.month, "data-status": status });
  const head = el("div", { class: "q-head" }, [chip(`${monthLabel(proposal.month)} (${proposal.month})`, "", { class: "chip chip-plain mono" }), chip(status, status === "proposed" ? "accent" : status === "applied" ? "ok" : ""), chip(`${(proposal.review || []).length} agents reviewed`), chip(`${changes.length} change${changes.length === 1 ? "" : "s"}`)]);
  const meta = el("p", { class: "meta" }, [txt(`written ${fmtIst(proposal.at)} · `), el("a", { href: `#/json/state/${proposal.reviewPath}`, text: proposal.reviewPath }), txt(" · "), el("a", { href: `#/json/state/hr/proposals/${encodeURIComponent(proposal.month)}.json`, text: "proposal JSON" })]);
  if (decision) meta.append(txt(` · ${status} ${fmtIst(decision.at)} by ${decision.by}${decision.applied && decision.applied.length ? ` (${decision.applied.join(", ")})` : ""}`));
  const ul = el("ul", { class: "changes", "aria-label": `Changes proposed for ${proposal.month}` });
  for (const c of changes) ul.append(el("li", {}, [hi(describeChange(c))]));
  if (!changes.length) ul.append(el("li", { class: "meta", text: "No roster change proposed (every verdict is keep)." }));
  const actions = el("div", { class: "q-actions" });
  const stateLine = el("p", { class: "meta m-0", "data-slot": "state" });
  if (status === "proposed") {
    const apply = el("button", { type: "button", class: "btn btn-primary", text: "Apply" });
    const dismiss = el("button", { type: "button", class: "btn", text: "Dismiss" });
    apply.addEventListener("click", () => decideProposal(proposal, "apply", [apply, dismiss], stateLine));
    dismiss.addEventListener("click", () => decideProposal(proposal, "dismiss", [apply, dismiss], stateLine));
    actions.append(apply, dismiss);
  }
  li.append(head, meta, ul, actions, stateLine);
  return li;
}
async function decideProposal(proposal, decision, buttons, stateLine) {
  if (S.busy) return;
  S.busy = true;
  for (const b of buttons) b.disabled = true;
  stateLine.textContent = decision === "apply" ? "applying…" : "dismissing…";
  try {
    const at = nowIst();
    if (decision === "dismiss") {
      const r = await dismissProposal(S.adminState, { proposal, at });
      log(`hr: dismissed proposal ${proposal.month} (${r.result.commitSha.slice(0, 7)})`);
    } else {
      const roster = JSON.parse((await S.client.getFile("company/roster.json")).text);
      const charters = {};
      for (const c of proposal.changes || []) {
        if (c.field !== "charterAppend" || charters[c.agent] !== undefined) continue;
        const agent = roster.agents.find((a) => a.name === c.agent);
        const path = (agent && agent.charter) || cfg.charters[c.agent] || `company/charters/${c.agent}.md`;
        charters[c.agent] = (await S.client.getFile(path)).text;
        S.files.delete(path);
      }
      const r = await applyProposal(S.adminState, { proposal, roster, config: S.data.config, charters, validateCharter: validateCharterText, at });
      log(`hr: applied proposal ${proposal.month} → ${r.applied.join(", ") || "no file changed"} (${r.results["state/hr/decisions.jsonl"].commitSha.slice(0, 7)})`);
    }
    renderRoster(); // the editor shows the applied roster; the card shows its new status
  } catch (err) {
    for (const b of buttons) b.disabled = false;
    stateLine.textContent = fail(err, `${decision} hr proposal ${proposal.month}`);
  } finally {
    S.busy = false;
  }
}
function renderCharter(agent) {
  const name = cfg.agents.includes(agent) ? agent : cfg.agents[0];
  const path = cfg.charters[name] || `company/charters/${name}.md`;
  for (const a of document.querySelectorAll("[data-charter-link]")) a.setAttribute("aria-pressed", String(a.dataset.charterLink === name));
  $("charter-heading").textContent = `Agent charter · ${name}`;
  $("charter-path").textContent = path;
  textEditor({ path, rel: `charters/${path.split("/").pop()}`, textarea: "charter-text", errorsList: "charter-errors", saveBtn: "charter-save", stateNode: "charter-state", validateText: validateCharterText, message: () => `charter: ${name}` });
}

/* ---------- tell the CEO ---------- */
function bindNote() {
  const ta = $("note-text");
  const save = $("note-save");
  const update = () => {
    const n = codePoints(ta.value.trim());
    $("note-count").textContent = `${n} / 1000`;
    save.disabled = n < 3 || n > 1000;
  };
  ta.addEventListener("input", update);
  update();
  save.addEventListener("click", async () => {
    save.disabled = true;
    const page = $("note-page").value;
    const rec = { at: nowIst(), by: "owner", kind: "note", ...(page ? { page } : {}), text: ta.value.trim(), tags: [] };
    try {
      const r = await S.adminState.appendLine("state/feedback.jsonl", rec, { message: "feedback: note" });
      $("note-state").textContent = `sent · commit ${r.commitSha.slice(0, 7)}`;
      log(`note to the CEO (${r.commitSha.slice(0, 7)})`);
      ta.value = "";
      update();
    } catch (err) {
      $("note-state").textContent = fail(err, "note");
      update();
    }
  });
}

/* ---------- activity (status.json.lastRuns only — M9) ---------- */
function renderActivity() {
  const list = $("last-runs");
  clear(list);
  const runs = (S.data.status && S.data.status.lastRuns) || [];
  show($("runs-empty"), runs.length === 0);
  for (const run of runs) {
    const agents = el("ul", {});
    for (const a of run.agents || []) agents.append(el("li", { class: a.skipped ? "skipped" : a.ok ? null : "failed", text: `${a.name}: ${a.note || (a.ok ? "ok" : "failed")}${a.calls ? ` · ${a.calls} call${a.calls === 1 ? "" : "s"}` : ""}` }));
    const head = el("div", {}, [
      el("span", { class: "actor", text: run.workflow }),
      txt(` · ${run.ok ? "ok" : "FAILED"} · ${run.trigger} · ${run.changed.length} file${run.changed.length === 1 ? "" : "s"} changed · USD ${run.budgetUsedUsd.toFixed(2)} used after this run`),
    ]);
    const body = el("div", { class: "runline" }, [head, el("span", { class: "mono", text: run.id }), agents]);
    if (run.errors && run.errors.length) body.append(el("span", { class: "form-error", text: run.errors.join(" · ") }));
    list.append(el("li", { class: run.ok ? null : "failed" }, [el("time", { datetime: run.endedAt, text: fmtIst(run.endedAt) }), body]));
  }
}

/* ---------- raw JSON view ---------- */
async function renderJson(path) {
  const input = $("json-path");
  const out = $("json-out");
  const meta = $("json-meta");
  if (path) input.value = path;
  const rel = input.value.trim().replace(/^\/+/, "").replace(/^company\//, "");
  if (!rel) {
    out.textContent = "";
    meta.textContent = "Enter a path under company/.";
    return;
  }
  meta.textContent = `loading company/${rel}…`;
  try {
    const { text, sha } = await S.client.getFile(`company/${rel}`);
    let pretty = text;
    if (rel.endsWith(".json")) pretty = JSON.stringify(JSON.parse(text), null, 2);
    out.textContent = pretty;
    meta.textContent = `company/${rel} · ${byteLength(text)} B · sha ${sha.slice(0, 7)}`;
  } catch (err) {
    out.textContent = "";
    meta.textContent = fail(err, `company/${rel}`);
  }
}

/* ---------- router ---------- */
async function route() {
  const hash = location.hash || "#/";
  if (!S.token) {
    showLock();
    return;
  }
  const [view, ...rest] = hash.replace(/^#\/?/, "").split("/");
  const param = rest.map((p) => decodeURIComponent(p)).join("/");
  const name = VIEWS.includes(view || "queue") ? view || "queue" : "queue";
  showView(name);
  if (!(await ensureData())) return;
  switch (name) {
    case "queue":
      return renderQueue();
    case "blocked":
      return renderBlocked();
    case "calendar":
      return renderCalendar();
    case "modes":
      return renderModes();
    case "run":
      return undefined;
    case "brand":
      return renderBrand(param);
    case "roster":
      return renderRoster();
    case "charter":
      return renderCharter(param);
    case "tell-ceo":
      return undefined;
    case "activity":
      return renderActivity();
    case "json":
      return renderJson(param);
    default:
      return renderQueue();
  }
}

/* ---------- boot ---------- */
async function boot() {
  if (!("showModal" in HTMLDialogElement.prototype) || typeof TextEncoder === "undefined") {
    setError($("browser-notice"), "This browser is too old — Chromium/Edge 120+, Firefox 120+ or Safari 17+ is needed.");
    return;
  }
  $("signin").addEventListener("submit", signIn);
  $("signin-btn").disabled = false;
  $("signout").addEventListener("click", signOut);
  $("reload").addEventListener("click", reload);
  $("cal-prev").addEventListener("click", () => shiftMonth(-1));
  $("cal-next").addEventListener("click", () => shiftMonth(1));
  $("run-engine").addEventListener("click", (ev) => dispatch(cfg.workflows.engine, ev.currentTarget));
  $("run-publisher").addEventListener("click", (ev) => dispatch(cfg.workflows.publisher, ev.currentTarget));
  $("run-analyst").addEventListener("click", (ev) => dispatch(cfg.workflows.engine, ev.currentTarget, { agents: "analyst" }));
  $("json-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const rel = $("json-path").value.trim().replace(/^company\//, "");
    const target = `#/json/${rel}`;
    if (location.hash === target) renderJson(rel);
    else location.hash = target;
  });
  bindNote();
  for (const id of ["reject-dialog", "edit-dialog", "move-dialog", "mode-dialog"]) $(id).addEventListener("cancel", () => $(id).close("cancel"));
  window.addEventListener("hashchange", route);

  const stored = store.get();
  if (stored) {
    try {
      S.client = await validateToken(stored);
      S.token = stored;
      S.adminState = createAdminState(S.client);
      log(store.remembered() ? "signed in with the remembered token" : "signed in with this tab's token");
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 401 || err.kind === "push")) store.clear();
      lock(userMessage(err));
      return;
    }
  }
  route();
}

boot();
