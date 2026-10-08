// Conversation nudge checks:
//  A. unanswered: fires at exactly 3d (not 2d); silent when last dir is 'in';
//     no refire without new exchange; a reply resets the streak.
//  B. stale: fires at cadence_days (default 7); custom 14; never=null;
//     refires after another full window; groups fixed 7d; agents excluded.
//  C. staged_followup: fires at 2d with no outbound; silent if outbound;
//     refires 3d before expiry.
//  D. snooze suppresses for the duration; dismiss suppresses until next trigger.
//  E. server routes: GET /api/nudges shape; cadence_days on POST/PATCH;
//     invalid cadence -> 400; snooze/dismiss round-trip; bogus key -> 404.
// Run: bun tests/nudges-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

const DAY = 86400_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

// ================= Part A–D: db-level =================
const { openDb, getDb, uid } = await import("../src/db.ts");
const { listNudges, snoozeNudge, dismissNudge } = await import("../src/nudges.ts");

const tmp = mkdtempSync(join(tmpdir(), "relay-nudges-"));
openDb(join(tmp, "relay.db"));
const db = getDb();

function mkContact(name: string, opts: any = {}) {
  const id = uid();
  db.query(`INSERT INTO contacts (id, name, email, gv_number, matrix_id, matrix_room_id, color, notes, photo, kind, agent_url, agent_secret, archived, cadence_days, created_at)
    VALUES (?, ?, '', '', '', '', '', '', '', ?, '', '', 0, ?, ?)`)
    .run(id, name, opts.kind || "person", opts.cadence_days === undefined ? 7 : opts.cadence_days, new Date().toISOString());
  return id;
}
function mkConv(memberIds: string[], isGroup = false, name = "") {
  const id = uid();
  db.query(`INSERT INTO conversations (id, name, is_group, matrix_room_id, last_read_at, archived, created_at) VALUES (?, ?, ?, '', '', 0, ?)`)
    .run(id, name, isGroup ? 1 : 0, new Date().toISOString());
  for (const mid of memberIds) db.query(`INSERT INTO members (conversation_id, contact_id) VALUES (?, ?)`).run(id, mid);
  return id;
}
function mkMsg(convId: string, direction: "in" | "out", ageMs: number, body = "hello") {
  db.query(`INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, message_id, participants, status, created_at)
    VALUES (?, ?, 'email', ?, ?, '', '', '', '', '', ?)`)
    .run(uid(), convId, direction, body, isoAgo(ageMs));
}
function mkStaged(name: string, ageMs: number, expiresInMs = 14 * DAY) {
  const id = uid();
  const t = Date.now() - ageMs;
  db.query(`INSERT INTO staged_contacts (id, name, channel, handle, met_at, met_where, met_about, notes, expires_at, extended, status, replied, created_at)
    VALUES (?, ?, 'email', ?, ?, 'Conf', 'things', '', ?, 0, 'staged', 0, ?)`)
    .run(id, name, name.replace(/\s/g, "").toLowerCase() + "@x.com", t, t + ageMs + expiresInMs, t);
  return id;
}
function stagedThread(stagedId: string) {
  const id = uid();
  db.query(`INSERT INTO conversations (id, name, is_group, matrix_room_id, last_read_at, archived, created_at) VALUES (?, '', 0, '', '', 0, ?)`)
    .run(id, new Date().toISOString());
  db.query(`INSERT INTO members (conversation_id, contact_id) VALUES (?, ?)`).run(id, `staged:${stagedId}`);
  return id;
}
const nudgeKeys = (t?: string) => listNudges().filter((n) => !t || n.type === t).map((n) => n.key);

// ---- A1: unanswered fires at exactly 3d, not 2d ----
{
  const c = mkContact("Ava");
  const conv = mkConv([c]);
  mkMsg(conv, "out", 2 * DAY + 3600_000);
  ok(!nudgeKeys("unanswered").includes(`unanswered:${conv}`), "A1: no unanswered nudge at ~2d");
  db.query("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run(isoAgo(3 * DAY + 3600_000), conv);
  const ns = listNudges().filter((n) => n.key === `unanswered:${conv}`);
  ok(ns.length === 1, "A1: unanswered fires at 3d+");
  ok(ns[0].days === 3, `A1: days=3 (got ${ns[0].days})`);
  ok(/Ava/.test(ns[0].title) && /hasn't replied/.test(ns[0].body), "A1: warm copy names them");
}

// ---- A2: silent when last direction is 'in' ----
{
  const c = mkContact("Ben");
  const conv = mkConv([c]);
  mkMsg(conv, "in", 4 * DAY);
  ok(!nudgeKeys("unanswered").includes(`unanswered:${conv}`), "A2: no unanswered when they wrote last");
}

// ---- A3: no refire without new exchange ----
{
  const c = mkContact("Cat");
  const conv = mkConv([c]);
  mkMsg(conv, "out", 4 * DAY);
  const k = `unanswered:${conv}`;
  ok(nudgeKeys("unanswered").includes(k), "A3: fires first time");
  ok(!nudgeKeys("unanswered").includes(k), "A3: no refire on second check (same streak)");
}

// ---- A4: a reply resets the streak ----
{
  const c = mkContact("Dan");
  const conv = mkConv([c]);
  mkMsg(conv, "out", 10 * DAY);
  const k = `unanswered:${conv}`;
  ok(nudgeKeys("unanswered").includes(k), "A4: first streak fires");
  // Simulate the first fire having happened 8 days ago, then a reply + new
  // outbound message 6 days ago (a genuinely new streak).
  db.query("UPDATE nudge_state SET last_fired_at = ? WHERE key = ?").run(Date.now() - 8 * DAY, k);
  mkMsg(conv, "in", 6 * DAY, "reply!");
  mkMsg(conv, "out", 6 * DAY - 3600_000, "thanks");
  ok(nudgeKeys("unanswered").includes(k), "A4: new streak after reply fires again");
}

// ---- B1: stale fires at default cadence 7 ----
{
  const c = mkContact("Eli"); // cadence default 7
  const conv = mkConv([c]);
  mkMsg(conv, "in", 8 * DAY, "hey");
  const ns = listNudges().filter((n) => n.key === `stale:${conv}`);
  ok(ns.length === 1 && ns[0].days === 8, "B1: stale fires at 8d on default cadence 7");
  ok(/Quiet with Eli/.test(ns[0].title), "B1: calm copy");
}

// ---- B2: custom cadence 14 ----
{
  const c = mkContact("Fay", { cadence_days: 14 });
  const conv = mkConv([c]);
  mkMsg(conv, "in", 10 * DAY, "hey");
  ok(!nudgeKeys("stale").includes(`stale:${conv}`), "B2: no stale at 10d on cadence 14");
  db.query("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run(isoAgo(15 * DAY), conv);
  ok(nudgeKeys("stale").includes(`stale:${conv}`), "B2: stale fires at 15d on cadence 14");
}

// ---- B3: never (null) ----
{
  const c = mkContact("Gus", { cadence_days: null });
  const conv = mkConv([c]);
  mkMsg(conv, "in", 30 * DAY, "hey");
  ok(!nudgeKeys("stale").includes(`stale:${conv}`), "B3: no stale when cadence is never");
}

// ---- B4: stale refires after another full window ----
{
  const c = mkContact("Hal");
  const conv = mkConv([c]);
  mkMsg(conv, "in", 8 * DAY, "hey");
  const k = `stale:${conv}`;
  ok(nudgeKeys("stale").includes(k), "B4: first stale fires");
  ok(!nudgeKeys("stale").includes(k), "B4: no immediate refire");
  // Simulate 8 more days of silence: last fire 8d ago, last message 16d ago.
  db.query("UPDATE nudge_state SET last_fired_at = ? WHERE key = ?").run(Date.now() - 8 * DAY, k);
  db.query("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run(isoAgo(16 * DAY), conv);
  ok(nudgeKeys("stale").includes(k), "B4: refires after another full cadence window");
}

// ---- B5: group stale fixed at 7d ----
{
  const c1 = mkContact("Ivy");
  const c2 = mkContact("Jay");
  const conv = mkConv([c1, c2], true, "Weekend crew");
  mkMsg(conv, "in", 8 * DAY, "hey all");
  const ns = listNudges().filter((n) => n.key === `stale:${conv}`);
  ok(ns.length === 1 && /Weekend crew/.test(ns[0].title), "B5: group stale fires at 7d fixed, names the group");
}

// ---- B6: agent contacts excluded ----
{
  const c = mkContact("Milton", { kind: "agent" });
  const conv = mkConv([c]);
  mkMsg(conv, "out", 10 * DAY, "hey");
  const ks = nudgeKeys();
  ok(!ks.includes(`unanswered:${conv}`) && !ks.includes(`stale:${conv}`), "B6: agent 1:1 gets no cadence nudges");
}

// ---- C1: staged_followup fires at 2d with no outbound ----
{
  const s = mkStaged("Kim", 3 * DAY);
  const ns = listNudges().filter((n) => n.key === `followup:${s}`);
  ok(ns.length === 1, "C1: followup fires at 3d staged with no outbound");
  ok(/Kim/.test(ns[0].body), "C1: copy names them");
}

// ---- C2: silent if outbound exists ----
{
  const s = mkStaged("Lee", 3 * DAY);
  const t = stagedThread(s);
  db.query(`INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, message_id, participants, status, created_at)
    VALUES (?, ?, 'email', 'out', 'hi', '', '', '', '', '', ?)`).run(uid(), t, isoAgo(DAY));
  ok(!nudgeKeys("staged_followup").includes(`followup:${s}`), "C2: no followup once you've messaged them");
}

// ---- C3: refires 3d before expiry ----
{
  const s = mkStaged("Mo", 3 * DAY);
  const k = `followup:${s}`;
  ok(nudgeKeys("staged_followup").includes(k), "C3: first followup fires");
  ok(!nudgeKeys("staged_followup").includes(k), "C3: no immediate refire");
  // 12 days staged, 2 days left, last fire 4d ago -> refire window.
  db.query("UPDATE staged_contacts SET created_at = ?, expires_at = ? WHERE id = ?")
    .run(Date.now() - 12 * DAY, Date.now() + 2 * DAY, s);
  db.query("UPDATE nudge_state SET last_fired_at = ? WHERE key = ?").run(Date.now() - 4 * DAY, k);
  ok(nudgeKeys("staged_followup").includes(k), "C3: refires 3d before expiry");
}

// ---- D1: snooze suppresses for the duration ----
{
  const c = mkContact("Nia");
  const conv = mkConv([c]);
  mkMsg(conv, "in", 9 * DAY, "hey");
  const k = `stale:${conv}`;
  ok(nudgeKeys("stale").includes(k), "D1: stale fires before snooze");
  const st = snoozeNudge(k, 3);
  ok(st.snoozed_until > Date.now() + 2 * DAY, "D1: snoozed_until ~3d out");
  ok(!nudgeKeys("stale").includes(k), "D1: snoozed nudge suppressed");
  db.query("UPDATE nudge_state SET snoozed_until = ? WHERE key = ?").run(Date.now() - 1000, k);
  ok(nudgeKeys("stale").includes(k), "D1: fires again after snooze lapses");
}

// ---- D2: dismiss stale suppresses until next window, then fires ----
{
  const c = mkContact("Ola");
  const conv = mkConv([c]);
  mkMsg(conv, "in", 9 * DAY, "hey");
  const k = `stale:${conv}`;
  ok(nudgeKeys("stale").includes(k), "D2: stale fires before dismiss");
  const st = dismissNudge(k);
  ok(st.dismissed_until > Date.now() + 6 * DAY, "D2: dismissed_until ~next cadence window");
  ok(!nudgeKeys("stale").includes(k), "D2: dismissed nudge suppressed");
  db.query("UPDATE nudge_state SET dismissed_until = 0, last_fired_at = ? WHERE key = ?")
    .run(Date.now() - 8 * DAY, k);
  ok(nudgeKeys("stale").includes(k), "D2: fires again in the next window");
}

// ---- D3: dismiss unanswered suppresses the streak, new streak fires ----
{
  const c = mkContact("Pam");
  const conv = mkConv([c]);
  mkMsg(conv, "out", 18 * DAY, "hey");
  const k = `unanswered:${conv}`;
  ok(nudgeKeys("unanswered").includes(k), "D3: unanswered fires before dismiss");
  dismissNudge(k);
  ok(!nudgeKeys("unanswered").includes(k), "D3: dismissed for this streak");
  // Owner follows up again (still no reply) -> stays quiet: same streak.
  mkMsg(conv, "out", 4 * DAY, "bump");
  ok(!nudgeKeys("unanswered").includes(k), "D3: still quiet after owner follow-up");
  // They reply, owner writes back, silence again -> new streak fires.
  // (Simulate the dismiss as 14d old so the reply at 12d is genuinely newer.)
  db.query("UPDATE nudge_state SET last_fired_at = ? WHERE key = ?").run(Date.now() - 14 * DAY, k);
  mkMsg(conv, "in", 12 * DAY, "sorry!");
  mkMsg(conv, "out", 12 * DAY - 3600_000, "np");
  ok(nudgeKeys("unanswered").includes(k), "D3: new streak after reply fires");
}

// ---- D4: snooze validation ----
{
  let threw = false;
  try { snoozeNudge("stale:nope", 99); } catch { threw = true; }
  ok(threw, "D4: snooze >30d rejected");
  threw = false;
  try { snoozeNudge("bogus-key", 3); } catch { threw = true; }
  ok(threw, "D4: malformed key rejected");
  threw = false;
  try { dismissNudge("stale:does-not-exist"); } catch { threw = true; }
  ok(threw, "D4: dismiss of unknown conversation -> not found");
}

// ---- B7: unanswered and stale don't double-nudge the same thread ----
{
  const c = mkContact("Quinn");
  const conv = mkConv([c]);
  mkMsg(conv, "out", 10 * DAY, "hey");
  const ks = nudgeKeys();
  ok(ks.includes(`unanswered:${conv}`), "B7: unanswered fires");
  ok(!ks.includes(`stale:${conv}`), "B7: stale stays quiet while unanswered fires (no piling up)");
}

console.log(`\ndb-level: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// ================= Part E: server routes =================
{
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { execSync, spawn } = await import("node:child_process");
  const { Database } = await import("bun:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "relay-nudges-srv-"));
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({}));
  const port = 4700 + Math.floor(Math.random() * 600);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + "/api/status"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const get = async (p: string) => {
      const r = await fetch(base + p);
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    const post = async (p: string, b?: any) => {
      const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };
    const patch = async (p: string, b: any) => {
      const r = await fetch(base + p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    };

    // E1: empty shape
    let r = await get("/api/nudges");
    ok(r.status === 200 && Array.isArray(r.json.nudges) && r.json.nudges.length === 0, "E1: GET /api/nudges -> {nudges: []}");

    // E2: cadence_days on create + patch, invalid -> 400
    r = await post("/api/contacts", { name: "Rae", cadence_days: 14 });
    ok(r.status === 201 && r.json.contact.cadence_days === 14, "E2: POST accepts cadence_days=14");
    const raeId = r.json.contact.id;
    r = await patch(`/api/contacts/${raeId}`, { cadence_days: null });
    ok(r.status === 200 && r.json.contact.cadence_days === null, "E2: PATCH cadence_days=null (never)");
    r = await patch(`/api/contacts/${raeId}`, { cadence_days: 5 });
    ok(r.status === 400, "E2: PATCH cadence_days=5 -> 400");
    r = await patch(`/api/contacts/${raeId}`, { cadence_days: 30 });
    ok(r.status === 200 && r.json.contact.cadence_days === 30, "E2: PATCH cadence_days=30");
    r = await post("/api/contacts", { name: "Rae2", cadence_days: 5 });
    ok(r.status === 400, "E2: POST cadence_days=5 -> 400");

    // E3: bogus keys -> 404, bad snooze window -> 400
    r = await post("/api/nudges/stale:nope/snooze", { days: 3 });
    ok(r.status === 404, "E3: snooze unknown key -> 404");
    r = await post("/api/nudges/bogus/snooze", { days: 3 });
    ok(r.status === 404, "E3: snooze malformed key -> 404");
    r = await post("/api/nudges/unanswered:nope/dismiss");
    ok(r.status === 404, "E3: dismiss unknown key -> 404");

    // E4: end-to-end stale nudge via API (seeded straight into the server's DB)
    const sdb = new Database(join(dir, "data", "relay.db"));
    const cid = "t-c-" + Date.now(), conv = "t-v-" + Date.now();
    sdb.query(`INSERT INTO contacts (id, name, email, gv_number, matrix_id, matrix_room_id, color, notes, photo, kind, agent_url, agent_secret, archived, cadence_days, created_at)
      VALUES (?, 'Zed', '', '', '', '', '', '', '', 'person', '', '', 0, 7, ?)`)
      .run(cid, new Date().toISOString());
    sdb.query(`INSERT INTO conversations (id, name, is_group, matrix_room_id, last_read_at, archived, created_at) VALUES (?, '', 0, '', '', 0, ?)`)
      .run(conv, new Date().toISOString());
    sdb.query(`INSERT INTO members (conversation_id, contact_id) VALUES (?, ?)`).run(conv, cid);
    sdb.query(`INSERT INTO messages (id, conversation_id, channel, direction, body, subject, external_id, message_id, participants, status, created_at)
      VALUES (?, ?, 'email', 'in', 'hey', '', '', '', '', '', ?)`)
      .run("t-m-" + Date.now(), conv, new Date(Date.now() - 9 * DAY).toISOString());
    sdb.close();

    r = await get("/api/nudges");
    const n = r.json.nudges.find((x: any) => x.key === `stale:${conv}`);
    ok(!!n && n.type === "stale" && n.conversation_id === conv, "E4: seeded stale nudge appears via API");
    ok(typeof n.title === "string" && typeof n.body === "string" && typeof n.days === "number"
      && n.staged_id === "" && /Quiet with Zed/.test(n.title), "E4: nudge shape + warm copy");
    r = await post(`/api/nudges/${encodeURIComponent(`stale:${conv}`)}/snooze`, { days: 3 });
    ok(r.status === 200 && r.json.ok === true, "E4: snooze -> 200");
    r = await get("/api/nudges");
    ok(!r.json.nudges.some((x: any) => x.key === `stale:${conv}`), "E4: snoozed nudge omitted from GET");

    // E5: staged followup via API; dismiss omits it
    const sdb2 = new Database(join(dir, "data", "relay.db"));
    const sid = "t-s-" + Date.now();
    const t = Date.now() - 3 * DAY;
    sdb2.query(`INSERT INTO staged_contacts (id, name, channel, handle, met_at, met_where, met_about, notes, expires_at, extended, status, replied, created_at)
      VALUES (?, 'Yara', 'email', 'yara@x.com', ?, '', '', '', ?, 0, 'staged', 0, ?)`)
      .run(sid, t, t + 14 * DAY, t);
    sdb2.close();
    r = await get("/api/nudges");
    const f = r.json.nudges.find((x: any) => x.key === `followup:${sid}`);
    ok(!!f && f.type === "staged_followup" && f.staged_id === sid, "E5: staged_followup appears via API");
    r = await post(`/api/nudges/${encodeURIComponent(`followup:${sid}`)}/dismiss`);
    ok(r.status === 200 && r.json.ok === true, "E5: dismiss staged followup -> 200");
    r = await get("/api/nudges");
    ok(!r.json.nudges.some((x: any) => x.key === `followup:${sid}`), "E5: dismissed followup omitted");
  } finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nALL: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
