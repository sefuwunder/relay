// Calendar invitation checks:
//  1. unit: buildIcs / parseIcs round-trip, TZID + folding, garbage tolerance
//  2. unit: appointment db helpers
//  3. live server: inline invite send (JSON + multipart), validation, diary API,
//     accept/decline, SMTP MIME carries text/calendar, inbound .ics import via
//     fake IMAP, idempotent re-poll
// Run: bun tests/calendar-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIcs, parseIcs, parseIcsDate, newEventUid } from "../src/ical";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---------- 1. ical unit ----------
{
  const ics = buildIcs({
    uid: "u1@relay", summary: "Lunch with Sam",
    startsAt: new Date("2026-09-18T18:00:00Z"), endsAt: new Date("2026-09-18T19:30:00Z"),
    location: "Main St Café", description: "Bring the\nreport; don't be late",
    organizer: "me@example.com", attendees: ["sam@example.com"],
  });
  ok(ics.includes("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR"), "buildIcs wraps a VCALENDAR");
  ok(ics.includes("METHOD:REQUEST"), "buildIcs defaults to METHOD:REQUEST");
  ok(ics.includes("UID:u1@relay"), "buildIcs keeps the UID");
  ok(ics.includes("DTSTART:20260918T180000Z"), "buildIcs writes UTC DTSTART");
  ok(ics.includes("DTEND:20260918T193000Z"), "buildIcs writes UTC DTEND");
  ok(ics.includes("SUMMARY:Lunch with Sam"), "buildIcs writes SUMMARY");
  ok(ics.includes("LOCATION:Main St Café"), "buildIcs writes LOCATION");
  ok(ics.includes("ATTENDEE") && ics.includes("mailto:sam@example.com"), "buildIcs lists attendees");
  ok(!ics.split("\r\n").some((l) => l.length > 75 && !l.startsWith(" ")), "buildIcs folds long lines");

  const evs = parseIcs(ics);
  ok(evs.length === 1, "parseIcs finds the one VEVENT");
  const ev = evs[0];
  ok(ev.uid === "u1@relay", "parseIcs round-trips the UID");
  ok(ev.summary === "Lunch with Sam", "parseIcs round-trips the summary");
  ok(ev.dtstart === "2026-09-18T18:00:00.000Z", `parseIcs round-trips DTSTART (${ev.dtstart})`);
  ok(ev.dtend === "2026-09-18T19:30:00.000Z", "parseIcs round-trips DTEND");
  ok(ev.location === "Main St Café", "parseIcs round-trips LOCATION");
  ok(ev.description === "Bring the\nreport; don't be late", "parseIcs unfolds + unescapes DESCRIPTION");

  // Two events in one document.
  const two = buildIcs({ uid: "a@r", summary: "A", startsAt: new Date("2026-09-18T10:00:00Z"), endsAt: new Date("2026-09-18T11:00:00Z") })
    .replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:b@r\r\nDTSTAMP:20260917T000000Z\r\nDTSTART:20260919T100000Z\r\nDTEND:20260919T110000Z\r\nSUMMARY:B\r\nEND:VEVENT\r\nEND:VCALENDAR");
  ok(parseIcs(two).length === 2, "parseIcs handles two VEVENTs");

  // Date shapes.
  ok(parseIcsDate("", "20260918T140000Z") === "2026-09-18T14:00:00.000Z", "parseIcsDate handles UTC");
  ok(parseIcsDate("", "20260918T140000") === "2026-09-18T14:00:00.000Z", "parseIcsDate keeps floating wall time as UTC");
  ok(parseIcsDate("", "20260918") === "2026-09-18T00:00:00.000Z", "parseIcsDate handles all-day dates");
  ok(parseIcsDate("", "bogus") === "", "parseIcsDate returns empty on garbage");
  const ny = parseIcsDate(";TZID=America/New_York", "20260918T140000");
  ok(ny === "2026-09-18T18:00:00.000Z", `parseIcsDate converts TZID wall time to UTC (${ny})`);

  // Missing DTEND defaults.
  const noEnd = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@r\r\nDTSTART:20260918T140000Z\r\nSUMMARY:No end\r\nEND:VEVENT\r\nEND:VCALENDAR");
  ok(noEnd.length === 1 && noEnd[0].dtend === "2026-09-18T15:00:00.000Z", "parseIcs defaults a missing DTEND to +1h");
  const noStart = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:y@r\r\nSUMMARY:No start\r\nEND:VEVENT\r\nEND:VCALENDAR");
  ok(noStart.length === 0, "parseIcs skips a VEVENT without DTSTART");

  ok(parseIcs("definitely not an ics file").length === 0, "parseIcs returns [] on garbage");
  ok(parseIcs("").length === 0, "parseIcs returns [] on empty input");
  ok(newEventUid() !== newEventUid(), "newEventUid is unique");
}

// ---------- 2. appointment db helpers ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-cal-"));
  const db = await import("../src/db.ts");
  db.openDb(join(dir, "relay.db"));
  const c = db.createContact({ name: "Cal Pal", email: "pal@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "#0a84ff", notes: "" });
  const conv = db.dmFor(c.id);
  const m1 = db.insertMessage({ conversation_id: conv.id, channel: "email", direction: "out", body: "invite", subject: "s", external_id: "", status: "sent" });

  const a1 = db.insertAppointment({
    conversation_id: conv.id, message_id: m1.id, uid: "u1@relay", title: "Lunch",
    starts_at: "2026-09-18T18:00:00.000Z", ends_at: "2026-09-18T19:00:00.000Z",
    location: "Café", description: "d", organizer: "me@example.com", status: "sent",
  });
  ok(!!a1.id, "insertAppointment returns a row");
  const a2 = db.insertAppointment({
    conversation_id: conv.id, title: "Dentist",
    starts_at: "2026-09-20T14:00:00.000Z", ends_at: "2026-09-20T15:00:00.000Z", status: "received",
  });
  const list = db.listAppointments(conv.id);
  ok(list.length === 2 && list[0].id === a1.id && list[1].id === a2.id, "listAppointments is chronological");
  ok(db.listAppointments("nope").length === 0, "listAppointments is per-conversation");
  ok(db.getAppointmentByUid("u1@relay")?.id === a1.id, "getAppointmentByUid finds by ICS uid");
  ok(db.getAppointmentByUid("missing") === null, "getAppointmentByUid returns null when missing");
  ok(db.getAppointmentByUid("") === null, "getAppointmentByUid ignores empty uid");
  const upd = db.setAppointmentStatus(a2.id, "accepted");
  ok(upd?.status === "accepted", "setAppointmentStatus updates the status");
  const byMsg = db.getAppointmentsForMessages([m1.id, "nope"]);
  ok(byMsg.get(m1.id)?.id === a1.id && byMsg.size === 1, "getAppointmentsForMessages maps message -> appointment");
  ok(db.getAppointmentsForMessages([]).size === 0, "getAppointmentsForMessages handles empty input");
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 3. live server end-to-end ----------
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

interface FakeMsg { size: number; raw: string; text: string; envelope: string; internaldate: string; }
function envelope(o: { date: string; subject: string; from: string; to: string[]; messageId: string }): string {
  const addr = (e: string) => { const [m, h] = e.split("@"); return `(" " NIL "${m}" "${h}")`; };
  const [fm, fh] = o.from.split("@");
  return `("${o.date}" "${o.subject}" ((" " NIL "${fm}" "${fh}")) NIL NIL (${o.to.map(addr).join(" ")}) NIL NIL NIL "${o.messageId}")`;
}
function startFakeImap(boxes: Map<string, Map<string, FakeMsg>>) {
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock: any) { sock.data = { buf: "", box: "" }; sock.write("* OK fake-imap ready\r\n"); },
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
          const boxMsgs = boxes.get(st.box) || new Map<string, FakeMsg>();
          if (/^LOGIN/.test(up)) { wr(`${tag} OK logged in\r\n`); continue; }
          if (/^LOGOUT/.test(up)) { wr(`* BYE bye\r\n${tag} OK logged out\r\n`); try { sock.end(); } catch { /* noop */ } continue; }
          if (/^LIST/.test(up)) {
            let s = "";
            for (const name of boxes.keys()) s += `* LIST (\\HasNoChildren) "/" "${name}"\r\n`;
            wr(s + `${tag} OK listed\r\n`); continue;
          }
          {
            const sel = cmd.match(/^(SELECT|EXAMINE)\s+"?([^"]+)"?/i);
            if (sel) {
              st.box = sel[2];
              const n = (boxes.get(st.box) || new Map()).size;
              wr(`* ${n} EXISTS\r\n${tag} OK ${sel[1].toLowerCase()}d\r\n`); continue;
            }
          }
          if (/^UID SEARCH/.test(up)) {
            const ids = [...boxMsgs.keys()];
            wr(`* SEARCH${ids.length ? " " + ids.join(" ") : ""}\r\n${tag} OK searched\r\n`); continue;
          }
          if (/^UID FETCH/.test(up)) {
            const um = cmd.match(/UID FETCH\s+([\d,]+)/i);
            const uids = um ? um[1].split(",") : [];
            if (/RFC822\.SIZE/.test(up)) {
              let s = "";
              for (const u of uids) s += `* 1 FETCH (UID ${u} RFC822.SIZE ${boxMsgs.get(u)?.size ?? 0})\r\n`;
              wr(s + `${tag} OK sizes\r\n`); continue;
            }
            if (/BODY\.PEEK\[TEXT\]/.test(up)) {
              let s = "";
              for (const u of uids) {
                const t = boxMsgs.get(u)?.text ?? "";
                s += `* 1 FETCH (UID ${u} BODY[TEXT] {${Buffer.byteLength(t)}}\r\n` + t + `\r\n)\r\n`;
              }
              wr(s + `${tag} OK text\r\n`); continue;
            }
            if (/ENVELOPE/.test(up)) {
              let s = "";
              for (const u of uids) {
                const msg = boxMsgs.get(u);
                const env = msg?.envelope ?? `("01-Jan-2026 00:00:00 +0000" "x" NIL NIL NIL NIL NIL NIL NIL NIL)`;
                const idate = msg?.internaldate ?? "01-Jan-2026 00:00:00 +0000";
                s += `* 1 FETCH (UID ${u} INTERNALDATE "${idate}" ENVELOPE ${env})\r\n`;
              }
              wr(s + `${tag} OK envelopes\r\n`); continue;
            }
            if (/BODY\.PEEK\[\]/.test(up)) {
              for (const u of uids) {
                const raw = boxMsgs.get(u)?.raw ?? "";
                wr(`* 1 FETCH (UID ${u} BODY[] {${Buffer.byteLength(raw)}}\r\n`);
                wr(raw);
                wr(`\r\n)\r\n`);
              }
              wr(`${tag} OK full\r\n`); continue;
            }
            wr(`${tag} OK fetched\r\n`); continue;
          }
          wr(`${tag} OK done\r\n`);
        }
      },
    },
  }) as any;
  return { port: server.port, stop: () => server.stop() };
}

{
  const smtpCaptured: string[] = [];
  const smtp = startFakeSmtp(smtpCaptured);
  const inbox = new Map<string, FakeMsg>();
  const imap = startFakeImap(new Map([["INBOX", inbox], ["Sent", new Map()]]));

  const dir = mkdtempSync(join(tmpdir(), "relay-cal-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imap.port, user: "me", pass: "x", secure: false },
    smtp: { host: "127.0.0.1", port: smtp.port, secure: "none", user: "", pass: "", from: "me@example.com", fromName: "Me" },
  }));
  const port = 4400 + Math.floor(Math.random() * 800);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: any, form = false) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ? body : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error("server did not start");
    }
    const cc = await post("/api/contacts", { name: "Cal Pal", email: "pal@example.com" });
    const convId = cc.json.contact?.id && (await (await fetch(base + `/api/contacts/${cc.json.contact.id}`)).json()).contact?.conversation_id;
    ok(!!convId, "contact created with a DM conversation");

    // --- inline invite send (JSON) ---
    const ev = { title: "Planning session", starts_at: "2026-09-22T14:00:00.000Z", ends_at: "2026-09-22T15:00:00.000Z", location: "HQ", description: "Q4 plans" };
    const sent = await post(`/api/conversations/${convId}/messages`, { channel: "email", body: "see you then", subject: "", event: ev });
    ok(sent.status === 201, `invite send returns 201 (got ${sent.status})`);
    const msg = sent.json.message || {};
    ok(!!msg.appointment && msg.appointment.title === "Planning session", "sent message carries its appointment");
    ok(msg.appointment.status === "sent", "sent appointment has status 'sent'");
    ok(msg.appointment.starts_at === ev.starts_at && msg.appointment.ends_at === ev.ends_at, "appointment keeps the event times");
    ok(msg.appointment.location === "HQ", "appointment keeps the location");
    ok(msg.subject === "Invitation: Planning session", `invite defaults the subject (${msg.subject})`);
    const icsAtt = (msg.attachments || []).find((a: any) => a.filename === "invite.ics");
    ok(!!icsAtt && icsAtt.mime === "text/calendar", "invite rides along as an invite.ics attachment");
    ok(smtpCaptured.length === 1, "one SMTP send happened");
    ok(smtpCaptured[0].includes("Content-Type: text/calendar"), "SMTP MIME carries a text/calendar part");
    const afterCal = smtpCaptured[0].split("Content-Type: text/calendar")[1] || "";
    const b64 = (afterCal.split("\r\n\r\n")[1] || "").split("\r\n--")[0].replace(/\s+/g, "");
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    ok(decoded.includes("BEGIN:VEVENT") && decoded.includes("SUMMARY:Planning session"),
      "the text/calendar part decodes to the VEVENT");

    // --- diary API ---
    const diary = await (await fetch(base + `/api/conversations/${convId}/appointments`)).json();
    ok((diary.appointments || []).length === 1 && diary.appointments[0].title === "Planning session", "diary lists the sent invitation");
    const diary404 = await fetch(base + "/api/conversations/nope/appointments");
    ok(diary404.status === 404, "diary 404s on an unknown conversation");

    // --- accept / decline ---
    const apptId = msg.appointment.id;
    const acc = await post(`/api/conversations/${convId}/appointments/${apptId}/status`, { status: "accepted" });
    ok(acc.status === 200 && acc.json.appointment.status === "accepted", "accept flips the status");
    const bad = await post(`/api/conversations/${convId}/appointments/${apptId}/status`, { status: "maybe" });
    ok(bad.status === 400, "bogus status is rejected");
    const gone = await post(`/api/conversations/${convId}/appointments/nope/status`, { status: "accepted" });
    ok(gone.status === 404, "status 404s on an unknown appointment");

    // --- validation ---
    const noTitle = await post(`/api/conversations/${convId}/messages`, { channel: "email", body: "x", event: { title: "", starts_at: ev.starts_at, ends_at: ev.ends_at } });
    ok(noTitle.status === 400, "invite without a title is rejected");
    const badTime = await post(`/api/conversations/${convId}/messages`, { channel: "email", body: "x", event: { title: "T", starts_at: ev.ends_at, ends_at: ev.starts_at } });
    ok(badTime.status === 400, "invite with end before start is rejected");
    const cc2 = await post("/api/contacts", { name: "Texter", email: "", gv_number: "15551234567" });
    const conv2 = cc2.json.contact?.id && (await (await fetch(base + `/api/contacts/${cc2.json.contact.id}`)).json()).contact?.conversation_id;
    const smsInvite = await post(`/api/conversations/${conv2}/messages`, { channel: "sms", body: "x", event: ev });
    ok(smsInvite.status === 400, "invites are email-only");

    // --- invite + file in one multipart send ---
    const form = new FormData();
    form.set("channel", "email");
    form.set("body", "deck + invite");
    form.set("event", JSON.stringify({ title: "Deck review", starts_at: "2026-09-23T10:00:00.000Z", ends_at: "2026-09-23T10:30:00.000Z" }));
    form.append("files", new Blob(["%PDF-1.4 fake"], { type: "application/pdf" }), "deck.pdf");
    const multi = await post(`/api/conversations/${convId}/messages`, form, true);
    ok(multi.status === 201, `multipart invite+file send returns 201 (got ${multi.status})`);
    const mAt = multi.json.message?.attachments || [];
    ok(mAt.some((a: any) => a.filename === "deck.pdf") && mAt.some((a: any) => a.filename === "invite.ics"),
      "multipart send keeps both the file and the invite.ics");
    ok(!!multi.json.message?.appointment && multi.json.message.appointment.title === "Deck review",
      "multipart send records the appointment");

    // --- inbound .ics import ---
    const inboundIcs = buildIcs({
      uid: "inbound-1@relay", summary: "Coffee catch-up",
      startsAt: new Date("2026-09-24T15:00:00Z"), endsAt: new Date("2026-09-24T15:30:00Z"),
      location: "Blue Room", description: "bring ideas",
    });
    const raw = [
      "From: pal@example.com", "To: me@example.com", "Subject: Invitation: Coffee catch-up",
      "Message-ID: <coffee-in@example.com>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b1"', "",
      "--b1", "Content-Type: text/plain", "", "Let's grab coffee!", "",
      "--b1", 'Content-Type: text/calendar; method=REQUEST; name="invite.ics"',
      "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="invite.ics"', "",
      Buffer.from(inboundIcs, "utf8").toString("base64"), "--b1--", "",
    ].join("\r\n");
    inbox.set("21", {
      size: Buffer.byteLength(raw), raw, text: "Let's grab coffee!",
      envelope: envelope({ date: "Thu, 17 Sep 2026 13:00:00 +0000", subject: "Invitation: Coffee catch-up", from: "pal@example.com", to: ["me@example.com"], messageId: "<coffee-in@example.com>" }),
      internaldate: "17-Sep-2026 13:00:00 +0000",
    });
    const poll = await post("/api/poll", {});
    ok(poll.json.ok, "manual poll succeeds");
    const mj = await (await fetch(base + `/api/conversations/${convId}/messages?limit=30`)).json();
    const inbound = (mj.messages || []).find((m: any) => m.message_id === "<coffee-in@example.com>");
    ok(!!inbound, "inbound invite email imported");
    ok(!!inbound?.appointment && inbound.appointment.title === "Coffee catch-up", "inbound message carries its appointment");
    ok(inbound?.appointment?.status === "received", "inbound appointment has status 'received'");
    ok(inbound?.appointment?.location === "Blue Room", "inbound appointment keeps the location");
    const diary2 = await (await fetch(base + `/api/conversations/${convId}/appointments`)).json();
    ok((diary2.appointments || []).length === 3, `diary now holds sent + inbound invites (got ${(diary2.appointments || []).length})`);
    await post("/api/poll", {});
    const diary3 = await (await fetch(base + `/api/conversations/${convId}/appointments`)).json();
    ok((diary3.appointments || []).length === 3, "re-poll does not duplicate the inbound appointment");

    // --- diary isolation between conversations ---
    const diaryOther = await (await fetch(base + `/api/conversations/${conv2}/appointments`)).json();
    ok((diaryOther.appointments || []).length === 0, "diary is per-conversation");
  } finally {
    srv.kill();
    imap.stop();
    smtp.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ncalendar: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
