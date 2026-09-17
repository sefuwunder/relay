// Inbound IMAP attachment extraction checks:
//  1. pure MIME parser unit tests (parseMailAttachments — no network)
//  2. fetchMailAttachments against a fake IMAP server (size gate + extraction)
//  3. live server end-to-end: fake IMAP -> POST /api/poll -> inbound file in
//     the message thread, the Shared files widget, and filename search
// Run: bun tests/imap-attachments-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMailAttachments,
  fetchMailAttachments,
} from "../src/imap";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

const B64PDF = "JVBERi0xLjQK"; // "%PDF-1.4\n"

// ---------- 1. parser unit tests ----------
{
  const raw = [
    "From: File Friend <friend@example.com>",
    "Subject: contract attached",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Here is the contract you asked for.",
    "--b1",
    'Content-Type: application/pdf; name="contract.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="contract.pdf"',
    "",
    B64PDF,
    "--b1--",
    "",
  ].join("\r\n");
  const atts = parseMailAttachments(raw);
  ok(atts.length === 1, "multipart mail yields exactly one attachment (text part skipped)");
  ok(atts[0]?.filename === "contract.pdf", "attachment filename parsed");
  ok(atts[0]?.mime === "application/pdf", "attachment mime parsed");
  ok(atts[0]?.data.toString() === "%PDF-1.4\n", "base64 attachment bytes decoded");
}

{
  // quoted-printable attachment
  const raw = [
    'Content-Type: multipart/mixed; boundary="q"',
    "",
    "--q",
    "Content-Type: text/plain",
    "",
    "see attached",
    "--q",
    'Content-Type: text/plain; name="note.txt"',
    "Content-Transfer-Encoding: quoted-printable",
    'Content-Disposition: attachment; filename="note.txt"',
    "",
    "Hello=2C=20world!=",
    "--q--",
  ].join("\r\n");
  const atts = parseMailAttachments(raw);
  ok(atts.length === 1 && atts[0].data.toString() === "Hello, world!", "quoted-printable attachment decoded");
}

{
  // RFC 2047 encoded-word filename
  const raw = [
    'Content-Type: multipart/mixed; boundary="e"',
    "",
    "--e",
    "Content-Type: text/plain",
    "",
    "x",
    "--e",
    "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="=?UTF-8?B?aGVsbG8udHh0?="',
    "",
    "QUJD",
    "--e--",
  ].join("\r\n");
  const atts = parseMailAttachments(raw);
  ok(atts.length === 1 && atts[0].filename === "hello.txt", "RFC2047 encoded filename decoded");
}

{
  // RFC 2231 single-segment filename*
  const raw = [
    'Content-Type: multipart/mixed; boundary="r"',
    "",
    "--r",
    "Content-Type: text/plain",
    "",
    "x",
    "--r",
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*=utf-8''%E2%82%ACuro.pdf",
    "",
    "QUJD",
    "--r--",
  ].join("\r\n");
  const atts = parseMailAttachments(raw);
  ok(atts.length === 1 && atts[0].filename === "€uro.pdf", "RFC2231 filename* decoded");
}

{
  // RFC 2231 continuations: filename*0*, filename*1*
  const raw = [
    'Content-Type: multipart/mixed; boundary="c"',
    "",
    "--c",
    "Content-Type: text/plain",
    "",
    "x",
    "--c",
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*0*=utf-8''%E2%82%ACuro-; filename*1*=report.pdf",
    "",
    "QUJD",
    "--c--",
  ].join("\r\n");
  const atts = parseMailAttachments(raw);
  ok(atts.length === 1 && atts[0].filename === "€uro-report.pdf", "RFC2231 continuations concatenated");
}

{
  // nested multipart (alternative inside mixed) + name= fallback without Content-Disposition
  const raw = [
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain",
    "",
    "hello",
    "--inner",
    "Content-Type: text/html",
    "",
    "<b>hello</b>",
    "--inner--",
    "--outer",
    'Content-Type: application/pdf; name="a.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "QUJD",
    "--outer--",
  ].join("\r\n");
  const atts = parseMailAttachments(raw);
  ok(atts.length === 1 && atts[0].filename === "a.pdf" && atts[0].data.toString() === "ABC",
    "nested multipart: attachment found via Content-Type name= fallback");
}

{
  // plain text mail, no attachments
  const atts = parseMailAttachments("From: x@y.z\r\nSubject: hi\r\n\r\njust text");
  ok(atts.length === 0, "plain text mail yields no attachments");
}

{
  // inline image with Content-ID but no filename is not a file
  const raw = [
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html",
    "",
    '<img src="cid:img1">',
    "--rel",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: inline",
    "Content-ID: <img1>",
    "",
    "iVBORw0KGgo=",
    "--rel--",
  ].join("\r\n");
  ok(parseMailAttachments(raw).length === 0, "inline part without filename is skipped");
}

{
  // garbage in, empty out — never throws
  let threw = false, res: any[] = [];
  try { res = parseMailAttachments("not a message at all {{{"); } catch { threw = true; }
  ok(!threw && res.length === 0, "malformed input returns [] without throwing");
}

{
  // zero-byte attachment part is skipped
  const raw = [
    'Content-Type: multipart/mixed; boundary="z"',
    "",
    "--z",
    "Content-Type: text/plain",
    "",
    "x",
    "--z",
    'Content-Type: application/pdf; name="empty.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="empty.pdf"',
    "",
    "--z--",
  ].join("\r\n");
  ok(parseMailAttachments(raw).length === 0, "zero-byte attachment part is skipped");
}

// ---------- 2 + 3. fake IMAP server ----------
const MIME_RAW = [
  "From: File Friend <friend@example.com>",
  "To: me@example.com",
  "Subject: contract attached",
  "Message-ID: <abc123@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Here is the contract you asked for.",
  "--b1",
  'Content-Type: application/pdf; name="contract.pdf"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="contract.pdf"',
  "",
  B64PDF,
  "--b1--",
  "",
].join("\r\n");
const MIME_TEXT = "Here is the contract you asked for.";
const ENVELOPE = '("Wed, 17 Sep 2026 12:00:00 +0000" "contract attached" (("File Friend" NIL "friend" "example.com")) NIL NIL NIL NIL NIL NIL "<abc123@example.com>")';

function startFakeImap(
  messages: Map<string, { size: number; raw: string; text: string; envelope: string }>,
  track: { bodyUids: string[] },
) {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
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
          if (/^SELECT/.test(up)) { wr(`* ${messages.size} EXISTS\r\n${tag} OK selected\r\n`); continue; }
          if (/^LOGOUT/.test(up)) { wr(`* BYE bye\r\n${tag} OK logged out\r\n`); try { sock.end(); } catch { /* noop */ } continue; }
          if (/^UID SEARCH/.test(up)) {
            const ids = [...messages.keys()].join(" ");
            wr(`* SEARCH${ids ? " " + ids : ""}\r\n${tag} OK searched\r\n`); continue;
          }
          if (/^UID STORE/.test(up)) { wr(`${tag} OK stored\r\n`); continue; }
          if (/^UID FETCH/.test(up)) {
            const um = cmd.match(/UID FETCH\s+([\d,]+)/i);
            const uids = um ? um[1].split(",") : [];
            if (/RFC822\.SIZE/.test(up)) {
              let s = "";
              for (const u of uids) s += `* 1 FETCH (UID ${u} RFC822.SIZE ${messages.get(u)?.size ?? 0})\r\n`;
              wr(s + `${tag} OK sizes\r\n`); continue;
            }
            if (/BODY\.PEEK\[TEXT\]/.test(up)) {
              let s = "";
              for (const u of uids) {
                const t = messages.get(u)?.text ?? "";
                s += `* 1 FETCH (UID ${u} BODY[TEXT] {${Buffer.byteLength(t)}}\r\n` + t + `\r\n)\r\n`;
              }
              wr(s + `${tag} OK text\r\n`); continue;
            }
            if (/HEADER\.FIELDS/.test(up)) {
              let s = "";
              for (const u of uids) s += `* 1 FETCH (UID ${u} BODY[HEADER.FIELDS (RETURN-PATH)] {0}\r\n\r\n)\r\n`;
              wr(s + `${tag} OK hdrs\r\n`); continue;
            }
            if (/ENVELOPE/.test(up)) {
              let s = "";
              for (const u of uids) {
                const env = messages.get(u)?.envelope ?? `("01-Jan-2026 00:00:00 +0000" "x" NIL NIL NIL NIL NIL NIL NIL NIL)`;
                s += `* 1 FETCH (UID ${u} INTERNALDATE "17-Sep-2026 12:00:00 +0000" ENVELOPE ${env})\r\n`;
              }
              wr(s + `${tag} OK envelopes\r\n`); continue;
            }
            if (/BODY\.PEEK\[\]/.test(up)) {
              for (const u of uids) {
                track.bodyUids.push(u);
                const raw = messages.get(u)?.raw ?? "";
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

const imapCfg = (port: number) => ({ host: "127.0.0.1", port, user: "test", pass: "test", secure: false });

// ---------- 2. fetchMailAttachments: size gate + extraction ----------
{
  const track = { bodyUids: [] as string[] };
  const msgs = new Map([
    ["201", { size: Buffer.byteLength(MIME_RAW), raw: MIME_RAW, text: MIME_TEXT, envelope: ENVELOPE }],
    ["202", { size: 999 * 1024 * 1024, raw: MIME_RAW, text: MIME_TEXT, envelope: ENVELOPE }], // over the cap
  ]);
  const srv = startFakeImap(msgs, track);
  try {
    const res = await fetchMailAttachments(imapCfg((srv as any).port), ["201", "202"]);
    const a201 = res.get("201") || [];
    ok(a201.length === 1 && a201[0].filename === "contract.pdf" && a201[0].data.toString() === "%PDF-1.4\n",
      "fetchMailAttachments extracts the attachment over IMAP");
    ok(!res.has("202"), "oversize message is skipped by the size gate");
    ok(track.bodyUids.includes("201") && !track.bodyUids.includes("202"),
      "full body is only fetched for messages under the size cap");
    const empty = await fetchMailAttachments(imapCfg((srv as any).port), []);
    ok(empty.size === 0, "empty uid list returns an empty map");
  } finally {
    srv.stop();
  }
}

// ---------- 3. live server end-to-end ----------
{
  const track = { bodyUids: [] as string[] };
  const msgs = new Map([
    ["301", { size: Buffer.byteLength(MIME_RAW), raw: MIME_RAW, text: MIME_TEXT, envelope: ENVELOPE }],
  ]);
  const imapSrv = startFakeImap(msgs, track);
  const imapPort = (imapSrv as any).port;

  const dir = mkdtempSync(join(tmpdir(), "relay-inbound-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imapPort, user: "test", pass: "test", secure: false },
  }));
  const port = 4200 + Math.floor(Math.random() * 800);
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
    const cc = await (await fetch(base + "/api/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "File Friend", email: "friend@example.com" }),
    })).json();
    const convId = cc.contact && (await (await fetch(base + `/api/contacts/${cc.contact.id}`)).json()).contact.conversation_id;
    ok(!!convId, "contact created with a DM conversation");

    // Manual poll pulls the fake inbound email (with attachment) into the thread.
    const poll = await (await fetch(base + "/api/poll", { method: "POST" })).json();
    ok(poll.ok, "manual poll succeeds against the fake IMAP server");

    const mj = await (await fetch(base + `/api/conversations/${convId}/messages?limit=10`)).json();
    const inbound = (mj.messages || []).find((m: any) => m.external_id === "mail:301");
    ok(!!inbound && inbound.direction === "in" && inbound.channel === "email", "inbound email lands in the thread");
    ok(inbound && inbound.attachments && inbound.attachments.length === 1 && inbound.attachments[0].filename === "contract.pdf",
      "inbound message carries the extracted attachment in thread metadata");

    const fj = await (await fetch(base + `/api/conversations/${convId}/files`)).json();
    ok(fj.files && fj.files.some((f: any) => f.filename === "contract.pdf" && f.direction === "in"),
      "Shared files widget lists the inbound attachment");

    const sj = await (await fetch(base + `/api/conversations/${convId}/files?q=contract`)).json();
    ok(sj.files.length === 1 && sj.files[0].filename === "contract.pdf",
      "filename search finds the inbound attachment");

    const attId = sj.files[0].id;
    const dl = await fetch(base + `/api/attachments/${attId}`);
    const bytes = Buffer.from(await dl.arrayBuffer()).toString();
    ok(bytes === "%PDF-1.4\n", "inbound attachment bytes round-trip through download");

    // A second poll must not duplicate the message or its files.
    await fetch(base + "/api/poll", { method: "POST" });
    const fj2 = await (await fetch(base + `/api/conversations/${convId}/files?q=contract`)).json();
    ok(fj2.files.length === 1, "re-poll does not duplicate the inbound attachment");
  } finally {
    srv.kill();
    imapSrv.stop();
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
