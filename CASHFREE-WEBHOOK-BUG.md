# Cashfree webhook 401 — millisecond timestamp bug

Paste the block below into any project that receives Cashfree webhooks.

Confirmed affected on 2026-08-27, same Cashfree account, same live payment:

| Endpoint | Result |
|---|---|
| `app.abrobot.ai/api/cashfree/webhook` | 200 |
| `omni.mnbresearch.com/api/pay/webhook` | 200 |
| `cortex.mnbresearch.com/api/pay/cashfree/webhook` | **401** |
| `auditflow.mnbresearch.com/api/webhooks/cashfree` | **401** |
| `crm.mnbresearch.com` (Supabase fn) | **401** → fixed |

The two returning 200 may simply not verify signatures at all, which is its own
problem worth checking.

---

## The prompt

```
We have a Cashfree payment webhook returning 401 to every real delivery, so
paid orders never get fulfilled. Live payments succeed at Cashfree, the money
is taken, and our endpoint rejects the notification.

ROOT CAUSE (already confirmed on a sibling project):

Cashfree sends the `x-webhook-timestamp` header in epoch MILLISECONDS —
a 13-digit value, e.g. "1787814895250".

Most implementations (including the Cashfree docs' own examples in some
languages) compare it against a seconds-based clock:

    Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_AGE

With a millisecond timestamp that difference is ~1.79 trillion, so the replay
window check rejects EVERY webhook before the signature is ever compared. The
API secret, app id, environment and webhook registration are all irrelevant —
they can be perfectly correct and it still 401s.

THE FIX — normalise by magnitude before the age comparison:

    const tsRaw = Number(timestamp);
    if (!Number.isFinite(tsRaw)) return reject("Malformed timestamp");
    // >1e11 cannot be seconds (that would be year ~5138), so it is millis
    const tsSeconds = Math.abs(tsRaw) > 1e11 ? tsRaw / 1000 : tsRaw;
    if (Math.abs(Date.now() / 1000 - tsSeconds) > MAX_AGE_SECONDS) reject(...);

CRITICAL: the SIGNATURE must still be computed over the RAW header string
exactly as received — do not substitute the normalised value:

    expected = base64(HMAC_SHA256(rawTimestampString + rawBody, clientSecret))

Also confirm:
  * the raw request BODY bytes are used, never re-serialised JSON
    (JSON.parse then JSON.stringify changes whitespace and key order and the
    signature will never match)
  * the comparison is constant-time
  * verification fails CLOSED when the secret is unset
  * handling is idempotent — Cashfree retries, and a retry must not grant a
    plan or fulfil an order twice
  * MAX_AGE is at least 15 minutes: Cashfree reuses the ORIGINAL timestamp on
    retries, and its retry schedule spans ~8+ minutes, so a 5-minute window
    silently drops the later retries

WHY THIS HIDES: hand-written test requests are usually built with
`date +%s` or `Math.floor(Date.now()/1000)` — SECONDS — which sail through the
age check and reach the signature comparison. The endpoint therefore "passes"
every manual test while failing every real delivery. Any test must use a
13-digit millisecond timestamp to reproduce the real caller.

Please: find the webhook verification code, check whether it has this bug, fix
it if so, and add a test that signs with a genuine 13-digit millisecond
timestamp. Then verify against a real Cashfree delivery, not a hand-built one.
```

---

## How to confirm the diagnosis in any project

In the Cashfree dashboard: **Payment Gateway → Developers → Webhooks → Logs**,
open a failed delivery, and look at the **Headers** tab. If
`x-webhook-timestamp` is 13 digits, and your code compares it to a
seconds-based clock, that is the bug.

## Reference implementation

`supabase/functions/_shared/cashfree.ts` in this repo, with tests in
`supabase/functions/_shared/cashfree.test.cjs` — including one that signs with
a real millisecond timestamp.
