// Meeting-chip checks: a message that looks like an ad-hoc meeting request
// renders an inline "Add to diary" chip; tapping it opens the diary composer
// pre-filled with the resolved time; saving POSTs to the diary store.
// Run with: node tests/meeting-chip-check.js
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
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts: opts || {} });
  return { ok: true, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
};

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("dates.js", "\n;globalThis.RelayDates = RelayDates;");
load("app.js", "\n;globalThis.__APP__ = { state, renderConversationDetail, openDiaryComposer, saveDiaryDraft, meetingChipFor, mtgCache, titleFromCue };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

function msg(id, body, extra) {
  return Object.assign({
    id, direction: "in", channel: "sms", created_at: "2026-09-20T14:00:00Z",
    body, subject: "", attachments: [], appointment: null,
  }, extra || {});
}

state.conv = { id: "c1", title: "Danyetta", is_group: false, members: [{ name: "Danyetta", color: "#888" }], channels: ["sms"], hints: {} };
state.messages = [
  msg("m1", "call tomorrow at 1pm?"),
  msg("m2", "the report is due tomorrow"),
  msg("m3", "lunch"),                                   // cue but no date
  msg("m4", "tomorrow at 1pm?"),                        // date but no cue
  msg("m5", "call tomorrow at 1pm?", { appointment: { id: "a1" } }), // already has one
  msg("m6", "zoom friday at 3pm", { direction: "out" }), // outbound also flags
];
state.seenMsgIds = new Set();
state.panel = null; state.files = []; state.diary = []; state.pendingFiles = [];

A.renderConversationDetail();
const html = document.getElementById("app").innerHTML;

ok("chip on meeting request", html.includes('data-mtg="m1"'));
ok("chip label offers diary", html.includes("Add to diary"));
ok("no chip on plain deadline", !html.includes('data-mtg="m2"'));
ok("no chip when cue but no date", !html.includes('data-mtg="m3"'));
ok("no chip when date but no cue", !html.includes('data-mtg="m4"'));
ok("no chip when appointment exists", !html.includes('data-mtg="m5"'));
ok("chip on outbound message too", html.includes('data-mtg="m6"'));
ok("exactly two chips", (html.match(/mtg-chip/g) || []).length === 2);

// Suppressed when the diary already holds an entry for the message.
state.diary = [{ id: "a9", message_id: "m1", title: "Call" }];
A.renderConversationDetail();
const html2 = document.getElementById("app").innerHTML;
ok("no chip when diary entry exists", !html2.includes('data-mtg="m1"'));
state.diary = [];

// Tapping the chip opens the composer pre-filled.
A.renderConversationDetail();
A.openDiaryComposer("m1");
const modal = state._diaryModal;
ok("composer modal opens", !!modal);
const mhtml = modal.innerHTML;
ok("title pre-filled from cue", mhtml.includes('value="Call"'));
{
  const tm = new Date(); tm.setDate(tm.getDate() + 1); tm.setHours(13, 0, 0, 0);
  const p = (n) => String(n).padStart(2, "0");
  const want = `${tm.getFullYear()}-${p(tm.getMonth() + 1)}-${p(tm.getDate())}T13:00`;
  ok("start pre-filled (tomorrow 1pm local)", mhtml.includes(`value="${want}"`));
}
ok("notes pre-filled with message", mhtml.includes("call tomorrow at 1pm?"));
ok("draft cached", state.diaryDraft && state.diaryDraft.convId === "c1" && state.diaryDraft.messageId === "m1");

// ---------- agreement chips: affirmation inherits the proposal's time ----------
// The reported thread: a bare "tomorrow 10:30 - 11:30?" carries no meeting
// cue, so it never gets a direct chip; the "Yes, see you then." affirmation
// must inherit the proposal's time.
{
  const at = (d, h, mi) => new Date(2026, 8, d, h, mi).toISOString();
  const savedMessages = state.messages;
  state.messages = [
    msg("a1", "I have a gap in my day from 10:30 am to 1:00 pm, and then I'm free after 2:00 pm for the rest of the day.", { created_at: at(20, 19, 26) }),
    msg("a2", "tomorrow 10:30 - 11:30?", { created_at: at(20, 19, 58) }),
    msg("a3", "Yes, see you then.", { created_at: at(20, 20, 0) }),
    msg("a4", "Sounds good, I'll send the agenda over tonight.", { created_at: at(20, 20, 2) }),
  ];
  state.diary = [];
  A.renderConversationDetail();
  const html = document.getElementById("app").innerHTML;
  ok("agreement chip on the affirmation", html.includes('data-mtg="a3"'));
  ok("no direct chip on the bare proposal", !html.includes('data-mtg="a2"'));
  ok("no chip on the availability listing", !html.includes('data-mtg="a1"'));
  ok("second affirmation does not double-chip the slot", !html.includes('data-mtg="a4"'));
  ok("exactly one chip in the thread", (html.match(/mtg-chip/g) || []).length === 1);
  ok("chip tooltip names the source proposal", html.includes("tomorrow 10:30 - 11:30?"));
  const e = A.mtgCache.get("a3");
  ok("inherited start is tomorrow 10:30 local", e && new Date(e.det.start).getTime() === new Date(2026, 8, 21, 10, 30).getTime());
  ok("inherited end is tomorrow 11:30 local", e && new Date(e.det.end).getTime() === new Date(2026, 8, 21, 11, 30).getTime());
  ok("chip carries agreement marker", e && e.det.cue === "agreement" && !!e.det.fromText);
  A.openDiaryComposer("a3");
  ok("composer desc cites the source proposal", state.diaryDraft && state.diaryDraft.desc.includes("tomorrow 10:30 - 11:30?"));
  ok("composer title defaults to Meeting", state.diaryDraft && state.diaryDraft.title === "Meeting");
  state._diaryModal = null; state.diaryDraft = null;

  // Bare "yes" answering a question: no proposal nearby -> no chip.
  state.messages = [
    msg("b1", "did you send the report?", { created_at: at(20, 18, 0) }),
    msg("b2", "yes", { created_at: at(20, 18, 5) }),
  ];
  A.renderConversationDetail();
  ok("no chip on yes with no proposal", !document.getElementById("app").innerHTML.includes("data-mtg="));

  // Deadline with an explicit time: still not a proposal -> no chip.
  state.messages = [
    msg("c1", "the report is due tomorrow at 5pm", { created_at: at(20, 18, 0) }),
    msg("c2", "yes", { created_at: at(20, 18, 5) }),
  ];
  A.renderConversationDetail();
  ok("no chip on yes after a deadline", !document.getElementById("app").innerHTML.includes("data-mtg="));

  // Proposal without a concrete time -> no chip.
  state.messages = [
    msg("d1", "let's meet sometime next week?", { created_at: at(20, 18, 0) }),
    msg("d2", "sounds good", { created_at: at(20, 18, 5) }),
  ];
  A.renderConversationDetail();
  ok("no chip when proposal has no concrete time", !document.getElementById("app").innerHTML.includes("data-mtg="));

  // Slot already in the diary (added from the proposal) -> no chip.
  state.messages = [
    msg("a2", "tomorrow 10:30 - 11:30?", { created_at: at(20, 19, 58) }),
    msg("a3", "Yes, see you then.", { created_at: at(20, 20, 0) }),
  ];
  state.diary = [{ id: "x1", message_id: "a2", title: "Meeting",
    starts_at: new Date(2026, 8, 21, 10, 30).toISOString(), ends_at: new Date(2026, 8, 21, 11, 30).toISOString() }];
  A.renderConversationDetail();
  ok("no chip when proposal already added", !document.getElementById("app").innerHTML.includes("data-mtg="));

  // Overlapping diary entry (different message) -> no chip.
  state.diary = [{ id: "x2", message_id: "other", title: "Dentist",
    starts_at: new Date(2026, 8, 21, 10, 45).toISOString(), ends_at: new Date(2026, 8, 21, 11, 15).toISOString() }];
  A.renderConversationDetail();
  ok("no chip when slot overlaps a diary entry", !document.getElementById("app").innerHTML.includes("data-mtg="));
  state.diary = [];

  // Lookback boundary: proposal 49h before the affirmation -> no chip…
  state.messages = [
    msg("f1", "tomorrow 10:30 - 11:30?", { created_at: at(18, 19, 0) }),
    msg("f2", "yes", { created_at: at(20, 20, 0) }),
  ];
  A.renderConversationDetail();
  ok("no chip past the 48h lookback", !document.getElementById("app").innerHTML.includes("data-mtg="));
  // …but 47h back still counts.
  state.messages = [
    msg("g1", "tomorrow 10:30 - 11:30?", { created_at: at(18, 21, 0) }),
    msg("g2", "yes", { created_at: at(20, 20, 0) }),
  ];
  A.renderConversationDetail();
  ok("chip within the 48h lookback", document.getElementById("app").innerHTML.includes('data-mtg="g2"'));

  // Proposal buried 11 messages back -> no chip.
  const buried = [msg("h0", "tomorrow 10:30 - 11:30?", { created_at: at(20, 19, 0) })];
  for (let i = 1; i <= 11; i++) buried.push(msg("h" + i, "noted, thanks", { created_at: at(20, 19, i) }));
  buried.push(msg("h12", "yes", { created_at: at(20, 19, 58) }));
  state.messages = buried;
  A.renderConversationDetail();
  ok("no chip past the 10-message lookback", !document.getElementById("app").innerHTML.includes("data-mtg="));

  state.messages = savedMessages; state.diary = []; A.renderConversationDetail();
  A.openDiaryComposer("m1"); // restore the composer draft the save-tests below expect
}

// Saving POSTs the entry to the diary store — same appointments endpoint.
(async () => {
  document.getElementById("dc-title").value = "Call";
  document.getElementById("dc-start").value = state.diaryDraft.start;
  document.getElementById("dc-end").value = state.diaryDraft.end;
  document.getElementById("dc-loc").value = "";
  document.getElementById("dc-desc").value = "call tomorrow at 1pm?";
  fetchCalls.length = 0;
  await A.saveDiaryDraft();
  const post = fetchCalls.find((c) => String(c.url).includes("/appointments") && (c.opts || {}).method === "POST");
  ok("POSTs to appointments endpoint", !!post && String(post.url).includes("/api/conversations/c1/appointments"));
  const body = JSON.parse(post.opts.body);
  ok("title sent", body.title === "Call");
  ok("message linked", body.message_id === "m1");
  ok("start hour is 13:00 local", new Date(body.starts_at).getHours() === 13);
  ok("end after start", new Date(body.ends_at) > new Date(body.starts_at));
  ok("diary panel opened to show it", state.panel === "diary");
  ok("composer closed after save", state._diaryModal === null);

  // Validation: empty title refuses to POST.
  A.openDiaryComposer("m1");
  document.getElementById("dc-title").value = "   ";
  fetchCalls.length = 0;
  await A.saveDiaryDraft();
  ok("empty title does not POST", !fetchCalls.some((c) => (c.opts || {}).method === "POST"));
  ok("composer stays open on validation error", state._diaryModal !== null);

  console.log(`meeting-chip: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
