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
  filesOpen: false,    // shared-files drawer (narrow screens)
  fileSearch: "",      // shared-files widget search query (last 90 days)
  fileResults: null,   // search matches; null = browsing recent files
  lightbox: null,      // { files, index } when the preview overlay is open
  dropDraft: false,    // set before re-rendering after a successful send
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

/** Attachment chips inside a message bubble. Images are preview chips (no inline
    thumbnails — previews live in the Shared files widget); video/audio get
    small players; the rest are download chips. */
function bubbleAtts(m) {
  const atts = m.attachments || [];
  if (!atts.length) return "";
  return `<div class="att-list">${atts.map((a) => {
    const kind = attKind(a.mime);
    const url = attachUrl(a.id);
    const label = esc(a.filename || "file");
    if (kind === "image") {
      return `<button class="att att-file att-imgchip" data-att="${esc(a.id)}" title="${label} — ${esc(fmtSize(a.size))}">${icon("image")}<span class="att-name">${label}</span><span class="att-size">${esc(fmtSize(a.size))}</span></button>`;
    }
    if (kind === "video") {
      return `<video class="att att-vid" src="${url}" controls preload="metadata" playsinline></video>`;
    }
    if (kind === "audio") {
      return `<audio class="att att-aud" src="${url}" controls preload="metadata"></audio>`;
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

function renderConversations() {
  const q = state.search.toLowerCase();
  const list = state.conversations.filter((c) =>
    !q || c.title.toLowerCase().includes(q) || (c.members || []).some((m) => m.name.toLowerCase().includes(q)));
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
  state.filesOpen = false;
  state.fileSearch = "";
  state.fileResults = null;
  try {
    const f = await api("/api/conversations/" + encodeURIComponent(id) + "/files?limit=30");
    state.files = f.files || [];
  } catch { state.files = []; }
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

/** Refresh the widget list, honoring an active search. */
async function refreshFiles() {
  if (!state.conv) return;
  try {
    if (state.fileSearch) {
      const f = await api("/api/conversations/" + encodeURIComponent(state.conv.id) + "/files?limit=30&days=90&q=" + encodeURIComponent(state.fileSearch));
      state.fileResults = f.files || [];
    } else {
      const f = await api("/api/conversations/" + encodeURIComponent(state.conv.id) + "/files?limit=30");
      state.files = f.files || [];
      state.fileResults = null;
    }
  } catch { /* widget keeps its old list */ }
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
      : `<span class="ft-prev ft-ic ft-${kind}">${icon(attIconName(kind))}</span>`;
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
  if (!panel || !state.conv) return;
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
    // A stack opens the lightbox on that message's images; a lone file opens
    // it in the widget's current list.
    if (e.type === "stack") openLightbox(e.images, 0);
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
  for (const m of state.messages) {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) { body += `<div class="day-divider">${esc(day)}</div>`; lastDay = day; }
    const out = m.direction === "out";
    const canReply = m.channel === "email" && !out && m.message_id;
    body += `<div class="msg ${out ? "out" : "in"}${m.status === "failed" ? " failed" : ""}">
      ${!out && conv.is_group ? `<div class="sender-name">${esc(senderName(m))}</div>` : ""}
      <div class="bubble">${m.subject ? `<div class="subject">${esc(m.subject)}</div>` : ""}<span class="bubble-text">${bubbleText(m)}</span>${bubbleAtts(m)}</div>
      <div class="meta-line">${chanPill(m.channel)}<span>${fmtTime(m.created_at)}</span>${m.status === "failed" ? `<span style="color:var(--red);font-weight:700">· failed to send</span><button class="retry-btn" data-retry="${m.id}" title="Try sending again">${icon("retry")}Retry</button>` : ""}${canReply ? `<button class="reply-btn" data-reply="${m.id}" title="Reply to this email in thread">${icon("reply")}Reply</button>` : ""}</div>
    </div>`;
  }

  const hints = Object.entries(conv.hints || {}).filter(([, v]) => v).map(([, v]) => esc(v));
  const pending = state.pendingFiles;

  app.innerHTML = `
    <div class="view conv-view">
      <div class="conv-layout${state.filesOpen ? " files-open" : ""}">
        <div class="conv-main">
          <div class="nav-bar">
            <button class="nav-back" id="back">${icon("back")}Conversations</button>
            ${avatarHtml(conv.title, conv.is_group ? "#8e8e93" : (conv.members[0]?.color || "#8e8e93"), 48, conv.is_group, conv.is_group ? null : conv.members[0]?.avatar_url)}
            <div style="flex:1;min-width:0">
              <div class="nav-title small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(conv.title)}</div>
              <div style="font-size:12px;color:var(--label-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(memberNames)}${conv.is_group ? " · " + (conv.members.length + 1) + "/8" : ""}</div>
            </div>
            <button class="nav-action files-toggle" id="files-toggle" aria-label="Shared files" title="Shared files">${icon("files")}${state.files.length ? `<span class="ft-badge">${state.files.length}</span>` : ""}</button>
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
            <div class="grow">
              ${pending.length ? `<div class="pending-files" id="pending">${pending.map((f, i) => `
                <span class="pchip">${icon(attIconName(attKind(f.type)))}<span class="pchip-name">${esc(f.name)}</span><span class="pchip-size">${esc(fmtSize(f.size))}</span><button class="pchip-x" data-pchip="${i}" aria-label="Remove ${esc(f.name)}">${icon("close")}</button></span>`).join("")}</div>` : ""}
              <div class="subject-line${ch === "email" && !state.replyTo ? " show" : ""}" id="subj-wrap"><input class="text-input" id="subject" placeholder="Subject"></div>
              <textarea id="draft" rows="1" placeholder="Message ${ch ? CHAN_META[ch].label : ""}…"></textarea>
            </div>
            ${ch === "email" ? `<button class="attach-btn" id="attach" aria-label="Attach files" title="Attach files (25 MB max each)">${icon("paperclip")}</button><input type="file" id="filepick" multiple hidden>` : ""}
            <button class="send-btn" id="send" aria-label="Send" ${ch ? "" : "disabled"}>${icon("send")}</button>
          </div>
        </div>
        ${filesPanelHtml()}
      </div>
    </div>`;

  $("#back").addEventListener("click", () => { location.hash = "#/conversations"; });
  const ge = $("#grp-edit");
  if (ge) ge.addEventListener("click", () => openGroupSheet(conv));

  // Shared-files widget: toggle + tiles + bubble attachments.
  $("#files-toggle").addEventListener("click", () => { state.filesOpen = !state.filesOpen; renderConversationDetail(); });
  const fpc = $("#fp-close");
  if (fpc) fpc.addEventListener("click", () => { state.filesOpen = false; renderConversationDetail(); });
  wireFilesPanel();
  $$("#msgs [data-att]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.att;
    const i = activeFiles().findIndex((f) => String(f.id) === String(id));
    if (i >= 0) openLightbox(activeFiles(), i);
    else {
      const m = state.messages.flatMap((x) => x.attachments || []).find((a) => String(a.id) === String(id));
      if (m) openLightbox([{ id: m.id, filename: m.filename, mime: m.mime, size: m.size }], 0);
    }
  }));

  $$("#seg button").forEach((b) => b.addEventListener("click", () => {
    state.chanSel[conv.id] = b.dataset.ch;
    localStorage.setItem("relay_chan_" + conv.id, b.dataset.ch);
    state.replyTo = null; // replies only thread on email
    renderConversationDetail();
    $("#draft").focus();
  }));

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
}
function senderName(m) {
  // Best-effort: match inbound message to a member via external hints is unreliable;
  // show the conversation title for DMs, generic for groups handled by caller.
  return "";
}

async function sendMsg() {
  const conv = state.conv;
  const ch = selectedChannel();
  if (!conv || !ch || state.sending) return;
  const body = $("#draft").value;
  const files = state.pendingFiles.slice();
  if (!body.trim() && !files.length) return;
  if (files.length && ch !== "email") { toast("Files can only be sent by email — switch channels or remove them.", true); return; }
  state.sending = true;
  $("#send").disabled = true;
  try {
    let r;
    if (files.length) {
      const form = new FormData();
      form.set("channel", ch);
      form.set("body", body);
      form.set("subject", ch === "email" ? ($("#subject")?.value || "") : "");
      if (state.replyTo) form.set("in_reply_to", state.replyTo.id);
      for (const f of files) form.append("files", f, f.name);
      r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages", { method: "POST", body: form });
    } else {
      r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages", {
        method: "POST",
        body: JSON.stringify({ channel: ch, body, subject: ch === "email" ? ($("#subject")?.value || "") : "", in_reply_to: state.replyTo ? state.replyTo.id : undefined }),
      });
    }
    state.messages.push(r.message);
    state.replyTo = null;
    state.pendingFiles = [];
    state.dropDraft = true; // the send consumed the draft — don't restore it
    await refreshFiles();
    renderConversationDetail();
  } catch (e) {
    if (e.failed_message) {
      state.messages.push(e.failed_message);
      state.replyTo = null;
      state.pendingFiles = [];
      state.dropDraft = true;
      await refreshFiles();
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
      // Data arrives via the global poller below; this just re-renders.
      state.timer = setInterval(() => { if ((location.hash || "#/conversations") === "#/conversations") renderConversations(); }, 15000);
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
