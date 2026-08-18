# AbroBot CRM — handoff

Everything that could be done without your credentials or third-party accounts
is done and committed to the branch **`recover/source-and-backend-features`**.

The live site was not touched at any point. Nothing is deployed.

---

## What's done

| | |
|---|---|
| ✅ | Confirmed the frontend source is unrecoverable (repo, all 21 commits, git object DB, zips, sourcemaps, live host, all 15 Vercel projects, all 17 restored repos) |
| ✅ | Recovered all 6 edge functions — 861 lines — into `supabase/functions/` |
| ✅ | Captured the live schema, enums, RLS policies, row counts → `RECOVERED-SCHEMA.md` |
| ✅ | Built lead scoring (`_shared/score.ts`) + 10 passing unit tests |
| ✅ | Built Telegram new-lead alerts (`_shared/notify.ts`) |
| ✅ | Built WhatsApp send + autoreply (`_shared/whatsapp.ts`, `whatsapp-send`) |
| ✅ | Fixed `nurture` ignoring the per-org `nurture_enabled` toggle |
| ✅ | Added `rescore-leads` to backfill the 21 existing leads |
| ✅ | Documented the `agent_config` credential exposure + why the obvious fixes break things |

All 11 function files parse clean; the scoring suite is 10/10 green.

---

## Your turn — in this order

### 1. Clear two stale git lock files  (30 seconds)

My sandbox couldn't delete these, and they will block your next `git commit`:

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app
rm -f .git/HEAD.lock .git/index.lock
git status
```

There's one commit staged behind them (a `.gitignore` that stops the Supabase
CLI's `supabase/.temp/` scratch files being tracked). Finish it with:

```bash
git commit -m "Add .gitignore; drop supabase CLI scratch state from tracking"
```

### 2. Check what deploying `nurture` will change  (1 minute)

This is the only change that alters live behaviour. Run:

```sql
select o.slug, o.name, c.nurture_enabled
from agent_config c join organizations o on o.id = c.org_id
order by o.slug;
```

- `nurture_enabled = true` everywhere → deploying changes nothing. Go ahead.
- any `false` → that org **stops** receiving nurture email after deploy. That
  is the intended fix, but you should know it's coming.

While you're in there, this tells us how much the rescore will move:

```sql
select score, count(*) from leads group by 1 order by 1;
```

### 3. Deploy  (2 minutes)

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app

npx -y supabase@latest functions deploy lead-webhook --no-verify-jwt
npx -y supabase@latest functions deploy chat-agent   --no-verify-jwt
npx -y supabase@latest functions deploy nurture      --no-verify-jwt
npx -y supabase@latest functions deploy rescore-leads
npx -y supabase@latest functions deploy whatsapp-send
```

The JWT flags matter: the first three are called by webhooks and the public
widget, the last two act for a logged-in CRM user and must keep verification
**on**.

### 4. Telegram alerts — only you can do this

Needs a Telegram account; I can't create the bot for you.

1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Search for your new bot, open it, send it any message (e.g. "hi").
   *(A bot cannot message you until you message it first.)*
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy
   the `"chat":{"id": … }` number.
4. In CRM → Settings → paste both, tick **"Send me a phone alert for every new
   lead"**, Save.
5. Test:

```bash
curl -X POST "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/lead-webhook?key=<ANY_ACTIVE_WEBHOOK_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Telegram Test","email":"tg-test@example.com","phone":"+919999999999","country":"USA","course_level":"Masters","intake":"Fall 2026"}'
```

The response now tells you exactly what happened:
`"alert":{"sent":true}`, or `{"sent":false,"reason":"disabled"}` /
`"not_configured"` / `"error"` with Telegram's own message. Delete the test
lead afterwards.

Get an active key with:
```sql
select key, label, source from webhook_keys where active limit 5;
```

### 5. Rescore the existing leads

Dry run first — it writes nothing:

```bash
curl -X POST "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/rescore-leads" \
  -H "Authorization: Bearer <YOUR_CRM_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" -d '{"dry_run":true}'
```

To get the token: open the CRM logged in, DevTools → Console →
`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('sb-')))).access_token`

Check the `sample` array — each entry shows `was`, `now` and the full
component `breakdown`. If the numbers look right, re-run without `dry_run`.

### 6. WhatsApp — only you can do this

Needs a Meta Business account and an approved WhatsApp sender.

1. Meta App Dashboard → add the **WhatsApp** product.
2. Copy the **Phone Number ID** (this is *not* the phone number) and generate a
   **permanent access token**.
3. CRM → Settings → WhatsApp → paste both, tick autoreply if you want it.
4. Point the WhatsApp webhook at your existing `lead-webhook?key=…` (the
   inbound Meta payload shape is already handled).

Two things to know: free-form messages only work inside the 24-hour window
after the customer's last message — outside it Meta returns error `131047` and
`whatsapp-send` reports it honestly rather than faking success. Sending outside
that window needs an approved message template.

---

## Decisions waiting on you

**`agent_config` credentials.** Dormant today (1 super_admin, 1 org_admin, no
counsellors). It becomes real with your first counsellor invite. The migration
in `supabase/migrations/` explains four approaches and why three of them break
the app. The one that works today is Step 3 in that file: move the secrets to
function environment secrets and null the columns — the edge functions already
fall back to env, and I added that fallback for Telegram and WhatsApp too.
**Anything currently in those columns should be treated as leaked and rotated.**

**Where this repo should live.** `main` here is 21 commits of drag-dropped
build output. Consider making the branch the new `main`, or starting a clean
repo where `supabase/` is the real source and the bundle is kept only as a
reference artifact.

**The frontend.** Still gone, still only a minified bundle. Nothing above
needed it. Reporting and any new screens will — that's when the
new-pages-alongside approach becomes the conversation.
