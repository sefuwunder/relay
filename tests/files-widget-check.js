// Files widget + attachment rendering checks: widget panel, per-kind bubble
// rendering, email-only attach button, pending chips, lightbox content.
// Run with: node tests/files-widget-check.js
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
load("app.js", "\n;globalThis.__APP__ = { state, renderConversationDetail, openLightbox, closeLightbox, bubbleAtts, filesPanelHtml, fmtSize, attKind };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

const now = new Date().toISOString();
function mkConv(channels) {
  return {
    id: "c1", title: "File Friend", is_group: false,
    members: [{ id: "p1", name: "File Friend", color: "#0a84ff", avatar_url: "" }],
    channels, hints: {},
  };
}
function mkMsg(id, dir, body, atts) {
  return { id, conversation_id: "c1", channel: "email", direction: dir, body, subject: "", external_id: "", message_id: "", status: "sent", created_at: now, attachments: atts || [] };
}
const imgAtt = { id: "a1", message_id: "m1", filename: "photo.png", mime: "image/png", size: 1234, created_at: now };
const vidAtt = { id: "a2", message_id: "m1", filename: "clip.mp4", mime: "video/mp4", size: 99999, created_at: now };
const audAtt = { id: "a3", message_id: "m2", filename: "song.mp3", mime: "audio/mpeg", size: 54321, created_at: now };
const docAtt = { id: "a4", message_id: "m2", filename: "deck.pdf", mime: "application/pdf", size: 2048, created_at: now };
const fourFiles = [docAtt, audAtt, vidAtt, imgAtt].map((f) => ({ ...f, direction: "in", sent_at: now }));

function renderDetail(channels, messages, files) {
  state.conv = mkConv(channels);
  state.messages = messages;
  state.files = files;
  state.pendingFiles = [];
  state.replyTo = null;
  state.filesOpen = false;
  A.renderConversationDetail();
  return document.getElementById("app").innerHTML;
}

// helpers
ok("fmtSize bytes", A.fmtSize(512) === "512 B");
ok("fmtSize kilobytes", A.fmtSize(1536) === "1.5 KB");
ok("fmtSize megabytes", A.fmtSize(2097152) === "2.0 MB");
ok("attKind image/video/audio/file",
  A.attKind("image/png") === "image" && A.attKind("video/mp4") === "video" &&
  A.attKind("audio/mpeg") === "audio" && A.attKind("application/pdf") === "file");

// 1. widget panel renders with one tile per file
let html = renderDetail(["email"],
  [mkMsg("m1", "out", "see these", [imgAtt, vidAtt]), mkMsg("m2", "in", "nice", [audAtt, docAtt])],
  fourFiles);
ok("files panel renders", html.includes('id="files-panel"') && html.includes("Shared files"));
ok("one tile per file", (html.match(/data-ftile="/g) || []).length === 4);
ok("image tile shows a thumbnail", html.includes("/api/attachments/a1"));
ok("file count badge", />4<\/span>/.test(html) || html.includes('fp-count">4'));
ok("tile shows name + size", html.includes("deck.pdf") && html.includes("2.0 KB"));
ok("widget toggle in nav bar", html.includes('id="files-toggle"'));

// 2. per-kind bubble rendering
ok("image bubble is a zoomable thumbnail", html.includes('class="att att-img"') && html.includes('data-att="a1"'));
ok("video bubble has a player", html.includes("<video") && html.includes("/api/attachments/a2"));
ok("audio bubble has a player", html.includes("<audio") && html.includes("/api/attachments/a3"));
ok("doc bubble is a download chip", html.includes('class="att att-file"') && html.includes("deck.pdf"));
ok("bubble text still renders", html.includes("see these"));

// 3. attach button is email-only
ok("attach button on the email channel", html.includes('id="attach"'));
html = renderDetail(["sms"], [mkMsg("m1", "out", "hi", [])], []);
ok("no attach button on the sms channel", !html.includes('id="attach"'));
ok("files toggle still present on sms", html.includes('id="files-toggle"'));

// 4. pending file chips in the composer
html = renderDetail(["email"], [mkMsg("m1", "out", "hi", [])], []);
state.pendingFiles = [{ name: "big-photo.png", type: "image/png", size: 1048576 }];
A.renderConversationDetail();
html = document.getElementById("app").innerHTML;
ok("pending chip renders with name + size", html.includes("pchip") && html.includes("big-photo.png") && html.includes("1.0 MB"));
ok("pending chip has a remove button", html.includes("data-pchip="));

// 5. empty widget state
html = renderDetail(["email"], [], []);
ok("empty widget message", html.includes("No files shared yet"));
ok("empty conversation message intact", html.includes("Start the conversation"));

// 6. lightbox content per kind
const created = [];
document.createElement = () => { const el = stubEl("created"); created.push(el); return el; };
state.files = fourFiles;
A.openLightbox(state.files, 3); // image
ok("lightbox opens on the image", created.length === 1 && created[0].innerHTML.includes("lb-img") && created[0].innerHTML.includes("/api/attachments/a1"));
ok("lightbox has prev/next with several files", created[0].innerHTML.includes("lb-prev") && created[0].innerHTML.includes("lb-next"));
A.openLightbox(state.files, 0); // pdf
ok("lightbox shows a doc card for pdf", created[1].innerHTML.includes("lb-doc") && created[1].innerHTML.includes("deck.pdf"));
A.openLightbox(state.files, 1); // audio
ok("lightbox has an audio player", created[2].innerHTML.includes("<audio"));
A.closeLightbox();
ok("lightbox closes", state.lightbox === null);
ok("openLightbox ignores empty lists", (A.openLightbox([], 0), state.lightbox === null));

console.log(`files widget checks: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
