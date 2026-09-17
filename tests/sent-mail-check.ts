// Sent-mail import checks:
//  1. unit: newMessageId + buildMessage Message-ID header + internalDateTimeToIso
//  2. fetchSentMail against a fake IMAP server (backfill + UID watermark)
//  3. live server end-to-end: seeded Relay-composed rows + fake Sent folder ->
//     POST /api/poll -> external sent mail imported with attachments, exact
//     and fuzzy dedupe hold, no duplicates on re-poll
// Run: bun tests/sent-mail-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSentMail, internalDateTimeToIso } from "../src/imap";
import { newMessageId, buildMessage } from "../src/smtp";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---------- 1. unit ----------
{
  const a = newMessageId(), b = newMessageId();
  ok(/^<[a-z0-9.]+@relay>$/.test(a), `newMessageId has msg-id shape (${a})`);
  ok(a !== b, "newMessageId is unique per call");
  const cfg: any = { from: "me@example.com", fromName: "Me" };
  const withMid = buildMessage(cfg, { to: ["x@y.z"], subject: "s", text: "t", messageId: a });
  ok(withMid.includes(`Message-ID: ${a}`), "buildMessage emits the given Message-ID");
  const withoutMid = buildMessage(cfg, { to: ["x@y.z"], subject: "s", text: "t" });
  ok(!/message-id:/i.test(withoutMid), "buildMessage omits Message-ID when none given");
  ok(internalDateTimeToIso("17-Sep-2026 12:00:00 +0000") === "2026-09-17T12:00:00Z",
    "internalDateTimeToIso parses INTERNALDATE with time");
  ok(internalDateTimeToIso("bogus") === "", "internalDateTimeToIso returns empty on garbage");
}

// ---------- 2. fetchSentMail vs fake IMAP ----------
interface FakeMsg { size: number; raw: string; text: string; envelope: string; internaldate: string; }

function addrList(emails: string[]): string {
  return "(" + emails.map((e) => {
    const [mbox, host] = e.split("@");
    return `(" " NIL "${mbox}" "${host}")`;
  }).join(" ") + ")";
}
function envelope(o: { date: string; subject: string; from: string; to: string[]; messageId: string }): string {
  const [fm, fh] = o.from.split("@");
  return `("${o.date}" "${o.subject}" ((" " NIL "${fm}" "${fh}")) NIL NIL ${addrList(o.to)} NIL NIL NIL "${o.messageId}")`;
}

function startFakeImap(boxes: Map<string, Map<string, FakeMsg>>) {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
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
            let ids: string[];
            const um = up.match(/UID (\d+):\*/);
            if (um) ids = [...boxMsgs.keys()].filter((u) => Number(u) >= Number(um[1]));
            else ids = [...boxMsgs.keys()]; // UNSEEN / SINCE -> everything in the test box
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
              wr(`${tag} OK bodies\r\n`); continue;
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

const imapCfg = (port: number) => ({ host: "127.0.0.1", port, user: "me", pass: "x", secure: false });

{
  const sentMsgs = new Map<string, FakeMsg>();
  const boxes = new Map<string, Map<string, FakeMsg>>([["INBOX", new Map()], ["Sent", sentMsgs]]);
  const srv = startFakeImap(boxes);
  const mk = (to: string[], subject: string, mid: string, text: string): FakeMsg => ({
    size: Buffer.byteLength(text), raw: "", text,
    envelope: envelope({ date: "Wed, 17 Sep 2026 12:00:00 +0000", subject, from: "me@example.com", to, messageId: mid }),
    internaldate: "17-Sep-2026 12:00:00 +0000",
  });
  sentMsgs.set("11", mk(["friend@example.com"], "Sent deck", "<ext1@mail>", "deck text"));
  sentMsgs.set("12", mk(["friend@example.com"], "Relay notes", "<relay1@relay>", "notes"));
  try {
    const r1 = await fetchSentMail(imapCfg((srv as any).port) as any, null);
    ok(r1.mailbox === "Sent", "fetchSentMail finds the Sent mailbox");
    ok(r1.items.length === 2 && r1.maxUid === 12, "backfill returns all sent items with maxUid");
    ok(r1.items[0].to.includes("friend@example.com"), "recipients parsed from envelope to");
    ok(r1.items[0].date === "2026-09-17T12:00:00Z", `full timestamp from INTERNALDATE (got ${r1.items[0].date})`);
    ok(r1.items[0].messageId === "<ext1@mail>", "envelope Message-ID parsed");
    const r2 = await fetchSentMail(imapCfg((srv as any).port) as any, 12);
    ok(r2.items.length === 0, "UID watermark suppresses already-seen mail");
    sentMsgs.set("13", mk(["friend@example.com"], "New", "<ext13@mail>", "new"));
    const r3 = await fetchSentMail(imapCfg((srv as any).port) as any, 12);
    ok(r3.items.length === 1 && r3.items[0].uid === "13" && r3.maxUid === 13,
      "only newer UIDs returned after watermark");
  } finally {
    srv.stop();
  }
}

// ---------- 3. live server end-to-end ----------
const B64PDF = "JVBERi0xLjQK"; // "%PDF-1.4\n"
const DECK_RAW = [
  "From: me@example.com",
  "To: friend@example.com",
  "Subject: Sent deck",
  "Message-ID: <ext1@mail>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Here is the deck you asked for.",
  "--b1",
  'Content-Type: application/pdf; name="deck.pdf"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="deck.pdf"',
  "",
  B64PDF,
  "--b1--",
  "",
].join("\r\n");

{
  // Sent box starts EMPTY so the server's boot-time auto-poll can't race the seeding below.
  const sentMsgs = new Map<string, FakeMsg>();
  const boxes = new Map<string, Map<string, FakeMsg>>([["INBOX", new Map()], ["Sent", sentMsgs]]);
  const imapSrv = startFakeImap(boxes);
  const imapPort = (imapSrv as any).port;

  const dir = mkdtempSync(join(tmpdir(), "relay-sent-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imapPort, user: "me", pass: "x", secure: false },
  }));
  const port = 4300 + Math.floor(Math.random() * 800);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  };
  const mk = (to: string[], subject: string, mid: string, text: string, raw = ""): FakeMsg => ({
    size: Buffer.byteLength(raw || text), raw, text,
    envelope: envelope({ date: "Wed, 17 Sep 2026 12:00:00 +0000", subject, from: "me@example.com", to, messageId: mid }),
    internaldate: "17-Sep-2026 12:00:00 +0000",
  });
  try {
    await wait();
    const cc = await (await fetch(base + "/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "File Friend", email: "friend@example.com" }),
    })).json();
    const convId = cc.contact && (await (await fetch(base + `/api/contacts/${cc.contact.id}`)).json()).contact.conversation_id;
    ok(!!convId, "contact created with a DM conversation");

    // Seed two Relay-composed rows: one with a stored Message-ID (exact dedupe),
    // one without (fuzzy dedupe + backfill).
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(dir, "data", "relay.db"));
    const ins = db.query(`INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, message_id, status, created_at)
      VALUES (?, ?, 'email', 'out', ?, ?, '', ?, 'sent', ?)`);
    ins.run("seed-1", convId, "Relay notes body", "Relay notes", "<relay1@relay>", new Date().toISOString());
    ins.run("seed-2", convId, "Old draft body", "Old draft", "", "2026-09-17T12:07:00.000Z");
    db.close();

    // Now expose the Sent folder contents.
    sentMsgs.set("11", mk(["friend@example.com"], "Sent deck", "<ext1@mail>", "Here is the deck you asked for.", DECK_RAW));
    sentMsgs.set("12", mk(["friend@example.com"], "Relay notes", "<relay1@relay>", "notes"));
    sentMsgs.set("13", mk(["stranger@example.com"], "Hi stranger", "<ext13@mail>", "hi"));
    sentMsgs.set("14", mk(["friend@example.com"], "Old draft", "<ext14@mail>", "draft"));

    const poll = await (await fetch(base + "/api/poll", { method: "POST" })).json();
    ok(poll.ok, "manual poll succeeds against the fake IMAP server");

    const mj = await (await fetch(base + `/api/conversations/${convId}/messages?limit=20`)).json();
    const out = (mj.messages || []).filter((m: any) => m.direction === "out" && m.channel === "email");
    ok(out.length === 3, `exactly 3 outbound emails in the thread (got ${out.length})`);
    ok(out.filter((m: any) => m.subject === "Relay notes").length === 1,
      "Relay-composed mail dedupes exactly via Message-ID");
    ok(out.filter((m: any) => m.subject === "Old draft").length === 1,
      "pre-Message-ID Relay mail dedupes fuzzily (no duplicate)");
    const imported = out.find((m: any) => m.external_id === "sentmail:Sent:11");
    ok(!!imported && imported.subject === "Sent deck", "external sent mail imported into the thread");
    ok(imported && imported.attachments && imported.attachments.length === 1 && imported.attachments[0].filename === "deck.pdf",
      "imported sent mail carries its attachment in thread metadata");

    const db2 = new Database(join(dir, "data", "relay.db"));
    const seed2 = db2.query("SELECT message_id FROM messages WHERE id = 'seed-2'").get() as any;
    db2.close();
    ok(seed2?.message_id === "<ext14@mail>", "fuzzy match backfills the Message-ID onto the composed row");

    const sj = await (await fetch(base + `/api/conversations/${convId}/files?q=deck`)).json();
    ok(sj.files.length === 1 && sj.files[0].filename === "deck.pdf" && sj.files[0].direction === "out",
      "filename search finds the sent attachment");
    const dl = await fetch(base + `/api/attachments/${sj.files[0].id}`);
    ok(Buffer.from(await dl.arrayBuffer()).toString() === "%PDF-1.4\n",
      "sent attachment bytes round-trip through download");

    // Re-poll: watermark + dedupe must keep everything stable.
    await fetch(base + "/api/poll", { method: "POST" });
    const mj2 = await (await fetch(base + `/api/conversations/${convId}/messages?limit=20`)).json();
    const out2 = (mj2.messages || []).filter((m: any) => m.direction === "out" && m.channel === "email");
    ok(out2.length === 3, "re-poll does not duplicate sent mail");
    const sj2 = await (await fetch(base + `/api/conversations/${convId}/files?q=deck`)).json();
    ok(sj2.files.length === 1, "re-poll does not duplicate the sent attachment");
  } finally {
    srv.kill();
    imapSrv.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
