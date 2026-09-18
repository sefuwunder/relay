// Archive conversation checks: archiving hides a thread from the default
// list, the archived view lists it, unarchiving restores it, internal routing
// still sees archived threads (no duplicates), the HTTP endpoints behave,
// and old DBs gain the column via migration.
// Run: bun tests/archive-conversation-check.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { Database } from "bun:sqlite";

let passed = 0;
function ok(cond: unknown, label: string) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exitCode = 1; return; }
  passed++;
}

// ---------- 1. archive / unarchive round-trip at the db layer ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-arch-"));
  const db = await import("../src/db.ts");
  db.openDb(join(dir, "relay.db"));
  const a = db.createContact({ name: "Alma", email: "alma@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "#0a84ff", notes: "" });
  const b = db.createContact({ name: "Ben", email: "ben@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "#30d158", notes: "" });
  const dm = db.dmFor(a.id);
  const grp = db.createGroup("Book club", [a.id, b.id]);
  db.insertMessage({ conversation_id: dm.id, channel: "email", direction: "in", body: "hi", subject: "", external_id: "", status: "" });

  ok(db.listConversations().length === 2, "default list shows both threads");
  ok(db.listConversations(true).length === 2, "includeArchived shows both threads");

  db.setConversationArchived(dm.id, true);
  ok(db.getConversation(dm.id)?.archived === 1, "archived flag persists");
  const def = db.listConversations();
  ok(def.length === 1 && def[0].id === grp.id, "archived DM leaves the default list");
  const all = db.listConversations(true);
  ok(all.length === 2, "routing view still sees the archived thread");
  ok(all.some((c) => c.id === dm.id && c.archived === 1), "archived row carries its flag");

  db.setConversationArchived(dm.id, false);
  ok(db.listConversations().length === 2, "unarchiving restores the thread");
  ok(db.getConversation(dm.id)?.archived === 0, "unarchive clears the flag");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 2. migration: old DBs gain the column ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-archmig-"));
  const raw = new Database(join(dir, "relay.db"), { create: true });
  raw.exec(`CREATE TABLE conversations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', is_group INTEGER NOT NULL DEFAULT 0,
    matrix_room_id TEXT NOT NULL DEFAULT '', last_read_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );`);
  raw.exec(`CREATE TABLE members (conversation_id TEXT NOT NULL, contact_id TEXT NOT NULL, PRIMARY KEY (conversation_id, contact_id));`);
  raw.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, channel TEXT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '', participants TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);`);
  raw.close();
  const db = await import("../src/db.ts");
  db.openDb(join(dir, "relay.db"));
  const cols = db.getDb().query("PRAGMA table_info(conversations)").all() as { name: string }[];
  ok(cols.some((c) => c.name === "archived"), "migration adds archived to conversations");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 3. HTTP: GET filter + PATCH toggle ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-archhttp-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: 1, user: "me", pass: "x", secure: false },
    smtp: { host: "127.0.0.1", port: 1, secure: "none", user: "", pass: "", from: "me@example.com", fromName: "Me" },
  }));
  const port = 4600 + Math.floor(Math.random() * 500);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = async (p: string, body: any) => {
    const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const patch = async (p: string, body: any) => {
    const r = await fetch(base + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error("server did not start");
    }
    const a = await post("/api/contacts", { name: "Alma", email: "alma@example.com" });
    const b = await post("/api/contacts", { name: "Ben", email: "ben@example.com" });
    const g = await post("/api/conversations", { name: "Book club", member_ids: [a.json.contact.id, b.json.contact.id] });
    const gid = g.json.conversation.id;
    const n0 = (await get("/api/conversations")).conversations.length;

    ok(n0 >= 3, "HTTP: DMs plus the group are listed by default");
    ok((await get("/api/conversations?archived=1")).conversations.length === 0, "HTTP: archived view empty at first");

    const p1 = await patch("/api/conversations/" + gid, { archived: 1 });
    ok(p1.status === 200 && p1.json.conversation.archived === 1, "HTTP: PATCH archived=1 sticks");
    const def = (await get("/api/conversations")).conversations;
    ok(def.length === n0 - 1 && !def.some((c: any) => c.id === gid), "HTTP: archived thread leaves the default list");
    const arch = (await get("/api/conversations?archived=1")).conversations;
    ok(arch.length === 1 && arch[0].id === gid && arch[0].archived === true, "HTTP: archived view lists it with the flag");

    const p0 = await patch("/api/conversations/" + gid, { archived: 0 });
    ok(p0.status === 200 && p0.json.conversation.archived === 0, "HTTP: PATCH archived=0 unarchives");
    ok((await get("/api/conversations")).conversations.length === n0, "HTTP: thread returns to the default list");

    const bad = await patch("/api/conversations/nope", { archived: 1 });
    ok(bad.status === 404, "HTTP: PATCH on a missing thread 404s");
  } finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`archive-conversation: ${passed} passed`);
