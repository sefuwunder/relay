// Conversation nudges: gentle, server-computed reminders that keep cadence
// flowing — unanswered threads, quiet threads, and Greenroom follow-ups.
// Follows the commitments-nudge pattern: computed on request (no timers),
// surfaced via GET /api/nudges on the client's 15s poll.

import {
  getDb,
  listConversations,
  isStagedMemberId,
  getStagedContact,
  listStagedContacts,
  type Contact,
} from "./db";

export interface Nudge {
  key: string; // "unanswered:<conv>" | "stale:<conv>" | "followup:<stagedId>"
  type: "unanswered" | "stale" | "staged_followup";
  conversation_id: string; // "" for staged_followup
  staged_id: string; // "" unless staged_followup
  title: string;
  body: string;
  days: number;
}

const DAY = 86400_000;
const nowMs = () => Date.now();

interface NudgeRow {
  key: string;
  snoozed_until: number;
  dismissed_until: number;
  last_fired_at: number;
}

function getState(key: string): NudgeRow | null {
  return (getDb().query("SELECT * FROM nudge_state WHERE key = ?").get(key) as NudgeRow) || null;
}

/** Stamp last_fired_at when a nudge is returned (idempotent per trigger window). */
function stampFired(key: string): void {
  const now = nowMs();
  getDb()
    .query(
      `INSERT INTO nudge_state (key, snoozed_until, dismissed_until, last_fired_at)
       VALUES (?, 0, 0, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = ?`
    )
    .run(key, now, now);
}

function suppressed(row: NudgeRow | null, now: number): boolean {
  if (!row) return false;
  return row.snoozed_until > now || row.dismissed_until > now;
}

/** Contact ids on a thread that are staged members ("staged:<id>"). */
function stagedMemberIds(conversationId: string): string[] {
  const rows = getDb()
    .query("SELECT contact_id FROM members WHERE conversation_id = ?")
    .all(conversationId) as { contact_id: string }[];
  return rows.map((r) => r.contact_id).filter(isStagedMemberId);
}

/** Latest inbound message time in a thread (0 when none). */
function latestInboundAt(conversationId: string): number {
  const r = getDb()
    .query("SELECT MAX(created_at) AS m FROM messages WHERE conversation_id = ? AND direction = 'in'")
    .get(conversationId) as { m: string | null };
  const t = r && r.m ? Date.parse(r.m) : NaN;
  return Number.isFinite(t) ? (t as number) : 0;
}

/** The single real contact on a 1:1 thread (null for groups / staged threads). */
function dmContact(conversationId: string): Contact | null {
  const rows = getDb()
    .query("SELECT contact_id FROM members WHERE conversation_id = ?")
    .all(conversationId) as { contact_id: string }[];
  const real = rows.map((r) => r.contact_id).filter((id) => !isStagedMemberId(id));
  if (real.length !== 1) return null;
  return (getDb().query("SELECT * FROM contacts WHERE id = ?").get(real[0]) as Contact) || null;
}

/** Conversation id of a staged contact's 1:1 thread ("" when none yet). */
function stagedThreadId(stagedId: string): string {
  const r = getDb()
    .query("SELECT conversation_id FROM members WHERE contact_id = ? LIMIT 1")
    .get(`staged:${stagedId}`) as { conversation_id: string } | null;
  return r ? r.conversation_id : "";
}

function hasOutbound(conversationId: string): boolean {
  if (!conversationId) return false;
  const r = getDb()
    .query("SELECT 1 FROM messages WHERE conversation_id = ? AND direction = 'out' LIMIT 1")
    .get(conversationId);
  return !!r;
}

const CADENCE_LABEL: Record<number, string> = { 3: "every 3 days", 14: "every 2 weeks", 30: "monthly" };

/** What the client's nudge check should surface right now. */
export function listNudges(): Nudge[] {
  const now = nowMs();
  const out: Nudge[] = [];
  // Threads where the unanswered nudge fired this pass: the stale nudge stays
  // quiet for them — one nudge per thread per pass, no piling up.
  const unansweredFired = new Set<string>();

  for (const c of listConversations(false)) {
    if (!c.last_at) continue;
    // Staged threads are covered by staged_followup only — never double-nudge.
    if (stagedMemberIds(c.id).length) continue;
    const lastAt = Date.parse(c.last_at);
    if (!Number.isFinite(lastAt)) continue;
    const daysSilent = Math.floor((now - lastAt) / DAY);
    const isGroup = !!c.is_group;
    // AI agents aren't people you owe replies to — no cadence nudges on 1:1s.
    const dm = isGroup ? null : dmContact(c.id);
    if (!isGroup && (!dm || dm.kind === "agent")) continue;

    // ---- unanswered: I sent the last message, 3+ days, no reply ----
    if (c.last_direction === "out" && now - lastAt >= 3 * DAY) {
      const key = `unanswered:${c.id}`;
      const row = getState(key);
      const latestInbound = latestInboundAt(c.id);
      const freshStreak = !row || !row.last_fired_at || row.last_fired_at < latestInbound;
      if (!suppressed(row, now) && freshStreak) {
        const name = isGroup ? c.name || "the group" : dm?.name || "them";
        out.push({
          key,
          type: "unanswered",
          conversation_id: c.id,
          staged_id: "",
          title: `Still waiting on ${name}?`,
          body: `${name} hasn't replied in ${daysSilent} days.`,
          days: daysSilent,
        });
        stampFired(key);
        unansweredFired.add(c.id);
      }
    }

    // ---- stale: nothing at all for the contact's cadence (groups: 7d) ----
    let cadence: number | null;
    let name: string;
    if (isGroup) {
      cadence = 7;
      name = c.name || "the group";
    } else {
      const contact = dm;
      if (!contact) continue;
      cadence = contact.cadence_days == null || contact.cadence_days === 0 ? null : contact.cadence_days;
      name = contact.name;
    }
    if (cadence && daysSilent >= cadence && !unansweredFired.has(c.id)) {
      const key = `stale:${c.id}`;
      const row = getState(key);
      // Refire after another full cadence window of continued silence.
      const due = !row || !row.last_fired_at || now - row.last_fired_at >= cadence * DAY;
      if (!suppressed(row, now) && due) {
        out.push({
          key,
          type: "stale",
          conversation_id: c.id,
          staged_id: "",
          title: `Quiet with ${name} lately.`,
          body: `It's been ${daysSilent} days since you talked to ${name}.`,
          days: daysSilent,
        });
        stampFired(key);
      }
    }
  }

  // ---- staged_followup: Greenroom contact, no outbound yet, staged 2+ days ago ----
  for (const s of listStagedContacts()) {
    if (s.status !== "staged") continue;
    const threadId = stagedThreadId(s.id);
    if (hasOutbound(threadId)) continue;
    const ageDays = Math.floor((now - s.created_at) / DAY);
    if (ageDays < 2) continue;
    const daysLeft = Math.ceil((s.expires_at - now) / DAY);
    const key = `followup:${s.id}`;
    const row = getState(key);
    // Refire once as expiry approaches (3 days out), if still no outbound.
    const due =
      !row ||
      !row.last_fired_at ||
      (daysLeft <= 3 && now - row.last_fired_at >= 3 * DAY);
    if (!suppressed(row, now) && due) {
      out.push({
        key,
        type: "staged_followup",
        conversation_id: threadId,
        staged_id: s.id,
        title: `Follow up with ${s.name}?`,
        body: `You haven't followed up with ${s.name} yet.`,
        days: ageDays,
      });
      stampFired(key);
    }
  }

  return out;
}

/** Snooze a nudge for N days (1–30). A lapsed snooze refires — snoozing
    means "remind me in N days", so the refire clock restarts from the lapse. */
export function snoozeNudge(key: string, days: number): NudgeRow {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1 || n > 30) throw new Error("Snooze 1–30 days.");
  assertNudgeTarget(key);
  const until = nowMs() + Math.round(n * DAY);
  getDb()
    .query(
      `INSERT INTO nudge_state (key, snoozed_until, dismissed_until, last_fired_at)
       VALUES (?, ?, 0, 0) ON CONFLICT(key) DO UPDATE SET snoozed_until = ?, last_fired_at = 0`
    )
    .run(key, until, until);
  return getState(key)!;
}

/**
 * Dismiss a nudge until its *next* natural trigger — never forever:
 * - stale → next cadence window
 * - unanswered → next unanswered streak (marks this streak handled)
 * - staged_followup → expiry (the follow-up window is over then anyway)
 */
export function dismissNudge(key: string): NudgeRow {
  const now = nowMs();
  const [type, id] = splitKey(key);
  const db = getDb();
  if (type === "stale") {
    const cadence = cadenceForConversation(id);
    if (!cadence) throw new Error("not found");
    const until = now + cadence * DAY;
    db.query(
      `INSERT INTO nudge_state (key, snoozed_until, dismissed_until, last_fired_at)
       VALUES (?, 0, ?, 0) ON CONFLICT(key) DO UPDATE SET dismissed_until = ?`
    ).run(key, until, until);
  } else if (type === "unanswered") {
    const c = db.query("SELECT id FROM conversations WHERE id = ?").get(id) as any;
    if (!c) throw new Error("not found");
    // Mark this streak handled: the next streak (a reply, then another
    // unanswered 3-day wait) fires fresh because latestInboundAt advances.
    db.query(
      `INSERT INTO nudge_state (key, snoozed_until, dismissed_until, last_fired_at)
       VALUES (?, 0, 0, ?) ON CONFLICT(key) DO UPDATE SET last_fired_at = ?`
    ).run(key, now, now);
  } else if (type === "followup") {
    const s = getStagedContact(id);
    if (!s) throw new Error("not found");
    const until = Math.max(s.expires_at, now + DAY);
    db.query(
      `INSERT INTO nudge_state (key, snoozed_until, dismissed_until, last_fired_at)
       VALUES (?, 0, ?, 0) ON CONFLICT(key) DO UPDATE SET dismissed_until = ?`
    ).run(key, until, until);
  } else {
    throw new Error("not found");
  }
  return getState(key)!;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(":");
  if (i < 0) throw new Error("not found");
  const type = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!["unanswered", "stale", "followup"].includes(type) || !id) throw new Error("not found");
  return [type, id];
}

/** Throw unless the key names a real nudge target. */
function assertNudgeTarget(key: string): void {
  const [type, id] = splitKey(key);
  const db = getDb();
  if (type === "followup") {
    if (!getStagedContact(id)) throw new Error("not found");
  } else {
    const c = db.query("SELECT id FROM conversations WHERE id = ?").get(id) as any;
    if (!c) throw new Error("not found");
  }
}

/** Cadence in days for a conversation (groups: 7; 1:1: the contact's setting). */
function cadenceForConversation(conversationId: string): number | null {
  const db = getDb();
  const c = db.query("SELECT is_group FROM conversations WHERE id = ?").get(conversationId) as any;
  if (!c) return null;
  if (c.is_group) return 7;
  const contact = dmContact(conversationId);
  if (!contact || contact.kind === "agent") return null;
  const v = contact.cadence_days;
  return v == null || v === 0 ? null : v;
}

/** Human label for the cadence picker. */
export function cadenceLabel(v: number | null | undefined): string {
  if (v == null || v === 0) return "Never";
  return CADENCE_LABEL[v] || "Weekly";
}
