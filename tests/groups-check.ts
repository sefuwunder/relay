// Auto-grouping checks: inbound email (and Sent-folder mail) that involves
// several tracked contacts lands in exactly one conversation — their group,
// created on the spot when needed — never duplicated into DMs.
// Run: bun tests/groups-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

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
  const sentBox = new Map<string, FakeMsg>();
  const imap = startFakeImap(new Map([["INBOX", inbox], ["Sent", sentBox]]));

  const dir = mkdtempSync(join(tmpdir(), "relay-groups-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imap.port, user: "me", pass: "x", secure: false },
    smtp: { host: "127.0.0.1", port: smtp.port, secure: "none", user: "", pass: "", from: "me@example.com", fromName: "Me" },
  }));
  const port = 4500 + Math.floor(Math.random() * 700);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: any) => {
    const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const get = async (p: string) => (await fetch(base + p)).json();
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error("server did not start");
    }

    const mkContact = async (name: string, email: string) => {
      const r = await post("/api/contacts", { name, email });
      ok(r.status === 201, `contact ${name} created`);
      const full = await get(`/api/contacts/${r.json.contact.id}`);
      return { ...r.json.contact, conversation_id: full.contact.conversation_id };
    };
    const pal = await mkContact("Pal", "pal@example.com");
    const sam = await mkContact("Sam", "sam@example.com");
    const alex = await mkContact("Alex", "alex@example.com");

    const mkMail = (uid: string, from: string, to: string[], subject: string, mid: string, text: string) => {
      const raw = [`From: ${from}`, `To: ${to.join(", ")}`, `Subject: ${subject}`, `Message-ID: ${mid}`, "", text, ""].join("\r\n");
      inbox.set(uid, {
        size: Buffer.byteLength(raw), raw, text,
        envelope: envelope({ date: "Thu, 17 Sep 2026 12:00:00 +0000", subject, from, to, messageId: mid }),
        internaldate: "17-Sep-2026 12:00:00 +0000",
      });
    };
    const convs = async () => (await get("/api/conversations")).conversations as any[];
    const msgs = async (id: string) => (await get(`/api/conversations/${id}/messages?limit=50`)).messages as any[];
    const groups = async () => (await convs()).filter((c: any) => c.is_group);

    // 1. pal -> me + sam: a group is created, the mail lives only there.
    mkMail("1", "pal@example.com", ["me@example.com", "sam@example.com"], "Weekend plans", "<g1@example.com>", "Cabin trip?");
    await post("/api/poll", {});
    let gs = await groups();
    ok(gs.length === 1, `group email creates one group (got ${gs.length})`);
    ok(gs[0].title === "Pal & Sam", `group named from members (${gs[0].title})`);
    const g1msgs = await msgs(gs[0].id);
    ok(g1msgs.length === 1 && g1msgs[0].subject === "Weekend plans", "group mail lands in the group");
    const palDm = await msgs(pal.conversation_id);
    const samDm = await msgs(sam.conversation_id);
    ok(!palDm.some((m: any) => m.subject === "Weekend plans"), "group mail is NOT in pal's DM");
    ok(!samDm.some((m: any) => m.subject === "Weekend plans"), "group mail is NOT in sam's DM");

    // 2. sam replies-all: same group, no duplicate.
    mkMail("2", "sam@example.com", ["me@example.com", "pal@example.com"], "Re: Weekend plans", "<g2@example.com>", "I'm in!");
    await post("/api/poll", {});
    gs = await groups();
    ok(gs.length === 1, "reply-all reuses the group");
    ok((await msgs(gs[0].id)).length === 2, "reply-all lands in the same group");

    // 3. pal -> me alone: DM as before.
    mkMail("3", "pal@example.com", ["me@example.com"], "Just you", "<d1@example.com>", "1:1 stuff");
    await post("/api/poll", {});
    ok((await msgs(pal.conversation_id)).some((m: any) => m.subject === "Just you"), "1:1 mail still lands in the DM");
    ok((await groups()).length === 1, "1:1 mail creates no group");

    // 4. untracked sender, one tracked recipient: filed in that contact's DM.
    mkMail("4", "boss@work.com", ["me@example.com", "alex@example.com"], "Quick note", "<d2@example.com>", "hi alex");
    await post("/api/poll", {});
    ok((await msgs(alex.conversation_id)).some((m: any) => m.subject === "Quick note"), "mail involving one contact lands in their DM");
    ok((await groups()).length === 1, "single-participant mail creates no group");

    // 5. nobody tracked: skipped.
    mkMail("5", "stranger@x.com", ["me@example.com"], "Spam", "<s1@example.com>", "buy now");
    await post("/api/poll", {});
    const allMsgs = (await convs()).map((c: any) => c.id);
    let found = false;
    for (const id of allMsgs) if ((await msgs(id)).some((m: any) => m.subject === "Spam")) found = true;
    ok(!found, "mail with no tracked participant is skipped");

    // 6. Sent-folder mail to pal + sam: joins the existing group.
    const sentRaw = ["From: me@example.com", "To: pal@example.com, sam@example.com", "Subject: Re: Weekend plans",
      "Message-ID: <sent1@example.com>", "", "Sounds great!", ""].join("\r\n");
    sentBox.set("1", {
      size: Buffer.byteLength(sentRaw), raw: sentRaw, text: "Sounds great!",
      envelope: envelope({ date: "Thu, 17 Sep 2026 13:00:00 +0000", subject: "Re: Weekend plans", from: "me@example.com", to: ["pal@example.com", "sam@example.com"], messageId: "<sent1@example.com>" }),
      internaldate: "17-Sep-2026 13:00:00 +0000",
    });
    await post("/api/poll", {});
    gs = await groups();
    ok(gs.length === 1, "sent mail to the same pair reuses the group");
    ok((await msgs(gs[0].id)).some((m: any) => m.direction === "out" && m.subject === "Re: Weekend plans"),
      "sent mail lands in the group");

    // 7. Sent to a new pair: a new group is created.
    const sentRaw2 = ["From: me@example.com", "To: pal@example.com, alex@example.com", "Subject: Intro",
      "Message-ID: <sent2@example.com>", "", "You two should meet.", ""].join("\r\n");
    sentBox.set("2", {
      size: Buffer.byteLength(sentRaw2), raw: sentRaw2, text: "You two should meet.",
      envelope: envelope({ date: "Thu, 17 Sep 2026 13:30:00 +0000", subject: "Intro", from: "me@example.com", to: ["pal@example.com", "alex@example.com"], messageId: "<sent2@example.com>" }),
      internaldate: "17-Sep-2026 13:30:00 +0000",
    });
    await post("/api/poll", {});
    gs = await groups();
    ok(gs.length === 2, "sent mail to a new pair creates a group");
    const palAlex = gs.find((g: any) => g.title === "Pal & Alex");
    ok(!!palAlex && (await msgs(palAlex.id)).some((m: any) => m.subject === "Intro"), "new-pair group holds the sent mail");

    // 8. Group size cap: 8 contacts on one thread -> group capped at 7 members.
    const extras: any[] = [];
    for (let i = 4; i <= 8; i++) extras.push(await mkContact(`Extra${i}`, `extra${i}@example.com`));
    const all = [pal, sam, alex, ...extras];
    mkMail("6", "pal@example.com", ["me@example.com", ...all.slice(1).map((c: any) => c.email)], "Big thread", "<big@example.com>", "hello all");
    await post("/api/poll", {});
    gs = await groups();
    const big = gs.find((g: any) => (g.member_count === 7));
    ok(!!big, "oversized thread creates a capped group");
    ok(!(await msgs(pal.conversation_id)).some((m: any) => m.subject === "Big thread"), "oversized thread is not in the DM either");
  } finally {
    srv.kill();
    smtp.close();
    imap.stop();
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\ngroups: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
