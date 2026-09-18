/* Relay — unified messenger frontend: clean, modern, OS-agnostic glass. */
"use strict";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtPhone = (d) => { const s = String(d || "").replace(/\D/g, ""); return s.length === 10 ? `(${s.slice(0, 3)}) ${s.slice(3, 6)}-${s.slice(6)}` : s; };
const normDigits = (d) => String(d || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? `${MON3[Number(m[2]) - 1]} ${Number(m[3])}` : (iso || ""); };

const CHAN_META = {
  email: { label: "Email", ic: "email" },
  sms: { label: "SMS", ic: "sms" },
  matrix: { label: "Matrix", ic: "matrix" },
};

const state = {
  status: null,
  conversations: [],
  contacts: [],
  archivedContacts: [],
  conv: null,          // open conversation detail
  messages: [],
  search: "",
  settings: null,
  chanSel: {},         // convId -> channel
  sending: false,
  replyTo: null,       // message being replied to in-thread (email)
  timer: null,
  files: [],           // recently shared files in the open conversation
  pendingFiles: [],    // File objects staged in the composer
  panel: null,         // side panel: "files" | "diary" | null
  diary: [],           // appointments in the open conversation
  diaryOffset: 0,      // week offset from the current week in the diary
  eventForm: false,    // inline calendar-invitation form open in the composer
  eventDraft: null,    // in-progress invitation field values
  pendingEvent: null,  // validated invitation to send with the next message
  fileSearch: "",      // shared-files widget search query (last 90 days)
  fileResults: null,   // search matches; null = browsing recent files
  lightbox: null,      // { files, index } when the preview overlay is open
  pdfViewer: null,    // file object when the PDF viewer overlay is open
  docxViewer: null,   // { file, status, html, error, blobs } when the DOCX viewer is open
  dropDraft: false,    // set before re-rendering after a successful send
  convListSig: "",     // signature of the last rendered conversation list (skips no-op re-renders)
  seenMsgIds: null,    // ids of messages already on screen (only new ones animate in)
  notify: (() => { try { return localStorage.getItem("relay_notify") === "1"; } catch { return false; } })(),
};

async function api(path, opts = {}) {
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const res = await fetch(path, {
    ...opts,
    headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* noop */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    if (body && body.failed_message) err.failed_message = body.failed_message;
    throw err;
  }
  return body;
}

function toast(msg, isErr) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " error" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 320); }, 2600);
}

function initials(name) {
  // Array.from: emoji are surrogate pairs — w[0] would slice one in half and render tofu.
  return name.trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0]).join("").toUpperCase() || "?";
}

function avatarHtml(name, color, size, group, url) {
  return `<div class="avatar a${size}${group ? " group" : ""}" style="background:linear-gradient(135deg, ${color}, ${color}cc)">${esc(initials(name))}${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</div>`;
}

// Long-message truncation: bubbles collapse past TRUNC_LEN chars; tapping
// "more"/"less" expands in place. Per-message expanded state survives
// re-renders while the conversation is open.
const TRUNC_LEN = 500;
const expandedIds = new Set();

function bubbleText(m) {
  const text = String(m.body ?? "");
  const expanded = expandedIds.has(String(m.id));
  if (text.length <= TRUNC_LEN) return esc(text);
  const label = expanded ? "less" : "more";
  const shown = expanded ? text : text.slice(0, TRUNC_LEN) + "…";
  return `${esc(shown)} <button class="more" data-mid="${esc(m.id)}">${label}</button>`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button.more");
  if (!btn || !$("#msgs")) return;
  const id = String(btn.dataset.mid || "");
  const m = state.messages.find((x) => String(x.id) === id);
  if (!m) return;
  if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
  const span = btn.closest(".bubble-text");
  if (span) span.innerHTML = bubbleText(m);
});

function chanPill(ch) {
  const m = CHAN_META[ch];
  if (!m) return "";
  return `<span class="chan-pill ${ch}">${icon(m.ic)}${m.label}</span>`;
}

// ---------- shared files ----------

function fmtSize(n) {
  n = Number(n || 0);
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function attKind(mime) {
  mime = String(mime || "");
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function attIconName(kind) {
  return kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "audio" : "file";
}

function attachUrl(id) {
  return "/api/attachments/" + encodeURIComponent(id);
}

/** True for PDF files: detected by MIME type or .pdf filename. */
function isPdf(f) {
  return !!f && (f.mime === "application/pdf" || /\.pdf$/i.test(f.filename || ""));
}

/** True for Word .docx files: detected by MIME type or .docx filename. */
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function isDocx(f) {
  return !!f && (f.mime === DOCX_MIME || /\.docx$/i.test(f.filename || ""));
}

/** "Thu, Sep 18 · 2:00 PM – 3:30 PM" from ISO UTC bounds. */
function fmtApptRange(startsAt, endsAt) {
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return "";
  const dateFmt = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeFmt = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (s.toDateString() === e.toDateString()) return `${dateFmt(s)} · ${timeFmt(s)} – ${timeFmt(e)}`;
  return `${dateFmt(s)} ${timeFmt(s)} – ${dateFmt(e)} ${timeFmt(e)}`;
}

/** Small status pill for an appointment. */
function apptStatusChip(status) {
  const labels = { sent: "sent", received: "invitation", accepted: "accepted", declined: "declined", cancelled: "cancelled" };
  return `<span class="appt-status st-${esc(status || "")}">${esc(labels[status] || status || "")}</span>`;
}

/** Calendar invitation card rendered inline in the bubble. Inbound invites the
    user hasn't answered get Accept / Decline buttons. */
function inviteCard(m, a) {
  const ap = m.appointment;
  const title = ap ? ap.title : (a.filename || "Calendar invitation");
  const when = ap ? fmtApptRange(ap.starts_at, ap.ends_at) : "";
  const loc = ap && ap.location ? `<div class="inv-loc">${icon("pin")}<span>${esc(ap.location)}</span></div>` : "";
  const desc = ap && ap.description ? `<div class="inv-desc">${esc(ap.description)}</div>` : "";
  const status = ap ? apptStatusChip(ap.status) : "";
  const actions = ap && m.direction === "in" && ap.status === "received"
    ? `<div class="inv-actions"><button class="inv-btn accept" data-appt-accept="${esc(ap.id)}">Accept</button><button class="inv-btn decline" data-appt-decline="${esc(ap.id)}">Decline</button></div>`
    : "";
  return `<div class="invite-card">
    <div class="inv-head">${icon("calendar")}<div class="inv-meta"><div class="inv-title">${esc(title)}</div>${when ? `<div class="inv-when">${when}</div>` : ""}</div>${status}</div>
    ${loc}${desc}${actions}
  </div>`;
}

/** Attachment chips inside a message bubble. Images are preview chips (no inline
    thumbnails — previews live in the Shared files widget); video/audio get
    small players; calendar invites render as invitation cards; the rest are
    download chips. */
function bubbleAtts(m) {
  const atts = m.attachments || [];
  if (!atts.length) return "";
  return `<div class="att-list">${atts.map((a) => {
    const kind = attKind(a.mime);
    const url = attachUrl(a.id);
    const label = esc(a.filename || "file");
    if (a.mime === "text/calendar" || /\.ics$/i.test(a.filename || "")) {
      return inviteCard(m, a);
    }
    if (kind === "image") {
      return `<button class="att att-file att-imgchip" data-att="${esc(a.id)}" title="${label} — ${esc(fmtSize(a.size))}">${icon("image")}<span class="att-name">${label}</span><span class="att-size">${esc(fmtSize(a.size))}</span></button>`;
    }
    if (kind === "video") {
      return `<video class="att att-vid" src="${url}" controls preload="metadata" playsinline></video>`;
    }
    if (kind === "audio") {
      return `<audio class="att att-aud" src="${url}" controls preload="metadata"></audio>`;
    }
    if (isPdf(a)) {
      return `<button class="att att-file att-pdfchip" data-pdf="${esc(a.id)}" title="${label} — view PDF">${icon("pdf")}<span class="att-name">${label}</span><span class="att-size">${esc(fmtSize(a.size))}</span></button>`;
    }
    if (isDocx(a)) {
      return `<button class="att att-file att-docxchip" data-docx="${esc(a.id)}" title="${label} — view document">${icon("docx")}<span class="att-name">${label}</span><span class="att-size">${esc(fmtSize(a.size))}</span></button>`;
    }
    return `<a class="att att-file" href="${url}" target="_blank" rel="noopener" title="${label} — ${esc(fmtSize(a.size))}">${icon(attIconName(kind))}<span class="att-name">${label}</span><span class="att-size">${esc(fmtSize(a.size))}</span></a>`;
  }).join("")}</div>`;
}

/** Open the preview lightbox over a file list at the given index. */
function openLightbox(files, index) {
  if (!files || !files.length) return;
  state.lightbox = { files, index: Math.max(0, Math.min(index, files.length - 1)) };
  renderLightbox();
}

function closeLightbox() {
  state.lightbox = null;
  const lb = $("#lightbox");
  if (lb) lb.remove();
}

/** Open the in-app PDF viewer: the browser's native PDF renderer (zoom,
    search, page navigation) inside a full-screen modal. Server sends
    attachments with Content-Disposition: inline, so the PDF renders in
    place instead of downloading. */
function openPdfViewer(file) {
  if (!file) return;
  state.pdfViewer = file;
  renderPdfViewer();
}

function closePdfViewer() {
  state.pdfViewer = null;
  const pv = $("#pdfview");
  if (pv) pv.remove();
}

function renderPdfViewer() {
  const old = $("#pdfview");
  if (old) old.remove();
  const f = state.pdfViewer;
  if (!f) return;
  const url = attachUrl(f.id);
  const label = f.filename || "file";
  const wrap = document.createElement("div");
  wrap.id = "pdfview";
  wrap.innerHTML = `
    <div class="pdfv-scrim" id="pdfv-scrim"></div>
    <div class="pdfv-box" role="dialog" aria-modal="true" aria-label="PDF viewer: ${esc(label)}">
      <div class="pdfv-head">
        <span class="pdfv-ic">${icon("pdf")}</span>
        <div class="pdfv-meta">
          <div class="pdfv-name">${esc(label)}</div>
          <div class="pdfv-sub">${esc(fmtSize(f.size))}${f.sent_at ? " · " + esc(fmtTime(f.sent_at)) : ""}</div>
        </div>
        <a class="pdfv-dl" href="${url}" target="_blank" rel="noopener" download="${esc(label)}">${icon("tray")}<span>Download</span></a>
        <button class="pdfv-close" id="pdfv-close" aria-label="Close PDF viewer">${icon("close")}</button>
      </div>
      <div class="pdfv-stage"><iframe class="pdfv-doc" src="${url}" title="${esc(label)}"></iframe></div>
    </div>`;
  document.body.appendChild(wrap);
  $("#pdfv-close").addEventListener("click", closePdfViewer);
  $("#pdfv-scrim").addEventListener("click", closePdfViewer);
}

/* ---------------- DOCX viewer ----------------
   Zero-dependency .docx rendering: a .docx is a ZIP of XML parts. We parse
   the ZIP central directory, inflate entries with DecompressionStream, walk
   word/document.xml with a tiny XML parser, and emit clean HTML (headings,
   bold/italic/underline, lists, tables, hyperlinks, embedded images). */

/** Strip XML prologues and comments — noise for the tiny parser below. */
function cleanXml(src) {
  return src.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
}

/** Tiny XML parser: enough for OOXML's regular subset. Returns a tree of
    { t: tag, a: attrs, c: children }; text nodes are plain strings. */
function parseXml(src) {
  const root = { t: "", a: {}, c: [] };
  const stack = [root];
  const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const unesc = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (x, e) => {
    if (ent[e] !== undefined) return ent[e];
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : x;
    }
    return x;
  });
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^<>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) {
      const text = unesc(m[5]);
      if (text) stack[stack.length - 1].c.push(text);
      continue;
    }
    if (m[1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const are = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = are.exec(m[3]))) attrs[am[1]] = unesc(am[2] !== undefined ? am[2] : am[3]);
    const node = { t: m[2], a: attrs, c: [] };
    stack[stack.length - 1].c.push(node);
    if (m[4] !== "/") stack.push(node);
  }
  return root;
}

/** Local tag name without its namespace prefix. */
function dxln(t) { const i = t.indexOf(":"); return i < 0 ? t : t.slice(i + 1); }
function dxKids(n, name) { return n.c.filter((x) => typeof x !== "string" && dxln(x.t) === name); }
function dxKid(n, name) { const k = dxKids(n, name); return k.length ? k[0] : null; }
function dxFind(n, name) {
  if (typeof n === "string") return null;
  if (dxln(n.t) === name) return n;
  for (const c of n.c) { const f = dxFind(c, name); if (f) return f; }
  return null;
}
/** Resolve a relationship target (relative to word/) to a ZIP part path. */
function dxResolve(base, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const out = [];
  for (const p of (base + target).split("/")) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

/** Minimal ZIP reader for .docx: parse the central directory, inflate
    entries on demand. Only stored (0) and deflated (8) entries. */
async function unzipDocx(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lh = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    if (!name || name.endsWith("/")) continue;
    if (lh + 30 > n) continue;
    const lnl = dv.getUint16(lh + 26, true), lel = dv.getUint16(lh + 28, true);
    const start = lh + 30 + lnl + lel;
    files[name] = { method, data: bytes.subarray(start, start + csize) };
  }
  if (!Object.keys(files).length) throw new Error("empty zip archive");
  return {
    names: Object.keys(files),
    async read(name) {
      const e = files[name];
      if (!e) return null;
      if (e.method === 0) return e.data;
      if (e.method === 8 && typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("deflate-raw");
        const out = await new Response(new Blob([e.data]).stream().pipeThrough(ds)).arrayBuffer();
        return new Uint8Array(out);
      }
      throw new Error("unsupported compression in " + name);
    },
  };
}

const DX_HIGHLIGHT = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000" };
const DX_OL_TYPE = { decimal: "1", lowerLetter: "a", upperLetter: "A", lowerRoman: "i", upperRoman: "I" };

/** Inline CSS for a run from its w:rPr. */
function dxRunStyle(rPr) {
  if (!rPr) return "";
  const onoff = (v) => v === undefined || !/^(0|false|off|none)$/i.test(v);
  const has = (n) => { const k = dxKid(rPr, n); return k ? onoff(k.a["w:val"]) : false; };
  const s = [], deco = [];
  if (has("b")) s.push("font-weight:700");
  if (has("i")) s.push("font-style:italic");
  const u = dxKid(rPr, "u");
  if (u && onoff(u.a["w:val"])) deco.push("underline");
  if (has("strike") || has("dstrike")) deco.push("line-through");
  if (deco.length) s.push("text-decoration:" + deco.join(" "));
  const sz = dxKid(rPr, "sz");
  if (sz && sz.a["w:val"] && parseFloat(sz.a["w:val"]) > 0) s.push("font-size:" + (parseFloat(sz.a["w:val"]) / 2) + "pt");
  const color = dxKid(rPr, "color");
  if (color && color.a["w:val"] && !/^auto$/i.test(color.a["w:val"])) s.push("color:#" + color.a["w:val"]);
  const hl = dxKid(rPr, "highlight");
  if (hl && DX_HIGHLIGHT[hl.a["w:val"]]) s.push("background-color:" + DX_HIGHLIGHT[hl.a["w:val"]]);
  const shd = dxKid(rPr, "shd");
  if (shd && shd.a["w:fill"] && !/^(auto|ffffff)$/i.test(shd.a["w:fill"])) s.push("background-color:#" + shd.a["w:fill"]);
  if (has("smallCaps")) s.push("font-variant:small-caps");
  if (has("caps")) s.push("text-transform:uppercase");
  const va = dxKid(rPr, "vertAlign");
  if (va && /^(superscript|subscript)$/i.test(va.a["w:val"] || "")) s.push("vertical-align:" + va.a["w:val"].toLowerCase());
  return s.join(";");
}

/** <img> for a w:drawing / w:pict: resolve r:embed through rels to word/media. */
function dxImage(node, ctx) {
  const blip = dxFind(node, "blip");
  const idata = dxFind(node, "imagedata");
  const rid = (blip && (blip.a["r:embed"] || blip.a["r:link"])) || (idata && idata.a["r:id"]);
  if (!rid) return "";
  const target = ctx.rels[rid];
  if (!target) return "";
  const url = ctx.media[dxResolve("word/", target)];
  if (!url) return "";
  // Alt text lives on pic:cNvPr (DrawingML) or v:shape (VML fallback).
  const cNvPr = dxFind(node, "cNvPr");
  const shape = dxFind(node, "shape");
  const alt = cNvPr ? cNvPr.a.descr || cNvPr.a.name || "" : shape ? shape.a.alt || shape.a.title || "" : "";
  return `<img class="dx-img" src="${esc(url)}" alt="${esc(alt)}">`;
}

/** Inline HTML for a run's content: text, tabs, breaks, symbols, drawings. */
function dxInline(r, ctx) {
  let out = "";
  for (const c of r.c) {
    if (typeof c === "string") { out += esc(c); continue; }
    const t = dxln(c.t);
    if (t === "t") out += esc(c.c.filter((x) => typeof x === "string").join(""));
    else if (t === "tab") out += "\t";
    else if (t === "br" || t === "cr") out += "<br>";
    else if (t === "noBreakHyphen") out += "&#8209;";
    else if (t === "sym" && c.a["w:char"]) {
      const cp = parseInt(c.a["w:char"], 16);
      if (cp) out += esc(String.fromCodePoint(cp));
    }
    else if (t === "drawing" || t === "pict") out += dxImage(c, ctx);
    else if (t === "AlternateContent") {
      const d = dxFind(c, "drawing") || dxFind(c, "pict");
      if (d) out += dxImage(d, ctx);
    }
  }
  return out;
}

function dxRun(r, ctx) {
  const inner = dxInline(r, ctx);
  if (!inner) return "";
  const style = dxRunStyle(dxKid(r, "rPr"));
  return style ? `<span style="${esc(style)}">${inner}</span>` : inner;
}

function dxHyperlink(node, ctx) {
  let inner = "";
  for (const c of node.c) {
    if (typeof c === "string") continue;
    const t = dxln(c.t);
    if (t === "r") inner += dxRun(c, ctx);
  }
  const target = node.a["r:id"] && ctx.rels[node.a["r:id"]];
  if (target && /^(https?:|mailto:)/i.test(target)) {
    return `<a href="${esc(target)}" target="_blank" rel="noopener">${inner}</a>`;
  }
  return inner;
}

/** One w:p → block descriptor { tag, style, list, html }. */
function dxParagraph(p, ctx) {
  const pPr = dxKid(p, "pPr");
  let tag = "p";
  const styles = [];
  let list = null;
  if (pPr) {
    const ps = dxKid(pPr, "pStyle");
    const sn = ps ? (ps.a["w:val"] || "").toLowerCase().replace(/[\s_-]+/g, "") : "";
    if (sn === "title" || sn === "heading1") tag = "h1";
    else if (sn === "heading2") tag = "h2";
    else if (/^heading[3-9]$/.test(sn)) tag = "h3";
    const jc = dxKid(pPr, "jc");
    const jv = jc ? (jc.a["w:val"] || "").toLowerCase() : "";
    if (jv === "center" || jv === "right") styles.push("text-align:" + jv);
    else if (jv === "end") styles.push("text-align:right");
    else if (jv === "both" || jv === "justify") styles.push("text-align:justify");
    const numPr = dxKid(pPr, "numPr");
    if (numPr) {
      const numId = dxKid(numPr, "numId"), ilvl = dxKid(numPr, "ilvl");
      if (numId && numId.a["w:val"] !== undefined) {
        list = { numId: numId.a["w:val"], ilvl: ilvl && ilvl.a["w:val"] ? parseInt(ilvl.a["w:val"], 10) || 0 : 0 };
      }
    }
    const ind = dxKid(pPr, "ind");
    if (ind && ind.a["w:left"]) {
      const px = Math.round(parseFloat(ind.a["w:left"]) * 96 / 1440);
      if (px > 0) styles.push("margin-left:" + px + "px");
    }
    const shd = dxKid(pPr, "shd");
    if (shd && shd.a["w:fill"] && !/^(auto|ffffff)$/i.test(shd.a["w:fill"])) styles.push("background-color:#" + shd.a["w:fill"]);
  }
  let inner = "";
  for (const c of p.c) {
    if (typeof c === "string") continue;
    const t = dxln(c.t);
    if (t === "r") inner += dxRun(c, ctx);
    else if (t === "hyperlink") inner += dxHyperlink(c, ctx);
  }
  return { tag, style: styles.join(";"), list, html: inner };
}

function dxBlockHtml(b) {
  return `<${b.tag}${b.style ? ` style="${esc(b.style)}"` : ""}>${b.html || ""}</${b.tag}>`;
}

/** word/numbering.xml → { nums: numId -> abstractNumId, abstracts: id -> { ilvl -> numFmt } }. */
function dxParseNumbering(xmlText) {
  const nums = {}, abstracts = {};
  if (!xmlText) return { nums, abstracts };
  const numbering = dxFind(parseXml(cleanXml(xmlText)), "numbering");
  if (!numbering) return { nums, abstracts };
  for (const ab of dxKids(numbering, "abstractNum")) {
    const id = ab.a["w:abstractNumId"];
    if (id === undefined) continue;
    const levels = {};
    for (const lvl of dxKids(ab, "lvl")) {
      const nf = dxKid(lvl, "numFmt");
      levels[lvl.a["w:ilvl"] || "0"] = (nf && nf.a["w:val"]) || "bullet";
    }
    abstracts[id] = levels;
  }
  for (const nm of dxKids(numbering, "num")) {
    const ref = dxKid(nm, "abstractNumId");
    if (nm.a["w:numId"] !== undefined && ref) nums[nm.a["w:numId"]] = ref.a["w:val"];
  }
  return { nums, abstracts };
}

function dxNumFmt(ctx, numId, ilvl) {
  const abs = ctx.numbering.nums[numId];
  const lvl = abs !== undefined && ctx.numbering.abstracts[abs] ? ctx.numbering.abstracts[abs][String(ilvl)] : undefined;
  return lvl || "bullet";
}

/** Consecutive same-list paragraphs → nested <ul>/<ol> by indent level. */
function dxList(items, ctx) {
  const root = { ilvl: -1, children: [] };
  const stack = [root];
  for (const it of items) {
    const lvl = it.list.ilvl || 0;
    while (stack.length > 1 && stack[stack.length - 1].ilvl >= lvl) stack.pop();
    const node = { ilvl: lvl, html: it.html, fmt: dxNumFmt(ctx, it.list.numId, lvl), children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  const render = (nodes) => {
    let out = "", k = 0;
    while (k < nodes.length) {
      const fmt = nodes[k].fmt, grp = [];
      while (k < nodes.length && nodes[k].fmt === fmt) grp.push(nodes[k++]);
      const ordered = fmt !== "bullet";
      const typeAttr = ordered && DX_OL_TYPE[fmt] ? ` type="${DX_OL_TYPE[fmt]}"` : "";
      out += ordered ? `<ol${typeAttr}>` : "<ul>";
      for (const n of grp) out += `<li>${n.html}${n.children.length ? render(n.children) : ""}</li>`;
      out += ordered ? "</ol>" : "</ul>";
    }
    return out;
  };
  return render(root.children);
}

function dxCellStyle(tcPr) {
  if (!tcPr) return "";
  const shd = dxKid(tcPr, "shd");
  if (shd && shd.a["w:fill"] && !/^(auto|ffffff)$/i.test(shd.a["w:fill"])) return "background-color:#" + shd.a["w:fill"];
  return "";
}

function dxCellHtml(c) {
  return `<td${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""}${c.style ? ` style="${esc(c.style)}"` : ""}>${c.html || "&nbsp;"}</td>`;
}

function dxCellInner(tc, ctx) {
  const parts = [];
  for (const c of tc.c) {
    if (typeof c === "string") continue;
    const t = dxln(c.t);
    if (t === "p") parts.push(dxBlockHtml(dxParagraph(c, ctx)));
    else if (t === "tbl") parts.push(dxTable(c, ctx));
  }
  return parts.join("");
}

/** w:tbl → HTML table; gridSpan → colspan, vMerge → rowspan. */
function dxTable(tbl, ctx) {
  const active = []; // visual column -> cell object with an open vertical merge
  const rowsOut = [];
  for (const tr of dxKids(tbl, "tr")) {
    let col = 0;
    const rowCells = [];
    for (const tc of dxKids(tr, "tc")) {
      const tcPr = dxKid(tc, "tcPr");
      const gs = tcPr && dxKid(tcPr, "gridSpan");
      const colspan = gs ? Math.max(1, parseInt(gs.a["w:val"] || "1", 10) || 1) : 1;
      const vmN = tcPr && dxKid(tcPr, "vMerge");
      const vm = vmN ? (vmN.a["w:val"] || "continue") : null;
      if (vm === "continue" && active[col]) {
        active[col].rowspan++;
        for (let k = 0; k < colspan; k++) active[col + k] = active[col];
      } else {
        const cell = { html: dxCellInner(tc, ctx), colspan, rowspan: 1, style: dxCellStyle(tcPr) };
        rowCells.push(cell);
        for (let k = 0; k < colspan; k++) active[col + k] = vm === "restart" ? cell : null;
      }
      col += colspan;
    }
    active.length = col;
    rowsOut.push(rowCells);
  }
  return `<table><tbody>${rowsOut.map((rc) => `<tr>${rc.map(dxCellHtml).join("")}</tr>`).join("")}</tbody></table>`;
}

/** Render a .docx ArrayBuffer → { html, blobUrls }. Throws on bad input. */
async function renderDocx(buf) {
  const zip = await unzipDocx(buf);
  const dec = new TextDecoder();
  const readText = async (name) => { const b = await zip.read(name); return b ? dec.decode(b) : null; };
  const docText = await readText("word/document.xml");
  if (!docText) throw new Error("missing word/document.xml");
  const document = dxFind(parseXml(cleanXml(docText)), "document");
  const body = document && dxKid(document, "body");
  if (!body) throw new Error("no readable document body");

  const rels = {};
  const relsText = await readText("word/_rels/document.xml.rels");
  if (relsText) {
    const walk = (n) => {
      if (typeof n === "string") return;
      if (dxln(n.t) === "Relationship" && n.a.Id) rels[n.a.Id] = n.a.Target || "";
      n.c.forEach(walk);
    };
    walk(parseXml(cleanXml(relsText)));
  }

  // Embedded raster images → blob URLs (SVG skipped: script risk; EMF/WMF won't render).
  const media = {}, blobUrls = [];
  const mimeFor = (name) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[(name.split(".").pop() || "").toLowerCase()] || "");
  for (const name of zip.names) {
    if (!/^word\/media\//i.test(name)) continue;
    const mt = mimeFor(name);
    if (!mt) continue;
    const bytes = await zip.read(name);
    if (!bytes) continue;
    const url = URL.createObjectURL(new Blob([bytes], { type: mt }));
    media[name] = url;
    blobUrls.push(url);
  }

  const ctx = { rels, media, numbering: dxParseNumbering(await readText("word/numbering.xml")) };
  const blocks = [];
  for (const c of body.c) {
    if (typeof c === "string") continue;
    const t = dxln(c.t);
    if (t === "p") blocks.push(dxParagraph(c, ctx));
    else if (t === "tbl") blocks.push({ table: dxTable(c, ctx) });
  }
  let html = "", i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.list) {
      const grp = [], numId = b.list.numId;
      while (i < blocks.length && blocks[i].list && blocks[i].list.numId === numId) grp.push(blocks[i++]);
      html += dxList(grp, ctx);
    } else if (b.table) { html += b.table; i++; }
    else { html += dxBlockHtml(b); i++; }
  }
  return { html, blobUrls };
}

/** Open the in-app DOCX viewer: fetch the attachment, render it with the
    zero-dependency parser above, and show it in a modal. */
function openDocxViewer(file) {
  if (!file) return;
  closeDocxViewer();
  const v = { file, status: "loading", html: "", error: "", blobs: [] };
  state.docxViewer = v;
  renderDocxViewer();
  loadDocxViewer(v);
}

async function loadDocxViewer(v) {
  try {
    const res = await fetch(attachUrl(v.file.id));
    if (!res.ok) throw new Error("download failed (" + res.status + ")");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 25 * 1024 * 1024) throw new Error("file too large to preview");
    const { html, blobUrls } = await renderDocx(buf);
    if (state.docxViewer !== v) { blobUrls.forEach((u) => URL.revokeObjectURL(u)); return; }
    v.blobs = blobUrls;
    v.status = "done";
    v.html = html || '<p class="dx-empty-doc">This document has no readable text.</p>';
  } catch (err) {
    if (state.docxViewer !== v) return;
    v.status = "error";
    v.error = (err && err.message) || "could not open this document";
  }
  renderDocxViewer();
}

function closeDocxViewer() {
  const v = state.docxViewer;
  state.docxViewer = null;
  if (v && v.blobs) v.blobs.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* noop */ } });
  const el = $("#docxview");
  if (el) el.remove();
}

function renderDocxViewer() {
  const old = $("#docxview");
  if (old) old.remove();
  const v = state.docxViewer;
  if (!v) return;
  const f = v.file;
  const url = attachUrl(f.id);
  const label = f.filename || "file";
  let stage;
  if (v.status === "loading") {
    stage = `<div class="dxv-loading"><span class="dxv-spin" aria-hidden="true"></span><p>Opening document&hellip;</p></div>`;
  } else if (v.status === "error") {
    stage = `<div class="dxv-error">${icon("warn", "big")}<p>Couldn&rsquo;t open this document.</p><p class="dxv-errmsg">${esc(v.error)}</p><a class="dxv-dlbtn" href="${url}" target="_blank" rel="noopener" download="${esc(label)}">${icon("tray")}<span>Download instead</span></a></div>`;
  } else {
    stage = `<div class="dxv-doc">${v.html}</div>`;
  }
  const wrap = document.createElement("div");
  wrap.id = "docxview";
  wrap.innerHTML = `
    <div class="dxv-scrim" id="dxv-scrim"></div>
    <div class="dxv-box" role="dialog" aria-modal="true" aria-label="Document viewer: ${esc(label)}">
      <div class="dxv-head">
        <span class="dxv-ic">${icon("docx")}</span>
        <div class="dxv-meta">
          <div class="dxv-name">${esc(label)}</div>
          <div class="dxv-sub">${esc(fmtSize(f.size))}${f.sent_at ? " · " + esc(fmtTime(f.sent_at)) : ""}</div>
        </div>
        <a class="dxv-dl" href="${url}" target="_blank" rel="noopener" download="${esc(label)}">${icon("tray")}<span>Download</span></a>
        <button class="dxv-close" id="dxv-close" aria-label="Close document viewer">${icon("close")}</button>
      </div>
      <div class="dxv-stage">${stage}</div>
    </div>`;
  document.body.appendChild(wrap);
  $("#dxv-close").addEventListener("click", closeDocxViewer);
  $("#dxv-scrim").addEventListener("click", closeDocxViewer);
}

function renderLightbox() {
  const lb0 = $("#lightbox");
  if (lb0) lb0.remove();
  const L = state.lightbox;
  if (!L) return;
  const f = L.files[L.index];
  const kind = attKind(f.mime);
  const url = attachUrl(f.id);
  let stage = "";
  if (kind === "image") {
    stage = `<img class="lb-img" src="${url}" alt="${esc(f.filename || "file")}">`;
  } else if (kind === "video") {
    stage = `<video class="lb-vid" src="${url}" controls preload="metadata" playsinline></video>`;
  } else if (kind === "audio") {
    stage = `<div class="lb-audio-wrap">${icon("audio", "big")}<audio class="lb-aud" src="${url}" controls preload="metadata"></audio></div>`;
  } else {
    stage = `<div class="lb-doc">${icon(attIconName(kind), "big")}<div class="lb-doc-name">${esc(f.filename || "file")}</div><div class="lb-doc-size">${esc(fmtSize(f.size))}</div></div>`;
  }
  const wrap = document.createElement("div");
  wrap.id = "lightbox";
  wrap.innerHTML = `
    <div class="lb-scrim" id="lb-scrim"></div>
    <div class="lb-box" role="dialog" aria-modal="true" aria-label="${esc(f.filename || "file")}">
      <button class="lb-close" id="lb-close" aria-label="Close preview">${icon("close")}</button>
      ${L.files.length > 1 ? `<button class="lb-nav lb-prev" id="lb-prev" aria-label="Previous file">${icon("chevL")}</button>
      <button class="lb-nav lb-next" id="lb-next" aria-label="Next file">${icon("chevR")}</button>` : ""}
      <div class="lb-stage">${stage}</div>
      <div class="lb-cap">
        <div class="lb-cap-name">${esc(f.filename || "file")}</div>
        <div class="lb-cap-meta">${esc(fmtSize(f.size))}${f.sent_at ? " · " + esc(fmtTime(f.sent_at)) : ""}</div>
        <a class="lb-dl" href="${url}" target="_blank" rel="noopener" download="${esc(f.filename || "file")}">${icon("tray")}Download</a>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  $("#lb-close").addEventListener("click", closeLightbox);
  $("#lb-scrim").addEventListener("click", closeLightbox);
  const prev = $("#lb-prev"), next = $("#lb-next");
  if (prev) prev.addEventListener("click", (e) => { e.stopPropagation(); state.lightbox.index = (L.index - 1 + L.files.length) % L.files.length; renderLightbox(); });
  if (next) next.addEventListener("click", (e) => { e.stopPropagation(); state.lightbox.index = (L.index + 1) % L.files.length; renderLightbox(); });
}

document.addEventListener("keydown", (e) => {
  if (state.pdfViewer) {
    if (e.key === "Escape") closePdfViewer();
    return;
  }
  if (state.docxViewer) {
    if (e.key === "Escape") closeDocxViewer();
    return;
  }
  const L = state.lightbox;
  if (!L) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft" && L.files.length > 1) { state.lightbox.index = (L.index - 1 + L.files.length) % L.files.length; renderLightbox(); }
  else if (e.key === "ArrowRight" && L.files.length > 1) { state.lightbox.index = (L.index + 1) % L.files.length; renderLightbox(); }
});

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return hm;
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

// ---------- shell ----------

function tabBar(active) {
  const unread = state.conversations.reduce((n, c) => n + (c.unread || 0), 0);
  const tabs = [
    { id: "conversations", ic: "convo", label: "Conversations", badge: unread },
    { id: "people", ic: "people", label: "People", badge: 0 },
    { id: "settings", ic: "sliders", label: "Settings", badge: 0 },
  ];
  return `<nav class="tab-bar">${tabs.map((t) =>
    `<button class="tab${active === t.id ? " active" : ""}" data-tab="${t.id}">
      ${icon(t.ic)}<span>${t.label}</span>
      ${t.badge ? `<span class="badge">${t.badge}</span>` : ""}
    </button>`).join("")}</nav>`;
}

function bindTabs(root) {
  $$(".tab", root).forEach((b) => b.addEventListener("click", () => { location.hash = "#/" + b.dataset.tab; }));
}

// ---------- conversation list ----------

async function loadConversations() {
  const r = await api("/api/conversations");
  state.conversations = r.conversations || [];
}

// ---------- message notifications ----------

function notifyPerm() {
  return ("Notification" in window) ? Notification.permission : "unsupported";
}

/** Poll the conversation list, fire desktop notifications for new inbound
    messages, and refresh the tab title badge. Never notifies for history:
    every conversation's latest message is seeded as seen on first sight. */
async function pollConversations() {
  const prev = new Map((state.conversations || []).map((c) => [c.id, c.last_at || ""]));
  try { await loadConversations(); } catch { return; }
  checkNotifications(prev);
  updateTitle();
}

function checkNotifications(prev) {
  const seen = (id) => { try { return localStorage.getItem("relay_seen_" + id); } catch { return null; } };
  const mark = (id, at) => { try { localStorage.setItem("relay_seen_" + id, at); } catch { /* noop */ } };
  const fresh = (at) => { const t = Date.parse(at); return Number.isFinite(t) && (Date.now() - t) < 10 * 60 * 1000; };
  const openId = state.conv && state.conv.id;
  const visible = typeof document !== "undefined" && document.visibilityState === "visible";
  for (const c of state.conversations || []) {
    const at = c.last_at || "";
    const inbound = c.last_direction === "in" && at;
    const known = seen(c.id);
    let isNew = false;
    if (prev.get(c.id) !== undefined && known !== null) {
      isNew = inbound && at !== known;
    } else if (inbound && fresh(at)) {
      // Never seen this conversation (first run, or a brand-new thread) and
      // the message just arrived — worth a notification, not silent seeding.
      isNew = true;
    }
    if (at) mark(c.id, at);
    if (!isNew) continue;
    if (!state.notify || notifyPerm() !== "granted") continue;
    if (visible && openId === c.id) continue; // user is reading it right now
    fireNotification(c);
  }
}

function fireNotification(c) {
  let body = String(c.last_body || "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!body) body = "New message";
  try {
    const n = new Notification(c.title || "Relay", { body, tag: "relay-" + c.id });
    n.onclick = () => { try { window.focus(); } catch { /* noop */ } location.hash = "#/conversations/" + c.id; n.close(); };
  } catch { /* notifications unavailable */ }
}

function updateTitle() {
  const n = (state.conversations || []).reduce((a, c) => a + (c.unread || 0), 0);
  document.title = n > 0 ? `(${n}) Relay` : "Relay";
}

function notifyHint() {
  const p = notifyPerm();
  if (p === "granted") return state.notify ? "On — you'll get a desktop notification for new messages." : "Off — turn on to get desktop notifications.";
  if (p === "denied") return "Blocked — allow notifications for this site in your browser settings, then toggle again.";
  if (p === "unsupported") return "This browser doesn't support desktop notifications.";
  return "Turn on, then allow notifications when your browser asks.";
}

async function setNotify(on) {
  state.notify = on;
  try { localStorage.setItem("relay_notify", on ? "1" : "0"); } catch { /* noop */ }
  if (on && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* noop */ }
  }
  renderSettings();
}

function renderConversations(skipIfSame) {
  const q = state.search.toLowerCase();
  const list = state.conversations.filter((c) =>
    !q || c.title.toLowerCase().includes(q) || (c.members || []).some((m) => m.name.toLowerCase().includes(q)));
  // The 15s timer re-renders this view; skip the rewrite (and its entrance
  // animation) when nothing on screen would change.
  const sig = q + "|" + list.map((c) => [c.id, c.last_at, c.unread, c.last_body, c.title].join("~")).join("|");
  if (skipIfSame && sig === state.convListSig) return;
  state.convListSig = sig;
  const app = $("#app");
  app.innerHTML = `
    <div class="view">
      <div class="nav-bar"><div class="nav-title">Conversations</div>
        <button class="nav-action" id="new-group">${icon("plus")}Group</button></div>
      <div class="search-wrap"><div class="search-field">${icon("search")}<input id="q" placeholder="Search conversations" value="${esc(state.search)}"></div></div>
      <div class="scroll">
        ${list.length ? list.map((c) => `
          <button class="conv-row" data-id="${c.id}">
            ${avatarHtml(c.title, c.avatar_color, 48, c.is_group, c.is_group ? null : c.members[0]?.avatar_url)}
            <div class="meta">
              <div class="top"><span class="name">${esc(c.title)}</span><span class="time">${fmtTime(c.last_at)}</span></div>
              <div class="preview">
                ${c.last_channel ? chanPill(c.last_channel) : ""}
                <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.last_body || (c.is_group ? `${c.member_count + 1} people` : "Say hello 👋"))}</span>
              </div>
            </div>
            ${c.unread ? `<span class="unread-dot">${c.unread}</span>` : ""}
          </button>`).join("")
        : `<div class="empty">${icon("burst", "big")}<h3>No conversations yet</h3><p>Your inner circle lives here.<br>Add people in the People tab,<br>then pick a channel and say hello.</p></div>`}
      </div>
      ${tabBar("conversations")}
    </div>`;
  bindTabs(app);
  $("#new-group").addEventListener("click", () => { location.hash = "#/group/new"; });
  const qi = $("#q");
  qi.addEventListener("input", () => { state.search = qi.value; renderConversations(); const nq = $("#q"); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); });
  $$(".conv-row", app).forEach((r) => r.addEventListener("click", () => { location.hash = "#/conversations/" + r.dataset.id; }));
}

// ---------- message view ----------

async function loadConversation(id) {
  const r = await api("/api/conversations/" + encodeURIComponent(id));
  state.conv = r.conversation;
  const m = await api("/api/conversations/" + encodeURIComponent(id) + "/messages?limit=100");
  state.messages = m.messages || [];
  state.replyTo = null;
  state.pendingFiles = [];
  state.panel = null;
  state.seenMsgIds = new Set(); // fresh view: every message animates in once
  state.diary = [];
  state.diaryOffset = 0;
  state.eventForm = false;
  state.eventDraft = null;
  state.pendingEvent = null;
  state.fileSearch = "";
  state.fileResults = null;
  try {
    const f = await api("/api/conversations/" + encodeURIComponent(id) + "/files?limit=30");
    state.files = calFilesOut(f.files || []);
  } catch { state.files = []; }
  try {
    const d = await api("/api/conversations/" + encodeURIComponent(id) + "/appointments");
    state.diary = d.appointments || [];
  } catch { state.diary = []; }
  if (!state.messages.length && state.conv && !state.conv.is_group) {
    // Empty conversation: pre-populate the first message from the last email exchange.
    api("/api/conversations/" + encodeURIComponent(id) + "/seed-email", { method: "POST" })
      .then(async (se) => {
        if (se && se.seeded && state.conv && state.conv.id === id) {
          const m2 = await api("/api/conversations/" + encodeURIComponent(id) + "/messages?limit=100");
          state.messages = m2.messages || [];
          renderConversationDetail();
        }
      })
      .catch(() => {});
  }
  await api("/api/conversations/" + encodeURIComponent(id) + "/read", { method: "POST" }).catch(() => {});
}

function selectedChannel() {
  const conv = state.conv;
  if (!conv || !conv.channels.length) return null;
  const saved = state.chanSel[conv.id] || localStorage.getItem("relay_chan_" + conv.id);
  if (saved && conv.channels.includes(saved)) return saved;
  return conv.channels[0];
}

/** Files currently shown in the widget: search matches, or recent files. */
function activeFiles() { return state.fileResults || state.files; }

/** Invitations (.ics) are appointments, not shared files — keep them out of the widget. */
function calFilesOut(files) {
  return (files || []).filter((f) => f.mime !== "text/calendar" && !/\.ics$/i.test(f.filename || ""));
}

/** Refresh the widget list, honoring an active search. */
async function refreshFiles() {
  if (!state.conv) return;
  try {
    if (state.fileSearch) {
      const f = await api("/api/conversations/" + encodeURIComponent(state.conv.id) + "/files?limit=30&days=90&q=" + encodeURIComponent(state.fileSearch));
      state.fileResults = calFilesOut(f.files || []);
    } else {
      const f = await api("/api/conversations/" + encodeURIComponent(state.conv.id) + "/files?limit=30");
      state.files = calFilesOut(f.files || []);
      state.fileResults = null;
    }
  } catch { /* widget keeps its old list */ }
}

/** Refresh the diary's appointments for the open conversation. */
async function refreshDiary() {
  if (!state.conv) return;
  try {
    const d = await api("/api/conversations/" + encodeURIComponent(state.conv.id) + "/appointments");
    state.diary = d.appointments || [];
  } catch { /* diary keeps its old list */ }
}

/** Group image previews into per-message stacks for the widget. Returns display
    entries — {type:"stack", images:[...]} or {type:"file", f} — newest first,
    so a stack sits where its newest image would. */
function groupStackable(files) {
  const entries = [];
  const stacks = new Map();
  for (const f of files) {
    if (attKind(f.mime) === "image" && f.message_id) {
      let s = stacks.get(f.message_id);
      if (!s) { s = { type: "stack", images: [] }; stacks.set(f.message_id, s); entries.push(s); }
      s.images.push(f);
    } else {
      entries.push({ type: "file", f });
    }
  }
  return entries;
}

/** One stack tile: the message's images layered on top of each other. */
function stackTile(images, i) {
  const n = images.length;
  const top = images[0];
  let under = "";
  for (let l = Math.min(n, 3) - 1; l >= 1; l--) under += `<span class="ft-layer l${l}"></span>`;
  const title = n === 1 ? esc(top.filename || "file") : `${n} photos`;
  const name = n === 1 ? esc(top.filename || "file") : `${n} photos`;
  return `<button class="file-tile file-stack" data-fentry="${i}" title="${title}">
    <span class="ft-stack">${under}<span class="ft-prev"><img src="${attachUrl(top.id)}" alt="" loading="lazy"></span>${n > 1 ? `<span class="ft-count">${n}</span>` : ""}</span>
    <span class="ft-name">${name}</span>
    <span class="ft-meta">${esc(fmtSize(top.size))}${top.sent_at ? " · " + esc(fmtTime(top.sent_at)) : ""}</span>
  </button>`;
}

/** Shared-files widget: sidebar on wide screens, slide-over drawer on narrow. */
function filesPanelHtml() {
  const searching = state.fileResults !== null;
  const files = activeFiles();
  const entries = groupStackable(files);
  state.fileEntries = entries;
  const q = state.fileSearch;
  const tiles = entries.map((e, i) => {
    if (e.type === "stack") return stackTile(e.images, i);
    const f = e.f;
    const kind = attKind(f.mime);
    const prev = kind === "image"
      ? `<span class="ft-prev"><img src="${attachUrl(f.id)}" alt="" loading="lazy"></span>`
      : `<span class="ft-prev ft-ic ft-${kind}">${icon(isPdf(f) ? "pdf" : isDocx(f) ? "docx" : attIconName(kind))}</span>`;
    return `<button class="file-tile" data-fentry="${i}" title="${esc(f.filename || "file")}">
      ${prev}
      <span class="ft-name">${esc(f.filename || "file")}</span>
      <span class="ft-meta">${esc(fmtSize(f.size))}${f.sent_at ? " · " + esc(fmtTime(f.sent_at)) : ""}</span>
    </button>`;
  }).join("");
  const body = files.length ? `<div class="fp-grid" id="fp-body">${tiles}</div>`
    : searching ? `<div class="fp-empty" id="fp-body">${icon("files", "big")}<p>No files matching &ldquo;${esc(q)}&rdquo;<br>in the last 90 days.</p></div>`
    : `<div class="fp-empty" id="fp-body">${icon("files", "big")}<p>No files shared yet.<br>Attach one from the Email channel.</p></div>`;
  return `
    <aside class="files-panel" id="files-panel" aria-label="Shared files">
      <div class="fp-head">${icon("files")}<span class="fp-title">Shared files</span>${files.length ? `<span class="fp-count">${files.length}</span>` : ""}<button class="fp-close" id="fp-close" aria-label="Close shared files">${icon("close")}</button></div>
      <div class="fp-search">
        <input id="fp-q" type="search" placeholder="Search files&hellip;" value="${esc(q)}" autocomplete="off" aria-label="Search shared files">
        ${searching ? `<button class="fp-x" id="fp-clear" aria-label="Clear search" title="Clear search">${icon("close")}</button>` : ""}
      </div>
      ${searching ? `<div class="fp-resmeta" id="fp-resmeta">${files.length ? `${files.length} result${files.length === 1 ? "" : "s"}` : "No matches"} for &ldquo;${esc(q)}&rdquo; &middot; last 90 days</div>` : ""}
      ${body}
    </aside>`;
}

/** Re-render just the widget body + meta after a search, keeping input focus. */
function renderFileResults() {
  const panel = $("#files-panel");
  if (!panel || !state.conv || state.panel !== "files") return;
  panel.outerHTML = filesPanelHtml();
  wireFilesPanel();
  const q = $("#fp-q");
  if (q) { q.focus(); const n = q.value.length; try { q.setSelectionRange(n, n); } catch { /* noop */ } }
}

let fileSearchTimer = 0;
async function runFileSearch(q) {
  state.fileSearch = q;
  if (!q) { state.fileResults = null; }
  else {
    try {
      const f = await api("/api/conversations/" + encodeURIComponent(state.conv.id) + "/files?limit=30&days=90&q=" + encodeURIComponent(q));
      // Ignore stale responses if the user kept typing or switched conversations.
      if (state.fileSearch === q && state.conv) state.fileResults = f.files || [];
      else return;
    } catch { state.fileResults = []; }
  }
  renderFileResults();
}

/** Wire the widget's toggle, tiles, and search box. Safe to call after a panel re-render. */
function wireFilesPanel() {
  $$("#files-panel [data-fentry]").forEach((t) => t.addEventListener("click", () => {
    const e = (state.fileEntries || [])[Number(t.dataset.fentry)];
    if (!e) return;
    // A stack opens the lightbox on that message's images; a lone PDF opens
    // the in-app PDF viewer; a lone DOCX opens the document viewer; anything
    // else opens the lightbox on the list.
    if (e.type === "stack") openLightbox(e.images, 0);
    else if (isPdf(e.f)) openPdfViewer(e.f);
    else if (isDocx(e.f)) openDocxViewer(e.f);
    else openLightbox(activeFiles(), Math.max(0, activeFiles().indexOf(e.f)));
  }));
  const qi = $("#fp-q");
  if (qi) {
    qi.addEventListener("input", () => {
      clearTimeout(fileSearchTimer);
      fileSearchTimer = setTimeout(() => runFileSearch(qi.value.trim()), 250);
    });
    qi.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { qi.value = ""; runFileSearch(""); }
      else if (e.key === "Enter") { clearTimeout(fileSearchTimer); runFileSearch(qi.value.trim()); }
    });
    // Native search-field clear (e.g. keyboard gesture) exits search mode too.
    qi.addEventListener("search", () => { if (!qi.value) runFileSearch(""); });
  }
  const clr = $("#fp-clear");
  if (clr) clr.addEventListener("click", () => runFileSearch(""));
}

/** Sunday starting the diary's displayed week (offset from this week). */
function diaryWeekStart() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - d.getDay() + state.diaryOffset * 7);
  return d;
}

/** Appointments starting inside the diary's displayed week. */
function diaryWeekAppts() {
  const start = diaryWeekStart();
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return state.diary.filter((a) => {
    const s = new Date(a.starts_at);
    return s >= start && s < end;
  }).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
}

/** Weekly appointment diary: one side-panel widget per conversation. */
function diaryPanelHtml() {
  const start = diaryWeekStart();
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const dFmt = (d, opts) => d.toLocaleDateString(undefined, opts);
  const label = start.getMonth() === end.getMonth()
    ? `${dFmt(start, { month: "short", day: "numeric" })} – ${end.getDate()}, ${end.getFullYear()}`
    : `${dFmt(start, { month: "short", day: "numeric" })} – ${dFmt(end, { month: "short", day: "numeric", year: "numeric" })}`;
  const todayStr = new Date().toDateString();
  const week = diaryWeekAppts();
  const byDay = new Map();
  for (const a of week) {
    const s = new Date(a.starts_at);
    const key = `${s.getFullYear()}-${s.getMonth()}-${s.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(a);
  }
  const tFmt = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  let days = "";
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    const appts = byDay.get(key) || [];
    const cards = appts.map((a) => {
      const s = new Date(a.starts_at), e = new Date(a.ends_at);
      return `<div class="dp-appt">
        <div class="dp-time">${tFmt(s)} – ${tFmt(e)}</div>
        <div class="dp-title">${esc(a.title)}</div>
        ${a.location ? `<div class="dp-loc">${icon("pin")}<span>${esc(a.location)}</span></div>` : ""}
        ${a.description ? `<div class="dp-desc">${esc(a.description)}</div>` : ""}
        <div class="dp-foot">${apptStatusChip(a.status)}</div>
      </div>`;
    }).join("");
    days += `<div class="dp-day${day.toDateString() === todayStr ? " today" : ""}">
      <div class="dp-dayhead"><span class="dp-dow">${dFmt(day, { weekday: "short" })}</span><span class="dp-dnum">${day.getDate()}</span></div>
      ${appts.length ? `<div class="dp-appts">${cards}</div>` : `<div class="dp-none">&mdash;</div>`}
    </div>`;
  }
  return `
    <aside class="files-panel diary-panel" id="files-panel" aria-label="Appointment diary">
      <div class="fp-head">${icon("calendar")}<span class="fp-title">Diary</span>${week.length ? `<span class="fp-count">${week.length}</span>` : ""}<button class="fp-close" id="fp-close" aria-label="Close diary">${icon("close")}</button></div>
      <div class="dp-weeknav">
        <button class="dp-nav" id="dp-prev" aria-label="Previous week">${icon("chevL")}</button>
        <button class="dp-today" id="dp-today">Today</button>
        <span class="dp-label">${esc(label)}</span>
        <button class="dp-nav" id="dp-next" aria-label="Next week">${icon("chevR")}</button>
      </div>
      <div class="dp-days" id="dp-body">${days}</div>
      <div class="dp-hint">Invitations sent or received here land in this diary.</div>
    </aside>`;
}

/** The side panel shows Shared files or the Diary, never both. */
function sidePanelHtml() {
  return state.panel === "diary" ? diaryPanelHtml() : filesPanelHtml();
}

/** Wire the diary's week navigation. Safe to call after a panel re-render. */
function wireDiaryPanel() {
  const prev = $("#dp-prev"), next = $("#dp-next"), today = $("#dp-today");
  if (prev) prev.addEventListener("click", () => { state.diaryOffset--; renderSidePanel(); });
  if (next) next.addEventListener("click", () => { state.diaryOffset++; renderSidePanel(); });
  if (today) today.addEventListener("click", () => { state.diaryOffset = 0; renderSidePanel(); });
}

/** Swap the side panel's content in place (week navigation, search). */
function renderSidePanel() {
  const panel = $("#files-panel");
  if (!panel || !state.conv) return;
  panel.outerHTML = sidePanelHtml();
  const fpc = $("#fp-close");
  if (fpc) fpc.addEventListener("click", () => { state.panel = null; renderConversationDetail(); });
  wireFilesPanel();
  wireDiaryPanel();
}

/** Accept or decline an invitation from its card: sends a real METHOD:REPLY
    RSVP email to the organizer when one is known. */
async function setApptStatus(id, status) {
  const conv = state.conv;
  if (!conv) return;
  const rsvp = status === "accepted" || status === "declined";
  try {
    const r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/appointments/" + encodeURIComponent(id) +
      (rsvp ? "/rsvp" : "/status"), {
      method: "POST",
      body: JSON.stringify(rsvp ? { response: status } : { status }),
    });
    for (const m of state.messages) {
      if (m.appointment && String(m.appointment.id) === String(id)) m.appointment = r.appointment;
    }
    if (r.message) state.messages.push(r.message);
    await refreshDiary();
    renderConversationDetail();
    if (r.rsvp_error) toast("Saved, but the RSVP email couldn't be sent: " + r.rsvp_error, true);
    else if (rsvp) toast(r.rsvp ? "RSVP sent — invitation " + status + "." : "Invitation " + status + " (no organizer to reply to).");
    else toast(status === "cancelled" ? "Invitation cancelled." : "Invitation updated.");
  } catch (e) {
    toast(e.message || "Couldn't update the invitation.", true);
  }
}

function renderConversationDetail() {
  const conv = state.conv;
  if (!conv) { location.hash = "#/conversations"; return; }
  // Preserve the in-progress draft across re-renders (file picks, refreshes).
  const keepDraft = $("#draft") ? $("#draft").value : "";
  const keepSubj = $("#subject") ? $("#subject").value : "";
  const ch = selectedChannel();
  const memberNames = conv.members.map((m) => m.name).join(", ");
  const app = $("#app");

  let body = "";
  let lastDay = "";
  const seen = state.seenMsgIds || new Set();
  for (const m of state.messages) {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) { body += `<div class="day-divider">${esc(day)}</div>`; lastDay = day; }
    const out = m.direction === "out";
    const canReply = m.channel === "email" && !out && m.message_id;
    // Messages already on screen keep their place quietly; only genuinely
    // new ones replay the pop-in animation.
    const isNew = !seen.has(m.id);
    body += `<div class="msg ${out ? "out" : "in"}${m.status === "failed" ? " failed" : ""}${isNew ? "" : " msg-old"}">
      ${!out && conv.is_group ? `<div class="sender-name">${esc(senderName(m))}</div>` : ""}
      <div class="bubble">${m.subject ? `<div class="subject">${esc(m.subject)}</div>` : ""}<span class="bubble-text">${bubbleText(m)}</span>${bubbleAtts(m)}</div>
      <div class="meta-line">${chanPill(m.channel)}<span>${fmtTime(m.created_at)}</span>${m.status === "failed" ? `<span style="color:var(--red);font-weight:700">· failed to send</span><button class="retry-btn" data-retry="${m.id}" title="Try sending again">${icon("retry")}Retry</button>` : ""}${canReply ? `<button class="reply-btn" data-reply="${m.id}" title="Reply to this email in thread">${icon("reply")}Reply</button>` : ""}</div>
    </div>`;
  }

  const hints = Object.entries(conv.hints || {}).filter(([, v]) => v).map(([, v]) => esc(v));
  const pending = state.pendingFiles;

  app.innerHTML = `
    <div class="view conv-view">
      <div class="conv-layout${state.panel ? " files-open" : ""}">
        <div class="conv-main">
          <div class="nav-bar">
            <button class="nav-back" id="back">${icon("back")}Conversations</button>
            ${avatarHtml(conv.title, conv.is_group ? "#8e8e93" : (conv.members[0]?.color || "#8e8e93"), 48, conv.is_group, conv.is_group ? null : conv.members[0]?.avatar_url)}
            <div style="flex:1;min-width:0">
              <div class="nav-title small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(conv.title)}</div>
              <div style="font-size:12px;color:var(--label-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(memberNames)}${conv.is_group ? " · " + (conv.members.length + 1) + "/8" : ""}</div>
            </div>
            <button class="nav-action diary-toggle${state.panel === "diary" ? " on" : ""}" id="diary-toggle" aria-label="Appointment diary" title="Appointment diary">${icon("calendar")}${diaryWeekAppts().length ? `<span class="ft-badge">${diaryWeekAppts().length}</span>` : ""}</button>
            <button class="nav-action files-toggle${state.panel === "files" ? " on" : ""}" id="files-toggle" aria-label="Shared files" title="Shared files">${icon("files")}${state.files.length ? `<span class="ft-badge">${state.files.length}</span>` : ""}</button>
            ${conv.is_group ? `<button class="nav-action" id="grp-edit">Edit</button>` : ""}
          </div>
          <div class="msg-scroll" id="msgs">${body || `<div class="empty">${icon("send", "big")}<h3>Start the conversation</h3><p>Pick a channel below and send the first message.</p></div>`}</div>
          <div class="chan-bar">
            ${conv.channels.length ? `
              <div class="seg" id="seg">${conv.channels.map((c) =>
                `<button data-ch="${c}" class="${c === ch ? "on" : ""}">${icon(CHAN_META[c].ic)}${CHAN_META[c].label}</button>`).join("")}</div>
              ${hints.length ? `<div class="chan-hint">${hints.join(" ")}</div>` : ""}`
            : `<div class="chan-hint">No channels available yet. ${hints.join(" ") || "Add contact details in the People tab."}</div>`}
          </div>
          <div class="composer">
              ${state.replyTo ? `<div class="reply-bar"><span>${icon("reply")}Replying to <b>${esc(state.replyTo.subject || "(no subject)")}</b> — threads under the original email</span><button id="reply-cancel" title="Cancel reply" aria-label="Cancel reply">${icon("close")}</button></div>` : ""}
            ${state.eventForm ? eventFormHtml() : ""}
            <div class="grow">
              ${pending.length ? `<div class="pending-files" id="pending">${pending.map((f, i) => `
                <span class="pchip">${icon(attIconName(attKind(f.type)))}<span class="pchip-name">${esc(f.name)}</span><span class="pchip-size">${esc(fmtSize(f.size))}</span><button class="pchip-x" data-pchip="${i}" aria-label="Remove ${esc(f.name)}">${icon("close")}</button></span>`).join("")}</div>` : ""}
              <div class="subject-line${ch === "email" && !state.replyTo ? " show" : ""}" id="subj-wrap"><input class="text-input" id="subject" placeholder="Subject"></div>
              <textarea id="draft" rows="1" placeholder="Message ${ch ? CHAN_META[ch].label : ""}…"></textarea>
            </div>
            ${ch === "email" ? `<button class="attach-btn" id="attach" aria-label="Attach files" title="Attach files (25 MB max each)">${icon("paperclip")}</button><input type="file" id="filepick" multiple hidden><button class="cal-btn${state.eventForm ? " on" : ""}" id="calinvite" aria-label="Send calendar invitation" title="Send calendar invitation">${icon("calendar")}</button>` : ""}
            <button class="send-btn" id="send" aria-label="Send" ${ch ? "" : "disabled"}>${icon("send")}</button>
          </div>
        </div>
        ${sidePanelHtml()}
      </div>
    </div>`;

  $("#back").addEventListener("click", () => { location.hash = "#/conversations"; });
  const ge = $("#grp-edit");
  if (ge) ge.addEventListener("click", () => openGroupSheet(conv));

  // Side panel: shared files and the appointment diary.
  $("#files-toggle").addEventListener("click", () => { state.panel = state.panel === "files" ? null : "files"; renderConversationDetail(); });
  $("#diary-toggle").addEventListener("click", () => { state.panel = state.panel === "diary" ? null : "diary"; renderConversationDetail(); });
  const fpc = $("#fp-close");
  if (fpc) fpc.addEventListener("click", () => { state.panel = null; renderConversationDetail(); });
  wireFilesPanel();
  wireDiaryPanel();
  // Invitation cards: accept / decline inbound invites.
  $$("#msgs [data-appt-accept]").forEach((b) => b.addEventListener("click", () => setApptStatus(b.dataset.apptAccept, "accepted")));
  $$("#msgs [data-appt-decline]").forEach((b) => b.addEventListener("click", () => setApptStatus(b.dataset.apptDecline, "declined")));
  $$("#msgs [data-att]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.att;
    const i = activeFiles().findIndex((f) => String(f.id) === String(id));
    if (i >= 0) openLightbox(activeFiles(), i);
    else {
      const m = state.messages.flatMap((x) => x.attachments || []).find((a) => String(a.id) === String(id));
      if (m) openLightbox([{ id: m.id, filename: m.filename, mime: m.mime, size: m.size }], 0);
    }
  }));
  // PDF chips open the in-app PDF viewer instead of the lightbox.
  $$("#msgs [data-pdf]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.pdf;
    const i = activeFiles().findIndex((f) => String(f.id) === String(id));
    if (i >= 0) openPdfViewer(activeFiles()[i]);
    else {
      const m = state.messages.flatMap((x) => x.attachments || []).find((a) => String(a.id) === String(id));
      if (m) openPdfViewer({ id: m.id, filename: m.filename, mime: m.mime, size: m.size });
    }
  }));

  // DOCX chips open the in-app document viewer instead of the lightbox.
  $$("#msgs [data-docx]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.docx;
    const i = activeFiles().findIndex((f) => String(f.id) === String(id));
    if (i >= 0) openDocxViewer(activeFiles()[i]);
    else {
      const m = state.messages.flatMap((x) => x.attachments || []).find((a) => String(a.id) === String(id));
      if (m) openDocxViewer({ id: m.id, filename: m.filename, mime: m.mime, size: m.size });
    }
  }));

  $$("#seg button").forEach((b) => b.addEventListener("click", () => {
    state.chanSel[conv.id] = b.dataset.ch;
    localStorage.setItem("relay_chan_" + conv.id, b.dataset.ch);
    state.replyTo = null; // replies only thread on email
    renderConversationDetail();
    $("#draft").focus();
  }));

  // Calendar invitation (email channel only): inline form in the composer.
  const calBtn = $("#calinvite");
  if (calBtn) calBtn.addEventListener("click", () => {
    state.eventForm = !state.eventForm;
    renderConversationDetail();
    if (state.eventForm) $("#ef-title")?.focus(); else $("#draft")?.focus();
  });
  const efCancel = $("#ef-cancel");
  if (efCancel) efCancel.addEventListener("click", () => {
    state.eventForm = false; state.eventDraft = null;
    renderConversationDetail();
    $("#draft")?.focus();
  });
  // Keep the invitation draft across re-renders.
  for (const [fid, key] of [["ef-title", "title"], ["ef-start", "start"], ["ef-end", "end"], ["ef-loc", "loc"], ["ef-desc", "desc"]]) {
    const el = document.getElementById(fid);
    if (el) el.addEventListener("input", () => {
      state.eventDraft = { ...(state.eventDraft || {}), [key]: el.value };
    });
  }
  const efSend = $("#ef-send");
  if (efSend) efSend.addEventListener("click", sendInvite);

  // Attachments (email channel only).
  const attachBtn = $("#attach");
  const filepick = $("#filepick");
  if (attachBtn && filepick) {
    attachBtn.addEventListener("click", () => filepick.click());
    filepick.addEventListener("change", () => {
      const picked = Array.from(filepick.files || []);
      for (const f of picked) {
        if (state.pendingFiles.length >= 10) { toast("At most 10 files per message.", true); break; }
        if (f.size > 25 * 1024 * 1024) { toast(`"${f.name}" is too big — 25 MB max per file.`, true); continue; }
        state.pendingFiles.push(f);
      }
      filepick.value = "";
      renderConversationDetail();
      $("#draft").focus();
    });
  }
  $$("#pending [data-pchip]").forEach((b) => b.addEventListener("click", () => {
    state.pendingFiles.splice(Number(b.dataset.pchip), 1);
    renderConversationDetail();
    $("#draft").focus();
  }));

  const draft = $("#draft");
  draft.addEventListener("input", () => { draft.style.height = "auto"; draft.style.height = Math.min(draft.scrollHeight, 120) + "px"; });
  draft.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

  $("#send").addEventListener("click", sendMsg);

  $$("#msgs [data-reply]").forEach((b) => b.addEventListener("click", () => {
    const target = state.messages.find((m) => m.id === b.dataset.reply);
    if (target) { state.replyTo = target; renderConversationDetail(); $("#draft")?.focus(); }
  }));
  $$("#msgs [data-retry]").forEach((b) => b.addEventListener("click", () => retryMsg(b.dataset.retry)));
  const rc = $("#reply-cancel");
  if (rc) rc.addEventListener("click", () => { state.replyTo = null; renderConversationDetail(); });

  // Restore the in-progress draft (unless the send just cleared it).
  if (!state.dropDraft) {
    if (keepDraft) { draft.value = keepDraft; draft.style.height = "auto"; draft.style.height = Math.min(draft.scrollHeight, 120) + "px"; }
    if (keepSubj && $("#subject")) $("#subject").value = keepSubj;
  }
  state.dropDraft = false;

  const sc = $("#msgs");
  sc.scrollTop = sc.scrollHeight;
  // Everything now on screen counts as seen, so only future messages animate.
  if (!state.seenMsgIds) state.seenMsgIds = new Set();
  for (const m of state.messages) state.seenMsgIds.add(m.id);
}
function senderName(m) {
  // Best-effort: match inbound message to a member via external hints is unreliable;
  // show the conversation title for DMs, generic for groups handled by caller.
  return "";
}

/** Inline calendar-invitation form inside the composer (email channel only). */
function eventFormHtml() {
  const d = state.eventDraft || {};
  return `<div class="event-form" id="event-form">
    <div class="ef-title">${icon("calendar")}<span>Calendar invitation</span><button class="ef-x" id="ef-cancel" aria-label="Cancel invitation" title="Cancel invitation">${icon("close")}</button></div>
    <input class="text-input" id="ef-title" placeholder="Event title" value="${esc(d.title || "")}" autocomplete="off" aria-label="Event title">
    <div class="ef-row">
      <label>Starts<input type="datetime-local" id="ef-start" value="${esc(d.start || "")}" aria-label="Start time"></label>
      <label>Ends<input type="datetime-local" id="ef-end" value="${esc(d.end || "")}" aria-label="End time"></label>
    </div>
    <input class="text-input" id="ef-loc" placeholder="Location (optional)" value="${esc(d.loc || "")}" autocomplete="off" aria-label="Location">
    <textarea id="ef-desc" rows="2" placeholder="Notes (optional)" aria-label="Notes">${esc(d.desc || "")}</textarea>
    <div class="ef-actions"><span class="ef-hint">Goes out as an .ics invitation by email</span><button class="ef-send" id="ef-send">Send invitation</button></div>
  </div>`;
}

/** Validate the invitation form, then send it with the message. */
async function sendInvite() {
  const d = state.eventDraft || {};
  const title = String(d.title || "").trim();
  const startV = String(d.start || ""), endV = String(d.end || "");
  if (!title) { toast("Give the invitation a title.", true); return; }
  const s = new Date(startV), e = new Date(endV);
  if (!startV || !endV || isNaN(s.getTime()) || isNaN(e.getTime())) { toast("Pick a start and end time.", true); return; }
  if (e.getTime() <= s.getTime()) { toast("The end time has to be after the start time.", true); return; }
  state.pendingEvent = {
    title,
    starts_at: s.toISOString(),
    ends_at: e.toISOString(),
    location: String(d.loc || "").trim(),
    description: String(d.desc || "").trim(),
  };
  state.eventForm = false;
  await sendMsg();
}

async function sendMsg() {
  const conv = state.conv;
  const ch = selectedChannel();
  if (!conv || !ch || state.sending) return;
  const body = $("#draft").value;
  const files = state.pendingFiles.slice();
  const event = state.pendingEvent;
  if (!body.trim() && !files.length && !event) return;
  if ((files.length || event) && ch !== "email") { toast("Invitations and files go out by email — switch channels or drop them.", true); return; }
  state.sending = true;
  $("#send").disabled = true;
  const clearEvent = () => { state.pendingEvent = null; state.eventDraft = null; state.eventForm = false; };
  try {
    let r;
    if (files.length) {
      const form = new FormData();
      form.set("channel", ch);
      form.set("body", body);
      form.set("subject", ch === "email" ? ($("#subject")?.value || "") : "");
      if (state.replyTo) form.set("in_reply_to", state.replyTo.id);
      if (event) form.set("event", JSON.stringify(event));
      for (const f of files) form.append("files", f, f.name);
      r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages", { method: "POST", body: form });
    } else {
      r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages", {
        method: "POST",
        body: JSON.stringify({ channel: ch, body, subject: ch === "email" ? ($("#subject")?.value || "") : "", in_reply_to: state.replyTo ? state.replyTo.id : undefined, event: event || undefined }),
      });
    }
    state.messages.push(r.message);
    state.replyTo = null;
    state.pendingFiles = [];
    clearEvent();
    state.dropDraft = true; // the send consumed the draft — don't restore it
    await refreshFiles();
    await refreshDiary();
    renderConversationDetail();
  } catch (e) {
    if (e.failed_message) {
      state.messages.push(e.failed_message);
      state.replyTo = null;
      state.pendingFiles = [];
      clearEvent();
      state.dropDraft = true;
      await refreshFiles();
      await refreshDiary();
      renderConversationDetail();
      toast(e.message, true);
    } else {
      toast(e.message, true);
    }
  } finally {
    state.sending = false;
    const btn = $("#send");
    if (btn) btn.disabled = false;
  }
}

async function retryMsg(id) {
  const conv = state.conv;
  const m = state.messages.find((x) => x.id === id);
  if (!conv || !m || m.status !== "failed") return;
  const btn = $(`#msgs [data-retry="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Retrying…"; }
  try {
    const r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages/" + encodeURIComponent(id) + "/retry", { method: "POST" });
    const i = state.messages.findIndex((x) => x.id === id);
    if (i >= 0) state.messages[i] = r.message;
    toast("Message sent.");
  } catch (e) {
    toast(e.message || "Still failing to send.", true);
  }
  renderConversationDetail();
}

async function refreshConversation() {
  const conv = state.conv;
  if (!conv) return;
  try {
    const m = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages?limit=100");
    const before = state.messages.length;
    state.messages = m.messages || [];
    if (state.messages.length !== before) {
      await refreshFiles();
      await refreshDiary();
      const sc = $("#msgs");
      const nearBottom = sc && (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120);
      renderConversationDetail();
      await api("/api/conversations/" + encodeURIComponent(conv.id) + "/read", { method: "POST" }).catch(() => {});
      if (!nearBottom) { /* keep position */ }
    }
  } catch { /* stay quiet on background refresh */ }
}

// ---------- people ----------

async function loadContacts() {
  const r = await api("/api/contacts");
  state.contacts = r.contacts || [];
  state.archivedContacts = r.archived || [];
  state.maxPeople = r.maxPeople;
}

function renderPeople() {
  const full = state.contacts.length >= (state.maxPeople || 8);
  const app = $("#app");
  app.innerHTML = `
    <div class="view">
      <div class="nav-bar"><div class="nav-title">People</div>
        <button class="nav-action" id="import-contacts">${icon("tray")}Import</button>
        <button class="nav-action" id="new-group2">${icon("plus")}Group</button></div>
      <div class="scroll"><div class="people-grid">
        ${state.contacts.map((c) => `
          <button class="person-card card" data-id="${c.id}">
            ${avatarHtml(c.name, c.color, 72, false, c.avatar_url)}
            <div class="pname">${esc(c.name)}</div>
            <div class="chan-dots">${["email", "sms", "matrix"].map((ch) =>
              `<span class="chan-dot ${ch}" style="${c.channels.includes(ch) ? "" : "opacity:.18;filter:grayscale(1)"}" title="${CHAN_META[ch].label}"></span>`).join("")}</div>
          </button>`).join("")}
        <button class="person-card add" id="add-person" ${full ? "disabled" : ""}>
          ${icon("plus", "big")}
          <div>${full ? `Full — ${state.maxPeople} max` : "Add person"}</div>
        </button>
      </div>
      <div class="hint" style="text-align:center;padding:0 24px 24px">Relay is for your inner circle — up to ${state.maxPeople || 8} people, ${state.maxPeople || 8} per group. Tap a person to see their channels, then message them. Archived people don't count against the limit.</div>
      ${state.archivedContacts.length ? `
      <div class="group-caption">Archived · ${state.archivedContacts.length}</div>
      <div class="group-card card">
        ${state.archivedContacts.map((c) => `
          <button class="group-row arch-row" data-id="${c.id}">
            ${avatarHtml(c.name, c.color, 40, false, c.avatar_url)}
            <div class="rlabel"><div class="t1">${esc(c.name)}</div><div class="t2">Archived — tap to restore</div></div>
            <span class="arch-badge">${icon("box")}</span>
          </button>`).join("")}
      </div>` : ""}
      </div>
      ${tabBar("people")}
    </div>`;
  bindTabs(app);
  $$(".person-card[data-id]", app).forEach((b) => b.addEventListener("click", () => { location.hash = "#/people/" + b.dataset.id; }));
  $$(".arch-row[data-id]", app).forEach((b) => b.addEventListener("click", () => { location.hash = "#/people/" + b.dataset.id; }));
  $("#add-person").addEventListener("click", () => { if (!full) location.hash = "#/people/new"; });
  $("#new-group2").addEventListener("click", () => { location.hash = "#/group/new"; });
  $("#import-contacts").addEventListener("click", openImportSheet);
}

// ---------- Google Contacts import ----------

function openImportSheet() {
  const scrim = document.createElement("div");
  scrim.className = "sheet-scrim";
  scrim.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grabber"></div><h3>Add people</h3>
      <div class="seg" id="imp-tabs" style="margin-bottom:12px">
        <button data-tab="sent" class="on">${icon("email")}Sent mail</button><button data-tab="sms">${icon("sms")}SMS</button><button data-tab="google">${icon("globe")}Google</button><button data-tab="vcf">${icon("card")}vCard</button>
      </div>
      <div id="imp-body"></div>
    </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });

  const body = $("#imp-body", scrim);
  const setTab = (t) => {
    $$("#imp-tabs button", scrim).forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    if (t === "sent") drawSentTab(body, close); else if (t === "sms") drawSmsTab(body, close); else if (t === "vcf") drawVcfTab(body, close); else drawGoogleTab(body, close);
  };
  $$("#imp-tabs button", scrim).forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  setTab("sent");
}

// Shared checkbox picker for the import tabs.
// items: [{name, email, sub, gv_number?, badge?, disabled?}] — badge shows a
// trailing match note (e.g. "already in contacts"); disabled rows are dimmed
// and cannot be picked.
function contactPicker(body, close, items, importHint, opts) {
  opts = opts || {};
  const remaining = (state.maxPeople || 8) - state.contacts.length;
  const picked = new Set();
  let q = "";
  const draw = () => {
    const list = items.filter((c) =>
      !q || c.name.toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q) || (c.gv_number || "").includes(q));
    body.innerHTML = `
      <div class="search-field" style="margin-bottom:10px">${icon("search")}<input id="imp-q" placeholder="Search" value="${esc(q)}"></div>
      <div class="hint" style="margin-bottom:8px">${remaining} of ${state.maxPeople || 8} spots left \u2014 Relay stays small on purpose.</div>
      <div class="group-card card" style="margin:0;max-height:38vh;overflow-y:auto">
        ${list.map((c) => { const idx = items.indexOf(c); return `
          <div class="pick-row${picked.has(idx) ? " on" : ""}${c.disabled ? " disabled" : ""}" data-idx="${idx}">
            <span class="check">${icon("check")}</span>${avatarHtml(c.name || c.email, "#0a84ff", 48)}
            <span class="pname" style="font-size:15px">${esc(c.name || "(no name)")}<br><span style="font-size:12px;color:var(--label-3);font-weight:400">${[c.email, c.sub].filter(Boolean).map(esc).join(" \u00B7 ")}</span>${c.badge ? `<br><span class="pick-badge">${esc(c.badge)}</span>` : ""}</span>
            ${c.attachable ? `<button class="link-btn" data-attach="${idx}">Add to existing</button>` : ""}
          </div>`; }).join("") || `<div class="empty"><p>No matches.</p></div>`}
      </div>
      <button class="btn" id="imp-go" style="width:100%;margin-top:12px" ${picked.size ? "" : "disabled"}>Import ${picked.size} contact${picked.size === 1 ? "" : "s"}</button>
      ${importHint ? `<div class="hint" style="text-align:center">${importHint}</div>` : ""}`;
    const qi = $("#imp-q", body);
    qi.addEventListener("input", () => { q = qi.value.toLowerCase(); const pos = qi.selectionStart; draw(); const nq = $("#imp-q", body); nq.focus(); nq.setSelectionRange(pos, pos); });
    $$(".pick-row", body).forEach((r) => r.addEventListener("click", () => {
      const idx = Number(r.dataset.idx);
      if (items[idx].disabled) return;
      if (picked.has(idx)) picked.delete(idx);
      else {
        if (picked.size >= remaining) { toast(`Only ${remaining} spot${remaining === 1 ? "" : "s"} left.`, true); return; }
        picked.add(idx);
      }
      draw();
    }));
    $$("[data-attach]", body).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (opts.onAttach) opts.onAttach(items[Number(b.dataset.attach)]);
    }));
    $("#imp-go", body).addEventListener("click", async () => {
      const btn = $("#imp-go", body);
      btn.disabled = true; btn.textContent = "Importing\u2026";
      try {
        const r = await api("/api/import-contacts", { method: "POST", body: JSON.stringify({ contacts: [...picked].map((i) => items[i]) }) });
        await loadContacts();
        close();
        toast(r.imported ? `Imported ${r.imported}.` + (r.skipped ? ` ${r.skipped} already here.` : "") : "Everyone selected was already here.");
        if ((location.hash || "").startsWith("#/people")) renderPeople();
      } catch (e) { toast(e.message, true); btn.disabled = false; draw(); }
    });
  };
  draw();
}

async function openAttachSheet(item, onDone) {
  let contacts = [];
  try { contacts = (await api("/api/contacts")).contacts || []; }
  catch (e) { toast("Couldn't load contacts.", true); return; }
  const num = normDigits(item.gv_number);
  const targets = contacts.filter((c) => { const d = normDigits(c.gv_number); return !num || d !== num; });
  const scrim = document.createElement("div");
  scrim.className = "sheet-scrim";
  scrim.innerHTML = `<div class="sheet"><div class="grabber"></div><h3>Add number to\u2026</h3>
    <p class="hint" style="text-align:center;margin:0 0 10px">${esc(item.name || fmtPhone(item.gv_number))} \u00B7 ${esc(fmtPhone(item.gv_number))}</p>
    <div class="group-card card" style="margin:0;max-height:40vh;overflow-y:auto">
      ${targets.map((c) => `<button class="attach-row" data-id="${esc(c.id)}">${avatarHtml(c.name, c.color, 40, false, c.avatar_url)}<span class="pname" style="font-size:15px">${esc(c.name)}<br><span style="font-size:12px;color:var(--label-3);font-weight:400">${esc([c.email, fmtPhone(c.gv_number)].filter(Boolean).join(" \u00B7 ") || "No number yet")}</span></span></button>`).join("") || `<div class="empty"><p>No other contacts yet.</p></div>`}
    </div>
    <button class="btn-quiet" id="attach-cancel">Cancel</button></div>`;
  document.body.appendChild(scrim);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) scrim.remove(); });
  $("#attach-cancel", scrim).addEventListener("click", () => scrim.remove());
  $$(".attach-row", scrim).forEach((b) => b.addEventListener("click", async () => {
    const t = targets.find((c) => String(c.id) === b.dataset.id);
    b.disabled = true;
    try {
      await api(`/api/contacts/${b.dataset.id}`, { method: "PATCH", body: JSON.stringify({ gv_number: item.gv_number }) });
      scrim.remove();
      toast(`Added to ${t ? t.name : "contact"}.`);
      await loadContacts();
      onDone();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }));
}

async function drawSmsTab(body, close) {
  body.innerHTML = `<div class="empty">${icon("clock", "big")}<p>Reading recent text conversations\u2026</p></div>`;
  try {
    const r = await api("/api/recent-sms");
    const items = (r.conversations || []).map((c) => ({
      name: c.name || fmtPhone(c.number), email: "", gv_number: c.number,
      sub: `${fmtPhone(c.number)} \u00B7 \u00D7${c.count} message${c.count === 1 ? "" : "s"} \u00B7 last ${fmtDay(c.lastDate)}`,
      badge: c.contact ? `\u2713 ${c.contact.name} \u2014 already in contacts` : "",
      disabled: !!c.contact,
      attachable: !c.contact,
    }));
    if (!items.length) {
      const n = Number(r.scanned || 0);
      body.innerHTML = `<div class="empty">${icon("sms", "big")}<h3>No recent texts</h3><p>Scanned ${n} inbox message${n === 1 ? "" : "s"} from the last 14 days \u2014 none were Google Voice SMS forwards.</p></div>`;
      return;
    }
    contactPicker(body, close, items, "Creates contacts with the Google Voice number filled in \u2014 ready for SMS.", {
      onAttach: (item) => openAttachSheet(item, () => drawSmsTab(body, close)),
    });
  } catch (e) {
    const needSettings = /Settings/.test(e.message || "");
    body.innerHTML = `<div class="empty">${needSettings ? icon("email", "big") : icon("warn", "big")}
      <h3>${needSettings ? "Mail isn't connected" : "Couldn't read inbox"}</h3><p>${esc(e.message)}</p>
      <div style="margin-top:14px">${needSettings
        ? `<button class="btn" id="imp-settings">Open Settings</button>`
        : `<button class="btn secondary" id="imp-retry">Try again</button>`}</div></div>`;
    const s = $("#imp-settings", body);
    if (s) s.addEventListener("click", () => { close(); location.hash = "#/settings"; });
    const rt = $("#imp-retry", body);
    if (rt) rt.addEventListener("click", () => drawSmsTab(body, close));
  }
}

async function drawSentTab(body, close) {
  body.innerHTML = `<div class="empty">${icon("clock", "big")}<p>Reading your last 40 sent emails\u2026</p></div>`;
  try {
    const r = await api("/api/sent-contacts");
    const items = (r.contacts || []).map((c) => ({
      name: c.name, email: c.email,
      sub: c.count > 1 ? `\u00D7${c.count} emails` : "1 email",
    }));
    if (!items.length) {
      body.innerHTML = `<div class="empty">${icon("email", "big")}<h3>No sent mail found</h3><p>Your Sent folder is empty or couldn't be read.</p></div>`;
      return;
    }
    contactPicker(body, close, items, "Harvested from your last 40 sent emails \u2014 names and addresses are imported.");
  } catch (e) {
    const needSettings = /Settings/.test(e.message || "");
    body.innerHTML = `<div class="empty">${needSettings ? icon("email", "big") : icon("warn", "big")}
      <h3>${needSettings ? "Mail isn't connected" : "Couldn't read sent mail"}</h3><p>${esc(e.message)}</p>
      <div style="margin-top:14px">${needSettings
        ? `<button class="btn" id="imp-settings">Open Settings</button>`
        : `<button class="btn secondary" id="imp-retry">Try again</button>`}</div></div>`;
    const s = $("#imp-settings", body);
    if (s) s.addEventListener("click", () => { close(); location.hash = "#/settings"; });
    const rt = $("#imp-retry", body);
    if (rt) rt.addEventListener("click", () => drawSentTab(body, close));
  }
}

async function drawGoogleTab(body, close) {
  body.innerHTML = `<div class="empty">${icon("clock", "big")}<p>Loading your Google contacts\u2026</p></div>`;
  try {
    const r = await api("/api/google/contacts");
    const items = (r.contacts || []).map((c) => ({ name: c.name, email: c.email, sub: c.phone || "" }));
    if (!items.length) {
      body.innerHTML = `<div class="empty">${icon("globe", "big")}<h3>No Google contacts found</h3><p>Your Google contacts list is empty.</p></div>`;
      return;
    }
    contactPicker(body, close, items, "Names and email addresses are imported. Add a Google Voice number afterwards (Edit person) to enable SMS.");
  } catch (e) {
    body.innerHTML = `<div class="empty">${icon("globe", "big")}<h3>Google isn't connected</h3>
      <p>${esc(e.message)}</p>
      <div style="margin-top:14px"><button class="btn" id="imp-settings">Open Settings</button></div></div>`;
    $("#imp-settings", body).addEventListener("click", () => { close(); location.hash = "#/settings"; });
  }
}

// ---------- vCard (.vcf) import ----------

// Unescape vCard text values: \, \; \n and \\.
function unescapeVcf(s) {
  return s.replace(/\\([\\,;nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

// Decode quoted-printable (vCard 2.1 ENCODING=QUOTED-PRINTABLE), UTF-8 aware.
function qpDecodeVcf(s) {
  const bytes = [];
  const clean = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(clean.substr(i + 1, 2))) {
      bytes.push(parseInt(clean.substr(i + 1, 2), 16)); i += 2;
    } else bytes.push(clean.charCodeAt(i) & 0xff);
  }
  try { return new TextDecoder("utf-8").decode(new Uint8Array(bytes)); } catch { return clean; }
}

/** Parse vCard 2.1/3.0/4.0 text into [{name, email, gv_number, sub}]. Runs on-device. */
function parseVcf(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const unfolded = [];
  for (const ln of lines) {
    if (/^[ \t]/.test(ln) && unfolded.length) unfolded[unfolded.length - 1] += ln.slice(1);
    else unfolded.push(ln);
  }
  const cards = [];
  let cur = null;
  for (const ln of unfolded) {
    const up = ln.toUpperCase();
    if (up === "BEGIN:VCARD") { cur = { names: [], emails: [], tels: [] }; continue; }
    if (up === "END:VCARD") { if (cur) cards.push(cur); cur = null; continue; }
    if (!cur) continue;
    const m = ln.match(/^([^:;]+)((?:;[^:]*)*):([\s\S]*)$/);
    if (!m) continue;
    const key = m[1].toUpperCase(), params = m[2].toUpperCase();
    let val = m[3];
    if (/QUOTED-PRINTABLE/.test(params)) val = qpDecodeVcf(val);
    val = unescapeVcf(val).trim();
    if (!val) continue;
    if (key === "FN") cur.names.push({ v: val, pref: /PREF/.test(params) });
    else if (key === "N") {
      // N:Family;Given;Middle;Prefix;Suffix
      const p = val.split(";").map((s) => s.trim());
      const full = [p[3], p[1], p[2], p[0], p[4]].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (full) cur.names.push({ v: full, pref: /PREF/.test(params) });
    }
    else if (key === "EMAIL") cur.emails.push({ v: val.toLowerCase(), pref: /PREF/.test(params) });
    else if (key === "TEL") cur.tels.push({ v: val, pref: /PREF/.test(params), cell: /CELL|MOBILE/.test(params) });
  }
  const pick = (arr) => (arr.find((a) => a.pref) || arr.find((a) => a.cell) || arr[0]);
  return cards.map((c) => {
    const name = (pick(c.names) || {}).v || "";
    const email = (pick(c.emails) || {}).v || "";
    const tel = (pick(c.tels) || {}).v || "";
    const label = name || email || tel;
    if (!label) return null;
    return { name: label, email, gv_number: tel, sub: [email, tel].filter(Boolean).join(" · ") };
  }).filter(Boolean);
}

function drawVcfTab(body, close) {
  body.innerHTML = `
    <div class="hint" style="margin-bottom:12px">Pick a <b>.vcf</b> vCard file — from iCloud, a Google Contacts export, or anywhere else. It's parsed on this device; nothing is uploaded.</div>
    <input type="file" id="vcf-file" accept=".vcf,.vcard,text/vcard" style="display:none">
    <button class="btn" id="vcf-pick" style="width:100%">${icon("card")} Choose vCard file…</button>
    <div id="vcf-status"></div>`;
  const input = $("#vcf-file", body);
  $("#vcf-pick", body).addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const status = $("#vcf-status", body);
    try {
      const items = parseVcf(await f.text());
      if (!items.length) {
        status.innerHTML = `<div class="empty"><p>No contacts found in that file.</p></div>`;
        return;
      }
      contactPicker(body, close, items, `Parsed ${items.length} contact${items.length === 1 ? "" : "s"} from ${esc(f.name)} — pick who to add.`);
    } catch (e) {
      status.innerHTML = `<div class="empty"><p>Couldn't read that file.</p></div>`;
    }
  });
}

function renderPersonDetail(id) {
  const c = state.contacts.find((x) => x.id === id) || state.archivedContacts.find((x) => x.id === id);
  if (!c) { location.hash = "#/people"; return; }
  const rows = [
    { ch: "email", t1: "Email", t2: c.email || "Not set" },
    { ch: "sms", t1: "SMS · Google Voice", t2: c.gv_number || "Not set" },
    { ch: "matrix", t1: "Matrix", t2: c.matrix_id || c.matrix_room_id || "Not set" },
  ];
  const app = $("#app");
  app.innerHTML = `
    <div class="view">
      <div class="nav-bar">
        <button class="nav-back" id="back">${icon("back")}People</button>
        <div class="nav-title small" style="flex:1"></div>
        <button class="nav-action" id="edit">Edit</button>
      </div>
      <div class="scroll">
        <div class="profile-hero">
          ${avatarHtml(c.name, c.color, 72, false, c.avatar_url)}
          <h2>${esc(c.name)}</h2>
          <div class="sub">${c.archived ? icon("box") + " Archived · " : ""}${c.channels.length ? c.channels.map((ch) => CHAN_META[ch].label).join(" · ") : "No channels yet"}</div>
        </div>
        <div style="padding:0 32px"><button class="btn" id="message" style="width:100%">Message</button></div>
        <div class="group-caption">Channels</div>
        <div class="group-card card">
          ${rows.map((r) => `
            <div class="group-row"><span class="chan-dot ${r.ch}"></span>
              <div class="rlabel"><div class="t1">${r.t1}</div><div class="t2">${esc(r.t2)}</div></div>
            </div>`).join("")}
        </div>
        ${c.notes ? `<div class="group-caption">Notes</div><div class="group-card card"><div class="group-row"><div class="rlabel"><div class="t1" style="font-weight:400">${esc(c.notes)}</div></div></div></div>` : ""}
        <div style="padding:8px 32px 32px;display:flex;flex-direction:column;gap:10px">
          ${c.archived
            ? `<button class="btn" id="unarchive" style="width:100%">Unarchive person</button>`
            : `<button class="btn" id="archive" style="width:100%">${icon("box")}Archive person</button>`}
          <button class="btn danger" id="del" style="width:100%">Remove person</button>
        </div>
      </div>
      ${tabBar("people")}
    </div>`;
  bindTabs(app);
  $("#back").addEventListener("click", () => { location.hash = "#/people"; });
  $("#edit").addEventListener("click", () => openContactSheet(c));
  $("#message").addEventListener("click", () => { location.hash = "#/conversations/" + c.conversation_id; });
  const archBtn = c.archived ? $("#unarchive") : $("#archive");
  if (archBtn) archBtn.addEventListener("click", async () => {
    try {
      await api("/api/contacts/" + c.id, { method: "PATCH", body: JSON.stringify({ archived: c.archived ? 0 : 1 }) });
      await loadContacts();
      toast(c.archived ? "Back in your circle." : "Archived — they no longer count against the limit.");
      location.hash = "#/people";
    } catch (e) { toast(e.message, true); }
  });
  $("#del").addEventListener("click", async () => {
    if (!confirm(`Remove ${c.name} from Relay? Their conversations will be deleted.`)) return;
    await api("/api/contacts/" + c.id, { method: "DELETE" });
    await loadContacts();
    toast("Removed.");
    location.hash = "#/people";
  });
}

// ---------- contact sheet (new/edit) ----------

function openContactSheet(existing) {
  const c = existing || { name: "", email: "", gv_number: "", matrix_id: "", matrix_room_id: "", notes: "", photo: "", color: "#8e8e93" };
  let photoData = c.photo || "";
  const scrim = document.createElement("div");
  scrim.className = "sheet-scrim";
  scrim.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grabber"></div>
      <h3>${existing ? "Edit person" : "Add person"}</h3>
      <div class="photo-row">
        <div id="f-photo-preview">${avatarHtml(c.name || "?", c.color || "#8e8e93", 72, false, photoData || null)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn secondary small" id="pick-photo" type="button">Choose photo</button>
            <button class="btn secondary small" id="clear-photo" type="button">Remove</button>
          </div>
          <div class="hint">A custom photo replaces the Gravatar image everywhere.</div>
        </div>
        <input type="file" id="f-photo-file" accept="image/*" style="display:none">
      </div>
      <div class="field"><label>Name</label><input class="text-input" id="f-name" value="${esc(c.name)}" placeholder="Ada Lovelace" maxlength="60"></div>
      <div class="field"><label>Email</label><input class="text-input" id="f-email" value="${esc(c.email)}" placeholder="ada@example.com" inputmode="email"></div>
      <div class="field"><label>Google Voice number</label><input class="text-input" id="f-gv" value="${esc(c.gv_number)}" placeholder="5551234567" inputmode="tel">
        <div class="hint">Their Google Voice number — Relay texts it through the GV email gateway.</div></div>
      <div class="field"><label>Matrix user <span style="font-weight:400">(for reference)</span></label><input class="text-input" id="f-mxid" value="${esc(c.matrix_id)}" placeholder="@ada:matrix.org"></div>
      <div class="field"><label>Matrix room</label>
        <div style="display:flex;gap:8px"><input class="text-input" id="f-room" value="${esc(c.matrix_room_id)}" placeholder="!abc:matrix.org" style="flex:1">
        <button class="btn secondary small" id="pick-room" type="button">Browse</button></div>
        <div class="hint">A DM room you're both in. Create it in Element first, then pick it here.</div></div>
      <div class="field"><label>Notes</label><textarea class="text-area" id="f-notes" placeholder="Anything worth remembering…">${esc(c.notes)}</textarea></div>
      <button class="btn" id="save" style="width:100%;margin-top:4px">${existing ? "Save" : "Add person"}</button>
      <div style="height:8px"></div>
    </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });

  const refreshPreview = () => {
    $("#f-photo-preview", scrim).innerHTML = avatarHtml($("#f-name", scrim).value || "?", c.color || "#8e8e93", 72, false, photoData || null);
  };
  $("#f-name", scrim).addEventListener("input", refreshPreview);
  $("#pick-photo", scrim).addEventListener("click", () => $("#f-photo-file", scrim).click());
  $("#clear-photo", scrim).addEventListener("click", () => { photoData = ""; refreshPreview(); });
  $("#f-photo-file", scrim).addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type || "")) { toast("Pick an image file.", true); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const S = 256, scale = Math.min(1, S / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * scale));
        cv.height = Math.max(1, Math.round(img.height * scale));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        photoData = cv.toDataURL("image/jpeg", 0.82);
        refreshPreview();
      } catch { toast("Couldn't read that image.", true); }
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => toast("Couldn't read that image.", true);
    img.src = URL.createObjectURL(f);
    e.target.value = "";
  });

  $("#pick-room", scrim).addEventListener("click", async () => {
    try {
      const r = await api("/api/matrix/rooms");
      const rooms = r.rooms || [];
      if (!rooms.length) { toast("No Matrix rooms found — join one first.", true); return; }
      const list = rooms.map((rm, i) => `${i + 1}. ${rm.name}`).join("\n");
      const pick = prompt(`Pick a room (number):\n${list}`);
      const n = Number(pick);
      if (n >= 1 && n <= rooms.length) $("#f-room", scrim).value = rooms[n - 1].id;
    } catch (e) { toast(e.message, true); }
  });

  $("#save", scrim).addEventListener("click", async () => {
    const vals = {
      name: $("#f-name", scrim).value.trim(),
      email: $("#f-email", scrim).value.trim(),
      gv_number: $("#f-gv", scrim).value.trim(),
      matrix_id: $("#f-mxid", scrim).value.trim(),
      matrix_room_id: $("#f-room", scrim).value.trim(),
      notes: $("#f-notes", scrim).value.trim(),
      photo: photoData,
    };
    if (!vals.name) { toast("Give them a name.", true); return; }
    try {
      if (existing) await api("/api/contacts/" + existing.id, { method: "PATCH", body: JSON.stringify(vals) });
      else await api("/api/contacts", { method: "POST", body: JSON.stringify(vals) });
      await loadContacts();
      close();
      toast(existing ? "Saved." : "Added. Say hello 👋");
      if (!existing) { const nc = state.contacts.find((x) => x.name === vals.name); if (nc) location.hash = "#/people/" + nc.id; }
      else renderPersonDetail(existing.id);
    } catch (e) { toast(e.message, true); }
  });
  setTimeout(() => $("#f-name", scrim).focus(), 60);
}

// ---------- new group ----------

function renderNewGroup() {
  const picked = new Set();
  const app = $("#app");
  const draw = () => {
    app.innerHTML = `
    <div class="view">
      <div class="nav-bar"><button class="nav-back" id="back">${icon("back")}People</button><div class="nav-title small" style="flex:1">New group</div>
        <button class="nav-action" id="create" ${picked.size ? "" : "disabled"}>Create</button></div>
      <div class="scroll">
        <div style="padding:16px 16px 0"><div class="field"><label>Group name</label><input class="text-input" id="g-name" placeholder="Weekend crew" maxlength="60"></div>
        <div class="field"><label>Matrix room <span style="font-weight:400">(optional)</span></label><input class="text-input" id="g-room" placeholder="!xyz:matrix.org"></div></div>
        <div class="group-caption">Members · ${picked.size + 1} of ${state.maxPeople || 8} (you included)</div>
        <div class="group-card card">
          ${state.contacts.map((c) => `
            <div class="pick-row${picked.has(c.id) ? " on" : ""}" data-id="${c.id}">
              <span class="check">✓</span>${avatarHtml(c.name, c.color, 48, false, c.avatar_url)}<span class="pname">${esc(c.name)}</span>
            </div>`).join("") || `<div class="empty"><p>Add people first.</p></div>`}
        </div>
        <div class="hint" style="padding:0 20px 24px">Only channels every member has set up can be used in the group.</div>
      </div>
      ${tabBar("people")}
    </div>`;
    bindTabs(app);
    $("#back").addEventListener("click", () => { location.hash = "#/people"; });
    $$(".pick-row", app).forEach((r) => r.addEventListener("click", () => {
      const id = r.dataset.id;
      if (picked.has(id)) picked.delete(id);
      else {
        if (picked.size + 1 >= (state.maxPeople || 8)) { toast(`Groups hold ${state.maxPeople || 8} people max, you included.`, true); return; }
        picked.add(id);
      }
      const nm = $("#g-name").value, rm = $("#g-room").value;
      draw();
      $("#g-name").value = nm; $("#g-room").value = rm;
    }));
    $("#create").addEventListener("click", async () => {
      try {
        const r = await api("/api/conversations", { method: "POST", body: JSON.stringify({ name: $("#g-name").value, member_ids: [...picked], matrix_room_id: $("#g-room").value }) });
        toast("Group created.");
        location.hash = "#/conversations/" + r.conversation.id;
      } catch (e) { toast(e.message, true); }
    });
  };
  draw();
}

// ---------- group edit sheet ----------

function openGroupSheet(conv) {
  const scrim = document.createElement("div");
  scrim.className = "sheet-scrim";
  scrim.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grabber"></div><h3>Group settings</h3>
      <div class="field"><label>Group name</label><input class="text-input" id="g-name" value="${esc(conv.name)}" maxlength="60"></div>
      <div class="field"><label>Matrix room</label><input class="text-input" id="g-room" value="${esc(conv.matrix_room_id || "")}" placeholder="!xyz:matrix.org"></div>
      <button class="btn" id="save" style="width:100%">Save</button>
      <div style="height:8px"></div>
      <button class="btn danger" id="del" style="width:100%">Delete group</button>
      <div style="height:8px"></div>
    </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  $("#save", scrim).addEventListener("click", async () => {
    try {
      await api("/api/conversations/" + conv.id, { method: "PATCH", body: JSON.stringify({ name: $("#g-name", scrim).value, matrix_room_id: $("#g-room", scrim).value }) });
      close(); toast("Saved.");
      await loadConversation(conv.id); renderConversationDetail();
    } catch (e) { toast(e.message, true); }
  });
  $("#del", scrim).addEventListener("click", async () => {
    if (!confirm("Delete this group and its messages?")) return;
    await api("/api/conversations/" + conv.id, { method: "DELETE" });
    close(); location.hash = "#/conversations";
  });
}

// ---------- settings ----------

async function loadSettings() {
  state.settings = await api("/api/settings");
  state.status = await api("/api/status");
}

function secretField(val, has, id, label, hint) {
  return `<div class="field"><label>${label}</label>
    <input class="text-input" type="password" id="${id}" placeholder="${has ? "Saved — leave blank to keep" : ""}" autocomplete="new-password">
    ${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
}

function renderSettings() {
  const s = state.settings, st = state.status;
  const app = $("#app");
  const dot = (ok) => `<span class="status-dot ${ok ? "ok" : "no"}"></span>`;
  app.innerHTML = `
    <div class="view">
      <div class="nav-bar"><div class="nav-title">Settings</div></div>
      <div class="scroll">
        <div class="group-caption">Connections</div>
        <div class="group-card card">
          <div class="group-row">${dot(st.smtp)}<div class="rlabel"><div class="t1">Email sending (SMTP)</div><div class="t2">${st.smtp ? esc(s.smtp.host) : "Not configured"}</div></div></div>
          <div class="group-row">${dot(st.imap)}<div class="rlabel"><div class="t1">Inbox (IMAP)</div><div class="t2">${st.imap ? esc(s.imap.host) : "Not configured"}</div></div></div>
          <div class="group-row">${dot(st.matrix)}<div class="rlabel"><div class="t1">Matrix</div><div class="t2">${st.matrix ? esc(s.matrix.homeserver) : "Not configured"}</div></div></div>
        </div>
        <div style="padding:4px 32px 0"><button class="btn secondary" id="poll" style="width:100%">${icon("retry")} Check for new messages</button></div>
        ${st.lastPoll && (st.lastPoll.mail || st.lastPoll.matrix) ? `<div class="hint" style="text-align:center">Last check — mail: ${st.lastPoll.mail ? fmtTime(st.lastPoll.mail) : "—"} · matrix: ${st.lastPoll.matrix ? fmtTime(st.lastPoll.matrix) : "—"}</div>` : ""}

        <div class="group-caption">Mail maintenance</div>
        <div class="group-card card" style="padding:14px 16px">
          <div class="group-row" style="padding:0;background:none;border:none">
            <div class="rlabel" style="flex:1"><div class="t1">Migrate old mail</div><div class="t2">Re-locates your stored emails by Message-ID, records who was on each one, and moves multi-contact threads into their group.</div></div>
          </div>
          <div class="test-row" style="margin-top:8px"><button class="btn secondary small" id="migrate-mail">Migrate old mail</button><span class="test-result" id="migrate-result"></span></div>
        </div>

        <div class="group-caption">Notifications</div>
        <div class="group-card card">
          <div class="group-row">
            <div class="rlabel" style="flex:1"><div class="t1">New message notifications</div><div class="t2">${notifyHint()}</div></div>
            <label class="switch"><input type="checkbox" id="notify-toggle" ${state.notify ? "checked" : ""} aria-label="New message notifications"><span class="track"><span class="thumb"></span></span></label>
          </div>
        </div>

        <div class="group-caption">Email sending · SMTP</div>
        <div class="group-card card" style="padding:14px 16px">
          <div class="row-2col">
            <div class="field"><label>Host</label><input class="text-input" id="s-host" value="${esc(s.smtp.host)}" placeholder="smtp.gmail.com"></div>
            <div class="field"><label>Port</label><input class="text-input" id="s-port" value="${esc(String(s.smtp.port || 465))}" inputmode="numeric"></div>
          </div>
          <div class="field"><label>Security</label><select class="text-input" id="s-sec">
            ${["ssl", "starttls", "none"].map((o) => `<option value="${o}"${s.smtp.secure === o ? " selected" : ""}>${o === "ssl" ? "SSL / TLS (465)" : o === "starttls" ? "STARTTLS (587)" : "None"}</option>`).join("")}</select></div>
          <div class="row-2col">
            <div class="field"><label>Username</label><input class="text-input" id="s-user" value="${esc(s.smtp.user)}" autocomplete="username"></div>
            <div class="field"><label>Your name</label><input class="text-input" id="s-name" value="${esc(s.smtp.fromName || "")}" placeholder="You"></div>
          </div>
          <div class="field"><label>From address</label><input class="text-input" id="s-from" value="${esc(s.smtp.from)}" placeholder="you@gmail.com" inputmode="email"></div>
          ${secretField(0, s.smtp.hasPass, "s-pass", "Password", "Gmail needs an <b>app password</b>, not your login password.")}
          <div class="test-row"><button class="btn secondary small" id="t-smtp">Test connection</button><span class="test-result" id="r-smtp"></span></div>
        </div>

        <div class="group-caption">Inbox · IMAP <span style="font-weight:400">(for replies)</span></div>
        <div class="group-card card" style="padding:14px 16px">
          <div class="row-2col">
            <div class="field"><label>Host</label><input class="text-input" id="i-host" value="${esc(s.imap.host)}" placeholder="imap.gmail.com"></div>
            <div class="field"><label>Port</label><input class="text-input" id="i-port" value="${esc(String(s.imap.port || 993))}" inputmode="numeric"></div>
          </div>
          <div class="field"><label>Username</label><input class="text-input" id="i-user" value="${esc(s.imap.user)}" autocomplete="username"></div>
          ${secretField(0, s.imap.hasPass, "i-pass", "Password", "Same app password as SMTP, usually.")}
          <div class="test-row"><button class="btn secondary small" id="t-imap">Test connection</button><span class="test-result" id="r-imap"></span></div>
        </div>

        <div class="group-caption">Matrix</div>
        <div class="group-card card" style="padding:14px 16px">
          <div class="field"><label>Homeserver</label><input class="text-input" id="m-hs" value="${esc(s.matrix.homeserver)}" placeholder="https://matrix.org"></div>
          ${secretField(0, s.matrix.hasToken, "m-token", "Access token", "Element → Settings → Help → Access token.")}
          ${s.matrix.userId ? `<div class="hint">Signed in as <b>${esc(s.matrix.userId)}</b></div>` : ""}
          <div class="test-row" style="margin-top:8px"><button class="btn secondary small" id="t-matrix">Test connection</button><span class="test-result" id="r-matrix"></span></div>
        </div>

        <div class="group-caption">Google Contacts</div>
        <div class="group-card card" style="padding:14px 16px">
          <div class="group-row" style="padding:0 0 10px;background:none;border:none">${dot(st.google)}<div class="rlabel"><div class="t1">Google Contacts</div><div class="t2">${s.google.connected ? "Connected as " + esc(s.google.email || "your account") : "Not connected"}</div></div></div>
          <div class="field"><label>OAuth client ID</label><input class="text-input" id="g-id" value="${esc(s.google.clientId || "")}" placeholder="1234…apps.googleusercontent.com"></div>
          ${secretField(0, s.google.hasClientSecret, "g-secret", "OAuth client secret", "")}
          <div class="hint" style="margin-bottom:10px"><b>One-time setup</b> — Google Cloud Console → new project → enable the <b>People API</b> → Credentials → Create OAuth client ID (Web application) → add this redirect URI:<br><code id="g-uri" style="word-break:break-all;user-select:all">…</code><br>Then paste the ID + secret above, save, and connect.</div>
          <div class="test-row">
            <button class="btn secondary small" id="g-connect">${s.google.connected ? "Reconnect" : "Save & connect Google"}</button>
            ${s.google.connected ? `<button class="btn secondary small" id="g-disconnect">Disconnect</button>` : ""}
          </div>
        </div>

        <div style="padding:8px 32px 40px"><button class="btn" id="save-all" style="width:100%">Save settings</button></div>
      </div>
      ${tabBar("settings")}
    </div>`;
  bindTabs(app);

  const test = (btnId, resId, service) => {
    $(btnId).addEventListener("click", async () => {
      const el = $(resId);
      el.className = "test-result"; el.textContent = "Testing…";
      try { await saveAll(true); await api("/api/settings/test", { method: "POST", body: JSON.stringify({ service }) }); el.className = "test-result ok"; el.innerHTML = icon("check") + " Connected"; }
      catch (e) { el.className = "test-result err"; el.innerHTML = icon("close") + " " + esc(e.message); }
    });
  };
  test("#t-smtp", "#r-smtp", "smtp");
  test("#t-imap", "#r-imap", "imap");
  test("#t-matrix", "#r-matrix", "matrix");

  api("/api/google/redirect-uri").then((r) => { const el = $("#g-uri"); if (el) el.textContent = r.redirect_uri; }).catch(() => {});

  $("#notify-toggle").addEventListener("change", (e) => { setNotify(e.target.checked); });

  $("#migrate-mail").addEventListener("click", async () => {
    const el = $("#migrate-result");
    el.className = "test-result"; el.textContent = "Migrating\u2026";
    try {
      const r = await api("/api/migrate-participants", { method: "POST" });
      const bits = [`${r.enriched} enriched`, `${r.moved} moved`];
      if (r.unresolved) bits.push(`${r.unresolved} unresolved`);
      const groups = (r.groups || []).map((g) => g.name).filter(Boolean).join(", ");
      el.className = "test-result ok";
      el.innerHTML = icon("check") + " " + esc(bits.join(" \u00b7 ")) + (groups ? `<br>Groups: ${esc(groups)}` : "");
      toast(`Migration done \u2014 ${bits.join(", ")}.`);
      await loadConversations();
    } catch (e) { el.className = "test-result err"; el.innerHTML = icon("close") + " " + esc(e.message); }
  });

  $("#g-connect").addEventListener("click", async () => {
    try {
      await saveAll(true);
      const r = await api("/api/google/auth");
      location.href = r.url;
    } catch (e) { toast(e.message, true); }
  });
  const gd = $("#g-disconnect");
  if (gd) gd.addEventListener("click", async () => {
    await api("/api/google/disconnect", { method: "POST" });
    toast("Google disconnected.");
    await loadSettings(); renderSettings();
  });

  async function saveAll(quiet) {
    const secret = (id, has) => { const v = $(id).value; return v ? v : (has ? "__KEEP__" : ""); };
    await api("/api/settings", { method: "POST", body: JSON.stringify({ section: "smtp", values: {
      host: $("#s-host").value.trim(), port: Number($("#s-port").value) || 465, secure: $("#s-sec").value,
      user: $("#s-user").value.trim(), fromName: $("#s-name").value.trim(), from: $("#s-from").value.trim(),
      pass: secret("#s-pass", s.smtp.hasPass),
    }})});
    await api("/api/settings", { method: "POST", body: JSON.stringify({ section: "imap", values: {
      host: $("#i-host").value.trim(), port: Number($("#i-port").value) || 993,
      user: $("#i-user").value.trim(), pass: secret("#i-pass", s.imap.hasPass),
    }})});
    await api("/api/settings", { method: "POST", body: JSON.stringify({ section: "matrix", values: {
      homeserver: $("#m-hs").value.trim().replace(/\/+$/, ""), token: secret("#m-token", s.matrix.hasToken),
    }})});
    await api("/api/settings", { method: "POST", body: JSON.stringify({ section: "google", values: {
      clientId: $("#g-id").value.trim(), clientSecret: secret("#g-secret", s.google.hasClientSecret),
    }})});
    if (!quiet) { toast("Settings saved."); await loadSettings(); renderSettings(); }
  }
  $("#save-all").addEventListener("click", () => saveAll(false).catch((e) => toast(e.message, true)));
  $("#poll").addEventListener("click", async () => {
    try { await api("/api/poll", { method: "POST" }); toast("Checked for new messages."); await loadConversations(); }
    catch (e) { toast(e.message, true); }
  });
}

// ---------- router ----------

function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

async function route() {
  stopTimer();
  let h = location.hash || "#/conversations";
  if (h === "#/chats" || h.startsWith("#/chats/")) {
    // Legacy route from before the rename — forward to the new one.
    h = "#/conversations" + h.slice("#/chats".length);
    location.hash = h;
  }
  const parts = h.replace(/^#\//, "").split("/");
  try {
    if (parts[0] === "conversations" && parts[1]) {
      await loadConversation(parts[1]);
      renderConversationDetail();
      state.timer = setInterval(refreshConversation, 10000);
    } else if (parts[0] === "conversations") {
      await pollConversations();
      renderConversations();
      // Data arrives via the global poller below; re-render only when the
      // list actually changed so the view doesn't flicker while idle.
      state.timer = setInterval(() => { if ((location.hash || "#/conversations") === "#/conversations") renderConversations(true); }, 15000);
    } else if (parts[0] === "people" && parts[1] === "new") {
      await loadContacts();
      openContactSheet(null);
      location.hash = "#/people";
    } else if (parts[0] === "people" && parts[1]) {
      await loadContacts();
      renderPersonDetail(parts[1]);
    } else if (parts[0] === "people") {
      await loadContacts();
      renderPeople();
    } else if (parts[0] === "group" && parts[1] === "new") {
      await loadContacts();
      renderNewGroup();
    } else if (parts[0] === "settings") {
      await loadSettings();
      renderSettings();
      const qp = new URLSearchParams(location.search);
      const g = qp.get("google");
      if (g === "connected") toast("Google connected — tap ⤓ Import on the People tab to pick contacts.");
      else if (g === "denied") toast("Google sign-in was cancelled.", true);
      else if (g === "error") toast("Google sign-in failed — check the client ID and secret, then try again.", true);
      if (g) history.replaceState(null, "", "/#/settings");
    } else {
      location.hash = "#/conversations";
    }
  } catch (e) {
    $("#app").innerHTML = `<div class="view"><div class="nav-bar"><div class="nav-title">Relay</div></div>
      <div class="empty">${icon("warn", "big")}<h3>Couldn't load</h3><p>${esc(e.message)}</p></div></div>`;
  }
}

window.addEventListener("hashchange", route);
route();
// Global notifier: polls the conversation list on every view so new inbound
// messages raise a desktop notification and update the tab title badge.
setInterval(pollConversations, 15000);
