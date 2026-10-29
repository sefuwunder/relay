// ninep-relay.test.ts — Relay 9P tree (read-only) against a temp database.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { startRelayNinep } from "../src/ninep-server.ts";
import { NinePClient } from "../src/ninep.ts";

let tmp = "";
let server: any;
let port = 0;
let db: Database;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "relay-9p-"));
  db = new Database(join(tmp, "relay.db"));
  db.run(`CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
    is_group INTEGER NOT NULL DEFAULT 0, matrix_room_id TEXT NOT NULL DEFAULT '',
    last_read_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE members (conversation_id TEXT NOT NULL, contact_id TEXT NOT NULL)`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    channel TEXT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL DEFAULT '', participants TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '', gv_number TEXT NOT NULL DEFAULT '',
    matrix_id TEXT NOT NULL DEFAULT '', matrix_room_id TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`);
  db.run("INSERT INTO contacts (id, name, email) VALUES ('c1', 'Jane Acme', 'jane@acme.example')");
  db.run("INSERT INTO conversations (id, name, is_group, created_at) VALUES ('conv-1', 'Jane Acme', 0, '2026-10-28')");
  db.run("INSERT INTO conversations (id, name, is_group, created_at) VALUES ('conv-2', 'Team', 1, '2026-10-28')");
  db.run("INSERT INTO members (conversation_id, contact_id) VALUES ('conv-1', 'c1')");
  db.run(`INSERT INTO messages (id, conversation_id, channel, direction, body, subject, participants, created_at)
    VALUES ('m1', 'conv-1', 'email', 'in', 'Hi there', 'Hello', '["c1"]', '2026-10-28T10:00:00Z')`);
  server = startRelayNinep({ dbPath: join(tmp, "relay.db"), port: 0 });
  port = server.port;
});

afterAll(() => {
  server.stop();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function client() {
  const c = new NinePClient();
  await c.connect("127.0.0.1", port);
  return c;
}

describe("relay 9P tree", () => {
  test("threads, messages, contacts read", async () => {
    const c = await client();
    try {
      expect((await c.listDir("/")).map((e) => e.name).sort()).toEqual(["contacts", "threads"]);
      expect(await c.readFile("/threads/conv-1/name")).toBe("Jane Acme");
      expect(await c.readFile("/threads/conv-1/is_group")).toBe("0");
      expect(await c.readFile("/threads/conv-2/is_group")).toBe("1");
      expect(await c.readFile("/threads/conv-1/member_names")).toContain("Jane Acme");
      expect(await c.readFile("/threads/conv-1/messages/m1/body")).toBe("Hi there");
      expect(await c.readFile("/threads/conv-1/messages/m1/channel")).toBe("email");
      expect(await c.readFile("/contacts/c1/email")).toBe("jane@acme.example");
    } finally {
      c.close();
    }
  });

  test("tree is read-only", async () => {
    const c = await client();
    try {
      await expect(c.writeFile("/threads/conv-1/name", "Nope")).rejects.toThrow();
      await expect(c.mkdir("/threads/new")).rejects.toThrow();
    } finally {
      c.close();
    }
  });
});
