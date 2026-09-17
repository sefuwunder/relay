// Relay — small-group unified messaging: email, SMS (Google Voice gateways), Matrix.
// Bun + zero dependencies. Private data (contacts, messages, credentials) lives in
// gitignored ./data and is never pushed.

import {
  openDb, getDb, uid,
  listContacts, listActiveContacts, listArchivedContacts, getContact, createContact, updateContact, deleteContact, countActiveContacts,
  getConversation, conversationMembers, dmFor, createGroup, listConversations, markRead,
  listMessages, insertMessage, hasExternalId, kvGet, kvSet, MAX_PEOPLE,
  insertAttachment, getAttachment, listAttachmentsForMessages, listConversationAttachments, searchConversationAttachments, deleteConversationData,
  insertAppointment, listAppointments, getAppointment, getAppointmentByUid, getAppointmentsForMessages, setAppointmentStatus,
  type Contact, type Conversation, type Channel, type Message, type Attachment, type Appointment,
} from "./db";
import { buildIcs, parseIcs, newEventUid, type CalEvent } from "./ical";
import { sendMail, validateSmtp, gvGatewayAddress, newMessageId, type SmtpConfig, type MailAttachment } from "./smtp";
import { fetchUnseen, validateImap, extractEmail, harvestSentContacts, harvestRecentSms, gvNumberFrom, latestGvForward, latestEmailWith, fetchInboxBody, fetchInboxMessageId, stripGvFooter, stripEmailQuotes, fetchMailAttachments, fetchSentMail, parseGvNumber, type ImapConfig, type SentMailItem, type InboundAttachment } from "./imap";
import { matrixSend, matrixSync, validateMatrix, matrixRooms, type MatrixConfig } from "./matrix";
import {
  googleAuthUrl, exchangeCode, refreshAccessToken, googleAccountEmail, listGoogleContacts,
  type GoogleSettings,
} from "./google";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT || 3006);
const DATA_DIR = "./data";
const ATTACH_DIR = `${DATA_DIR}/attachments`;

/** File attachments: metadata in SQLite, bytes on disk under ./data/attachments/<id>. */
function attachmentPath(id: string): string {
  return `${ATTACH_DIR}/${id}`;
}

async function saveMessageAttachments(messageId: string, files: MailAttachment[]): Promise<Attachment[]> {
  const saved: Attachment[] = [];
  await (Bun as any).write(ATTACH_DIR + "/.keep", ""); // ensure the dir exists
  try {
    for (const f of files) {
      const row = insertAttachment({
        message_id: messageId,
        filename: (f.filename || "file").slice(0, 120),
        mime: (f.mime || "application/octet-stream").slice(0, 120),
        size: f.data.length,
      });
      await (Bun as any).write(attachmentPath(row.id), f.data);
      saved.push(row);
    }
  } catch (e) {
    // Roll back this batch so a half-written set never leaves orphan rows
    // (or rows pointing at missing bytes) behind.
    for (const row of saved) {
      try { getDb().query("DELETE FROM attachments WHERE id = ?").run(row.id); } catch { /* noop */ }
    }
    await removeAttachmentFiles(saved.map((r) => r.id));
    throw e;
  }
  return saved;
}

async function removeAttachmentFiles(ids: string[]): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  for (const id of ids) {
    try { await unlink(attachmentPath(id)); } catch { /* already gone */ }
  }
}

// Attachment upload limits.
const MAX_FILES_PER_MESSAGE = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file

/** Embed each message's file metadata (no bytes) for the UI. */
function withAttachments<T extends Message>(msgs: T[]): (T & { attachments: Attachment[]; appointment: Appointment | null })[] {
  const all = listAttachmentsForMessages(msgs.map((m) => m.id));
  const byMsg = new Map<string, Attachment[]>();
  for (const a of all) {
    const list = byMsg.get(a.message_id) || [];
    list.push(a);
    byMsg.set(a.message_id, list);
  }
  const appts = getAppointmentsForMessages(msgs.map((m) => m.id));
  return msgs.map((m) => ({ ...m, attachments: byMsg.get(m.id) || [], appointment: appts.get(m.id) || null }));
}

/** True when an attachment is a calendar invitation. */
function isCalendarAttachment(a: { mime: string; filename: string }): boolean {
  return a.mime === "text/calendar" || /\.ics$/i.test(a.filename);
}

/**
 * Scan a message's attachments for calendar invites and record one
 * appointment per ICS event (deduped by UID). Called after both inbound
 * and sent-mail attachment saves.
 */
async function ingestCalendarAttachments(messageId: string, convId: string, direction: "in" | "out"): Promise<void> {
  const atts = listAttachmentsForMessages([messageId]).filter(isCalendarAttachment);
  if (!atts.length) return;
  const { readFile } = await import("node:fs/promises");
  for (const a of atts) {
    let text = "";
    try {
      text = await readFile(attachmentPath(a.id), "utf8");
    } catch {
      continue;
    }
    for (const ev of parseIcs(text)) {
      if (!ev.uid || getAppointmentByUid(ev.uid)) continue;
      insertAppointment({
        conversation_id: convId,
        message_id: messageId,
        uid: ev.uid,
        title: ev.summary,
        starts_at: ev.dtstart,
        ends_at: ev.dtend,
        location: ev.location,
        description: ev.description,
        organizer: ev.organizer,
        status: direction === "in" ? "received" : "sent",
      });
    }
  }
}

/** Parse and validate an inline calendar-invitation payload (object or JSON string). */
function parseInviteParam(raw: unknown): {
  title: string; startsAt: string; endsAt: string; location: string; description: string; uid: string;
} | null {
  if (raw == null || raw === "") return null;
  let ev: any = raw;
  if (typeof ev === "string") {
    try {
      ev = JSON.parse(ev);
    } catch {
      throw new Error("That invitation didn't parse — try again.");
    }
  }
  if (typeof ev !== "object") throw new Error("That invitation didn't parse — try again.");
  const title = String(ev.title || "").trim();
  if (!title) throw new Error("Give the invitation a title.");
  const s = new Date(String(ev.starts_at || ev.startsAt || ""));
  const e = new Date(String(ev.ends_at || ev.endsAt || ""));
  if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new Error("Pick a valid start and end time.");
  if (e.getTime() <= s.getTime()) throw new Error("The end time has to be after the start time.");
  return {
    title: title.slice(0, 200),
    startsAt: s.toISOString(),
    endsAt: e.toISOString(),
    location: String(ev.location || "").slice(0, 200),
    description: String(ev.description || "").slice(0, 2000),
    uid: newEventUid(),
  };
}

/** Sanitize an uploaded filename for storage + MIME headers. */
function cleanUploadName(name: string): string {
  const base = (name || "file").split(/[\\/]/).pop() || "file";
  return base.replace(/[\r\n"]/g, "").slice(0, 120) || "file";
}

/** Parse a message POST body: JSON as before, or multipart/form-data with files. */
async function readMessageBody(req: Request): Promise<{ fields: any; files: MailAttachment[] }> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const fields: any = {};
    const files: MailAttachment[] = [];
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        fields[key] = value;
      } else if (value && typeof (value as any).arrayBuffer === "function") {
        const file = value as unknown as { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
        const data = Buffer.from(await file.arrayBuffer());
        if (data.length > MAX_FILE_BYTES) {
          throw new Error(`"${cleanUploadName(file.name)}" is too big — 25 MB max per file.`);
        }
        files.push({ filename: cleanUploadName(file.name), mime: file.type || "application/octet-stream", data });
      }
    }
    if (files.length > MAX_FILES_PER_MESSAGE) throw new Error(`At most ${MAX_FILES_PER_MESSAGE} files per message.`);
    return { fields, files };
  }
  return { fields: await readBody(req), files: [] };
}

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

// One-time sweep: scrub GV footer boilerplate out of inbound SMS bodies
// stored before stripGvFooter learned the "To respond to this text message"
// variant. Idempotent — runs to zero matches on later boots.
{
  const db = getDb();
  const rows = db.query(
    `SELECT id, body FROM messages WHERE channel = 'sms' AND direction = 'in'
     AND (body LIKE '%To respond to this text message%' OR body LIKE '%YOUR ACCOUNT <https://voice.google.com>%')`
  ).all() as { id: string; body: string }[];
  let scrubbed = 0;
  for (const r of rows) {
    const clean = stripGvFooter(r.body);
    if (clean !== r.body) {
      db.query("UPDATE messages SET body = ? WHERE id = ?").run(clean || "(empty SMS)", r.id);
      scrubbed++;
    }
  }
  if (scrubbed) console.log(`scrubbed GV footers from ${scrubbed} stored SMS message(s)`);
}

// One-time repair: re-fetch full bodies for inbound mail/SMS stored truncated
// at the old 280-char snippet cap (the poller used to save the list preview
// as the message body), and backfill the original Message-ID so the reply
// button can thread under older messages. Idempotent — repaired rows no
// longer match; a UID that no longer resolves is left alone.
if (imapReady()) {
  const db = getDb();
  const rows = db.query(
    `SELECT id, external_id, channel, message_id, LENGTH(body) AS len FROM messages
     WHERE direction = 'in' AND channel IN ('email', 'sms')
     AND external_id LIKE 'mail:%' AND (LENGTH(body) = 280 OR message_id = '')`
  ).all() as { id: string; external_id: string; channel: string; message_id: string; len: number }[];
  let repaired = 0;
  for (const r of rows) {
    const uid = r.external_id.slice(5);
    if (!/^\d+$/.test(uid)) continue;
    try {
      let newBody: string | null = null;
      let newMid: string | null = null;
      if (r.len === 280) {
        let full = await fetchInboxBody(settings.imap, uid, 4000);
        if (r.channel === "sms") full = stripGvFooter(full);
        if (full && full.length > 280) newBody = full;
      }
      if (!r.message_id) {
        const mid = await fetchInboxMessageId(settings.imap, uid);
        if (mid) newMid = mid;
      }
      if (newBody !== null || newMid !== null) {
        db.query("UPDATE messages SET body = COALESCE(?, body), message_id = COALESCE(?, message_id) WHERE id = ?")
          .run(newBody, newMid, r.id);
        repaired++;
      }
    } catch { /* stale UID — leave the row alone */ }
  }
  if (repaired) console.log(`repaired ${repaired} truncated email/SMS message(s)`);
}

// One-time sweep: strip quoted reply history ("On ... wrote:", ">" lines)
// and signatures out of stored inbound email bodies. Idempotent — stripped
// rows no longer match on later boots.
{
  const db = getDb();
  const rows = db.query(
    `SELECT id, body FROM messages WHERE channel = 'email' AND direction = 'in'
     AND (body LIKE '% wrote:%' OR body LIKE '%' || char(10) || '>%' OR body LIKE '%' || char(10) || '-- %')`
  ).all() as { id: string; body: string }[];
  let stripped = 0;
  for (const r of rows) {
    const clean = stripEmailQuotes(r.body);
    if (clean !== r.body) {
      db.query("UPDATE messages SET body = ? WHERE id = ?").run(clean, r.id);
      stripped++;
    }
  }
  if (stripped) console.log(`stripped quoted history from ${stripped} stored email message(s)`);
  else if (rows.length) console.log(`quote-strip sweep: ${rows.length} stored email(s) checked, none needed stripping`);
}

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
    if (countActiveContacts() >= MAX_PEOPLE) break;
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
  return json({ imported, skipped, capped: countActiveContacts() >= MAX_PEOPLE });
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
/** Public avatar for an email address via Gravatar (d=404 so missing ones 404). */
export function avatarUrl(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  return `https://www.gravatar.com/avatar/${createHash("md5").update(e).digest("hex")}?s=128&d=404`;
}

/** Effective avatar: the contact's custom photo wins, then Gravatar. */
export function avatarFor(c: { photo?: string; email?: string }): string | null {
  return (c.photo && /^data:image\/(jpeg|png|webp|gif);base64,/.test(c.photo)) ? c.photo : avatarUrl(c.email || "");
}

/** Validate an uploaded contact photo: image data URL, downscaled client-side, ~400KB cap. */
function cleanPhoto(v: unknown): string | null {
  const s = String(v ?? "");
  if (!s) return "";
  if (s.length > 550000) return null;
  return /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null;
}

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
    hints.matrix = "Add Matrix in Settings to message over Matrix.";
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

/** Message-ID for an outbound send: reuse the failed row's on retry so the
    Sent-folder copy stays recognizable as the same message. */
function outboundMessageId(retryOfId?: string): string {
  if (retryOfId) {
    const row = getDb().query("SELECT message_id FROM messages WHERE id = ?").get(retryOfId) as { message_id?: string } | null;
    if (row?.message_id) return row.message_id;
  }
  return newMessageId();
}

async function sendConversationMessage(convId: string, channel: Channel, body: string, subject: string, inReplyToMsgId?: string, retryOfId?: string, attachments: MailAttachment[] = []) {
  const conv = getConversation(convId);
  if (!conv) throw new Error("Conversation not found.");
  const members = conversationMembers(convId);
  const text = body.trim();
  if (!text && !attachments.length) throw new Error("Write a message first.");
  const ok = conversationChannels(conv, members);
  if (!ok.includes(channel)) throw new Error(`That channel isn't available here right now.`);
  if (attachments.length && channel !== "email") {
    throw new Error("Files can only be sent by email for now.");
  }

  if (channel === "email") {
    const to = members.map((m) => m.email);
    // Reply in-thread when the user picked a specific message: In-Reply-To /
    // References carry the original's Message-ID and the subject gets Re:.
    let inReplyTo: string | undefined;
    let subj = subject.trim() || (conv.is_group ? conv.name : `Message for ${members[0]?.name || "you"}`);
    if (inReplyToMsgId) {
      const orig = getDb().query("SELECT subject, message_id FROM messages WHERE id = ? AND conversation_id = ?").get(inReplyToMsgId, convId) as any;
      if (orig?.message_id) {
        inReplyTo = orig.message_id;
        subj = "Re: " + String(orig.subject || subj).replace(/^Re:\s*/i, "");
      }
    }
    // One Message-ID for both the wire and the local row, so the sent-mail
    // import recognizes the Sent-folder copy as this same message.
    const mid = outboundMessageId(retryOfId);
    await sendMail(settings.smtp, { to, subject: subj, text, inReplyTo, messageId: mid, attachments });
    const sent = recordSent(retryOfId, { conversation_id: convId, channel, direction: "out", body: text, subject: subj, external_id: "", message_id: mid, status: "sent" });
    if (attachments.length && !retryOfId) {
      // Persist file rows now that the send succeeded. (On failure the
      // caller persists them against the failed row so Retry still has them.)
      // If persistence itself fails after a good send, don't report failure —
      // the mail went out with the files; only the local copy is lost.
      try {
        await saveMessageAttachments(sent.id, attachments);
      } catch (e) {
        console.log(`warning: sent message ${sent.id} but could not store its attachments: ${(e as Error).message}`);
      }
    }
    return sent;
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
    const mid = outboundMessageId(retryOfId);
    await sendMail(settings.smtp, { to, subject: subj, text, inReplyTo, messageId: mid });
    return recordSent(retryOfId, { conversation_id: convId, channel, direction: "out", body: text, subject: "", external_id: "", message_id: mid, status: "sent" });
  }
  // matrix
  const roomId = conv.is_group ? conv.matrix_room_id : members[0].matrix_room_id;
  const eventId = await matrixSend(settings.matrix, roomId, text);
  return recordSent(retryOfId, { conversation_id: convId, channel, direction: "out", body: text, subject: "", external_id: `matrix:${eventId}`, status: "sent" });
}

// On a retry, flip the original failed row to sent instead of inserting a duplicate.
function recordSent(retryOfId: string | undefined, rec: Omit<Message, "id" | "created_at"> & { created_at?: string }): Message {
  if (!retryOfId) return insertMessage(rec);
  getDb().query("UPDATE messages SET channel = ?, direction = 'out', body = ?, subject = ?, external_id = ?, message_id = ?, status = 'sent' WHERE id = ?").run(rec.channel, rec.body, rec.subject, rec.external_id, rec.message_id || "", retryOfId);
  return getDb().query("SELECT * FROM messages WHERE id = ?").get(retryOfId) as Message;
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
    const inboundFiles: { uid: string; messageId: string; convId: string }[] = [];
    for (const m of mails) {
      const extId = `mail:${m.uid}`;
      if (hasExternalId(extId)) continue;
      const rawFrom = m.from || "";
      const gvNum = gvNumberFrom(rawFrom, m.subject || "", m.returnPath || "");
      let contact: Contact | null = null;
      let channel: Channel = "email";
      let body = m.body || "";
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
        body = stripEmailQuotes(body); // drop quoted reply history + signatures
      }
      if (!contact) continue; // not from someone we track
      const conv = dmFor(contact.id);
      const msg = insertMessage({
        conversation_id: conv.id, channel, direction: "in", body, subject,
        external_id: extId, message_id: m.messageId || "", status: "",
      });
      // Inbound email attachments ride along on the message (GV forwards are SMS — no files).
      if (channel === "email") inboundFiles.push({ uid: m.uid, messageId: msg.id, convId: conv.id });
    }
    if (inboundFiles.length) {
      try {
        const attMap = await fetchMailAttachments(settings.imap, inboundFiles.map((p) => p.uid));
        for (const p of inboundFiles) {
          const files = attMap.get(p.uid) || [];
          // Idempotent: a reprocessed message (uidvalidity shift) never duplicates files.
          if (files.length && listAttachmentsForMessages([p.messageId]).length === 0) {
            await saveMessageAttachments(p.messageId, files);
          }
          // Calendar invitations arrive as .ics attachments.
          await ingestCalendarAttachments(p.messageId, p.convId, "in");
        }
      } catch (e) {
        console.error("inbound attachment fetch failed:", e instanceof Error ? e.message : e);
      }
    }
    lastPoll.mail = new Date().toISOString();
    lastPoll.mailError = null;
    // Sent-mail sync: pick up mail (and attachments) sent from outside Relay.
    try {
      await pollSentMail();
    } catch (e) {
      console.error("sent-mail poll failed:", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    lastPoll.mailError = errMsg(e);
  }
}

// ---------- sent-mail import ----------

/** Normalize a subject for duplicate comparison: lowercase, strip Re:/Fwd:. */
function normSubject(s: string): string {
  return s.toLowerCase().replace(/^(re|fwd?):\s*/i, "").trim();
}

/**
 * Conversation for a set of recipient contacts: the group whose members match
 * exactly, else the first recipient's DM.
 */
function conversationForContacts(ids: string[]): Conversation {
  if (ids.length === 1) return dmFor(ids[0]);
  const want = [...new Set(ids)].sort().join(",");
  for (const c of listConversations()) {
    if (!c.is_group) continue;
    const have = conversationMembers(c.id).map((m) => m.id).sort().join(",");
    if (have === want) return c;
  }
  return dmFor(ids[0]);
}

/**
 * A sent-folder message composed inside Relay before Message-IDs were stored
 * has no message_id to match on. Find it fuzzily: same conversation, outbound
 * email, matching subject, sent within ±15 minutes, same attachment filenames.
 */
function findSentDuplicate(convId: string, subject: string, dateIso: string, filenames: string[]): Message | null {
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return null;
  const wantSubj = normSubject(subject);
  const wantFiles = [...filenames].sort().join("\0");
  const cands = getDb().query(
    "SELECT * FROM messages WHERE conversation_id = ? AND direction = 'out' AND channel = 'email' AND (message_id IS NULL OR message_id = '') ORDER BY created_at DESC LIMIT 200"
  ).all(convId) as Message[];
  for (const c of cands) {
    const ct = Date.parse(c.created_at);
    if (!Number.isFinite(ct) || Math.abs(ct - t) > 15 * 60_000) continue;
    if (normSubject(c.subject || "") !== wantSubj) continue;
    const haveFiles = listAttachmentsForMessages([c.id]).map((a) => a.filename).sort().join("\0");
    if (haveFiles !== wantFiles) continue;
    return c;
  }
  return null;
}

async function importSentItem(
  mailbox: string,
  item: SentMailItem,
  byEmail: Map<string, Contact>,
  selfEmails: Set<string>
): Promise<void> {
  // Exact dedupe: already imported, or composed inside Relay (stored Message-ID).
  if (item.messageId && getDb().query("SELECT 1 FROM messages WHERE message_id = ? LIMIT 1").get(item.messageId)) return;
  const extId = `sentmail:${mailbox}:${item.uid}`;
  if (hasExternalId(extId)) return;
  const seen = new Set<string>();
  const recipients: Contact[] = [];
  for (const raw of item.to) {
    const email = extractEmail(raw);
    if (!email || selfEmails.has(email) || seen.has(email)) continue;
    seen.add(email);
    if (parseGvNumber(email)) continue; // SMS sends are already recorded by the composer
    const c = byEmail.get(email);
    if (c) recipients.push(c);
  }
  if (!recipients.length) return; // nobody we track
  const conv = conversationForContacts(recipients.map((c) => c.id));
  // Attachments ride on the message; fetch them first so the fuzzy duplicate
  // check can compare filename sets.
  let files: InboundAttachment[] = [];
  try {
    const attMap = await fetchMailAttachments(settings.imap, [item.uid], mailbox);
    files = attMap.get(item.uid) || [];
  } catch (e) {
    console.error("sent-mail attachment fetch failed:", e instanceof Error ? e.message : e);
  }
  const dup = findSentDuplicate(conv.id, item.subject, item.date, files.map((f) => f.filename));
  if (dup) {
    // Backfill the Message-ID so future polls match exactly.
    if (item.messageId) getDb().query("UPDATE messages SET message_id = ? WHERE id = ?").run(item.messageId, dup.id);
    return;
  }
  const msg = insertMessage({
    conversation_id: conv.id, channel: "email", direction: "out",
    body: item.body || "(no text)", subject: item.subject,
    external_id: extId, message_id: item.messageId || "",
    status: "sent", created_at: item.date || undefined,
  });
  if (files.length) await saveMessageAttachments(msg.id, files);
  // Invitations sent from a regular mail app land in the diary too.
  await ingestCalendarAttachments(msg.id, conv.id, "out");
}

/**
 * Import mail sent from outside Relay (phone's mail app, desktop client, …)
 * so threads, the Shared files widget, and filename search see it. Watermarked
 * by UID per mailbox; the first run backfills up to 90 days (newest 200).
 * One bad message never fails the batch; failures are logged, not thrown.
 */
async function pollSentMail(): Promise<void> {
  const prevBox = kvGet("imap:sent:box") || "";
  let resumeUid: number | null = null;
  if (prevBox) {
    const n = Number(kvGet("imap:sent:lastuid") || "");
    if (Number.isFinite(n)) resumeUid = n;
  }
  const { mailbox, items, maxUid } = await fetchSentMail(settings.imap, prevBox ? resumeUid : null);
  if (!mailbox) return; // no Sent folder found — nothing to do
  if (items.length) {
    const contacts = listContacts();
    const byEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
    const selfEmails = new Set([settings.imap.user, settings.smtp.from].filter(Boolean).map((s) => (s as string).toLowerCase()));
    for (const item of items) {
      try {
        await importSentItem(mailbox, item, byEmail, selfEmails);
      } catch (e) {
        console.error("sent-mail import failed for uid", item.uid, e instanceof Error ? e.message : e);
      }
    }
  }
  kvSet("imap:sent:box", mailbox);
  if (maxUid !== null) kvSet("imap:sent:lastuid", String(maxUid));
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
          contacts: countActiveContacts(), maxPeople: MAX_PEOPLE,
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
        const withMeta = (c: Contact) => ({ ...c, channels: contactChannels(c), conversation_id: dmFor(c.id).id, avatar_url: avatarFor(c) });
        return json({
          contacts: listActiveContacts().map(withMeta),
          archived: listArchivedContacts().map(withMeta),
          maxPeople: MAX_PEOPLE,
        });
      }
      if (path === "/api/contacts" && method === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "Give them a name." }, 400);
        const photo = cleanPhoto(b.photo);
        if (photo === null) return json({ error: "That photo didn't work — try a JPEG, PNG, WebP or GIF." }, 400);
        const c = createContact({
          name,
          email: String(b.email || "").trim().toLowerCase(),
          gv_number: String(b.gv_number || "").trim(),
          matrix_id: String(b.matrix_id || "").trim(),
          matrix_room_id: String(b.matrix_room_id || "").trim(),
          color: String(b.color || "") || pickColor(name),
          notes: String(b.notes || "").trim(),
          photo: photo || "",
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
            return json({ contact: { ...c, channels: contactChannels(c), conversation_id: dmFor(c.id).id, avatar_url: avatarFor(c) } });
          }
          if (method === "PATCH") {
            const b = await readBody(req);
            const patch: any = {};
            for (const k of ["name", "email", "gv_number", "matrix_id", "matrix_room_id", "color", "notes"]) {
              if (k in b) patch[k] = String(b[k] ?? "").trim();
            }
            if ("archived" in b) patch.archived = b.archived === true || b.archived === 1 || b.archived === "1" ? 1 : 0;
            if ("photo" in b) {
              const photo = cleanPhoto(b.photo);
              if (photo === null) return json({ error: "That photo didn't work — try a JPEG, PNG, WebP or GIF." }, 400);
              patch.photo = photo;
            }
            if (patch.email) patch.email = patch.email.toLowerCase();
            if (patch.name !== undefined && !patch.name) return json({ error: "Give them a name." }, 400);
            const cur = getContact(id);
            if (!cur) return json({ error: "not found" }, 404);
            if (patch.archived === 0 && cur.archived === 1 && countActiveContacts() >= MAX_PEOPLE) {
              return json({ error: `Your inner circle is full (${MAX_PEOPLE} max). Archive someone else first.` }, 400);
            }
            const c = updateContact(id, patch);
            if (!c) return json({ error: "not found" }, 404);
            return json({ contact: c });
          }
          if (method === "DELETE") {
            const removed = deleteContact(id);
            await removeAttachmentFiles(removed);
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
            members: members.map((x) => ({ id: x.id, name: x.name, color: x.color, avatar_url: avatarFor(x) })),
            hidden: !c.is_group && members.length > 0 && members.every((x) => x.archived === 1),
          };
        }).filter((c) => !c.hidden).map(({ hidden, ...c }) => c);
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
                members: members.map((x) => ({ ...x, channels: contactChannels(x), avatar_url: avatarFor(x) })),
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
            const removed = deleteConversationData(id);
            await removeAttachmentFiles(removed);
            return json({ ok: true });
          }
        }
      }
      {
        // Retry a failed outbound message: re-send with its original
        // channel/body and flip the same row to sent (no duplicate bubble).
        const m = path.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/retry$/);
        if (m && method === "POST") {
          const id = decodeURIComponent(m[1]);
          const mid = decodeURIComponent(m[2]);
          const row = getDb().query("SELECT * FROM messages WHERE id = ? AND conversation_id = ?").get(mid, id) as Message | undefined;
          if (!row || row.direction !== "out" || row.status !== "failed") return json({ error: "That message can't be retried." }, 400);
          try {
            // Re-attach the failed message's stored files so they go out again.
            const stored = listAttachmentsForMessages([row.id]);
            const files: MailAttachment[] = [];
            for (const a of stored) {
              const data = Buffer.from(await (Bun as any).file(attachmentPath(a.id)).arrayBuffer());
              if (data.length) files.push({ filename: a.filename, mime: a.mime, data });
            }
            const msg = await sendConversationMessage(id, row.channel as Channel, row.body, row.subject || "", undefined, row.id, files);
            return json({ message: withAttachments([msg])[0] });
          } catch (e) {
            return atErr(e);
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
            return json({ messages: withAttachments(msgs) });
          }
          if (method === "POST") {
            let fields: any;
            let files: MailAttachment[];
            try {
              ({ fields, files } = await readMessageBody(req));
            } catch (e) {
              return json({ error: errMsg(e) }, 400);
            }
            const b = fields;
            const channel = b.channel as Channel;
            if (!["email", "sms", "matrix"].includes(channel)) return json({ error: "Pick a channel." }, 400);
            if (files.length && channel !== "email") {
              return json({ error: "Files can only be sent by email for now — switch to the Email channel to attach them." }, 400);
            }
            // Inline calendar invitation: the details ride along as a
            // generated .ics attachment and land in the diary widget.
            let invite: ReturnType<typeof parseInviteParam>;
            try {
              invite = parseInviteParam(b.event);
            } catch (e) {
              return json({ error: errMsg(e) }, 400);
            }
            if (invite && channel !== "email") {
              return json({ error: "Calendar invitations go out by email — switch to the Email channel." }, 400);
            }
            const sendFiles = files.slice();
            if (invite) {
              const members = conversationMembers(id);
              const ics = buildIcs({
                uid: invite.uid,
                summary: invite.title,
                startsAt: new Date(invite.startsAt),
                endsAt: new Date(invite.endsAt),
                location: invite.location || undefined,
                description: invite.description || undefined,
                organizer: settings.smtp.from || undefined,
                attendees: members.map((m) => m.email).filter(Boolean) as string[],
              });
              sendFiles.push({ filename: "invite.ics", mime: "text/calendar", data: Buffer.from(ics, "utf8") });
            }
            const recordInvite = (messageId: string) => {
              // The uid dedupe also protects the sent-mail import from
              // recording this same invitation a second time.
              if (invite && !getAppointmentByUid(invite.uid)) {
                insertAppointment({
                  conversation_id: id,
                  message_id: messageId,
                  uid: invite.uid,
                  title: invite.title,
                  starts_at: invite.startsAt,
                  ends_at: invite.endsAt,
                  location: invite.location,
                  description: invite.description,
                  organizer: settings.smtp.from || "",
                  status: "sent",
                });
              }
            };
            try {
              const bodyText = String(b.body || "") || (invite ? `📅 Calendar invitation: ${invite.title}` : "");
              const subjText = String(b.subject || "") || (invite ? `Invitation: ${invite.title}` : "");
              const msg = await sendConversationMessage(id, channel, bodyText, subjText, typeof b.in_reply_to === "string" ? b.in_reply_to : undefined, undefined, sendFiles);
              recordInvite(msg.id);
              return json({ message: withAttachments([msg])[0] }, 201);
            } catch (e) {
              // Record the failed attempt so nothing silently vanishes.
              let failedMsg = null;
              try {
                failedMsg = insertMessage({ conversation_id: id, channel, direction: "out", body: String(b.body || ""), subject: String(b.subject || ""), external_id: "", status: "failed" });
                if (sendFiles.length) await saveMessageAttachments(failedMsg.id, sendFiles);
                recordInvite(failedMsg.id);
              } catch { /* noop */ }
              const res = atErr(e);
              if (failedMsg) {
                // Hand the failed record back so the UI can show it (with Retry) right away.
                const body = await res.json().catch(() => ({}));
                return json({ ...body, failed_message: withAttachments([failedMsg])[0] }, res.status);
              }
              return res;
            }
          }
        }
      }
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)\/appointments$/);
        if (m && method === "GET") {
          const id = decodeURIComponent(m[1]);
          if (!getConversation(id)) return json({ error: "not found" }, 404);
          return json({ appointments: listAppointments(id) });
        }
      }
      {
        // Accept / decline / cancel an appointment from an invitation card.
        const m = path.match(/^\/api\/conversations\/([^/]+)\/appointments\/([^/]+)\/status$/);
        if (m && method === "POST") {
          const id = decodeURIComponent(m[1]);
          const apptId = decodeURIComponent(m[2]);
          if (!getConversation(id)) return json({ error: "not found" }, 404);
          const appt = getAppointment(apptId);
          if (!appt || appt.conversation_id !== id) return json({ error: "not found" }, 404);
          let body: any = {};
          try {
            body = await readBody(req);
          } catch { /* noop */ }
          const status = String(body.status || "");
          if (!["accepted", "declined", "cancelled"].includes(status)) {
            return json({ error: "Pick accepted, declined, or cancelled." }, 400);
          }
          return json({ appointment: setAppointmentStatus(apptId, status) });
        }
      }
      {
        // RSVP to an invitation: updates the diary and, when the invitation
        // names an organizer, emails them a real METHOD:REPLY .ics.
        const m = path.match(/^\/api\/conversations\/([^/]+)\/appointments\/([^/]+)\/rsvp$/);
        if (m && method === "POST") {
          const id = decodeURIComponent(m[1]);
          const apptId = decodeURIComponent(m[2]);
          if (!getConversation(id)) return json({ error: "not found" }, 404);
          const appt = getAppointment(apptId);
          if (!appt || appt.conversation_id !== id) return json({ error: "not found" }, 404);
          let body: any = {};
          try {
            body = await readBody(req);
          } catch { /* noop */ }
          const response = String(body.response || "");
          if (!["accepted", "declined"].includes(response)) {
            return json({ error: "Pick accepted or declined." }, 400);
          }
          const updated = setAppointmentStatus(apptId, response);
          const organizer = (appt.organizer || "").trim();
          const selfAddr = (settings.smtp.from || "").trim().toLowerCase();
          // Nobody to reply to (or we'd be replying to ourselves): local
          // diary update only.
          if (!organizer || organizer.toLowerCase() === selfAddr) {
            return json({ appointment: updated, message: null, rsvp: false });
          }
          const partstat = response === "accepted" ? "ACCEPTED" : "DECLINED";
          const verb = response === "accepted" ? "Accepted" : "Declined";
          const ics = buildIcs({
            uid: appt.uid || newEventUid(),
            summary: appt.title,
            startsAt: new Date(appt.starts_at),
            endsAt: new Date(appt.ends_at),
            location: appt.location || undefined,
            organizer,
            attendees: [{ email: settings.smtp.from, partstat }],
            method: "REPLY",
          });
          const mid = newMessageId();
          const text = `${verb}: ${appt.title}`;
          try {
            await sendMail(settings.smtp, {
              to: [organizer],
              subject: `${verb}: ${appt.title}`,
              text,
              messageId: mid,
              attachments: [{ filename: "reply.ics", mime: "text/calendar", data: Buffer.from(ics, "utf8") }],
            });
          } catch (e) {
            // The diary still records the user's decision; the reply just
            // didn't go out.
            return json({ appointment: updated, message: null, rsvp: false, rsvp_error: errMsg(e) });
          }
          const msg = insertMessage({
            conversation_id: id, channel: "email", direction: "out",
            body: text, subject: `${verb}: ${appt.title}`,
            external_id: "", message_id: mid, status: "sent",
          });
          return json({ appointment: updated, message: withAttachments([msg])[0], rsvp: true });
        }
      }
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)\/read$/);
        if (m && method === "POST") {
          markRead(decodeURIComponent(m[1]));
          return json({ ok: true });
        }
      }

      // Pre-populate an empty 1:1 conversation with the last email conversation.
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
              body: found.body, subject: found.subject, external_id: extId,
              message_id: found.messageId || "", status: "",
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

      // ----- shared files -----

      // Recently shared files in a conversation, newest first — feeds the widget.
      {
        const m = path.match(/^\/api\/conversations\/([^/]+)\/files$/);
        if (m && method === "GET") {
          const id = decodeURIComponent(m[1]);
          if (!getConversation(id)) return json({ error: "not found" }, 404);
          const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);
          const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
          if (q) {
            const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 90));
            return json({ files: searchConversationAttachments(id, q, days, limit), q, days });
          }
          return json({ files: listConversationAttachments(id, limit) });
        }
      }

      // Download / preview a single attachment. The id comes from the DB row,
      // so there is no path traversal: bytes are read from ./data/attachments/<id>.
      {
        const m = path.match(/^\/api\/attachments\/([^/]+)$/);
        if (m && method === "GET") {
          const att = getAttachment(decodeURIComponent(m[1]));
          if (!att) return json({ error: "not found" }, 404);
          const file = (Bun as any).file(attachmentPath(att.id));
          if (!(await file.exists())) return json({ error: "file missing" }, 404);
          const safeName = att.filename.replace(/[\r\n"]/g, "");
          return new Response(file, {
            headers: {
              "Content-Type": att.mime || "application/octet-stream",
              "Content-Length": String(att.size),
              "Content-Disposition": `inline; filename="${safeName}"`,
              "Cache-Control": "private, max-age=86400",
            },
          });
        }
      }

      // ----- static -----
      const filePath = "public" + (path === "/" ? "/index.html" : path);
      const file = (Bun as any).file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": contentType(filePath), "Cache-Control": "no-cache" } });
      }
      if (!path.startsWith("/api/")) {
        return new Response((Bun as any).file("public/index.html"), { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return atErr(e);
    }
  },
});

startPollers();
console.log(`relay listening on http://localhost:${server.port}`);
