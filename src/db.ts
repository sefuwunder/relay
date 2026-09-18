// Relay persistence: Bun's built-in SQLite.
// Contacts and conversations are the user's private data — the DB lives in
// gitignored ./data and is never pushed.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Channel = "email" | "sms" | "matrix";

export interface Contact {
  id: string;
  name: string;
  email: string;
  gv_number: string;
  matrix_id: string;
  matrix_room_id: string;
  color: string;
  notes: string;
  photo: string; // custom avatar data URL; falls back to Gravatar when empty
  archived: number;
  created_at: string;
}

export const MAX_PEOPLE = 8;

export interface Conversation {
  id: string;
  name: string;
  is_group: number;
  matrix_room_id: string;
  last_read_at: string;
  archived: number;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  channel: Channel;
  direction: "in" | "out";
  body: string;
  subject: string;
  external_id: string;
  /** Original email Message-ID (for In-Reply-To threading); "" when none. */
  message_id: string;
  /** JSON array of contact ids involved in the message; "" when unknown. */
  participants: string;
  status: string;
  created_at: string;
}

export interface Attachment {
  id: string;
  message_id: string;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
}

let db: Database;

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      gv_number TEXT NOT NULL DEFAULT '',
      matrix_id TEXT NOT NULL DEFAULT '',
      matrix_room_id TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      is_group INTEGER NOT NULL DEFAULT 0,
      matrix_room_id TEXT NOT NULL DEFAULT '',
      last_read_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      conversation_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      external_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      /** JSON array of contact ids involved in the message; "" when unknown. */
      participants TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_ext ON messages(external_id);
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      mime TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      uid TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      organizer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appt_conv ON appointments(conversation_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_appt_msg ON appointments(message_id);
    CREATE INDEX IF NOT EXISTS idx_appt_uid ON appointments(uid);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
  // Migration: archived flag on contacts (older DBs lack the column).
  const cols = db.query("PRAGMA table_info(contacts)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "archived")) {
    db.exec("ALTER TABLE contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  // Migration: archived flag on conversations (older DBs lack the column).
  const convCols = db.query("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!convCols.some((c) => c.name === "archived")) {
    db.exec("ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  // Migration: custom contact photo (older DBs lack the column).
  if (!cols.some((c) => c.name === "photo")) {
    db.exec("ALTER TABLE contacts ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
  }
  // Migration: original email Message-ID for reply threading (older DBs lack it).
  const msgCols = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!msgCols.some((c) => c.name === "message_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN message_id TEXT NOT NULL DEFAULT ''");
  }
  // Migration: participant contact ids per message (older DBs lack the column).
  if (!msgCols.some((c) => c.name === "participants")) {
    db.exec("ALTER TABLE messages ADD COLUMN participants TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

export function getDb(): Database {
  return db;
}

const now = () => new Date().toISOString();
export const uid = () =>
  (globalThis.crypto as any)?.randomUUID
    ? (globalThis.crypto as any).randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// ---------- contacts ----------

export function listContacts(): Contact[] {
  return db.query("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all() as Contact[];
}

/** Active (non-archived) contacts — the ones that count against MAX_PEOPLE. */
export function listActiveContacts(): Contact[] {
  return db.query("SELECT * FROM contacts WHERE archived = 0 ORDER BY name COLLATE NOCASE").all() as Contact[];
}

export function listArchivedContacts(): Contact[] {
  return db.query("SELECT * FROM contacts WHERE archived = 1 ORDER BY name COLLATE NOCASE").all() as Contact[];
}

export function getContact(id: string): Contact | null {
  return (db.query("SELECT * FROM contacts WHERE id = ?").get(id) as Contact) || null;
}

export function countContacts(): number {
  return (db.query("SELECT COUNT(*) AS n FROM contacts").get() as any).n as number;
}

export function countActiveContacts(): number {
  return (db.query("SELECT COUNT(*) AS n FROM contacts WHERE archived = 0").get() as any).n as number;
}

export function createContact(c: Omit<Contact, "id" | "created_at" | "archived"> & { archived?: number }): Contact {
  if (countActiveContacts() >= MAX_PEOPLE) throw new Error(`Relay keeps things small — ${MAX_PEOPLE} contacts maximum.`);
  const row: Contact = { photo: "", ...c, archived: c.archived ? 1 : 0, id: uid(), created_at: now() };
  db.query(
    "INSERT INTO contacts (id, name, email, gv_number, matrix_id, matrix_room_id, color, notes, photo, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.name, row.email, row.gv_number, row.matrix_id, row.matrix_room_id, row.color, row.notes, row.photo, row.archived, row.created_at);
  return row;
}

export function updateContact(id: string, patch: Partial<Omit<Contact, "id" | "created_at">>): Contact | null {
  const cur = getContact(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  if ("archived" in patch) next.archived = patch.archived ? 1 : 0;
  db.query(
    "UPDATE contacts SET name = ?, email = ?, gv_number = ?, matrix_id = ?, matrix_room_id = ?, color = ?, notes = ?, photo = ?, archived = ? WHERE id = ?"
  ).run(next.name, next.email, next.gv_number, next.matrix_id, next.matrix_room_id, next.color, next.notes, next.photo, next.archived, id);
  return next;
}

export function deleteContact(id: string): string[] {
  // Delete 1:1 conversations with this contact; remove them from groups.
  // Returns attachment ids removed, so the caller can delete their files.
  const removed: string[] = [];
  const convs = db.query("SELECT c.id, c.is_group FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE m.contact_id = ?").all(id) as { id: string; is_group: number }[];
  for (const c of convs) {
    if (c.is_group) {
      db.query("DELETE FROM members WHERE conversation_id = ? AND contact_id = ?").run(c.id, id);
    } else {
      removed.push(...deleteConversationData(c.id));
    }
  }
  db.query("DELETE FROM contacts WHERE id = ?").run(id);
  return removed;
}

// ---------- conversations ----------

export function getConversation(id: string): Conversation | null {
  return (db.query("SELECT * FROM conversations WHERE id = ?").get(id) as Conversation) || null;
}

export function conversationMembers(convId: string): Contact[] {
  return db.query(
    "SELECT c.* FROM contacts c JOIN members m ON m.contact_id = c.id WHERE m.conversation_id = ? ORDER BY c.name COLLATE NOCASE"
  ).all(convId) as Contact[];
}

/** Find (or create) the 1:1 conversation for a contact. */
export function dmFor(contactId: string): Conversation {
  const existing = db.query(
    "SELECT c.* FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE c.is_group = 0 AND m.contact_id = ? LIMIT 1"
  ).get(contactId) as Conversation | null;
  if (existing) return existing;
  const conv: Conversation = { id: uid(), name: "", is_group: 0, matrix_room_id: "", last_read_at: now(), created_at: now() };
  db.query("INSERT INTO conversations (id, name, is_group, matrix_room_id, last_read_at, created_at) VALUES (?, ?, 0, '', ?, ?)").run(
    conv.id, conv.name, conv.last_read_at, conv.created_at
  );
  db.query("INSERT INTO members (conversation_id, contact_id) VALUES (?, ?)").run(conv.id, contactId);
  return conv;
}

export function createGroup(name: string, memberIds: string[], matrixRoomId = ""): Conversation {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) throw new Error("Add at least one person to the group.");
  if (unique.length + 1 > MAX_PEOPLE) throw new Error(`Groups are small by design — ${MAX_PEOPLE} people maximum, you included.`);
  const conv: Conversation = { id: uid(), name: name.trim() || "Group", is_group: 1, matrix_room_id: matrixRoomId, last_read_at: now(), created_at: now() };
  db.query("INSERT INTO conversations (id, name, is_group, matrix_room_id, last_read_at, created_at) VALUES (?, ?, 1, ?, ?, ?)").run(
    conv.id, conv.name, conv.matrix_room_id, conv.last_read_at, conv.created_at
  );
  for (const mid of unique) db.query("INSERT OR IGNORE INTO members (conversation_id, contact_id) VALUES (?, ?)").run(conv.id, mid);
  return conv;
}

export function listConversations(includeArchived = false): (Conversation & { member_count: number; last_body: string; last_at: string; last_channel: string; last_direction: string; unread: number })[] {
  return db.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id) AS member_count,
      (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_at,
      (SELECT channel FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_channel,
      (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_direction,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND direction = 'in' AND created_at > c.last_read_at) AS unread
    FROM conversations c
    ${includeArchived ? "" : "WHERE c.archived = 0"}
    ORDER BY COALESCE(last_at, c.created_at) DESC
  `).all() as any[];
}

/** Archive (or unarchive) a conversation. Archived threads stay routable —
    new mail still lands in the existing thread — but hide from the list. */
export function setConversationArchived(id: string, archived: boolean): void {
  db.query("UPDATE conversations SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
}

export function markRead(convId: string): void {
  db.query("UPDATE conversations SET last_read_at = ? WHERE id = ?").run(now(), convId);
}

// ---------- messages ----------

export function listMessages(convId: string, limit = 100, before?: string): Message[] {
  if (before) {
    return db.query("SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(convId, before, limit) as Message[];
  }
  return db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?").all(convId, limit) as Message[];
}

export function insertMessage(m: Omit<Message, "id" | "created_at" | "message_id" | "participants"> & { created_at?: string; message_id?: string; participants?: string[] }): Message {
  const row = { ...m, id: uid(), created_at: m.created_at || now() } as Message;
  const parts = m.participants ?? conversationMembers(row.conversation_id).map((c) => c.id);
  row.message_id = m.message_id || "";
  row.participants = JSON.stringify(parts);
  db.query(
    "INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, message_id, participants, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.conversation_id, row.channel, row.direction, row.body, row.subject, row.external_id, row.message_id, row.participants, row.status, row.created_at);
  return row;
}

export function hasExternalId(externalId: string): boolean {
  return !!(db.query("SELECT 1 FROM messages WHERE external_id = ? LIMIT 1").get(externalId) as any);
}

// ---------- attachments ----------

/** File bytes live on disk under <data>/attachments/<id>; this is the metadata. */
export function insertAttachment(a: { message_id: string; filename: string; mime: string; size: number }): Attachment {
  const row: Attachment = { ...a, id: uid(), created_at: now() };
  db.query(
    "INSERT INTO attachments (id, message_id, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.message_id, row.filename, row.mime, row.size, row.created_at);
  return row;
}

export function getAttachment(id: string): Attachment | null {
  return (db.query("SELECT * FROM attachments WHERE id = ?").get(id) as Attachment) || null;
}

// ---------- appointments ----------

export interface Appointment {
  id: string;
  conversation_id: string;
  message_id: string;
  uid: string;
  title: string;
  starts_at: string;
  ends_at: string;
  location: string;
  description: string;
  organizer: string;
  /** sent | received | accepted | declined | cancelled */
  status: string;
  created_at: string;
}

export function insertAppointment(a: {
  conversation_id: string; message_id?: string; uid?: string; title: string;
  starts_at: string; ends_at: string; location?: string; description?: string;
  organizer?: string; status?: string;
}): Appointment {
  const row: Appointment = {
    id: uid(),
    conversation_id: a.conversation_id,
    message_id: a.message_id || "",
    uid: a.uid || "",
    title: a.title,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    location: a.location || "",
    description: a.description || "",
    organizer: a.organizer || "",
    status: a.status || "sent",
    created_at: now(),
  };
  db.query(`INSERT INTO appointments
    (id, conversation_id, message_id, uid, title, starts_at, ends_at, location, description, organizer, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.conversation_id, row.message_id, row.uid, row.title, row.starts_at,
    row.ends_at, row.location, row.description, row.organizer, row.status, row.created_at);
  return row;
}

/** Every appointment in a conversation, chronological. */
export function listAppointments(convId: string): Appointment[] {
  return db.query("SELECT * FROM appointments WHERE conversation_id = ? ORDER BY starts_at, created_at")
    .all(convId) as Appointment[];
}

export function getAppointment(id: string): Appointment | null {
  return (db.query("SELECT * FROM appointments WHERE id = ?").get(id) as Appointment) || null;
}

export function getAppointmentByUid(uid: string): Appointment | null {
  if (!uid) return null;
  return (db.query("SELECT * FROM appointments WHERE uid = ? LIMIT 1").get(uid) as Appointment) || null;
}

/** First appointment per message, for a batch of message ids. */
export function getAppointmentsForMessages(messageIds: string[]): Map<string, Appointment> {
  const out = new Map<string, Appointment>();
  if (!messageIds.length) return out;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.query(
    `SELECT * FROM appointments WHERE message_id IN (${placeholders}) ORDER BY created_at`
  ).all(...messageIds) as Appointment[];
  for (const r of rows) if (r.message_id && !out.has(r.message_id)) out.set(r.message_id, r);
  return out;
}

export function setAppointmentStatus(id: string, status: string): Appointment | null {
  db.query("UPDATE appointments SET status = ? WHERE id = ?").run(status, id);
  return getAppointment(id);
}

/** All attachments for a set of message ids, in one query. */
export function listAttachmentsForMessages(messageIds: string[]): Attachment[] {
  if (!messageIds.length) return [];
  const placeholders = messageIds.map(() => "?").join(",");
  return db.query(`SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at, rowid`).all(...messageIds) as Attachment[];
}

/** Newest files shared in a conversation, for the shared-files widget. */
export function listConversationAttachments(convId: string, limit = 30): (Attachment & { direction: string; sent_at: string })[] {
  return db.query(`
    SELECT a.*, m.direction AS direction, m.created_at AS sent_at
    FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE m.conversation_id = ?
    ORDER BY m.created_at DESC, a.created_at DESC
    LIMIT ?
  `).all(convId, limit) as (Attachment & { direction: string; sent_at: string })[];
}

/**
 * Search a conversation's attachments by filename, scoped to the last
 * `days` days (default 90). Case-insensitive substring match; LIKE wildcards
 * in the query are escaped so they match literally.
 */
export function searchConversationAttachments(convId: string, q: string, days = 90, limit = 30): (Attachment & { direction: string; sent_at: string })[] {
  const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const daysInt = Math.max(1, Math.min(365, Math.floor(Number(days) || 90)));
  return db.query(`
    SELECT a.*, m.direction AS direction, m.created_at AS sent_at
    FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE m.conversation_id = ?
      AND a.filename LIKE ? ESCAPE '\\'
      AND m.created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY m.created_at DESC, a.created_at DESC
    LIMIT ?
  `).all(convId, like, daysInt, limit) as (Attachment & { direction: string; sent_at: string })[];
}

/**
 * Delete every message in a conversation (plus members + the conversation row).
 * Returns the attachment ids removed, so the caller can delete their files.
 */
export function deleteConversationData(convId: string): string[] {
  const atts = db.query(
    "SELECT a.id AS id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?"
  ).all(convId) as { id: string }[];
  const ids = atts.map((a) => a.id);
  db.query("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)").run(convId);
  db.query("DELETE FROM messages WHERE conversation_id = ?").run(convId);
  db.query("DELETE FROM members WHERE conversation_id = ?").run(convId);
  db.query("DELETE FROM conversations WHERE id = ?").run(convId);
  return ids;
}

// ---------- kv ----------

export function kvGet(key: string): string {
  return ((db.query("SELECT value FROM kv WHERE key = ?").get(key) as any)?.value as string) || "";
}

export function kvSet(key: string, value: string): void {
  db.query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
