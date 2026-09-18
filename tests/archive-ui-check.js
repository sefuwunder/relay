// Archive conversation UI checks: the conversation list shows an "Archived · N"
// section, and the conversation detail nav bar carries an Archive/Unarchive
// button that flips with the conversation's archived flag.
// Run with: node tests/archive-ui-check.js
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");

function stubEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "", style: {},
    checked: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, remove() {},
    appendChild() {}, removeChild() {},
    querySelector(s) { return stubEl(s); },
    querySelectorAll() { return []; },
    focus() {}, click() {}, setAttribute() {},
    fire(t, e) { (this._l[t] || []).forEach((fn) => fn(e || {})); },
  };
  return el;
}
const store = {};
const selCache = {};
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
  createElement() { return stubEl("created"); },
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

const activeConvs = [
  { id: "c1", title: "Alma", is_group: false, avatar_color: "#0a84ff", member_count: 1, last_body: "hey", last_at: "2026-09-18T10:00:00", last_channel: "email", last_direction: "in", unread: 1, archived: false, members: [{ id: "a", name: "Alma", color: "#0a84ff" }] },
];
const archivedConvs = [
  { id: "c2", title: "Old group", is_group: true, avatar_color: "#8e8e93", member_count: 2, last_body: "bye", last_at: "2026-09-01T10:00:00", last_channel: "sms", last_direction: "out", unread: 0, archived: true, members: [{ id: "b", name: "Ben", color: "#30d158" }] },
];
global.fetch = async (url) => ({
  ok: true,
  json: async () => ({ conversations: String(url).includes("archived=1") ? archivedConvs : activeConvs }),
  arrayBuffer: async () => new ArrayBuffer(0),
});

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, renderConversations, renderConversationDetail, loadConversations };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

(async () => {
  // --- list: archived section ---
  state.search = "";
  await A.loadConversations();
  ok("loadConversations keeps active and archived lists separate",
    state.conversations.length === 1 && state.archivedConversations.length === 1);
  A.renderConversations();
  const html = document.getElementById("app").innerHTML;
  ok("list shows an Archived section with the count", html.includes("Archived · 1"));
  ok("archived conversation renders as a row", html.includes('data-id="c2"') && html.includes("Old group"));
  ok("active conversation still renders", html.includes("Alma"));

  // --- list: search covers the archived section too ---
  state.search = "old group";
  A.renderConversations();
  const h2 = document.getElementById("app").innerHTML;
  ok("search finds the archived thread", h2.includes('data-id="c2"'));

  // --- detail: archive button flips with the flag ---
  function renderDetail(archived) {
    state.conv = {
      id: "c1", title: "Alma", is_group: false, archived,
      members: [{ id: "a", name: "Alma", color: "#0a84ff", channels: ["email"] }],
      channels: ["email"], hints: {},
    };
    state.messages = []; state.files = []; state.diary = []; state.panel = null;
    state.seenMsgIds = new Set(); state.pendingFiles = []; state.eventForm = false;
    A.renderConversationDetail();
    return document.getElementById("app").innerHTML;
  }
  const d0 = renderDetail(0);
  ok("detail has an archive button", d0.includes('id="conv-archive"'));
  ok("button says Archive when the thread is active", d0.includes('title="Archive conversation"'));
  const d1 = renderDetail(1);
  ok("button says Unarchive when the thread is archived", d1.includes('title="Unarchive conversation"'));

  console.log(`archive-ui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
