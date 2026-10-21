# WhatsApp QR worker ↔ backend internal protocol (v1)

Status: implementation contract for the isolated, default-off "WhatsApp (linked device)" human-reply module designed in
[WHATSAPP_QR_DESIGN.md](WHATSAPP_QR_DESIGN.md) section C. Owner decision 2026-10-21: build it for the default shop and the
Demo shop; the official Cloud API stays the recommended channel and the seller must acknowledge the number-ban risk first.

## Processes and trust

```text
browser (seller) --HTTPS--> backend public listener :3000  (existing session/CSRF/Origin/capabilities)
worker ----------HTTP-----> backend internal listener :3001 (bearer token; private compose network only)
worker ----------WSS------> WhatsApp (Baileys 6.7.24, egress network)
```

- The backend NEVER calls the worker and never imports Baileys. The worker is a pure client: it polls `control`, pushes
  state/auth/inbound events and claims replies.
- The internal listener starts only when `WHATSAPP_QR_ENABLED=1` and `WHATSAPP_QR_TOKEN_FILE` points at a readable file
  holding one line of >= 32 random URL-safe characters. It binds `0.0.0.0:3001` inside the container (the port is not
  published and Caddy never proxies it). Every request needs `Authorization: Bearer <token>`, compared in constant time;
  otherwise 401 with no body detail. Body limit 256 KiB (JSON only, `Content-Type: application/json`), 64 KiB for all
  routes except `PUT /v1/auth`. Unknown routes 404. No CORS. Responses `Cache-Control: no-store`.
- One worker serves exactly one shop. The token is bound by configuration to the default shop store
  (`WHATSAPP_QR_SHOP=default`; tenant shops are out of scope for v1 and must be refused, not guessed).
- Every worker request except `GET /v1/control` carries `generation` (integer): in the JSON body for POST/PUT and as
  the query parameter `?generation=N` for `GET /v1/auth`. A request whose generation differs from the current session
  generation is rejected with 409 `{"error":"STALE_GENERATION"}` and changes nothing (fencing).
- Lease: the worker sends header `X-Worker-Id: <uuid chosen at process start>`. `GET /v1/control` acquires/renews a
  60-second lease on the session row for that worker id; any other worker id gets 409 `{"error":"LEASE_HELD"}` while the
  lease is valid. All mutating routes require the caller to hold the lease (409 otherwise).

## Session states

`desired` is set only by the seller API: `OFF` | `PAIR` | `RUN`. `state` is reported only by the worker:
`IDLE` | `PAIRING` | `CONNECTING` | `CONNECTED` | `RECONNECTING` | `LOGGED_OUT` | `ERROR`.

- Seller "Pair" (Owner only, after risk acknowledgement): if `desired` is `OFF` or state is `LOGGED_OUT`/`ERROR`/`IDLE`,
  increment `generation`, delete all auth records of older generations, set `desired = PAIR`, clear QR.
- Seller "Disconnect": increment `generation`, set `desired = OFF`, delete all auth records, clear QR, cancel every
  QUEUED reply (status `CANCELLED`), keep thread history. The worker sees a new generation with `desired = OFF`, logs the
  socket out if it can (`sock.logout()`), closes it and reports `IDLE`.
- Worker reports `CONNECTED` → backend sets `desired = RUN` if it was `PAIR`.
- Worker reports `LOGGED_OUT` (WhatsApp unlinked the device or rejected it) → backend sets `desired = OFF`, deletes auth
  records, clears QR. The seller must pair again.

## Routes (all under `http://backend:3001/internal/whatsapp-qr`)

### `GET /v1/control`
Response `200 {"generation": 7, "desired": "PAIR", "leaseSeconds": 60, "pollMs": 2000}`.
Also performs bounded housekeeping (at most 200 rows each call): delete message bodies older than 30 days
(`body = NULL`, keep the row as a tombstone), expire QR older than 60 s, move SENDING replies whose lease expired to
`RECONCILE`.

### `POST /v1/state`
Body `{"generation":7,"state":"PAIRING","qr":"<string from Baileys connection.update>"}` |
`{"generation":7,"state":"CONNECTED","phone":"60123456789"}` | `{"generation":7,"state":"ERROR","reason":"<code>"}`.
- `qr` only with `PAIRING`, 1..1024 printable ASCII chars; stored with `qr_expires_at = now + 60 s`; replaced by a newer
  value; cleared on any other state.
- `phone` digits only 8..15; stored masked for display (`+60•••••6789`) and as an HMAC for order matching; never
  returned in full.
- `reason` matches `^[A-Z_]{2,40}$`.
Response `204`.

### `GET /v1/auth?generation=7`
Response `200 {"version": 41, "creds": <BufferJSON-encoded object or null>, "keys": [{"type":"pre-key","id":"1","value":<encoded>}, ...]}`
for the current generation, all read from ONE consistent snapshot (same transaction). `version` is the session's
`auth_version`; it starts at 0 for a new generation (no records) and the worker sends it unchanged in the next
`PUT /v1/auth`. The backend decrypts records sealed with the integration secret box; context string
`WHATSAPP_QR:<shopId>:<generation>:<type>:<id>:<chunk>`. Values are JSON text produced by Baileys `BufferJSON.replacer`
(the backend treats them as opaque strings, never parses Baileys structures). At most 5000 key records.

### `PUT /v1/auth`
Body `{"generation":7,"version":41,"creds":<encoded|undefined>,"set":[{"type","id","value"}],"delete":[{"type","id"}]}`.
Applied in ONE transaction, compare-and-set on `auth_version = version` (409 `{"error":"AUTH_VERSION"}` on mismatch —
the worker must then stop the socket, reload from `GET /v1/auth` and reconnect; continuing with stale Signal keys
corrupts the session). Success `200 {"version":42}`. Chunk values > 4096 chars into several sealed rows; a record is
returned only when all chunks open and the stored SHA-256 matches. `type` matches `^[a-z-]{2,40}$`, `id` 1..200 chars
printable. Max 500 set/delete items per call.

### `POST /v1/inbound`
Body `{"generation":7,"messages":[{"id":"<provider id 1..128>","peer":"<jid>","name":"<pushName or empty>","at":"<ISO time>","text":"<1..4096>"}]}`
(max 50 per call). The worker sends ONLY live (`messages.upsert` type `notify`) direct one-to-one messages that are not
`fromMe`, whose `remoteJid` ends with `@s.whatsapp.net` or `@lid`, that carry text (`conversation` or
`extendedTextMessage.text`). Groups, broadcasts, status, newsletters, history sync, reactions, media and own echoes are
dropped in the worker AND validated again by the backend (peer pattern). Unique `(provider, provider_message_id)` dedupes
retries. Response `200 {"accepted": n, "duplicates": m}`.

### `POST /v1/replies/claim`
Body `{"generation":7}`. Atomically moves the oldest eligible `QUEUED` reply to `SENDING` with a 60 s lease and returns
`200 {"reply":{"id":"<uuid>","peer":"<jid>","text":"<body>"}}` or `200 {"reply":null}`. Eligibility is re-checked here
(thread not suppressed, last inbound within 24 h, session CONNECTED, same generation as when queued); ineligible replies
become `FAILED` with `error_code` `NOT_ELIGIBLE`. One in-flight reply per session; at most one claim per 5 seconds.

### `POST /v1/replies/{id}/result`
Body `{"generation":7,"status":"SENT","providerMessageId":"<id>"}` | `{"generation":7,"status":"FAILED","code":"<CODE>"}`
(only for failures proven before dispatch) | `{"generation":7,"status":"UNKNOWN"}` (crash/timeout after dispatch →
stored as `RECONCILE`, never retried automatically). Only from `SENDING`. Response `204`.

## Worker behaviour (summary)

- Poll `control` every `pollMs` while `desired != OFF`, every 10 s otherwise. Exponential reconnect backoff 1/2/4/8/16/30 s,
  give up (report `ERROR` `RECONNECT_LIMIT`) after 5 minutes of failures; `loggedOut` disconnect → `LOGGED_OUT`.
- Never request history (`syncFullHistory: false`, `shouldSyncHistoryMessage: () => false`, `markOnlineOnConnect: false`).
- In-memory caches only as Baileys needs them; no file system auth state (`useMultiFileAuthState` is forbidden).
- Logs: one line per state change with codes only; never log QR, JIDs, phone numbers, message text, auth or the token.

## Clarifications

- This protocol takes precedence over the older design C2 proposal for schema
  names and secret contexts. Schema 27 contains the four tables specified by the
  backend job; no integration-channel or order-link tables are added here.
- Encoded auth `creds` and key `value` fields are opaque JSON **text strings**:
  the worker serializes with BufferJSON before sending, then parses after GET.
  Missing creds leaves the stored record unchanged; deleting Signal keys uses
  `delete`. The reserved record type `creds` is not allowed in set/delete.
  Set and delete together are capped at 500 items; deletes apply first, then
  sets (a set wins for the same identity). UTF-16 surrogate pairs are kept
  intact across 4096-character chunks; malformed Unicode is rejected.
- Peer HMAC key context is `WHATSAPP_QR:default:peer-key`; sealed thread JID
  context is `WHATSAPP_QR:default:peer:<threadId>`. Auth uses the context in
  the route contract, with reserved creds identity `creds:creds`.
- A valid worker lease is required for auth GET as well as mutations. Generation
  fencing is checked before lease ownership for non-control routes. Error JSON
  is `{ \"error\": \"CODE\" }`; authentication failure has an empty body.
- Direct peers are numeric identities (1–30 digits) at `s.whatsapp.net` or `lid`;
  LIDs never imply a phone match. Names are bounded to 200 characters. Inbound
  timestamps must be parseable UTC ISO timestamps ending in Z, not in the future;
  server receipt time never renews a historical message's 24-hour reply window.
- Result reports after the reply's 60-second dispatch lease expires are rejected.
  Control polling moves such rows to RECONCILE; a late SENT report cannot turn
  that uncertain outcome into a retry or overwrite the reconciled state.
- SQLite import deliberately excludes session, auth, threads and messages,
  retaining a fresh OFF/IDLE session. Restoring history without its sealed peer
  identity/key would not produce a usable thread; restoring dispatch intents
  or device state could reactivate an old session. Backups still contain these
  sensitive records and require the existing operational custody controls.

- LOGGED_OUT clears auth and advances `auth_version` rather than resetting it:
  a delayed pre-logout auth PUT must conflict, not recreate deleted credentials.
  Only a new seller-created generation starts at auth version zero.
