// Relay email feed checks (for Switchboard):
//  1. GET /api/relay/emails returns seeded email messages with the documented shape
//  2. non-email channels are excluded; snippet truncates at 200 chars
//  3. has_attachments reflects the attachments table
//  4. ?since= cursor pages forward; ?limit= caps results
// Run: bun tests/relay-emails-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, createContact, dmFor, insertMessage, insertAttachment } from "../src/db";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

const dir = mkdtempSync(join(tmpdir(), "relay-emails-"));
const { spawn } = await import("node:child_process");
const { mkdirSync, writeFileSync } = await import("node:fs");
const { execSync } = await import("node:child_process");
execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
mkdirSync(join(dir, "data"), { recursive: true });
writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
  imap: { host: "", port: 993, user: "me@example.com", pass: "" },
  smtp: { from: "me@example.com" },
}));

// Seed directly through db.ts (same store the IMAP poll writes).
openDb(join(dir, "data", "relay.db"));
const contact = createContact({ name: "Danyetta Cole", email: "danyetta@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "", notes: "", photo: "" });
const conv = dmFor(contact.id);
const t0 = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const longBody = "x".repeat(500);
const m1 = insertMessage({
  conversation_id: conv.id, channel: "email", direction: "in",
  body: longBody, subject: "Q4 numbers", external_id: "mail:1",
  message_id: "<a@x>", status: "", participants: [contact.id], created_at: iso(t0),
});
const m2 = insertMessage({
  conversation_id: conv.id, channel: "email", direction: "out",
  body: "Thanks, reviewing now.", subject: "Re: Q4 numbers", external_id: "mail:2",
  message_id: "<b@x>", status: "sent", participants: [contact.id], created_at: iso(t0 + 60000),
});
insertMessage({ // non-email channel: must not appear in the feed
  conversation_id: conv.id, channel: "sms", direction: "in",
  body: "sms body", subject: "", external_id: "sms:1",
  message_id: "", status: "", participants: [contact.id], created_at: iso(t0 + 120000),
});
insertAttachment({ message_id: m1.id, filename: "q4.pdf", mime: "application/pdf", size: 1234 });

// Boot the server against the seeded DB.
const port = 4400 + Math.floor(Math.random() * 800);
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

  // 1. shape + field mapping
  const j = await (await fetch(base + "/api/relay/emails")).json();
  ok(Array.isArray(j.emails), "emails is an array");
  ok(j.emails.length === 2, `two email messages returned (got ${j.emails.length})`);
  const [e1, e2] = j.emails;
  ok(e1.id === m1.id, "first item is the oldest (ascending)");
  ok(e1.from === "danyetta@example.com" && e1.from_name === "Danyetta Cole", `inbound from resolves via contact (${e1.from}/${e1.from_name})`);
  ok(e1.to === "me@example.com", `inbound to is self (${e1.to})`);
  ok(e1.subject === "Q4 numbers", "subject passes through");
  ok(e1.snippet.length === 200 && e1.snippet === "x".repeat(200), "snippet truncates body at 200 chars");
  ok(e1.date === Math.floor(t0 / 1000), `date is unix seconds (${e1.date})`);
  ok(e1.has_attachments === true, "has_attachments true when files ride along");
  ok(e2.has_attachments === false, "has_attachments false otherwise");
  ok(e2.from === "me@example.com" && e2.from_name === "me", "outbound from is self");
  ok(e2.to === "danyetta@example.com", `outbound to lists contacts (${e2.to})`);
  const keys = Object.keys(e1).sort().join(",");
  ok(keys === "date,from,from_name,has_attachments,id,snippet,subject,to", `exact field set (${keys})`);

  // 2. since cursor
  const j2 = await (await fetch(base + `/api/relay/emails?since=${Math.floor(t0 / 1000)}`)).json();
  ok(j2.emails.length === 1 && j2.emails[0].id === m2.id, "since= filters to newer messages");
  const j3 = await (await fetch(base + `/api/relay/emails?since=${Math.floor(t0 / 1000) + 3600}`)).json();
  ok(j3.emails.length === 0, "since= past everything returns empty");

  // 3. limit
  const j4 = await (await fetch(base + "/api/relay/emails?limit=1")).json();
  ok(j4.emails.length === 1 && j4.emails[0].id === m1.id, "limit=1 returns the oldest first");

  // 4. bad input doesn't crash
  const j5 = await fetch(base + "/api/relay/emails?since=bogus&limit=-5");
  ok(j5.ok, "garbage query params still return 200");
} finally {
  srv.kill();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
