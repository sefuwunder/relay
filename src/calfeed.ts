// Calendar feed (iCal secret-address) sync: fetch a VCALENDAR feed, match its
// events to contacts, and build import previews. Zero dependencies, offline
// except for the single feed fetch the user triggers manually.

import { parseIcs, expandRecurrence, type CalEvent } from "./ical";
import {
  listActiveContacts, findDmConversation, getAppointmentByUid,
  type Contact,
} from "./db";

/** Feed fetch timeout and response cap. */
export const FEED_TIMEOUT_MS = 15000;
export const FEED_MAX_BYTES = 5 * 1024 * 1024;

export type CalConfidence = "email" | "name" | "mention";

export interface CalMatch {
  contact_id: string;
  name: string;
  confidence: CalConfidence;
  conversation_id: string;
  conversation_name: string;
}

export interface CalPreviewEvent {
  /** Dedupe key: uid + "::" + occurrence start. Doubles as the appointment uid. */
  key: string;
  uid: string;
  summary: string;
  location: string;
  description: string;
  organizer: string;
  /** ISO UTC. */
  start: string;
  end: string;
  all_day: boolean;
  recurring: { index: number; total: number } | null;
  cancelled: boolean;
  already_imported: boolean;
  matches: CalMatch[];
  /** Conversation the entry would land in, "" when none. */
  import_conversation_id: string;
}

/** Stable dedupe key for one event occurrence. */
export function dedupeKey(uid: string, start: string): string {
  return `${uid}::${start}`;
}

/**
 * Fetch an iCal feed URL. Follows up to 5 same-scheme redirects, times out
 * after FEED_TIMEOUT_MS, and refuses bodies over FEED_MAX_BYTES.
 * The URL itself is never logged.
 */
export async function fetchIcalFeed(urlStr: string): Promise<string> {
  let first: URL;
  try {
    first = new URL(String(urlStr || "").trim());
  } catch {
    throw new Error("That doesn't look like a valid calendar URL.");
  }
  if (first.protocol !== "http:" && first.protocol !== "https:") {
    throw new Error("Calendar feed URLs must start with http(s).");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    let current = first.toString();
    for (let hop = 0; hop < 6; hop++) {
      let res: Response;
      try {
        res = await fetch(current, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "User-Agent": "relay-calendar/1.0", Accept: "text/calendar" },
        });
      } catch (e: any) {
        if (e && e.name === "AbortError") throw new Error("The calendar feed took too long to respond (15s timeout).");
        throw new Error("Couldn't reach the calendar feed — check the URL and your connection.");
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("The calendar feed redirected without a destination.");
        const next = new URL(loc, current);
        if (next.protocol !== first.protocol) {
          throw new Error("The calendar feed redirected to a different scheme — refusing to follow.");
        }
        current = next.toString();
        continue;
      }
      if (!res.ok) throw new Error(`The calendar feed returned HTTP ${res.status}.`);
      const reader = res.body ? res.body.getReader() : null;
      if (!reader) {
        const t = await res.text();
        if (t.length > FEED_MAX_BYTES) throw new Error("The calendar feed is too large (over 5 MB).");
        return t;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > FEED_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* noop */ }
          throw new Error("The calendar feed is too large (over 5 MB).");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    throw new Error("The calendar feed redirected too many times.");
  } finally {
    clearTimeout(timer);
  }
}

function norm(s: string): string {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

const CONF_RANK: Record<CalConfidence, number> = { email: 3, name: 2, mention: 1 };

/**
 * Match an event to the user's contacts. Confidence: an attendee/organizer
 * email matching the contact's email beats an exact name match, which beats
 * a name mentioned in the title/description. One entry per contact (best wins).
 */
export function matchContacts(ev: CalEvent): CalMatch[] {
  const contacts = listActiveContacts();
  const best = new Map<string, CalMatch>();
  const consider = (c: Contact, conf: CalConfidence) => {
    const cur = best.get(c.id);
    if (cur && CONF_RANK[conf] <= CONF_RANK[cur.confidence]) return;
    const conv = findDmConversation(c.id);
    best.set(c.id, {
      contact_id: c.id,
      name: c.name,
      confidence: conf,
      conversation_id: conv ? conv.id : "",
      conversation_name: conv ? conv.name || c.name : "",
    });
  };
  const emails = new Set(ev.attendees.map((a) => norm(a.email)).filter(Boolean));
  if (ev.organizer) emails.add(norm(ev.organizer));
  const cnSet = new Set(ev.attendees.map((a) => norm(a.cn)).filter(Boolean));
  const hay = norm([ev.summary, ev.description, ev.location].join(" \u0000 "));
  for (const c of contacts) {
    const cname = norm(c.name);
    const cemail = norm(c.email);
    if (!cname && !cemail) continue;
    if (cemail && emails.has(cemail)) { consider(c, "email"); continue; }
    if (cname.length >= 2 && cnSet.has(cname)) { consider(c, "name"); continue; }
    if (cname.length >= 3 && hay.includes(cname)) {
      consider(c, "mention");
    }
  }
  return [...best.values()].sort((a, b) => CONF_RANK[b.confidence] - CONF_RANK[a.confidence]);
}

/** Expand events (recurrences become one preview row each) with match info. */
export function previewFromEvents(events: CalEvent[]): CalPreviewEvent[] {
  const out: CalPreviewEvent[] = [];
  for (const ev of events) {
    const occs = expandRecurrence(ev.dtstart, ev.dtend, ev.rrule);
    const matches = matchContacts(ev);
    const cancelled = ev.status === "CANCELLED";
    const total = occs.length;
    const baseUid = ev.uid || `${ev.summary}|${ev.dtstart}`;
    occs.forEach((o, i) => {
      const key = dedupeKey(baseUid, o.start);
      const target = matches.length && matches[0].conversation_id ? matches[0].conversation_id : "";
      out.push({
        key,
        uid: ev.uid,
        summary: ev.summary,
        location: ev.location,
        description: ev.description,
        organizer: ev.organizer,
        start: o.start,
        end: o.end,
        all_day: ev.allDay,
        recurring: total > 1 ? { index: i + 1, total } : null,
        cancelled,
        already_imported: !!getAppointmentByUid(key),
        matches,
        import_conversation_id: target,
      });
    });
  }
  return out;
}

/** Parse feed text into preview rows; throws a friendly error when empty. */
export function previewFromFeedText(text: string): CalPreviewEvent[] {
  const events = parseIcs(text);
  if (!events.length) throw new Error("No calendar events found in this feed.");
  return previewFromEvents(events);
}
