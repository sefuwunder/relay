// Missed-call alert checks:
//  1. unit: parseMissedCall on the real GV notification email + variants
//  2. live server end-to-end: fake IMAP INBOX holding a GV missed-call email ->
//     POST /api/poll -> a 📞 alert lands in the caller's DM; re-poll does not
//     duplicate it; a missed call from an untracked number is skipped.
// Run: bun tests/missed-call-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMissedCall } from "../src/imap";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---------- 1. unit ----------
const REAL_BODY = [
  "<https://voice.google.com>",
  "Hello Salve Sefu,",
  "",
  "You missed a call from Acela (513) 967-2841.",
  "call back",
  "<https://voice.google.com/calls?a=nc,%2B15139672841&e=salvesefu@gmail.com&source=callback_email>",
  "YOUR ACCOUNT <https://voice.google.com> HELP CENTER",
  "<https://support.google.com/voice#topic=1707989> HELP FORUM",
].join("\n");
const FROM = "Google Voice <voice-noreply@google.com>";
const SUBJ = "New missed call from Acela.";

{
  const r = parseMissedCall(FROM, SUBJ, REAL_BODY);
  ok(!!r && r.name === "Acela" && r.digits === "5139672841", `real GV email parses (${JSON.stringify(r)})`);
  ok(parseMissedCall("friend@example.com", SUBJ, REAL_BODY) === null, "wrong from -> null");
  ok(parseMissedCall(FROM, "New text message from Acela (SMS)", REAL_BODY) === null, "SMS subject -> null");
  ok(parseMissedCall(FROM, SUBJ, "You missed a call from Acela.") === null, "no phone -> null");
  ok(parseMissedCall(FROM, SUBJ, "hello there") === null, "unrelated body -> null");
  const dots = parseMissedCall(FROM, "New missed call from Bob.", "You missed a call from Bob 513.967.2841.");
  ok(!!dots && dots.digits === "5139672841" && dots.name === "Bob", "dotted phone format parses");
  const nospace = parseMissedCall(FROM, "New missed call from Bob.", "You missed a call from Bob (513)967-2841.");
  ok(!!nospace && nospace.digits === "5139672841", "no-space phone format parses");
}

// ---------- 2. live end-to-end ----------
interface FakeMsg { size: number; text: string; envelope: string; }
function envelope(o: { date: string; subject: string; from: string; to: string[]; messageId: string }): string {
  const [fm, fh] = o.from.split("@");
  const addrList = (emails: string[]) => "(" + emails.map((e) => {
    const [mbox, host] = e.split("@");
    return `(" " NIL "${mbox}" "${host}")`;
  }).join(" ") + ")";
  return `("${o.date}" "${o.subject}" ((" " NIL "${fm}" "${fh}")) NIL NIL ${addrList(o.to)} NIL NIL NIL "${o.messageId}")`;
}
function startFakeImap(inbox: Map<string, FakeMsg>) {
  const seen = new Set<string>();
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
          const tag = m[1], up = m[2].toUpperCase();
          const wr = (s: string) => sock.write(s);
          if (/^LOGIN/.test(up)) { wr(`${tag} OK logged in\r\n`); continue; }
          if (/^LOGOUT/.test(up)) { wr(`* BYE bye\r\n${tag} OK logged out\r\n`); try { sock.end(); } catch { /* noop */ } continue; }
          if (/^SELECT/.test(up)) { wr(`* ${inbox.size} EXISTS\r\n${tag} OK selected\r\n`); continue; }
          if (/^UID SEARCH/.test(up)) {
            const ids = [...inbox.keys()].filter((u) => !seen.has(u));
            wr(`* SEARCH${ids.length ? " " + ids.join(" ") : ""}\r\n${tag} OK searched\r\n`); continue;
          }
          if (/^UID STORE/.test(up)) {
            const um = m[2].match(/UID STORE\s+([\d,]+)/i);
            for (const u of (um ? um[1].split(",") : [])) seen.add(u);
            wr(`${tag} OK stored\r\n`); continue;
          }
          if (/^UID FETCH/.test(up)) {
            const um = m[2].match(/UID FETCH\s+([\d,]+)/i);
            const uids = um ? um[1].split(",") : [];
            if (/BODY\.PEEK\[TEXT\]/.test(up)) {
              let s = "";
              for (const u of uids) {
                const t = inbox.get(u)?.text ?? "";
                s += `* 1 FETCH (UID ${u} BODY[TEXT] {${Buffer.byteLength(t)}}\r\n` + t + `\r\n)\r\n`;
              }
              wr(s + `${tag} OK text\r\n`); continue;
            }
            if (/ENVELOPE/.test(up)) {
              let s = "";
              for (const u of uids) {
                const msg = inbox.get(u);
                s += `* 1 FETCH (UID ${u} INTERNALDATE "29-Sep-2026 15:25:48 -0700" ENVELOPE ${msg?.envelope ?? "NIL"})\r\n`;
              }
              wr(s + `${tag} OK envelopes\r\n`); continue;
            }
            wr(`${tag} OK fetch\r\n`); continue;
          }
          wr(`${tag} BAD unknown command\r\n`);
        }
      },
    },
  });
  return server;
}

{
  const missedText = [
    "<https://voice.google.com>",
    "Hello Salve Sefu,",
    "",
    "You missed a call from Acela (513) 967-2841.",
    "call back",
    "<https://voice.google.com/calls?a=nc,%2B15139672841&e=salvesefu@gmail.com&source=callback_email>",
    "YOUR ACCOUNT <https://voice.google.com> HELP CENTER",
  ].join("\n");
  const strangerText = "Hello Salve Sefu,\n\nYou missed a call from Stranger (212) 555-0199.\ncall back";
  const inbox = new Map<string, FakeMsg>([
    ["1", {
      size: Buffer.byteLength(missedText), text: missedText,
      envelope: envelope({ date: "Tue, 29 Sep 2026 15:25:48 -0700", subject: SUBJ, from: "voice-noreply@google.com", to: ["salvesefu@gmail.com"], messageId: "<missed1@google.com>" }),
    }],
    ["2", {
      size: Buffer.byteLength(strangerText), text: strangerText,
      envelope: envelope({ date: "Tue, 29 Sep 2026 15:30:00 -0700", subject: "New missed call from Stranger.", from: "voice-noreply@google.com", to: ["salvesefu@gmail.com"], messageId: "<missed2@google.com>" }),
    }],
  ]);
  const imapSrv = startFakeImap(inbox);
  const imapPort = (imapSrv as any).port;

  const dir = mkdtempSync(join(tmpdir(), "relay-missed-"));
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imapPort, user: "me", pass: "x", secure: false },
  }));
  const port = 4400 + Math.floor(Math.random() * 800);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Tracked contact whose GV number matches the missed call.
    const cc = await (await fetch(base + "/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acela", gv_number: "5139672841" }),
    })).json();
    ok(cc.contact && cc.contact.id, "contact created");
    const convId = cc.contact && (await (await fetch(base + `/api/contacts/${cc.contact.id}`)).json()).contact.conversation_id;
    ok(!!convId, "contact has a DM conversation");

    const poll = await (await fetch(base + "/api/poll", { method: "POST" })).json();
    ok(poll.ok, "poll succeeds against the fake IMAP server");

    const mj = await (await fetch(base + `/api/conversations/${convId}/messages?limit=20`)).json();
    const alerts = (mj.messages || []).filter((m: any) => m.direction === "in" && m.body.includes("Missed call"));
    ok(alerts.length === 1, `exactly one missed-call alert in the DM (got ${alerts.length})`);
    ok(alerts[0] && alerts[0].body === "📞 Missed call from Acela", `alert body is exact (${alerts[0]?.body})`);
    ok(alerts[0] && alerts[0].channel === "sms", "alert rides the sms channel");
    ok(alerts[0] && alerts[0].external_id === "mail:1", "alert dedupes on the mail uid");

    // No conversation/message for the untracked number.
    const convs = await (await fetch(base + "/api/conversations")).json();
    const allBodies: string[] = [];
    for (const c of convs.conversations || []) {
      const mm = await (await fetch(base + `/api/conversations/${c.id}/messages?limit=20`)).json();
      for (const m of mm.messages || []) allBodies.push(m.body);
    }
    ok(!allBodies.some((b) => b.includes("Stranger")), "untracked number creates no alert");

    // Re-poll: the fake marks seen, and external_id dedupe holds anyway.
    await fetch(base + "/api/poll", { method: "POST" });
    const mj2 = await (await fetch(base + `/api/conversations/${convId}/messages?limit=20`)).json();
    const alerts2 = (mj2.messages || []).filter((m: any) => m.direction === "in" && m.body.includes("Missed call"));
    ok(alerts2.length === 1, "re-poll does not duplicate the alert");
  } finally {
    srv.kill();
    imapSrv.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
