# Relay

A small, glossy, iOS-style messaging app for your inner circle — up to **8 people**, up to **8 per group**. Tap a person, pick a channel, send.

## Channels (per contact, per message)

In any message view a segmented control offers the channels that contact can actually use right now:

- **✉️ Email** — sent through your SMTP server; replies arrive via IMAP and land in the same thread.
- **💬 SMS** — sent through **Google Voice's SMS email gateway** (`5551234567@txt.voice.google.com`). Just add the contact's Google Voice number; no phone hardware needed. Replies forwarded by Google Voice to your email are picked up by the IMAP poller and threaded as SMS.
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
