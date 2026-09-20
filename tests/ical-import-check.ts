// Calendar feed (iCal secret address) sync checks:
//  1. unit: ATTENDEE/STATUS/RRULE parsing, recurrence expansion (+ cap)
//  2. unit: contact matching incl. the no-conversation case (temp DB)
//  3. live server: settings secret handling, feed fetch success/failure modes,
//     sync preview, confirm-gated import, dedupe across syncs
// Run: bun tests/ical-import-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIcs, expandRecurrence, MAX_RRULE_OCCURRENCES } from "../src/ical";

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", msg); }
}

// ---------- 1. parser + recurrence unit ----------
{
  const evs = parseIcs([
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:a@t", "DTSTAMP:20260920T000000Z",
    "DTSTART:20260922T170000Z", "DTEND:20260922T180000Z",
    "SUMMARY:Lunch",
    'ATTENDEE;CN="Doe, Jane":mailto:jane@example.com',
    "ATTENDEE:mailto:plain@example.com",
    "STATUS:CANCELLED",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n"));
  ok(evs.length === 1, "parseIcs finds the event");
  const ev = evs[0];
  ok(ev.attendees.length === 2, "parseIcs captures both ATTENDEEs");
  ok(ev.attendees[0].email === "jane@example.com" && ev.attendees[0].cn === "Doe, Jane",
    "parseIcs unquotes the CN param");
  ok(ev.attendees[1].email === "plain@example.com" && ev.attendees[1].cn === "",
    "parseIcs handles ATTENDEE without CN");
  ok(ev.status === "CANCELLED", "parseIcs captures STATUS");
  ok(ev.rrule === "FREQ=DAILY;COUNT=3", "parseIcs captures RRULE");
  ok(ev.allDay === false, "timed event is not all-day");

  const allDay = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b@t\r\nDTSTART:20260922\r\nSUMMARY:X\r\nEND:VEVENT\r\nEND:VCALENDAR");
  ok(allDay.length === 1 && allDay[0].allDay === true, "bare-date DTSTART marks all-day");

  // Recurrence expansion.
  const daily = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=DAILY;COUNT=3");
  ok(daily.length === 3, "DAILY COUNT=3 expands to 3");
  ok(daily[0].start === "2026-09-22T17:00:00.000Z" && daily[2].start === "2026-09-24T17:00:00.000Z",
    "DAILY occurrences step one day");
  ok(daily[1].end === "2026-09-23T18:00:00.000Z", "expanded occurrences keep the duration");

  const weekly = expandRecurrence("2026-09-21T13:00:00.000Z", "2026-09-21T13:15:00.000Z", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4");
  ok(weekly.length === 4, "WEEKLY BYDAY MO,WE COUNT=4 expands to 4");
  ok(weekly.map((o) => o.start.slice(0, 10)).join(",") === "2026-09-21,2026-09-23,2026-09-28,2026-09-30",
    "WEEKLY BYDAY lands on the right weekdays");

  const until = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=DAILY;UNTIL=20260924T170000Z");
  ok(until.length === 3, "DAILY UNTIL bounds the expansion");

  const interval = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=DAILY;INTERVAL=2;COUNT=2");
  ok(interval.length === 2 && interval[1].start === "2026-09-24T17:00:00.000Z", "DAILY INTERVAL=2 steps two days");

  const unbounded = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=DAILY");
  ok(unbounded.length === 1, "unbounded DAILY yields the base occurrence only");

  const capped = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=DAILY;COUNT=500");
  ok(capped.length === MAX_RRULE_OCCURRENCES, "expansion is capped");

  const monthly = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=MONTHLY;COUNT=3");
  ok(monthly.length === 1, "unsupported FREQ yields the base occurrence");

  const garbage = expandRecurrence("2026-09-22T17:00:00.000Z", "2026-09-22T18:00:00.000Z", "FREQ=DAILY;COUNT=bogus");
  ok(garbage.length === 1, "malformed RRULE yields the base occurrence");
}

// ---------- 2. matching unit (temp DB, no server) ----------
{
  const dir = mkdtempSync(join(tmpdir(), "relay-calfeed-"));
  const db = await import("../src/db.ts");
  const { previewFromFeedText, matchContacts } = await import("../src/calfeed.ts");
  db.openDb(join(dir, "relay.db"));
  const pal = db.createContact({ name: "Cal Pal", email: "pal@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "#0a84ff", notes: "" });
  const loner = db.createContact({ name: "Lonely Lou", email: "lou@example.com", gv_number: "", matrix_id: "", matrix_room_id: "", color: "#0a84ff", notes: "" });
  // NOTE: created directly in the DB — no dmFor, so these contacts have NO conversation.

  const evs = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m@t\r\nDTSTART:20260922T170000Z\r\nDTEND:20260922T180000Z\r\nSUMMARY:Lunch\r\nATTENDEE;CN=Cal Pal:mailto:pal@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR");
  const ms = matchContacts(evs[0]);
  ok(ms.length === 1 && ms[0].contact_id === pal.id && ms[0].confidence === "email",
    "attendee email matches the contact with email confidence");
  ok(ms[0].conversation_id === "", "no conversation exists for a contact without a DM");

  const mention = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:n@t\r\nDTSTART:20260922T170000Z\r\nSUMMARY:Dinner with Lonely Lou\r\nEND:VEVENT\r\nEND:VCALENDAR");
  const ms2 = matchContacts(mention[0]);
  ok(ms2.length === 1 && ms2[0].confidence === "mention", "name in the summary matches with mention confidence");

  const prev = previewFromFeedText("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m@t\r\nDTSTART:20260922T170000Z\r\nDTEND:20260922T180000Z\r\nSUMMARY:Lunch\r\nATTENDEE:mailto:pal@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR");
  ok(prev.length === 1 && prev[0].key === "m@t::2026-09-22T17:00:00.000Z",
    "dedupe key is uid + occurrence start");
  ok(prev[0].import_conversation_id === "", "preview targets no conversation when none exists");

  let threw = "";
  try { previewFromFeedText("definitely not a calendar"); } catch (e: any) { threw = e.message; }
  ok(/no calendar events/i.test(threw), "empty parse throws a friendly error");

  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 3. live server ----------
const FEED = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
  "BEGIN:VEVENT", "UID:lunch1@test", "DTSTAMP:20260920T000000Z",
  "DTSTART:20260922T170000Z", "DTEND:20260922T180000Z",
  "SUMMARY:Lunch with Cal Pal",
  'ATTENDEE;CN="Cal Pal":mailto:pal@example.com',
  "LOCATION:Main St Café", "DESCRIPTION:Quarterly catch-up",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:call1@test", "DTSTAMP:20260920T000000Z",
  "DTSTART:20260923T140000Z", "DTEND:20260923T143000Z",
  "SUMMARY:Call Dana about the contract",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:dental1@test", "DTSTAMP:20260920T000000Z",
  "DTSTART:20260924T090000Z", "DTEND:20260924T100000Z",
  "SUMMARY:Dentist appointment",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:old1@test", "DTSTAMP:20260920T000000Z",
  "DTSTART:20260910T100000Z", "DTEND:20260910T110000Z",
  "SUMMARY:Old sync with Cal Pal",
  "ATTENDEE:mailto:pal@example.com",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:standup1@test", "DTSTAMP:20260920T000000Z",
  "DTSTART:20260921T130000Z", "DTEND:20260921T131500Z",
  "SUMMARY:Standup",
  "ATTENDEE;CN=Cal Pal:mailto:pal@example.com",
  "RRULE:FREQ=DAILY;COUNT=2",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:tallinn1@test", "DTSTAMP:20260920T000000Z",
  "DTSTART;TZID=America/New_York:20260925T090000",
  "DTEND;TZID=America/New_York:20260925T100000",
  "SUMMARY:Flight to Tallinn",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

async function startFeedStub(): Promise<{ port: number; close: () => void }> {
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    const u = req.url || "/";
    if (u === "/feed.ics") { res.writeHead(200, { "Content-Type": "text/calendar" }); res.end(FEED); }
    else if (u === "/r404") { res.writeHead(404); res.end("nope"); }
    else if (u === "/garbage") { res.writeHead(200); res.end("this is not a calendar"); }
    else if (u === "/redir") { res.writeHead(302, { Location: "/feed.ics" }); res.end(); }
    else if (u === "/redir-evil") { res.writeHead(302, { Location: "https://127.0.0.1:1/feed.ics" }); res.end(); }
    else if (u === "/slow") { setTimeout(() => { try { res.writeHead(200); res.end(FEED); } catch { /* gone */ } }, 20000); }
    else if (u === "/big") {
      res.writeHead(200, { "Content-Type": "text/calendar" });
      res.end("BEGIN:VCALENDAR\r\n" + "X-PAD:" + "x".repeat(6 * 1024 * 1024) + "\r\nEND:VCALENDAR\r\n");
    }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  return { port, close: () => srv.close() };
}

{
  const stub = await startFeedStub();
  const feedUrl = `http://127.0.0.1:${stub.port}/feed.ics`;
  const dir = mkdtempSync(join(tmpdir(), "relay-calapi-"));
  const { execSync, spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  execSync(`ln -s ${process.cwd()}/public ${dir}/public && ln -s ${process.cwd()}/src ${dir}/src`);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", "config.json"), JSON.stringify({ calendar: { feedUrl, lastSyncAt: "" } }));
  const port = 4600 + Math.floor(Math.random() * 700);
  const srv = spawn("bun", ["src/server.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, json: await r.json().catch(() => ({})), text: await r.text().catch(() => "") };
  };
  // NOTE: get() consumes the body twice above — fetch again for text when needed.
  const getRaw = async (p: string) => {
    const r = await fetch(base + p);
    return { status: r.status, text: await r.text() };
  };
  const post = async (p: string, body: any) => {
    const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(base + "/api/conversations"); if (r.ok) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error("server did not start");
    }

    // Settings redaction.
    const sraw = await getRaw("/api/settings");
    ok(sraw.status === 200, "GET /api/settings works");
    ok(!sraw.text.includes("feed.ics") && !sraw.text.includes("feedUrl"),
      "the feed URL never appears in GET /api/settings");
    const s = JSON.parse(sraw.text);
    ok(s.calendar && s.calendar.configured === true && s.calendar.lastSyncAt === "",
      "settings reports the feed as configured, never synced");

    // Contacts (creating them also creates their 1:1 conversations).
    const pal = await post("/api/contacts", { name: "Cal Pal", email: "pal@example.com" });
    const dana = await post("/api/contacts", { name: "Dana", email: "" });
    ok(pal.status === 201 && dana.status === 201, "test contacts created");

    // Sync -> preview.
    const sync = await post("/api/calendar/sync", {});
    ok(sync.status === 200, "POST /api/calendar/sync succeeds");
    const events = sync.json.events || [];
    ok(events.length === 7, `preview has 7 rows (6 events, standup x2), got ${events.length}`);
    const lunch = events.find((e: any) => e.uid === "lunch1@test");
    ok(lunch && lunch.matches.length === 1 && lunch.matches[0].confidence === "email" &&
      lunch.matches[0].name === "Cal Pal" && !!lunch.import_conversation_id,
      "lunch matches Cal Pal by email and targets his conversation");
    ok(lunch.location === "Main St Café" && lunch.description === "Quarterly catch-up",
      "preview carries location + description");
    const call = events.find((e: any) => e.uid === "call1@test");
    ok(call && call.matches.length === 1 && call.matches[0].confidence === "mention",
      "call matches Dana by name mention");
    const dental = events.find((e: any) => e.uid === "dental1@test");
    ok(dental && dental.matches.length === 0 && dental.import_conversation_id === "",
      "dentist matches nobody and targets no conversation");
    const old = events.find((e: any) => e.uid === "old1@test");
    ok(old && old.cancelled === true, "cancelled event is flagged");
    const standups = events.filter((e: any) => e.uid === "standup1@test");
    ok(standups.length === 2 && standups[0].recurring && standups[0].recurring.index === 1 &&
      standups[0].recurring.total === 2 && standups[1].recurring.index === 2,
      "recurring standup expands to two indexed rows");
    ok(standups[0].key !== standups[1].key, "occurrences have distinct dedupe keys");
    const tlln = events.find((e: any) => e.uid === "tallinn1@test");
    ok(tlln && tlln.start === "2026-09-25T13:00:00.000Z",
      `TZID wall time resolves to UTC (${tlln && tlln.start})`);
    ok(events.every((e: any) => e.already_imported === false), "nothing is imported yet");

    // Nothing written by the sync itself.
    const convs = await get("/api/conversations");
    const palConv = (convs.json.conversations || []).find((c: any) =>
      (c.members || []).some((m: any) => m.name === "Cal Pal"));
    const apptsBefore = await get(`/api/conversations/${palConv.id}/appointments`);
    ok((apptsBefore.json.appointments || []).length === 0, "sync writes nothing — preview only");

    // Confirm -> import.
    const items = [lunch, ...standups].map((e: any) => ({
      key: e.key, uid: e.uid, summary: e.summary, start: e.start, end: e.end,
      location: e.location, description: e.description, organizer: e.organizer,
      conversation_id: e.import_conversation_id, cancelled: e.cancelled,
    }));
    const imp = await post("/api/calendar/import", { items });
    ok(imp.status === 200 && imp.json.imported === 3 && imp.json.skipped === 0,
      `import writes the 3 selected rows (got ${imp.json.imported}/${imp.json.skipped})`);
    const apptsAfter = await get(`/api/conversations/${palConv.id}/appointments`);
    const appts = apptsAfter.json.appointments || [];
    ok(appts.length === 3, "3 diary entries land in the conversation");
    ok(appts.every((a: any) => a.status === "planned"), "imported entries are planned");
    ok(appts.some((a: any) => a.uid === "lunch1@test::2026-09-22T17:00:00.000Z"),
      "appointment uid is the dedupe key");
    ok(appts.some((a: any) => a.title === "Lunch with Cal Pal" && a.location === "Main St Café"),
      "entry keeps title + location");

    // Dedupe across syncs: preview now flags them, re-import skips.
    const sync2 = await post("/api/calendar/sync", {});
    const lunch2 = (sync2.json.events || []).find((e: any) => e.uid === "lunch1@test");
    ok(lunch2 && lunch2.already_imported === true, "re-sync flags already-imported rows");
    const imp2 = await post("/api/calendar/import", { items });
    ok(imp2.json.imported === 0 && imp2.json.skipped === 3 &&
      (imp2.json.results || []).every((r: any) => r.status === "already_imported"),
      "re-importing the same rows skips them all as already_imported");

    // Per-item skip reasons.
    const danaItem = { key: call!.key, uid: call!.uid, summary: call!.summary, start: call!.start, end: call!.end, conversation_id: call!.import_conversation_id, cancelled: false };
    const imp3 = await post("/api/calendar/import", { items: [danaItem] });
    ok(imp3.json.imported === 1, "mention-matched event imports into the contact's conversation");
    const skipCases = await post("/api/calendar/import", {
      items: [
        { key: dental!.key, uid: dental!.uid, summary: dental!.summary, start: dental!.start, end: dental!.end, conversation_id: "", cancelled: false },
        { key: "bogus::x", uid: "bogus", summary: "", start: "nope", end: "", conversation_id: "nope", cancelled: false },
        { key: old!.key, uid: old!.uid, summary: old!.summary, start: old!.start, end: old!.end, conversation_id: lunch!.import_conversation_id, cancelled: true },
        { key: "ghost::2026-09-22T17:00:00.000Z", uid: "ghost", summary: "Ghost", start: "2026-09-22T17:00:00.000Z", end: "2026-09-22T18:00:00.000Z", conversation_id: "does-not-exist", cancelled: false },
      ],
    });
    const st = Object.fromEntries((skipCases.json.results || []).map((r: any) => [r.key, r.status]));
    ok(st[dental!.key] === "no_conversation", "event with no conversation is skipped");
    ok(st["bogus::x"] === "invalid", "malformed item is skipped");
    ok(st[old!.key] === "cancelled", "cancelled event is skipped");
    ok(st["ghost::2026-09-22T17:00:00.000Z"] === "no_conversation", "unknown conversation is skipped");
    ok(skipCases.json.imported === 0 && skipCases.json.skipped === 4, "skip summary counts add up");

    // Endpoint validation.
    ok((await post("/api/calendar/import", { items: [] })).status === 400, "empty import is 400");
    ok((await post("/api/calendar/import", {})).status === 400, "missing items is 400");

    // lastSyncAt is stamped.
    const s2 = JSON.parse((await getRaw("/api/settings")).text);
    ok(!!s2.calendar.lastSyncAt, "lastSyncAt is recorded after a sync");

    // Feed failure modes.
    const setFeed = (u: string) => post("/api/settings", { section: "calendar", values: { feedUrl: u } });
    ok((await setFeed(`http://127.0.0.1:${stub.port}/r404`)).status === 200, "feed URL can be changed");
    const e404 = await post("/api/calendar/sync", {});
    ok(e404.status === 502 && /404/.test(e404.json.error || ""), "HTTP 404 surfaces as a 502 with the status");
    await setFeed(`http://127.0.0.1:${stub.port}/garbage`);
    const egb = await post("/api/calendar/sync", {});
    ok(egb.status === 400 && /no calendar events/i.test(egb.json.error || ""), "malformed feed is a clear 400");
    await setFeed(`http://127.0.0.1:${stub.port}/redir`);
    ok((await post("/api/calendar/sync", {})).status === 200, "same-scheme redirect is followed");
    await setFeed(`http://127.0.0.1:${stub.port}/redir-evil`);
    const eevil = await post("/api/calendar/sync", {});
    ok(eevil.status === 502 && /scheme/i.test(eevil.json.error || ""), "cross-scheme redirect is refused");
    await setFeed(`http://127.0.0.1:${stub.port}/big`);
    const ebig = await post("/api/calendar/sync", {});
    ok(ebig.status === 502 && /too large/i.test(ebig.json.error || ""), "oversize feed is rejected");
    await setFeed(`http://127.0.0.1:${stub.port}/slow`);
    const eslow = await post("/api/calendar/sync", {});
    ok(eslow.status === 502 && /too long/i.test(eslow.json.error || ""), "slow feed hits the 15s timeout");
    await setFeed("ftp://example.com/cal.ics");
    const eft = await post("/api/calendar/sync", {});
    ok(eft.status === 502 && /http\(s\)/i.test(eft.json.error || ""), "non-http(s) URL is rejected");

    // __KEEP__ preserves the secret; blank clears it.
    await setFeed(feedUrl);
    await post("/api/settings", { section: "calendar", values: { feedUrl: "__KEEP__" } });
    ok((await post("/api/calendar/sync", {})).status === 200, "__KEEP__ keeps the saved URL");
    await post("/api/settings", { section: "calendar", values: { feedUrl: "" } });
    const s3 = JSON.parse((await getRaw("/api/settings")).text);
    ok(s3.calendar.configured === false, "blank clears the feed URL");
    const enone = await post("/api/calendar/sync", {});
    ok(enone.status === 400 && /settings first/i.test(enone.json.error || ""),
      "sync without a URL tells the user to visit Settings");
  } finally {
    srv.kill();
    stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
