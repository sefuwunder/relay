// Relay persistence: Bun's built-in SQLite.
// Contacts and conversations are the user's private data — the DB lives in
// gitignored ./data and is never pushed.

import { Database } from "bun:sqlite";

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
  created_at: string;
}

export interface Conversation {
  id: string;
  name: string;
  is_group: number;
  matrix_room_id: string;
  last_read_at: string;
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
  status: string;
  created_at: string;
}

export const MAX_PEOPLE = 8;

let db: Database;

export function openDb(path: string): Database {
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
      status TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_ext ON messages(external_id);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
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

export function getContact(id: string): Contact | null {
  return (db.query("SELECT * FROM contacts WHERE id = ?").get(id) as Contact) || null;
}

export function countContacts(): number {
  return (db.query("SELECT COUNT(*) AS n FROM contacts").get() as any).n as number;
}

export function createContact(c: Omit<Contact, "id" | "created_at">): Contact {
  if (countContacts() >= MAX_PEOPLE) throw new Error(`Relay keeps things small — ${MAX_PEOPLE} contacts maximum.`);
  const row: Contact = { ...c, id: uid(), created_at: now() };
  db.query(
    "INSERT INTO contacts (id, name, email, gv_number, matrix_id, matrix_room_id, color, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.name, row.email, row.gv_number, row.matrix_id, row.matrix_room_id, row.color, row.notes, row.created_at);
  return row;
}

export function updateContact(id: string, patch: Partial<Omit<Contact, "id" | "created_at">>): Contact | null {
  const cur = getContact(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.query(
    "UPDATE contacts SET name = ?, email = ?, gv_number = ?, matrix_id = ?, matrix_room_id = ?, color = ?, notes = ? WHERE id = ?"
  ).run(next.name, next.email, next.gv_number, next.matrix_id, next.matrix_room_id, next.color, next.notes, id);
  return next;
}

export function deleteContact(id: string): void {
  // Delete 1:1 conversations with this contact; remove them from groups.
  const convs = db.query("SELECT c.id, c.is_group FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE m.contact_id = ?").all(id) as { id: string; is_group: number }[];
  for (const c of convs) {
    if (c.is_group) {
      db.query("DELETE FROM members WHERE conversation_id = ? AND contact_id = ?").run(c.id, id);
    } else {
      db.query("DELETE FROM messages WHERE conversation_id = ?").run(c.id);
      db.query("DELETE FROM members WHERE conversation_id = ?").run(c.id);
      db.query("DELETE FROM conversations WHERE id = ?").run(c.id);
    }
  }
  db.query("DELETE FROM contacts WHERE id = ?").run(id);
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

export function listConversations(): (Conversation & { member_count: number; last_body: string; last_at: string; last_channel: string; last_direction: string; unread: number })[] {
  return db.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id) AS member_count,
      (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_at,
      (SELECT channel FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_channel,
      (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_direction,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND direction = 'in' AND created_at > c.last_read_at) AS unread
    FROM conversations c
    ORDER BY COALESCE(last_at, c.created_at) DESC
  `).all() as any[];
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

export function insertMessage(m: Omit<Message, "id" | "created_at"> & { created_at?: string }): Message {
  const row: Message = { ...m, id: uid(), created_at: m.created_at || now() };
  db.query(
    "INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.conversation_id, row.channel, row.direction, row.body, row.subject, row.external_id, row.status, row.created_at);
  return row;
}

export function hasExternalId(externalId: string): boolean {
  return !!(db.query("SELECT 1 FROM messages WHERE external_id = ? LIMIT 1").get(externalId) as any);
}

// ---------- kv ----------

export function kvGet(key: string): string {
  return ((db.query("SELECT value FROM kv WHERE key = ?").get(key) as any)?.value as string) || "";
}

export function kvSet(key: string, value: string): void {
  db.query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
