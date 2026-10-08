// Conversation-nudge client checks (runs under plain node):
//  1. toggle defaults on; a stored "0" starts off
//  2. setConvoNudges writes the flag and clears the card when off
//  3. toggle off -> checkConversationNudges skips without fetching
//  4. toggle on  -> fetches /api/nudges, fires one digest notification,
//     per-session dedupe (no second fire), tap routes to the thread
//  5. nudge card HTML: calm rows with Message / 3d / 1w / Dismiss; empty -> ""
// Run: node tests/nudges-ui-check.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const pub = path.join(__dirname, "..", "public");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

function stubEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "", style: {},
    checked: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, appendChild() {}, removeChild() {},
    querySelector() { return stubEl("q"); }, querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, click() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    fire(t, e) { (this._l[t] || []).forEach((fn) => fn(e || {})); },
  };
  return el;
}

/** Fresh app instance in its own vm context, with a stubbed browser. */
function loadFresh(lsInit, fetchImpl) {
  const ls = new Map(Object.entries(lsInit || {}));
  const notifications = [];
  const fetchCalls = [];
  const store = {};
  const FIXED = new Date(2026, 9, 8, 14, 0, 0); // 2pm, outside quiet hours
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [FIXED.getTime()])); }
    static now() { return FIXED.getTime(); }
  }
  const Notif = class {
    constructor(title, opts) { this.title = title; this.opts = opts || {}; notifications.push(this); }
    close() {}
  };
  Notif.permission = "granted";
  const document = {
    title: "", visibilityState: "hidden",
    getElementById(id) { if (!store[id]) store[id] = stubEl(id); return store[id]; },
    querySelector(sel) { if (sel === "#app") return document.getElementById("app"); return stubEl(sel); },
    querySelectorAll() { return []; },
    createElement() { return stubEl("created"); },
    body: stubEl("body"),
    addEventListener() {},
  };
  const sandbox = {
    console,
    document,
    window: { addEventListener() {}, focus() {} },
    location: { hash: "" },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    },
    Notification: Notif,
    Date: FakeDate,
    fetch: (url, opts) => { fetchCalls.push(url); return fetchImpl(url, opts); },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0,
    alert: () => {}, confirm: () => false, prompt: () => null,
  };
  sandbox.window.Notification = Notif;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const icons = fs.readFileSync(path.join(pub, "icons.js"), "utf8").replace('"use strict";', "");
  const app = fs.readFileSync(path.join(pub, "app.js"), "utf8").replace('"use strict";', "");
  vm.runInContext(icons + "\n;globalThis.__ICONS__ = ICONS;", sandbox, { filename: "icons.js" });
  vm.runInContext(app + `\n;globalThis.__APP__ = {
    state, checkConversationNudges, setConvoNudges, nudgeCardHtml, fireConvoNudge,
    renderConversations, renderSettings, openContactSheet,
  };`, sandbox, { filename: "app.js" });
  return { app: sandbox.__APP__, ls, notifications, fetchCalls, setFetch: (fn) => { fetchImpl = fn; }, sandbox };
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });

(async () => {
  // 1. defaults on; stored "0" starts off
  {
    const a = loadFresh({}, okJson({}));
    ok("toggle defaults on", a.app.state.convoNudges === true);
    const b = loadFresh({ relay_convo_nudges: "0" }, okJson({}));
    ok('stored "0" starts off', b.app.state.convoNudges === false);
  }

  // 2. setter wiring
  {
    const h = loadFresh({}, okJson({}));
    h.app.state.settings = { smtp: {}, imap: {}, matrix: {}, google: {} }; // renderSettings reads deep fields
    h.app.state.status = { smtp: false, imap: false, matrix: false, google: false };
    h.app.state.nudges = [{ key: "stale:x", title: "t", body: "b" }];
    h.app.setConvoNudges(false);
    ok("setConvoNudges(false) persists 0", h.ls.get("relay_convo_nudges") === "0");
    ok("setConvoNudges(false) flips state", h.app.state.convoNudges === false);
    ok("setConvoNudges(false) clears the card", h.app.state.nudges.length === 0);
    h.app.setConvoNudges(true);
    ok("setConvoNudges(true) persists 1", h.ls.get("relay_convo_nudges") === "1");
    ok("setConvoNudges(true) flips state", h.app.state.convoNudges === true);
  }

  // 3. toggle off -> skips without fetching
  {
    const h = loadFresh({ relay_convo_nudges: "0" }, okJson({ nudges: [] }));
    h.app.state.notify = true;
    h.fetchCalls.length = 0; // ignore the initial page-load fetch
    await h.app.checkConversationNudges();
    ok("toggle off: no fetch", h.fetchCalls.length === 0);
    ok("toggle off: no notifications", h.notifications.length === 0);
  }

  // 4. toggle on -> fetch, digest notification, dedupe, tap routing
  {
    const nudges = [
      { key: "unanswered:c1", type: "unanswered", conversation_id: "c1", staged_id: "", title: "Still waiting on Ava?", body: "Ava hasn't replied in 4 days.", days: 4 },
      { key: "followup:s9", type: "staged_followup", conversation_id: "", staged_id: "s9", title: "Follow up with Kim?", body: "You haven't followed up with Kim yet.", days: 3 },
    ];
    const h = loadFresh({}, okJson({ nudges }));
    h.app.state.notify = true;
    h.sandbox.location.hash = "#/commitments"; // not staring at the list
    h.fetchCalls.length = 0; // ignore the initial page-load fetch
    await h.app.checkConversationNudges();
    ok("toggle on: fetched /api/nudges", h.fetchCalls.includes("/api/nudges"));
    ok("card state updated", h.app.state.nudges.length === 2);
    ok("one digest notification for 2 nudges", h.notifications.length === 1);
    ok("digest title is calm", h.notifications[0].title === "A few gentle nudges (2)");
    // per-session dedupe: second poll fires nothing new
    await h.app.checkConversationNudges();
    ok("no second notification this session", h.notifications.length === 1);
    // tap routing: thread nudge
    const nn = h.notifications[0];
    h.app.fireConvoNudge(nudges[0]);
    const threadNote = h.notifications[h.notifications.length - 1];
    threadNote.onclick();
    ok("tap thread nudge opens the thread", h.sandbox.location.hash === "#/conversations/c1");
    // tap routing: staged nudge
    h.app.fireConvoNudge(nudges[1]);
    const stagedNote = h.notifications[h.notifications.length - 1];
    stagedNote.onclick();
    ok("tap staged nudge opens the staged profile", h.sandbox.location.hash === "#/people/staged/s9");
    void nn;
  }

  // 5. card HTML
  {
    const h = loadFresh({}, okJson({}));
    h.app.state.nudges = [];
    ok("empty card renders nothing", h.app.nudgeCardHtml() === "");
    h.app.state.convoNudges = false;
    h.app.state.nudges = [{ key: "stale:c1", title: "Quiet with Ava lately.", body: "It's been 9 days since you talked to Ava." }];
    ok("card hidden when toggled off", h.app.nudgeCardHtml() === "");
    h.app.state.convoNudges = true;
    const html = h.app.nudgeCardHtml();
    ok("card shows the title", html.includes("Quiet with Ava lately."));
    ok("card shows the body", html.includes("9 days since you talked to Ava")); // esc() escapes the apostrophe
    for (const label of ["Message", "3d", "1w", "Dismiss"]) {
      ok(`card has a ${label} button`, html.includes(">" + label + "<"));
    }
    ok("card heading is calm", html.includes("Gentle nudges"));
  }

  // 6. full renders don't throw with nudges present
  {
    const h = loadFresh({}, okJson({ conversations: [], archived: [] }));
    h.app.state.settings = { smtp: {}, imap: {}, matrix: {}, google: {} };
    h.app.state.status = { smtp: false, imap: false, matrix: false, google: false };
    h.app.state.nudges = [
      { key: "stale:c1", type: "stale", conversation_id: "c1", staged_id: "", title: "Quiet with Ava lately.", body: "It's been 9 days.", days: 9 },
    ];
    let threw = "";
    try { h.app.renderConversations(); } catch (e) { threw = "renderConversations: " + e.message; }
    ok("renderConversations with nudge card", threw === "");
    try { h.app.renderSettings(); } catch (e) { threw = "renderSettings: " + e.message; }
    ok("renderSettings with convo toggle", threw === "");
    try { h.app.openContactSheet(null); } catch (e) { threw = "openContactSheet: " + e.message; }
    ok("openContactSheet with cadence picker", threw === "");
    if (threw) console.log("   (" + threw + ")");
  }

  console.log(`\nui: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
