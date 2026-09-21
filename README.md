# Relay

A small, clean, modern messaging app for your inner circle — up to **8 people**, up to **8 per group**. Tap a person, pick a channel, send. The UI is OS-agnostic glass: calm, inviting, professional.

## Channels (per contact, per message)

In any message view a segmented control offers the channels that contact can actually use right now:

- **✉️ Email** — sent through your SMTP server; replies arrive via IMAP and land in the same thread. When an email (inbox or Sent) involves several of your contacts, Relay files it in exactly one conversation: their group, created automatically if needed ("Pal & Sam") — never duplicated into the 1:1s. Single-contact mail keeps landing in the DM as before.
- **💬 SMS** — sent through **Google Voice's SMS email gateway**. Just add the contact's Google Voice number; no phone hardware needed. Replies forwarded by Google Voice to your email are picked up by the IMAP poller and threaded as SMS (the MIME text/plain part is decoded (base64/quoted-printable) and the GV email footer boilerplate is stripped, so threads show just the message).

Opening an empty 1:1 chat pre-populates its first message from the last email conversation with that contact (inbox or Sent, read-only lookup), so the thread starts with context instead of blank. Outbound 1:1 texts are always sent as *replies* to the previous GV thread for that number (Google Voice drops fresh mail to the bare gateway address): Relay uses the newest forward it has recorded, and if it has none (e.g. the forward was already marked seen before Relay polled), it looks the thread up live over IMAP at send time. Groups and numbers with no thread in the last 30 days fall back to the plain gateway address.
- **🟣 Matrix** — sent with your Matrix access token to a room you pick per contact (or per group); incoming room messages arrive over `/sync` long-polling.

A channel only appears when the service is configured in Settings **and** every participant has that channel's address. Hints explain what's missing.

## File attachments (Email channel)

The 📎 paperclip in the composer appears on the Email channel. Pick up to **10 files** per message, **25 MB** each:

- Images get inline thumbnails, video and audio get inline players, everything else becomes a download chip — in the thread and in the **Shared files** widget.
- Images are never shown inline in the thread — each becomes a preview chip that opens the lightbox; video and audio keep their small inline players.
- The widget lives in the conversation header (badge shows the count): on wide screens (≥1100px) it docks as a permanent right-hand panel; on smaller screens it opens as a slide-over drawer. **Images stack by message**: one tile per message with its photos layered on top of each other and a count badge; tapping a stack opens the lightbox on that message's photos (←/→ to flip through). A single photo renders as a plain tile. Other files stay as individual tiles with preview, name, size, and time; tapping one opens the preview lightbox (image / video / audio / document) with prev/next, download, and keyboard navigation (←/→/Esc).
- A **search box** at the top of the widget searches the conversation's attachments by filename over the **last 90 days** (case-insensitive, debounced, newest-first; Esc or ✕ clears). `GET /api/conversations/:id/files` accepts `q` and `days` (1–365, default 90) to drive it.
- Files go out as real MIME attachments on the email (`multipart/mixed`, base64). SMS and Matrix reject attachments with a clear error for now.
- Inbound email attachments are pulled in too: each IMAP poll extracts files from new mail (base64 / quoted-printable, RFC 2047/2231 filenames, nested multiparts), stores them like sent files (same 10-per-message / 25 MB limits; messages over 30 MB are skipped), and they appear in the thread, the widget, and filename search. Re-polls never duplicate them.
- **Sent-folder mail is imported too:** each poll also scans your IMAP **Sent** mailbox, so email you sent from your regular mail app appears in the matching Relay thread as an outbound message — and its attachments land in Shared files and the filename search. The first poll backfills up to the newest 200 messages from the last 90 days, then tracks a UID watermark so it only picks up new mail. Mail you composed inside Relay is matched by `Message-ID` (plus a subject/time/filename fallback for older messages) and never re-imported. Mail to untracked addresses is skipped.
- Failed sends keep their files, so **Retry** re-sends the original attachments. Deleting a conversation removes its files from disk too.

## Calendar invitations + weekly diary (Email channel)

The 📅 calendar button in the Email composer opens an inline invitation form — title, start/end, optional location and notes. Sending attaches a real **`invite.ics`** (`text/calendar`, `METHOD:REQUEST`) to the email, so any calendar app can add it; the invitation is recorded in the conversation's diary either way.

- Each conversation has a **weekly Diary widget** (badge shows this week's count): Sunday–Saturday with prev/next week and Today controls, time, location, notes, and status pills (sent / invitation / accepted / declined / cancelled).
- Invitations render as **cards in the thread** — inbound ones you haven't answered show **Accept** and **Decline** buttons. Accepting or declining emails the organizer a real **`METHOD:REPLY`** `.ics` (with your `PARTSTAT`) and records an "Accepted/Declined: …" message in the thread, so there's a visible record; when there's no organizer to reply to it just updates the diary.
- Inbound `.ics` attachments from email replies are parsed into the diary automatically (UTC, floating, all-day, and `TZID` dates; missing end times default to +1 hour); events are deduplicated by ICS UID, and `.ics` files are hidden from Shared files so they only appear as appointments.
- Sent-folder scanning ingests invitations your mail app sent too. New APIs: `GET /api/conversations/:id/appointments` and `POST /api/conversations/:id/appointments/:appointmentId/status` (`accepted` | `declined` | `cancelled`).
- Like Shared files, the Diary docks as a permanent right-hand panel at ≥1100px and becomes a slide-over drawer on smaller screens — one panel area, switched by the header buttons.

## Calendar feed sync (secret iCal address)

**Settings → Calendar feed (iCal)** takes your calendar's secret iCal address (e.g. Google Calendar's *Secret address in iCal format*). The URL is stored server-side as a secret — it's never logged and `GET /api/settings` only reports `configured` + `lastSyncAt`, never the URL itself.

- **Sync now** (also the ⟳ icon in the Diary panel header) fetches the feed server-side (15s timeout, 5MB cap, same-scheme redirects only) and opens a **preview modal**: every event row shows local date/time, location, a recurrence badge (`2/5`), an already-imported or cancelled badge, and the matched contacts with confidence chips — **email**, **name**, or **mentioned**.
- Matching is exact: attendee/organizer email, attendee CN, or the contact's name appearing in the summary/description/location. Recurrences (`RRULE` DAILY/WEEKLY, COUNT/UNTIL/BYDAY) expand into one row per occurrence, capped at 200.
- Rows with a confident email/name match and an existing 1:1 conversation come pre-checked; cancelled, already-imported, and conversation-less rows are disabled. **Nothing is written until you confirm.**
- Confirm imports the checked rows into each contact's existing conversation diary as `planned` entries (dedupe key: ICS UID + occurrence start — re-syncs show **Already imported** instead of duplicating; no conversations are ever created). The result summary lists imported/skipped counts and a per-event status.
- Manual sync only — no background polling. New APIs: `POST /api/calendar/sync` (preview) and `POST /api/calendar/import` (`{ items }` → `{ imported, skipped, results }`).

## Commitments + decisions tracker

The ✓ toggle in the conversation header opens the **Commitments panel** (Open / Suggestions / Decisions tabs):

- Relay watches inbound messages with conservative, deterministic heuristics ("I'll …", "we decided …", "I promise …") and date/time extraction. Anything it thinks is a commitment or decision becomes a **suggestion** — a private guess that saves nothing until you tap **Keep** or **Dismiss**.
- Keep teaches the **adaptive phrasing loop**: your wording is templated (dates → `{WHEN}`, numbers → `{NUM}`, names → `{X}` — raw text is never stored), and after **3 confirms** that phrasing suggests on its own; **3 dismissals** retires it, **6 confirms** revives it. Conversation patterns win over global ones; every suggestion's reason names the pattern and its count ("learned from your phrasing", "3 times").
- Open commitments group into **Overdue / Today / This week / Later / No date** with muted terracotta urgency; each row does Done, diary, edit, and delete. Mark any message via right-click (or long-press / Shift+F10) → **Mark as commitment** / **Log as decision**.
- A **global Commitments** view (`#/commitments`, Open / Decisions tabs with search) shows everything across conversations; typing ≥2 characters in **Search conversations** also surfaces matching commitments and decisions in a section under the results — rows jump straight to the conversation, and to the source message when known.
- **Nudges** (on by default, `relay_commit_nudges`): due-today and overdue items surface one desktop notification per day, quiet hours 22:00–07:00, digest when several are due.
- New APIs: `GET/POST /api/conversations/:id/commitments`, `PATCH/DELETE /api/commitments/:id`, `GET /api/conversations/:id/suggestions`, `POST /api/suggestions/:id/confirm|dismiss`, `GET/POST /api/conversations/:id/decisions`, `PATCH/DELETE /api/decisions/:id`, `GET /api/commitments/all`, `GET /api/decisions/all` (searchable), `GET /api/commitments/due`, `POST /api/commitments/:id/nudge`, and JSON/CSV export. Everything is local SQLite — no network, no models, no new dependencies.

## Wide-screen reflow

Stretch the window and the UI opens up: at ≥1100px the conversation view gains the persistent Shared files panel while the thread uses the rest; at ≥1400px the People grid goes six-wide. Everything stays glass, and animations still respect `prefers-reduced-motion`.

## Quick start

```bash
bun src/server.ts   # http://localhost:3006
```

1. Open **Settings** and add:
   - **SMTP** — host, port, security (SSL/STARTTLS), username, from-address. Gmail needs an [app password](https://myaccount.google.com/apppasswords).
   - **IMAP** — same inbox, so replies and Google Voice SMS forwards are picked up.
   - **Matrix** — homeserver URL + access token (Element → Settings → Help → Access token).
   - Use **Test connection** on each.
2. **People** → add up to 8 people with whichever channels they have.
3. Tap a person → **Message** → pick a channel → send. Or **＋ Group** for up to 8 total.

For Matrix DMs: create the DM room in Element first, then paste the room ID on the contact (or use **Browse** to pick from rooms you've joined). For group Matrix chat, set the room on the group.

### Adding people

On the **People** tab, tap **⤓ Import** to pick from four sources:

- **✉️ Sent mail** (no extra setup) — Relay scans the last 40 emails in your Sent folder over IMAP and lists everyone you've written to, most-emailed first. Your own address and automated senders (noreply@…) are skipped.
- **💬 SMS** (no extra setup) — your most recent Google Voice text conversations from the last 14 days, read from the inbox (GV forwards arrive as mail). Importing one creates the contact with the GV number already filled in, ready for SMS.
- **🔵 Google** — import from Google Contacts via OAuth (one-time setup below).
- **📇 vCard** — pick a `.vcf` file (iCloud / Google Contacts export). Parsed on-device, nothing is uploaded.

Picks respect the 8-person cap, duplicates are skipped, and names + email addresses are imported. Add a Google Voice number afterwards (Edit person) to enable SMS for someone.

#### Google Contacts import (optional)

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable the **People API**.
3. **APIs & Services → Credentials** → Create Credentials → **OAuth client ID** → application type **Web application**.
4. Under *Authorized redirect URIs*, add the URI shown in Relay's Settings (Google Contacts section) — for a local run it looks like `http://localhost:3006/api/google/callback`.
5. Paste the **client ID** and **client secret** into Relay's Settings → Google Contacts, save, then **Save & connect Google**.

Google tokens are stored in the gitignored `./data/config.json` next to your other credentials and never leave your machine.

## Design notes

- **Small by design.** 8 contacts max, 8 people per group (you included). The caps are enforced server-side.
- **Zero dependencies.** Bun + built-in SQLite + hand-rolled SMTP/IMAP clients. The Matrix client is ~100 lines over `fetch`.
- **Private by default.** Contacts, messages, and credentials live in gitignored `./data/` (`relay.db`, `config.json`) — never pushed.
- **Polling, not webhooks.** IMAP is polled every 60s; Matrix uses `/sync` long-polling. **Check for new messages** in Settings polls on demand.
- **Dedupe.** Every inbound message is keyed (`mail:{uid}`, `matrix:{event_id}`) so polls never double-insert.
- **Participant data.** Every message records the contact ids involved, so threads can be re-filed later. Mail stored before this existed can be backfilled from **Settings → Mail maintenance → Migrate old mail**: each stored email is re-located on the server by its stable Message-ID (UIDs shift, Message-IDs don't), its sender/recipient envelope is read, and multi-contact threads move into their group (created on the spot when missing). `POST /api/migrate-participants` does the same; pass `{dry_run: true}` to preview without writing.
- Failed sends are kept in the thread with a "failed to send" flag — nothing silently vanishes.
- UI honors `prefers-reduced-motion` and `prefers-color-scheme`.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | service readiness, contact count, last poll |
| GET/POST | `/api/settings` | secrets are never returned; `__KEEP__` preserves them |
| POST | `/api/settings/test` | `{service: smtp\|imap\|matrix}` |
| GET | `/api/matrix/rooms` | joined rooms for picking DM rooms |
| GET/POST | `/api/contacts` | max 8 enforced |
| GET/PATCH/DELETE | `/api/contacts/:id` | delete removes their 1:1 conversations |
| GET/POST | `/api/conversations` | POST creates a group |
| GET/PATCH/DELETE | `/api/conversations/:id` | detail includes `channels` + `hints` |
| GET/POST | `/api/conversations/:id/messages` | POST `{channel, body, subject?}`; multipart `files[]` for attachments (email only) |
| POST | `/api/conversations/:id/messages/:mid/retry` | re-sends a failed message with its stored attachments |
| GET | `/api/conversations/:id/files` | recently shared files (newest first) for the widget |
| GET | `/api/attachments/:id` | download / inline preview of one file |
| POST | `/api/conversations/:id/read` | clears unread |
| POST | `/api/poll` | poll mail + Matrix now |
| POST | `/api/migrate-participants` | backfill participant data + re-thread old multi-contact mail into groups; `{dry_run: true}` previews |

## Ports

Relay runs on **3006** (`PORT` env overrides).
