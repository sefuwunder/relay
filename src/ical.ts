// Minimal RFC 5545 calendar support for invitations: build request ICS and
// parse inbound ICS — zero dependencies.

export interface CalEvent {
  uid: string;
  summary: string;
  /** ISO UTC timestamps. */
  dtstart: string;
  dtend: string;
  location: string;
  description: string;
  /** Organizer email (mailto: stripped), "" when the event names none. */
  organizer: string;
  method: string;
  /** Attendees: mailto: stripped email + CN display name. */
  attendees: { email: string; cn: string }[];
  /** STATUS value (e.g. CONFIRMED, CANCELLED), uppercased, "" when absent. */
  status: string;
  /** Raw RRULE value, "" when the event does not repeat. */
  rrule: string;
  /** True when DTSTART was a bare date (all-day event). */
  allDay: boolean;
}

export function newEventUid(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@relay`;
}

function p2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date -> ICS UTC timestamp: 20260917T120000Z */
function icsDate(d: Date): string {
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`
  );
}

function escText(s: string): string {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

export function unescText(s: string): string {
  return String(s || "").replace(/\\n/gi, "\n").replace(/\\;/g, ";").replace(/\\,/g, ",").replace(/\\\\/g, "\\");
}

/** Fold a content line past 75 octets (RFC 5545 §3.1). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  let out = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length) {
    out += "\r\n " + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return out;
}

export interface BuildIcsOpts {
  uid: string;
  summary: string;
  startsAt: Date;
  endsAt: Date;
  location?: string;
  description?: string;
  organizer?: string;
  organizerName?: string;
  /** Attendees: plain emails, or objects when a PARTSTAT is needed (RSVP). */
  attendees?: (string | { email: string; partstat?: string })[];
  method?: "REQUEST" | "REPLY" | "CANCEL";
}

/** Build a VCALENDAR invitation (METHOD:REQUEST by default). */
export function buildIcs(o: BuildIcsOpts): string {
  const method = o.method || "REQUEST";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//relay//calendar//EN",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${o.uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(o.startsAt)}`,
    `DTEND:${icsDate(o.endsAt)}`,
    `SUMMARY:${escText(o.summary)}`,
  ];
  if (o.location) lines.push(`LOCATION:${escText(o.location)}`);
  if (o.description) lines.push(`DESCRIPTION:${escText(o.description)}`);
  if (o.organizer) lines.push(`ORGANIZER${o.organizerName ? `;CN=${escText(o.organizerName)}` : ""}:mailto:${o.organizer}`);
  for (const a of o.attendees || []) {
    const email = typeof a === "string" ? a : a.email;
    const partstat = typeof a === "string" ? "" : a.partstat ? `;PARTSTAT=${a.partstat}` : "";
    lines.push(`ATTENDEE;CN=${escText(email)}${partstat}:mailto:${email}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Offset of a tz at a UTC instant, in ms (local - utc), via Intl. */
function tzOffsetMs(tz: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(at)) parts[p.type] = p.value;
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour || 0) % 24, +parts.minute, +parts.second);
    return asUTC - at.getTime();
  } catch {
    return 0;
  }
}

/** Wall-clock time in a TZID zone -> ISO UTC. Two passes for DST edges. */
export function tzWallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, mo - 1, d, h, mi, s) - tzOffsetMs(tz, new Date(guess));
  return new Date(guess).toISOString();
}

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z?)$/;

/** Parse an ICS date value (+ its params) to ISO UTC. "" when unparseable. */
export function parseIcsDate(params: string, value: string): string {
  const m = value.match(DT_RE);
  if (!m) return "";
  const y = +m[1], mo = +m[2], d = +m[3];
  const h = +(m[4] || "0"), mi = +(m[5] || "0"), s = +(m[6] || "0");
  const tzid = (/TZID=([^;:]+)/i.exec(params) || [])[1];
  if (m[7] === "Z" || !m[4]) {
    // UTC instant, or an all-day date (midnight UTC).
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
  }
  if (tzid) return tzWallToUtc(tzid, y, mo, d, h, mi, s);
  // Floating wall time: keep as UTC.
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
}

/** Parse every VEVENT in an ICS document. Never throws. */
export function parseIcs(text: string): CalEvent[] {
  const out: CalEvent[] = [];
  try {
    const raw = String(text || "").split(/\r\n|\n|\r/);
    const lines: string[] = [];
    for (const ln of raw) {
      if (/^[ \t]/.test(ln) && lines.length) lines[lines.length - 1] += ln.slice(1);
      else lines.push(ln);
    }
    let method = "";
    let cur: Record<string, string> | null = null;
    for (const ln of lines) {
      const ci = ln.indexOf(":");
      if (ci < 0) continue;
      const head = ln.slice(0, ci);
      const value = ln.slice(ci + 1);
      const prop = head.split(";")[0].trim().toUpperCase();
      const params = head.slice(head.split(";")[0].length);
      if (prop === "METHOD" && !cur) {
        method = value.trim().toUpperCase();
      } else if (prop === "BEGIN" && value.trim().toUpperCase() === "VEVENT") {
        cur = {};
      } else if (prop === "END" && value.trim().toUpperCase() === "VEVENT") {
        if (cur && cur.dtstart) {
          const start = cur.dtstart;
          let end = cur.dtend;
          if (!end) {
            // Default: +1 day for all-day, +1 hour otherwise.
            const allDay = /^\d{8}$/.test(cur.dtstartRaw || "");
            end = new Date(new Date(start).getTime() + (allDay ? 86400 : 3600) * 1000).toISOString();
          }
          out.push({
            uid: cur.uid || "",
            summary: cur.summary || "(no title)",
            dtstart: start,
            dtend: end,
            location: cur.location || "",
            description: cur.description || "",
            method: method || "REQUEST",
            organizer: cur.organizer || "",
            attendees: cur.attendees ? JSON.parse(cur.attendees) : [],
            status: (cur.status || "").toUpperCase(),
            rrule: cur.rrule || "",
            allDay: /^\d{8}$/.test(cur.dtstartRaw || ""),
          });
        }
        cur = null;
      } else if (cur) {
        if (prop === "UID") cur.uid = value.trim();
        else if (prop === "SUMMARY") cur.summary = unescText(value);
        else if (prop === "DTSTART") {
          cur.dtstartRaw = value.trim();
          cur.dtstart = parseIcsDate(params, value.trim());
        } else if (prop === "DTEND") cur.dtend = parseIcsDate(params, value.trim());
        else if (prop === "LOCATION") cur.location = unescText(value);
        else if (prop === "DESCRIPTION") cur.description = unescText(value);
        else if (prop === "ORGANIZER") cur.organizer = value.trim().replace(/^mailto:/i, "");
        else if (prop === "STATUS") cur.status = value.trim();
        else if (prop === "RRULE") cur.rrule = value.trim();
        else if (prop === "ATTENDEE") {
          const email = value.trim().replace(/^mailto:/i, "");
          const cnM = /CN=("[^"]*"|[^;:]*)/i.exec(params);
          let cn = cnM ? cnM[1] : "";
          if (cn.startsWith('"') && cn.endsWith('"') && cn.length >= 2) cn = cn.slice(1, -1);
          const list = cur.attendees ? JSON.parse(cur.attendees) : [];
          list.push({ email, cn: unescText(cn) });
          cur.attendees = JSON.stringify(list);
        }
      }
    }
  } catch {
    /* best effort — a broken invite never breaks the poll */
  }
  return out;
}

/** One expanded instance of a (possibly recurring) event. ISO UTC. */
export interface IcsOccurrence {
  start: string;
  end: string;
}

/** Maximum occurrences expanded from one RRULE — a sanity cap. */
export const MAX_RRULE_OCCURRENCES = 200;

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Expand a basic RRULE (FREQ=DAILY or FREQ=WEEKLY, with optional
 * INTERVAL/COUNT/UNTIL/BYDAY) into concrete occurrences.
 * Unknown or unsupported rules yield just the base occurrence.
 * Never throws; always capped at MAX_RRULE_OCCURRENCES.
 */
export function expandRecurrence(dtstart: string, dtend: string, rrule: string): IcsOccurrence[] {
  const base = { start: dtstart, end: dtend };
  const startMs = new Date(dtstart).getTime();
  const endMs = new Date(dtend).getTime();
  if (!rrule || isNaN(startMs) || isNaN(endMs) || endMs <= startMs) return [base];
  const parts: Record<string, string> = {};
  for (const kv of rrule.split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim().toUpperCase()] = kv.slice(i + 1).trim().toUpperCase();
  }
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY") return [base];
  const interval = Math.max(1, parseInt(parts.INTERVAL || "1", 10) || 1);
  const count = parts.COUNT ? Math.max(0, parseInt(parts.COUNT, 10) || 0) : 0;
  let untilMs = 0;
  if (parts.UNTIL) {
    if (/^\d{8}$/.test(parts.UNTIL)) {
      // Date-only UNTIL is inclusive through the end of that day.
      untilMs = Date.UTC(+parts.UNTIL.slice(0, 4), +parts.UNTIL.slice(4, 6) - 1, +parts.UNTIL.slice(6, 8)) + 86400000 - 1;
    } else {
      const u = parseIcsDate("", parts.UNTIL);
      untilMs = u ? new Date(u).getTime() : 0;
    }
  }
  const durationMs = endMs - startMs;
  const out: IcsOccurrence[] = [];
  const push = (ms: number) => {
    if (out.length >= MAX_RRULE_OCCURRENCES) return;
    out.push({ start: new Date(ms).toISOString(), end: new Date(ms + durationMs).toISOString() });
  };

  if (freq === "DAILY") {
    let ms = startMs, i = 0;
    const step = interval * 86400000;
    while (out.length < MAX_RRULE_OCCURRENCES) {
      if (count && i >= count) break;
      if (untilMs && ms > untilMs) break;
      push(ms);
      i++;
      ms += step;
      if (!count && !untilMs) break; // unbounded without a bound would loop forever
    }
    return out.length ? out : [base];
  }

  // WEEKLY: walk day by day; a day qualifies when its week block matches the
  // interval and its weekday is listed (default: the start's weekday).
  const startDay = new Date(startMs);
  const byday = (parts.BYDAY || WEEKDAYS[startDay.getUTCDay()]).split(",").map((d) => d.trim()).filter(Boolean);
  const dayMs = 86400000;
  const maxWalk = MAX_RRULE_OCCURRENCES * interval * 7 + 7;
  let added = 0;
  for (let d = 0; d < maxWalk && out.length < MAX_RRULE_OCCURRENCES; d++) {
    const ms = startMs + d * dayMs;
    if (untilMs && ms > untilMs) break;
    if (count && added >= count) break;
    const wk = Math.floor(d / 7);
    if (wk % interval !== 0) continue;
    if (!byday.includes(WEEKDAYS[new Date(ms).getUTCDay()])) continue;
    push(ms);
    added++;
    if (!count && !untilMs) break; // unbounded — one occurrence, like DAILY
  }
  return out.length ? out : [base];
}
