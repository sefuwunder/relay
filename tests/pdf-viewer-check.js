// PDF viewer checks: isPdf detection, bubble chip rendering, viewer overlay
// open/close, Escape handling, widget tile icon.
// Run with: node tests/pdf-viewer-check.js
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
let lastCreated = null;
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
  createElement() { lastCreated = stubEl("created"); return lastCreated; },
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
load("app.js", "\n;globalThis.__APP__ = { state, openPdfViewer, closePdfViewer, renderPdfViewer, isPdf, bubbleAtts, filesPanelHtml, icon };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

// pdf icon exists and is distinct from the generic file icon
const pdfIcon = A.icon("pdf");
ok("pdf icon renders svg", pdfIcon.includes("<svg") && pdfIcon.includes("M6 3h8l4 4v14H6z"));
ok("pdf icon distinct from file icon", pdfIcon !== A.icon("file"));

// isPdf detection: mime, filename fallback, negatives
ok("isPdf by mime", A.isPdf({ mime: "application/pdf", filename: "x.bin" }));
ok("isPdf by filename", A.isPdf({ mime: "application/octet-stream", filename: "report.PDF" }));
ok("isPdf false for docx", !A.isPdf({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "d.docx" }));
ok("isPdf false for null", !A.isPdf(null));

// bubble chips: PDF becomes a viewer chip, other docs stay download anchors
const pdfAtt = { id: "p1", filename: "deck.pdf", mime: "application/pdf", size: 2048 };
const docAtt = { id: "d1", filename: "notes.txt", mime: "text/plain", size: 100 };
const pdfHtml = A.bubbleAtts({ attachments: [pdfAtt] });
ok("pdf chip has data-pdf", pdfHtml.includes('data-pdf="p1"') && pdfHtml.includes("att-pdfchip"));
ok("pdf chip not a download anchor", !pdfHtml.includes("<a "));
const docHtml = A.bubbleAtts({ attachments: [docAtt] });
ok("non-pdf doc still download link", docHtml.includes("<a ") && docHtml.includes("/api/attachments/d1"));

// widget tile uses the pdf icon
state.conv = { id: "c1" };
state.files = [{ ...pdfAtt, sent_at: new Date().toISOString() }];
state.fileResults = null; state.fileSearch = "";
const panelHtml = A.filesPanelHtml();
ok("widget tile shows pdf icon", panelHtml.includes("M6 3h8l4 4v14H6z"));

// viewer open: overlay with iframe pointing at the attachment URL
A.openPdfViewer({ id: "p1", filename: "deck.pdf", mime: "application/pdf", size: 2048, sent_at: new Date().toISOString() });
ok("viewer state set", state.pdfViewer && state.pdfViewer.id === "p1");
const vhtml = lastCreated ? lastCreated.innerHTML : "";
ok("viewer has iframe to attachment", lastCreated.id === "pdfview" && vhtml.includes('<iframe class="pdfv-doc"') && vhtml.includes('src="/api/attachments/p1"'));
ok("viewer header has name + download", vhtml.includes("deck.pdf") && vhtml.includes("pdfv-dl") && vhtml.includes('download="deck.pdf"'));

// Escape closes the viewer
ok("keydown handler registered", keyHandlers.length > 0);
keyHandlers.forEach((h) => h({ key: "Escape" }));
ok("escape closes viewer", state.pdfViewer === null);
ok("no-op close safe", (() => { A.closePdfViewer(); return true; })());

// viewer without sent_at still renders
A.openPdfViewer({ id: "p2", filename: "a.pdf", mime: "application/pdf", size: 10 });
ok("viewer renders without sent_at", lastCreated.innerHTML.includes("/api/attachments/p2"));
A.closePdfViewer();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
