// Archived fold + commitments slide-down checks:
//  - archived section starts folded, expands/collapses, persists across a simulated reload
//  - commitments toggle sits under the search input; the panel slides open/closed,
//    reuses the existing commitments UI (search, tabs, rows), and persists
//  - conversation list still renders; full-page #/commitments route still works
// Run with: node tests/archive-commit-slide-check.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const pub = path.join(__dirname, "..", "public");

const iconsCode = fs.readFileSync(path.join(pub, "icons.js"), "utf8").replace('"use strict";', "");
const datesCode = fs.readFileSync(path.join(pub, "dates.js"), "utf8").replace('"use strict";', "");
const appCode = fs.readFileSync(path.join(pub, "app.js"), "utf8").replace('"use strict";', "")
  + `\n;globalThis.__APP__ = { state, renderConversations, renderGlobalCommits, loadConversations, toggleCommitPanel };`;

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
  { id: "c2", title: "Old group", is_group: true, avatar_color: "#8e8e93", member_count: 2, last_body: "bye", last_at: "2026-09-01T10:00:00", last_channel: "sms", last_direction: "out", unread: 0, archived: true, members: [{ id: "b", name: "Ben", color: "#30d158" }] },
];
const allCommits = [
  { id: "k1", text: "Send the contract", conversation_id: "c1", conversation_title: "Danyetta", due_date: "", status: "open" },
];
const allDecisions = [
  { id: "d1", text: "Launch Tuesday", conversation_id: "c1", conversation_title: "Danyetta", decided_at: "2026-09-19T10:00:00" },
];

async function stubFetch(url) {
  const u = String(url);
  const body = u.includes("/api/commitments/all") ? { commitments: allCommits }
    : u.includes("/api/decisions/all") ? { decisions: allDecisions }
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
    setTimeout: (fn) => { try { fn(); } catch {} return 0; },
    alert: () => {}, confirm: () => true, prompt: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(iconsCode, sandbox);
  vm.runInContext(datesCode, sandbox);
  vm.runInContext(appCode, sandbox);
  const A = sandbox.__APP__;
  A.state.conversations = activeConvs;
  A.state.archivedConversations = archivedConvs;
  A.state.globalCommits = allCommits;
  return { A, document, appEl: () => document.getElementById("app"), html: () => document.getElementById("app").innerHTML };
}

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }
const flush = async (n) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

(async () => {
  ls.clear();

  // --- fresh profile: archived folded, commitments panel closed ---
  let b = boot();
  b.A.renderConversations();
  let html = b.html();
  ok("archived starts folded", html.includes('id="arch-toggle"') && html.includes('aria-expanded="false"') && html.includes('class="arch-clip" inert'));
  ok("folded archived keeps its count", html.includes("Archived · 1"));
  ok("commitments toggle sits under the search input", html.indexOf("Search conversations") < html.indexOf("commit-slide-toggle"));
  ok("commitments panel starts closed", html.includes('id="commit-slide-toggle"') && html.includes('aria-expanded="false"')
    && !html.includes('class="commit-slide open"') && !html.includes('id="gq"'));
  ok("toggle carries the open-count badge", html.includes("ft-badge"));
  ok("active conversation still renders", html.includes("Danyetta"));

  // --- expand the archived fold ---
  b.document.querySelector("#arch-toggle").fire("click");
  html = b.html();
  ok("archived expands on toggle", html.includes('aria-expanded="true"') && html.includes("Old group") && html.includes('data-id="c2"'));
  ok("archived-open persists to localStorage", ls.get("relay_archived_open") === "1");

  // --- simulated reload: same localStorage, fresh JS context ---
  b = boot();
  b.A.renderConversations();
  html = b.html();
  ok("archived-open survives a reload", html.includes('aria-expanded="true"') && html.includes('class="arch-body open"'));
  b.document.querySelector("#arch-toggle").fire("click");
  ok("archived-closed persists to localStorage", ls.get("relay_archived_open") === "0"
    && b.html().includes('class="arch-clip" inert'));

  // --- slide the commitments panel open ---
  b.document.querySelector("#commit-slide-toggle").fire("click");
  html = b.html();
  ok("panel opens with a loading state first", html.includes('class="commit-slide open"') && html.includes("Loading commitments"));
  await flush(8);
  html = b.html();
  ok("panel loads the existing commitments UI", html.includes('id="gq"') && html.includes("Send the contract"));
  ok("panel rows link to conversations", html.includes('data-goto="c1"'));
  ok("panel has Open and Decisions tabs", html.includes('data-gtab="open"') && html.includes('data-gtab="decisions"'));
  ok("toggle reflects the open state", html.includes('id="commit-slide-toggle"') && html.includes('aria-expanded="true"'));
  ok("conversation list still renders with the panel open", html.includes("Danyetta"));
  ok("archived fold still present with the panel open", html.includes('id="arch-toggle"'));
  ok("panel-open persists to localStorage", ls.get("relay_commit_panel") === "1");

  // --- tabs switch inside the slide-down panel ---
  b.A.state.globalCommitTab = "decisions";
  b.A.renderConversations();
  html = b.html();
  ok("panel decisions tab reuses the same UI", html.includes("Launch Tuesday") && html.includes('aria-selected="true"'));
  b.A.state.globalCommitTab = "open";

  // --- slide it shut ---
  b.document.querySelector("#commit-slide-toggle").fire("click");
  html = b.html();
  ok("panel slides closed", !html.includes('class="commit-slide open"') && !html.includes('id="gq"'));
  ok("panel-closed persists to localStorage", ls.get("relay_commit_panel") === "0");

  // --- simulated reload keeps the panel closed ---
  b = boot();
  b.A.renderConversations();
  ok("panel-closed survives a reload", !b.html().includes('class="commit-slide open"'));

  // --- the full-page #/commitments route still works (reused UI) ---
  await b.A.renderGlobalCommits();
  html = b.html();
  ok("full-page commitments view still renders", html.includes('id="gq"') && html.includes("Send the contract") && html.includes("Conversations"));

  console.log(`archive-commit-slide: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
