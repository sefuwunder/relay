// Greenroom (staged contacts) checks:
//  1. staged contacts don't count against MAX_PEOPLE (8 contacts + staging still allowed)
//  2. promote at cap: 409 with contacts list; with archive_id: atomic archive+promote
//  3. promote under cap: 201, no archive needed; thread migrates to the new contact
//  4. expiry sweep flips at 14 days (db-level); extend adds 14d once, second extend 409s
//  5. draft contains met_where/met_about
//  6. inbound email from a staged handle sets replied=1 and lands in the staged thread
//  7. inbound SMS (GV forward) from a staged number sets replied=1
//  8. staging cap 32 enforced
//  9. outbound 1:1 message to a staged contact via the existing email sender
//  10. staged contacts can't join groups (400)
// Run: bun tests/staged-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---------- fake SMTP (captures outbound) ----------
function startFakeSmtp(captured: string[]) {
  const net = require("node:net") as typeof import("node:net");
  const server = net.createServer((sock) => {
    let buf = "", dataMode = false, dataBuf = "";
    sock.write("220 fake-smtp ready\r\n");
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (dataMode) {
          if (line === ".") { dataMode = false; captured.push(dataBuf); dataBuf = ""; sock.write("250 OK queued\r\n"); }
          else dataBuf += line + "\r\n";
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith("DATA")) { dataMode = true; sock.write("354 go ahead\r\n"); }
        else if (up.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  return { port: (server.address() as any).port, close: () => server.close() };
}

// ---------- fake IMAP (one-shot unseen mail) ----------
interface FakeMsg { text: string; envelope: string; internaldate: string; }
function envelope(o: { date: string; subject: string; from: string; to: string[]; messageId: string }): string {
  const addr = (e: string) => { const [m, h] = e.split("@"); return `(" " NIL "${m}" "${h}")`; };
  const [fm, fh] = o.from.split("@");
  return `("${o.date}" "${o.subject}" ((" " NIL "${fm}" "${fh}")) NIL NIL (${o.to.map(addr).join(" ")}) NIL NIL NIL "${o.messageId}")`;
}
function startFakeImap(box: Map<string, FakeMsg>) {
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock: any) { sock.data = { buf: "" }; sock.write("* OK fake-imap ready\r\n"); },
      data(sock: any, data: Buffer) {
        const st = sock.data;
        st.buf += data.toString("latin1");
        let idx: number;
        while ((idx = st.buf.indexOf("\r\n")) >= 0) {
          const line = st.buf.slice(0, idx);
          st.buf = st.buf.slice(idx + 2);
          const m = line.match(/^(\S+)\s+([\s\S]*)$/);
          if (!m) continue;
          const tag = m[1], cmd = m[2], up = cmd.toUpperCase();
          const wr = (s: string) => sock.write(s);
          if (/^LOGIN/.test(up)) { wr(`${tag} OK logged in\r\n`); continue; }
          if (/^SELECT/.test(up)) { wr(`* ${box.size} EXISTS\r\n${tag} OK selected\r\n`); continue; }
          if (/^UID SEARCH/.test(up)) {
            const ids = [...box.keys()];
            wr(`* SEARCH${ids.length ? " " + ids.join(" ") : ""}\r\n${tag} OK searched\r\n`); continue;
          }
          if (/^UID FETCH/.test(up)) {
            const um = cmd.match(/UID FETCH\s+([\d,]+)/i);
            const uids = um ? um[1].split(",") : [];
            if (/BODY\.PEEK\[TEXT\]/.test(up)) {
              let s = "";
              for (const u of uids) {
                const t = box.get(u)?.text ?? "";
                s += `* 1 FETCH (UID ${u} BODY[TEXT] {${Buffer.byteLength(t)}}\r\n` + t + `\r\n)\r\n`;
              }
              wr(s + `${tag} OK text\r\n`); continue;
            }
            if (/ENVELOPE/.test(up)) {
              let s = "";
              for (const u of uids) {
                const msg = box.get(u);
                const env = msg?.envelope ?? `("01-Jan-2026 00:00:00 +0000" "x" NIL NIL NIL NIL NIL NIL NIL NIL)`;
                const idate = msg?.internaldate ?? "01-Jan-2026 00:00:00 +0000";
                s += `* 1 FETCH (UID ${u} INTERNALDATE "${idate}" ENVELOPE ${env})\r\n`;
              }
              wr(s + `${tag} OK envelopes\r\n`); continue;
            }
            wr(`${tag} OK fetched\r\n`); continue;
          }
          if (/^UID STORE/.test(up)) { wr(`${tag} OK stored\r\n`); continue; }
          wr(`${tag} OK done\r\n`);
        }
      },
    },
  }) as any;
  return { port: server.port, stop: () => server.stop() };
}

async function main() {
  const smtpCaptured: string[] = [];
  const smtp = startFakeSmtp(smtpCaptured);
  const inbox = new Map<string, FakeMsg>();
  const imap = startFakeImap(inbox);

  const dir = mkdtempSync(join(tmpdir(), "relay-staged-"));
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imap.port, user: "me", pass: "x", secure: false },
    smtp: { host: "127.0.0.1", port: smtp.port, secure: "none", user: "", pass: "", from: "me@example.com", fromName: "Me" },
  }));
  const port = 4600 + Math.floor(Math.random() * 700);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + "/api/status"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const get = async (p: string) => (await (await fetch(base + p)).json());
    const post = async (p: string, b: any) => {
      const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };

    // ---- 1. create a staged contact; fill the inner circle; staging still allowed
    let r = await post("/api/staged", {
      name: "Maya Chen", channel: "email", handle: "maya@example.com",
      met_where: "SaaStr 2026", met_about: "RevOps, pricing talk", notes: "warm intro",
    });
    ok(r.status === 201, "create staged contact -> 201");
    const maya = r.json.staged;
    ok(maya.days_left >= 13 && maya.days_left <= 14, `days_left ~14 (got ${maya.days_left})`);
    ok(maya.status === "staged" && maya.replied === 0, "fresh staged row: staged, not replied");

    const mkContact = async (name: string, email: string) =>
      (await post("/api/contacts", { name, email })).json.contact;
    const contacts: any[] = [];
    for (let i = 1; i <= 8; i++) contacts.push(await mkContact(`Person${i}`, `person${i}@example.com`));
    r = await post("/api/staged", { name: "Late Comer", channel: "email", handle: "late@example.com", met_where: "hallway", met_about: "x" });
    ok(r.status === 201, "staged allowed with 8/8 contacts (doesn't count against MAX_PEOPLE)");
    const late = r.json.staged;

    // ---- validation
    r = await post("/api/staged", { name: "", channel: "email", handle: "x@y.com" });
    ok(r.status === 400, "staged without name -> 400");
    r = await post("/api/staged", { name: "Nope", channel: "email", handle: "not-an-email" });
    ok(r.status === 400, "staged with bad email -> 400");
    r = await post("/api/staged", { name: "Nope", channel: "sms", handle: "123" });
    ok(r.status === 400, "staged with bad phone -> 400");
    r = await post("/api/staged", { name: "Nope", channel: "pager", handle: "x" });
    ok(r.status === 400, "staged with bad channel -> 400");

    // ---- 2. promote at cap: 409 with contacts list, then atomic archive+promote
    r = await post(`/api/staged/${late.id}/promote`, {});
    ok(r.status === 409, "promote at 8/8 without archive_id -> 409");
    ok(Array.isArray(r.json.contacts) && r.json.contacts.length === 8, "409 carries the 8 active contacts");
    const victim = contacts[0];
    r = await post(`/api/staged/${late.id}/promote`, { archive_id: victim.id });
    ok(r.status === 201, "promote with archive_id -> 201");
    ok(r.json.archived === victim.id, "response names the archived contact");
    const after = await get("/api/contacts");
    ok(after.contacts.length === 8, "still 8 active after atomic swap");
    ok(after.archived.some((c: any) => c.id === victim.id), "victim is archived");
    ok(after.contacts.some((c: any) => c.name === "Late Comer" && c.email === "late@example.com"), "promoted contact has the staged email");
    const shelf = await get("/api/staged");
    ok(!shelf.staged.some((s: any) => s.id === late.id), "promoted row leaves the shelf");

    // ---- 3. promote under cap on a fresh server would need a second boot;
    // instead: release one contact's slot via archive, then plain promote.
    await post(`/api/staged`, { name: "Under Cap", channel: "sms", handle: "5551234567", met_where: "conf", met_about: "y" });
    const uc = (await get("/api/staged")).staged.find((s: any) => s.name === "Under Cap");
    // open their Greenroom thread first, so we can verify it migrates on promote
    const ucConv = (await post("/api/conversations", { member_ids: ["staged:" + uc.id] })).json.conversation;
    // archive one more to open a slot
    await fetch(base + `/api/contacts/${contacts[1].id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: 1 }) });
    r = await post(`/api/staged/${uc.id}/promote`, {});
    ok(r.status === 201, "promote under cap -> 201");
    ok(!r.json.archived, "no archive needed under cap");
    const ucFull = await get(`/api/contacts/${r.json.contact.id}`);
    ok(ucFull.contact.gv_number === "5551234567", "sms handle becomes gv_number on the contact");
    const ucThread = await get(`/api/conversations/${ucConv.id}`);
    ok(ucThread.conversation.members.length === 1 && ucThread.conversation.members[0].id === r.json.contact.id,
      "promote migrates the Greenroom thread to the new contact");

    // ---- 4b. extend once, second extend 409s
    r = await post(`/api/staged/${maya.id}/extend`, {});
    ok(r.status === 200 && r.json.staged.extended === 1, "extend -> 200, extended flag set");
    ok(r.json.staged.days_left >= 27, `extend adds 14d (days_left=${r.json.staged.days_left})`);
    r = await post(`/api/staged/${maya.id}/extend`, {});
    ok(r.status === 409, "second extend -> 409");

    // ---- 5. draft contains context
    const d = await get(`/api/staged/${maya.id}/draft`);
    ok(d.draft.includes("SaaStr 2026") && d.draft.includes("RevOps, pricing talk"),
      `draft carries met_where/met_about: "${d.draft.slice(0, 60)}..."`);

    // ---- 9. outbound 1:1 to a staged contact through the existing email sender
    r = await post("/api/conversations", { member_ids: ["staged:" + maya.id] });
    ok(r.status === 201, "staged DM opens via POST /api/conversations");
    const convId = r.json.conversation.id;
    r = await post("/api/conversations", { member_ids: ["staged:" + maya.id] });
    ok(r.json.conversation.id === convId, "re-opening reuses the staged thread");
    const before = smtpCaptured.length;
    r = await post(`/api/conversations/${convId}/messages`, { channel: "email", body: "hello maya", subject: "hi" });
    ok(r.status === 201, "message to staged contact sends");
    ok(smtpCaptured.length === before + 1 && /maya@example\.com/.test(smtpCaptured[smtpCaptured.length - 1]),
      "fake SMTP got the mail addressed to the staged handle");
    const thread = await get(`/api/conversations/${convId}`);
    ok(thread.conversation.members.length === 1 && thread.conversation.members[0].id === "staged:" + maya.id,
      "staged thread members resolve to the pseudo-contact");

    // ---- 10. staged can't join groups
    r = await post("/api/conversations", { member_ids: ["staged:" + maya.id, contacts[2].id], name: "bad group" });
    ok(r.status === 400, "staged + contact group -> 400");

    // ---- 6. inbound email from staged handle -> replied=1, lands in staged thread
    const mkMail = (uid: string, from: string, to: string[], subject: string, mid: string, text: string) => {
      inbox.set(uid, {
        text,
        envelope: envelope({ date: "08-Oct-2026 10:00:00 +0000", subject, from, to, messageId: mid }),
        internaldate: "08-Oct-2026 10:00:00 +0000",
      });
    };
    mkMail("11", "maya@example.com", ["me@example.com"], "Re: hi", "<m1@example.com>", "great to meet you too!");
    await post("/api/poll", {});
    let shelf2 = await get("/api/staged");
    const maya2 = shelf2.staged.find((s: any) => s.id === maya.id);
    ok(maya2 && maya2.replied === 1, "inbound email from staged handle sets replied=1");
    const inbound = await get(`/api/conversations/${convId}/messages?limit=50`);
    ok(inbound.messages.some((m: any) => m.direction === "in" && /great to meet/.test(m.body)),
      "inbound from staged handle lands in the staged thread");

    // ---- 7. inbound SMS (GV forward) from a staged number -> replied=1
    r = await post("/api/staged", { name: "Sam Texter", channel: "sms", handle: "5559876543", met_where: "lobby", met_about: "z" });
    const sam = r.json.staged;
    // GV forward: first numeric part is the account's own number, sender is next.
    mkMail("12", "19995550001.15559876543.fwd@txt.voice.google.com", ["me@example.com"],
      "SMS", "<m2@example.com>", "hey its sam\n\nTo respond to this text message, reply to this email.");
    await post("/api/poll", {});
    shelf2 = await get("/api/staged");
    const sam2 = shelf2.staged.find((s: any) => s.id === sam.id);
    ok(sam2 && sam2.replied === 1, "inbound GV SMS from staged number sets replied=1");

    // ---- release
    r = await post(`/api/staged/${sam.id}/release`, {});
    ok(r.status === 200, "release -> 200");
    shelf2 = await get("/api/staged");
    ok(!shelf2.staged.some((s: any) => s.id === sam.id), "released row leaves the shelf");

    // ---- 8. cap 32
    let capped = false;
    for (let i = 0; i < 40; i++) {
      const rr = await post("/api/staged", { name: `Bulk${i}`, channel: "email", handle: `bulk${i}@example.com` });
      if (rr.status !== 201) { capped = rr.status === 400; break; }
    }
    ok(capped, "staging cap enforced at 32");

    // ---- 4a. expiry sweep (db-level: time-travel the row)
    {
      const { openDb, createStagedContact, getStagedContact, sweepStagedContacts, extendStagedContact } = await import("../src/db");
      const { mkdtempSync: mk } = await import("node:fs");
      const d2 = mk(join(tmpdir(), "relay-staged-db-"));
      openDb(join(d2, "t.db"));
      const s = createStagedContact({ name: "Old", channel: "email", handle: "old@example.com" });
      ok(getStagedContact(s.id)!.status === "staged", "db: fresh row is staged");
      const { getDb } = await import("../src/db");
      getDb().query("UPDATE staged_contacts SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, s.id);
      ok(sweepStagedContacts() === 1, "db: sweep flips one row");
      ok(getStagedContact(s.id)!.status === "expired", "db: row is expired after sweep");
      const s2 = createStagedContact({ name: "Fresh", channel: "email", handle: "fresh@example.com" });
      const beforeExp = s2.expires_at;
      const ext = extendStagedContact(s2.id);
      ok(ext.expires_at - beforeExp === 14 * 86400000 && ext.extended === 1, "db: extend adds exactly 14 days");
      let threw = false;
      try { extendStagedContact(s2.id); } catch { threw = true; }
      ok(threw, "db: second extend throws");
      const { rmSync } = await import("node:fs");
      rmSync(d2, { recursive: true, force: true });
    }
  } finally {
    srv.kill();
    smtp.close();
    imap.stop();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
console.log(`\nstaged: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
