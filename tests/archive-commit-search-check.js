// Archived fold + commitments/decisions conversation-search checks:
//  - archived section starts folded, expands/collapses, persists across a simulated reload
//  - the old global commitments toggle/slide-down panel is gone entirely
//  - typing >=2 chars in "Search conversations" debounces one fetch per endpoint;
//    matches render in a labeled "Commitments & decisions" section below the
//    conversation rows (above the archived fold), with a "View all" link;
//    rows deep-link to the conversation and anchor to the source message
//  - empty query -> no section, no fetches; no matches -> one-line empty state
//  - archived conversations' rows carry the archive badge
//  - full-page #/commitments route still works
// Run with: node tests/archive-commit-search-check.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const pub = path.join(__dirname, "..", "public");

const iconsCode = fs.readFileSync(path.join(pub, "icons.js"), "utf8").replace('"use strict";', "");
const datesCode = fs.readFileSync(path.join(pub, "dates.js"), "utf8").replace('"use strict";', "");
const appCode = fs.readFileSync(path.join(pub, "app.js"), "utf8").replace('"use strict";', "")
  + `\n;globalThis.__APP__ = { state, renderConversations, renderGlobalCommits, scheduleCommitSearch, bindGotoRows, scrollToPendingMessage };`;

function stubEl(id, selCache) {
  const el = {
    id: id || "", textContent: "", value: "", className: "", style: {},
    checked: false, dataset: {}, files: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _html: "",
    _l: {},
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener() {}, remove() {},
    appendChild() {}, removeChild() {},
    querySelector(s) { return stubEl(s); },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    classList: { add() {}, remove() {} },
    scrollIntoView() {},
    focus() {}, click() {}, setAttribute() {}, setSelectionRange() {},
    fire(t, e) { (this._l[t] || []).forEach((fn) => fn(e || {})); },
  };
  // Emulate DOM node replacement: setting #app's innerHTML discards the old
  // subtree, so cached selector stubs from the previous render go stale.
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) {
      this._html = String(v);
      if (id === "app") { for (const k of Object.keys(selCache)) delete selCache[k]; }
    },
  });
  return el;
}

const activeConvs = [
  { id: "c1", title: "Danyetta", is_group: false, avatar_color: "#0a84ff", member_count: 1, last_body: "hey", last_at: "2026-09-18T10:00:00", last_channel: "email", last_direction: "in", unread: 1, archived: false, members: [{ id: "a", name: "Danyetta", color: "#0a84ff" }] },
];
const archivedConvs = [
  { id: "c2", title: "Book club", is_group: true, avatar_color: "#8e8e93", member_count: 2, last_body: "bye", last_at: "2026-09-01T10:00:00", last_channel: "sms", last_direction: "out", unread: 0, archived: true, members: [{ id: "b", name: "Ben", color: "#30d158" }] },
];
const allCommits = [
  { id: "k1", text: "Send the contract", conversation_id: "c1", conversation_title: "Danyetta", due_date: "", status: "open", message_id: "m1" },
  { id: "k2", text: "Book the venue", conversation_id: "c2", conversation_title: "Book club", due_date: "", status: "open", archived: 1, message_id: "m2" },
];
const allDecisions = [
  { id: "d1", text: "Launch Tuesday", conversation_id: "c1", conversation_title: "Danyetta", decided_at: "2026-09-19T10:00:00", participants: '["me"]', message_id: "m3" },
];

const fetchCalls = [];
function qOf(u) {
  const m = String(u).match(/[?&]q=([^&]*)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}
async function stubFetch(url) {
  const u = String(url);
  fetchCalls.push(u);
  const q = qOf(u);
  const keep = (r) => !q || (r.text || "").toLowerCase().includes(q);
  const body = u.includes("/api/commitments/all") ? { commitments: allCommits.filter(keep) }
    : u.includes("/api/decisions/all") ? { decisions: allDecisions.filter(keep) }
    : u.includes("archived=1") ? { conversations: archivedConvs }
    : u.includes("/api/conversations") ? { conversations: activeConvs }
    : {};
  return { ok: true, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

// Shared across boots: simulates the same browser profile's localStorage.
const ls = new Map();

function boot() {
  const store = {};
  const selCache = {};
  let timerSeq = 0;
  let timers = [];
  const mk = (id) => stubEl(id, selCache);
  const document = {
    title: "",
    visibilityState: "hidden",
    getElementById(id) { if (!store[id]) store[id] = mk(id); return store[id]; },
    querySelector(sel) {
      if (sel === "#app") return document.getElementById("app");
      if (!selCache[sel]) selCache[sel] = mk(sel);
      return selCache[sel];
    },
    querySelectorAll() { return []; },
    createElement() { return mk("created"); },
    body: { appendChild() {}, removeChild() {}, addEventListener() {} },
    addEventListener() {},
  };
  const sandbox = {
    console,
    document,
    window: { addEventListener() {}, focus() {}, location: { hash: "" }, innerWidth: 1280, innerHeight: 800 },
    location: { hash: "" },
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    },
    Notification: class { constructor() {} close() {} static requestPermission() { return Promise.resolve("granted"); } },
    fetch: stubFetch,
    setInterval: () => 0, clearInterval: () => {},
    // Manual timer queue so debounce behavior is testable.
    setTimeout: (fn) => { const id = ++timerSeq; timers.push({ id, fn }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    alert: () => {}, confirm: () => true, prompt: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(iconsCode, sandbox);
  vm.runInContext(datesCode, sandbox);
  vm.runInContext(appCode, sandbox);
  const A = sandbox.__APP__;
  A.state.conversations = activeConvs;
  A.state.archivedConversations = archivedConvs;
  return {
    A, document, sandbox,
    appEl: () => document.getElementById("app"),
    html: () => document.getElementById("app").innerHTML,
    runTimers: async () => { const q = timers; timers = []; for (const t of q) await t.fn(); },
    pendingTimers: () => timers.length,
  };
}

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }
const flush = async (n) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

(async () => {
  ls.clear();
  fetchCalls.length = 0;

  // --- fresh profile: archived folded, no commitments toggle/panel anywhere ---
  let b = boot();
  b.A.renderConversations();
  let html = b.html();
  ok("archived starts folded", html.includes('id="arch-toggle"') && html.includes('aria-expanded="false"') && html.includes('class="arch-clip" inert'));
  ok("folded archived keeps its count", html.includes("Archived · 1"));
  ok("commitments toggle is gone", !html.includes("commit-slide-toggle") && !html.includes("commit-slide"));
  ok("no commitments search section on empty query", !html.includes("csq-section"));
  ok("empty query issues no /all fetches", !fetchCalls.some((u) => u.includes("/api/commitments/all") || u.includes("/api/decisions/all")));
  ok("active conversation still renders", html.includes("Danyetta"));

  // --- expand the archived fold ---
  b.document.querySelector("#arch-toggle").fire("click");
  html = b.html();
  ok("archived expands on toggle", html.includes('aria-expanded="true"') && html.includes("Book club") && html.includes('data-id="c2"'));
  ok("archived-open persists to localStorage", ls.get("relay_archived_open") === "1");

  // --- simulated reload: same localStorage, fresh JS context ---
  b = boot();
  b.A.renderConversations();
  html = b.html();
  ok("archived-open survives a reload", html.includes('aria-expanded="true"') && html.includes('class="arch-body open"'));
  b.document.querySelector("#arch-toggle").fire("click");
  ok("archived-closed persists to localStorage", ls.get("relay_archived_open") === "0"
    && b.html().includes('class="arch-clip" inert'));

  // --- search commitments & decisions: debounced, one fetch per endpoint ---
  fetchCalls.length = 0;
  b.A.state.search = "contrac";
  b.A.scheduleCommitSearch();
  b.A.state.search = "contract";
  b.A.scheduleCommitSearch();
  ok("search fetch is debounced", !fetchCalls.some((u) => u.includes("/api/commitments/all") || u.includes("/api/decisions/all")));
  ok("only one timer pending after two keystrokes", b.pendingTimers() === 1);
  await b.runTimers();
  await flush(8);
  const nCommit = fetchCalls.filter((u) => u.includes("/api/commitments/all")).length;
  const nDec = fetchCalls.filter((u) => u.includes("/api/decisions/all")).length;
  ok("one commitments fetch per query", nCommit === 1);
  ok("one decisions fetch per query", nDec === 1);
  ok("fetch carries q + include_archived", fetchCalls.some((u) => u.includes("/api/commitments/all?q=contract") && u.includes("include_archived=1")));
  html = b.html();
  ok("section renders with label + count", html.includes("csq-section") && html.includes("Commitments &amp; decisions · 1"));
  ok("section sits below the conversation results", html.indexOf("No conversations yet") < html.indexOf("csq-section"));
  ok("section has a View all link", html.includes('href="#/commitments"'));
  ok("matching commitment row renders", html.includes("Send the contract") && html.includes('data-goto="c1"'));
  ok("row carries the message anchor", html.includes('data-msg="m1"'));
  ok("row has a kind icon", html.includes("cm-kind"));
  ok("conversation list still renders with results", html.includes("Danyetta"));

  // --- cached: same query doesn't refetch ---
  fetchCalls.length = 0;
  b.A.scheduleCommitSearch();
  ok("repeat query uses the cache", b.pendingTimers() === 0 && fetchCalls.length === 0);

  // --- decisions match too, with participant names ---
  b.A.state.search = "launch";
  b.A.scheduleCommitSearch();
  await b.runTimers();
  await flush(8);
  html = b.html();
  ok("matching decision row renders", html.includes("Launch Tuesday"));
  ok("decision shows participant name", html.includes(">You<"));

  // --- archived conversation's row carries the archive badge ---
  // "book" matches the archived conv too, so the fold renders: the section
  // must sit above it.
  b.A.state.search = "book";
  b.A.scheduleCommitSearch();
  await b.runTimers();
  await flush(8);
  html = b.html();
  ok("archived row renders", html.includes("Book the venue"));
  ok("archived row flagged with the archive badge", html.includes("Book the venue") && html.includes("arch-badge"));
  ok("section sits above the archived fold", html.indexOf("csq-section") < html.indexOf("arch-fold"));
  ok("archived fold still present with results", html.includes('id="arch-toggle"'));

  // --- no matches: one-line empty state ---
  b.A.state.search = "zzz-no-such-thing";
  b.A.scheduleCommitSearch();
  await b.runTimers();
  await flush(8);
  html = b.html();
  ok("no-match shows the empty state", html.includes("csq-section") && html.includes("No commitments or decisions match."));

  // --- clearing the query removes the section without fetching ---
  fetchCalls.length = 0;
  b.A.state.search = "";
  b.A.scheduleCommitSearch();
  b.A.renderConversations();
  html = b.html();
  ok("empty query removes the section", !html.includes("csq-section"));
  ok("empty query fetches nothing", fetchCalls.length === 0);

  // --- row click deep-links and anchors the message ---
  b.A.state.search = "contract";
  b.A.scheduleCommitSearch();
  await b.runTimers();
  await flush(8);
  const app = b.appEl();
  const listeners = {};
  const fakeRow = { dataset: { goto: "c1", msg: "m1", panel: "" }, addEventListener(t, fn) { listeners[t] = fn; } };
  const origQSA = app.querySelectorAll;
  app.querySelectorAll = () => [fakeRow];
  b.A.bindGotoRows(app);
  app.querySelectorAll = origQSA;
  listeners.click();
  ok("row click navigates to the conversation", b.sandbox.location.hash === "#/conversations/c1");
  ok("row click anchors the source message", b.A.state._pendingMsg === "m1");

  // --- scrollToPendingMessage finds the message in the thread ---
  const seen = [];
  const fakeMsg = { getAttribute: () => "m1", classList: { add(c) { seen.push("add:" + c); }, remove(c) { seen.push("remove:" + c); } }, scrollIntoView() { seen.push("scroll"); } };
  const origDocQSA = b.document.querySelectorAll;
  b.document.querySelectorAll = () => [fakeMsg];
  b.A.scrollToPendingMessage();
  b.document.querySelectorAll = origDocQSA;
  ok("pending message is scrolled into view", seen.includes("scroll") && seen.includes("add:msg-flash"));
  ok("pending message flag is consumed", b.A.state._pendingMsg === null);

  // --- the full-page #/commitments route still works (reused UI) ---
  await b.A.renderGlobalCommits();
  html = b.html();
  ok("full-page commitments view still renders", html.includes('id="gq"') && html.includes("Send the contract") && html.includes("Conversations"));
  ok("full-page rows still deep-link", html.includes('data-goto="c1"'));

  console.log(`archive-commit-search: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
