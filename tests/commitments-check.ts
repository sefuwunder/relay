// Commitments tracker + decision log checks:
//  1. commitment CRUD, status transitions, validation
//  2. decision CRUD
//  3. due query + nudge cadence (local calendar days)
//  4. JSON/CSV export
//  5. deterministic suggestion heuristics
//  6. adaptive learning loop: signatures, scoring, feedback, scope, decay
//  7. suggestion confirm/dismiss, 7-day expiry, conversation cascade
// Run: bun tests/commitments-check.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, getDb, insertMessage, deleteConversationData, type Message } from "../src/db";
import {
  localDay, createCommitment, getCommitment, listCommitments, patchCommitment,
  deleteCommitment, listDueCommitments, recordNudge, listAllCommitments,
  createDecision, getDecision, listDecisions, patchDecision, deleteDecision, listAllDecisions,
  createSuggestion, getSuggestion, listSuggestions, confirmSuggestion, dismissSuggestion,
  sweepExpiredSuggestions, trackMessage, recordFeedback, teachFromManual,
  analyzeMessage, deriveSignature, patternScore, stripQuotes, extractDue, exportJson, exportCsv,
} from "../src/commitments";

const dir = mkdtempSync(join(tmpdir(), "relay-commit-"));
openDb(join(dir, "test.db"));

let pass = 0, fail = 0;
function ok(cond: any, msg: string) {
  if (cond) { pass++; } else { fail++; console.error("FAIL:", msg); }
}
function throws(fn: () => any, msg: string) {
  try { fn(); } catch { pass++; return; }
  fail++; console.error("FAIL (no throw):", msg);
}

// ---------- fixtures ----------
let n = 0;
const nid = (p: string) => `${p}-${++n}-${Date.now().toString(36)}`;
function mkConv(id: string, name = "", is_group = 0) {
  getDb().query(
    "INSERT INTO conversations (id, name, is_group, matrix_room_id, last_read_at, created_at) VALUES (?, ?, ?, '', '', ?)"
  ).run(id, name, is_group, new Date().toISOString());
}
function mkContact(id: string, name: string) {
  getDb().query(
    "INSERT INTO contacts (id, name, email, gv_number, matrix_id, matrix_room_id, color, notes, photo, archived, created_at) VALUES (?, ?, '', '', '', '', '', '', '', 0, ?)"
  ).run(id, name, new Date().toISOString());
}
function mkMember(convId: string, contactId: string) {
  getDb().query("INSERT OR IGNORE INTO members (conversation_id, contact_id) VALUES (?, ?)").run(convId, contactId);
}
function mkMsg(convId: string, body: string, direction: "in" | "out" = "out"): Message {
  return insertMessage({
    conversation_id: convId, channel: "email", direction, body, subject: "",
    external_id: nid("ext"), status: "",
  });
}
const ctxFor = (conversationId: string, memberCount = 1, recent: { direction: string; body: string; created_at: string }[] = []) => ({
  conversationId, conversationName: "Shy", direction: "out" as const,
  memberNames: ["Shy"], memberCount, recentMessages: recent,
});

// ---------- A. localDay ----------
{
  ok(/^\d{4}-\d{2}-\d{2}$/.test(localDay()), "localDay format YYYY-MM-DD");
  const d = new Date(); d.setDate(d.getDate() + 1);
  const p = (x: number) => String(x).padStart(2, "0");
  ok(localDay(1) === `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, "localDay(+1) is tomorrow locally");
}

// ---------- B. commitment CRUD ----------
const convA = nid("convA"); mkConv(convA);
const convB = nid("convB"); mkConv(convB);
{
  const c = createCommitment({ conversation_id: convA, text: "  Send the report  " });
  ok(c.status === "open" && c.source === "manual" && c.owner === "me", "defaults: open/manual/me");
  ok(c.text === "Send the report", "text trimmed");
  ok(c.due_date === "" && c.due_time === "" && c.last_nudged_at === "", "undated by default");
  const full = createCommitment({
    conversation_id: convA, message_id: "m1", text: "Call Shy", owner: "me",
    due_date: localDay(1), due_time: "15:00",
  });
  ok(full.due_date === localDay(1) && full.due_time === "15:00" && full.message_id === "m1", "due date/time stored");
  throws(() => createCommitment({ conversation_id: convA, text: "   " }), "empty text throws");
  throws(() => createCommitment({ conversation_id: convA, text: "x".repeat(5), due_date: "tomorrow" }), "bad due_date throws");
  throws(() => createCommitment({ conversation_id: convA, text: "x".repeat(5), due_time: "3pm" }), "bad due_time throws");
  ok(getCommitment(c.id)!.text === "Send the report", "get round-trip");
  ok(getCommitment("nope") === null, "get missing -> null");
  createCommitment({ conversation_id: convB, text: "Other conversation item" });
  ok(listCommitments(convA).length === 2, "list scoped to conversation");
  ok(listCommitments(convA, "report").length === 1, "list q search");
  ok(listCommitments(convA, "", "open").length === 2, "list status filter");
  // patch
  const p1 = patchCommitment(c.id, { text: "Send the final report", owner: "contact-9" })!;
  ok(p1.text === "Send the final report" && p1.owner === "contact-9", "patch text/owner");
  throws(() => patchCommitment(c.id, { text: "  " }), "patch empty text throws");
  throws(() => patchCommitment(c.id, { due_date: "soon" }), "patch bad due_date throws");
  // due-date change resets the nudge stamp so the new date nudges
  recordNudge(c.id);
  ok(getCommitment(c.id)!.last_nudged_at !== "", "nudge stamp set");
  patchCommitment(c.id, { due_date: localDay(2) });
  ok(getCommitment(c.id)!.last_nudged_at === "", "due change clears nudge stamp");
  // transitions
  ok(patchCommitment(c.id, { status: "done" })!.status === "done", "open -> done");
  ok(patchCommitment(c.id, { status: "open" })!.status === "open", "done -> open");
  ok(patchCommitment(c.id, { status: "dismissed" })!.status === "dismissed", "open -> dismissed");
  ok(patchCommitment(c.id, { status: "open" })!.status === "open", "dismissed -> open");
  patchCommitment(c.id, { status: "done" });
  throws(() => patchCommitment(c.id, { status: "dismissed" }), "done -> dismissed rejected");
  ok(patchCommitment("nope", { status: "done" }) === null, "patch missing -> null");
  // delete
  const delId = createCommitment({ conversation_id: convA, text: "temporary" }).id;
  ok(deleteCommitment(delId) === true, "delete -> true");
  ok(deleteCommitment(delId) === false, "delete again -> false");
  ok(getCommitment(delId) === null, "deleted gone");
}

// ---------- C. decisions ----------
{
  const d = createDecision({ conversation_id: convA, text: "Going with the oak finish" });
  ok(JSON.parse(d.participants).join() === "me", "participants default [me]");
  ok(d.decided_at !== "" && d.source === "manual", "decided_at + source set");
  createDecision({ conversation_id: convA, text: "Second decision", participants: ["me", "c1", "c1"] });
  const list = listDecisions(convA);
  ok(list.length === 2 && list[0].text === "Second decision", "decisions newest-first");
  ok(listDecisions(convB).length === 0, "decisions scoped to conversation");
  ok(listDecisions(convA, "oak").length === 1, "decision q search");
  const p = patchDecision(d.id, { text: "Going with walnut", participants: ["me", "c2", "c2"] })!;
  ok(p.text === "Going with walnut" && JSON.parse(p.participants).join() === "me,c2", "patch text + dedupe participants");
  throws(() => patchDecision(d.id, { text: " " }), "decision empty text throws");
  ok(getDecision("nope") === null, "getDecision missing -> null");
  ok(deleteDecision(d.id) === true && deleteDecision(d.id) === false, "deleteDecision true then false");
}

// ---------- D. due + nudge cadence ----------
{
  const conv = nid("convD"); mkConv(conv);
  const over = createCommitment({ conversation_id: conv, text: "overdue", due_date: localDay(-1) });
  const today = createCommitment({ conversation_id: conv, text: "today", due_date: localDay(0) });
  createCommitment({ conversation_id: conv, text: "tomorrow", due_date: localDay(1) });
  createCommitment({ conversation_id: conv, text: "undated" });
  const done = createCommitment({ conversation_id: conv, text: "done-today", due_date: localDay(0) });
  patchCommitment(done.id, { status: "done" });
  const due = listDueCommitments().map((c) => c.id);
  ok(due.includes(over.id) && due.includes(today.id), "due: overdue + today included");
  ok(due.length === 2, "due: tomorrow/undated/done excluded");
  recordNudge(today.id);
  ok(!listDueCommitments().some((c) => c.id === today.id), "nudged today -> not due again");
  // A nudge from a previous local day doesn't suppress today's.
  getDb().query("UPDATE commitments SET last_nudged_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 86400_000).toISOString(), over.id);
  recordNudge(over.id); // stamps today
  ok(!listDueCommitments().some((c) => c.id === over.id), "second nudge same day suppressed");
  getDb().query("UPDATE commitments SET last_nudged_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 86400_000).toISOString(), today.id);
  ok(listDueCommitments().some((c) => c.id === today.id), "yesterday's nudge -> due again today");
}

// ---------- E. export ----------
{
  const tricky = createCommitment({ conversation_id: convA, text: 'Say "hi", then go' });
  const j = exportJson();
  ok(typeof j.exported_at === "string" && Array.isArray(j.commitments) && Array.isArray(j.decisions), "exportJson shape");
  ok(Array.isArray(j.language_patterns), "exportJson includes language_patterns");
  ok(!("body" in (j.language_patterns[0] || {})), "exported patterns carry no raw message text");
  const csv = exportCsv("commitments");
  const lines = csv.trim().split("\n");
  ok(lines[0] === "id,conversation_id,message_id,text,owner,due_date,due_time,status,source,last_nudged_at,created_at", "commitments CSV header");
  ok(lines.length - 1 === j.commitments.length, "commitments CSV row count matches");
  ok(csv.includes('"Say ""hi"", then go"'), "CSV quotes commas and quotes");
  ok(csv.endsWith("\n"), "CSV ends with newline");
  const dcsv = exportCsv("decisions");
  ok(dcsv.split("\n")[0] === "id,conversation_id,message_id,text,participants,decided_at,source,created_at", "decisions CSV header");
  deleteCommitment(tricky.id);
}

// ---------- F. heuristics ----------
{
  const ctx = ctxFor(convA);
  const a = analyzeMessage("I'll send the contract tomorrow", ctx)!;
  ok(a && a.class === "commitment", "commitment verb fires");
  ok(a.due_date === localDay(1), "due date = tomorrow (local)");
  ok(a.due_time === "", "no explicit time -> no due_time");
  ok(a.reason.includes("i'll send"), "reason names the matched phrasing");
  const b = analyzeMessage("I'll call you at 3pm", ctx)!;
  ok(b && b.due_time === "15:00", "explicit time extracted, never guessed");
  const c = analyzeMessage("I'll send it sometime", ctx);
  ok(c === null || c.due_date === "", "vague 'sometime' -> no due date");
  ok(analyzeMessage("The contract is attached", ctx) === null, "no verb -> no suggestion");
  ok(analyzeMessage("https://example.com/report.pdf", ctx) === null, "URL-only excluded");
  ok(analyzeMessage("ok", ctx) === null, "too short excluded");
  ok(analyzeMessage("Can you send the report?", ctx) === null, "bare question excluded");
  ok(analyzeMessage("Let me know what you think", ctx) === null, "weak verb alone doesn't fire");
  const weak = analyzeMessage("Let me send it tomorrow", ctx);
  ok(weak && weak.class === "commitment", "weak verb + date fires");
  ok(analyzeMessage("> I'll send the contract tomorrow\n\nSounds good", ctx) === null, "quote-reply stripped before analysis");
  ok(analyzeMessage("> I'll handle the catering", ctx) === null, "quote-only message excluded");
  ok(stripQuotes("> hi\nreal line").trim() === "real line", "stripQuotes keeps real lines");
  // decisions: conservative
  const grp = ctxFor(convA, 2);
  const d1 = analyzeMessage("It's decided, we're going with the oak finish", grp);
  ok(d1 && d1.class === "decision" && d1.due_date === "", "decision phrase fires in group");
  ok(analyzeMessage("It's decided, we're going with oak", ctxFor(convA, 1)) === null, "decision in 1-1 without agreement -> null");
  const agreed = analyzeMessage("It's decided, we're going with oak",
    ctxFor(convA, 1, [{ direction: "in", body: "sounds good, do it", created_at: new Date().toISOString() }]));
  ok(agreed && agreed.class === "decision", "agreement reply unlocks 1-1 decision");
  // extractDue: explicit vs guessed
  const e1 = extractDue("Call me tomorrow at 3pm");
  ok(e1.due_date === localDay(1) && e1.due_time === "15:00", "extractDue explicit time");
  const e2 = extractDue("Call me tomorrow");
  ok(e2.due_date === localDay(1) && e2.due_time === "", "extractDue no invented time");
  ok(extractDue("just saying hi").due_date === "", "extractDue nothing found");
}

// ---------- G. learning loop ----------
{
  const conv = nid("convG"); mkConv(conv);
  const other = nid("convG2"); mkConv(other);
  // signature: the spec's example, templated
  const sig = deriveSignature("I'll send the contract tomorrow, Danyetta", ["Danyetta"]);
  ok(sig === "i will send {X} {WHEN}", `spec example signature (got ${JSON.stringify(sig)})`);
  const priv = deriveSignature("Call me at 555-1234 tomorrow", []);
  ok(!/\d/.test(priv) && priv.includes("{NUM}") && priv.includes("{WHEN}"), "numbers never leak into signatures");
  ok(!sig.includes("danyetta") && !sig.includes("contract") && !sig.includes("tomorrow"), "names/words/dates never leak");
  ok(deriveSignature("count me in") === "count me {X}", "short phrase signature");
  ok(deriveSignature("   ") === "", "blank -> empty signature");
  // scoring: laplace + 90-day half-life decay
  const fresh = { pattern: "p", class: "commitment", scope: conv, confirms: 3, dismissals: 0, retired: "", first_seen: "", last_seen: new Date().toISOString() };
  ok(Math.abs(patternScore(fresh) - 0.8) < 1e-9, "laplace (3+1)/(3+0+2) = 0.8");
  const aged = (days: number) => ({ ...fresh, last_seen: new Date(Date.now() - days * 86400_000).toISOString() });
  ok(Math.abs(patternScore(aged(100)) - 0.4) < 1e-9, "100d old -> half weight");
  ok(Math.abs(patternScore(aged(200)) - 0.2) < 1e-9, "200d old -> quarter weight");
  ok(Math.abs(patternScore(aged(10)) - 0.8) < 1e-9, "10d old -> no decay yet");
  // feedback: confirms
  recordFeedback({ text: "count me in", class: "commitment", conversationId: conv, kind: "confirm" });
  recordFeedback({ text: "count me in", class: "commitment", conversationId: conv, kind: "confirm" });
  recordFeedback({ text: "count me in", class: "commitment", conversationId: conv, kind: "confirm" });
  const row = getDb().query("SELECT * FROM language_patterns WHERE scope = ?").get(conv) as any;
  ok(row && row.confirms === 3 && row.retired === "", "3 confirms recorded");
  ok(row.pattern === "count me {X}", "stored pattern is the template, not raw text");
  // learned suggestion fires without any heuristic verb, scoped to the conversation
  const learned = analyzeMessage("count me in", ctxFor(conv, 1));
  ok(learned && learned.class === "commitment", "3 confirms -> learned suggestion");
  ok(learned!.reason.includes("learned from your phrasing") && learned!.reason.includes("count me {X}"), "reason explains the learning");
  ok(analyzeMessage("count me in", ctxFor(other, 1)) === null, "scoped pattern doesn't fire in another conversation");
  // 2 confirms is not enough to suggest alone
  recordFeedback({ text: "you got it", class: "commitment", conversationId: other, kind: "confirm" });
  recordFeedback({ text: "you got it", class: "commitment", conversationId: other, kind: "confirm" });
  ok(analyzeMessage("you got it", ctxFor(other, 1)) === null, "2 confirms -> still no learned suggestion");
  // dismissals retire at 3
  const rc = nid("convR"); mkConv(rc);
  recordFeedback({ text: "noted with thanks", class: "commitment", conversationId: rc, kind: "confirm" });
  recordFeedback({ text: "noted with thanks", class: "commitment", conversationId: rc, kind: "dismiss" });
  recordFeedback({ text: "noted with thanks", class: "commitment", conversationId: rc, kind: "dismiss" });
  let rrow = getDb().query("SELECT * FROM language_patterns WHERE scope = ?").get(rc) as any;
  ok(rrow.retired === "", "2 dismissals -> not retired");
  recordFeedback({ text: "noted with thanks", class: "commitment", conversationId: rc, kind: "dismiss" });
  rrow = getDb().query("SELECT * FROM language_patterns WHERE scope = ?").get(rc) as any;
  ok(rrow.retired !== "" && rrow.dismissals === 3, "3 dismissals -> retired");
  // retired patterns need double the confirms (6 total) to revive
  for (let i = 0; i < 4; i++) recordFeedback({ text: "noted with thanks", class: "commitment", conversationId: rc, kind: "confirm" });
  rrow = getDb().query("SELECT * FROM language_patterns WHERE scope = ?").get(rc) as any;
  ok(rrow.retired !== "" && rrow.confirms === 5, "5 confirms -> still retired");
  recordFeedback({ text: "noted with thanks", class: "commitment", conversationId: rc, kind: "confirm" });
  rrow = getDb().query("SELECT * FROM language_patterns WHERE scope = ?").get(rc) as any;
  ok(rrow.retired === "" && rrow.confirms === 6, "6th confirm revives");
  // global promotion: same phrasing confirmed in 2 conversations
  const g1 = nid("convG1"); mkConv(g1);
  const g2 = nid("convG2"); mkConv(g2);
  for (let i = 0; i < 3; i++) {
    recordFeedback({ text: "on it, boss", class: "commitment", conversationId: g1, kind: "confirm" });
    recordFeedback({ text: "on it, boss", class: "commitment", conversationId: g2, kind: "confirm" });
  }
  const grow = getDb().query("SELECT * FROM language_patterns WHERE scope = ''").get() as any;
  ok(grow && grow.confirms === 6, "shared phrasing promotes to global fallback");
  ok(grow.pattern === deriveSignature("on it, boss"), "global row stores the template");
  // teachFromManual wires into the same store
  const sig2 = teachFromManual({ text: "I'll handle the invitations", class: "commitment", conversationId: g1 });
  ok(typeof sig2 === "string" && sig2.length > 0, "teachFromManual returns a signature");
}

// ---------- H. suggestion lifecycle ----------
{
  const conv = nid("convH"); mkConv(conv);
  mkContact("c-shy", "Shy"); mkMember(conv, "c-shy");
  const msg = mkMsg(conv, "I'll send the contract tomorrow", "out");
  const s1 = trackMessage(msg);
  ok(s1 && s1.class === "commitment" && s1.conversation_id === conv, "trackMessage persists a suggestion");
  ok(s1!.due_date === localDay(1), "suggestion carries the extracted due date");
  ok(trackMessage(msg) === null && listSuggestions(conv).length === 1, "trackMessage idempotent per message");
  ok(listSuggestions(conv).length === 1, "listSuggestions returns it");
  const before = (getDb().query("SELECT COUNT(*) AS n FROM commitments").get() as any).n;
  const rec: any = confirmSuggestion(s1!.id, {});
  ok(rec.text === "I'll send the contract tomorrow" && rec.source === "suggested", "confirm creates the commitment from the message");
  ok(rec.due_date === localDay(1), "confirm inherits the suggested due date");
  ok(getSuggestion(s1!.id) === null, "confirm removes the suggestion");
  ok((getDb().query("SELECT COUNT(*) AS n FROM commitments").get() as any).n === before + 1, "exactly one commitment created");
  const pat = getDb().query("SELECT * FROM language_patterns WHERE scope = ?").get(conv) as any;
  ok(pat && pat.confirms >= 1, "confirm teaches the pattern loop");
  // decision confirm
  const grp = nid("convH2"); mkConv(grp, "Team", 1);
  mkMember(grp, "c-shy");
  mkContact("c-abby", "Abby"); mkMember(grp, "c-abby");
  const msg2 = mkMsg(grp, "It's decided, we're going with the oak finish", "out");
  const s2 = trackMessage(msg2)!;
  ok(s2.class === "decision", "decision suggestion tracked");
  const drec: any = confirmSuggestion(s2.id, {});
  ok(drec.text.includes("oak finish") && drec.source === "suggested", "confirm creates the decision");
  ok(JSON.parse(drec.participants).includes("c-shy"), "decision participants default to members");
  // dismiss
  const msg3 = mkMsg(conv, "I'll call you back soon", "out");
  const s3 = trackMessage(msg3)!;
  dismissSuggestion(s3.id);
  ok(getSuggestion(s3.id) === null, "dismiss removes the suggestion");
  ok((getDb().query("SELECT COUNT(*) AS n FROM commitments").get() as any).n === before + 1, "dismiss creates nothing");
  const dpat = getDb().query("SELECT * FROM language_patterns WHERE scope = ? AND pattern = ?").get(conv, deriveSignature("I'll call you back soon", ["Shy"])) as any;
  ok(dpat && dpat.dismissals === 1, "dismiss teaches the pattern loop");
  throws(() => confirmSuggestion("missing", {}), "confirm missing -> throws");
  throws(() => dismissSuggestion("missing"), "dismiss missing -> throws");
  // nothing auto-created: trackMessage only writes suggestions
  const msg4 = mkMsg(conv, "I'll book the flights tonight", "out");
  const cBefore = (getDb().query("SELECT COUNT(*) AS n FROM commitments").get() as any).n;
  const dBefore = (getDb().query("SELECT COUNT(*) AS n FROM decisions").get() as any).n;
  trackMessage(msg4);
  ok((getDb().query("SELECT COUNT(*) AS n FROM commitments").get() as any).n === cBefore, "tracking never auto-creates commitments");
  ok((getDb().query("SELECT COUNT(*) AS n FROM decisions").get() as any).n === dBefore, "tracking never auto-creates decisions");
  // 7-day expiry
  const old = createSuggestion({
    conversation_id: conv, message_id: nid("oldmsg"), class: "commitment",
    reason: "old", due_date: "", due_time: "",
  })!;
  getDb().query("UPDATE suggestions SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 8 * 86400_000).toISOString(), old.id);
  const swept = sweepExpiredSuggestions();
  ok(swept === 1 && getSuggestion(old.id) === null, "8-day-old suggestion swept");
  ok(listSuggestions(conv).length >= 1, "fresh suggestions survive the sweep");
  // per-message dedupe across classes
  const dup = createSuggestion({ conversation_id: conv, message_id: msg4.id, class: "commitment", reason: "x" });
  ok(dup === null, "one suggestion per message per class");
}

// ---------- I. global views + cascade ----------
{
  const conv = nid("convI"); mkConv(conv, "Weekend", 1);
  mkContact("c-d", "Danyetta"); mkMember(conv, "c-d");
  createCommitment({ conversation_id: conv, text: "Global view item", due_date: localDay(0) });
  createDecision({ conversation_id: conv, text: "Global decision" });
  const all = listAllCommitments();
  const hit = all.find((c) => c.text === "Global view item");
  ok(hit && hit.conversation_title === "Weekend", "global commitments carry conversation titles");
  ok(listAllCommitments("view item").length >= 1, "global q search");
  ok(listAllDecisions().some((d) => d.text === "Global decision"), "global decisions listed");
  // archived conversations are hidden unless asked for
  getDb().query("UPDATE conversations SET archived = 1 WHERE id = ?").run(conv);
  ok(!listAllCommitments().some((c) => c.text === "Global view item"), "archived hidden by default");
  ok(listAllCommitments("", true).some((c) => c.text === "Global view item"), "archived shown on request");
  // cascade
  const sig = teachFromManual({ text: "I'll water the plants", class: "commitment", conversationId: conv });
  ok(sig.length > 0, "pattern seeded for cascade check");
  const counts = () => ({
    c: (getDb().query("SELECT COUNT(*) AS n FROM commitments WHERE conversation_id = ?").get(conv) as any).n,
    d: (getDb().query("SELECT COUNT(*) AS n FROM decisions WHERE conversation_id = ?").get(conv) as any).n,
    s: (getDb().query("SELECT COUNT(*) AS n FROM suggestions WHERE conversation_id = ?").get(conv) as any).n,
    p: (getDb().query("SELECT COUNT(*) AS n FROM language_patterns WHERE scope = ?").get(conv) as any).n,
  });
  ok(counts().c > 0 && counts().d > 0 && counts().p > 0, "rows exist before delete");
  deleteConversationData(conv);
  const after = counts();
  ok(after.c === 0 && after.d === 0 && after.s === 0 && after.p === 0, "conversation delete cascades to tracker tables");
  const globalLeft = (getDb().query("SELECT COUNT(*) AS n FROM language_patterns WHERE scope = ''").get() as any).n;
  ok(globalLeft > 0, "global fallback patterns survive conversation deletion");
}

// ---------- decision timestamps, decision search, failed-message tracking ----------
{
  const conv = nid("convT"); mkConv(conv);
  // explicit decision timestamp on create
  const d1 = createDecision({ conversation_id: conv, text: "We ship Tuesday", decided_at: "2026-09-10T14:00:00.000Z" });
  ok(d1.decided_at === "2026-09-10T14:00:00.000Z", "decision create honors explicit decided_at");
  // invalid timestamp rejected
  let threw = false;
  try { createDecision({ conversation_id: conv, text: "Bad date", decided_at: "not a date" }); } catch { threw = true; }
  ok(threw, "decision create rejects unparseable decided_at");
  // patch updates the timestamp
  const d2 = patchDecision(d1.id, { decided_at: "2026-09-11T09:30:00.000Z" });
  ok(d2 !== null && d2.decided_at === "2026-09-11T09:30:00.000Z", "decision patch updates decided_at");
  let threw2 = false;
  try { patchDecision(d1.id, { decided_at: "garbage" }); } catch { threw2 = true; }
  ok(threw2, "decision patch rejects unparseable decided_at");
  // global decision search
  createDecision({ conversation_id: conv, text: "We migrate the database tonight" });
  ok(listAllDecisions("migrate").some((d) => d.text.includes("migrate")), "listAllDecisions q search matches text");
  ok(listAllDecisions("migrate").every((d) => d.text.includes("migrate") || (d.participants || "").includes("migrate")), "listAllDecisions q search filters non-matches");
  ok(listAllDecisions("migr_te").length === 0, "listAllDecisions escapes LIKE wildcards");
  // failed outgoing messages never produce suggestions
  const fm = insertMessage({
    id: nid("fm"), conversation_id: conv, direction: "out", channel: "sms",
    body: "I'll send the contract tomorrow morning", subject: "", status: "failed",
    external_id: "", created_at: new Date().toISOString(),
  } as any);
  ok(trackMessage(fm) === null, "failed message -> no suggestion");
  ok(listSuggestions(conv).length === 0, "no suggestion persisted for failed message");
}

console.log(`commitments: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
