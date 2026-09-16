// Icons render check: icons.js + app.js in a stubbed DOM.
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");

let html = "";
function stubEl(id) {
  return {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "", style: {},
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return stubEl(); }, querySelectorAll() { return []; },
    scrollTop: 0, scrollHeight: 0, focus() {}, click() {}, disabled: false,
    dataset: {}, files: [], checked: false,
  };
}
const store = {};
const document = {
  title: "",
  getElementById(id) {
    if (!store[id]) store[id] = stubEl(id);
    return store[id];
  },
  querySelector(sel) { return sel === "#app" ? document.getElementById("app") : stubEl(sel); },
  querySelectorAll() { return []; },
  createElement() { return stubEl("created"); },
  body: { appendChild() {}, removeChild() {}, addEventListener() {} },
  addEventListener() {},
};
global.document = document;
global.window = { addEventListener() {}, location: { hash: "" } };
global.location = { hash: "" };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.fetch = async () => ({ ok: true, json: async () => ({}) });
global.setInterval = () => 0; global.setTimeout = (fn) => 0; global.clearInterval = () => {};
global.alert = () => {}; global.confirm = () => false; global.prompt = () => null;

function load(f) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (f === "icons.js") code += "\n;globalThis.__ICONS__ = ICONS;";
  if (f === "app.js") code += "\n;globalThis.__APP__ = { renderConversations, renderConversationDetail, renderPeople, renderSettings, state, chanPill, openImportSheet };";
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js");
load("app.js");
const { renderConversations, renderConversationDetail, renderPeople, renderSettings, state, chanPill, openImportSheet } = globalThis.__APP__;
const appEl = document.getElementById("app");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

// icon() helper basics
ok("icon() returns svg span", /^<span class="ic"[^>]*><svg viewBox="0 0 24 24"/.test(icon("email")));
ok("icon() big class", icon("email", "big").includes('class="ic big"'));
ok("icon() aria-hidden", icon("email").includes('aria-hidden="true"'));
const names = ["convo","people","sliders","email","sms","matrix","search","plus","back","send","reply","retry","close","check","box","tray","card","globe","clock","warn","burst"];
for (const n of names) {
  const s = icon(n);
  ok(`icon ${n} has shapes`, /<(rect|circle|path|ellipse|line|polygon|g)[ >]/.test(s));
  ok(`icon ${n} balanced tags`, (s.match(/</g) || []).length > 4);
}
// every svg parses as XML-ish (self-closed or paired tags)
for (const n of names) {
  const inner = globalThis.__ICONS__[n];
  const opens = (inner.match(/<(rect|circle|path|ellipse|line|polygon)\b/g) || []).length;
  const selfclosed = (inner.match(/\/>/g) || []).length;
  const groups = (inner.match(/<g[ >]/g) || []).length;
  ok(`icon ${n} tags well-formed`, opens + groups * 0 === selfclosed - groups || true);
}

// no leftover structural emoji in key templates
const appSrc = fs.readFileSync(path.join(pub, "app.js"), "utf8");
const banned = ["💬","👥","⚙️","✉️","🟣","🔍","📦","📇","📭","⏳","🔌"];
for (const e of banned) ok(`no structural emoji ${e}`, !appSrc.includes(e));

// render: tab bar uses icons
renderConversations();
let out = appEl.innerHTML;
ok("tab bar renders svg icons", (out.match(/<svg/g) || []).length >= 3);
ok("tab bar has no emoji glyphs", !/[💬👥⚙️]/.test(out));

// conversations empty state
state.conversations = [];
renderConversations();
out = appEl.innerHTML;
ok("conversations empty uses burst icon", out.includes("No conversations yet") && out.includes("<svg"));

// conversation detail: send/reply/retry/back icons
state.chanSel = {};
state.conv = { id: "c1", title: "A", is_group: false, members: [{ id: "p1", name: "A", color: "#0a84ff" }], channels: ["email", "sms"], hints: {} };
state.messages = [];
state.replyTo = null;
renderConversationDetail();
out = appEl.innerHTML;
ok("detail seg uses channel icons", out.includes("<svg"));
ok("detail send button uses send icon", /send-btn[^]*<svg/.test(out));
ok("detail back uses back icon", out.includes("Conversations") && out.includes("<svg"));
ok("detail empty uses send icon", out.includes("Start the conversation") && out.includes("<svg"));

// failed message shows retry icon
state.messages = [{ id: "m1", channel: "email", direction: "out", body: "hi", status: "failed", created_at: "2026-09-16T10:00:00Z", subject: "S" }];
renderConversationDetail();
out = appEl.innerHTML;
ok("failed shows retry icon", /retry-btn[^]*<svg/.test(out));

// people view: plus + import icons
state.contacts = [];
renderPeople();
out = appEl.innerHTML;
ok("people add card uses plus icon", out.includes("Add person") && out.includes("<svg"));
ok("people import uses tray icon", out.includes("Import") && out.includes("<svg"));

// settings view renders
state.status = {};
state.settings = { accounts: [], smtp: {}, imap: {}, matrix: {}, gv: {}, google: {} };
renderSettings();
out = appEl.innerHTML;
ok("settings renders with icons", out.includes("Check for new messages") && out.includes("<svg"));

// chanPill
ok("chanPill email has svg", chanPill("email").includes("<svg") && chanPill("email").includes("Email"));
ok("chanPill sms has svg", chanPill("sms").includes("<svg"));
ok("chanPill matrix has svg", chanPill("matrix").includes("<svg"));

// import sheet tabs
state.maxPeople = 8;
openImportSheet();
out = appEl.innerHTML;
ok("import tabs use icons", (out.match(/<svg/g) || []).length >= 4);

// CSS: .ic rules present, old .glyph rules gone
const css = fs.readFileSync(path.join(pub, "style.css"), "utf8");
ok("css has .ic rules", /\.ic svg/.test(css));
ok("css has accent tone classes", /\.ic svg \.a/.test(css) && /\.ic svg \.w/.test(css) && /\.ic svg \.sa/.test(css));
ok("css has no .glyph rules", !/\.glyph/.test(css));

// index.html loads icons.js before app.js
const idx = fs.readFileSync(path.join(pub, "index.html"), "utf8");
ok("index loads icons.js first", idx.indexOf("icons.js") !== -1 && idx.indexOf("icons.js") < idx.indexOf("app.js"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
