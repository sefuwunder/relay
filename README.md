# Relay

A small, glossy, iOS-style messaging app for your inner circle — up to **8 people**, up to **8 per group**. Tap a person, pick a channel, send.

## Channels (per contact, per message)

In any message view a segmented control offers the channels that contact can actually use right now:

- **✉️ Email** — sent through your SMTP server; replies arrive via IMAP and land in the same thread.
- **💬 SMS** — sent through **Google Voice's SMS email gateway**. Just add the contact's Google Voice number; no phone hardware needed. Replies forwarded by Google Voice to your email are picked up by the IMAP poller and threaded as SMS (the GV email footer boilerplate is stripped, so threads show just the message).

Opening an empty 1:1 chat pre-populates its first message from the last email conversation with that contact (inbox or Sent, read-only lookup), so the thread starts with context instead of blank. Outbound 1:1 texts are always sent as *replies* to the previous GV thread for that number (Google Voice drops fresh mail to the bare gateway address): Relay uses the newest forward it has recorded, and if it has none (e.g. the forward was already marked seen before Relay polled), it looks the thread up live over IMAP at send time. Groups and numbers with no thread in the last 30 days fall back to the plain gateway address.
- **🟣 Matrix** — sent with your Matrix access token to a room you pick per contact (or per group); incoming room messages arrive over `/sync` long-polling.

A channel only appears when the service is configured in Settings **and** every participant has that channel's address. Hints explain what's missing.

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

On the **People** tab, tap **⤓ Import** to pick from three sources:

- **✉️ Sent mail** (no extra setup) — Relay scans the last 40 emails in your Sent folder over IMAP and lists everyone you've written to, most-emailed first. Your own address and automated senders (noreply@…) are skipped.
- **💬 SMS** (no extra setup) — your most recent Google Voice text conversations from the last 14 days, read from the inbox (GV forwards arrive as mail). Importing one creates the contact with the GV number already filled in, ready for SMS.
- **🔵 Google** — import from Google Contacts via OAuth (one-time setup below).

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
| GET/PATCH/DELETE | `/api/contacts/:id` | delete removes their 1:1 chats |
| GET/POST | `/api/conversations` | POST creates a group |
| GET/PATCH/DELETE | `/api/conversations/:id` | detail includes `channels` + `hints` |
| GET/POST | `/api/conversations/:id/messages` | POST `{channel, body, subject?}` |
| POST | `/api/conversations/:id/read` | clears unread |
| POST | `/api/poll` | poll mail + Matrix now |

## Ports

Relay runs on **3006** (`PORT` env overrides).
