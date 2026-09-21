// AI agent contact UI checks: the contact sheet's Person/AI-agent kind toggle,
// the "AI agent" badge in the people grid and headers, the agent conversation
// detail (no channel picker, badge, "Message <name>…" placeholder, no reply
// bar), the agent detail card, the group member picker filter, and the
// sendMsg channel guards. Run with: bun tests/agent-ui-check.js
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");

function stubEl(id) {
  const el = {
    id: id || "", textContent: "", value: "", className: "", style: {},
    checked: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _html: "", _q: {},
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, remove() {},
    appendChild() {}, removeChild() {},
    // Cache per-selector stubs so visibility toggles on sheet sub-elements are
    // observable across separate $() lookups.
    querySelector(s) { if (!this._q[s]) this._q[s] = stubEl(s); return this._q[s]; },
    querySelectorAll() { return []; },
    focus() {}, click() {}, setAttribute() {},
    fire(t, e) { (this._l[t] || []).forEach((fn) => fn(e || {})); },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      if (id === "app") { for (const k of Object.keys(selCache)) delete selCache[k]; }
    },
  });
  return el;
}
const store = {};
const selCache = {};
const created = [];
const keyHandlers = [];
const ls = new Map();
const document = {
  title: "",
  visibilityState: "hidden",
  getElementById(id) { if (!store[id]) store[id] = stubEl(id); return store[id]; },
  querySelector(sel) {
    if (sel === "#app") return document.getElementById("app");
    if (!selCache[sel]) selCache[sel] = stubEl(sel);
    return selCache[sel];
  },
  querySelectorAll() { return []; },
  createElement(tag) { const el = stubEl("created"); created.push(el); return el; },
  body: { appendChild() {}, removeChild() {}, addEventListener() {} },
  addEventListener(t, fn) { if (t === "keydown") keyHandlers.push(fn); },
};
global.document = document;
global.window = { addEventListener() {}, focus() {}, location: { hash: "" } };
global.location = { hash: "" };
global.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
global.Notification = class { constructor() {} close() {} static requestPermission() { return Promise.resolve("granted"); } };
global.Notification.permission = "granted";
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { try { fn(); } catch {} return 0; };
global.alert = () => {}; global.confirm = () => false; global.prompt = () => null;

const fetchCalls = [];
const agentReply = { id: "m2", direction: "in", channel: "agent", body: "On it.", created_at: "2026-09-20T12:01:00" };
const sentMsg = { id: "m1", direction: "out", channel: "agent", body: "hello", created_at: "2026-09-20T12:00:00" };
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || "GET", body: (opts && opts.body) || null });
  const u = String(url);
  const json = async () => {
    if (u.includes("/messages") && (opts && opts.method) === "POST") return { message: sentMsg };
    if (u.includes("/messages")) return { messages: [sentMsg, agentReply] };
    return {};
  };
  return { ok: true, json, arrayBuffer: async () => new ArrayBuffer(0) };
};

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, renderConversations, renderConversationDetail, loadConversations, openContactSheet, renderPeople, renderPersonDetail, renderNewGroup, sendMsg, chanPill };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

const sheetOf = () => created.filter((e) => (e._html || "").includes("f-kind-seg")).pop();
// Fire the sheet's delegated kind-toggle handler with a fake click target.
const toggleKind = (sheet, kind) => sheet.fire("click", { target: { closest: (sel) => sel === "#f-kind-seg button" ? { dataset: { kind } } : null } });

const personC = { id: "a", name: "Alma", color: "#0a84ff", channels: ["email"], kind: "person", email: "alma@example.com", avatar_url: null };
const agentC = { id: "b", name: "Milton", color: "#b5543f", channels: ["agent"], kind: "agent", agent_url_set: true, has_agent_secret: true, avatar_url: null };
const agentConv = {
  id: "c1", title: "Milton", is_group: false, archived: 0,
  members: [{ id: "b", name: "Milton", color: "#b5543f", kind: "agent" }],
  channels: ["agent"], hints: {},
};
function openAgentConv() {
  state.conv = JSON.parse(JSON.stringify(agentConv));
  state.messages = []; state.files = []; state.diary = []; state.panel = null;
  state.seenMsgIds = new Set(); state.pendingFiles = []; state.eventForm = false;
  state.replyTo = null; state.sending = false;
  A.renderConversationDetail();
  return document.getElementById("app").innerHTML;
}

(async () => {
  // --- contact sheet: kind toggle ---
  A.openContactSheet(null);
  let sheet = sheetOf();
  ok("sheet opens", !!sheet);
  ok("person fields visible by default", sheet.querySelector("#f-person-fields").style.display === "");
  ok("agent fields hidden by default", sheet.querySelector("#f-agent-fields").style.display === "none");
  ok("save button says Add person by default", sheet.querySelector("#save").textContent === "Add person");
  ok("agent seg tab is off by default", sheet._html.includes('data-kind="agent" class=""'));
  toggleKind(sheet, "agent");
  ok("toggle shows agent fields", sheet.querySelector("#f-agent-fields").style.display === "");
  ok("toggle hides person fields", sheet.querySelector("#f-person-fields").style.display === "none");
  ok("save button says Add agent in agent mode", sheet.querySelector("#save").textContent === "Add agent");
  ok("sheet title says Add agent in agent mode", sheet.querySelector("#f-title").textContent === "Add agent");
  ok("agent mode has the endpoint URL field", sheet._html.includes('id="f-agent-url"') && sheet._html.includes("http://127.0.0.1:3009/api/chat"));
  ok("agent mode has the secret hint", sheet._html.includes("Sent as X-Agent-Secret header."));
  toggleKind(sheet, "person");
  ok("toggle back restores person fields", sheet.querySelector("#f-person-fields").style.display === "" && sheet.querySelector("#f-agent-fields").style.display === "none");
  ok("save button back to Add person", sheet.querySelector("#save").textContent === "Add person");

  // --- contact sheet: editing an existing agent ---
  A.openContactSheet(agentC);
  const esheet = sheetOf();
  ok("edit sheet starts in agent mode", esheet.querySelector("#f-agent-fields").style.display === "" && esheet.querySelector("#f-person-fields").style.display === "none");
  ok("agent seg tab is on when editing an agent", esheet._html.includes('data-kind="agent" class="on"'));
  ok("secret placeholder says saved when a secret is set", esheet._html.includes("Saved — leave blank to keep"));
  ok("endpoint note appears when a URL is saved", esheet._html.includes("Endpoint saved — re-enter to change it."));

  // --- chanPill for the agent channel ---
  const pill = A.chanPill("agent");
  ok("agent channel pill renders", pill.includes("AI agent") && pill.includes('chan-pill agent'));

  // --- people grid: badge + hint ---
  state.contacts = [personC, agentC];
  state.archivedContacts = []; state.maxPeople = 8;
  A.renderPeople();
  const grid = document.getElementById("app").innerHTML;
  ok("exactly one agent badge in the grid", (grid.match(/agent-badge/g) || []).length === 1);
  ok("badge sits under the agent name", grid.indexOf("Milton") < grid.indexOf("agent-badge"));
  const almaCard = grid.split('data-id="a"')[1].split('data-id=')[0];
  ok("person card has no agent badge", !almaCard.includes("agent-badge"));
  ok("hint mentions people and AI agents", grid.includes("up to 8 people and AI agents"));

  // --- person detail: agent card ---
  A.renderPersonDetail("b");
  const pdet = document.getElementById("app").innerHTML;
  ok("agent detail shows the badge in the sub-line", pdet.includes('class="agent-badge"') && pdet.includes("AI agent"));
  ok("agent detail shows Endpoint row", pdet.includes("Endpoint") && pdet.includes("Saved"));
  ok("agent detail shows Secret row", pdet.includes("Secret"));
  ok("agent detail has no email/SMS rows", !pdet.includes("SMS · Google Voice"));
  ok("buttons say Archive agent / Remove agent", pdet.includes("Archive agent") && pdet.includes("Remove agent") && !pdet.includes("Archive person"));
  A.renderPersonDetail("a");
  const pdet2 = document.getElementById("app").innerHTML;
  ok("person detail keeps its channel rows and labels", pdet2.includes("SMS · Google Voice") && pdet2.includes("Archive person"));

  // --- new group: agents filtered out ---
  A.renderNewGroup();
  const grp = document.getElementById("app").innerHTML;
  ok("group picker lists the person", grp.includes("Alma"));
  ok("group picker excludes the agent", !grp.includes("Milton"));
  ok("group hint explains agents can't join", grp.includes("can't join groups"));
  state.contacts = [personC];
  A.renderNewGroup();
  const grp2 = document.getElementById("app").innerHTML;
  ok("group hint omits the agent note when no agents exist", !grp2.includes("can't join groups"));

  // --- conversation detail: agent DM ---
  const html = openAgentConv();
  ok("agent DM hides the channel seg picker", !html.includes('id="seg"'));
  ok("agent DM shows the AI agent badge", html.includes('class="agent-badge"') && html.includes("AI agent"));
  ok("composer placeholder uses the agent name", html.includes('placeholder="Message Milton…"'));
  ok("send button stays enabled for the agent channel", html.includes('aria-label="Send" >'));
  ok("agent DM shows the 1:1 static line", html.includes("Chatting 1:1 with your AI agent."));
  state.replyTo = { id: "m1", subject: "Hi" };
  const html2 = openAgentConv();
  ok("reply bar is hidden for agent conversations", !html2.includes("reply-bar"));

  // --- conversation detail: email control ---
  state.conv = {
    id: "c2", title: "Alma", is_group: false, archived: 0,
    members: [{ id: "a", name: "Alma", color: "#0a84ff", kind: "person" }],
    channels: ["email"], hints: {},
  };
  state.messages = []; state.seenMsgIds = new Set(); state.pendingFiles = []; state.eventForm = false;
  state.replyTo = null; state.panel = null;
  A.renderConversationDetail();
  const html3 = document.getElementById("app").innerHTML;
  ok("email DM keeps the channel seg picker", html3.includes('id="seg"'));
  ok("email DM keeps the channel placeholder", html3.includes('placeholder="Message Email…"'));
  ok("email DM has no agent badge", !html3.includes("agent-badge"));

  // --- sendMsg: files guard ---
  state.conv = { id: "c3", title: "Group", is_group: true, archived: 0, members: [], channels: ["sms"], hints: {} };
  state.messages = []; state.sending = false; state.pendingFiles = [{ name: "f.txt" }];
  state.pendingEvent = null; state.replyTo = null;
  document.querySelector("#draft").value = "hi";
  fetchCalls.length = 0;
  await A.sendMsg();
  ok("files blocked on non-email non-agent channels", !fetchCalls.some((c) => c.method === "POST" && c.url.includes("/messages")));

  // --- sendMsg: agent channel sends and reloads so the reply appears ---
  state.conv = JSON.parse(JSON.stringify(agentConv));
  state.messages = []; state.sending = false; state.pendingFiles = [];
  state.pendingEvent = null; state.replyTo = null; state.files = []; state.diary = [];
  state.eventForm = false; state.panel = null; state.seenMsgIds = new Set();
  document.querySelector("#draft").value = "hello";
  fetchCalls.length = 0;
  await A.sendMsg();
  ok("agent message POSTs to the messages endpoint", fetchCalls.some((c) => c.method === "POST" && c.url.includes("/messages")));
  ok("agent send reloads messages so the reply appears", state.messages.length === 2 && state.messages.some((m) => m.id === "m2"));

  console.log(`agent-ui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
