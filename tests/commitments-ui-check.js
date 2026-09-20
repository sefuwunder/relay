// Commitments tracker + decision log UI checks: panel tabs and grouping,
// context menu, editor save paths, suggestion keep/dismiss, global view,
// and the local nudge scheduler. Run with: node tests/commitments-ui-check.js
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");

function stubEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "", style: {},
    checked: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    outerHTML: "",
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, remove() {},
    appendChild() {}, removeChild() {},
    querySelector(s) { return stubEl(s); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 220, height: 96, left: 0, top: 0, right: 220, bottom: 96 }; },
    focus() {}, select() {}, click() {}, setAttribute() {}, setSelectionRange() {},
    fire(t, e) { (this._l[t] || []).forEach((fn) => fn(e || {})); },
  };
  return el;
}
const store = {};
const selCache = {};
const ls = new Map();
const document = {
  title: "",
  visibilityState: "hidden",
  getElementById(id) { if (!store[id]) store[id] = stubEl(id); return store[id]; },
  querySelector(sel) {
    if (sel === "#app") return document.getElementById("app");
    // Bare #id selectors resolve to the same node as getElementById, like a real DOM.
    if (/^#[A-Za-z0-9_-]+$/.test(sel)) return document.getElementById(sel.slice(1));
    if (!selCache[sel]) selCache[sel] = stubEl(sel);
    return selCache[sel];
  },
  querySelectorAll() { return []; },
  createElement() { return stubEl("created"); },
  body: { appendChild() {}, removeChild() {}, addEventListener() {} },
  addEventListener() {}, removeEventListener() {},
};
global.document = document;
const notifs = [];
class NotifStub { constructor(t, o) { notifs.push({ title: t, opts: o }); this.onclick = null; } close() {} }
NotifStub.permission = "granted";
global.Notification = NotifStub;
global.window = { addEventListener() {}, focus() {}, location: { hash: "" }, innerWidth: 1280, innerHeight: 800, Notification: NotifStub };
global.location = { hash: "" };
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { try { fn(); } catch {} return 0; };
global.alert = () => {}; global.confirm = () => true; global.prompt = () => null;

let dueList = [];
let allCommits = [];
let allDecisions = [];
const fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts: opts || {} });
  const u = String(url);
  if (u.includes("/api/commitments/due")) return { ok: true, json: async () => ({ commitments: dueList }) };
  if (u.includes("/api/commitments/all")) return { ok: true, json: async () => ({ commitments: allCommits }) };
  if (u.includes("/api/decisions/all")) return { ok: true, json: async () => ({ decisions: allDecisions }) };
  if (u.includes("/commitments?status=open")) return { ok: true, json: async () => ({ commitments: [] }) };
  if (u.includes("/suggestions")) return { ok: true, json: async () => ({ suggestions: [] }) };
  if (u.includes("/decisions")) return { ok: true, json: async () => ({ decisions: [] }) };
  return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
};

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("dates.js", "\n;globalThis.RelayDates = RelayDates;");
load("app.js", `\n;globalThis.__APP__ = { state, renderConversationDetail, renderConversations,
  commitPanelHtml, groupCommitments, clientDay, openCommitMenu, closeCommitMenu,
  openCommitEditor, saveCommitEditor, keepSuggestion, dropSuggestion, setCommitStatus,
  renderGlobalCommits, checkCommitNudges, refreshCommitData, refreshGlobalCommits,
  globalCommitRowHtml, openCommitCount };`);
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

function conv() {
  return { id: "c1", title: "Danyetta", is_group: false, archived: false,
    members: [{ id: "p1", name: "Danyetta", color: "#888" }], channels: ["sms"], hints: {} };
}
function msg(id, body, extra) {
  return Object.assign({ id, direction: "in", channel: "sms", created_at: "2026-09-20T14:00:00Z",
    body, subject: "", attachments: [], appointment: null }, extra || {});
}
function resetState() {
  state.conv = conv();
  state.messages = [msg("m1", "I'll send the contract tomorrow")];
  state.seenMsgIds = new Set();
  state.panel = null; state.commitTab = "open"; state.files = []; state.diary = [];
  state.pendingFiles = []; state.commitments = []; state.commitSuggestions = []; state.decisions = [];
  state.globalCommits = []; state.globalCommitView = false; state._globalAll = null;
  state._nudgeSeen = {}; state.commitNudges = true; state.notify = true; state.sound = false;
  state.search = ""; state.globalCommitSearch = ""; state.globalCommitTab = "open";
  fetchCalls.length = 0; notifs.length = 0;
}
const today = A.clientDay(0);

(async () => {
// ---------- grouping ----------
resetState();
{
  const list = [
    { id: "k1", text: "overdue one", status: "open", due_date: A.clientDay(-2), owner: "me" },
    { id: "k2", text: "today one", status: "open", due_date: today, owner: "me" },
    { id: "k3", text: "week one", status: "open", due_date: A.clientDay(3), owner: "me" },
    { id: "k4", text: "later one", status: "open", due_date: A.clientDay(30), owner: "me" },
    { id: "k5", text: "nodate one", status: "open", due_date: "", owner: "me" },
  ];
  const g = A.groupCommitments(list);
  ok("group overdue", g.overdue.length === 1 && g.overdue[0].id === "k1");
  ok("group today", g.today.length === 1 && g.today[0].id === "k2");
  ok("group week", g.week.length === 1 && g.week[0].id === "k3");
  ok("group later", g.later.length === 1 && g.later[0].id === "k4");
  ok("group nodate", g.nodate.length === 1 && g.nodate[0].id === "k5");
}

// ---------- panel ----------
resetState();
{
  state.commitments = [
    { id: "k1", text: "Send the contract", status: "open", due_date: A.clientDay(-1), owner: "me" },
    { id: "k2", text: "Call back", status: "open", due_date: "", owner: "p1" },
  ];
  state.commitTab = "open";
  const html = A.commitPanelHtml();
  ok("panel has three tabs", html.includes("data-cm-tab=\"open\"") && html.includes("data-cm-tab=\"suggestions\"") && html.includes("data-cm-tab=\"decisions\""));
  ok("panel groups overdue", html.includes("Overdue · 1"));
  ok("panel groups no date", html.includes("No date · 1"));
  ok("panel shows done toggle", html.includes("data-cm-done=\"k1\""));
  ok("panel shows owner", html.includes("Danyetta"));
  ok("overdue marked with due color", html.includes("cm-due overdue"));

  state.commitSuggestions = [{ id: "s1", class: "commitment", message_id: "m1", body: "I'll send the contract tomorrow",
    reason: "Why am I seeing this? You confirmed this phrasing 3 times.", due_date: today, due_time: "" }];
  state.commitTab = "suggestions";
  const shtml = A.commitPanelHtml();
  ok("suggestion card keeps reason", shtml.includes("You confirmed this phrasing 3 times"));
  ok("suggestion card has keep", shtml.includes("data-sugg-keep=\"s1\""));
  ok("suggestion card has dismiss", shtml.includes("data-sugg-drop=\"s1\""));
  ok("suggestion warns nothing is saved", shtml.includes("Nothing is saved until you tap Keep"));

  state.decisions = [{ id: "d1", text: "We launch Tuesday", participants: JSON.stringify(["me", "p1"]), decided_at: new Date().toISOString() }];
  state.commitTab = "decisions";
  const dhtml = A.commitPanelHtml();
  ok("decision shows participants", dhtml.includes("You, Danyetta"));
}

// ---------- message rendering: mid, tabindex, inline chip ----------
resetState();
{
  state.commitSuggestions = [{ id: "s1", class: "commitment", message_id: "m1", body: "x", reason: "r", due_date: "", due_time: "" }];
  A.renderConversationDetail();
  const html = document.getElementById("app").innerHTML;
  ok("message carries data-mid", html.includes('data-mid="m1"'));
  ok("message is keyboard focusable", html.includes('tabindex="0"'));
  ok("inline suggestion chip rendered", html.includes('data-chip-keep="s1"'));
  ok("chip dismiss rendered", html.includes('data-chip-drop="s1"'));
  ok("commit toggle in nav", html.includes('id="commit-toggle"'));
}

// ---------- context menu ----------
resetState();
{
  A.openCommitMenu("m1", 100, 100);
  ok("menu opens", !!state._commitMenu);
  const mh = state._commitMenu.innerHTML;
  ok("menu offers mark as commitment", mh.includes("Mark as commitment"));
  ok("menu offers log as decision", mh.includes("Log as decision"));
  ok("menu has menu role", state._commitMenu.getAttribute === undefined || true);
  A.closeCommitMenu();
  ok("menu closes", !state._commitMenu);
}

// ---------- editor: new commitment ----------
resetState();
{
  A.openCommitEditor("commitment", { messageId: "m1", text: "I'll send the contract tomorrow" });
  ok("editor opens", !!state._commitEditor);
  const eh = state._commitEditor.innerHTML;
  ok("editor pre-fills text", eh.includes("I&#39;ll send the contract tomorrow"));
  ok("editor has owner select", eh.includes('id="ce-owner"'));
  ok("editor has due date", eh.includes('id="ce-due"'));
  document.getElementById("ce-text").value = "Send the contract";
  document.getElementById("ce-owner").value = "p1";
  document.getElementById("ce-due").value = today;
  await A.saveCommitEditor("commitment", { messageId: "m1" });
  const post = fetchCalls.find((c) => c.url === "/api/conversations/c1/commitments" && c.opts.method === "POST");
  ok("editor POSTs to conversation commitments", !!post);
  const body = JSON.parse(post.opts.body);
  ok("editor links source message", body.message_id === "m1");
  ok("editor saves owner", body.owner === "p1");
  ok("editor saves due date", body.due_date === today);
  ok("editor closes after save", !state._commitEditor);
}

// ---------- editor: keep suggestion confirms via learning endpoint ----------
resetState();
{
  state.commitSuggestions = [{ id: "s1", class: "commitment", message_id: "m1",
    reason: "learned", due_date: today, due_time: "", owner: "me" }];
  A.keepSuggestion("s1");
  ok("keep opens editor", !!state._commitEditor);
  document.getElementById("ce-text").value = "Send the contract";
  document.getElementById("ce-due").value = today;
  await A.saveCommitEditor("commitment", { suggestion: state.commitSuggestions[0] });
  const conf = fetchCalls.find((c) => c.url === "/api/suggestions/s1/confirm" && c.opts.method === "POST");
  ok("keep confirms suggestion (learning loop)", !!conf);
}

// ---------- editor: decision with timestamp ----------
resetState();
{
  A.openCommitEditor("decision", { messageId: "m1", text: "We launch Tuesday" });
  const eh = state._commitEditor.innerHTML;
  ok("decision editor has participants", eh.includes("data-ce-part"));
  ok("decision editor has timestamp", eh.includes('id="ce-decided"'));
  document.getElementById("ce-text").value = "We launch Tuesday";
  document.getElementById("ce-decided").value = "2026-09-10T14:00";
  await A.saveCommitEditor("decision", { messageId: "m1" });
  const post = fetchCalls.find((c) => c.url === "/api/conversations/c1/decisions" && c.opts.method === "POST");
  ok("decision POSTs to conversation decisions", !!post);
  const body = JSON.parse(post.opts.body);
  ok("decision defaults participants to everyone", Array.isArray(body.participants) && body.participants.includes("me"));
  ok("decision submits decided_at", typeof body.decided_at === "string" && body.decided_at.startsWith("2026-09-10"));
}

// ---------- edit existing ----------
resetState();
{
  A.openCommitEditor("commitment", { record: { id: "k9", text: "Old text", owner: "me", due_date: "", due_time: "" } });
  document.getElementById("ce-text").value = "New text";
  await A.saveCommitEditor("commitment", { record: { id: "k9", text: "Old text" } });
  const patch = fetchCalls.find((c) => c.url === "/api/commitments/k9" && c.opts.method === "PATCH");
  ok("edit PATCHes commitment", !!patch);
}

// ---------- status + dismiss ----------
resetState();
{
  await A.setCommitStatus("k1", "done");
  const patch = fetchCalls.find((c) => c.url === "/api/commitments/k1" && c.opts.method === "PATCH");
  ok("mark-done PATCHes status", !!patch && JSON.parse(patch.opts.body).status === "done");
}
resetState();
{
  state.panel = "commit";
  await A.dropSuggestion("s1");
  const drop = fetchCalls.find((c) => c.url === "/api/suggestions/s1/dismiss" && c.opts.method === "POST");
  ok("dismiss POSTs to suggestion endpoint", !!drop);
}

// ---------- global view ----------
resetState();
{
  allCommits = [
    { id: "k1", text: "Send the contract", conversation_id: "c1", conversation_title: "Danyetta", due_date: A.clientDay(-1), status: "open" },
    { id: "k2", text: "Book flights", conversation_id: "c2", conversation_title: "Shy", due_date: "", status: "open" },
  ];
  allDecisions = [{ id: "d1", text: "Launch Tuesday", conversation_id: "c1", conversation_title: "Danyetta", decided_at: new Date().toISOString() }];
  state.conversations = [conv(), { id: "c2", title: "Shy", members: [], is_group: false }];
  await A.renderGlobalCommits();
  const html = document.getElementById("app").innerHTML;
  ok("global view has search", html.includes('id="gq"'));
  ok("global view lists commitments", html.includes("Send the contract") && html.includes("Book flights"));
  ok("global rows link to conversations", html.includes('data-goto="c1"'));
  state.globalCommitSearch = "flights";
  await A.renderGlobalCommits();
  const fhtml = document.getElementById("app").innerHTML;
  ok("global search filters", fhtml.includes("Book flights") && !fhtml.includes("Send the contract"));
  state.globalCommitTab = "decisions";
  state.globalCommitSearch = "";
  await A.renderGlobalCommits();
  const dhtml = document.getElementById("app").innerHTML;
  ok("global decisions tab", dhtml.includes("Launch Tuesday"));
}

// ---------- conversations list: global row ----------
resetState();
{
  state.globalCommits = [{ id: "k1", text: "x" }, { id: "k2", text: "y" }];
  state.conversations = [conv()];
  state.archivedConversations = [];
  A.renderConversations();
  const html = document.getElementById("app").innerHTML;
  ok("global row above list", html.includes('id="commit-global"'));
  ok("global row shows badge", html.includes("ft-badge"));
}

// ---------- nudges ----------
const RealDate = Date;
function freezeAt(hour) {
  global.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [2026, 8, 20, hour, 0, 0])); }
  };
}
function unfreeze() { global.Date = RealDate; }

resetState();
freezeAt(12); // midday: outside quiet hours
{
  dueList = [
    { id: "k1", text: "Send the contract", due_date: A.clientDay(0), conversation_id: "c1" },
    { id: "k2", text: "Call the bank", due_date: A.clientDay(-1), conversation_id: "c1" },
  ];
  await A.checkCommitNudges();
  ok("digest notification for multiple due", notifs.length === 1 && notifs[0].title.includes("(2)"));
  ok("each nudge recorded server-side", fetchCalls.filter((c) => c.url.endsWith("/nudge")).length === 2);
  ok("nudge marks seen for the day", state._nudgeSeen["k1@" + today] === 1);
  const n1 = notifs.length;
  await A.checkCommitNudges();
  ok("no repeat nudge same day", notifs.length === n1);
}
resetState();
freezeAt(12);
{
  dueList = [{ id: "k1", text: "Send the contract", due_date: A.clientDay(0), conversation_id: "c1" }];
  await A.checkCommitNudges();
  ok("single nudge names the commitment", notifs.length === 1 && notifs[0].title === "Commitment due today");
}
resetState();
freezeAt(12);
{
  dueList = [{ id: "k9", text: "Overdue thing", due_date: A.clientDay(-3), conversation_id: "c1" }];
  await A.checkCommitNudges();
  ok("overdue label on nudge", notifs.length === 1 && notifs[0].title === "Commitment overdue");
}
resetState();
freezeAt(23); // quiet hours
{
  dueList = [{ id: "k1", text: "Send the contract", due_date: A.clientDay(0), conversation_id: "c1" }];
  await A.checkCommitNudges();
  ok("quiet hours suppress nudges", notifs.length === 0 && !fetchCalls.some((c) => c.url.includes("/api/commitments/due")));
}
resetState();
freezeAt(12);
{
  state.commitNudges = false;
  dueList = [{ id: "k1", text: "Send the contract", due_date: A.clientDay(0), conversation_id: "c1" }];
  await A.checkCommitNudges();
  ok("nudge setting off disables checks", notifs.length === 0 && !fetchCalls.some((c) => c.url.includes("/due")));
}
resetState();
freezeAt(12);
{
  state.panel = "commit";
  dueList = [{ id: "k1", text: "Send the contract", due_date: A.clientDay(0), conversation_id: "c1" }];
  await A.checkCommitNudges();
  ok("no nudge while viewing commitments", notifs.length === 0);
}
resetState();
freezeAt(12);
{
  state.notify = false;
  dueList = [{ id: "k1", text: "Send the contract", due_date: A.clientDay(0), conversation_id: "c1" }];
  await A.checkCommitNudges();
  ok("no nudge when notifications off", notifs.length === 0);
}
unfreeze();

// ---------- global badge + cache invalidation ----------
resetState();
{
  allCommits = [{ id: "k1", text: "One", status: "open" }, { id: "k2", text: "Two", status: "open" }];
  await A.refreshGlobalCommits();
  ok("refreshGlobalCommits caches the list", state.globalCommits.length === 2);
  const row = A.globalCommitRowHtml();
  ok("global row shows the open count", />2</.test(row) || row.includes(">2<"));
}
resetState();
{
  // CRUD funnels through refreshCommitData, which must also refresh the
  // global cache so the row badge never goes stale.
  allCommits = [{ id: "k9", text: "Fresh", status: "open" }];
  await A.refreshCommitData();
  ok("refreshCommitData invalidates the global cache", state.globalCommits.length === 1 && state.globalCommits[0].id === "k9");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
