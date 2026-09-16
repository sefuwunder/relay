/* Relay — glossy iOS unified messenger frontend */
"use strict";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtPhone = (d) => { const s = String(d || "").replace(/\D/g, ""); return s.length === 10 ? `(${s.slice(0, 3)}) ${s.slice(3, 6)}-${s.slice(6)}` : s; };
const normDigits = (d) => String(d || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); return m ? `${MON3[Number(m[2]) - 1]} ${Number(m[3])}` : (iso || ""); };

const CHAN_META = {
  email: { label: "Email", glyph: "✉️" },
  sms: { label: "SMS", glyph: "💬" },
  matrix: { label: "Matrix", glyph: "🟣" },
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
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* noop */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
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
// re-renders while the chat is open.
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
  return `<span class="chan-pill ${ch}">${m.glyph} ${m.label}</span>`;
}

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
    { id: "chats", glyph: "💬", label: "Chats", badge: unread },
    { id: "people", glyph: "👥", label: "People", badge: 0 },
    { id: "settings", glyph: "⚙️", label: "Settings", badge: 0 },
  ];
  return `<nav class="tab-bar">${tabs.map((t) =>
    `<button class="tab${active === t.id ? " active" : ""}" data-tab="${t.id}">
      <span class="glyph">${t.glyph}</span><span>${t.label}</span>
      ${t.badge ? `<span class="badge">${t.badge}</span>` : ""}
    </button>`).join("")}</nav>`;
}

function bindTabs(root) {
  $$(".tab", root).forEach((b) => b.addEventListener("click", () => { location.hash = "#/" + b.dataset.tab; }));
}

// ---------- chats list ----------

async function loadConversations() {
  const r = await api("/api/conversations");
  state.conversations = r.conversations || [];
}

function renderChats() {
  const q = state.search.toLowerCase();
  const list = state.conversations.filter((c) =>
    !q || c.title.toLowerCase().includes(q) || (c.members || []).some((m) => m.name.toLowerCase().includes(q)));
  const app = $("#app");
  app.innerHTML = `
    <div class="view">
      <div class="nav-bar"><div class="nav-title">Chats</div>
        <button class="nav-action" id="new-group">＋ Group</button></div>
      <div class="search-wrap"><div class="search-field">🔍<input id="q" placeholder="Search" value="${esc(state.search)}"></div></div>
      <div class="scroll">
        ${list.length ? list.map((c) => `
          <button class="chat-row" data-id="${c.id}">
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
        : `<div class="empty"><div class="glyph">💬</div><h3>No chats yet</h3><p>Add people in the People tab,<br>then pick a channel and say hello.</p></div>`}
      </div>
      ${tabBar("chats")}
    </div>`;
  bindTabs(app);
  $("#new-group").addEventListener("click", () => { location.hash = "#/group/new"; });
  const qi = $("#q");
  qi.addEventListener("input", () => { state.search = qi.value; renderChats(); const nq = $("#q"); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); });
  $$(".chat-row", app).forEach((r) => r.addEventListener("click", () => { location.hash = "#/chats/" + r.dataset.id; }));
}

// ---------- message view ----------

async function loadConversation(id) {
  const r = await api("/api/conversations/" + encodeURIComponent(id));
  state.conv = r.conversation;
  const m = await api("/api/conversations/" + encodeURIComponent(id) + "/messages?limit=100");
  state.messages = m.messages || [];
  state.replyTo = null;
  if (!state.messages.length && state.conv && !state.conv.is_group) {
    // Empty chat: pre-populate the first message from the last email exchange.
    api("/api/conversations/" + encodeURIComponent(id) + "/seed-email", { method: "POST" })
      .then(async (se) => {
        if (se && se.seeded && state.conv && state.conv.id === id) {
          const m2 = await api("/api/conversations/" + encodeURIComponent(id) + "/messages?limit=100");
          state.messages = m2.messages || [];
          renderChatDetail();
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

function renderChatDetail() {
  const conv = state.conv;
  if (!conv) { location.hash = "#/chats"; return; }
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
      <div class="bubble">${m.subject ? `<div class="subject">${esc(m.subject)}</div>` : ""}<span class="bubble-text">${bubbleText(m)}</span></div>
      <div class="meta-line">${chanPill(m.channel)}<span>${fmtTime(m.created_at)}</span>${m.status === "failed" ? `<span style="color:var(--red);font-weight:700">· failed to send</span>` : ""}${canReply ? `<button class="reply-btn" data-reply="${m.id}" title="Reply to this email in thread">↩ Reply</button>` : ""}</div>
    </div>`;
  }

  const hints = Object.entries(conv.hints || {}).filter(([, v]) => v).map(([, v]) => esc(v));

  app.innerHTML = `
    <div class="view">
      <div class="nav-bar">
        <button class="nav-back" id="back">‹ Chats</button>
        ${avatarHtml(conv.title, conv.is_group ? "#8e8e93" : (conv.members[0]?.color || "#8e8e93"), 48, conv.is_group, conv.is_group ? null : conv.members[0]?.avatar_url)}
        <div style="flex:1;min-width:0">
          <div class="nav-title small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(conv.title)}</div>
          <div style="font-size:12px;color:var(--label-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(memberNames)}${conv.is_group ? " · " + (conv.members.length + 1) + "/8" : ""}</div>
        </div>
        ${conv.is_group ? `<button class="nav-action" id="grp-edit">Edit</button>` : ""}
      </div>
      <div class="msg-scroll" id="msgs">${body || `<div class="empty"><div class="glyph">👋</div><h3>Start the conversation</h3><p>Pick a channel below and send the first message.</p></div>`}</div>
      <div class="chan-bar">
        ${conv.channels.length ? `
          <div class="seg" id="seg">${conv.channels.map((c) =>
            `<button data-ch="${c}" class="${c === ch ? "on" : ""}">${CHAN_META[c].glyph} ${CHAN_META[c].label}</button>`).join("")}</div>
          ${hints.length ? `<div class="chan-hint">${hints.join(" ")}</div>` : ""}`
        : `<div class="chan-hint">No channels available yet. ${hints.join(" ") || "Add contact details in the People tab."}</div>`}
      </div>
      <div class="composer">
        ${state.replyTo ? `<div class="reply-bar"><span>↩ Replying to <b>${esc(state.replyTo.subject || "(no subject)")}</b> — threads under the original email</span><button id="reply-cancel" title="Cancel reply">×</button></div>` : ""}
        <div class="grow">
          <div class="subject-line${ch === "email" && !state.replyTo ? " show" : ""}" id="subj-wrap"><input class="text-input" id="subject" placeholder="Subject"></div>
          <textarea id="draft" rows="1" placeholder="Message ${ch ? CHAN_META[ch].label : ""}…"></textarea>
        </div>
        <button class="send-btn" id="send" ${ch ? "" : "disabled"}>↑</button>
      </div>
    </div>`;

  $("#back").addEventListener("click", () => { location.hash = "#/chats"; });
  const ge = $("#grp-edit");
  if (ge) ge.addEventListener("click", () => openGroupSheet(conv));

  $$("#seg button").forEach((b) => b.addEventListener("click", () => {
    state.chanSel[conv.id] = b.dataset.ch;
    localStorage.setItem("relay_chan_" + conv.id, b.dataset.ch);
    state.replyTo = null; // replies only thread on email
    renderChatDetail();
    $("#draft").focus();
  }));

  const draft = $("#draft");
  draft.addEventListener("input", () => { draft.style.height = "auto"; draft.style.height = Math.min(draft.scrollHeight, 120) + "px"; });
  draft.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

  $("#send").addEventListener("click", sendMsg);

  $$("#msgs [data-reply]").forEach((b) => b.addEventListener("click", () => {
    const target = state.messages.find((m) => m.id === b.dataset.reply);
    if (target) { state.replyTo = target; renderChatDetail(); $("#draft")?.focus(); }
  }));
  const rc = $("#reply-cancel");
  if (rc) rc.addEventListener("click", () => { state.replyTo = null; renderChatDetail(); });

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
  if (!body.trim()) return;
  state.sending = true;
  $("#send").disabled = true;
  try {
    const r = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages", {
      method: "POST",
      body: JSON.stringify({ channel: ch, body, subject: ch === "email" ? ($("#subject")?.value || "") : "", in_reply_to: state.replyTo ? state.replyTo.id : undefined }),
    });
    state.messages.push(r.message);
    state.replyTo = null;
    renderChatDetail();
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.sending = false;
    const btn = $("#send");
    if (btn) btn.disabled = false;
  }
}

async function refreshChat() {
  const conv = state.conv;
  if (!conv) return;
  try {
    const m = await api("/api/conversations/" + encodeURIComponent(conv.id) + "/messages?limit=100");
    const before = state.messages.length;
    state.messages = m.messages || [];
    if (state.messages.length !== before) {
      const sc = $("#msgs");
      const nearBottom = sc && (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120);
      renderChatDetail();
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
        <button class="nav-action" id="import-contacts">⤓ Import</button>
        <button class="nav-action" id="new-group2">＋ Group</button></div>
      <div class="scroll"><div class="people-grid">
        ${state.contacts.map((c) => `
          <button class="person-card card" data-id="${c.id}">
            ${avatarHtml(c.name, c.color, 72, false, c.avatar_url)}
            <div class="pname">${esc(c.name)}</div>
            <div class="chan-dots">${["email", "sms", "matrix"].map((ch) =>
              `<span class="chan-dot ${ch}" style="${c.channels.includes(ch) ? "" : "opacity:.18;filter:grayscale(1)"}" title="${CHAN_META[ch].label}"></span>`).join("")}</div>
          </button>`).join("")}
        <button class="person-card add" id="add-person" ${full ? "disabled" : ""}>
          <div class="glyph">＋</div>
          <div>${full ? `Full — ${state.maxPeople} max` : "Add person"}</div>
        </button>
      </div>
      <div class="hint" style="text-align:center;padding:0 24px 24px">Relay is for your inner circle — up to ${state.maxPeople || 8} people, ${state.maxPeople || 8} per group. Tap a person to see their channels, then message them. Archived people don't count against the limit.</div>
      ${state.archivedContacts.length ? `
      <div class="group-caption">Archived · ${state.archivedContacts.length}</div>
      <div class="ios-group card">
        ${state.archivedContacts.map((c) => `
          <button class="ios-row arch-row" data-id="${c.id}">
            ${avatarHtml(c.name, c.color, 40, false, c.avatar_url)}
            <div class="rlabel"><div class="t1">${esc(c.name)}</div><div class="t2">Archived — tap to restore</div></div>
            <span class="arch-badge">📦</span>
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
        <button data-tab="sent" class="on">\u2709\uFE0F Sent mail</button><button data-tab="sms">\uD83D\uDCAC SMS</button><button data-tab="google">\uD83D\uDD35 Google</button><button data-tab="vcf">\uD83D\uDCC7 vCard</button>
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
      <div class="search-field" style="margin-bottom:10px">\uD83D\uDD0D<input id="imp-q" placeholder="Search" value="${esc(q)}"></div>
      <div class="hint" style="margin-bottom:8px">${remaining} of ${state.maxPeople || 8} spots left \u2014 Relay stays small on purpose.</div>
      <div class="ios-group card" style="margin:0;max-height:38vh;overflow-y:auto">
        ${list.map((c) => { const idx = items.indexOf(c); return `
          <div class="pick-row${picked.has(idx) ? " on" : ""}${c.disabled ? " disabled" : ""}" data-idx="${idx}">
            <span class="check">\u2713</span>${avatarHtml(c.name || c.email, "#0a84ff", 48)}
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
    <div class="ios-group card" style="margin:0;max-height:40vh;overflow-y:auto">
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
  body.innerHTML = `<div class="empty"><div class="glyph">\u23F3</div><p>Reading recent text conversations\u2026</p></div>`;
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
      body.innerHTML = `<div class="empty"><div class="glyph">\uD83D\uDCAC</div><h3>No recent texts</h3><p>Scanned ${n} inbox message${n === 1 ? "" : "s"} from the last 14 days \u2014 none were Google Voice SMS forwards.</p></div>`;
      return;
    }
    contactPicker(body, close, items, "Creates contacts with the Google Voice number filled in \u2014 ready for SMS.", {
      onAttach: (item) => openAttachSheet(item, () => drawSmsTab(body, close)),
    });
  } catch (e) {
    const needSettings = /Settings/.test(e.message || "");
    body.innerHTML = `<div class="empty"><div class="glyph">${needSettings ? "\uD83D\uDD0C" : "\u26A0\uFE0F"}</div>
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
  body.innerHTML = `<div class="empty"><div class="glyph">\u23F3</div><p>Reading your last 40 sent emails\u2026</p></div>`;
  try {
    const r = await api("/api/sent-contacts");
    const items = (r.contacts || []).map((c) => ({
      name: c.name, email: c.email,
      sub: c.count > 1 ? `\u00D7${c.count} emails` : "1 email",
    }));
    if (!items.length) {
      body.innerHTML = `<div class="empty"><div class="glyph">\uD83D\uDCED</div><h3>No sent mail found</h3><p>Your Sent folder is empty or couldn't be read.</p></div>`;
      return;
    }
    contactPicker(body, close, items, "Harvested from your last 40 sent emails \u2014 names and addresses are imported.");
  } catch (e) {
    const needSettings = /Settings/.test(e.message || "");
    body.innerHTML = `<div class="empty"><div class="glyph">${needSettings ? "\uD83D\uDD0C" : "\u26A0\uFE0F"}</div>
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
  body.innerHTML = `<div class="empty"><div class="glyph">\u23F3</div><p>Loading your Google contacts\u2026</p></div>`;
  try {
    const r = await api("/api/google/contacts");
    const items = (r.contacts || []).map((c) => ({ name: c.name, email: c.email, sub: c.phone || "" }));
    if (!items.length) {
      body.innerHTML = `<div class="empty"><div class="glyph">\uD83D\uDCC7</div><h3>No Google contacts found</h3><p>Your Google contacts list is empty.</p></div>`;
      return;
    }
    contactPicker(body, close, items, "Names and email addresses are imported. Add a Google Voice number afterwards (Edit person) to enable SMS.");
  } catch (e) {
    body.innerHTML = `<div class="empty"><div class="glyph">\uD83D\uDD0C</div><h3>Google isn't connected</h3>
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
    <button class="btn" id="vcf-pick" style="width:100%">\uD83D\uDCC7 Choose vCard file…</button>
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
        <button class="nav-back" id="back">‹ People</button>
        <div class="nav-title small" style="flex:1"></div>
        <button class="nav-action" id="edit">Edit</button>
      </div>
      <div class="scroll">
        <div class="profile-hero">
          ${avatarHtml(c.name, c.color, 72, false, c.avatar_url)}
          <h2>${esc(c.name)}</h2>
          <div class="sub">${c.archived ? "📦 Archived · " : ""}${c.channels.length ? c.channels.map((ch) => CHAN_META[ch].label).join(" · ") : "No channels yet"}</div>
        </div>
        <div style="padding:0 32px"><button class="btn" id="message" style="width:100%">Message</button></div>
        <div class="group-caption">Channels</div>
        <div class="ios-group card">
          ${rows.map((r) => `
            <div class="ios-row"><span class="chan-dot ${r.ch}"></span>
              <div class="rlabel"><div class="t1">${r.t1}</div><div class="t2">${esc(r.t2)}</div></div>
            </div>`).join("")}
        </div>
        ${c.notes ? `<div class="group-caption">Notes</div><div class="ios-group card"><div class="ios-row"><div class="rlabel"><div class="t1" style="font-weight:400">${esc(c.notes)}</div></div></div></div>` : ""}
        <div style="padding:8px 32px 32px;display:flex;flex-direction:column;gap:10px">
          ${c.archived
            ? `<button class="btn" id="unarchive" style="width:100%">Unarchive person</button>`
            : `<button class="btn" id="archive" style="width:100%">📦 Archive person</button>`}
          <button class="btn danger" id="del" style="width:100%">Remove person</button>
        </div>
      </div>
      ${tabBar("people")}
    </div>`;
  bindTabs(app);
  $("#back").addEventListener("click", () => { location.hash = "#/people"; });
  $("#edit").addEventListener("click", () => openContactSheet(c));
  $("#message").addEventListener("click", () => { location.hash = "#/chats/" + c.conversation_id; });
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
    if (!confirm(`Remove ${c.name} from Relay? Their chats will be deleted.`)) return;
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
      <div class="nav-bar"><button class="nav-back" id="back">‹ People</button><div class="nav-title small" style="flex:1">New group</div>
        <button class="nav-action" id="create" ${picked.size ? "" : "disabled"}>Create</button></div>
      <div class="scroll">
        <div style="padding:16px 16px 0"><div class="field"><label>Group name</label><input class="text-input" id="g-name" placeholder="Weekend crew" maxlength="60"></div>
        <div class="field"><label>Matrix room <span style="font-weight:400">(optional)</span></label><input class="text-input" id="g-room" placeholder="!xyz:matrix.org"></div></div>
        <div class="group-caption">Members · ${picked.size + 1} of ${state.maxPeople || 8} (you included)</div>
        <div class="ios-group card">
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
        location.hash = "#/chats/" + r.conversation.id;
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
      await loadConversation(conv.id); renderChatDetail();
    } catch (e) { toast(e.message, true); }
  });
  $("#del", scrim).addEventListener("click", async () => {
    if (!confirm("Delete this group and its messages?")) return;
    await api("/api/conversations/" + conv.id, { method: "DELETE" });
    close(); location.hash = "#/chats";
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
        <div class="ios-group card">
          <div class="ios-row">${dot(st.smtp)}<div class="rlabel"><div class="t1">Email sending (SMTP)</div><div class="t2">${st.smtp ? esc(s.smtp.host) : "Not configured"}</div></div></div>
          <div class="ios-row">${dot(st.imap)}<div class="rlabel"><div class="t1">Inbox (IMAP)</div><div class="t2">${st.imap ? esc(s.imap.host) : "Not configured"}</div></div></div>
          <div class="ios-row">${dot(st.matrix)}<div class="rlabel"><div class="t1">Matrix</div><div class="t2">${st.matrix ? esc(s.matrix.homeserver) : "Not configured"}</div></div></div>
        </div>
        <div style="padding:4px 32px 0"><button class="btn secondary" id="poll" style="width:100%">↻ Check for new messages</button></div>
        ${st.lastPoll && (st.lastPoll.mail || st.lastPoll.matrix) ? `<div class="hint" style="text-align:center">Last check — mail: ${st.lastPoll.mail ? fmtTime(st.lastPoll.mail) : "—"} · matrix: ${st.lastPoll.matrix ? fmtTime(st.lastPoll.matrix) : "—"}</div>` : ""}

        <div class="group-caption">Email sending · SMTP</div>
        <div class="ios-group card" style="padding:14px 16px">
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
        <div class="ios-group card" style="padding:14px 16px">
          <div class="row-2col">
            <div class="field"><label>Host</label><input class="text-input" id="i-host" value="${esc(s.imap.host)}" placeholder="imap.gmail.com"></div>
            <div class="field"><label>Port</label><input class="text-input" id="i-port" value="${esc(String(s.imap.port || 993))}" inputmode="numeric"></div>
          </div>
          <div class="field"><label>Username</label><input class="text-input" id="i-user" value="${esc(s.imap.user)}" autocomplete="username"></div>
          ${secretField(0, s.imap.hasPass, "i-pass", "Password", "Same app password as SMTP, usually.")}
          <div class="test-row"><button class="btn secondary small" id="t-imap">Test connection</button><span class="test-result" id="r-imap"></span></div>
        </div>

        <div class="group-caption">Matrix</div>
        <div class="ios-group card" style="padding:14px 16px">
          <div class="field"><label>Homeserver</label><input class="text-input" id="m-hs" value="${esc(s.matrix.homeserver)}" placeholder="https://matrix.org"></div>
          ${secretField(0, s.matrix.hasToken, "m-token", "Access token", "Element → Settings → Help → Access token.")}
          ${s.matrix.userId ? `<div class="hint">Signed in as <b>${esc(s.matrix.userId)}</b></div>` : ""}
          <div class="test-row" style="margin-top:8px"><button class="btn secondary small" id="t-matrix">Test connection</button><span class="test-result" id="r-matrix"></span></div>
        </div>

        <div class="group-caption">Google Contacts</div>
        <div class="ios-group card" style="padding:14px 16px">
          <div class="ios-row" style="padding:0 0 10px;background:none;border:none">${dot(st.google)}<div class="rlabel"><div class="t1">Google Contacts</div><div class="t2">${s.google.connected ? "Connected as " + esc(s.google.email || "your account") : "Not connected"}</div></div></div>
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
      try { await saveAll(true); await api("/api/settings/test", { method: "POST", body: JSON.stringify({ service }) }); el.className = "test-result ok"; el.textContent = "✓ Connected"; }
      catch (e) { el.className = "test-result err"; el.textContent = "✕ " + e.message; }
    });
  };
  test("#t-smtp", "#r-smtp", "smtp");
  test("#t-imap", "#r-imap", "imap");
  test("#t-matrix", "#r-matrix", "matrix");

  api("/api/google/redirect-uri").then((r) => { const el = $("#g-uri"); if (el) el.textContent = r.redirect_uri; }).catch(() => {});

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
  const h = location.hash || "#/chats";
  const parts = h.replace(/^#\//, "").split("/");
  try {
    if (parts[0] === "chats" && parts[1]) {
      await loadConversation(parts[1]);
      renderChatDetail();
      state.timer = setInterval(refreshChat, 10000);
    } else if (parts[0] === "chats") {
      await loadConversations();
      renderChats();
      state.timer = setInterval(async () => { await loadConversations().catch(() => {}); if ((location.hash || "#/chats") === "#/chats") renderChats(); }, 15000);
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
      location.hash = "#/chats";
    }
  } catch (e) {
    $("#app").innerHTML = `<div class="view"><div class="nav-bar"><div class="nav-title">Relay</div></div>
      <div class="empty"><div class="glyph">⚠️</div><h3>Couldn't load</h3><p>${esc(e.message)}</p></div></div>`;
  }
}

window.addEventListener("hashchange", route);
route();
