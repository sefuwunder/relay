// Invite remove-button checks: the ✕ renders only on unresponded cards,
// removed appointments render no card, and clicking remove calls DELETE and
// drops the card. Run with: node tests/invite-remove-check.js
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
const ls = new Map();
const document = {
  title: "",
  visibilityState: "hidden",
  getElementById(id) { if (!store[id]) store[id] = stubEl(id); return store[id]; },
  querySelector(sel) {
    if (sel === "#app") return document.getElementById("app");
    return stubEl(sel);
  },
  querySelectorAll() { return []; },
  createElement() { return stubEl("created"); },
  body: { appendChild() {}, removeChild() {}, addEventListener() {} },
  addEventListener() {},
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
const fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || "GET" });
  return { ok: true, json: async () => ({ appointments: [], files: [] }) };
};
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { try { fn(); } catch {} return 0; };
global.alert = () => {}; global.confirm = () => false; global.prompt = () => null;

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, bubbleAtts, inviteCard, removeAppointment, refreshDiary, renderConversationDetail };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

const now = new Date().toISOString();
const icsAtt = { id: "a9", message_id: "m9", filename: "invite.ics", mime: "text/calendar", size: 800, created_at: now };
function mkAppt(over) {
  return Object.assign({
    id: "ap1", conversation_id: "c1", message_id: "m9", uid: "u1@relay",
    title: "Planning session", starts_at: "2026-09-22T14:00:00.000Z", ends_at: "2026-09-22T15:00:00.000Z",
    location: "", description: "", organizer: "", status: "sent", created_at: now,
  }, over || {});
}
function mkMsg(dir, appt) {
  return { id: "m9", conversation_id: "c1", channel: "email", direction: dir, body: "x", subject: "",
    external_id: "", message_id: "", status: "sent", created_at: now, attachments: [icsAtt], appointment: appt || null };
}

// ---------- remove button visibility ----------
let html = A.bubbleAtts(mkMsg("in", mkAppt({ status: "received", id: "ap2" })));
ok("received card has a remove button", html.includes('data-appt-remove="ap2"'));
ok("received card still has accept/decline", html.includes('data-appt-accept="ap2"'));

html = A.bubbleAtts(mkMsg("out", mkAppt({ status: "sent", id: "ap1" })));
ok("sent (outbound, unanswered) card has a remove button", html.includes('data-appt-remove="ap1"'));
ok("outbound card has no accept/decline", !html.includes("data-appt-accept"));

html = A.bubbleAtts(mkMsg("in", mkAppt({ status: "accepted", id: "ap3" })));
ok("accepted card has no remove button", !html.includes("data-appt-remove"));

html = A.bubbleAtts(mkMsg("in", mkAppt({ status: "declined", id: "ap4" })));
ok("declined card has no remove button", !html.includes("data-appt-remove"));

html = A.bubbleAtts(mkMsg("in", mkAppt({ status: "cancelled", id: "ap5" })));
ok("cancelled card has no remove button", !html.includes("data-appt-remove"));

html = A.bubbleAtts(mkMsg("in", mkAppt({ status: "removed", id: "ap6" })));
ok("removed appointment renders no card at all", !html.includes("invite-card") && html === '<div class="att-list"></div>');

html = A.bubbleAtts(mkMsg("in", null));
ok("appointment-less .ics still renders a card (unchanged legacy path)", html.includes("invite-card"));

// ---------- removeAppointment flow ----------
(async () => {
  state.conv = { id: "c1", title: "T", is_group: false, members: [], channels: [], hints: {} };
  state.messages = [mkMsg("out", mkAppt({ status: "sent", id: "ap1" }))];
  state.panel = null; state.files = []; state.diary = [];
  fetchCalls.length = 0;
  await A.removeAppointment("ap1");
  const del = fetchCalls.find((c) => c.method === "DELETE");
  ok("remove calls DELETE on the appointment endpoint",
    !!del && del.url === "/api/conversations/c1/appointments/ap1");
  ok("card data is marked removed after delete",
    state.messages[0].appointment.status === "removed");
  ok("re-rendered bubble has no invite card",
    !A.bubbleAtts(state.messages[0]).includes("invite-card"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
