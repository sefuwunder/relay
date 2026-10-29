// ninep-server.ts — Relay as a read-only 9P2000 tree.
//
// Run: bun src/ninep-server.ts
//   RELAY_DATA_DIR (default: <repo>/data) — relay.db lives here.
//   NINEP_PORT (default 9006), loopback only.
//
// Tree (read-only; writes answer "permission denied"):
//   /contacts/<id>/{name, email, gv_number, matrix_id, notes}
//   /threads/<conv>/{name, is_group, members, member_names,
//                    messages/<msg>/{channel, direction, subject, body, created, participants}}
//
// members lists contact ids, one per line; member_names lists names.
// Message files are the raw bodies; subject is empty for chat messages.

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveNineP, type DirNode, type FileNode, type Node } from "./ninep.ts";

function textFile(name: string, path: string, get: () => string): FileNode {
  return {
    kind: "file", name, path,
    len: () => new TextEncoder().encode(get()).length,
    read: (off: number, count: number) => new TextEncoder().encode(get()).slice(off, off + count),
    mtime: () => Date.now(),
  };
}

function dir(name: string, path: string, list: () => { name: string; isDir: boolean }[],
  get: (n: string) => Node | null): DirNode {
  return { kind: "dir", name, path, list, get, mtime: () => Date.now() };
}

export function buildRelayTree(db: Database): DirNode {
  const all = (sql: string, ...args: any[]): any[] => db.query(sql).all(...args) as any[];
  const one = (sql: string, ...args: any[]): any => db.query(sql).get(...args) as any;

  const msgNode = (convId: string, m: any): DirNode =>
    dir(m.id, `/threads/${convId}/messages/${m.id}`,
      () => [
        { name: "channel", isDir: false }, { name: "direction", isDir: false },
        { name: "subject", isDir: false }, { name: "body", isDir: false },
        { name: "created", isDir: false }, { name: "participants", isDir: false },
      ],
      (n: string) => {
        const p = `/threads/${convId}/messages/${m.id}/${n}`;
        if (n === "channel") return textFile(n, p, () => m.channel);
        if (n === "direction") return textFile(n, p, () => m.direction);
        if (n === "subject") return textFile(n, p, () => m.subject);
        if (n === "body") return textFile(n, p, () => m.body);
        if (n === "created") return textFile(n, p, () => m.created_at);
        if (n === "participants") return textFile(n, p, () => m.participants || "");
        return null;
      });

  const threadNode = (c: any): DirNode =>
    dir(c.id, `/threads/${c.id}`,
      () => [
        { name: "name", isDir: false }, { name: "is_group", isDir: false },
        { name: "members", isDir: false }, { name: "member_names", isDir: false },
        { name: "messages", isDir: true },
      ],
      (n: string) => {
        const p = `/threads/${c.id}/${n}`;
        if (n === "name") return textFile(n, p, () => c.name);
        if (n === "is_group") return textFile(n, p, () => (c.is_group ? "1" : "0"));
        if (n === "members") {
          return textFile(n, p, () =>
            all("SELECT contact_id FROM members WHERE conversation_id = ?", c.id)
              .map((m) => m.contact_id).join("\n") + "\n");
        }
        if (n === "member_names") {
          return textFile(n, p, () =>
            all(`SELECT c.name FROM members m JOIN contacts c ON c.id = m.contact_id
                 WHERE m.conversation_id = ? ORDER BY c.name`, c.id)
              .map((m) => m.name).join("\n") + "\n");
        }
        if (n === "messages") {
          return dir("messages", `/threads/${c.id}/messages`,
            () => all("SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at", c.id)
              .map((m) => ({ name: m.id, isDir: true })),
            (mid: string) => {
              const m = one("SELECT * FROM messages WHERE id = ? AND conversation_id = ?", mid, c.id);
              return m ? msgNode(c.id, m) : null;
            });
        }
        return null;
      });

  const threads = dir("threads", "/threads",
    () => all("SELECT id FROM conversations ORDER BY created_at").map((c) => ({ name: c.id, isDir: true })),
    (id: string) => {
      const c = one("SELECT * FROM conversations WHERE id = ?", id);
      return c ? threadNode(c) : null;
    });

  const contacts = dir("contacts", "/contacts",
    () => all("SELECT id FROM contacts ORDER BY name").map((c) => ({ name: c.id, isDir: true })),
    (id: string) => {
      const c = one("SELECT * FROM contacts WHERE id = ?", id);
      if (!c) return null;
      return dir(id, `/contacts/${id}`,
        () => [
          { name: "name", isDir: false }, { name: "email", isDir: false },
          { name: "gv_number", isDir: false }, { name: "matrix_id", isDir: false },
          { name: "notes", isDir: false },
        ],
        (n: string) => {
          const p = `/contacts/${id}/${n}`;
          if (n === "name") return textFile(n, p, () => c.name);
          if (n === "email") return textFile(n, p, () => c.email);
          if (n === "gv_number") return textFile(n, p, () => c.gv_number);
          if (n === "matrix_id") return textFile(n, p, () => c.matrix_id);
          if (n === "notes") return textFile(n, p, () => c.notes);
          return null;
        });
    });

  const rootChildren: Record<string, Node> = { contacts, threads };
  return dir("", "/",
    () => Object.keys(rootChildren).map((n) => ({ name: n, isDir: true })),
    (n: string) => rootChildren[n] || null);
}

export function startRelayNinep(opts: { dbPath: string; port: number; hostname?: string }) {
  const db = new Database(opts.dbPath, { readonly: true });
  return serveNineP(buildRelayTree(db), { port: opts.port, hostname: opts.hostname });
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.RELAY_DATA_DIR || join(here, "..", "data");
  const port = Number(process.env.NINEP_PORT || 9006);
  startRelayNinep({ dbPath: join(dataDir, "relay.db"), port });
  console.log(`relay 9P (read-only) on 127.0.0.1:${port} db ${join(dataDir, "relay.db")}`);
}
