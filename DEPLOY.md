# Deploying AbroBot CRM

Two independent halves. Deploy them separately — that separation is what lets
the new frontend take over one route at a time without a big-bang cutover.

---

## 1. Database migrations

Apply in order, in the Supabase SQL editor for project **`pomsltnrxvbcafwtbtlc`**
(org `nandadynastybuilders-2809`). Double-check the project — running these
against the wrong database is the expensive mistake.

| # | File | Status |
|---|---|---|
| 1 | `20260816120000_agent_config_secret_hardening.sql` | ⬜ not applied — see the security note below |
| 2 | `20260817090000_multi_industry_foundation.sql` | ✅ applied 2026-08-19 |
| 3 | `20260819090000_automations_and_plan_limits.sql` | ✅ applied 2026-08-19 |

---

## 2. Edge functions

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app

# public — called by the widget and by webhooks
npx -y supabase@latest functions deploy chat-agent      --no-verify-jwt
npx -y supabase@latest functions deploy lead-webhook    --no-verify-jwt
npx -y supabase@latest functions deploy nurture         --no-verify-jwt
npx -y supabase@latest functions deploy summarize-chats --no-verify-jwt
npx -y supabase@latest functions deploy app-signup      --no-verify-jwt
npx -y supabase@latest functions deploy run-automations --no-verify-jwt
npx -y supabase@latest functions deploy system-health   --no-verify-jwt

# act for a signed-in user — JWT verification stays ON
npx -y supabase@latest functions deploy send-campaign
npx -y supabase@latest functions deploy whatsapp-send
npx -y supabase@latest functions deploy rescore-leads
```

The JWT flags are not cosmetic. `send-campaign`, `whatsapp-send` and
`rescore-leads` act on behalf of a logged-in user and check their org
membership; deploying them with `--no-verify-jwt` would expose them.

### Secrets

```bash
npx -y supabase@latest secrets set \
  GROQ_API_KEY=... \
  RESEND_API_KEY=... \
  TELEGRAM_BOT_TOKEN=... \
  WHATSAPP_TOKEN=... \
  APP_WEBHOOK_SECRET=... \
  CRM_BASE_URL=https://crm.mnbresearch.com
```

### Schedules

| Function | Cadence | Why |
|---|---|---|
| `run-automations` | every 15 min | time-based rules (no contact for N hours, overdue follow-ups) |
| `nurture` | daily | the 3-step email sequence |
| `system-health` | hourly, `POST {"alert": true}` | catches provider outages in an hour instead of three days |

---

## 3. Frontend

```bash
cd app
npm install
npm run build      # tsc --noEmit && vite build -> app/dist
```

Serve `app/dist` as a static site. `public/_redirects` ships the SPA fallback
(`/*  /index.html  200`), which Cloudflare Pages and Netlify both read.

**This must stay in place.** Without it, any nested route (`/leads/<id>`)
returns a hard 404 on refresh — the exact bug the legacy app fixed in its
"v17: fix nested-route blank page" deploy.

### Environment

```
VITE_SUPABASE_URL=https://pomsltnrxvbcafwtbtlc.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

Both have safe defaults in `src/lib/supabase.ts`, so a build without them still
points at production.

### Taking over from the legacy app

The two frontends can run side by side against the same database — that is what
the `stage`/`stage_key` sync trigger is for. Suggested order:

1. Deploy the new app to a subdomain (e.g. `app.crm.mnbresearch.com`) and use it
   yourself for a week.
2. Move `crm.mnbresearch.com` across once you trust it.
3. Keep the old bundle deployed somewhere reachable until the new app covers
   every route you actually use.

---

## ⚠️ Before you invite your first counsellor

Migration 1 is still unapplied, and the issue it documents becomes live the
moment a non-admin account exists.

`agent_config` holds `groq_api_key`, `resend_api_key`, `whatsapp_token`,
`telegram_bot_token` and `app_secret`, and its RLS policy grants read access to
**any active member** — including counsellors. Today every member is an admin,
so nothing is over-exposed. That stops being true with your first counsellor.

The migration explains why the obvious fixes break the app (a masking view
breaks PostgREST's upsert; tightening the row policy breaks every non-admin
login, because the auth bootstrap reads `onboarded` for everyone). The option
that works today is Step 3 in that file: move the keys into function secrets and
null the columns. All three code paths already fall back to the environment.

`system-health` now checks for this. It reports **fail** the moment a counsellor
account exists while credentials are still in the database.

**Treat anything currently in those columns as leaked, and rotate it.**

---

## Verifying a deploy

Do not trust a green build. The August outage passed every check except reality.

```bash
# 1. AI agent actually answers
curl -s -X POST "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/chat-agent" \
  -H "Content-Type: application/json" \
  -d '{"org":"abrobot","message":"one short sentence about studying in Canada"}'

# 2. full system status
curl -s "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/system-health?org=abrobot"

# 3. automations — dry run changes nothing
curl -s -X POST "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/run-automations" \
  -H "Content-Type: application/json" -d '{"org":"abrobot","dry_run":true}'
```

A real sentence from (1) means the agent is healthy. `"status":"ok"` from (2)
means every probe passed.
