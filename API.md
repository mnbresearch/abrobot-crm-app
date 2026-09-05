# AbroBot CRM API

Base URL: `https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/api/v1`

Create a key in **Settings → Integrations**. It is shown once — we store a
SHA-256 hash, so we genuinely cannot recover it for you.

```
Authorization: Bearer abk_live_...
```

Every request is scoped to the organisation the key belongs to. The org is
never a parameter, so there is no way to ask for another tenant's data.

---

## Scopes

| Scope | Grants |
|---|---|
| `leads:read` | List and fetch records |
| `leads:write` | Create and update records |
| `stages:read` | Read the pipeline |
| `conversations:read` | Read chat transcripts |

Grant the least you need. A reporting dashboard should not hold a key that can
also modify records.

---

## Endpoints

### `GET /me`
Check a key works and see what it can do. No scope required.

```bash
curl -H "Authorization: Bearer $KEY" \
  https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/api/v1/me
```
```json
{ "org": "AbroBot", "slug": "abrobot", "plan": "enterprise",
  "scopes": ["leads:read", "leads:write"] }
```

### `GET /leads` — `leads:read`

| Query | Meaning |
|---|---|
| `stage` | Filter by stage key (see `/stages`) |
| `assigned` | Filter by owner's user id |
| `source` | `website`, `whatsapp`, `csv_import`, `manual`, `referral`, `other` |
| `since` | ISO timestamp — only records created after |
| `q` | Search name, email, phone |
| `limit` | 1–200, default 50 |
| `offset` | For paging |

```json
{ "leads": [ ... ],
  "pagination": { "total": 1284, "limit": 50, "offset": 0, "has_more": true } }
```

### `GET /leads/:id` — `leads:read`

### `POST /leads` — `leads:write`

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Priya Sharma","email":"priya@example.com","phone":"9876543210"}' \
  .../api/v1/leads
```

Needs an email or a phone. Phone numbers are normalised the same way the chat
widget and capture URLs normalise them (`9876543210` → `+919876543210`), so a
record created here **deduplicates against one captured on your website** — you
get `{"deduped": true, "id": ...}` with `200` rather than a second copy of the
same person.

New records land in the first stage of your pipeline. Returns `201`.

`402` means you have hit your plan's record limit; the message says which.

### `PATCH /leads/:id` — `leads:write`

Updatable: `name`, `email`, `phone`, `stage_key`, `score`, `assigned_to`,
`tags`, `custom`, `next_follow_up_at`. Anything else is ignored — deliberately,
so a stray field cannot move a record between organisations.

`stage_key` is validated against your pipeline; an unknown value returns `422`
rather than silently hiding the record from your board.

### `GET /stages` — `stages:read`

### `GET /conversations` — `conversations:read`

Chat sessions from the widget, newest activity first.

| Query | Meaning |
|---|---|
| `lead_id` | Only conversations tied to one record |
| `since` | ISO timestamp — only those active after |
| `limit` / `offset` | 1–200, default 50 |

### `GET /conversations/:id` — `conversations:read`

The conversation plus its transcript, up to 500 messages.

```json
{ "conversation": { "id": "…", "visitor_name": "…", "message_count": 12, … },
  "messages": [ { "role": "user", "content": "…", "created_at": "…" }, … ] }
```

The conversation is fetched first and scoped to your org, then its messages —
`chat_messages` carries no org id of its own, so that row is the only thing
establishing ownership. A conversation belonging to another organisation
returns `404`, the same as one that does not exist.

---

## Errors

| Code | Meaning |
|---|---|
| `401` | Missing, invalid, revoked or expired key |
| `403` | Key lacks the scope |
| `404` | No such record **in your organisation** |
| `422` | Validation — the message says what |
| `402` | Plan limit reached |

Revoked, expired and never-existed all return the same `401`. Telling an
attacker which one it was is free information.

---

## Outbound webhooks

Add an endpoint in **Settings → Integrations**. We POST when:

| Event | Fires |
|---|---|
| `lead.created` | Any new record, from **any** source — widget, capture URL, CSV import, manual add, or this API |
| `lead.stage_changed` | A record moves stage, including by drag-and-drop or automation |

```json
{
  "event": "lead.created",
  "org_id": "…",
  "created_at": "2026-09-05T09:14:22Z",
  "data": { "id": "…", "name": "Priya Sharma", "email": "…", "stage": "new", "score": 42 }
}
```

### Verify the signature — do not skip this

Your endpoint URL will end up in logs, browser history and screenshots. The
signature is the only thing distinguishing us from anyone who has seen it.

```
X-AbroBot-Event: lead.created
X-AbroBot-Signature: sha256=<hmac of the raw body, using your endpoint secret>
```

```js
const crypto = require("crypto");

function verify(rawBody, header, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret)
    .update(rawBody).digest("hex");
  const a = Buffer.from(header || "");
  const b = Buffer.from(expected);
  // Lengths must match before timingSafeEqual, and comparing with === would
  // leak the answer one byte at a time.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

HMAC the **raw request body**, before any JSON parsing. Re-serialising changes
the bytes and the signature will never match.

Delivery is fire-and-forget with an 8-second timeout: a slow endpoint of yours
can never delay a record being saved. Every attempt is logged for 7 days.

---

## Rate limits

None enforced yet, beyond a hard cap of 200 records per page. Be reasonable —
this runs on shared infrastructure, and the practical limit today is politeness
rather than code. That will change before it becomes a problem.

---

## What this API does not do yet

Stated plainly so you don't design around something that isn't there:

- **No `DELETE`.** Deliberate. Use `PATCH` to move a record to a lost stage.
- **No activities or notes.** Conversation transcripts *are* available; the
  human-written notes and call logs on a record are not.
- **No bulk endpoints.** Import a CSV for anything large.
- **No pagination cursor** — `offset` only, which can skip or repeat a record if
  data changes mid-page. Filter with `since` for reliable syncing.
- **No OAuth.** Bearer keys only.
