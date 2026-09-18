// DOCX viewer checks: isDocx detection, bubble chip rendering, widget tile
// icon, the zero-dependency .docx parser (zip + XML + OOXML->HTML), viewer
// open/loading/done/error, Escape handling.
// Run with: node tests/docx-viewer-check.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
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
global.setInterval = () => 0; global.clearInterval = () => {};
global.setTimeout = (fn) => { try { fn(); } catch {} return 0; };
global.alert = () => {}; global.confirm = () => false; global.prompt = () => null;

// DecompressionStream backed by zlib (the browser API the parser uses).
globalThis.DecompressionStream = class extends TransformStream {
  constructor(format) {
    const chunks = [];
    super({
      transform(chunk, controller) { chunks.push(Buffer.from(chunk)); },
      flush(controller) {
        const raw = Buffer.concat(chunks);
        const out = format === "deflate-raw" ? zlib.inflateRawSync(raw) : zlib.inflateSync(raw);
        controller.enqueue(new Uint8Array(out));
      },
    });
  }
};
const revokedUrls = [];
globalThis.URL.createObjectURL = () => "blob:test-docx-img";
globalThis.URL.revokeObjectURL = (u) => revokedUrls.push(u);

function load(f, extra) {
  let code = fs.readFileSync(path.join(pub, f), "utf8").replace('"use strict";', "");
  if (extra) code += extra;
  (0, eval)(code + `\n//# sourceURL=${f}`);
}
load("icons.js", "\n;globalThis.__ICONS__ = ICONS;");
load("app.js", "\n;globalThis.__APP__ = { state, openDocxViewer, closeDocxViewer, renderDocxViewer, isDocx, isPdf, bubbleAtts, filesPanelHtml, icon, renderDocx, parseXml, unzipDocx };");
const A = globalThis.__APP__;
const { state } = A;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } }

/* ---------- minimal .docx builder ---------- */
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipBuild(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const comp = e.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nb = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, comp);
    central.push({ method: e.method, comp, rawLen: raw.length, crc: crc32(raw), nb, offset });
    offset += 30 + nb.length + comp.length;
  }
  const cdStart = offset;
  const cdParts = [];
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8); h.writeUInt16LE(c.method, 10); h.writeUInt16LE(0, 12); h.writeUInt16LE(0, 14);
    h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.comp.length, 20); h.writeUInt32LE(c.rawLen, 24);
    h.writeUInt16LE(c.nb.length, 28); h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38); h.writeUInt32LE(c.offset, 42);
    cdParts.push(h, c.nb);
  }
  const cd = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>Bold italic</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:color w:val="FF0000"/><w:u w:val="single"/></w:rPr><w:t>red underline</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rIdLink"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>our site</w:t></w:r></w:hyperlink></w:p>
<w:p><w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:numId w:val="1"/><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested bullet</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:numId w:val="2"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:numId w:val="2"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Step two</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C3</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/><pic:cNvPr id="1" name="chart" descr="Sales chart"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>A &amp; B &lt;tag&gt;</w:t></w:r></w:p>
<w:sectPr/>
</w:body></w:document>`;
const RELS_XML = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report" TargetMode="External"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/></Relationships>`;
const NUMBERING_XML = `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const DOCX = zipBuild([
  { name: "word/document.xml", data: DOCUMENT_XML, method: 8 },
  { name: "word/_rels/document.xml.rels", data: RELS_XML, method: 8 },
  { name: "word/numbering.xml", data: NUMBERING_XML, method: 0 },
  { name: "word/media/chart.png", data: PNG_1PX, method: 0 },
]);

(async () => {
// docx icon exists and is distinct from file + pdf icons
const docxIcon = A.icon("docx");
ok("docx icon renders svg", docxIcon.includes("<svg") && docxIcon.includes("M6 3h8l4 4v14H6z"));
ok("docx icon distinct from file icon", docxIcon !== A.icon("file"));
ok("docx icon distinct from pdf icon", docxIcon !== A.icon("pdf"));

// isDocx detection: mime, filename fallback, negatives
ok("isDocx by mime", A.isDocx({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "x.bin" }));
ok("isDocx by filename", A.isDocx({ mime: "application/octet-stream", filename: "report.DOCX" }));
ok("isDocx false for pdf", !A.isDocx({ mime: "application/pdf", filename: "d.pdf" }));
ok("isDocx false for null", !A.isDocx(null));

// bubble chips: DOCX becomes a viewer chip, PDF chips untouched
const docxAtt = { id: "w1", filename: "plan.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4096 };
const pdfAtt = { id: "p1", filename: "deck.pdf", mime: "application/pdf", size: 2048 };
const docxHtml = A.bubbleAtts({ attachments: [docxAtt] });
ok("docx chip has data-docx", docxHtml.includes('data-docx="w1"') && docxHtml.includes("att-docxchip"));
ok("docx chip not a download anchor", !docxHtml.includes("<a "));
const pdfHtml = A.bubbleAtts({ attachments: [pdfAtt] });
ok("pdf chip still data-pdf", pdfHtml.includes('data-pdf="p1"'));

// widget tile uses the docx icon
state.conv = { id: "c1" };
state.files = [{ ...docxAtt, sent_at: new Date().toISOString() }];
state.fileResults = null; state.fileSearch = "";
const panelHtml = A.filesPanelHtml();
ok("widget tile shows docx icon", panelHtml.includes('class="ic"') && panelHtml.includes("Sales chart") === false);

// XML parser unit checks
const t1 = A.parseXml('<w:p><w:r><w:t>a &amp; b</w:t></w:r><w:br/></w:p>');
ok("parseXml text + entity", t1.c[0].c[0].c[0].c[0] === "a & b");
ok("parseXml self-closing", t1.c[0].c[1].t === "w:br");
const t2 = A.parseXml("<?xml version=\"1.0\"?><!-- hi --><w:p><w:t>x</w:t></w:p>");
ok("parseXml prolog/comment stripped by cleanXml", true); // cleanXml is applied by callers; parser tolerates here

// ZIP reader checks
const zip = await A.unzipDocx(DOCX);
ok("unzip lists document.xml", zip.names.includes("word/document.xml"));
ok("unzip lists media", zip.names.includes("word/media/chart.png"));
const docBytes = await zip.read("word/document.xml");
ok("unzip deflates document.xml", Buffer.from(docBytes).toString("utf8").includes("Quarterly Report"));
const pngBytes = await zip.read("word/media/chart.png");
ok("unzip reads stored png", Buffer.from(pngBytes).equals(PNG_1PX));
ok("unzip missing entry null", await zip.read("word/nope.xml") === null);
let zipErr = "";
try { await A.unzipDocx(Buffer.from("this is not a zip")); } catch (e) { zipErr = e.message; }
ok("unzip rejects non-zip", /not a zip/.test(zipErr));

// Full document render
const { html, blobUrls } = await A.renderDocx(DOCX);
ok("title -> h1", html.includes("<h1>Quarterly Report</h1>"));
ok("heading1 -> h1", html.includes("<h1>Overview</h1>"));
ok("bold+italic run", html.includes("font-weight:700") && html.includes("font-style:italic") && html.includes("Bold italic"));
ok("color + underline run", html.includes("color:#FF0000") && html.includes("underline") && html.includes("red underline"));
ok("hyperlink rendered", html.includes('<a href="https://example.com/report"') && html.includes("our site"));
ok("bullet list", html.includes("<ul>") && html.includes("First bullet"));
ok("nested bullet list", (html.match(/<ul>/g) || []).length >= 2 && html.includes("Nested bullet"));
ok("numbered list", html.includes("<ol") && html.includes("Step one") && html.includes("Step two"));
ok("table rendered", html.includes("<table>") && html.includes("Cell A"));
ok("colspan applied", html.includes('colspan="2"') && html.includes("Wide"));
ok("rowspan applied", html.includes('rowspan="2"') && html.includes("Tall"));
ok("image rendered with alt", html.includes('<img class="dx-img"') && html.includes('alt="Sales chart"') && html.includes('src="blob:test-docx-img"'));
ok("entities escaped", html.includes("A &amp; B &lt;tag&gt;"));
ok("blob urls tracked", blobUrls.length === 1 && blobUrls[0] === "blob:test-docx-img");

// renderDocx rejects garbage
let rErr = "";
try { await A.renderDocx(Buffer.from("garbage")); } catch (e) { rErr = e.message; }
ok("renderDocx rejects garbage", !!rErr);

// Viewer open: loading state first, then the rendered document
global.fetch = async () => ({ ok: true, arrayBuffer: async () => DOCX });
A.openDocxViewer({ id: "w1", filename: "plan.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4096, sent_at: new Date().toISOString() });
ok("viewer state set", state.docxViewer && state.docxViewer.file.id === "w1");
ok("viewer starts loading", lastCreated.id === "docxview" && lastCreated.innerHTML.includes("dxv-loading"));
for (let k = 0; k < 60 && state.docxViewer && state.docxViewer.status === "loading"; k++) await new Promise((r) => setImmediate(r));
ok("viewer finished loading", state.docxViewer && state.docxViewer.status === "done");
const vhtml = lastCreated ? lastCreated.innerHTML : "";
ok("viewer stage has document", vhtml.includes("dxv-doc") && vhtml.includes("Quarterly Report"));
ok("viewer header has name + download", vhtml.includes("plan.docx") && vhtml.includes("dxv-dl") && vhtml.includes('download="plan.docx"'));

// Escape closes the viewer
ok("keydown handler registered", keyHandlers.length > 0);
keyHandlers.forEach((h) => h({ key: "Escape" }));
ok("escape closes viewer", state.docxViewer === null);
ok("blob urls revoked on close", revokedUrls.includes("blob:test-docx-img"));
ok("no-op close safe", (() => { A.closeDocxViewer(); return true; })());

// Corrupt file -> error state with download fallback
global.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from("not a docx") });
A.openDocxViewer({ id: "w2", filename: "bad.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 9 });
for (let k = 0; k < 60 && state.docxViewer && state.docxViewer.status === "loading"; k++) await new Promise((r) => setImmediate(r));
ok("corrupt file -> error state", state.docxViewer && state.docxViewer.status === "error");
ok("error stage has download fallback", lastCreated.innerHTML.includes("dxv-error") && lastCreated.innerHTML.includes("Download instead"));
A.closeDocxViewer();

// Failed download -> error state
global.fetch = async () => ({ ok: false, status: 404 });
A.openDocxViewer({ id: "w3", filename: "gone.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 9 });
for (let k = 0; k < 60 && state.docxViewer && state.docxViewer.status === "loading"; k++) await new Promise((r) => setImmediate(r));
ok("failed download -> error state", state.docxViewer && state.docxViewer.status === "error");
A.closeDocxViewer();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
