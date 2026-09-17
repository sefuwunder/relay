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
      }
    }
  } catch {
    /* best effort — a broken invite never breaks the poll */
  }
  return out;
}
