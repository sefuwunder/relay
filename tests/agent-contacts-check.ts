// AI agent contacts checks:
//  1. migration: legacy contacts table (no kind/agent_url/agent_secret) -> openDb
//     adds the columns and backfills kind='person'
//  2. live server end-to-end: stub agent <-> Relay send/reply, sanitization,
//     unreachable agent, attachments, PATCH secret rotation, cap, group rejection
// Run: bun tests/agent-contacts-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, getDb } from "../src/db";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---------- 1. migration from a legacy DB ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-agent-mig-"));
  const legacyPath = join(dir, "legacy.db");
  const ldb = new Database(legacyPath, { create: true });
  ldb.exec(`CREATE TABLE contacts (
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
  );`);
  ldb.query("INSERT INTO contacts (id, name, email, gv_number, matrix_id, matrix_room_id, color, notes, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
    .run("c1", "Old Friend", "old@example.com", "", "", "", "#0a84ff", "", new Date().toISOString());
  ldb.close();

  openDb(legacyPath);
  const cols = (getDb().query("PRAGMA table_info(contacts)").all() as { name: string }[]).map((c) => c.name);
  ok(cols.includes("kind") && cols.includes("agent_url") && cols.includes("agent_secret"),
    "migration adds kind/agent_url/agent_secret columns");
  const row = getDb().query("SELECT kind, agent_url, agent_secret FROM contacts WHERE id = 'c1'").get() as any;
  ok(row && row.kind === "person", `legacy row backfilled to kind='person' (got ${row?.kind})`);
  ok(row && row.agent_url === "" && row.agent_secret === "", "legacy row gets empty agent fields");
}

// ---------- 2. live server end-to-end ----------
const SECRET = "s3cr3t-agent-secret";

// Stub agent: asserts the generic contract and answers.
let lastStubHit: { session: string; message: string; secret: string | null } | null = null;
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/agent") {
      const j = await req.json();
      lastStubHit = { session: j.session, message: j.message, secret: req.headers.get("x-agent-secret") };
      return Response.json({ text: "stub says hi", extra: 1 });
    }
    return new Response("nf", { status: 404 });
  },
});
const stubPort = (stub as any).port;
const stubUrl = `http://127.0.0.1:${stubPort}/agent`;
let serverStderr = "";

{
  const dir = mkdtempSync(join(tmpdir(), "relay-agent-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  const port = 4400 + Math.floor(Math.random() * 800);
  const srv: any = spawn("bun", ["src/server.ts"], {
    cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  srv.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); serverStderr = stderr; });
  const base = `http://127.0.0.1:${port}`;
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  };
  const postJson = (p: string, b: any) => fetch(base + p, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
  });
  const patchJson = (p: string, b: any) => fetch(base + p, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
  });
  try {
    await wait();

    // --- create the agent contact ---
    let r = await postJson("/api/contacts", { kind: "agent", name: "Milton", agent_url: stubUrl, agent_secret: SECRET });
    ok(r.status === 201, `agent contact create -> 201 (got ${r.status})`);
    const created = await r.json();
    const createdStr = JSON.stringify(created);
    ok(!createdStr.includes(SECRET), "create response leaks no secret");
    ok(!createdStr.includes(stubUrl), "create response leaks no agent_url");
    ok(!createdStr.includes("agent_url") || createdStr.includes("agent_url_set"), "create response has no raw agent_url key");
    ok(created.contact && created.contact.kind === "agent", "create response kind is agent");
    ok(created.contact && created.contact.has_agent_secret === true, "create response has_agent_secret true");
    ok(created.contact && created.contact.agent_url_set === true, "create response agent_url_set true");
    const agentId = created.contact.id;

    // bad URL rejected
    r = await postJson("/api/contacts", { kind: "agent", name: "Bad", agent_url: "ftp://nope/x" });
    ok(r.status === 400, `agent with non-http URL -> 400 (got ${r.status})`);

    // --- list sanitization ---
    r = await fetch(base + "/api/contacts");
    const list = await r.json();
    const listStr = JSON.stringify(list);
    ok(!listStr.includes(SECRET), "contacts list leaks no secret");
    ok(!listStr.includes(stubUrl), "contacts list leaks no agent_url");
    for (const c of [...(list.contacts || []), ...(list.archived || [])]) {
      if (!("agent_url" in c) && !("agent_secret" in c)) pass++;
      else { fail++; console.error("FAIL: raw agent keys on listed contact", c.name); }
    }

    // --- single contact + its DM conversation ---
    r = await fetch(base + `/api/contacts/${agentId}`);
    const single = await r.json();
    const agentCid = single.contact.conversation_id;
    ok(!!agentCid, "agent contact has an auto-created DM conversation");
    ok(!("agent_url" in single.contact) && !("agent_secret" in single.contact), "single contact sanitized");
    ok(JSON.stringify(single).includes(SECRET) === false, "single contact leaks no secret");

    // --- conversation detail: channels/hints/members sanitized ---
    r = await fetch(base + `/api/conversations/${agentCid}`);
    const detail = await r.json();
    ok(JSON.stringify(detail.conversation.channels) === JSON.stringify(["agent"]),
      `agent conversation channels are ["agent"] (got ${JSON.stringify(detail.conversation.channels)})`);
    ok(detail.conversation.hints && detail.conversation.hints.agent === "", "hints carry an agent key");
    ok(!("agent_url" in detail.conversation.members[0]) && !("agent_secret" in detail.conversation.members[0]),
      "conversation members sanitized");

    // --- send a text to the agent ---
    lastStubHit = null;
    r = await postJson(`/api/conversations/${agentCid}/messages`, { channel: "agent", body: "hello agent" });
    ok(r.status === 201, `agent message send -> 201 (got ${r.status})`);
    ok(lastStubHit !== null, "stub agent received the POST");
    ok(lastStubHit?.session === "relay:" + agentCid, `stub got session relay:<convId> (got ${lastStubHit?.session})`);
    ok(lastStubHit?.message === "hello agent", "stub got the message text");
    ok(lastStubHit?.secret === SECRET, "stub got the x-agent-secret header");
    r = await fetch(base + `/api/conversations/${agentCid}/messages?limit=20`);
    const msgs = (await r.json()).messages || [];
    const out = msgs.find((m: any) => m.direction === "out" && m.channel === "agent");
    const inbound = msgs.find((m: any) => m.direction === "in" && m.channel === "agent" && m.body === "stub says hi");
    ok(!!out && out.body === "hello agent", "outbound agent message recorded");
    ok(out && out.status === "sent", "outbound agent row has status sent");
    ok(!!inbound, "stub agent reply recorded as inbound");

    // --- wrong channel in an agent conversation ---
    r = await postJson(`/api/conversations/${agentCid}/messages`, { channel: "email", body: "nope" });
    ok(r.status === 400, `email channel in agent conv -> 400 (got ${r.status})`);
    const wrongCh = await r.json();
    ok(/AI agent/.test(wrongCh.error || ""), "wrong-channel error mentions the AI agent");

    // --- unreachable agent: outbound kept, notice inbound, no URL leak ---
    r = await postJson("/api/contacts", { kind: "agent", name: "Dead Agent", agent_url: "http://127.0.0.1:1/" });
    ok(r.status === 201, "unreachable agent contact created");
    const deadId = (await r.json()).contact.id;
    const deadCid = (await (await fetch(base + `/api/contacts/${deadId}`)).json()).contact.conversation_id;
    r = await postJson(`/api/conversations/${deadCid}/messages`, { channel: "agent", body: "are you there" });
    ok(r.status === 201, `send to dead agent still -> 201 (got ${r.status})`);
    r = await fetch(base + `/api/conversations/${deadCid}/messages?limit=20`);
    const dmsgs = (await r.json()).messages || [];
    ok(!!dmsgs.find((m: any) => m.direction === "out" && m.body === "are you there"),
      "dead-agent outbound preserved");
    const notice = dmsgs.find((m: any) => m.direction === "in" && /^Agent unreachable:/.test(m.body));
    ok(!!notice, "dead agent produces an inbound 'Agent unreachable:' notice");
    ok(notice && !notice.body.includes("127.0.0.1:1"), "unreachable notice contains no endpoint URL");
    ok(notice && !notice.body.includes("agent_secret"), "unreachable notice contains no secret key name");

    // --- attachments: stored on the outbound row, text-only notice, text still sent ---
    lastStubHit = null;
    const fd = new FormData();
    fd.append("channel", "agent");
    fd.append("body", "here is a file");
    fd.append("file", new File(["hello file bytes"], "note.txt", { type: "text/plain" }));
    r = await fetch(base + `/api/conversations/${agentCid}/messages`, { method: "POST", body: fd });
    ok(r.status === 201, `agent message with file -> 201 (got ${r.status})`);
    r = await fetch(base + `/api/conversations/${agentCid}/messages?limit=30`);
    const fmsgs = (await r.json()).messages || [];
    const fout = fmsgs.find((m: any) => m.direction === "out" && m.body === "here is a file");
    ok(!!fout && fout.attachments && fout.attachments.length === 1 && fout.attachments[0].filename === "note.txt",
      "outbound agent message keeps the file in thread metadata");
    ok(!!fmsgs.find((m: any) => m.direction === "in" && /text-only/.test(m.body)),
      "text-only notice appears inbound after an attachment");
    ok(lastStubHit?.message === "here is a file", "stub still received the text alongside the file");

    // --- PATCH: secret rotation with __KEEP__ semantics ---
    r = await patchJson(`/api/contacts/${agentId}`, { agent_secret: "__KEEP__" });
    ok(r.status === 200 && (await r.json()).contact.has_agent_secret === true, "PATCH __KEEP__ preserves the secret");
    r = await patchJson(`/api/contacts/${agentId}`, { agent_secret: "" });
    const cleared = await r.json();
    ok(r.status === 200 && cleared.contact.has_agent_secret === false, "PATCH \"\" clears the secret");
    ok(!JSON.stringify(cleared).includes(SECRET), "PATCH response leaks no secret");
    // restore the secret for the stub assertions that follow
    await patchJson(`/api/contacts/${agentId}`, { agent_secret: SECRET });
    // person -> agent without a URL is rejected
    r = await postJson("/api/contacts", { name: "Pal", email: "pal@example.com" });
    const palId = (await r.json()).contact.id;
    ok(r.status === 201, "person contact created");
    r = await patchJson(`/api/contacts/${palId}`, { kind: "agent" });
    ok(r.status === 400, `person->agent without URL -> 400 (got ${r.status})`);
    r = await patchJson(`/api/contacts/${palId}`, { kind: "agent", agent_url: stubUrl });
    ok(r.status === 200 && (await r.json()).contact.kind === "agent", "person->agent with URL works");
    r = await patchJson(`/api/contacts/${palId}`, { kind: "person" });
    const backToPerson = await r.json();
    ok(r.status === 200 && backToPerson.contact.kind === "person" && backToPerson.contact.agent_url_set === false,
      "agent->person clears the agent fields");

    // --- groups reject agents ---
    r = await postJson("/api/contacts", { name: "Friend", email: "friend@example.com" });
    const friendId = (await r.json()).contact.id;
    r = await postJson("/api/conversations", { name: "Nope", member_ids: [agentId, friendId] });
    ok(r.status === 400, `group with an agent member -> 400 (got ${r.status})`);
    const gerr = await r.json();
    ok(/1:1 only/.test(gerr.error || ""), "group rejection names the 1:1-only rule");

    // --- cap: 8 contacts max, persons and agents alike ---
    for (const n of ["P1", "P2", "P3", "P4"]) {
      r = await postJson("/api/contacts", { name: n });
      ok(r.status === 201, `contact ${n} created (filling toward the cap)`);
    }
    r = await postJson("/api/contacts", { name: "Ninth" });
    ok(r.status === 400, `9th contact -> 400 (got ${r.status})`);
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

stub.stop();

ok(!serverStderr.includes(SECRET), "server stderr never contains the agent secret");
ok(!serverStderr.includes(stubUrl), "server stderr never contains the agent endpoint URL");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
