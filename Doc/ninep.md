# Relay as a 9P tree

Relay served over 9P2000, read-only, for the executive desk: threads
and messages as files the translator and the desk can read.

## Run

```
bun src/ninep-server.ts
```

Environment: `RELAY_DATA_DIR` (default `<repo>/data`, where
`relay.db` lives), `NINEP_PORT` (default 9006). Loopback only. The
database is opened read-only, so this server cannot change relay
state; start relay itself first if the database does not exist yet.

## Tree

```
contacts/<id>/{name, email, gv_number, matrix_id, notes}
threads/<conv>/{name, is_group, members, member_names,
                messages/<msg>/{channel, direction, subject, body, created, participants}}
```

`members` lists contact ids, one per line; `member_names` lists
names. Message files are raw bodies. Writes, creates, and removes
all answer "permission denied": replies still go out through
relay's own SMTP path, not through this tree.

## v1 limits

No authentication: run on loopback only. No `Twstat`. The 9P
library lives in `src/ninep.ts` and is vendored verbatim into
cadence, outpost, and translator — do not fork it per app.
