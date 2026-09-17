// Participant migration checks: old email stored before participants were
// recorded gets its sender/recipient data backfilled (re-located on the
// server by stable Message-ID), and multi-contact threads move into their
// group — created on the spot when missing. Dry-run changes nothing;
// re-running is a no-op.
// Run: bun tests/migrate-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

interface FakeMsg { size: number; raw: string; text: string; envelope: string; internaldate: string; mid: string; }
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
            // The migration looks mail up by Message-ID; honor that filter.
            const hm = cmd.match(/HEADER\s+Message-ID\s+"([^"]*)"/i);
            let ids = [...boxMsgs.keys()];
            if (hm) ids = ids.filter((u) => boxMsgs.get(u)?.mid === hm[1]);
            wr(`* SEARCH${ids.length ? " " + ids.join(" ") : ""}\r\n${tag} OK searched\r\n`); continue;
          }
          if (/^UID FETCH/.test(up)) {
            const um = cmd.match(/UID FETCH\s+([\d,]+)/i);
            const uids = um ? um[1].split(",") : [];
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
  const inbox = new Map<string, FakeMsg>();
  const sentBox = new Map<string, FakeMsg>();
  const imap = startFakeImap(new Map([["INBOX", inbox], ["Sent", sentBox]]));

  const dir = mkdtempSync(join(tmpdir(), "relay-migrate-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({
    imap: { host: "127.0.0.1", port: imap.port, user: "me", pass: "x", secure: false },
    smtp: { host: "127.0.0.1", port: 1, secure: "none", user: "", pass: "", from: "me@example.com", fromName: "Me" },
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

    const msgs = async (id: string) => (await get(`/api/conversations/${id}/messages?limit=50`)).messages as any[];
    const groups = async () => ((await get("/api/conversations")).conversations as any[]).filter((c: any) => c.is_group);

    // Seed "old" rows the way they looked before participants were recorded:
    // participants blank, filed wherever the old code put them (pal's DM).
    const db = new Database(join(dir, "data", "relay.db"));
    const seedMsg = (id: string, conv: string, channel: string, dirn: string, subject: string, extId: string, mid: string) => {
      db.query("INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, message_id, participants, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?)")
        .run(id, conv, channel, dirn, "old body", subject, extId, mid, "2026-08-01T10:00:00.000Z");
    };
    // NOTE: rows seeded BEFORE the fake mails land in the boxes, so even if a
    // poll interleaves it dedupes on external_id.
    seedMsg("m1", pal.conversation_id, "email", "in", "Old group thread", "mail:91", "<oldgroup@example.com>");
    seedMsg("m2", pal.conversation_id, "email", "in", "Old DM thread", "mail:92", "<olddm@example.com>");
    seedMsg("m3", pal.conversation_id, "email", "in", "No message id", "mail:93", "");
    seedMsg("m4", pal.conversation_id, "sms", "in", "", "sms:99", "");
    seedMsg("m5", pal.conversation_id, "email", "out", "Old sent group", "sentmail:Sent:5", "<oldsent@example.com>");
    db.close();

    const mkMail = (box: Map<string, FakeMsg>, uid: string, from: string, to: string[], subject: string, mid: string) => {
      const raw = [`From: ${from}`, `To: ${to.join(", ")}`, `Subject: ${subject}`, `Message-ID: ${mid}`, "", "body", ""].join("\r\n");
      box.set(uid, {
        size: Buffer.byteLength(raw), raw, text: "body", mid,
        envelope: envelope({ date: "Thu, 17 Sep 2026 12:00:00 +0000", subject, from, to, messageId: mid }),
        internaldate: "17-Sep-2026 12:00:00 +0000",
      });
    };
    mkMail(inbox, "91", "pal@example.com", ["me@example.com", "sam@example.com"], "Old group thread", "<oldgroup@example.com>");
    mkMail(inbox, "92", "pal@example.com", ["me@example.com"], "Old DM thread", "<olddm@example.com>");
    mkMail(sentBox, "5", "me@example.com", ["pal@example.com", "sam@example.com"], "Old sent group", "<oldsent@example.com>");

    const row = (id: string) => {
      const d = new Database(join(dir, "data", "relay.db"));
      const r = d.query("SELECT * FROM messages WHERE id = ?").get(id) as any;
      d.close();
      return r;
    };

    // 1. Dry run: reports what would happen, changes nothing.
    const dry = await post("/api/migrate-participants", { dry_run: true });
    ok(dry.status === 200 && dry.json.dry_run === true, "dry run returns 200 + dry_run flag");
    ok(dry.json.scanned === 3, `dry run scans 3 old mails (got ${dry.json.scanned})`);
    ok(dry.json.enriched === 3, `dry run would enrich 3 (got ${dry.json.enriched})`);
    ok(dry.json.moved === 2, `dry run would move 2 (got ${dry.json.moved})`);
    ok(dry.json.unresolved === 0, `dry run unresolved 0 (got ${dry.json.unresolved})`);
    ok(dry.json.groups.length === 1 && dry.json.groups[0].name === "Pal & Sam (new)",
      `dry run previews the new group (got ${JSON.stringify(dry.json.groups)})`);
    ok((await groups()).length === 0, "dry run creates no group");
    ok(row("m1").participants === "" && row("m1").conversation_id === pal.conversation_id,
      "dry run leaves m1 untouched");

    // 2. Real run: backfills participants, moves multi-contact mail to a group.
    const real = await post("/api/migrate-participants", {});
    ok(real.json.enriched === 3 && real.json.moved === 2 && real.json.unresolved === 0,
      `real run enriches 3 and moves 2 (${real.json.enriched}/${real.json.moved}/${real.json.unresolved})`);
    const p1 = JSON.parse(row("m1").participants);
    ok(p1.includes(pal.id) && p1.includes(sam.id) && p1.length === 2, "m1 carries pal + sam");
    const p5 = JSON.parse(row("m5").participants);
    ok(p5.includes(pal.id) && p5.includes(sam.id) && p5.length === 2, "m5 (sent mail) carries pal + sam");
    ok(JSON.parse(row("m2").participants).join() === pal.id, "m2 carries just pal");
    ok(row("m3").participants === "", "m3 (no Message-ID) stays unresolved");
    ok(row("m4").participants === "", "m4 (sms) is out of scope, untouched");
    const gs = await groups();
    ok(gs.length === 1 && gs[0].title === "Pal & Sam", `one group created, named from members (${gs.map((g: any) => g.title)})`);
    ok(row("m1").conversation_id === gs[0].id && row("m5").conversation_id === gs[0].id,
      "both group mails moved into the same group");
    ok(row("m2").conversation_id === pal.conversation_id, "1:1 old mail stays in the DM");
    const gsubs = (await msgs(gs[0].id)).map((m: any) => m.subject).sort();
    ok(gsubs.join("|") === "Old group thread|Old sent group", `group holds both threads (${gsubs})`);
    const dmSubs = (await msgs(pal.conversation_id)).map((m: any) => m.subject);
    ok(!dmSubs.includes("Old group thread") && dmSubs.includes("Old DM thread") && dmSubs.includes("No message id"),
      "pal's DM keeps only its own threads");

    // 3. Re-run: idempotent no-op.
    const again = await post("/api/migrate-participants", {});
    ok(again.json.scanned === 0 && again.json.enriched === 0 && again.json.moved === 0,
      `re-run is a no-op (${again.json.scanned}/${again.json.enriched}/${again.json.moved})`);
    ok((await groups()).length === 1, "re-run creates no extra group");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } finally {
    srv.kill();
    imap.stop();
  }
}
