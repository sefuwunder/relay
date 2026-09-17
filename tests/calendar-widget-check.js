// Calendar widget checks: invite cards in bubbles, the composer invitation form,
// and the weekly diary side panel. Run with: node tests/calendar-widget-check.js
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
global.fetch = async () => ({ ok: true, json: async () => ({}) });
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { try { fn(); } catch {} return 0; };
global.alert = () => {}; global.confirm = () => false; global.prompt = () => null;

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, renderConversationDetail, bubbleAtts, inviteCard, fmtApptRange, apptStatusChip, diaryPanelHtml, sidePanelHtml, eventFormHtml, diaryWeekAppts, diaryWeekStart, calFilesOut, activeFiles };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

const now = new Date().toISOString();
function mkConv(channels) {
  return {
    id: "c1", title: "Cal Pal", is_group: false,
    members: [{ id: "p1", name: "Cal Pal", color: "#0a84ff", avatar_url: "" }],
    channels, hints: {},
  };
}
function mkMsg(id, dir, body, atts, appt) {
  return { id, conversation_id: "c1", channel: "email", direction: dir, body, subject: "", external_id: "", message_id: "", status: "sent", created_at: now, attachments: atts || [], appointment: appt || null };
}
const icsAtt = { id: "a9", message_id: "m9", filename: "invite.ics", mime: "text/calendar", size: 800, created_at: now };
function mkAppt(over) {
  return Object.assign({
    id: "ap1", conversation_id: "c1", message_id: "m9", uid: "u1@relay",
    title: "Planning session", starts_at: "2026-09-22T14:00:00.000Z", ends_at: "2026-09-22T15:00:00.000Z",
    location: "HQ", description: "Q4 plans", organizer: "me@example.com", status: "sent", created_at: now,
  }, over || {});
}
function renderDetail(channels, messages, extra) {
  state.conv = mkConv(channels);
  state.messages = messages;
  state.files = [];
  state.diary = (extra && extra.diary) || [];
  state.diaryOffset = 0;
  state.panel = (extra && extra.panel) || null;
  state.eventForm = !!(extra && extra.eventForm);
  state.eventDraft = (extra && extra.eventDraft) || null;
  state.pendingFiles = [];
  state.replyTo = null;
  A.renderConversationDetail();
  return document.getElementById("app").innerHTML;
}

// ---------- invite cards ----------
const sentAppt = mkAppt();
const recvAppt = mkAppt({ id: "ap2", status: "received", title: "Coffee catch-up" });
const sentMsg = mkMsg("m9", "out", "see you", [icsAtt], sentAppt);
const recvMsg = mkMsg("m8", "in", "invite!", [icsAtt], recvAppt);

let html = A.bubbleAtts(sentMsg);
ok("invite card renders instead of a file chip", html.includes("invite-card") && !html.includes("att-file"));
ok("invite card shows the title", html.includes("Planning session"));
const d22 = new Date("2026-09-22T14:00:00.000Z");
const dExp = d22.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const tExp = d22.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
ok("invite card shows a formatted time", html.includes(dExp) && html.includes(tExp));
ok("invite card shows the location", html.includes("HQ"));
ok("invite card shows a status pill", html.includes("appt-status") && html.includes(">sent<"));
ok("outbound invite has no accept/decline", !html.includes("data-appt-accept"));

html = A.bubbleAtts(recvMsg);
ok("inbound received invite gets accept/decline", html.includes('data-appt-accept="ap2"') && html.includes('data-appt-decline="ap2"'));

const acceptedMsg = mkMsg("m8", "in", "invite!", [icsAtt], mkAppt({ status: "accepted" }));
ok("answered invite hides the buttons", !A.bubbleAtts(acceptedMsg).includes("data-appt-accept"));

const bareIcs = mkMsg("m7", "in", "", [{ id: "a8", filename: "meeting.ics", mime: "application/octet-stream", size: 10 }]);
ok(".ics by extension renders a card too", A.bubbleAtts(bareIcs).includes("invite-card"));

ok("fmtApptRange same-day", A.fmtApptRange("2026-09-22T14:00:00.000Z", "2026-09-22T15:30:00.000Z").includes("–"));
ok("fmtApptRange multi-day names both days", (A.fmtApptRange("2026-09-22T14:00:00.000Z", "2026-09-23T15:30:00.000Z").match(/Sep/g) || []).length === 2);
ok("apptStatusChip classes", A.apptStatusChip("accepted").includes("st-accepted") && A.apptStatusChip("received").includes("invitation"));

// ---------- composer invitation form ----------
html = renderDetail(["email"], [sentMsg], { eventForm: true, eventDraft: { title: "Lunch" } });
ok("calendar button in the email composer", html.includes('id="calinvite"'));
ok("invitation form opens inline", html.includes('id="event-form"') && html.includes('id="ef-title"'));
ok("form keeps its draft", html.includes('value="Lunch"'));
ok("form has start/end/location/notes", html.includes('id="ef-start"') && html.includes('id="ef-end"') && html.includes('id="ef-loc"') && html.includes('id="ef-desc"'));

html = renderDetail(["sms"], [mkMsg("m1", "out", "hi", [])]);
ok("no calendar button on the SMS channel", !html.includes('id="calinvite"'));

html = A.eventFormHtml();
ok("eventFormHtml escapes drafts", (state.eventDraft = { title: '<b>x</b>' }, A.eventFormHtml().includes("&lt;b&gt;x&lt;/b&gt")));
state.eventDraft = null;

// ---------- diary panel ----------
function apptOn(dayOffset, hour, over) {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + dayOffset); // Sunday + offset
  d.setHours(hour, 0, 0, 0);
  const e = new Date(d.getTime() + 3600000);
  return mkAppt(Object.assign({ id: "ap" + dayOffset + hour, title: "Appt " + dayOffset, starts_at: d.toISOString(), ends_at: e.toISOString(), location: "", description: "" }, over || {}));
}
const weekAppts = [apptOn(1, 10), apptOn(1, 14, { status: "accepted" }), apptOn(5, 9, { location: "Room 2" })];
html = renderDetail(["email"], [sentMsg], { panel: "diary", diary: weekAppts });
ok("diary panel renders", html.includes('aria-label="Appointment diary"') && html.includes("Diary"));
ok("diary has week navigation", html.includes('id="dp-prev"') && html.includes('id="dp-next"') && html.includes('id="dp-today"'));
ok("diary shows seven day rows", (html.match(/class="dp-day(?: |")/g) || []).length === 7);
ok("diary groups two appointments on the same day", (html.match(/Appt 1/g) || []).length === 2);
ok("diary shows the location", html.includes("Room 2"));
ok("diary shows status pills", html.includes("st-accepted"));
ok("diary week count badge", html.includes('<span class="fp-count">3</span>'));
ok("diary toggle exists in the nav bar", html.includes('id="diary-toggle"'));

state.panel = "files";
ok("sidePanelHtml switches on panel state", A.sidePanelHtml().includes("Shared files") && (state.panel = "diary", A.sidePanelHtml().includes("Appointment diary")));
state.panel = null;

state.diary = weekAppts; state.diaryOffset = 0;
ok("diaryWeekAppts stays in the week", A.diaryWeekAppts().length === 3);
state.diaryOffset = 1;
ok("diaryWeekAppts follows the offset", A.diaryWeekAppts().length === 0);
state.diaryOffset = 0;
const ws = A.diaryWeekStart();
ok("diary week starts on Sunday", ws.getDay() === 0);

// ---------- .ics stays out of the files widget ----------
const files = [
  { id: "f1", filename: "deck.pdf", mime: "application/pdf", size: 10 },
  { id: "f2", filename: "invite.ics", mime: "text/calendar", size: 10 },
  { id: "f3", filename: "other.ICS", mime: "application/octet-stream", size: 10 },
];
const kept = A.calFilesOut(files);
ok("calFilesOut drops invites from the files list", kept.length === 1 && kept[0].id === "f1");

console.log(`\ncalendar widget: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
