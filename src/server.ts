// Relay — small-group unified messaging: email, SMS (Google Voice gateways), Matrix.
// Bun + zero dependencies. Private data (contacts, messages, credentials) lives in
// gitignored ./data and is never pushed.

import {
  openDb, getDb, uid,
  listContacts, getContact, createContact, updateContact, deleteContact, countContacts,
  getConversation, conversationMembers, dmFor, createGroup, listConversations, markRead,
  listMessages, insertMessage, hasExternalId, kvGet, kvSet, MAX_PEOPLE,
  type Contact, type Conversation, type Channel,
} from "./db";
import { sendMail, validateSmtp, gvGatewayAddress, type SmtpConfig } from "./smtp";
import { fetchUnseen, validateImap, extractEmail, harvestSentContacts, harvestRecentSms, gvNumberFrom, latestGvForward, latestEmailWith, stripGvFooter, type ImapConfig } from "./imap";
import { matrixSend, matrixSync, validateMatrix, matrixRooms, type MatrixConfig } from "./matrix";
import {
  googleAuthUrl, exchangeCode, refreshAccessToken, googleAccountEmail, listGoogleContacts,
  type GoogleSettings,
} from "./google";

const PORT = Number(process.env.PORT || 3006);
const DATA_DIR = "./data";

interface Settings {
  smtp: SmtpConfig;
  imap: ImapConfig;
  matrix: MatrixConfig;
  google: GoogleSettings;
}

const DEFAULT_SETTINGS: Settings = {
  smtp: { host: "", port: 465, secure: "ssl", user: "", pass: "", from: "", fromName: "" },
  imap: { host: "", port: 993, user: "", pass: "" },
  matrix: { homeserver: "", token: "", userId: "" },
  google: { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", expiresAt: 0, email: "" },
};

let settings: Settings = structuredClone(DEFAULT_SETTINGS);

async function bootSettings() {
  try {
    const f = (Bun as any).file(`${DATA_DIR}/config.json`);
    if (await f.exists()) {
      const j = await f.json();
      settings = {
        smtp: { ...DEFAULT_SETTINGS.smtp, ...(j.smtp || {}) },
        imap: { ...DEFAULT_SETTINGS.imap, ...(j.imap || {}) },
        matrix: { ...DEFAULT_SETTINGS.matrix, ...(j.matrix || {}) },
        google: { ...DEFAULT_SETTINGS.google, ...(j.google || {}) },
      };
    }
  } catch { /* keep defaults */ }
}

async function saveSettings() {
  await (Bun as any).write(`${DATA_DIR}/config.json`, JSON.stringify(settings, null, 2));
}

openDb(`${DATA_DIR}/relay.db`);
await bootSettings();

// ---------- helpers ----------

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

function smtpReady(): boolean {
  return !!(settings.smtp.host && settings.smtp.from);
}
function imapReady(): boolean {
  return !!(settings.imap.host && settings.imap.user);
}
function matrixReady(): boolean {
  return !!(settings.matrix.homeserver && settings.matrix.token);
}
function googleReady(): boolean {
  return !!(settings.google.clientId && settings.google.refreshToken);
}

/** Import picked contacts (from Google, sent mail, or recent SMS). Shared by all. */
// 10-digit NANP digits for a GV number, tolerating a leading US country code.
const normDigits = (s: string) => s.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

async function handleImportContacts(req: Request): Promise<Response> {
  const b = await readBody(req);
  const items = (Array.isArray(b.contacts) ? b.contacts : [])
    .map((c: any) => ({
      name: String(c.name || "").trim(),
      email: String(c.email || "").trim().toLowerCase(),
      gv: normDigits(String(c.gv_number || "")),
    }))
    .filter((c: any) => c.name || c.email || c.gv);
  const haveEmail = new Set(listContacts().map((c) => c.email.toLowerCase()).filter(Boolean));
  const haveGv = new Set(listContacts().map((c) => normDigits(c.gv_number || "")).filter(Boolean));
  const haveName = new Set(listContacts().map((c) => c.name.toLowerCase()));
  let imported = 0, skipped = 0;
  for (const it of items) {
    if (countContacts() >= MAX_PEOPLE) break;
    if ((it.email && haveEmail.has(it.email)) || (it.gv && haveGv.has(it.gv)) || haveName.has(it.name.toLowerCase())) { skipped++; continue; }
    const c = createContact({
      name: it.name || it.email || it.gv, email: it.email, gv_number: it.gv,
      matrix_id: "", matrix_room_id: "", color: pickColor(it.name || it.email || it.gv), notes: "",
    });
    dmFor(c.id);
    if (it.email) haveEmail.add(it.email);
    if (it.gv) haveGv.add(it.gv);
    haveName.add(c.name.toLowerCase());
    imported++;
  }
  return json({ imported, skipped, capped: countContacts() >= MAX_PEOPLE });
}

// Harvested sent-mail contacts, cached briefly (sent mail barely changes).
let sentCache: { at: number; contacts: { name: string; email: string; count: number }[] } | null = null;
// Recent GV SMS conversations, cached briefly too.
let smsCache: { at: number; conversations: { number: string; name: string; count: number; lastDate: string }[]; scanned: number } | null = null;

/** A live Google access token, refreshing it when expired. */
async function googleToken(): Promise<string> {
  const g = settings.google;
  if (!g.clientId || !g.clientSecret) throw new Error("Add your Google OAuth client in Settings first.");
  if (!g.refreshToken) throw new Error("Connect Google in Settings first.");
  if (g.accessToken && g.expiresAt > Date.now() + 60000) return g.accessToken;
  const t = await refreshAccessToken(g.clientId, g.clientSecret, g.refreshToken);
  g.accessToken = t.access_token;
  g.expiresAt = Date.now() + t.expires_in * 1000;
  await saveSettings();
  return g.accessToken;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "unexpected server error";
}

function atErr(e: unknown): Response {
  const m = errMsg(e);
  if (e instanceof Error && (e.name === "ImapError" || e.name === "SmtpError")) {
    const st = (e as any).status as number;
    if (st === 401 || st === 400) return json({ error: m }, st);
    return json({ error: m }, 502);
  }
  if (e instanceof Error && e.name === "MatrixError") {
    const st = (e as any).status as number;
    if (st === 401 || st === 403) return json({ error: "Matrix rejected that token — check it in Settings" }, 401);
    if (st === 400) return json({ error: m }, 400);
    return json({ error: m }, 502);
  }
  return json({ error: m }, 500);
}


/** Which channels a contact has addresses for (regardless of service config). */
export function contactChannels(c: Contact): Channel[] {
  const out: Channel[] = [];
  if (c.email) out.push("email");
  if (normDigits(c.gv_number).length === 10) out.push("sms");
  if (c.matrix_room_id) out.push("matrix");
  return out;
}

/** Which channels can actually send right now in a conversation. */
export function conversationChannels(conv: Conversation, members: Contact[]): Channel[] {
  const out: Channel[] = [];
  if (!members.length) return out;
  if (smtpReady() && members.every((m) => m.email)) out.push("email");
  if (smtpReady() && members.every((m) => normDigits(m.gv_number).length === 10)) out.push("sms");
  if (matrixReady()) {
    if (conv.is_group ? conv.matrix_room_id : members.every((m) => m.matrix_room_id)) out.push("matrix");
  }
  return out;
}

/** Why a channel is unavailable — shown as a hint in the UI. */
export function channelHints(conv: Conversation, members: Contact[]): Record<Channel, string> {
  const hints = { email: "", sms: "", matrix: "" } as Record<Channel, string>;
  if (!smtpReady()) {
    hints.email = "Add SMTP in Settings to send email.";
    hints.sms = "Add SMTP in Settings to send SMS via Google Voice.";
  } else {
    const noEmail = members.filter((m) => !m.email).map((m) => m.name);
    if (noEmail.length) hints.email = `No email address for: ${noEmail.join(", ")}.`;
    const noSms = members.filter((m) => normDigits(m.gv_number).length !== 10).map((m) => m.name);
    if (noSms.length) hints.sms = `No Google Voice number for: ${noSms.join(", ")}.`;
  }
  if (!matrixReady()) {
    hints.matrix = "Add Matrix in Settings to chat over Matrix.";
  } else if (conv.is_group) {
    if (!conv.matrix_room_id) hints.matrix = "Pick a Matrix room for this group in its settings.";
  } else {
    const noMx = members.filter((m) => !m.matrix_room_id).map((m) => m.name);
    if (noMx.length) hints.matrix = `No Matrix room set for: ${noMx.join(", ")}.`;
  }
  return hints;
}

const AVATAR_COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#64d2ff", "#ffd60a", "#ff6482"];
function pickColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// ---------- sending ----------

/** Newest Google Voice forward seen for a 10-digit number, for reply threading. */
function gvReplyFor(gvNumber: string): { messageId: string; from: string; subject: string } | null {
  const d = normDigits(gvNumber || "");
  if (d.length !== 10) return null;
  try {
    const r = JSON.parse(kvGet("gv:reply:" + d) || "null");
    if (r && typeof r.messageId === "string" && r.messageId && typeof r.from === "string" && r.from) {
      r.messageId = r.messageId.replace(/[\r\n]+/g, "");
      if (r.messageId) return r;
    }
  } catch { /* corrupt entry — treat as no record */ }
  return null;
}

async function sendConversationMessage(convId: string, channel: Channel, body: string, subject: string) {
  const conv = getConversation(convId);
  if (!conv) throw new Error("Conversation not found.");
  const members = conversationMembers(convId);
  const text = body.trim();
  if (!text) throw new Error("Write a message first.");
  const ok = conversationChannels(conv, members);
  if (!ok.includes(channel)) throw new Error(`That channel isn't available here right now.`);

  if (channel === "email") {
    const to = members.map((m) => m.email);
    const subj = subject.trim() || (conv.is_group ? conv.name : `Message for ${members[0]?.name || "you"}`);
    await sendMail(settings.smtp, { to, subject: subj, text });
    return insertMessage({ conversation_id: convId, channel, direction: "out", body: text, subject: subj, external_id: "", status: "sent" });
  }
  if (channel === "sms") {
    // Google Voice only delivers mail sent as a *reply* to its last forward
    // for that number — a fresh mail to the bare gateway address fails. So
    // 1:1 texts go out threaded under the newest GV forward we have seen
    // (recorded by the IMAP poll and the SMS harvester). Groups and unknown
    // numbers fall back to the plain gateway address.
    let to = members.map((m) => gvGatewayAddress(m.gv_number));
    let subj = "sms"; // gateway ignores subject; keep it inert
    let inReplyTo: string | undefined;
    if (members.length === 1) {
      const digits = normDigits(members[0].gv_number);
      let rec = gvReplyFor(members[0].gv_number);
      if (!rec && imapReady()) {
        // No recorded forward (it was likely already \Seen before Relay polled):
        // find the previous thread live so the send is still a reply to it.
        try {
          const live = await latestGvForward(settings.imap, digits);
          if (live) {
            kvSet("gv:reply:" + digits, JSON.stringify(live));
            rec = live;
          }
        } catch { /* fall through to the plain gateway */ }
      }
      // Keep the gateway token's original case — extractEmail() lowercases,
      // which is right for contact matching but not for the reply address.
      const m = rec ? rec.from.match(/<([^<>]+)>/) : null;
      const replyAddr = (m ? m[1] : rec?.from || "").trim();
      if (rec && replyAddr) {
        to = [replyAddr];
        inReplyTo = rec.messageId;
        if (rec.subject) subj = "Re: " + rec.subject.replace(/^Re:\s*/i, "");
      }
    }
    await sendMail(settings.smtp, { to, subject: subj, text, inReplyTo });
    return insertMessage({ conversation_id: convId, channel, direction: "out", body: text, subject: "", external_id: "", status: "sent" });
  }
  // matrix
  const roomId = conv.is_group ? conv.matrix_room_id : members[0].matrix_room_id;
  const eventId = await matrixSend(settings.matrix, roomId, text);
  return insertMessage({ conversation_id: convId, channel, direction: "out", body: text, subject: "", external_id: `matrix:${eventId}`, status: "sent" });
}

// ---------- polling ----------

let lastPoll: { mail: string | null; matrix: string | null; mailError: string | null; matrixError: string | null } = {
  mail: null, matrix: null, mailError: null, matrixError: null,
};

async function pollMail() {
  if (!imapReady()) return;
  try {
    const mails = await fetchUnseen(settings.imap, 50);
    const contacts = listContacts();
    const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c]));
    const byGv = new Map(contacts.map((c) => [normDigits(c.gv_number), c]).filter(([d]) => d.length === 10) as [string, Contact][]);
    for (const m of mails) {
      const extId = `mail:${m.uid}`;
      if (hasExternalId(extId)) continue;
      const rawFrom = m.from || "";
      const gvNum = gvNumberFrom(rawFrom, m.subject || "", m.returnPath || "");
      let contact: Contact | null = null;
      let channel: Channel = "email";
      let body = m.snippet || "";
      let subject = m.subject || "";
      if (gvNum) {
        const digits = gvNum; // already normalized to 10 digits
        if (m.messageId && m.from) {
          kvSet("gv:reply:" + digits, JSON.stringify({ messageId: m.messageId, from: m.from, subject: m.subject || "" }));
        }
        contact = byGv.get(digits) || null;
        channel = "sms";
        subject = "";
        body = stripGvFooter(body); // drop the GV email footer boilerplate
        if (!body) body = "(empty SMS)";
      } else {
        contact = byEmail.get(extractEmail(rawFrom)) || null;
      }
      if (!contact) continue; // not from someone we track
      const conv = dmFor(contact.id);
      insertMessage({
        conversation_id: conv.id, channel, direction: "in", body, subject,
        external_id: extId, status: "",
      });
    }
    lastPoll.mail = new Date().toISOString();
    lastPoll.mailError = null;
  } catch (e) {
    lastPoll.mailError = errMsg(e);
  }
}

async function pollMatrixOnce() {
  if (!matrixReady()) return;
  const first = !kvGet("matrix_since");
  try {
    const { nextBatch, messages } = await matrixSync(settings.matrix, kvGet("matrix_since") || null, 20000);
    if (nextBatch) kvSet("matrix_since", nextBatch);
    if (!first) {
      const contacts = listContacts();
      const roomToConv = new Map<string, string>();
      for (const c of contacts) if (c.matrix_room_id) roomToConv.set(c.matrix_room_id, dmFor(c.id).id);
      for (const conv of listConversations()) {
        if (conv.is_group && (conv as Conversation).matrix_room_id) roomToConv.set((conv as Conversation).matrix_room_id, conv.id);
      }
      for (const m of messages) {
        const extId = `matrix:${m.eventId}`;
        if (!m.eventId || hasExternalId(extId)) continue;
        const convId = roomToConv.get(m.roomId);
        if (!convId) continue; // room we don't track
        insertMessage({
          conversation_id: convId, channel: "matrix", direction: "in", body: m.body, subject: "",
          external_id: extId, status: "", created_at: new Date(m.ts).toISOString(),
        });
      }
    }
    lastPoll.matrix = new Date().toISOString();
    lastPoll.matrixError = null;
  } catch (e) {
    lastPoll.matrixError = errMsg(e);
  }
}

function startPollers() {
  // IMAP on an interval.
  setInterval(() => { pollMail().catch(() => {}); }, 60000);
  setTimeout(() => { pollMail().catch(() => {}); }, 5000);
  // Matrix long-poll loop.
  (async () => {
    for (;;) {
      try { await pollMatrixOnce(); } catch { /* recorded inside */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
}

// ---------- routes ----------

function contentType(p: string): string {
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".js")) return "text/javascript";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const server = (Bun as any).serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      // ----- status -----
      if (path === "/api/status" && method === "GET") {
        return json({
          smtp: smtpReady(), imap: imapReady(), matrix: matrixReady(), google: googleReady(),
          contacts: listContacts().length, maxPeople: MAX_PEOPLE,
          lastPoll,
        });
      }

      // ----- settings -----
      if (path === "/api/settings" && method === "GET") {
        return json({
          smtp: { ...settings.smtp, pass: undefined, hasPass: !!settings.smtp.pass },
          imap: { ...settings.imap, pass: undefined, hasPass: !!settings.imap.pass },
          matrix: { ...settings.matrix, token: undefined, hasToken: !!settings.matrix.token },
          google: {
            clientId: settings.google.clientId,
            hasClientSecret: !!settings.google.clientSecret,
            connected: googleReady(),
            email: settings.google.email,
          },
        });
      }
      if (path === "/api/settings" && method === "POST") {
        const b = await readBody(req);
        const section = b.section as "smtp" | "imap" | "matrix" | "google";
        if (!["smtp", "imap", "matrix", "google"].includes(section)) return json({ error: "unknown settings section" }, 400);
        const vals = b.values || {};
        // Keep existing secrets when the client sends a placeholder.
        if (section === "smtp" && vals.pass === "__KEEP__") delete vals.pass;
        if (section === "imap" && vals.pass === "__KEEP__") delete vals.pass;
        if (section === "matrix" && vals.token === "__KEEP__") delete vals.token;
        if (section === "google" && vals.clientSecret === "__KEEP__") delete vals.clientSecret;
        (settings as any)[section] = { ...(settings as any)[section], ...vals };
        if (section === "imap") { sentCache = null; smsCache = null; } // harvests came from the old mailbox
        await saveSettings();
        return json({ ok: true });
      }
      if (path === "/api/settings/test" && method === "POST") {
        const b = await readBody(req);
        if (b.service === "smtp") { await validateSmtp(settings.smtp); return json({ ok: true }); }
        if (b.service === "imap") { await validateImap(settings.imap); return json({ ok: true }); }
        if (b.service === "matrix") {
          const { userId } = await validateMatrix(settings.matrix);
          settings.matrix.userId = userId;
          await saveSettings();
          return json({ ok: true, userId });
        }
        if (b.service === "google") {
          const token = await googleToken();
          const email = await googleAccountEmail(token);
          settings.google.email = email;
          await saveSettings();
          return json({ ok: true, email });
        }
        return json({ error: "unknown service" }, 400);
      }
      if (path === "/api/matrix/rooms" && method === "GET") {
        return json({ rooms: await matrixRooms(settings.matrix) });
      }

      // ----- Google Contacts -----
      const googleRedirectUri = () => {
        const u = new URL(req.url);
        return `${u.protocol}//${u.host}/api/google/callback`;
      };
      if (path === "/api/google/redirect-uri" && method === "GET") {
        return json({ redirect_uri: googleRedirectUri() });
      }
      if (path === "/api/google/auth" && method === "GET") {
        if (!settings.google.clientId) return json({ error: "Add your Google OAuth client ID in Settings first." }, 400);
        return json({ url: googleAuthUrl(settings.google.clientId, googleRedirectUri()) });
      }
      if (path === "/api/google/callback" && method === "GET") {
        const code = url.searchParams.get("code");
        const denied = url.searchParams.get("error");
        if (denied || !code) {
          return new Response(null, { status: 302, headers: { Location: "/?google=denied#/settings" } });
        }
        try {
          const g = settings.google;
          const t = await exchangeCode(g.clientId, g.clientSecret, code, googleRedirectUri());
          g.accessToken = t.access_token;
          if (t.refresh_token) g.refreshToken = t.refresh_token;
          g.expiresAt = Date.now() + t.expires_in * 1000;
          g.email = await googleAccountEmail(g.accessToken).catch(() => "");
          await saveSettings();
          return new Response(null, { status: 302, headers: { Location: "/?google=connected#/settings" } });
        } catch (e) {
          return new Response(null, { status: 302, headers: { Location: "/?google=error#/settings" } });
        }
      }
      if (path === "/api/google/contacts" && method === "GET") {
        try {
          const token = await googleToken();
          return json({ contacts: await listGoogleContacts(token) });
        } catch (e) {
          const st = (e as any)?.status === 401 || (e as any)?.status === 403 ? 401 : 502;
          return json({ error: errMsg(e), notConnected: st === 401 }, st);
        }
      }
      // Generic import (sent-mail picks); the google endpoint below is an alias.
      if (path === "/api/import-contacts" && method === "POST") {
        return handleImportContacts(req);
      }
      if (path === "/api/google/import" && method === "POST") {
        return handleImportContacts(req);
      }
      if (path === "/api/google/disconnect" && method === "POST") {
        settings.google.accessToken = "";
        settings.google.refreshToken = "";
        settings.google.expiresAt = 0;
        settings.google.email = "";
        await saveSettings();
        return json({ ok: true });
      }

      // ----- Recent Google Voice SMS conversations (INBOX, last 14 days) -----
      if (path === "/api/recent-sms" && method === "GET") {
        if (!imapReady()) return json({ error: "Add your mail account in Settings first." }, 400);
        try {
          const now = Date.now();
          if (!smsCache || now - smsCache.at > 5 * 60 * 1000) {
            const h = await harvestRecentSms(settings.imap, 14);
            smsCache = { at: now, conversations: h.conversations, scanned: h.scanned };
            for (const c of h.conversations) {
              if (c.replyTo) kvSet("gv:reply:" + c.number, JSON.stringify(c.replyTo));
            }
          }
          // Cross-reference with existing contacts by GV number (fresh every request).
          const byGv = new Map<string, { id: string; name: string }>();
          for (const c of listContacts()) {
            const d = normDigits(c.gv_number || "");
            if (d.length === 10 && !byGv.has(d)) byGv.set(d, { id: c.id, name: c.name });
          }
          const conversations = smsCache.conversations.map((c) => ({
            ...c,
            contact: byGv.get(c.number) || null,
          }));
          return json({ conversations, scanned: smsCache.scanned });
        } catch (e) {
          smsCache = null;
          return json({ error: errMsg(e) }, 502);
        }
      }

      // ----- Sent-mail contact harvesting -----
      if (path === "/api/sent-contacts" && method === "GET") {
        if (!imapReady()) return json({ error: "Add your mail account in Settings first." }, 400);
        try {
          const now = Date.now();
          if (!sentCache || now - sentCache.at > 5 * 60 * 1000) {
            const selfEmails = [settings.imap.user, settings.smtp.from].filter(Boolean) as string[];
            sentCache = { at: now, contacts: await harvestSentContacts(settings.imap, 40, selfEmails) };
          }
          return json({ contacts: sentCache.contacts });
        } catch (e) {
          sentCache = null;
          return json({ error: errMsg(e) }, 502);
        }
      }

      // ----- contacts -----
      if (path === "/api/contacts" && method === "GET") {
        const contacts = listContacts().map((c) => ({ ...c, channels: contactChannels(c), conversation_id: dmFor(c.id).id }));
        return json({ contacts, maxPeople: MAX_PEOPLE });
      }
      if (path === "/api/contacts" && method === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "Give them a name." }, 400);
        const c = createContact({
          name,
          email: String(b.email || "").trim().toLowerCase(),
          gv_number: String(b.gv_number || "").trim(),
          matrix_id: String(b.matrix_id || "").trim(),
          matrix_room_id: String(b.matrix_room_id || "").trim(),
          color: String(b.color || "") || pickColor(name),
          notes: String(b.notes || "").trim(),
        });
        dmFor(c.id);
        return json({ contact: c }, 201);
      }
      {
        const m = path.match(/^\/api\/contacts\/([^/]+)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (method === "GET") {
            const c = getContact(id);
            if (!c) return json({ error: "not found" }, 404);
            return json({ contact: { ...c, channels: contactChannels(c), conversation_id: dmFor(c.id).id } });
          }
          if (method === "PATCH") {
            const b = await readBody(req);
            const patch: any = {};
            for (const k of ["name", "email", "gv_number", "matrix_id", "matrix_room_id", "color", "notes"]) {
              if (k in b) patch[k] = String(b[k] ?? "").trim();
            }
            if (patch.email) patch.email = patch.email.toLowerCase();
            if (patch.name !== undefined && !patch.name) return json({ error: "Give them a name." }, 400);
            const c = updateContact(id, patch);
            if (!c) return json({ error: "not found" }, 404);
            return json({ contact: c });
          }
          if (method === "DELETE") {
            deleteContact(id);
            return json({ ok: true });
          }
        }
      }

      // ----- conversations -----
      if (path === "/api/conversations" && method === "GET") {
        const convs = listConversations().map((c) => {
          const members = conversationMembers(c.id);
          const title = c.is_group ? c.name : members[0]?.name || "Conversation";
          return {
            id: c.id, title, is_group: !!c.is_group,
            avatar_color: c.is_group ? "#8e8e93" : members[0]?.color || "#8e8e93",
            member_count: c.member_count, last_body: c.last_body || "", last_at: c.last_at || c.created_at,
            last_channel: c.last_channel || "", last_direction: c.last_direction || "", unread: c.unread,
            members: members.map((x) => ({ id: x.id, name: x.name, color: x.color })),
          };
        });
        return json({ conversations: convs });
      }
      if (path === "/api/conversations" && method === "POST") {
        const b = await readBody(req);
        const memberIds = (Array.isArray(b.member_ids) ? b.member_ids : []).map(String);
        for (const mid of memberIds) if (!getContact(mid)) return json({ error: "Unknown contact in group." }, 400);
        const conv = createGroup(String(b.name || ""), memberIds, String(b.matrix_room_id || "").trim());
        return json({ conversation: conv }, 201);
      }
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          const conv = getConversation(id);
          if (!conv) return json({ error: "not found" }, 404);
          if (method === "GET") {
            const members = conversationMembers(id);
            return json({
              conversation: {
                ...conv, is_group: !!conv.is_group,
                title: conv.is_group ? conv.name : members[0]?.name || "Conversation",
                members: members.map((x) => ({ ...x, channels: contactChannels(x) })),
                channels: conversationChannels(conv, members),
                hints: channelHints(conv, members),
              },
            });
          }
          if (method === "PATCH") {
            const b = await readBody(req);
            if (b.name !== undefined) conv.name = String(b.name).trim() || conv.name;
            if (b.matrix_room_id !== undefined) conv.matrix_room_id = String(b.matrix_room_id).trim();
            getDb().query("UPDATE conversations SET name = ?, matrix_room_id = ? WHERE id = ?").run(conv.name, conv.matrix_room_id, id);
            return json({ conversation: conv });
          }
          if (method === "DELETE") {
            getDb().query("DELETE FROM messages WHERE conversation_id = ?").run(id);
            getDb().query("DELETE FROM members WHERE conversation_id = ?").run(id);
            getDb().query("DELETE FROM conversations WHERE id = ?").run(id);
            return json({ ok: true });
          }
        }
      }
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          if (!getConversation(id)) return json({ error: "not found" }, 404);
          if (method === "GET") {
            const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
            const before = url.searchParams.get("before") || undefined;
            const msgs = listMessages(id, limit, before).reverse();
            return json({ messages: msgs });
          }
          if (method === "POST") {
            const b = await readBody(req);
            const channel = b.channel as Channel;
            if (!["email", "sms", "matrix"].includes(channel)) return json({ error: "Pick a channel." }, 400);
            try {
              const msg = await sendConversationMessage(id, channel, String(b.body || ""), String(b.subject || ""));
              return json({ message: msg }, 201);
            } catch (e) {
              // Record the failed attempt so nothing silently vanishes.
              try {
                insertMessage({ conversation_id: id, channel, direction: "out", body: String(b.body || ""), subject: String(b.subject || ""), external_id: "", status: "failed" });
              } catch { /* noop */ }
              return atErr(e);
            }
          }
        }
      }
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)\/read$/);
        if (m && method === "POST") {
          markRead(decodeURIComponent(m[1]));
          return json({ ok: true });
        }
      }

      // Pre-populate an empty 1:1 chat with the last email conversation.
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)\/seed-email$/);
        if (m && method === "POST") {
          const id = decodeURIComponent(m[1]);
          const conv = getConversation(id);
          if (!conv) return json({ error: "not found" }, 404);
          if (conv.is_group) return json({ seeded: false, reason: "group" });
          if (listMessages(id, 1).length) return json({ seeded: false, reason: "not-empty" });
          const contact = conversationMembers(id)[0];
          if (!contact || !contact.email) return json({ seeded: false, reason: "no-email" });
          if (!imapReady()) return json({ seeded: false, reason: "imap-not-configured" });
          try {
            const found = await latestEmailWith(settings.imap, contact.email);
            if (!found || !found.body) return json({ seeded: false, reason: "none-found" });
            // Reuse the poller's external-id for inbox mail so a later poll dedupes.
            const extId = found.mailbox === "inbox" ? `mail:${found.uid}` : `sentmail:${found.uid}`;
            if (hasExternalId(extId)) return json({ seeded: false, reason: "already-present" });
            insertMessage({
              conversation_id: id, channel: "email", direction: found.direction,
              body: found.body, subject: found.subject, external_id: extId, status: "",
              created_at: found.date,
            });
            return json({ seeded: true });
          } catch {
            return json({ seeded: false, reason: "lookup-failed" });
          }
        }
      }

      // ----- manual poll -----
      if (path === "/api/poll" && method === "POST") {
        await Promise.all([pollMail(), pollMatrixOnce()]);
        return json({ ok: true, lastPoll });
      }

      // ----- static -----
      const filePath = "public" + (path === "/" ? "/index.html" : path);
      const file = (Bun as any).file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": contentType(filePath) } });
      }
      if (!path.startsWith("/api/")) {
        return new Response((Bun as any).file("public/index.html"), { headers: { "Content-Type": "text/html" } });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return atErr(e);
    }
  },
});

startPollers();
console.log(`relay listening on http://localhost:${server.port}`);
