// Calendar-feed sync UI checks (DOM-stubbed):
//  - preview modal renders rows with match chips, badges, correct pre-checks
//  - nothing is POSTed to /api/calendar/import before the user confirms
//  - confirm sends only the checked rows; the summary modal renders counts
// Run with: node tests/ical-import-ui-check.js
const fs = require("fs");
const path = require("path");
const pub = path.join(__dirname, "..", "public");

function stubEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "", style: {},
    checked: false, disabled: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, remove() {},
    appendChild() {}, removeChild() {},
    querySelector(s) { return stubEl(s); },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    focus() {}, select() {}, click() {}, setAttribute() {},
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
    if (!selCache[sel]) selCache[sel] = stubEl(sel);
    return selCache[sel];
  },
  querySelectorAll() { return []; },
  createElement() { return stubEl("created"); },
  body: { appendChild() {}, removeChild() {}, addEventListener() {} },
  addEventListener() {}, removeEventListener() {},
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
let importResponse = { results: [], imported: 0, skipped: 0 };
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts: opts || {} });
  const body = url.includes("/api/calendar/import") ? importResponse : {};
  return { ok: true, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
};

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("dates.js", "\n;globalThis.RelayDates = RelayDates;");
load("app.js", "\n;globalThis.__APP__ = { state, renderCalPreview, confirmCalImport, calRowPrechecked, updateCalImportCount, fmtCalWhen, syncCalendarFeed };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

function row(key, over) {
  return Object.assign({
    key, uid: "u@" + key, summary: "Event " + key, location: "", description: "", organizer: "",
    start: "2026-09-22T17:00:00.000Z", end: "2026-09-22T18:00:00.000Z",
    all_day: false, recurring: null, cancelled: false, already_imported: false,
    matches: [], import_conversation_id: "",
  }, over || {});
}
const pal = { contact_id: "c-pal", name: "Cal Pal", confidence: "email", conversation_id: "conv-pal", conversation_name: "Cal Pal" };

state.calPreview = [
  row("k1", { summary: "Lunch with Cal Pal", matches: [pal], import_conversation_id: "conv-pal" }),
  row("k2", { summary: "Call Dana", matches: [{ contact_id: "c-dana", name: "Dana", confidence: "mention", conversation_id: "conv-dana", conversation_name: "Dana" }], import_conversation_id: "conv-dana" }),
  row("k3", { summary: "Dentist" }),
  row("k4", { summary: "Already there", already_imported: true, matches: [pal], import_conversation_id: "conv-pal" }),
  row("k5", { summary: "Cancelled thing", cancelled: true, matches: [pal], import_conversation_id: "conv-pal" }),
  row("k6", { summary: "Standup", recurring: { index: 1, total: 3 }, matches: [Object.assign({}, pal, { confidence: "name" })], import_conversation_id: "conv-pal" }),
];

A.renderCalPreview();
const wrap = state._calPreviewEl;
ok("preview modal created", !!wrap);
const html = wrap.innerHTML;
ok("all six rows render", (html.match(/class="cal-row[\s"]/g) || []).length === 6);
ok("email match pre-checked", /data-cal-key="k1" checked/.test(html));
ok("mention-only match not pre-checked", !/data-cal-key="k2" checked/.test(html));
ok("no-match row not pre-checked", !/data-cal-key="k3" checked/.test(html));
ok("already-imported row disabled", /data-cal-key="k4" checked[^>]*disabled|data-cal-key="k4"[^>]*disabled/.test(html));
ok("cancelled row disabled", /data-cal-key="k5"[^>]*disabled/.test(html));
ok("already-imported badge", html.includes("Already imported"));
ok("cancelled badge", html.includes("Cancelled"));
ok("no-conversation badge", html.includes("No conversation"));
ok("email confidence chip", html.includes("Cal Pal · email"));
ok("mention confidence chip", html.includes("Dana · mentioned"));
ok("target conversation chip", html.includes("Cal Pal") && html.includes("cal-target"));
ok("recurring index badge", html.includes("1/3"));
ok("when line is local", /Sep 22/.test(html));

ok("nothing posted before confirm", !fetchCalls.some((c) => String(c.url).includes("/api/calendar/import")));

ok("precheck helper: email+conv", A.calRowPrechecked(state.calPreview[0]) === true);
ok("precheck helper: mention-only is false", A.calRowPrechecked(state.calPreview[1]) === false);
ok("precheck helper: no match is false", A.calRowPrechecked(state.calPreview[2]) === false);
ok("precheck helper: already imported is false", A.calRowPrechecked(state.calPreview[3]) === false);
ok("precheck helper: cancelled is false", A.calRowPrechecked(state.calPreview[4]) === false);
ok("precheck helper: name match counts", A.calRowPrechecked(state.calPreview[5]) === true);

// Simulate the user checking k1 and k2, then confirming.
function fakeCheck(key, checked) {
  return { checked, getAttribute: (n) => (n === "data-cal-key" ? key : null) };
}
wrap.querySelectorAll = (sel) => {
  if (sel === ".cal-check:checked") return [fakeCheck("k1", true), fakeCheck("k2", true)];
  if (sel === ".cal-check") return [fakeCheck("k1", true), fakeCheck("k2", true), fakeCheck("k3", false)];
  return [];
};
A.updateCalImportCount(wrap);
ok("import button counts checked rows", document.getElementById("cal-import").textContent.includes("(2)"));

importResponse = {
  results: [
    { key: "k1", status: "imported", conversation_id: "conv-pal", conversation_name: "Cal Pal" },
    { key: "k2", status: "no_conversation", reason: "No conversation for the matched contact." },
  ],
  imported: 1, skipped: 1,
};

(async () => {
  await A.confirmCalImport();
  const imp = fetchCalls.find((c) => String(c.url).includes("/api/calendar/import"));
  ok("confirm POSTs to the import endpoint", !!imp);
  const sent = JSON.parse(imp.opts.body).items;
  ok("only checked rows are sent", sent.length === 2 && sent.every((i) => i.key === "k1" || i.key === "k2"));
  ok("items carry conversation targets", sent.find((i) => i.key === "k1").conversation_id === "conv-pal");
  ok("cancelled flag travels with items", sent.every((i) => i.cancelled === false));

  const sum = state._calModal;
  ok("summary modal renders", !!sum && sum.innerHTML.includes("1</b> imported"));
  ok("summary shows skip count", sum.innerHTML.includes("1</b> skipped"));
  ok("summary lists per-event status", sum.innerHTML.includes("Imported") && sum.innerHTML.includes("No conversation"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
