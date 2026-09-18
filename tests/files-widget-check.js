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
load("app.js", "\n;globalThis.__APP__ = { state, renderConversationDetail, openLightbox, closeLightbox, bubbleAtts, filesPanelHtml, activeFiles, runFileSearch, wireFilesPanel, refreshFiles, fmtSize, attKind, groupStackable };");
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
ok("one tile per file group", (html.match(/data-fentry="/g) || []).length === 4);
ok("image tile shows a thumbnail", html.includes("/api/attachments/a1"));
ok("file count badge", />4<\/span>/.test(html) || html.includes('fp-count">4'));
ok("tile shows name + size", html.includes("deck.pdf") && html.includes("2.0 KB"));
ok("widget toggle in nav bar", html.includes('id="files-toggle"'));

// 2. per-kind bubble rendering
const bhtml = A.bubbleAtts(mkMsg("m1", "out", "see these", [imgAtt]));
ok("image bubble is a chip, not an inline thumbnail",
  bhtml.includes("att-imgchip") && bhtml.includes('data-att="a1"') && !bhtml.includes("<img"));
ok("image chip still opens the lightbox via data-att", bhtml.includes('data-att="a1"') && bhtml.includes("photo.png"));
ok("video bubble has a player", html.includes("<video") && html.includes("/api/attachments/a2"));
ok("audio bubble has a player", html.includes("<audio") && html.includes("/api/attachments/a3"));
ok("pdf bubble opens the in-app viewer", html.includes('data-pdf="a4"') && html.includes("att-pdfchip") && html.includes("deck.pdf"));
ok("bubble text still renders", html.includes("see these"));

// 2b. same-message images stack into one tile
const stackFiles = [
  { ...imgAtt, id: "b1", filename: "one.png", message_id: "mx", direction: "in", sent_at: now },
  { ...imgAtt, id: "b2", filename: "two.png", message_id: "mx", direction: "in", sent_at: now },
  { ...docAtt, direction: "in", sent_at: now },
];
const entries = A.groupStackable(stackFiles);
ok("groupStackable groups same-message images",
  entries.length === 2 && entries[0].type === "stack" && entries[0].images.length === 2);
ok("groupStackable keeps non-images separate",
  entries[1].type === "file" && entries[1].f.filename === "deck.pdf");
ok("groupStackable keeps different messages apart",
  A.groupStackable([{ ...imgAtt, id: "x1", message_id: "m1" }, { ...imgAtt, id: "x2", message_id: "m2" }])
    .filter((e) => e.type === "stack").length === 2);
ok("groupStackable never groups video/audio",
  A.groupStackable([{ ...vidAtt }, { ...audAtt }]).every((e) => e.type === "file"));
state.files = stackFiles; state.fileResults = null;
const stackHtml = A.filesPanelHtml();
ok("stack renders one tile with a count badge",
  (stackHtml.match(/data-fentry="/g) || []).length === 2 && stackHtml.includes('ft-count">2'));
ok("stack shows layered cards behind the top image", stackHtml.includes('class="ft-layer l1"'));
ok("stack top is the newest image", stackHtml.includes("/api/attachments/b1"));
ok("single-image stack shows no badge or layers",
  (() => { state.files = [{ ...imgAtt, direction: "in", sent_at: now }]; const h = A.filesPanelHtml(); state.files = fourFiles;
    return h.includes("file-stack") && !h.includes("ft-count") && !h.includes("ft-layer"); })());

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
// 7. shared-files search: filename + last-90-days filter
state.fileSearch = "";
state.fileResults = null;
html = renderDetail(["email"], [mkMsg("m1", "out", "see these", [imgAtt])], fourFiles);
ok("search box renders in the widget", html.includes('id="fp-q"') && html.includes('aria-label="Search shared files"'));
ok("activeFiles returns recent files when not searching", A.activeFiles() === state.files);

// Search-mode rendering.
state.fileSearch = "photo";
state.fileResults = [{ ...imgAtt, direction: "in", sent_at: now }];
let sHtml = A.filesPanelHtml();
ok("search mode keeps the query in the box", sHtml.includes('value="photo"'));
ok("search mode shows result count", sHtml.includes('id="fp-resmeta"') && sHtml.includes("1 result"));
ok("search mode shows a clear button", sHtml.includes('id="fp-clear"'));
ok("search mode shows only the match", sHtml.includes("photo.png") && !sHtml.includes("deck.pdf"));
state.fileResults = [];
sHtml = A.filesPanelHtml();
ok("no-match state names the query", sHtml.includes("No files matching") && sHtml.includes("photo"));
state.fileSearch = ""; state.fileResults = null;

// Live search round-trip against a stubbed API.
let lastFilesUrl = "";
global.fetch = async (url) => ({ ok: true, json: async () => {
  if (String(url).includes("/files")) { lastFilesUrl = String(url); return { files: [{ ...imgAtt }] }; }
  return {};
} });
(async () => {
  state.conv = state.conv || mkConv(["email"]);
  await A.runFileSearch("photo");
  ok("search queries the files endpoint with q + days=90", lastFilesUrl.includes("q=photo") && lastFilesUrl.includes("days=90"));
  ok("search stores results and flips to search mode", state.fileSearch === "photo" && state.fileResults.length === 1);
  ok("activeFiles follows search results", A.activeFiles() === state.fileResults);
  await A.runFileSearch("");
  ok("clearing the query exits search mode", state.fileResults === null && state.fileSearch === "");
  // Escape clears the box.
  await A.runFileSearch("photo");
  A.wireFilesPanel();
  const qi = document.querySelector("#fp-q");
  qi.value = "photo";
  qi.fire("keydown", { key: "Escape" });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  ok("Escape clears the search", state.fileSearch === "" && state.fileResults === null && qi.value === "");
  console.log(`files widget checks: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
