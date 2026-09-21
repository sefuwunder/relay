"use strict";

/* RelayDates — fuzzy natural-language date/time parsing + meeting-request detection.
 *
 * Zero dependencies. Everything is computed in the viewer's LOCAL timezone;
 * returned ISO strings are UTC (matching the diary/appointment store).
 *
 * PARSING RULES (documented contract):
 *  - Date anchors: "today", "tonight", "tomorrow", "day after tomorrow",
 *    bare weekday ("friday"), "this friday", "next friday",
 *    "in N minutes|hours|days|weeks", "sep 22" / "22 september" (nearest
 *    future), ISO "2026-09-22".
 *  - WEEKDAY RULE: a bare weekday or "this <weekday>" = the NEAREST FUTURE
 *    occurrence of that weekday. "next <weekday>" = the occurrence at least
 *    7 days out (i.e. next calendar week's). When the resolved instant is not
 *    in the future it rolls forward — day-by-day for plain dates/times, or to
 *    next week's occurrence for weekday anchors (so "sunday at 8am" said on
 *    Sunday at 10am means next Sunday, not Monday). Ambiguity always resolves
 *    to the nearest future instant, never the past.
 *  - Time anchors: "1pm", "1:30pm", "13:00", "noon" (12:00), "midnight" (00:00),
 *    "morning" (09:00), "afternoon" (14:00), "evening" (18:00). A bare "1:30"
 *    (no am/pm) means the nearer of 1:30am / 1:30pm. "tonight" alone = 20:00.
 *    A time with no date ("at 1pm") means today if still ahead, else tomorrow.
 *  - Durations: "for 30 min", "for 2 hours", "an hour", "half an hour".
 *    Default event length is 60 minutes; a date with no time starts at 09:00.
 *  - matchedText is the exact substring that was parsed.
 *
 * DETECTION RULE (detectMeetingRequest): a message flags only when it contains
 * BOTH a parseable date/time expression AND a meeting-ish cue (meet, call,
 * talk, coffee, lunch, catch up, "free at…?", …). Plain deadlines like
 * "the report is due tomorrow" do not flag.
 *
 * AGREEMENT RULE (detectAffirmation + agreementChipFor in app.js): a short
 * affirmative reply with no date/time of its own ("Yes, see you then.") can
 * inherit the time from the most recent meeting proposal (concrete date AND
 * explicit time, not a deadline) in the previous ~10 messages / 48h of the
 * same conversation. The chip's tooltip names the source message so the
 * inherited time never looks hallucinated. Bare "yes" with no proposal in the
 * window never flags.
 */

var DAY_MS = 86400000;

var WD_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
var MON_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

var WD_PAT = "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:sday)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
var MON_PAT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function wdIndex(name) { return WD_IDX[String(name).slice(0, 3).toLowerCase()]; }
function monIndex(name) { return MON_IDX[String(name).slice(0, 3).toLowerCase()]; }

// One date alternative; wrapped in \b…\b by the master patterns.
var DATE_SRC =
  "(?<rel>day\\s+after\\s+tomorrow|tonight|tomorrow|today)" +
  "|(?<thisnext>this|next)\\s+(?<wn>" + WD_PAT + ")" +
  "|(?<wd>" + WD_PAT + ")" +
  "|in\\s+(?<inN>\\d+)\\s+(?<inU>minute|hour|day|week)s?" +
  "|(?<mon>" + MON_PAT + ")\\s+(?<mday>\\d{1,2})(?:st|nd|rd|th)?" +
  "|(?<mday2>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<mon2>" + MON_PAT + ")" +
  "|(?<iso>\\d{4}-\\d{1,2}-\\d{1,2})";

var TIME_SRC =
  "(?<tod>noon|midnight|morning|afternoon|evening)" +
  "|(?<h12>\\d{1,2})(?::(?<m12>\\d{2}))?\\s*(?<ap>am|pm)" +
  "|(?<h24>\\d{1,2}):(?<m24>\\d{2})";

var DUR_SRC =
  "for\\s+(?<durn>\\d+)\\s*(?<duru>min(?:ute)?s?|hours?)" +
  "|(?:for\\s+)?(?<durhalf>half)\\s+an?\\s+hour" +
  "|(?:for\\s+)?an?\\s+(?<durone>hour)";

// "1pm tomorrow" / "at noon on friday" — tried first so the time isn't lost
// when the date also appears later in the string.
var RE_TIME_DATE = new RegExp(
  "\\b(?:at\\s+)?(?:" + TIME_SRC + ")\\s+(?:on\\s+)?\\b(?:" + DATE_SRC + ")\\b" +
  "(?:\\s*,?\\s*(?:" + DUR_SRC + "))?",
  "i");
// "tomorrow at 1pm", "friday", "in 2 hours for 30 min" …
var RE_DATE_FIRST = new RegExp(
  "(?:\\b(?:on|by)\\s+)?\\b(?:" + DATE_SRC + ")\\b" +
  "(?:\\s+(?:at\\s+)?(?:" + TIME_SRC + "))?" +
  "(?:\\s*,?\\s*(?:" + DUR_SRC + "))?",
  "i");
// "at 1pm", "noon for an hour" …
var RE_TIME_ONLY = new RegExp(
  "\\b(?:at\\s+)?(?:" + TIME_SRC + ")(?:\\s*,?\\s*(?:" + DUR_SRC + "))?",
  "i");

/** Minutes-of-day for the matched time, or null when no time was given.
 *  { invalid: true } when a time token was present but nonsensical. */
function timeInfo(g) {
  if (g.tod) {
    var t = g.tod.toLowerCase();
    return { min: t === "noon" ? 720 : t === "midnight" ? 0 : t === "morning" ? 540 : t === "afternoon" ? 840 : 1080, bare: false };
  }
  if (g.h12) {
    var h = parseInt(g.h12, 10), mi = g.m12 ? parseInt(g.m12, 10) : 0, ap = g.ap.toLowerCase();
    if (h < 1 || h > 12 || mi > 59) return { invalid: true };
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { min: h * 60 + mi, bare: false };
  }
  if (g.h24) {
    var h2 = parseInt(g.h24, 10), mi2 = parseInt(g.m24, 10);
    if (h2 > 23 || mi2 > 59) return { invalid: true };
    if (h2 <= 12) return { min: h2 * 60 + mi2, bare: true }; // "1:30" → nearer of 1:30am / 1:30pm
    return { min: h2 * 60 + mi2, bare: false };
  }
  return null;
}

function durMinutes(g) {
  if (g.durn) {
    var n = parseInt(g.durn, 10);
    return g.duru.toLowerCase().charAt(0) === "m" ? n : n * 60;
  }
  if (g.durhalf) return 30;
  if (g.durone) return 60;
  return 0;
}

function parseDateTime(text, nowMs) {
  if (!text) return null;
  var now = nowMs == null ? Date.now() : nowMs;
  var m = RE_TIME_DATE.exec(text) || RE_DATE_FIRST.exec(text) || RE_TIME_ONLY.exec(text);
  if (!m) return null;
  var out = resolveGroups(m.groups || {}, now);
  if (!out) return null;
  var gg = m.groups || {};
  return {
    start: new Date(out.start).toISOString(),
    end: new Date(out.end).toISOString(),
    matchedText: m[0].trim(),
    // True when the message named an explicit time ("10:30", "noon",
    // "morning"); false when the time is just the 09:00 date-only default.
    // Agreement detection only inherits explicit times, never defaults.
    timeExplicit: !!(gg.tod || gg.h12 || gg.h24),
  };
}

function resolveGroups(g, now) {
  var ref = new Date(now);
  var midnight = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  var dayMs = midnight;
  var todMin = 9 * 60; // default time when only a date is given
  var relativeStart = 0;

  if (g.rel) {
    var r = g.rel.toLowerCase().replace(/\s+/g, " ");
    if (r === "tomorrow") dayMs = midnight + DAY_MS;
    else if (r === "day after tomorrow") dayMs = midnight + 2 * DAY_MS;
    else if (r === "tonight") todMin = 20 * 60;
  } else if (g.wn || g.wd) {
    var idx = wdIndex(g.wn || g.wd);
    var delta = (idx - new Date(midnight).getDay() + 7) % 7;
    // "next <weekday>" = the occurrence at least 7 days out.
    if (g.thisnext && g.thisnext.toLowerCase() === "next" && delta < 7) delta += 7;
    dayMs = midnight + delta * DAY_MS;
  } else if (g.inN) {
    var n = parseInt(g.inN, 10), u = g.inU.toLowerCase().charAt(0);
    var add = u === "m" ? n * 60000 : u === "h" ? n * 3600000 : u === "d" ? n * DAY_MS : n * 7 * DAY_MS;
    relativeStart = now + add;
  } else if (g.mon || g.mon2) {
    var mi = monIndex(g.mon || g.mon2), dy = parseInt(g.mday || g.mday2, 10);
    var cand = new Date(ref.getFullYear(), mi, dy).getTime();
    if (cand + todMin * 60000 <= now) cand = new Date(ref.getFullYear() + 1, mi, dy).getTime();
    dayMs = cand; // explicit time (or 09:00 default) resolved below
  } else if (g.iso) {
    var p = g.iso.split("-");
    dayMs = new Date(+p[0], +p[1] - 1, +p[2]).getTime(); // explicit time (or 09:00) below
  } else if (!g.tod && !g.h12 && !g.h24) {
    return null; // no date and no time matched (shouldn't happen)
  }

  var ti = timeInfo(g);
  if (ti && ti.invalid) return null;
  var start;
  var isWeekday = !!(g.wn || g.wd);
  if (relativeStart) {
    start = relativeStart;
  } else if (ti && ti.bare) {
    // Bare "1:30": the nearer of 1:30am / 1:30pm that is still in the future.
    var c1 = dayMs + ti.min * 60000, c2 = dayMs + (ti.min + 720) * 60000;
    var fut = [c1, c2].filter(function (t) { return t > now; });
    start = fut.length ? Math.min.apply(null, fut) : c1 + DAY_MS;
  } else {
    start = dayMs + (ti ? ti.min : todMin) * 60000;
    if (isWeekday) {
      // A weekday anchor names a weekday: a passed time jumps to next week's
      // occurrence, not to tomorrow (which would be the wrong weekday).
      if (start <= now) start += 7 * DAY_MS;
    } else {
      var guard = 0;
      while (start <= now && guard++ < 8) start += DAY_MS; // nearest future, never the past
    }
  }
  return finishAt(start, g, now);
}

function finishAt(start, g, now) {
  void now;
  var dur = durMinutes(g) || 60;
  return { start: start, end: start + dur * 60000 };
}

// Meeting-ish cues. Word-boundary guarded so "recall" ≠ "call".
var CUE_RE = /\b(?:meet(?:ing)?s?|call(?:s|ed|ing)?|talk(?:s|ed|ing)?|chat(?:s|ting)?|zoom|coffee|lunch|dinner|breakfast|drinks|catch[\s-]?up|sync(?:s|ed|ing)?|hang\s*out|get\s+together|appointment|demo|stand[\s-]?up|huddle|session|are\s+you\s+free|free\s+(?:at|on|this|next|in|today|tomorrow|tonight)|does\s+[\w\s,'-]{1,40}?\s+work\s+for\s+you|how\s+about|quick\s+(?:chat|call|sync))\b/i;

function detectMeetingRequest(text, nowMs) {
  if (!text) return null;
  var cueM = CUE_RE.exec(text);
  if (!cueM) return null;
  var dt = parseDateTime(text, nowMs);
  if (!dt) return null;
  return { start: dt.start, end: dt.end, matchedText: dt.matchedText, cue: cueM[0].trim().toLowerCase() };
}

// Agreement affirmations: short affirmative replies ("Yes.", "Yes, see you
// then.", "Sounds good") that confirm a meeting proposal made earlier in the
// thread. A tight curated list — the reply must be short, carry no date/time
// of its own, and contain no contradiction ("yes, but…"). The meeting time is
// inherited from the proposal by the caller (see agreementChipFor in app.js);
// this only says "this message sounds like an agreement".
var AFFIRM_PHRASES = [
  "sounds good", "works for me", "that works", "see you then",
  "looking forward to it", "perfect", "confirmed", "deal",
];
var AFFIRM_WORDS = ["yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "great", "awesome"];
// Contradictions that disqualify an otherwise affirmative-looking reply.
var AFFIRM_NO_RE = /\b(but|however|though|although|unless|can'?t|cannot|won'?t|not yet)\b/i;

function detectAffirmation(text) {
  var t = String(text || "").trim().toLowerCase().replace(/[.!…]+$/, "").trim();
  if (!t || t.length > 80 || t.indexOf("?") !== -1) return null;
  var hit = null, i, w, rest;
  for (i = 0; i < AFFIRM_PHRASES.length; i++) {
    var p = AFFIRM_PHRASES[i];
    if (t === p || (t.indexOf(p) === 0 && /^[\s,;:]/.test(t.slice(p.length)))) { hit = p; break; }
  }
  if (!hit) {
    for (i = 0; i < AFFIRM_WORDS.length; i++) {
      w = AFFIRM_WORDS[i];
      if (t === w || (t.indexOf(w) === 0 && /^[\s,;:.!]/.test(t.slice(w.length)))) { hit = w; break; }
    }
  }
  if (!hit) return null;
  var tail = t.slice(hit.length);
  if (tail.length > 50) return null;
  if (AFFIRM_NO_RE.test(tail)) return null;
  return hit;
}

var RelayDates = {
  parseDateTime: parseDateTime,
  detectMeetingRequest: detectMeetingRequest,
  detectAffirmation: detectAffirmation,
};

if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
  module.exports = RelayDates;
}
