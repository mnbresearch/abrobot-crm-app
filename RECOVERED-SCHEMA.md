# AbroBot CRM — Recovered Schema (ground truth)

Read live from Supabase project `pomsltnrxvbcafwtbtlc` ("abrobot-crm",
org `nandadynastybuilders-2809`) on 2026-08-15. This is the authoritative
data model — the frontend source is gone, this is not.

`!` = NOT NULL. `USER-DEFINED` = postgres enum (defined at the bottom).

---

## Row counts (live, at time of capture)

| Table | Rows |
|---|---|
| organizations | 4 |
| profiles | 2 |
| leads | 21 |
| activities | 41 |
| conversations | 77 |
| chat_messages | 316 |
| message_templates | 4 |
| imports | 0 |
| agent_config | 4 |
| webhook_keys | 11 |

Small dataset — the product is early-stage. Migration risk is low.

---

## Tables

### organizations
`id uuid!, name text!, slug text!, brand_color text, logo_url text, active boolean!, created_at timestamptz!, plan text!, trial_started_at timestamptz!, trial_days integer!, credits_total integer!, credits_used integer!`

Trial + credit system lives here (`trial_started_at`, `trial_days`,
`credits_total`, `credits_used`) — matches the "7-day trial / credit system
with daily upgrade nudge" commit messages.

### profiles
`id uuid!, org_id uuid, full_name text!, email text!, role user_role!, status member_status!, created_at timestamptz!`

### leads
`id uuid!, org_id uuid!, name text!, email text, phone text, source lead_source!, stage lead_stage!, target_country text, course text, course_level text, intake text, budget_inr numeric, test_status text, score integer!, assigned_to uuid, tags ARRAY!, next_follow_up_at timestamptz, last_contacted_at timestamptz, raw jsonb, created_at timestamptz!, updated_at timestamptz!, docs jsonb!, lost_reason text, nurture_step integer!, nurture_last_sent_at timestamptz, nurture_opted_out boolean!, nurture_token uuid!`

Note `raw jsonb` (original webhook payload) and `docs jsonb` (document
tracking) — neither was visible from the frontend bundle.

### activities
`id uuid!, org_id uuid!, lead_id uuid!, user_id uuid, type activity_type!, content text!, created_at timestamptz!`

### conversations
`id uuid!, org_id uuid!, lead_id uuid, visitor_name text, visitor_email text, visitor_phone text, page_url text, message_count integer!, created_at timestamptz!, last_message_at timestamptz!`

### chat_messages
`id uuid!, conversation_id uuid!, org_id uuid!, role text!, content text!, created_at timestamptz!`

### message_templates
`id uuid!, org_id uuid!, name text!, channel text!, subject text, body text!, created_at timestamptz!`

### imports
`id uuid!, org_id uuid!, user_id uuid, filename text!, kind text!, total integer!, inserted integer!, duplicates integer!, created_at timestamptz!`

### webhook_keys
`id uuid!, org_id uuid!, key text!, label text!, source lead_source!, active boolean!, created_at timestamptz!`

### agent_config — 41 columns
`org_id uuid!, enabled boolean!, agent_name text!, welcome_message text!, knowledge text!, updated_at timestamptz!, groq_api_key text, resend_api_key text, resend_from text, resend_reply_to text, booking_url text, brand_name text, whatsapp text, contact_url text, app_secret text, onboarded boolean!, whatsapp_token text, whatsapp_phone_id text, whatsapp_autoreply boolean!, greeting text, teaser text, header_title text, header_subtitle text, quick_replies text, cta_text text, widget_color text, widget_position text, persona text, tone text, temperature numeric, model text, max_tokens integer, capture_fields text, languages text, away_message text, logo_url text, guardrails text, nurture_enabled boolean!, industry text, telegram_bot_token text, telegram_chat_id text, notify_new_leads boolean!`

**⚠️ Security: this table holds `groq_api_key`, `resend_api_key`,
`whatsapp_token`, `telegram_bot_token`, and `app_secret` — and the frontend
selects from it directly. Any user who can read this row can read those
credentials from the browser. Needs RLS review + moving secret use
server-side into edge functions.**

---

## Enums

| Enum | Values |
|---|---|
| `lead_stage` | new, contacted, counselled, application, offer, visa, enrolled, lost |
| `lead_source` | whatsapp, chatbase, email, website, csv_import, pdf_import, manual, referral, other |
| `activity_type` | note, call, whatsapp, email, meeting, stage_change, assignment, system |
| `user_role` | super_admin, org_admin, counsellor |
| `member_status` | pending, active, disabled |

---

## Edge Functions — ALL 6 RECOVERED ✅

Full source in `supabase/functions/`. 861 lines total. This is the only
original source that survived the wipe.

| Function | Lines | JWT | Purpose |
|---|---|---|---|
| `chat-agent` | 229 | off | Groq-powered AI chat backend (free Chatbase replacement). Fully driven by the `agent_config` row. Lead capture w/ phone normalisation + dedupe. Falls back org key → platform key. |
| `nurture` | 162 | off | Cron-driven email nurture. `GAP_HOURS = [1, 72, 96]`, max 3 steps. Token-based unsubscribe. Logs to `activities`. |
| `lead-webhook` | 139 | off | Lead intake webhook + public capture form API. Authenticated by `webhook_keys.key`. |
| `send-campaign` | 117 | **ON** | One-off compose & send (Resend). Deliberately keeps JWT verification ON — only active org members, only their own org's leads. |
| `summarize-chats` | 110 | off | Groq conversation summariser → `{ summary, interest }`. Transcripts read server-side, org-scoped. |
| `app-signup` | 104 | off | Signup hook for **`app.abrobot.ai`** (a separate product surface). Creates a lead with source `app`, sends one-time welcome, dedupes returning users. Auth via `x-app-secret`. |

### Secrets these functions expect (names only)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`,
`RESEND_API_KEY`, `APP_WEBHOOK_SECRET`, `NURTURE_FROM`,
`NURTURE_REPLY_TO`, `BOOKING_URL`

All correctly read via `Deno.env.get()` — no secrets are hardcoded in the
function source.

---

## ⚠️ Deferred security issue — NOT exploitable today, but has a clear trigger

**Status as of 2026-08-16: dormant.** `profiles` contains exactly two rows —
1 `super_admin` (active) and 1 `org_admin` (active). Zero counsellors. Every
active member is legitimately entitled to these credentials, so nothing is
currently over-exposed.

**This becomes a real vulnerability the day you invite your first
`counsellor`.** Treat that invitation as the trigger to fix it first.

**Why it can't simply be patched now:** the naive fix (restrict the row to
admins) would break every non-admin login. The auth bootstrap runs
`agent_config.select("onboarded")` for *every* user, not just admins, so
tightening the row policy would bounce counsellors into a broken onboarding
state. RLS is row-level, not column-level, so the secret columns can't be
hidden while leaving `onboarded` readable.

The clean fix (move secrets to a separate admin-only table) requires editing
the Settings page, which does `select("*")` + `upsert()` against
`agent_config` — and that is frontend code we no longer have. So this is
coupled to the frontend rebuild.

**Options when the time comes:**
1. Move secrets to an `agent_secrets` table + update Settings (needs frontend).
2. Column-masking view: rename the table, recreate `agent_config` as a view
   returning NULL for secret columns to non-admins, with `INSTEAD OF` triggers
   so the existing upsert keeps working. Zero frontend change, but fiddly with
   PostgREST's `on_conflict` upsert.
3. Interim: null out `groq_api_key` / `resend_api_key` and rely on
   edge-function env secrets — both `chat-agent` and `nurture` already fall
   back to `Deno.env.get()`, so this is near-zero operational risk.

### The original finding (for reference)

The RLS policy on `agent_config`:

```sql
agent_config_org | ALL | using: (is_super_admin() OR ((org_id = my_org()) AND is_active_member()))
```

grants SELECT to **any active org member**, including `counsellor`. That table
holds `groq_api_key`, `resend_api_key`, `whatsapp_token`,
`telegram_bot_token` and `app_secret`, and the frontend selects from it
directly — so any counsellor can read all of them from the browser.

The server side already does the right thing: `chat-agent` has a
`publicConfig()` that strips secrets before returning widget config. The gap
is only the frontend Settings page reading the row back.

**Fix:** restrict the secret columns to `org_admin`+ (column-level grants or a
split table), and have Settings write secrets through an edge function rather
than reading them back.

---

## Constants recovered from the minified bundle

- Target countries: USA, Canada, UK, Australia, Germany, New Zealand, Ireland, Singapore, Other
- Course levels: Bachelors, Masters, MBA, PhD, Diploma, Language course
- Full CSS design-token set (amber `--brand: #b45309`, `--radius: 16px`, 3 shadow tiers) in `index-B9KeoLgM.css` — reusable verbatim

## Frontend facts (verified)

- React + Vite, **plain CSS with custom properties — no Tailwind**
- **Hand-rolled `popstate` router — no react-router**
- No shadcn, no lucide, no framer-motion
- Deps: `@supabase/supabase-js` (+ auth-js, ssr), `recharts`, `exceljs`, `pdf.js`
- Hosted on **Cloudflare Pages** (not Vercel), deployed straight from this repo
- Live bundle `index-Bw0EU57x.js` is byte-identical to repo HEAD
