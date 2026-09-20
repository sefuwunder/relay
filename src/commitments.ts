// Relay commitments tracker + decision log.
// Bun + zero deps. All deterministic and offline: regex heuristics plus a
// per-conversation learned-pattern loop. Nothing is ever auto-created —
// suggestions always wait for an explicit user Confirm.

import { getDb, uid, type Message } from "./db";
import { parseDateTime } from "./dates";

// ---------- local-day helpers ----------

/** Server-local calendar day as YYYY-MM-DD (the machine's own timezone). */
export function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local day of an ISO timestamp, for nudge cadence comparisons. */
export function localDayOf(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const nowIso = () => new Date().toISOString();

// ---------- types ----------

export interface Commitment {
  id: string;
  conversation_id: string;
  message_id: string;
  text: string;
  owner: string; // 'me' or a contact id
  due_date: string; // YYYY-MM-DD or ''
  due_time: string; // HH:MM or ''
  status: string; // open | done | dismissed
  source: string; // manual | suggested
  last_nudged_at: string;
  created_at: string;
}

export interface Decision {
  id: string;
  conversation_id: string;
  message_id: string;
  text: string;
  participants: string; // JSON array of 'me' + contact ids
  decided_at: string;
  source: string;
  created_at: string;
}

export interface Suggestion {
  id: string;
  conversation_id: string;
  message_id: string;
  class: string; // 'commitment' | 'decision'
  reason: string; // "Suggested because: …" transparency line
  due_date: string;
  due_time: string;
  created_at: string;
}

interface Pattern {
  pattern: string;
  class: string;
  scope: string;
  confirms: number;
  dismissals: number;
  retired: string;
  first_seen: string;
  last_seen: string;
}

// ---------- commitments ----------

const VALID_OWNERS = () => true; // owner is 'me' or any contact id; validated at the route layer

export function createCommitment(c: {
  conversation_id: string; message_id?: string; text: string; owner?: string;
  due_date?: string; due_time?: string; source?: string;
}): Commitment {
  const text = c.text.trim().slice(0, 500);
  if (!text) throw new Error("Give the commitment some text.");
  if (c.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(c.due_date)) throw new Error("Bad due date.");
  if (c.due_time && !/^\d{2}:\d{2}$/.test(c.due_time)) throw new Error("Bad due time.");
  const row: Commitment = {
    id: uid(),
    conversation_id: c.conversation_id,
    message_id: c.message_id || "",
    text,
    owner: c.owner || "me",
    due_date: c.due_date || "",
    due_time: c.due_time || "",
    status: "open",
    source: c.source === "suggested" ? "suggested" : "manual",
    last_nudged_at: "",
    created_at: nowIso(),
  };
  getDb().query(`INSERT INTO commitments
    (id, conversation_id, message_id, text, owner, due_date, due_time, status, source, last_nudged_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.conversation_id, row.message_id, row.text, row.owner, row.due_date,
    row.due_time, row.status, row.source, row.last_nudged_at, row.created_at);
  return row;
}

export function getCommitment(id: string): Commitment | null {
  return (getDb().query("SELECT * FROM commitments WHERE id = ?").get(id) as Commitment) || null;
}

export function listCommitments(convId: string, q = "", status = ""): Commitment[] {
  let sql = "SELECT * FROM commitments WHERE conversation_id = ?";
  const args: any[] = [convId];
  if (status) { sql += " AND status = ?"; args.push(status); }
  if (q) { sql += " AND text LIKE ? ESCAPE '\\'"; args.push("%" + q.replace(/[\\%_]/g, (x) => "\\" + x) + "%"); }
  sql += " ORDER BY CASE WHEN due_date = '' THEN 1 ELSE 0 END, due_date, created_at DESC";
  return getDb().query(sql).all(...args) as Commitment[];
}

const TRANSITIONS: Record<string, string[]> = {
  open: ["done", "dismissed"],
  done: ["open"],
  dismissed: ["open"],
};

export function patchCommitment(id: string, patch: Partial<Pick<Commitment, "text" | "owner" | "due_date" | "due_time" | "status">>): Commitment | null {
  const cur = getCommitment(id);
  if (!cur) return null;
  const next = { ...cur };
  if (patch.text !== undefined) {
    const t = patch.text.trim().slice(0, 500);
    if (!t) throw new Error("Give the commitment some text.");
    next.text = t;
  }
  if (patch.owner !== undefined) next.owner = patch.owner || "me";
  if (patch.due_date !== undefined) {
    if (patch.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.due_date)) throw new Error("Bad due date.");
    if (patch.due_date !== cur.due_date) next.last_nudged_at = ""; // due again on the new date
    next.due_date = patch.due_date || "";
  }
  if (patch.due_time !== undefined) {
    if (patch.due_time && !/^\d{2}:\d{2}$/.test(patch.due_time)) throw new Error("Bad due time.");
    next.due_time = patch.due_time || "";
  }
  if (patch.status !== undefined && patch.status !== cur.status) {
    if (!(TRANSITIONS[cur.status] || []).includes(patch.status)) {
      throw new Error(`Can't move a commitment from ${cur.status} to ${patch.status}.`);
    }
    next.status = patch.status;
  }
  getDb().query(
    "UPDATE commitments SET text = ?, owner = ?, due_date = ?, due_time = ?, status = ?, last_nudged_at = ? WHERE id = ?"
  ).run(next.text, next.owner, next.due_date, next.due_time, next.status, next.last_nudged_at, id);
  return getCommitment(id);
}

export function deleteCommitment(id: string): boolean {
  return getDb().query("DELETE FROM commitments WHERE id = ?").run(id).changes > 0;
}

/** What the poller should nudge right now: open, dated, due today or past,
    and not already nudged today (local calendar days). */
export function listDueCommitments(): Commitment[] {
  const today = localDay();
  const rows = getDb().query(
    "SELECT * FROM commitments WHERE status = 'open' AND due_date != '' AND due_date <= ? ORDER BY due_date"
  ).all(today) as Commitment[];
  return rows.filter((r) => !r.last_nudged_at || localDayOf(r.last_nudged_at) < today);
}

export function recordNudge(id: string): Commitment | null {
  getDb().query("UPDATE commitments SET last_nudged_at = ? WHERE id = ?").run(nowIso(), id);
  return getCommitment(id);
}

/** Global open-commitment view across conversations. */
export function listAllCommitments(q = "", includeArchived = false): (Commitment & { conversation_title: string; archived: number })[] {
  let sql = `SELECT c.*, conv.archived AS archived,
      COALESCE(NULLIF(conv.name, ''), (SELECT co.name FROM contacts co JOIN members m ON m.contact_id = co.id WHERE m.conversation_id = conv.id ORDER BY co.name LIMIT 1), 'Conversation') AS conversation_title
    FROM commitments c JOIN conversations conv ON conv.id = c.conversation_id
    WHERE c.status = 'open'`;
  const args: any[] = [];
  if (!includeArchived) sql += " AND conv.archived = 0";
  if (q) { sql += " AND c.text LIKE ? ESCAPE '\\'"; args.push("%" + q.replace(/[\\%_]/g, (x) => "\\" + x) + "%"); }
  sql += " ORDER BY CASE WHEN c.due_date = '' THEN 1 ELSE 0 END, c.due_date, c.created_at DESC";
  return getDb().query(sql).all(...args) as any[];
}

// ---------- decisions ----------

export function createDecision(d: {
  conversation_id: string; message_id?: string; text: string; participants?: string[]; source?: string; decided_at?: string;
}): Decision {
  const text = d.text.trim().slice(0, 500);
  if (!text) throw new Error("Give the decision some text.");
  let decidedAt = nowIso();
  if (d.decided_at) {
    const parsed = new Date(d.decided_at);
    if (isNaN(parsed.getTime())) throw new Error("That decision date doesn't parse.");
    decidedAt = parsed.toISOString();
  }
  const row: Decision = {
    id: uid(),
    conversation_id: d.conversation_id,
    message_id: d.message_id || "",
    text,
    participants: JSON.stringify(d.participants && d.participants.length ? [...new Set(d.participants)] : ["me"]),
    decided_at: decidedAt,
    source: d.source === "suggested" ? "suggested" : "manual",
    created_at: nowIso(),
  };
  getDb().query(`INSERT INTO decisions
    (id, conversation_id, message_id, text, participants, decided_at, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.conversation_id, row.message_id, row.text, row.participants,
    row.decided_at, row.source, row.created_at);
  return row;
}

export function getDecision(id: string): Decision | null {
  return (getDb().query("SELECT * FROM decisions WHERE id = ?").get(id) as Decision) || null;
}

export function listDecisions(convId: string, q = ""): Decision[] {
  let sql = "SELECT * FROM decisions WHERE conversation_id = ?";
  const args: any[] = [convId];
  if (q) { sql += " AND text LIKE ? ESCAPE '\\'"; args.push("%" + q.replace(/[\\%_]/g, (x) => "\\" + x) + "%"); }
  sql += " ORDER BY decided_at DESC, created_at DESC";
  return getDb().query(sql).all(...args) as Decision[];
}

export function patchDecision(id: string, patch: Partial<Pick<Decision, "text" | "participants" | "decided_at">>): Decision | null {
  const cur = getDecision(id);
  if (!cur) return null;
  const next = { ...cur };
  if (patch.text !== undefined) {
    const t = patch.text.trim().slice(0, 500);
    if (!t) throw new Error("Give the decision some text.");
    next.text = t;
  }
  if (patch.participants !== undefined) {
    next.participants = JSON.stringify([...new Set(patch.participants)].filter(Boolean));
  }
  if (patch.decided_at !== undefined) {
    const d = new Date(patch.decided_at);
    if (isNaN(d.getTime())) throw new Error("That decision date doesn't parse.");
    next.decided_at = d.toISOString();
  }
  getDb().query("UPDATE decisions SET text = ?, participants = ?, decided_at = ? WHERE id = ?").run(next.text, next.participants, next.decided_at, id);
  return getDecision(id);
}

export function deleteDecision(id: string): boolean {
  return getDb().query("DELETE FROM decisions WHERE id = ?").run(id).changes > 0;
}

export function listAllDecisions(q = "", includeArchived = false): (Decision & { conversation_title: string; archived: number })[] {
  let sql = `SELECT d.*, conv.archived AS archived,
      COALESCE(NULLIF(conv.name, ''), (SELECT co.name FROM contacts co JOIN members m ON m.contact_id = co.id WHERE m.conversation_id = conv.id ORDER BY co.name LIMIT 1), 'Conversation') AS conversation_title
    FROM decisions d JOIN conversations conv ON conv.id = d.conversation_id`;
  const params: any[] = [];
  if (!includeArchived) sql += " WHERE conv.archived = 0";
  if (q) {
    const like = "%" + q.replace(/[\\%_]/g, (x) => "\\" + x) + "%";
    sql += (includeArchived ? " WHERE " : " AND ") + "(d.text LIKE ? ESCAPE '\\' OR d.participants LIKE ? ESCAPE '\\')";
    params.push(like, like);
  }
  sql += " ORDER BY d.decided_at DESC, d.created_at DESC";
  return getDb().query(sql).all(...params) as any[];
}

// ---------- suggestions ----------

export function createSuggestion(s: {
  conversation_id: string; message_id: string; class: string;
  reason: string; due_date?: string; due_time?: string;
}): Suggestion | null {
  const db = getDb();
  // Idempotent: one suggestion per message per class.
  const dup = db.query("SELECT 1 FROM suggestions WHERE message_id = ? AND class = ? LIMIT 1").get(s.message_id, s.class);
  if (dup) return null;
  const row: Suggestion = {
    id: uid(),
    conversation_id: s.conversation_id,
    message_id: s.message_id,
    class: s.class,
    reason: s.reason.slice(0, 500),
    due_date: s.due_date || "",
    due_time: s.due_time || "",
    created_at: nowIso(),
  };
  db.query(`INSERT INTO suggestions
    (id, conversation_id, message_id, class, reason, due_date, due_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.conversation_id, row.message_id, row.class, row.reason,
    row.due_date, row.due_time, row.created_at);
  return row;
}

export function getSuggestion(id: string): Suggestion | null {
  return (getDb().query("SELECT * FROM suggestions WHERE id = ?").get(id) as Suggestion) || null;
}

export function listSuggestions(convId: string): (Suggestion & { body: string; direction: string })[] {
  return getDb().query(
    `SELECT s.*, m.body AS body, m.direction AS direction
     FROM suggestions s LEFT JOIN messages m ON m.id = s.message_id
     WHERE s.conversation_id = ? ORDER BY s.created_at DESC`
  ).all(convId) as any[];
}

export function deleteSuggestion(id: string): void {
  getDb().query("DELETE FROM suggestions WHERE id = ?").run(id);
}

/** Drop suggestions older than 7 days. Returns the number removed. */
export function sweepExpiredSuggestions(): number {
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  return getDb().query("DELETE FROM suggestions WHERE created_at < ?").run(cutoff).changes;
}

// ---------- deterministic heuristics ----------

// [regex, anchor label, strong]. Weak verbs ("let me", "i can") only reach
// the suggestion bar with a date token or a learned-pattern boost —
// "let me know what you think" is not a promise.
const COMMIT_VERBS: [RegExp, string, boolean][] = [
  [/\bi'?ll\s+take\s+care\s+of\b/i, "i'll take care of", true],
  [/\bi'?ll\s+promise\s+to\b/i, "i promise to", true],
  [/\b(i'?ll|i\s+will)\s+send\b/i, "i'll send", true],
  [/\b(i'?ll|i\s+will)\s+get\b/i, "i'll get", true],
  [/\b(i'?ll|i\s+will)\s+call\b/i, "i'll call", true],
  [/\b(i'?ll|i\s+will)\s+book\b/i, "i'll book", true],
  [/\b(i'?ll|i\s+will)\s+confirm\b/i, "i'll confirm", true],
  [/\b(i'?ll|i\s+will)\s+handle\b/i, "i'll handle", true],
  [/\b(i'?ll|i\s+will)\b/i, "i'll", true],
  [/\bi\s+promise\s+to\b/i, "i promise to", true],
  [/\blet\s+me\b/i, "let me", false],
  [/\bleave\s+it\s+with\s+me\b/i, "leave it with me", true],
  [/\bi\s+owe\s+you\b/i, "i owe you", true],
  [/\bi\s+can\b/i, "i can", false],
];

const DECISION_PHRASES: [RegExp, string][] = [
  [/\bwe'?re\s+going\s+with\b/i, "we're going with"],
  [/\bit'?s\s+decided\b/i, "it's decided"],
  [/\bwe\s+agreed\b/i, "we agreed"],
  [/\bwe\s+decided\b/i, "we decided"],
  [/\bfinal\s+decision\b/i, "final decision"],
  [/\bdecision\s*:/i, "decision:"],
  [/\bsettled\b/i, "settled"],
  [/\bconfirmed\b/i, "confirmed"],
  [/\blocked\s+in\b/i, "locked in"],
  [/\bagreed\b/i, "agreed"],
];

const DATE_TOKEN = /\b(tomorrow|today|tonight|next\s+week|in\s+\d+\s+days?|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+\w+\s+\d{1,2}|by\s+\d{1,2}\s*(am|pm)?)\b/i;
const TIME_TOKEN = /\b(\d{1,2}\s*(am|pm)|\d{1,2}:\d{2}|noon|midnight|morning|afternoon|evening)\b/i;
const AGREEMENT_TOKEN = /\b(yes|perfect|sounds good|works for me|agreed|love it|do it)\b/i;

/** Strip quote-reply blocks before analysis. */
export function stripQuotes(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/^(-{2,}.*|_{2,})\s*$/gm, "")
    .trim();
}

/** Exclusion checks: too short, URL-only, or a bare question. */
function excluded(body: string, hasCommitVerb: boolean): boolean {
  const t = body.trim();
  if (t.length < 10) return true;
  if (/^\s*https?:\/\/\S+\s*$/.test(t)) return true;
  if (/\?\s*$/.test(t) && !hasCommitVerb) return true;
  return false;
}

/** Extract a due date/time from free text. Returns local calendar values.
    Times are only extracted when explicitly stated — never guessed. */
export function extractDue(text: string): { due_date: string; due_time: string; matched: string } {
  let parsed: { start: string; end: string; matchedText: string } | null = null;
  try { parsed = parseDateTime(text); } catch { parsed = null; }
  if (!parsed || !parsed.matchedText) return { due_date: "", due_time: "", matched: "" };
  const start = new Date(parsed.start);
  if (isNaN(start.getTime())) return { due_date: "", due_time: "", matched: "" };
  const p = (n: number) => String(n).padStart(2, "0");
  const due_date = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`;
  // A time counts as explicit only when the matched text carries a time token.
  const due_time = TIME_TOKEN.test(parsed.matchedText)
    ? `${p(start.getHours())}:${p(start.getMinutes())}`
    : "";
  return { due_date, due_time, matched: parsed.matchedText };
}

// ---------- adaptive learning loop ----------

/** Expand common contractions so templates and anchor phrases are stable. */
function expandContractions(s: string): string {
  return s
    .replace(/\bi'll\b/g, " i will ")
    .replace(/\bit's\b/g, " it is ")
    .replace(/\bwe're\b/g, " we are ")
    .replace(/\bn't\b/g, " not ")
    .replace(/\b've\b/g, " have ")
    .replace(/\b'd\b/g, " would ")
    .replace(/\b'm\b/g, " am ")
    .replace(/\b're\b/g, " are ");
}

/**
 * Derive a templated n-gram signature from a message. Never stores raw text:
 * dates/times → {WHEN}, numbers → {NUM}, contact names and quoted spans → {X}.
 *
 * The core is verb-led: the heuristic verb/decision phrase (or the message
 * start when there is none) plus placeholders for everything else. The only
 * literal words ever kept are the anchor phrase itself and a small closed
 * list of pronouns/demonstratives — no content words, names, dates, or
 * numbers survive, so a signature can never reconstruct the message.
 *
 * Example: "I'll send the contract tomorrow, Danyetta"
 *   → "i will send {X} {WHEN}"
 */
export function deriveSignature(text: string, contactNames: string[] = []): string {
  // ZZ sentinels survive the punctuation strip below, then map back to
  // placeholders — so braces never pass through the strip step.
  let s = " " + expandContractions(text.toLowerCase()) + " ";
  // Dates/times → sentinel: prefer the real parser's matched span, then fall
  // back to bare date words it may have missed.
  try {
    const parsed = parseDateTime(text);
    if (parsed && parsed.matchedText) {
      const idx = s.indexOf(parsed.matchedText.toLowerCase());
      if (idx >= 0) s = s.slice(0, idx) + " zzwhenzz " + s.slice(idx + parsed.matchedText.length);
    }
  } catch { /* parser is best-effort */ }
  s = s.replace(/\b(today|tonight|tomorrow|day after tomorrow|next week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/g, " zzwhenzz ");
  s = s.replace(/\b\d+(\.\d+)?\b/g, " zznumzz ");
  // Quoted spans and contact names → {X} (longest names first).
  s = s.replace(/"[^"]*"|'[^']*'/g, " zzxxzz ");
  for (const n of [...contactNames].sort((a, b) => b.length - a.length)) {
    const nn = n.trim().toLowerCase();
    if (nn.length < 2) continue;
    s = s.split(nn).join(" zzxxzz ");
  }
  const tokens = s
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === "zzwhenzz" ? "{WHEN}" : t === "zznumzz" ? "{NUM}" : t === "zzxxzz" ? "{X}" : t));
  if (!tokens.length) return "";
  // Anchor: earliest heuristic verb/decision phrase, else the message start.
  // Labels are contraction-expanded to match the normalized text above.
  let anchorAt = 0, anchorLen = 1;
  const joined = " " + tokens.join(" ") + " ";
  const phrases: string[] = [
    ...COMMIT_VERBS.map(([, label]) => expandContractions(label).replace(/\s+/g, " ").trim()),
    ...DECISION_PHRASES.map(([, label]) => expandContractions(label).replace(/\s+/g, " ").trim()),
  ].sort((a, b) => b.length - a.length);
  // Earliest phrase wins; ties (same start) resolve to the longest phrase
  // because `phrases` is sorted longest-first.
  let found = false;
  for (const ph of phrases) {
    const i = joined.indexOf(" " + ph + " ");
    if (i < 0) continue;
    const at = joined.slice(0, i).trim().split(/\s+/).filter(Boolean).length;
    if (!found || at < anchorAt) {
      found = true;
      anchorAt = at;
      anchorLen = ph.split(" ").length;
    }
  }
  // When nothing matched, anchorAt stays 0 and anchorLen 1 (message start).
  const isPh = (t: string) => /^\{(WHEN|NUM|X)\}$/.test(t);
  // Closed literal list: pronouns and demonstratives only. Everything else
  // generalizes to {X}, so no content word ever lands in the store.
  const LITERAL_OK = new Set([
    "me", "you", "him", "her", "us", "them", "it",
    "my", "your", "his", "its", "our", "their",
    "this", "that", "these", "those", "here", "there",
  ]);
  const core: string[] = [];
  for (let i = anchorAt; i < tokens.length && core.length < 6; i++) {
    const t = tokens[i];
    const inAnchor = i < anchorAt + anchorLen;
    if (inAnchor) { core.push(t); continue; }
    if (isPh(t)) { if (!core.includes(t)) core.push(t); continue; }
    if (LITERAL_OK.has(t)) { core.push(t); continue; }
    if (core[core.length - 1] !== "{X}") core.push("{X}");
  }
  // Placeholders seen past the core window still join, deduped.
  for (let i = anchorAt + core.length; i < tokens.length; i++) {
    const t = tokens[i];
    if (isPh(t) && !core.includes(t)) core.push(t);
  }
  return core.join(" ").trim();
}

const DAY_MS = 86400_000;

/**
 * Decayed pattern weight. Signals older than 90 days count at half weight per
 * full 90-day bucket since last_seen (recomputed lazily on read):
 *   score = laplace(confirms, dismissals) × 0.5^buckets
 * where laplace = (c+1)/(c+d+2). The decay multiplies the smoothed weight so a
 * pattern untouched for >180 days scores at most a quarter of its fresh
 * weight — old phrasings must earn their suggestions again.
 */
export function patternScore(p: Pattern, nowMs = Date.now()): number {
  const last = Date.parse(p.last_seen);
  const buckets = Number.isFinite(last) ? Math.max(0, Math.floor((nowMs - last) / (90 * DAY_MS))) : 0;
  const w = (p.confirms + 1) / (p.confirms + p.dismissals + 2);
  return w * Math.pow(0.5, buckets);
}

function getPattern(pattern: string, cls: string, scope: string): Pattern | null {
  return (getDb().query(
    "SELECT * FROM language_patterns WHERE pattern = ? AND class = ? AND scope = ?"
  ).get(pattern, cls, scope) as Pattern) || null;
}

function upsertPattern(pattern: string, cls: string, scope: string, kind: "confirm" | "dismiss"): Pattern {
  const db = getDb();
  const cur = getPattern(pattern, cls, scope);
  if (!cur) {
    const row: Pattern = {
      pattern, class: cls, scope,
      confirms: kind === "confirm" ? 1 : 0,
      dismissals: kind === "dismiss" ? 1 : 0,
      retired: kind === "dismiss" ? "" : "",
      first_seen: nowIso(), last_seen: nowIso(),
    };
    // A single first dismissal can't retire a brand-new pattern.
    db.query(`INSERT INTO language_patterns
      (pattern, class, scope, confirms, dismissals, retired, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.pattern, row.class, row.scope, row.confirms, row.dismissals,
      row.retired, row.first_seen, row.last_seen);
    return getPattern(pattern, cls, scope)!;
  }
  const confirms = cur.confirms + (kind === "confirm" ? 1 : 0);
  const dismissals = cur.dismissals + (kind === "dismiss" ? 1 : 0);
  let retired = cur.retired;
  if (kind === "dismiss" && dismissals >= 3 && !retired) {
    retired = nowIso(); // ≥3 dismissals retires the pattern
  } else if (kind === "confirm" && retired && confirms >= 6) {
    // Retired patterns need double the confirms (≥6) to return.
    retired = "";
  }
  db.query("UPDATE language_patterns SET confirms = ?, dismissals = ?, retired = ?, last_seen = ? WHERE pattern = ? AND class = ? AND scope = ?")
    .run(confirms, dismissals, retired, nowIso(), pattern, cls, scope);
  return getPattern(pattern, cls, scope)!;
}

/** Promote a phrasing to the global fallback once ≥2 conversations confirm it. */
function maybePromoteGlobal(pattern: string, cls: string): void {
  const db = getDb();
  const rows = db.query(
    "SELECT scope, confirms, dismissals FROM language_patterns WHERE pattern = ? AND class = ? AND scope != ''"
  ).all(pattern, cls) as { scope: string; confirms: number; dismissals: number }[];
  const withConfirms = rows.filter((r) => r.confirms > 0);
  if (withConfirms.length < 2) return;
  const confirms = withConfirms.reduce((a, r) => a + r.confirms, 0);
  const dismissals = rows.reduce((a, r) => a + r.dismissals, 0);
  const cur = getPattern(pattern, cls, "");
  if (!cur) {
    db.query(`INSERT INTO language_patterns
      (pattern, class, scope, confirms, dismissals, retired, first_seen, last_seen)
      VALUES (?, ?, '', ?, ?, '', ?, ?)`).run(pattern, cls, confirms, dismissals, nowIso(), nowIso());
  } else {
    let retired = cur.retired;
    if (dismissals >= 3) retired = retired || nowIso();
    db.query("UPDATE language_patterns SET confirms = ?, dismissals = ?, retired = ?, last_seen = ? WHERE pattern = ? AND class = ? AND scope = ''")
      .run(confirms, dismissals, retired, nowIso(), pattern, cls);
  }
}

/**
 * Record a labeled signal for a message: confirm (+1) or dismissal (+1) on
 * the message's derived signature, scoped to the conversation, plus the
 * shared-phrasing global promotion.
 */
export function recordFeedback(opts: {
  text: string; class: "commitment" | "decision"; conversationId: string;
  contactNames?: string[]; kind: "confirm" | "dismiss";
}): string {
  const sig = deriveSignature(opts.text, opts.contactNames || []);
  if (!sig) return "";
  upsertPattern(sig, opts.class, opts.conversationId, opts.kind);
  if (opts.kind === "confirm") maybePromoteGlobal(sig, opts.class);
  else {
    // Keep the global aggregate honest after a dismissal too.
    const g = getPattern(sig, opts.class, "");
    if (g) maybePromoteGlobal(sig, opts.class);
  }
  return sig;
}

// ---------- message analysis ----------

export interface Analysis {
  class: "commitment" | "decision";
  reason: string;
  due_date: string;
  due_time: string;
  matched: string;
}

export interface AnalysisCtx {
  conversationId: string;
  conversationName: string;
  direction: "in" | "out";
  memberNames: string[];
  memberCount: number; // contacts in the conversation (excludes the user)
  recentMessages: { direction: string; body: string; created_at: string }[];
}

/** Run the heuristics + learned patterns over one message. Null = no suggestion. */
export function analyzeMessage(body: string, ctx: AnalysisCtx): Analysis | null {
  const clean = stripQuotes(body);
  // Pre-scan for a commitment verb so ?-questions with one still pass.
  const verbHit = COMMIT_VERBS.find(([re]) => re.test(clean));
  if (excluded(clean, !!verbHit)) return null;

  // Learned patterns, evaluated before the heuristics: a pattern with ≥3
  // confirms and a fresh-enough score suggests independently of any verb.
  // Scoped patterns win; the global fallback applies only when no scoped
  // pattern covers this signature in this conversation.
  const sig = deriveSignature(clean, ctx.memberNames);
  const db = getDb();
  const rows = sig ? db.query(
    "SELECT * FROM language_patterns WHERE pattern = ? AND class IN ('commitment','decision') AND (scope = ? OR scope = '')"
  ).all(sig, ctx.conversationId) as Pattern[] : [];
  const scopedCover = rows.some((p) => p.scope === ctx.conversationId);
  const firing = rows.filter((p) => !p.retired &&
    (p.scope === ctx.conversationId || (p.scope === "" && !scopedCover)));
  let best: Pattern | null = null;
  for (const p of firing) {
    if (!best || patternScore(p) > patternScore(best)) best = p;
  }
  // Independent learned suggestion: ≥3 confirms, fresh score, not retired.
  const learned = firing.find((p) => p.confirms >= 3 && patternScore(p) >= 0.75) || null;

  let cls: "commitment" | "decision" | null = null;
  let matched = "";
  let base = 0;
  const decHit = DECISION_PHRASES.find(([re]) => re.test(clean));
  if (verbHit) {
    cls = "commitment";
    matched = verbHit[1];
    // Weak verbs ("let me", "i can") need a date token to reach the bar alone.
    base = (verbHit[2] ? 0.5 : 0.25) + (DATE_TOKEN.test(clean) ? 0.25 : 0);
  } else if (decHit) {
    // Conservative on decisions: need ≥2 participants, an agreement reply,
    // or a learned decision pattern the user already validated here.
    const agreed = ctx.recentMessages.some(
      (m) => m.direction !== ctx.direction && AGREEMENT_TOKEN.test(m.body || "")
    );
    if (ctx.memberCount < 2 && !agreed && !(learned && learned.class === "decision")) return null;
    cls = "decision";
    matched = decHit[1];
    base = 0.6;
  }
  const independent = !cls && learned;
  if (!cls) {
    if (!learned) return null;
    cls = learned.class as "commitment" | "decision";
    matched = learned.pattern;
  }

  // Learned boost on top of a heuristic hit.
  let learnedScore = 0;
  for (const p of firing) {
    if (p.class === cls) learnedScore += patternScore(p);
  }
  if (!(base + learnedScore >= 0.5 || independent)) return null;

  let due_date = "", due_time = "";
  if (cls === "commitment") {
    const d = extractDue(clean);
    due_date = d.due_date;
    due_time = d.due_time;
  }
  const where = (p: Pattern) =>
    p.scope ? `in ${ctx.conversationName || "this conversation"}` : "across conversations";
  let reason: string;
  if (independent && learned) {
    reason = `Suggested because of your phrasing \u201c${learned.pattern}\u201d \u2014 learned from your phrasing (${learned.confirms}\u00d7 confirmed ${where(learned)})`;
  } else {
    reason = `Suggested because you wrote \u201c${matched}\u201d`;
    if (best && best.class === cls && best.confirms > 0) {
      reason += ` \u2014 learned from your phrasing \u201c${best.pattern}\u201d (${best.confirms}\u00d7 confirmed ${where(best)})`;
    }
  }
  return { class: cls, reason, due_date, due_time, matched };
}

/**
 * Analyze a freshly stored message and persist a suggestion when the
 * heuristics + learned patterns fire. Never creates commitments/decisions.
 */
export function trackMessage(m: Message): Suggestion | null {
  const db = getDb();
  const conv = db.query("SELECT id, name, is_group FROM conversations WHERE id = ?").get(m.conversation_id) as any;
  if (!conv) return null;
  // A failed send never left the device — suggesting its text back is noise.
  if ((m.status || "") === "failed") return null;
  // Don't re-suggest what's already suggested or already recorded.
  const already = db.query(
    "SELECT 1 FROM suggestions WHERE message_id = ? LIMIT 1"
  ).get(m.id) ||
    db.query("SELECT 1 FROM commitments WHERE message_id = ? LIMIT 1").get(m.id) ||
    db.query("SELECT 1 FROM decisions WHERE message_id = ? LIMIT 1").get(m.id);
  if (already) return null;
  const members = db.query(
    "SELECT c.name FROM contacts c JOIN members mm ON mm.contact_id = c.id WHERE mm.conversation_id = ?"
  ).all(m.conversation_id) as { name: string }[];
  const recent = db.query(
    "SELECT direction, body, created_at FROM messages WHERE conversation_id = ? AND created_at >= datetime('now', '-1 day') ORDER BY created_at DESC LIMIT 20"
  ).all(m.conversation_id) as { direction: string; body: string; created_at: string }[];
  const title = conv.is_group ? conv.name : members[0]?.name || "Conversation";
  const a = analyzeMessage(m.body || "", {
    conversationId: m.conversation_id,
    conversationName: title,
    direction: m.direction as "in" | "out",
    memberNames: members.map((x) => x.name),
    memberCount: members.length,
    recentMessages: recent,
  });
  if (!a) return null;
  return createSuggestion({
    conversation_id: m.conversation_id,
    message_id: m.id,
    class: a.class,
    reason: a.reason,
    due_date: a.due_date,
    due_time: a.due_time,
  });
}

// ---------- confirm / dismiss ----------

/** Confirm a suggestion: create the record and teach the pattern loop. */
export function confirmSuggestion(id: string, opts: {
  text?: string; owner?: string; due_date?: string; due_time?: string; participants?: string[]; decided_at?: string;
}): Commitment | Decision {
  const s = getSuggestion(id);
  if (!s) throw new Error("Suggestion not found.");
  const db = getDb();
  const msg = db.query("SELECT * FROM messages WHERE id = ?").get(s.message_id) as Message | null;
  const members = db.query(
    "SELECT c.id, c.name FROM contacts c JOIN members mm ON mm.contact_id = c.id WHERE mm.conversation_id = ?"
  ).all(s.conversation_id) as { id: string; name: string }[];
  const names = members.map((x) => x.name);
  // Feedback first: the message's signature earns a confirm.
  if (msg) {
    recordFeedback({
      text: msg.body || s.reason, class: s.class as "commitment" | "decision",
      conversationId: s.conversation_id, contactNames: names, kind: "confirm",
    });
  }
  let rec: Commitment | Decision;
  if (s.class === "decision") {
    rec = createDecision({
      conversation_id: s.conversation_id,
      message_id: s.message_id,
      text: (opts.text ?? (msg ? msg.body : "")).slice(0, 500),
      participants: opts.participants || ["me", ...members.map((x) => x.id)],
      decided_at: opts.decided_at,
      source: "suggested",
    });
  } else {
    rec = createCommitment({
      conversation_id: s.conversation_id,
      message_id: s.message_id,
      text: (opts.text ?? (msg ? msg.body : "")).slice(0, 500),
      owner: opts.owner ?? (msg && msg.direction === "in" ? memberOwner(msg, members) : "me"),
      due_date: opts.due_date ?? s.due_date,
      due_time: opts.due_time ?? s.due_time,
      source: "suggested",
    });
  }
  deleteSuggestion(id);
  return rec;
}

/** Best-effort owner for an inbound commitment: the sender when identifiable. */
function memberOwner(msg: Message, members: { id: string; name: string }[]): string {
  try {
    const parts = JSON.parse(msg.participants || "[]") as string[];
    const hit = members.find((m) => parts.includes(m.id));
    if (hit) return hit.id;
  } catch { /* fall through */ }
  return members[0]?.id || "me";
}

/** Dismiss a suggestion: teach the pattern loop, then drop it. */
export function dismissSuggestion(id: string): void {
  const s = getSuggestion(id);
  if (!s) throw new Error("Suggestion not found.");
  const db = getDb();
  const msg = db.query("SELECT * FROM messages WHERE id = ?").get(s.message_id) as Message | null;
  const members = db.query(
    "SELECT c.name FROM contacts c JOIN members mm ON mm.contact_id = c.id WHERE mm.conversation_id = ?"
  ).all(s.conversation_id) as { name: string }[];
  if (msg) {
    recordFeedback({
      text: msg.body || "", class: s.class as "commitment" | "decision",
      conversationId: s.conversation_id, contactNames: members.map((x) => x.name), kind: "dismiss",
    });
  }
  deleteSuggestion(id);
}

/** Manual marking also teaches the loop: the user's phrasing is the signal. */
export function teachFromManual(opts: {
  text: string; class: "commitment" | "decision"; conversationId: string;
}): string {
  const db = getDb();
  const members = db.query(
    "SELECT c.name FROM contacts c JOIN members mm ON mm.contact_id = c.id WHERE mm.conversation_id = ?"
  ).all(opts.conversationId) as { name: string }[];
  return recordFeedback({
    text: opts.text, class: opts.class, conversationId: opts.conversationId,
    contactNames: members.map((x) => x.name), kind: "confirm",
  });
}

// ---------- export ----------

export function exportJson(): { exported_at: string; commitments: Commitment[]; decisions: Decision[]; language_patterns: any[] } {
  const db = getDb();
  return {
    exported_at: nowIso(),
    commitments: db.query("SELECT * FROM commitments ORDER BY created_at").all() as Commitment[],
    decisions: db.query("SELECT * FROM decisions ORDER BY created_at").all() as Decision[],
    // Template-level only — no raw message text is ever stored here.
    language_patterns: db.query("SELECT pattern, class, scope, confirms, dismissals, retired, first_seen, last_seen FROM language_patterns ORDER BY class, scope, pattern").all(),
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCsv(kind: "commitments" | "decisions"): string {
  const db = getDb();
  if (kind === "commitments") {
    const rows = db.query("SELECT * FROM commitments ORDER BY created_at").all() as Commitment[];
    const head = ["id", "conversation_id", "message_id", "text", "owner", "due_date", "due_time", "status", "source", "last_nudged_at", "created_at"];
    return [head.join(","), ...rows.map((r) => head.map((h) => csvCell((r as any)[h])).join(","))].join("\n") + "\n";
  }
  const rows = db.query("SELECT * FROM decisions ORDER BY created_at").all() as Decision[];
  const head = ["id", "conversation_id", "message_id", "text", "participants", "decided_at", "source", "created_at"];
  return [head.join(","), ...rows.map((r) => head.map((h) => csvCell((r as any)[h])).join(","))].join("\n") + "\n";
}

// ---------- cascade ----------

/** Extend conversation deletion: drop its commitments, decisions,
    suggestions, and learned patterns. Called from deleteConversationData. */
export function deleteCommitmentData(convId: string): void {
  const db = getDb();
  db.query("DELETE FROM commitments WHERE conversation_id = ?").run(convId);
  db.query("DELETE FROM decisions WHERE conversation_id = ?").run(convId);
  db.query("DELETE FROM suggestions WHERE conversation_id = ?").run(convId);
  db.query("DELETE FROM language_patterns WHERE scope = ?").run(convId);
}
