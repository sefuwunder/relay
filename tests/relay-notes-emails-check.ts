// Relay notes-mail feed checks (for Abba ingest):
//  1. GET /api/relay/notes-emails returns seeded note emails with full bodies
//  2. ?since= accepts ms and unix seconds (magnitude check)
//  3. ?limit= caps results; results ascend by date
//  4. uid dedupe: insertNotesMail skips duplicates
// Run: bun tests/relay-notes-emails-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, insertNotesMail, hasNotesMailUid, listNotesMail } from "../src/db";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

const dir = mkdtempSync(join(tmpdir(), "relay-notes-"));
const { spawn, execSync } = await import("node:child_process");
const { mkdirSync, writeFileSync } = await import("node:fs");
execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
  imap: { host: "", port: 993, user: "me@example.com", pass: "", notes_folder: "Notes" },
  smtp: { from: "me@example.com" },
}));

// Seed directly through db.ts (same store the notes-folder poll writes).
openDb(join(dir, "data", "relay.db"));
const t0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const longBody = "# Shopping list\n\n- oat milk\n- bread\n\n" + "x".repeat(3000); // > 2000 chars: must NOT be truncated
const n1 = insertNotesMail({ uid: "1001", message_id: "<n1@x>", subject: "Shopping list", body: longBody, from_addr: "me@example.com", date_iso: iso(t0) });
const n2 = insertNotesMail({ uid: "1002", message_id: "<n2@x>", subject: "Idea", body: "an idea", from_addr: "me@example.com", date_iso: iso(t0 + 60000) });

// uid dedupe
const dup = insertNotesMail({ uid: "1001", subject: "changed", body: "changed", date_iso: iso(t0 + 99999) });
ok(hasNotesMailUid("1001"), "hasNotesMailUid finds stored uid");
ok(!hasNotesMailUid("9999"), "hasNotesMailUid misses unknown uid");
ok(listNotesMail(iso(0), 50).length === 2, `uid dedupe keeps 2 rows (got ${listNotesMail(iso(0), 50).length})`);

// Boot the server against the seeded DB.
const port = 4600 + Math.floor(Math.random() * 800);
const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
const wait = async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/api/conversations"); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
};

try {
  await wait();

  // 1. shape + full body
  const j = await (await fetch(base + "/api/relay/notes-emails")).json();
  ok(Array.isArray(j.emails), "emails is an array");
  ok(j.emails.length === 2, `two note emails returned (got ${j.emails.length})`);
  const [e1, e2] = j.emails;
  ok(e1.id === n1.id, "first item is the oldest (ascending)");
  ok(e1.subject === "Shopping list", "subject passes through");
  ok(e1.body === longBody, `body is FULL, not truncated (${e1.body.length} chars)`);
  ok(e1.from === "me@example.com", "from passes through");
  ok(e1.message_id === "<n1@x>", "message_id passes through");
  ok(e1.date === Math.floor(t0 / 1000), `date is unix seconds (${e1.date})`);
  ok(e2.id === n2.id, "second item is the newer one");

  // 2. since cursor: ms and seconds
  const jMs = await (await fetch(`${base}/api/relay/notes-emails?since=${t0 + 30000}`)).json();
  ok(jMs.emails.length === 1 && jMs.emails[0].id === n2.id, `ms since pages forward (got ${jMs.emails.length})`);
  const jSec = await (await fetch(`${base}/api/relay/notes-emails?since=${Math.floor((t0 + 30000) / 1000)}`)).json();
  ok(jSec.emails.length === 1 && jSec.emails[0].id === n2.id, `seconds since pages forward (got ${jSec.emails.length})`);
  const jFuture = await (await fetch(`${base}/api/relay/notes-emails?since=${Date.now() + 60000}`)).json();
  ok(jFuture.emails.length === 0, "future since returns empty");

  // 3. limit
  const jLim = await (await fetch(`${base}/api/relay/notes-emails?limit=1`)).json();
  ok(jLim.emails.length === 1, "limit=1 caps results");
} finally {
  srv.kill();
}

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
