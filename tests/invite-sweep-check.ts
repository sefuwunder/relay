// Invite removal + 24h silent auto-drop checks:
//  1. db-level: sweepStaleAppointments moves only old unresponded invites to
//     'removed'; accepted/declined/cancelled/planned survive at any age.
//  2. db-level: removeAppointment hides the card + diary row, keeps UID dedupe.
//  3. live server: DELETE endpoint behavior (pending ok, answered/nonexistent
//     404), status/RSVP routes reject removed invites, and the boot pollMail
//     sweep actually drops a backdated pending invite with no side effects.
// Run: bun tests/invite-sweep-check.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const REPO_ROOT = process.cwd();

// ---------- 1+2. db-level ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-invdb-"));
  process.chdir(dir);
  const db = await import("../src/db.ts");
  db.openDb(join(dir, "data", "relay.db"));
  const raw = db.getDb();

  const mk = (status: string, ageH: number, uid?: string) => {
    const a = db.insertAppointment({
      conversation_id: "c1", message_id: "m1", uid: uid || `u-${status}-${ageH}-${Math.random()}`,
      title: `T ${status} ${ageH}h`, starts_at: hoursAgo(-48), ends_at: hoursAgo(-47), status,
    });
    raw.query("UPDATE appointments SET created_at = ? WHERE id = ?").run(hoursAgo(ageH), a.id);
    return a;
  };

  const oldSent = mk("sent", 25);
  const newSent = mk("sent", 1);
  const oldRecv = mk("received", 25);
  const justUnder = mk("sent", 23.9);
  const justOver = mk("received", 24.1);
  const oldAccepted = mk("accepted", 48);
  const oldDeclined = mk("declined", 48);
  const oldCancelled = mk("cancelled", 48);
  const oldPlanned = mk("planned", 48);

  const moved = db.sweepStaleAppointments();
  ok(moved === 3, `sweep moves exactly the 3 stale pending invites (moved ${moved})`);

  const st = (id: string) => (raw.query("SELECT status FROM appointments WHERE id = ?").get(id) as any).status;
  ok(st(oldSent.id) === "removed", "old sent invite is removed");
  ok(st(oldRecv.id) === "removed", "old received invite is removed");
  ok(st(justOver.id) === "removed", "24.1h received invite is removed");
  ok(st(newSent.id) === "sent", "1h-old sent invite survives");
  ok(st(justUnder.id) === "sent", "23.9h-old sent invite survives (boundary)");
  ok(st(oldAccepted.id) === "accepted", "old accepted invite survives");
  ok(st(oldDeclined.id) === "declined", "old declined invite survives");
  ok(st(oldCancelled.id) === "cancelled", "old cancelled invite survives");
  ok(st(oldPlanned.id) === "planned", "old planned diary entry survives");
  ok(db.sweepStaleAppointments() === 0, "second sweep is a no-op");

  // removeAppointment: hidden from diary, still known by UID.
  const r = db.removeAppointment(newSent.id);
  ok(r !== null && r.status === "removed", "removeAppointment flips a pending invite");
  ok(!db.listAppointments("c1").some((a: any) => a.id === newSent.id), "removed invite leaves the diary listing");
  ok(!!db.getAppointmentByUid(r!.uid), "removed invite's UID still dedupes (no resurrection)");
  ok(db.removeAppointment("nope") === null, "removing a nonexistent id returns null");

  process.chdir("/");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 3. live server ----------
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

{
  const smtpCaptured: string[] = [];
  const smtp = startFakeSmtp(smtpCaptured);
  const dir = mkdtempSync(join(tmpdir(), "relay-inv-"));
  const { execSync, spawn } = await import("node:child_process");
  execSync(`ln -s ${REPO_ROOT}/public ${dir}/public && ln -s ${REPO_ROOT}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: 1, user: "me", pass: "x", secure: false },
    smtp: { host: "127.0.0.1", port: smtp.port, secure: "none", user: "", pass: "", from: "me@example.com", fromName: "Me" },
  }));
  const port = 4500 + Math.floor(Math.random() * 700);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: any) => {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const cc = await post("/api/contacts", { name: "Inv Pal", email: "invpal@example.com" });
    const convId = cc.json.contact?.id && (await (await fetch(base + `/api/contacts/${cc.json.contact.id}`)).json()).contact?.conversation_id;
    ok(!!convId, "contact created with a DM conversation");

    const ev = (t: string) => ({ title: t, starts_at: "2026-10-05T14:00:00.000Z", ends_at: "2026-10-05T15:00:00.000Z" });
    const sendInvite = async (t: string) =>
      (await post(`/api/conversations/${convId}/messages`, { channel: "email", body: "see you", subject: "", event: ev(t) })).json.message?.appointment;

    // --- manual remove of a pending invite ---
    const a1 = await sendInvite("Removable");
    ok(!!a1 && a1.status === "sent", "invite sends as pending");
    const del = await fetch(base + `/api/conversations/${convId}/appointments/${a1.id}`, { method: "DELETE" });
    ok(del.status === 200, `DELETE pending invite returns 200 (got ${del.status})`);
    const delJson = await del.json().catch(() => ({}));
    ok(delJson.removed === true && delJson.appointment?.status === "removed", "DELETE marks it removed");
    let diary = await (await fetch(base + `/api/conversations/${convId}/appointments`)).json();
    ok(!(diary.appointments || []).some((a: any) => a.id === a1.id), "removed invite gone from the diary listing");
    const del2 = await fetch(base + `/api/conversations/${convId}/appointments/${a1.id}`, { method: "DELETE" });
    ok(del2.status === 404, "DELETE on a removed invite is a clean 404");
    const delNope = await fetch(base + `/api/conversations/${convId}/appointments/nope`, { method: "DELETE" });
    ok(delNope.status === 404, "DELETE on a nonexistent invite is a clean 404");
    const delBadConv = await fetch(base + `/api/conversations/nope/appointments/${a1.id}`, { method: "DELETE" });
    ok(delBadConv.status === 404, "DELETE on an unknown conversation is a clean 404");

    // --- answered invites are not removable ---
    const a2 = await sendInvite("Answered");
    await post(`/api/conversations/${convId}/appointments/${a2.id}/status`, { status: "accepted" });
    const delAns = await fetch(base + `/api/conversations/${convId}/appointments/${a2.id}`, { method: "DELETE" });
    ok(delAns.status === 404, "DELETE on an accepted invite is a clean 404");
    diary = await (await fetch(base + `/api/conversations/${convId}/appointments`)).json();
    ok((diary.appointments || []).some((a: any) => a.id === a2.id && a.status === "accepted"), "accepted invite still listed");
    const stRemoved = await post(`/api/conversations/${convId}/appointments/${a1.id}/status`, { status: "accepted" });
    ok(stRemoved.status === 404, "status change on a removed invite is a clean 404");
    const rsvpRemoved = await post(`/api/conversations/${convId}/appointments/${a1.id}/rsvp`, { response: "accepted" });
    ok(rsvpRemoved.status === 404, "RSVP on a removed invite is a clean 404");

    // --- the 24h sweep runs inside the server's own poll loop ---
    const a3 = await sendInvite("Stale pending");
    const a4 = await sendInvite("Fresh pending");
    const { Database } = await import("bun:sqlite");
    const raw = new Database(join(dir, "data", "relay.db"));
    raw.query("UPDATE appointments SET created_at = ? WHERE id = ?").run(hoursAgo(25), a3.id);
    raw.close();
    // pollMail runs once ~5s after boot and every 60s; wait for the sweep.
    let swept = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      diary = await (await fetch(base + `/api/conversations/${convId}/appointments`)).json();
      if (!(diary.appointments || []).some((a: any) => a.id === a3.id)) { swept = true; break; }
    }
    ok(swept, "server's poll loop silently drops the 25h-old pending invite");
    ok((diary.appointments || []).some((a: any) => a.id === a4.id && a.status === "sent"), "fresh pending invite survives the sweep");
    ok((diary.appointments || []).some((a: any) => a.id === a2.id && a.status === "accepted"), "accepted invite survives the sweep");
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 500));
    smtp.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
