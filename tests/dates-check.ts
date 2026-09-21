// RelayDates checks: fuzzy date/time parser + meeting-request detector.
// Deterministic: every case runs against a fixed "now" (Sunday 2026-09-20
// 10:00 LOCAL), and expectations are built with local Date arithmetic so the
// suite passes in any timezone.
// Run: bun tests/dates-check.ts
import { parseDateTime, detectMeetingRequest, detectAffirmation } from "../src/dates";

let pass = 0, fail = 0;
function ok(name: string, cond: any) {
  if (cond) { pass++; } else { fail++; console.error("FAIL:", name); }
}

// Fixed now: Sunday 2026-09-20 10:00 local.
const NOW = new Date(2026, 8, 20, 10, 0, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const startOf = (r: any) => (r ? new Date(r.start).getTime() : NaN);
const endOf = (r: any) => (r ? new Date(r.end).getTime() : NaN);

// ---------- relative dates ----------
{
  const r = parseDateTime("call tomorrow at 1pm?", NOW);
  ok("tomorrow at 1pm", startOf(r) === at(2026, 9, 21, 13, 0));
  ok("default 60 min", endOf(r) === at(2026, 9, 21, 14, 0));
  ok("matchedText", r!.matchedText === "tomorrow at 1pm");
  const r2 = parseDateTime("meet today at 4pm", NOW);
  ok("today at 4pm", startOf(r2) === at(2026, 9, 20, 16, 0));
  const r3 = parseDateTime("sync day after tomorrow for 30 min", NOW);
  ok("day after tomorrow", startOf(r3) === at(2026, 9, 22, 9, 0));
  ok("explicit 30 min duration", endOf(r3) === at(2026, 9, 22, 9, 30));
  const r4 = parseDateTime("meet tonight", NOW);
  ok("tonight = 20:00", startOf(r4) === at(2026, 9, 20, 20, 0));
  const r5 = parseDateTime("meet tomorrow at 12pm for an hour", NOW);
  ok("an hour duration", endOf(r5) === at(2026, 9, 21, 13, 0));
  const r6 = parseDateTime("meet tomorrow for half an hour", NOW);
  ok("half an hour duration", endOf(r6) === at(2026, 9, 21, 9, 30));
}

// ---------- weekdays: the nearest-future rule ----------
{
  // Sunday 10:00; Friday is 5 days out.
  const r = parseDateTime("lunch friday morning", NOW);
  ok("bare friday -> nearest future", startOf(r) === at(2026, 9, 25, 9, 0));
  const r2 = parseDateTime("talk this friday at 2pm", NOW);
  ok("this friday = bare friday", startOf(r2) === at(2026, 9, 25, 14, 0));
  const r3 = parseDateTime("meet next tuesday 3pm", NOW);
  ok("next tuesday >= 7 days out", startOf(r3) === at(2026, 9, 29, 15, 0));
  const r4 = parseDateTime("call next monday", NOW);
  ok("next monday >= 7 days out", startOf(r4) === at(2026, 9, 28, 9, 0));
  const r5 = parseDateTime("call this monday", NOW);
  ok("this monday = tomorrow", startOf(r5) === at(2026, 9, 21, 9, 0));
  // Same weekday as today: a time still ahead lands today …
  const r6 = parseDateTime("call sunday at 3pm", NOW);
  ok("today's weekday, time ahead -> today", startOf(r6) === at(2026, 9, 20, 15, 0));
  // … a time already past rolls a full week forward.
  const r7 = parseDateTime("call sunday at 8am", NOW);
  ok("today's weekday, time past -> +7 days", startOf(r7) === at(2026, 9, 27, 8, 0));
  const r8 = parseDateTime("coffee tue", NOW);
  ok("abbrev tue", startOf(r8) === at(2026, 9, 22, 9, 0));
}

// ---------- times ----------
{
  const r = parseDateTime("zoom at 13:00", NOW);
  ok("24h time", startOf(r) === at(2026, 9, 20, 13, 0));
  const r2 = parseDateTime("zoom at 8am", NOW);
  ok("past am time -> tomorrow", startOf(r2) === at(2026, 9, 21, 8, 0));
  const r3 = parseDateTime("call at noon", NOW);
  ok("noon", startOf(r3) === at(2026, 9, 20, 12, 0));
  const r4 = parseDateTime("call at noon", at(2026, 9, 20, 13, 0));
  ok("noon past -> tomorrow", startOf(r4) === at(2026, 9, 21, 12, 0));
  const r5 = parseDateTime("meet at midnight", NOW);
  ok("midnight rolls forward", startOf(r5) === at(2026, 9, 21, 0, 0));
  const r6 = parseDateTime("talk in the morning friday", NOW);
  ok("morning = 09:00", startOf(r6) === at(2026, 9, 25, 9, 0));
  const r7 = parseDateTime("talk friday afternoon", NOW);
  ok("afternoon = 14:00", startOf(r7) === at(2026, 9, 25, 14, 0));
  const r8 = parseDateTime("talk friday evening", NOW);
  ok("evening = 18:00", startOf(r8) === at(2026, 9, 25, 18, 0));
  const r9 = parseDateTime("chat at 1:30", NOW);
  ok("bare 1:30 -> nearer pm", startOf(r9) === at(2026, 9, 20, 13, 30));
  const r10 = parseDateTime("chat at 1:30", at(2026, 9, 20, 15, 0));
  ok("bare 1:30 past pm -> tomorrow am", startOf(r10) === at(2026, 9, 21, 1, 30));
  ok("no false date on '1:30'", r9!.matchedText === "at 1:30");
}

// ---------- time-only, time-date order, month dates, ISO ----------
{
  const r = parseDateTime("1pm tomorrow", NOW);
  ok("time-date order", startOf(r) === at(2026, 9, 21, 13, 0));
  const r2 = parseDateTime("dinner sep 25 at 7pm", NOW);
  ok("month name + explicit time", startOf(r2) === at(2026, 9, 25, 19, 0));
  const r3 = parseDateTime("dinner 25 september", NOW);
  ok("day month order", startOf(r3) === at(2026, 9, 25, 9, 0));
  const r4 = parseDateTime("call 2026-09-22", NOW);
  ok("ISO date", startOf(r4) === at(2026, 9, 22, 9, 0));
  const r5 = parseDateTime("dinner jan 5", NOW);
  ok("past month-day -> next year", startOf(r5) === at(2027, 1, 5, 9, 0));
  const r6 = parseDateTime("meet on friday at 2pm", NOW);
  ok("'on friday' preposition", startOf(r6) === at(2026, 9, 25, 14, 0));
}

// ---------- "in N …" ----------
{
  const r = parseDateTime("coffee in 2 hours?", NOW);
  ok("in 2 hours", startOf(r) === NOW + 2 * 3600000);
  const r2 = parseDateTime("call in 30 minutes", NOW);
  ok("in 30 minutes", startOf(r2) === NOW + 30 * 60000);
  const r3 = parseDateTime("meet in 3 days", NOW);
  ok("in 3 days", startOf(r3) === NOW + 3 * 86400000);
}

// ---------- detector: needs a cue AND a date/time ----------
const positives: Array<[string, number]> = [
  ["call tomorrow at 1pm?", at(2026, 9, 21, 13, 0)],
  ["can we talk at noon?", at(2026, 9, 20, 12, 0)],
  ["lets meet next tuesday 3pm", at(2026, 9, 29, 15, 0)],
  ["coffee in 2 hours?", NOW + 2 * 3600000],
  ["lunch friday morning", at(2026, 9, 25, 9, 0)],
  ["zoom at 13:00", at(2026, 9, 20, 13, 0)],
  ["are you free tomorrow?", at(2026, 9, 21, 9, 0)],
  ["does friday at 2 work for you?", at(2026, 9, 25, 9, 0)],
  ["how about thursday morning?", at(2026, 9, 24, 9, 0)],
  ["quick sync day after tomorrow", at(2026, 9, 22, 9, 0)],
  ["let's catch up on saturday", at(2026, 9, 26, 9, 0)],
  ["dinner sep 25 at 7pm?", at(2026, 9, 25, 19, 0)],
  ["can we do a demo tomorrow at 10am?", at(2026, 9, 21, 10, 0)],
];
for (const [text, want] of positives) {
  const r = detectMeetingRequest(text, NOW);
  ok(`flags: ${text}`, !!r && startOf(r) === want);
}
const negatives = [
  "the report is due tomorrow",
  "tomorrow at 1pm?",
  "recall tomorrow at 1pm",
  "happy birthday tomorrow!",
  "the meeting notes from yesterday are attached",
  "call at 25:00",
  "let's catch up next week",
  "money is due friday",
  "i'll call you sometime",
  "lunch was great",
];
for (const text of negatives) {
  ok(`no flag: ${text}`, detectMeetingRequest(text, NOW) === null);
}
{
  // parseDateTime alone still sees the date in a deadline…
  ok("parser sees deadlines", parseDateTime("the report is due tomorrow", NOW) !== null);
  // …but the detector requires a meeting cue.
  const r = detectMeetingRequest("call tomorrow at 1pm?", NOW);
  ok("cue reported", r!.cue === "call");
  ok("empty text", detectMeetingRequest("", NOW) === null);
}

// ---------- explicit-time flag (drives agreement inheritance) ----------
{
  const r = parseDateTime("tomorrow 10:30 - 11:30?", NOW);
  ok("range time is explicit", r!.timeExplicit === true);
  ok("range start", startOf(r) === at(2026, 9, 21, 10, 30));
  const r2 = parseDateTime("call tomorrow", NOW);
  ok("date-only time is not explicit", r2!.timeExplicit === false);
  const r3 = parseDateTime("meet tonight", NOW);
  ok("tonight alone is not explicit", r3!.timeExplicit === false);
  const r4 = parseDateTime("lunch friday morning", NOW);
  ok("morning is explicit", r4!.timeExplicit === true);
  const r5 = parseDateTime("sync day after tomorrow for 30 min", NOW);
  ok("duration-only is not explicit", r5!.timeExplicit === false);
}

// ---------- agreement affirmations ----------
{
  const affs: Array<[string, string]> = [
    ["Yes, see you then.", "yes"],
    ["Yes.", "yes"],
    ["yes", "yes"],
    ["SOUNDS GOOD", "sounds good"],
    ["Sounds good", "sounds good"],
    ["works for me", "works for me"],
    ["that works!", "that works"],
    ["perfect", "perfect"],
    ["confirmed", "confirmed"],
    ["looking forward to it", "looking forward to it"],
    ["deal.", "deal"],
    ["ok, see you then", "ok"],
  ];
  for (const [text, want] of affs) {
    ok(`affirmation: ${text}`, detectAffirmation(text) === want);
  }
  const rejects = [
    "yes but I can't make it",
    "sounds good, however I have a conflict",
    "Did you send it?",
    "yesterday",
    "yes " + "and ".repeat(30),          // too long
    "the meeting is confirmed for tuesday at 3pm", // carries its own date
    "",
  ];
  for (const text of rejects) {
    ok(`not an affirmation: ${text.slice(0, 30)}`, detectAffirmation(text) === null);
  }
}

console.log(`dates: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
