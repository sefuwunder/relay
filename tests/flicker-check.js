// Flicker checks: the conversation list must not re-render when nothing
// changed, and background message refreshes must not replay the pop-in
// animation on messages already on screen.
// Run with: node tests/flicker-check.js
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
global.fetch = async () => ({ ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, renderConversations, renderConversationDetail };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

// Count how many times #app.innerHTML is assigned during fn().
function countAppRenders(fn) {
  const app = document.getElementById("app");
  let n = 0;
  const desc = Object.getOwnPropertyDescriptor(app, "innerHTML");
  let val = app.innerHTML;
  Object.defineProperty(app, "innerHTML", {
    configurable: true,
    get() { return val; },
    set(v) { n++; val = v; },
  });
  try { fn(); } finally {
    if (desc) Object.defineProperty(app, "innerHTML", desc);
    else { delete app.innerHTML; app.innerHTML = val; }
  }
  return n;
}

const convA = { id: "a", title: "Shy", last_at: "2026-09-18T15:00:00Z", unread: 0, last_body: "hey", last_channel: "sms", is_group: false, members: [{ name: "Shy" }], member_count: 1 };
const convB = { id: "b", title: "Group", last_at: "2026-09-18T14:00:00Z", unread: 2, last_body: "yo", last_channel: "email", is_group: true, members: [], member_count: 3 };

// 1. List re-renders on explicit calls…
state.conversations = [{ ...convA }, { ...convB }];
state.search = "";
ok("explicit renderConversations() paints", countAppRenders(() => A.renderConversations()) === 1);

// …but the idle timer path skips when nothing changed.
ok("idle re-render skipped when unchanged", countAppRenders(() => A.renderConversations(true)) === 0);
ok("idle re-render skipped twice in a row", countAppRenders(() => A.renderConversations(true)) === 0);

// …and re-renders when something actually changed.
state.conversations = [{ ...convA }, { ...convB, unread: 3 }];
ok("idle re-render fires on new unread", countAppRenders(() => A.renderConversations(true)) === 1);
ok("signature updated after render", countAppRenders(() => A.renderConversations(true)) === 0);
state.conversations = [{ ...convA, last_body: "hey!!" }, { ...convB, unread: 3 }];
ok("idle re-render fires on new message text", countAppRenders(() => A.renderConversations(true)) === 1);

// Search still forces a render through the input path.
state.search = "shy";
ok("search query change re-renders", countAppRenders(() => A.renderConversations(true)) === 1);
state.search = "";

// 2. Message animations: first paint animates everything…
state.conv = { id: "a", title: "Shy", members: [{ name: "Shy", color: "#888" }], channels: ["sms"], hints: {}, is_group: false };
state.messages = [
  { id: "m1", direction: "in", channel: "sms", created_at: "2026-09-18T15:00:00Z", body: "hey" },
  { id: "m2", direction: "out", channel: "sms", created_at: "2026-09-18T15:01:00Z", body: "hi" },
];
state.seenMsgIds = new Set();
state.panel = null; state.files = []; state.diary = []; state.pendingFiles = [];
A.renderConversationDetail();
let html = document.getElementById("app").innerHTML;
ok("first paint: no msg-old", !html.includes("msg-old"));
ok("first paint: both messages rendered", html.includes("hey") && html.includes("hi"));
ok("seen ids tracked after paint", state.seenMsgIds.has("m1") && state.seenMsgIds.has("m2"));

// …a background refresh animates only the new message.
state.messages = [...state.messages, { id: "m3", direction: "in", channel: "sms", created_at: "2026-09-18T15:02:00Z", body: "new one" }];
A.renderConversationDetail();
html = document.getElementById("app").innerHTML;
const oldCount = (html.match(/msg-old/g) || []).length;
ok("refresh: old messages marked msg-old", oldCount === 2);
ok("refresh: new message has no msg-old", /<div class="msg in">\s*<div class="bubble">/.test(html) || !html.split("new one")[0].endsWith("msg-old"));
ok("refresh: new message rendered", html.includes("new one"));

// 3. Route wiring: the 15s list timer uses the skip-if-same path.
const src = fs.readFileSync(path.join(pub, "app.js"), "utf8");
ok("list timer passes skipIfSame", src.includes("renderConversations(true)"));
// CSS kills the animation for already-seen messages.
const css = fs.readFileSync(path.join(pub, "style.css"), "utf8");
ok("msg-old disables animation", /\.msg-old\s*\{\s*animation:\s*none/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
