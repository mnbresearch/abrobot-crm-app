# What this system actually does — 24 September 2026

A categorised inventory of every feature built to date, written against the
code rather than against the roadmap. Twenty-one feature areas, fourteen edge
functions, eight scheduled jobs, thirty-seven migrations, one embeddable
widget.

The point of this document is to be able to answer, for any feature, three
questions without opening a file: **does it run, what is it made of, and how
would I know if it stopped.** Where the answer is "it does not run", that is
stated as plainly as where it does — a column nothing reads and a function
nothing calls are both recorded here, because in this codebase they are the
things most likely to be mistaken for working features.

## How to read the status labels

| Label | Means |
|---|---|
| **Working** | Live, has run in production, and there is evidence of it running. |
| **Working with caveats** | Live, but with a known failure mode, a partial path, or a gap between what the screen says and what the code does. |
| **Built but unverified** | Code complete and deployed, but has never actually executed against a real tenant — usually because no tenant has configured it. |
| **Partially built** | Some paths work and some are stubs, unwired, or reachable only outside the product UI. |

Every claim below was checked against the source. Where a code comment records
a real past incident, it is quoted in one line — those comments are the only
written history of several outages and they are load-bearing.

---

# Architecture in one page

## The five paths a lead can take from first touch to the CRM

```
                                                                  ┌──────────────┐
 1. Visitor on customer's website                                 │              │
    widget.js  ──POST /chat-agent?org=slug──►  chat-agent  ──────►│              │
      (Groq answers, regex extracts email/phone, inserts lead)    │              │
                                                                  │              │
 2. Form / WhatsApp / Zapier / IndiaMART / JustDial / Google Ads   │   leads      │
    ──POST /lead-webhook?key=<capture key>──►  lead-webhook ──────►│   (RLS,      │
      (dedupes, scores, alerts, optional WhatsApp autoreply)       │   org_id)    │
                                                                  │              │
 3. Admin uploads a CSV                                           │              │
    Import.tsx ──browser supabase-js, RLS──────────────────────►  │              │
      (pre-flights plan quota twice, stops on first chunk error)   │              │
                                                                  │              │
 4. Customer's own system                                         │              │
    ──POST /api/v1/leads, Bearer abk_live_…──►  api  ────────────►│              │
      (SHA-256 key lookup, scope check, Business plan gate)        │              │
                                                                  │              │
 5. Counsellor clicks "Add"                                       │              │
    Leads.tsx ──browser supabase-js, RLS───────────────────────►  │              │
      (dedupe is advisory here only — "Save anyway" is allowed)    └──────┬───────┘
                                                                         │
                                       ┌─────────────────────────────────┘
                                       │  trg_notify_lead_change
                                       │  (AFTER INSERT OR UPDATE OF stage_key)
                                       ▼
                    ┌──────────────────┴───────────────────┐
                    │                                      │
            fire_webhooks()                    call_edge_function('run-automations')
            HMAC-signed POST via pg_net        x-cron-secret header
                    │                                      │
                    ▼                                      ▼
            customer's endpoint                    run-automations
            (reconciled every 5 min)               → _shared/run-actions.ts
                                                   → stage move, assign, tag,
                                                     follow-up, Telegram
```

The trigger is the spine. It exists because `fireEventAutomations()` was
originally imported by exactly one of the five creation paths, so "when a
record is created" rules fired for almost nothing and `stage_changed` fired for
nothing at all. Two of the five paths are browser inserts that cannot call an
edge function even in principle.

> `20260905090000_public_api_and_webhooks.sql:311` — *"A trigger is the only place that sees every write regardless of who made it."*

Both dispatches are individually wrapped in exception handlers
(`20260906100000_prelaunch_hardening.sql:58,72`) so that a slow customer
webhook or a dead edge function cannot abort the insert on all five paths at
once.

## After intake

- **Scored once, at intake** — `_shared/score.ts`, called from `chat-agent` and `lead-webhook`. Never recomputed automatically.
- **Swept every 15 minutes** — `run-automations` walks orgs least-recently-swept first, with a resume cursor.
- **Emailed daily at 09:30 UTC** — `nurture`, opt-in per tenant, capped at 80 sends per run across the whole platform.
- **Archived, not deleted** — `archive_lead()` sets `deleted_at`; a RESTRICTIVE RLS policy hides it; `purge_archived()` hard-deletes after 30 days at 03:15.
- **Watched every 15 minutes** — `watch_jobs()`, pure SQL on pg_cron, no HTTP in the detection path.

## Frontend shape

React 18 + Vite 7 + TS strict, hand-rolled router (`app/src/lib/router.ts`), no
router library. Sixteen routes, built to `app/dist`, copied to the repo root,
served by Cloudflare Pages off `main`. `_redirects` still hands eight paths
(`/get`, `/onboarding`, `/myday`, `/priority`, `/compose`, `/analytics`,
`/leaderboard`, `/super`) to the **legacy bundle** — the cutover is incomplete
and that file is the whole mechanism.

| Route | Screen | Gate |
|---|---|---|
| `/` | Dashboard | member |
| `/leads`, `/leads/:id` | Leads, LeadDetail | member |
| `/pipeline` | Pipeline (kanban) | member |
| `/calendar` | Calendar | member |
| `/conversations` | Conversations | member |
| `/templates` | Templates | member |
| `/automations` | Automations | admin |
| `/reports` | Reports | member |
| `/activity` | Activity | member |
| `/team` | Team | member (write: admin) |
| `/import` | CSV Import | admin |
| `/archived` | Archived | admin |
| `/integrations` | Integrations | admin |
| `/settings` | Settings | admin |
| `/admin` | Platform console | super admin |

---

# 1. Auth & tenancy

**What it does.** People sign in with a magic link — there are no passwords.
Which organisation you belong to is decided by the database, never by anything
your browser sends.

**How it works.** `Login.tsx:19` calls `supabase.auth.signInWithOtp`. Comment
at `Login.tsx:4`: *"passwords are the single biggest support and breach surface
in a small SaaS."* Membership lives in `profiles.org_id`, keyed to
`auth.uid()`, and is set only by `create_organisation()` or `accept_invite()`.
`public.my_org()` resolves it inside every RLS policy. Edge functions re-derive
identity server-side with `admin.auth.getUser(token)` and then read `profiles`
by the verified user id — `callFunction()` (`app/src/lib/supabase.ts:17`)
attaches only the access token and nothing else.

Org identity is never taken from the request on any privileged path. The one
apparent exception is closed: `SECURITY DEFINER` functions that legitimately
need to move a profile into an org set a transaction-local flag,
`app.profile_bootstrap`, which only definer code can set
(`20260901090000_security_hardening.sql:119-146`) — *"set_config(..., true) is
scoped to the transaction, so it cannot leak into a later client statement."*

**Configured by.** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (build-time,
with hardcoded production fallbacks at `supabase.ts:7-8`). The anon key is
public by design; RLS is the boundary.

**Status: Working.** Four distinct privilege-escalation routes have been found
and closed — self-promotion via a `profiles` UPDATE with no `WITH CHECK`, tenant
escape via editing `org_id`, escalation via inviting yourself as `super_admin`,
and identity theft by editing `profiles.email` before calling `accept_invite()`.
Each is documented at its fix site in `20260819140000_profile_privilege_guard.sql`
and `20260901090000_security_hardening.sql`.

**Verified by.** No automated test. Both migrations end in manual "run this as
a non-super-admin" SQL blocks. This is the largest untested security surface in
the system.

---

# 2. Signup, org creation & onboarding

**What it does.** A signed-in person with no organisation either accepts a
pending invite or creates their own org, picks an industry, and lands in a
working CRM. There is no trial — the free tier is a real, small allowance.

**How it works.**

- `CreateOrg.tsx:29` calls `accept_invite()` first, on load, for anyone with no org.
- If there is no invite, `create_organisation(p_name, p_industry)` (`20260908090000_pricing_reset.sql:337-413`) creates the org on plan `free`, generates a collision-resistant slug, seeds `agent_config`, and calls `apply_industry_pack()`. One org per account, enforced by a `profiles.org_id is not null` check.
- `Onboarding.tsx:17` is a single-screen industry picker calling `apply_industry_pack(org_id, slug)`.
- `SetupChecklist.tsx` (rendered on the Dashboard) reads `integration_status()` and shows what is still unconfigured.

**`app-signup` is not signup.** Despite the name, `supabase/functions/app-signup/index.ts`
does not create an organisation, account or tenant. It is a lead-capture
webhook for the marketing site that writes into the fixed `abrobot` org's
`leads` table (`app-signup/index.ts:94`) and sends a welcome email. Auth is a
constant-time-compared `x-app-secret` header that fails closed —
*"This used to read `if (APP_SECRET && ...)`, so an unset secret disabled the
check entirely. That made this an open relay"* (`app-signup/index.ts:64`). A
second fixed bug in the same file: the `lead_source` enum has no `"app"` value,
so every insert failed and the error was discarded — *"Signups from the app have
been dropping on the floor."*

**Configured by.** `organizations.industry_slug`, `new_org_plan()` (returns
`'free'`), `APP_WEBHOOK_SECRET`, `RESEND_API_KEY`, `NURTURE_FROM`.

**Status: Working with caveats.** The flow works. One checklist item is
actively wrong: `SetupChecklist.tsx:136` tells a customer *"Alerts are switched
on but there is no Telegram bot token or chat ID saved, so nothing can be
delivered"* whenever their own `agent_config.telegram_bot_token` is empty — but
`_shared/notify.ts:104` falls back to the platform `TELEGRAM_BOT_TOKEN`, so
delivery works fine. `integration_status()`
(`20260905120000_credential_columns_and_status.sql:140`) computes `configured`
from the per-org columns only and has no knowledge of the platform fallback.
The checklist nags about something that works. Confirmed still present in the
code today.

**Verified by.** No automated test for `app-signup`, `create_organisation`,
`apply_industry_pack` or the checklist.

---

# 3. Industry packs

**What it does.** Choosing "Dental & Aesthetic" instead of "Study Abroad"
changes the pipeline stages, the custom fields, the dashboard KPIs, the word
for a lead ("Patient" vs "Student"), the quick actions, the AI agent's persona
and greeting, and which calculator appears on a record. One codebase, fourteen
verticals.

**How it works.** Two halves that must agree:

- **Database half** — `public.industries` is the catalogue; `apply_industry_pack(org_id, slug)` (`20260817090000_multi_industry_foundation.sql:486-557`) seeds `pipeline_stages` and `field_defs` from `industries.default_stages` / `default_fields`, sets `organizations.industry_slug`, and writes persona/knowledge/greeting/quick_replies into `agent_config`. Idempotent — `on conflict do nothing`.
- **Frontend half** — `app/src/lib/industries.ts` (557 lines) holds the terminology, KPI definitions, quick actions, default columns and tool assignment per pack.

**The fourteen packs.** `hospital` (triage tool), `clinic` (quote), `study_abroad`
(roi), `education` (quote), `real_estate` (budget_match), `legal` (none),
`fitness` (quote), `finance` (emi), `automotive` (emi), `travel` (trip_cost),
`recruitment` (ctc_compare), `home_services` (quote), `b2b_saas` (none),
`wholesale` (added later, `20260911110000_fix_industry_assignment.sql:65`), plus
`general` as the fallback.

**Switching packs later is allowed but incomplete.** `apply_industry_pack` can be
re-run and will add the new pack's stages — but it deliberately does **not**
remap existing leads' `stage_key`, so records sit in the old columns alongside
the new ones. `20260911110000...sql:214-255` ships a commented-out remap script
to be run *"deliberately, one org at a time"*, with the reasoning: *"Stages are
referenced by leads.stage_key, so remapping them moves real records between
columns. That is a decision with data behind it, not a cleanup."*

**`restore_pack_authorisation` is a security fix, not a feature.**
`20260912090000_restore_pack_authorisation.sql` exists because the previous
migration rewrote `apply_industry_pack` and dropped its authorisation check.
For the period between the two, a `SECURITY DEFINER` function granted to
`authenticated` took an arbitrary `p_org_id` and performed no ownership check —
*"since that migration was applied, the function has been a CROSS-TENANT WRITE
PRIMITIVE."* Any signed-in free-tier user who knew another org's UUID could
rewrite that org's pipeline, custom fields and AI persona. The fix restores the
check as the first statement in the body and additionally revokes `plan_of` /
`effective_plan` from `authenticated`, which had the same shape of hole for
reads.

**The industry tools are local calculators and nothing more.** `app/src/lib/tools.ts`
and `IndustryTool.tsx` implement EMI, affordability, triage, CTC comparison,
trip cost, ROI and quote calculators entirely in `useState`. There is no
Supabase call anywhere in `IndustryTool.tsx`; nothing is written back to the
lead. `tools.ts:1` says so: *"Kept as pure functions so they are testable and
reusable from an edge function later."* The triage tool is explicitly labelled
non-clinical (`tools.ts:64`).

**Status: Working with caveats** — the packs themselves are live and correct;
pack-switching leaves orphaned stages, and the tools are display-only.

**Verified by.** No automated test for `industries.ts`, `tools.ts` or
`IndustryTool.tsx`. The closely related `_shared/stage.ts` has a strong suite
(`stage.test.cjs`).

---

# 4. Lead intake

Five paths. They share dedupe rules and phone normalisation, and they all
converge on `trg_notify_lead_change`.

## 4a. The embeddable chat widget

**What it does.** One `<script>` tag on the customer's own site renders a chat
bubble. The bot answers from the tenant's knowledge base and creates a lead
when it picks up an email or phone number.

**Path.** `widget.js` → `GET /chat-agent?org=slug&config=1` for public config →
`POST /chat-agent` per message. Its only network call is to `chat-agent`
(`widget.js:45,358,403`) — it never touches `lead-webhook`.

**Config.** `data-org` is required and the script refuses to render without it
(`widget.js:33`). Optional `data-booking`, `data-contact`, `data-logo`.
Everything else — greeting, teaser, header, quick replies, colour, position,
CTA, logo — comes from that org's `agent_config` row.

The script finds its own tag **by `src`**, not `document.currentScript`, because
GTM / Shopify / Segment injection makes `currentScript` null — which previously
caused a cross-tenant branding leak where a dental clinic's visitors saw
AbroBot's copy (`widget.js:18-43`).

**Status: Working with caveats.** The caveat is structural: `chat-agent` serves
`Access-Control-Allow-Origin: *` (`chat-agent/index.ts:76`) and there is no
per-org domain allowlist anywhere in the schema. An org slug is not a secret —
it is in the embed snippet. Anyone can therefore pull a tenant's widget config
or drive its chat quota from any origin, bounded only by the 20/min per-IP rate
limit.

**Verified by.** `_shared/widget-linkify.test.cjs` — DOM-parsed XSS assertions
against **both** copies of `widget.js` in the repo (`widget-linkify.test.cjs:83`).
The suite exists because escaping bugs pass string-based checks: *"a string check
can pass on markup a browser would still build."*

## 4b. `lead-webhook` — the public HTTP endpoint

**What it does.** A URL a customer can paste into a capture form, Zapier,
IndiaMART, JustDial, TradeIndia, a Google Ads lead form, or WhatsApp Cloud API.
Accepts JSON and form-encoded bodies (`_shared/sources.ts` `parseBody` — form
encoding is what Twilio and plain HTML forms send). Handles inbound WhatsApp
payloads (Meta and Twilio shapes) and generic JSON.

**Native adapters** (`_shared/sources.ts`, tested in `sources.test.cjs`):
IndiaMART Push API (`SENDER_*`, `QUERY_*`, `UNIQUE_QUERY_ID`, with or without the
`RESPONSE` wrapper), Google Ads lead forms (`user_column_data[]`; `google_key`
must equal the capture key, else 403), TradeIndia (`sender_*`, `rfi_id`), JustDial
(`leadid`, or any `mobile` payload on a key whose source is `justdial`). Each maps
onto the flat shape the generic path already validates, dedupes and scores; the
record's `source` is the detected provider. JustDial and TradeIndia field names
are from their commonly documented formats — confirm against the first live lead.

**Meta Lead Ads are NOT natively supported, and cannot be via this URL.** Meta's
leadgen webhook carries only a `leadgen_id`; the contact details must be fetched
from the Graph API with a page token and the `leads_retrieval` permission (app
review). Such payloads are recognised and answered 422 with Zapier guidance
rather than silently dropped. Use Zapier: Facebook Lead Ads → Webhooks by Zapier.

**Source values.** `indiamart`, `justdial`, `tradeindia`, `google_ads`,
`meta_ads` are added to `lead_source` by migration `20261007090000`, which also
keeps them inbound-exempt in `guard_lead_limit`. Until it is applied, an insert
with a new source fails 22P02 and lead-webhook retries with the key's own source,
so no lead is lost.

**Path.** `POST /lead-webhook?key=<capture key>` → `webhook_keys` lookup →
dedupe against `leads` → insert or enrich → `activities` → Telegram alert →
optional WhatsApp autoreply.

**Auth.** `?key=` is matched against `webhook_keys.key` — **plaintext, not
hashed** (`lead-webhook/index.ts:144`). This differs from the REST API's keys,
which are SHA-256 hashed. A `webhook_keys` leak exposes directly usable keys.
Each key is scoped to one `org_id`, one `source`, and an optional `segment`.

A missing key returns 401; a *database error* resolving the key returns **503,
not 401** — deliberately, so Zapier and Meta do not permanently disable the
webhook over a transient blip (`lead-webhook/index.ts:150`).

**Limits, quoted.**

```ts
const { data: rl, error: rlErr } = await supabase.rpc("hit_rate_limit", {
  p_key: `lead:${wk.org_id}:${ip}`, p_limit: 60, p_window_seconds: 60,
});
...
const MAX_BODY_BYTES = 32 * 1024;
```

60/min per org+IP, checked before any write, failing closed on RPC error; 32 KB
body cap checked against both `Content-Length` and the actual read length so
chunked encoding cannot hide size (`lead-webhook/index.ts:184-216`). This closes
audit finding H1, which is listed as open in `RUN-THIS-NEXT.md` — that entry is
now stale.

**Custom fields are allow-listed.** The public body's `custom` object is
filtered against the org's own `field_defs`; unknown keys dropped, values
stringified and capped at 500 chars, and the whole thing fails closed if
`field_defs` cannot be read (`lead-webhook/index.ts:91-130`).

**Dedupe enriches, never overwrites.** On a match it appends an activity and
fills only empty fields (`lead-webhook/index.ts:261-336`).

**Status: Working.**

**Verified by.** No automated test for the handler, `extractLead()` or
`resolveCustom()`.

## 4c. CSV import

**What it does.** An admin uploads a spreadsheet, maps columns, and the rows
land as records — or the whole import is refused before a single row is written.

**Path.** `Import.tsx` → browser `supabase-js` under RLS → `usage_snapshot()`
RPC → paged dedupe index → chunked `INSERT` → `imports` history row. **No edge
function is involved.**

**Plan quota is pre-flighted twice** — once before parsing (`Import.tsx:119`)
and again after dedupe, against the actual insert count (`Import.tsx:242`) —
and the insert loop stops on the first chunk failure rather than continuing
(`Import.tsx:270`), after a documented incident where 1,500 rows went in, 1,000
committed, and 500 were silently lost.

Soft-deleted rows are excluded from the dedupe index by RLS rather than by an
explicit filter — the query has no `deleted_at` predicate and does not need one.

**Status: Working.** Called out in `AUDIT-2026-09-17.md:173` as sound: *"both
pre-flight, both refuse rather than partially commit, both report honestly."*

**Verified by.** No automated test.

## 4d. Public REST API `POST /leads`

Covered in full under **§14 Public REST API & API keys**.

## 4e. Manual "Add" in the UI

`Leads.tsx:396-506`. Debounced live dedupe check while typing, which raises an
amber *"Already in your CRM… Saving will create a second record"* warning and
relabels the button "Save anyway" — but `save()` proceeds regardless
(`Leads.tsx:424-440`). **This is the only creation path where a duplicate can
be made deliberately**, which is intentional. Plan cap is enforced by the
`guard_lead_limit` trigger, not by the screen.

## Dedupe across all five paths

| Path | Matches on | Excludes archived | Behaviour on a hit |
|---|---|---|---|
| Widget → chat-agent | email OR phone | yes (`chat-agent:511`) | merges into existing lead |
| lead-webhook | email OR phone | yes (`lead-webhook:232`) | merges, fills empty fields only |
| CSV import | email OR phone | yes, via RLS | skipped, counted, reported |
| REST API | email OR phone | yes (`api:283`) | `200 {deduped:true, id}` |
| Manual add | email OR phone | yes, via RLS | **advisory only** |

All four programmatic paths normalise `9876543210` → `+919876543210`, so records
dedupe across channels. All four escape PostgREST `.or()` delimiters before
interpolation.

## Dead columns at intake

- **`leads.raw`** — written by `lead-webhook` only (`lead-webhook/index.ts:378`), holds the entire original payload. Grepped `app/src`: **zero readers**. Deliberately excluded from the public API response — *"not ours to hand back out"* (`api/index.ts:46`). It exists for manual SQL debugging and nothing else.
- **`utm_*`** — does not exist. Zero hits repo-wide. Lead capture happens on customer marketing pages and no campaign attribution is captured anywhere.

## `hit_rate_limit()` — complete caller list

Defined once (`20260906100000_prelaunch_hardening.sql:387`). Exactly two
callers: `lead-webhook/index.ts:184` (60/min) and `chat-agent/index.ts:379`
(20/min). **Not** called by `api/index.ts` — see §14.

---

# 5. The AI chat agent

**What it does.** A per-tenant chatbot that answers visitors from the tenant's
own knowledge base, asks for one contact detail at a time, and turns a
conversation into a CRM record.

**How it works.** `widget.js` → `chat-agent/index.ts` → Groq → `conversations`,
`chat_messages`, `leads`, `activities` → Telegram.

1. Org resolved by slug, **no default org** — an unmatched slug returns 400 rather than falling back to a real tenant (`chat-agent:279-296`).
2. Rate limit, fails closed (`:378`). Message capped at 2000 chars (`:309`).
3. History: last 20 messages, `created_at desc` then reversed (`:448`). This was blocker B3 — `.order("created_at")` defaults to **ascending**, so the model was fed a frozen window of the opening exchange forever. Invisible on short chats, guaranteed on long ones, i.e. it broke exactly the conversations that were about to convert.
4. Contact extraction by regex; lead created once; `stage_key` resolved via `firstStageKey()` rather than hardcoded `'new'`.
5. `consume_usage` metering, fails closed both on RPC error and on `allowed:false` (`:613-642`).
6. Groq call with a fallback chain, retry and backoff (`:648-781`), `<think>` chain-of-thought stripped (`stripReasoning`, `:97`).

**Model chain.** `DEFAULT_MODEL = "openai/gpt-oss-120b"`, `FALLBACK_MODELS =
["openai/gpt-oss-20b"]`, per-request chain is `[agent_config.model || DEFAULT,
...FALLBACK]` deduped.

**Configured by.** `GROQ_API_KEY` (platform) or `agent_config.groq_api_key`
(per-org override). Behaviour columns: `enabled, agent_name, persona, tone,
knowledge, capture_fields, languages, guardrails, temperature, model,
max_tokens, away_message`, plus the public widget-appearance set.

**Status: Working with caveats.** Two:

- **The Settings model dropdown offers dead models.** `Settings.tsx:980-984` still lists `llama-3.1-8b-instant` (shut down by Groq on 2026-08-16) and `qwen/qwen3.6-27b` (a preview model at 4–5× the primary's price) — both of which `chat-agent/index.ts:39-56` documents as retired or unfit. Picking either writes `agent_config.model`, which goes **first** in the chain, so every message pays a 404 before falling through. This is audit finding H9 and it is open.
- **`conversations.lead_id` is updated without checking the error** (`chat-agent/index.ts:590`). Every other write in the file is checked. Finding H8: the lead exists, the transcript exists, and the link between them never forms.

**Verified by.** No automated test for the handler. `score.test.ts` covers the
scoring it calls.

**Incidents recorded in the comments.**

> `:29` — *"a single hardcoded model is a single point of failure against a provider that deprecates on its own schedule."*
> `:97` — measured live: 2 of 4 replies leaked raw `<think>` reasoning to visitors.
> `:220` — across 139 conversations the bot asked for all three contact fields at once in 110, and 93 of those visitors left. Conversion at 3+ messages was 14/20.
> `:355` — the rate-limit check used to run *after* six writes per request.
> `:676` — a reasoning model spent its whole 900-token budget thinking about "What does AbroBot cost?" and emitted no answer.

`AGENT-SETTINGS.md:24` records the agent quoting a fictitious "Document
Essentials Pack" with invented prices, sourced from stale text buried in a
13,804-character knowledge base that contradicted corrected pricing appended
below it.

---

# 6. Lead scoring

**What it does.** Every record gets a 0–100 score with an explainable
breakdown. It is a fixed weighted sum, not a model.

**Weights** (`_shared/score.ts:16-26`, summing to exactly 100):

| Signal | Max | Note |
|---|---|---|
| budget | 25 | banded by INR tier |
| phone | 15 | *"strongest intent signal we hold"* |
| engagement | 12 | saturates at 5 interactions |
| email | 10 | |
| intake | 10 | ≤3mo full, ≤6mo ×0.75, ≤12mo ×0.5, past = 0 |
| country | 8 | |
| stage | 8 | `lost` = 0 |
| course | 6 | |
| course_level | 6 | |

**Written** at `chat-agent:548` and `lead-webhook:362` — intake only — and in
bulk by `rescore-leads`. **Read** by the Leads list and sort, LeadDetail,
Pipeline cards, Dashboard urgency ranking (`score + overdueDays*12 + dueToday?25`),
Reports average and CSV column, the `score_above`/`score_below` automation
conditions, and the Telegram alert line.

**Status: Working with caveats.** Nothing recomputes a score when the data
behind it changes. Editing a lead's budget, intake or stage does not rescore.
`rescore-leads/index.ts:6` says so: *"can be re-run any time weights change or
as a scheduled refresh (engagement and intake proximity both drift over time)"*
— but nothing schedules it and, as below, nothing calls it either. Every score
in the system is a snapshot of the moment the record was created.

**Known edge case** (`supabase/functions/CHANGES.md`): a bare year like
`"2026 intake"` is read as mid-2026, already past, and scores 0 for intake.

**Verified by.** `_shared/score.test.ts` — bounds, ordering, monotonic budget
bands, non-numeric budget → 0 not NaN, intake proximity, `lost` = 0, and a
breakdown-sums-to-score invariant. Good coverage of the maths, none of the
write paths.

## `rescore-leads` — built, deployed, documented, never called

`app/src` contains **zero references to `rescore-leads`**. No button, no admin
action, no cron entry. The only mentions anywhere are its own source, the
deploy script (which deploys it), and documentation including a manual `curl`
in `CHANGES.md:83`. It is correctly authenticated (JWT on, caller's own org
only), supports `dry_run`, pages by keyset with a 45-second wall-clock budget,
and aborts with **no writes** if the activities read fails rather than risk
zeroing everyone's engagement component. It is well-built dead code.

**Status: Partially built** — the function is complete; the product has no way
to invoke it.

---

# 7. Pipeline & stages

**What it does.** A kanban board. Columns come from the tenant's own
`pipeline_stages`, seeded by their industry pack.

**How it works.** `Pipeline.tsx` reads `stages` from the app store.
`moveTo()` (`:44-70`) updates the UI optimistically, writes
`leads.stage_key`, rolls back on failure, then logs a `stage_change` activity
best-effort — *"a failure here must not undo it, but it must not be invisible
either"* (`:62`). The stage write fires `trg_notify_lead_change`, which
dispatches `stage_changed` automations and `lead.stage_changed` webhooks.

`is_won` / `is_lost` flags on each stage drive the conversion KPI, the trophy
and ✖ icons, the Calendar "done" filter, and the nurture stop set.

**Status: Working with caveats.** HTML5 `draggable` does not fire on touch
devices at all — *"the entire pipeline was read-only"* (`Pipeline.tsx:10`). The
retained fix is a "Move ▾" button opening a stage picker, which is also the
keyboard path. Drag-and-drop remains desktop-only.

**The `firstStageKey` incident** (`_shared/stage.ts:1-19`) is the sharpest
example of a whole-product failure from a one-line default. Intake paths used
to insert without `stage_key`, defaulting to the legacy enum `'new'`. Only 2 of
13 packs have a stage keyed `'new'`; the other 11 start at `'enquiry'` or
`'sourced'`. `Pipeline.tsx:33` builds columns from `pipeline_stages` and silently
drops any lead whose key has no column.

> `stage.ts:14` — *"The record existed, it was counted, it was billed; it just could not be seen where anyone would look for it."*

**Verified by.** `_shared/stage.test.cjs` — ordering, cross-tenant scoping, the
recruitment `'sourced'` case, the fallback-on-error path, that the error is
logged with org id, and that the error path never rejects. Substantive.

---

# 8. Automations engine

**What it does.** "When X happens, do Y, unless it already happened recently."
Rules fire instantly off the database trigger for record-created and
stage-changed, and every 15 minutes for time-based conditions.

**How it works.**

- **UI** — `Automations.tsx`: When / Only if / Then builder, plain-English `describe()`, recipes, a dry-run "Test run" button (`:171`), enable/pause. CRUD goes straight to the `automations` table under RLS; no edge function.
- **Event path** — trigger → `call_edge_function('run-automations', {event, lead_id, org_id})` → `run-automations/index.ts:86-117` → `fireEventAutomations()` (`_shared/run-actions.ts:314`).
- **Cron path** — `run-automations` with no event → pages orgs, ordered by `automation_sweep_state.updated_at` so the least-recently-swept org goes first → pages leads with a resume cursor → `shouldRun()` → `executeActions()`.
- **Both paths call the same `executeActions()`.** There used to be two copies of the nine-case switch and they had already drifted; the round-robin fix landed in only one, so a rule behaved differently at intake than at 3am. One executor now.

**Triggers** (6, full parity with the UI): `lead_created`, `stage_changed`,
`no_contact_for`, `follow_up_overdue`, `score_above`, `score_below`.

**Actions** (`_shared/run-actions.ts:104-269`):

| Action | Implemented | In the UI builder |
|---|---|---|
| `set_stage` | yes | yes |
| `assign_round_robin` | yes | yes |
| `set_score` | yes | yes |
| `add_tag` | yes | yes |
| `set_follow_up` | yes | yes |
| `add_note` | yes | yes |
| `notify_telegram` | yes | yes |
| `assign_to` | **yes** | **no** |
| `send_email_template` | **no — deliberate stub** | no |

`assign_to` (assign to one named person) is fully implemented and unit-tested
but has no control in the builder — reachable only by writing the `automations`
row directly. `send_email_template` is in the type union and the DB enum but
refuses with `"send_email_template is not wired to the mailer"`, non-fatal:
*"Unattended sending needs the unsubscribe and rate handling the nurture
function already owns; duplicating it risks mailing a lead who opted out"*
(`run-actions.ts:252`).

**Cooldowns.** Read via `automation_last_runs()` — batched, one row per lead
per call. The old query pulled the whole cooldown window unbounded, and
PostgREST truncates at 1,000. Truncation there is not a shorter answer, it is
an **inverted** one: a row present means "already ran, skip"; missing means
"never ran, go ahead". Past a thousand runs in the window a rule stopped seeing
its own history and re-fired — a second Telegram alert, a second stage move, on
the same lead, the same day.

**Configured by.** `plan_limits.max_automations`, enforced by the
`guard_automation_limit()` trigger counting only `enabled = true` rows. Cron
`*/15 * * * *`. No env secrets of its own; Telegram credentials are read inside
`notify.ts`.

**Status: Working.** Heavily hardened, with one honest gap (`send_email_template`)
and one UI omission (`assign_to`).

**Verified by.** `_shared/automations.test.cjs` and `_shared/run-actions.test.cjs`.
The latter is the strongest test in the repo: a fake postgrest client that
resolves with `{data:null, error}` and never throws, proving every write path
checks `error`; exact write payloads per action; fatal vs non-fatal semantics;
the round-robin quadratic-cost fix (one RPC for three leads); and the `add_tag`
in-memory staleness fix. Neither covers `run-automations/index.ts` itself — the
sweep's pagination, fairness ordering and heartbeat wiring are untested.

> `run-actions.ts:206` — two rules tagging the same lead in one sweep could destroy each other's tag.

---

# 9. Nurture sequences

**What it does.** A daily, opt-in, up-to-three-step follow-up email sequence
built from the tenant's own templates, segmentable by which capture key the
lead came from, that stops when the lead is won or lost and honours
unsubscribes.

**How it works.** `nurture/index.ts`, `30 9 * * *` (09:30 UTC = 15:00 IST, so
replies land in working hours).

Per org: read `agent_config` → refuse unless `nurture_enabled` → build
sequences from `message_templates` grouped by `nurture_segment` and
`nurture_step` (`_shared/sequences.ts`) → read `pipeline_stages` for the
won/lost stop set → check `email_allowance()` → one query pass per segment,
each with a **due-ness predicate in SQL** → send via Resend → stamp
`nurture_step` and `nurture_last_sent_at` → log an activity →
`consume_usage('emails')`.

**Budgets.** `MAX_SENDS_PER_RUN = 80` across the whole platform,
`ORGS_PER_RUN = 25`, `LEADS_PER_ORG = 100`. Gaps between steps:
`GAP_HOURS = [1, 72, 96]`.

**Three blockers fixed here, all of the same family.**

- **B7 — starvation.** Due-ness used to be computed in JavaScript *after* fetching, while the query ordered oldest-first with `limit(100)` and no due predicate. The oldest 100 leads held the page through their entire 72h/96h waiting windows. Simulated on 300 overdue leads, the last lead's first email moved from **day 20 to day 2**.
- **B6 — false health.** Per-lead failures went into a local array nothing read; a run where 2,400 of 2,500 sends failed wrote `last_status = 'ok'`. Now `degraded = threw > 0 || refused > 0 || failures > 0` sets the heartbeat to `warn`, and the function additionally returns HTTP 500 when `sent === 0 && failures > 0` — *"a single channel nobody reads is the same as no channel at all."*
- **H6 — emailing customers who already bought.** An unchecked `pipeline_stages` read left `terminal` null and `stop` empty, and the guard at the send site is `if (stop.size)`, which then skips the exclusion **entirely**. Now fails closed: a read error skips the org and sends nothing.

> `nurture/index.ts:229` — *"a refused read left `terminal` null, `stop` empty… which then skips the exclusion ENTIRELY and emails the people it exists to protect."*

An org with **no won/lost stage at all** is allowed but carries a warning on
every run, because nothing ever removes a record from follow-up there.

**Opt-in is strict.** `nurture_enabled` defaults to `false`; a missing
`agent_config` row is not consent. `nurture/index.ts:1` records why: *"the first
correct cron run would email a dental clinic's patients about university
shortlists… from our sending domain."*

**Unsubscribe.** Served by the `nurture` function itself at `?unsub=<token>`
(`:538-605`), keyed on `leads.nurture_token`. `GET` renders a confirm page and
mutates nothing — RFC 8058 one-click safety, because link scanners prefetch.
`POST` sets `nurture_opted_out`. This same endpoint serves one-off campaigns
too.

**Segments are live, not a dead table.** `webhook_keys.segment` → `leads.segment`
→ matched against `message_templates.nurture_segment`. One query pass per named
segment plus one default, each bounded by its own sequence's `maxStep`.

**Configured by.** `agent_config.nurture_enabled / resend_api_key / brand_name /
contact_url / booking_url`; `plan_limits.max_emails`; env `RESEND_API_KEY`,
`NURTURE_FROM` (default `hello@updates.mnbresearch.com`), `CRON_SECRET`.

**Status: Working with caveats.** The caveat is H7 and it is real: the `from`
address is a hardcoded platform domain. A tenant who supplies their own Resend
API key gets a **100% send failure rate**, because that key is not authorised to
send from `updates.mnbresearch.com`. Only the display name is tenant-branded
(`"${brand} <${FROM_ADDRESS}>"`) — deliberate, since a tenant's own domain is
not SPF/DKIM-authorised on our sender, but it means "bring your own Resend key"
is offered in Integrations and cannot work. Columns `agent_config.resend_from`
and `resend_reply_to` exist in the live schema (`RECOVERED-SCHEMA.md:67`) and
are read by **nothing** — grep returns only the audit entry describing them.

**Verified by.** `_shared/sequences.test.ts` — 9 Deno cases including the
central one, that a segment with its own sequence does **not** also inherit the
default. `_shared/template.test.cjs` for the merge engine. No test exercises
`nurture/index.ts` itself: the due-ness query, the budgets, the heartbeat
escalation and the unsubscribe handler are all untested.

---

# 10. Email campaigns & templates

**What it does.** Templates is the single store of reusable email and WhatsApp
copy with merge tokens. An admin can send one-off to a filtered audience or to
a single test address.

**How it works.** `Templates.tsx` CRUD on `message_templates` direct under RLS;
`SendModal` (`:451`) calls `send-campaign`. Merge tokens come from `BASE_TOKENS`
plus the org's own custom fields. `send-campaign/index.ts` verifies the JWT,
requires `org_admin` or `super_admin`, reads `email_allowance()`, resolves the
audience, sends via Resend, logs activities, and meters with the **actual sent
count, not the attempted count** — *"A bounce at Resend is not something to bill
a customer's allowance for"* (`:254`).

Hard cap `MAX_RECIPIENTS = 2000`. `count_only` mode lets the UI show the number
before sending. A quota shortfall refuses the **whole** send rather than
partially sending (`:222`). An `email_allowance()` RPC error returns 503 and
sends nothing.

**Status: Working.** This is the clearest "was dead, now wired" case in the
repo. Its own header says so:

> `send-campaign/index.ts:14` — *"This function existed, was correct about authentication, and had ZERO callers — Templates was a notepad with no Send button."*

Role gating was also a real fix: *"'Active member' let any counsellor mass-mail
2,000 people."*

**Caveat.** B5: `send-campaign` returns **HTTP 200** with `{sent: 0, errors:[…]}`
when a send fails, and `LeadDetail.tsx` discarded the return value, so the toast
said "Email sent" for a send that sent nothing. Fixed on 17 September; that fix
shipped on 22 September.

**Verified by.** `_shared/template.test.cjs` — token substitution, unknown
tokens left visible rather than blanked, `firstName()` fallback chain (never a
bare phone number), and a full XSS-ordering suite proving `escapeHtml` must run
**after** `applyTemplate` because lead-supplied names are attacker-controlled.
It also carries a deliberately-failing documented case: a whitespace-only email
defeats the "never an empty greeting" guarantee, marked *"KNOWN FAILURE — do
not weaken this test."* No test for `send-campaign/index.ts` itself.

---

# 11. WhatsApp

**What it does.** Counsellors send free-form WhatsApp messages from a lead
record; inbound WhatsApp leads can get an automatic reply.

**How it works.** `LeadDetail.tsx:132` → `whatsapp-send` (JWT **on**) →
tenancy check → `whatsapp_allowance()` → `getWhatsAppConfig()` →
`sendWhatsAppText()` → Meta Graph API → `consume_usage` after a confirmed send
→ activity row + `last_contacted_at`. The autoreply path is separate: inside
`lead-webhook/index.ts:414-459`, only for `source = "whatsapp"` capture keys,
gated by `plan_allows_whatsapp()` and `agent_config.whatsapp_autoreply`.

**The credential pairing rule** is the interesting part.
`resolveWhatsAppCredentials()` (`_shared/whatsapp.ts:61-101`) will pair the
**platform** token only with `WHATSAPP_PHONE_ID` from function secrets — never
with a tenant-supplied phone id. Finding H3: `whatsapp_phone_id` is a plain
tenant-writable column with no ownership check, and the platform token owns
*every* number on our Meta app. An admin could clear their own token, paste
another tenant's Phone Number ID, and send as them, billed to us. A tenant's
own token still works normally; Meta's own check covers that case.

**The 24-hour rule** is handled honestly: Meta only allows free-form text
inside the window opened by the customer's last message. Outside it, Meta
returns error `131047` and the function passes it through rather than reporting
a false success.

**Configured by.** `agent_config.whatsapp_token / whatsapp_phone_id /
whatsapp_autoreply / whatsapp`; env `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`,
`META_GRAPH_VERSION` (default `v21.0`); `plan_limits.whatsapp` and
`max_whatsapp`.

**Status: Built but unverified.** No tenant has ever configured WhatsApp.
`RUN-THIS-NEXT.md:384` (17 September): *"No org has WhatsApp configured today,
so nothing is affected right now."* Every line of this feature is untested
against Meta in production. There is also a hard external deadline — a Meta
payment method by 30 September — still listed as open.

**Built and unwired:** `plan_limits.max_whatsapp_marketing` (0 free/starter,
300 growth, 600 business) has no code path that can consume it, because
`_shared/whatsapp.ts` sends `type:"text"` only. The comment is candid:
*"nothing can actually send a marketing message yet… This cap exists so that
whoever adds templates has to reckon with it"*
(`20260911100000_whatsapp_economics.sql:148`).

There is also **no `send_whatsapp` automation action**. WhatsApp can only be
triggered by a human on LeadDetail or by the inbound autoreply — never by a
rule.

**Verified by.** `_shared/whatsapp-creds.test.cjs` — 10 assertions on the
credential-pairing boundary only. Nothing covers `sendWhatsAppText`'s HTTP
call, the plan gate, or the autoreply path.

---

# 12. Telegram alerts

Two systems that share a module and nothing else.

## Per-org alerts — telling a customer about their own leads

`_shared/notify.ts:70-137`. Token = the org's `telegram_bot_token`, falling back
to the platform `TELEGRAM_BOT_TOKEN`. Chat ID has **no** fallback, deliberately:

> `notify.ts:104` / `save-integration/index.ts:186` — *"Platform bot token is a valid fallback; chat_id never is, because it identifies THIS customer's channel."*

`notifyNewLead()` has become the generic "ping this org's Telegram" primitive
despite its name. Callers: `lead-webhook:408` (new lead), `chat-agent:584` (chat
capture), `run-actions.ts:237` (the `notify_telegram` automation action),
`billing-webhook:388,537` (refund/chargeback), `system-health:365` (that org's
own health failure).

**Status: Working.** Proved end to end on 17 September — a test lead posted to
the capture webhook returned `{"ok": true, "alert": {"sent": true}}`.

> `notify.ts:76` — a discarded read error would stop every org's alerts while `automation_runs` still recorded `ok: true`: *"The board stays green while nobody is being told about any new enquiry."*
> `notify.ts:119` — a Telegram error body used to leak the bot token; now routed through `scrubToken`.

**Open configuration issue:** `mnb-research` has `notify_new_leads = true` and
**no chat ID**, so its alerts silently do nothing. The other four orgs all point
at the same chat — fine while every org is ours, not fine for the first real
customer.

## Operator alerts — telling us that a job died

Separate table (`app_settings.ops_telegram_bot_token` / `ops_telegram_chat_id`),
sent by `watch_jobs_notify()` in pure SQL, seeded **absent** rather than with a
placeholder:

> `20260914120000_job_watchdog.sql:180` — *"an operator alert must not depend on a customer's configuration and must never be delivered into a customer's chat."*

**Status: Built but unverified — deliberately unconfigured.** Incidents are
written to `job_incidents` regardless; Telegram is a bonus on top, never the
mechanism.

**Known residual exposure, documented not fixed:** the bot token goes in the
Telegram URL, which `pg_net` stores in `net.http_request_queue`. The migration's
verify block checks whether `anon` / `authenticated` can read the `net` schema.

**Verified by.** No dedicated test. `run-actions.test.cjs` stubs `notifyNewLead`.

---

# 13. Outbound webhooks

**What it does.** A customer registers an HTTPS URL and gets a signed POST
whenever a lead is created or moves stage.

**How it works.** `Integrations.tsx:252` adds an endpoint; `trg_notify_lead_change`
calls `fire_webhooks(org_id, event, payload)`; that computes
`HMAC-SHA256(body, ep.secret)` and sends it as `X-AbroBot-Signature: sha256=…`
via `net.http_post` with an 8-second timeout, so a slow customer endpoint can
never block a lead write. `reconcile_webhook_deliveries()` runs every 5 minutes,
joins `net._http_response` back onto `webhook_deliveries` by `request_id`, rolls
endpoint health forward, and auto-disables after 20 consecutive failures.

**Events:** exactly two — `lead.created` and `lead.stage_changed`.

**B8 — the reconciler disabled healthy endpoints.** `status_code is null` was the
"not yet reconciled" sentinel, but a pg_net *timeout* also has
`status_code = NULL`. The reconciler wrote NULL back, so the row stayed eligible
and re-incremented `failure_count` on **every 5-minute run**. One customer
endpoint that answers slowly was permanently disabled after ~100 minutes, and
there was no UI to re-enable it. Fixed by adding `reconciled_at`, set exactly
once regardless of outcome, plus a one-time blunt repair that zeroed every
failure count and re-enabled every disabled endpoint — because there was no
reliable way to tell genuine failures from the double-counting.

**Pause/resume now exists** (`Integrations.tsx:277`), added for the same reason:

> `Integrations.tsx:269` — the only route back was deleting and re-adding, *"which issues a new signing secret"* the customer then has to redeploy.

**SSRF guard, two generations.** v1 (`20260912100000`) was string-prefix
regexes, which miss every alternative spelling: `https://2852039166/`,
`https://0xa9fea9fe/`, `https://0251.0376.0251.0376/` and
`https://169.254.43518/` all reach 169.254.169.254 and none start with `169.`.
v2 (`20260917120000_ssrf_guard_inet.sql`) parses the host with `inet_aton`
semantics and tests CIDR containment. **43 cases pass**, and the constraint is
now `VALID` rather than `NOT VALID`. Two bugs in the fix itself were caught by
that case table before shipping — the shorthand multiplier was `256^(4-n)`
instead of `256^(5-n)`, and numeric `/` in Postgres is exact division, so
`::bigint` **rounded** 169.254.169.254 into 170.255.170.254, a public address
that passes every reserved-block test. That is why the table asserts exact
addresses rather than just safe/unsafe.

**Still open by design: DNS rebinding.** Documented at
`20260917120000...sql:308`. The real fix is moving delivery out of Postgres into
an edge function that resolves and pins the IP. Not done.

**Configured by.** `webhook_endpoints` (url, secret, events[], active,
failure_count, last_status, last_error, last_success_at); Business plan and
above (`Integrations.tsx:598` renders the card only when `apiAccess !== false`,
server-enforced by `api/index.ts` returning 402).

**Status: Working.**

**Verified by.** No `.test.cjs`. Verification is inline SQL assertion blocks at
the bottom of each migration — including the 43-case address table — run by hand
against the live database, not in CI.

---

# 14. Public REST API & API keys

**What it does.** A Business-plan customer gets a Bearer-token REST API to read
and write their own records.

**Routes** (`api/index.ts`): `GET /me`, `GET /stages`, `GET /conversations`,
`GET /conversations/:id`, `GET /leads`, `GET /leads/:id`, `POST /leads`,
`PATCH /leads/:id`. No `DELETE`, deliberately. No bulk endpoints.

**Key scheme.** `create_api_key(name, scopes, expires_days)` — admin-only,
generates `abk_live_` + 32 random bytes hex, stores **only** `sha256(raw)` plus
a 17-char `key_prefix` for display, returns the raw value once.
`resolve_api_key(raw)` re-hashes and looks up, updating `last_used_at` /
`use_count`. Revoked, expired and never-existed keys are deliberately
indistinguishable. Scopes: `leads:read`, `leads:write`, `conversations:read`,
`stages:read`, validated against an allow-list at creation and checked
per-route by `needScope()`.

**Tenancy.** `org_id` always comes from the resolved key, never from a request
parameter. `PATCH` uses an explicit field allow-list, so a stray field cannot
move a record to another org.

**Configured by.** `api_keys` table; `plan_allows_api()`; Business plan and
above. Deployed `--no-verify-jwt` because the app's own key *is* the auth.

**Status: Working with caveats.** Two:

- **No rate limiting whatsoever.** `hit_rate_limit()` exists and is never called from `api/index.ts`. This is a `--no-verify-jwt` endpoint that does a row-locking `UPDATE` and an unbounded `count(*)` per request. `API.md:184` states it plainly: *"None enforced yet, beyond a hard cap of 200 records per page."* Finding H5, open.
- **Pagination is offset-based with no cursor**, which `API.md:200` documents as able to skip or repeat rows under concurrent writes.

**Verified by.** No automated test. `scripts/api-isolation-test.sh` is an
**interactive** script requiring two orgs' API keys pasted in by hand, and
`RUN-THIS.md` records it as not yet run. `INTEGRATION-STATUS.md:236` is honest
about it: *"that is a reading of the code and the point of this section is that
readings are not evidence."* Cross-key isolation is therefore **built but
unverified** even though the mechanism reads correctly.

`AUDIT-2026-09-17.md:168` did verify the storage: *"32 random bytes, SHA-256
stored, raw value returned exactly once, never logged."*

---

# 15. Credential storage & the Integrations screen

**What it does.** One admin screen for WhatsApp, Telegram, email sending, API
keys and outbound webhooks. Credentials go in and never come back out.

**How it works.** `Integrations.tsx` → `save-integration` (JWT on, admin only)
→ upsert into `agent_config`. Actions: `status`, `save_whatsapp`,
`test_whatsapp`, `save_telegram`, `test_telegram`, `save_email`, `test_email`.
The `status` action returns **booleans only** — `configured`, `phone_id_set`,
`autoreply`, `own_key` — plus non-secret display fields. A `"-"` sentinel
clears a stored credential; blank means "leave as is".

**Write-only is enforced structurally, not by convention.**
`20260905120000_credential_columns_and_status.sql:60-93` revokes table-level
`SELECT/INSERT/UPDATE` on `agent_config` from `authenticated` and `anon`, then
re-grants column-level access to every column **except** `groq_api_key`,
`resend_api_key`, `whatsapp_token`, `telegram_bot_token`, `app_secret`. The
migration explains why a plain column-level revoke does not work:

> `:46` — *"Postgres treats a table-level privilege as covering every column… a column-level REVOKE cannot carve a hole in it — it emits a warning and returns success."*

So even `select("*")` from the browser cannot retrieve those five. Every reader
(`chat-agent`, `nurture`, `send-campaign`, `system-health`, `_shared/notify`,
`_shared/whatsapp`, `save-integration`) runs on the service role.

**A related hole is still open.** `20260816120000_agent_config_secret_hardening.sql:3`
is marked **"NOT APPLIED. Review before running."** Its Step 3 — nulling out the
secret columns in favour of env fallbacks — is commented out. The file's own
note says the exposure is *"DORMANT"* only because the live org has no
non-admin members. It becomes live the moment a counsellor is invited. Note that
`system-health`'s `checkSecurity` exists precisely to detect this state.

**Frontend honesty.** `Integrations.tsx:62-98` distinguishes "confirmed off"
from "status check failed", so a dropped status call cannot tell an org with
live WhatsApp that it has none and invite an admin to overwrite a working
credential.

**Status: Working.**

**Verified by.** No test file. Verified by `has_column_privilege()` assertions
embedded in the migration.

---

# 16. Billing, plans & quota enforcement

**What it does.** Cashfree checkout is the only path that grants a plan, and
every limit in the product is derived from one function that accounts for
expiry, cancellation and refund.

**How it works.**

`Settings.tsx:233` → `billing-checkout` (JWT on, admin only) → price read
**server-side** from `plan_limits.price_inr`, never from the request body →
Cashfree `/pg/orders` with `x-idempotency-key: orderId` → `payments` row with
`status:'created'` → Cashfree SDK loaded on demand and opened. Separately,
Cashfree POSTs `billing-webhook` → HMAC verify → amount reconciliation against
`payments.amount` → `grant_plan_from_payment()` compare-and-swap on
`granted_at is null` → `subscriptions` + `organizations.plan`.

The browser return URL is display-only. Entitlement comes from the webhook.

**The plan matrix** (`20260908090000_pricing_reset.sql`, free tier raised in
`20260911090000`):

| | Free | Starter ₹999 | Growth ₹2,499 | Business ₹4,999 | Enterprise |
|---|---|---|---|---|---|
| Seats | 1 | 3 | 10 | 30 | ∞ |
| Records | 50 | 1,000 | 10,000 | 50,000 | ∞ |
| AI replies/mo | 50 | 1,000 | 5,000 | 10,000 | ∞ |
| Emails/mo | 20 | 300 | 3,000 | 6,000 | ∞ |
| WhatsApp/mo | 0 | 0 | 1,500 | 3,000 | ∞ |
| Automations | 0 | 3 | 25 | 100 | ∞ |
| API access | — | — | — | yes | yes |

`expired` is a synthetic sixth row (1 seat, 0 everything, read-only) that
`effective_plan()` returns once the 3-day grace period elapses. **There is no
free trial** — `PRICING.md:4`: *"₹999 Starter is the front door: sign up free,
set everything up, pay to switch it on."* `CreateOrg.tsx:157` tells the user
this before they invest setup effort.

**Enforcement — every limit is a real gate, not a display.**

| Limit | Mechanism |
|---|---|
| Seats | `guard_profile_changes()` trigger → `plan_seat_cap()` |
| Records | `guard_lead_limit()` trigger — **asymmetric**: inbound sources (website, whatsapp, referral…) are always accepted; manual and import are blocked at cap |
| Automations | `guard_automation_limit()` trigger, counts only `enabled = true` |
| AI replies | `consume_usage(org,'ai_messages')` RPC, limit read internally from `plan_of()` |
| Emails | `email_allowance()` pre-check + `consume_usage('emails')` |
| WhatsApp | `whatsapp_allowance()` pre-check + `consume_usage('whatsapp_messages')` |
| API | `plan_allows_api()`, checked in `api/index.ts:85` |

`20260821080000_enforce_plan_limits.sql:6` records that records, automations and
WhatsApp were previously **DISPLAYED ONLY**. They are not any more.

**The `consume_usage` audit finding is stale.** The audit claimed most call
sites discard the result. Re-checked, all six: `chat-agent:613` and
`summarize-chats:193` check both the error and `allowed`; `nurture:480`,
`send-campaign:255`, `whatsapp-send:122` and `lead-webhook:456` are
fire-and-forget *after* an explicit `*_allowance()` gate, which is metering not
gating. No call site silently ignores a plan-exceeded condition.

**B1 — buy a month, inherit a year.** `grant_plan_from_payment` extended
`current_period_end` from the existing value *and* overwrote `plan`, with no
comparison. Buy Starter annual (₹9,990) then Business monthly (₹4,999) and you
held **13 months of Business for ₹14,989 instead of ₹49,990** — ₹35,001 through
the ordinary UI. Fixed by carrying unused time across as *value*, verified
value-conserving to 0.0% across upgrade, downgrade, renewal and first purchase.
The diagnostic found nobody had exploited it.

**B2 — refunds granted nothing back.** There was no refund or dispute branch,
and `effective_plan` **selected `subscriptions.status` and never read it**, so
even a manual cancellation revoked nothing. Now:

```sql
if coalesce(s.status, 'active') in ('cancelled', 'refunded', 'chargeback') then
  return 'expired';
end if;
```

The refund branch runs **before** the idempotency short-circuit, because a
refund always arrives for an already-granted payment. `DISPUTE_CREATED` alone
does not revoke — only a closed set of "lost" statuses does. A **partial**
refund does not revoke; it is recorded and left for an operator, and the
response says so literally: `"plan not revoked; proportional revocation is not
implemented"`.

**Cashfree specifics.** PG Orders API `2023-08-01`; `CASHFREE_ENV` has **no
default** and fails closed. Signature = `base64(HMAC-SHA256(timestamp + rawBody,
secret))` over raw bytes, constant-time compared. The replay window is 15
minutes, not 5, because Cashfree resends the *original* event timestamp on
retry — *"Observed on order abcrm_abrobot_starter_1787812523559: event_time
12:06:10, retries at 12:06, 12:07, 12:09 and 12:14."* Timestamps arrive in
milliseconds and are normalised by magnitude after live payments 401'd while
hand-built test requests passed, *"because those were generated with
`date +%s`"*.

**Status: Working with caveats.** Three:

- **No auto-renewal.** Subscriptions simply expire and the customer pays again manually. No eNACH or UPI AutoPay code exists.
- **The proration guard called for on the checkout side was never built.** `20260917090000...sql:361` asks for `billing-checkout` to refuse a plan change without an explicit flag and to show the prorated end date first. Re-read in full: there is no comparison of the requested plan to the live plan, no confirmation flag, no preview. The SQL half of B1 is fixed; the UI half that would make the change legible to the customer is not.
- **`PAYMENTS.md` is stale** — it still says 5-minute replay window and describes refunds as manual.

**Verified by.** `_shared/cashfree.test.cjs` — 5 assertions on `verifyWebhook()`
only. **Nothing covers** `createOrder()`, the amount-reconciliation branch, the
refund/dispute state machine, `grant_plan_from_payment`, or
`revoke_plan_from_payment`. The most money-sensitive code in the system has
signature verification tested and nothing else.
`scripts/test-plan-enforcement.sql` exists as a manual script, not in CI.

---

# 17. Team, invites & roles

**What it does.** An admin creates an invite row; the invited person is
attached to the org when *they* sign in.

**How it works.** `Team.tsx:60` upserts to `invites` under RLS (no edge
function). `CreateOrg.tsx:29` calls `accept_invite()` on load for anyone with no
org. `accept_invite()` matches on `auth.users.email` — the JWT-backed value —
not `profiles.email`, which is user-writable and was the basis of a real
identity-theft path. Seat cap is enforced inside `accept_invite()` via
`plan_seat_cap()`, so a lapsed org cannot keep accepting invites.

**Roles:** `counsellor`, `org_admin`, `super_admin`. The invite and role-change
dropdowns deliberately omit `super_admin`:

> `Team.tsx:10` — *"super_admin is a PLATFORM role, not a tenant one. Offering it in this dropdown invited an org admin to promote their own user to it."*

Because PostgREST accepts any enum value regardless of what the dropdown offers,
this is backed by a CHECK constraint `invites_role_not_super` **and** a
defence-in-depth check inside `accept_invite()` itself.

**Seat counting includes pending invites** (`Team.tsx:83`) after an incident
where, on the free plan's single seat, *"every invite 'succeeded', the admin told
their colleague they were in, and the colleague was refused when they tried to
log in."*

**Status: Working with caveats.** The caveat is stated honestly in the UI
itself: **the "Create invite" button does not send an email.** `Team.tsx:129`
says so on screen rather than implying one went out. Getting the invite to the
person is a manual step.

There is also a live housekeeping item: `RUN-THIS-NEXT.md:409` records a
machine-generated account, `audit_sec_1789801652_202348@gmail.com`, holding
**counsellor** access to the AbroBot org — which means real student names,
phone numbers and full chat transcripts. The epoch in the name decodes to
20 September. It is almost certainly residue from an automated security test.
It has not been removed, deliberately, because revoking access is the owner's
call.

**Verified by.** No automated test for `accept_invite()`, `guard_profile_changes()`
or the invite RLS policies.

---

# 18. Soft delete & retention

**What it does.** Deleting a record archives it for 30 days. It disappears
everywhere, can be restored by an admin, and is then permanently purged.

**How it works.**

- `archive_lead(id)` sets `leads.deleted_at` and cascades to that lead's `activities`.
- `restore_lead(id)` — admin only — clears `deleted_at` on the lead and on activities archived within a **5-second window of the same delete timestamp**, deliberately narrow so a note deleted separately a month earlier is not resurrected.
- `archived_leads()` lists them with `days_left`, capped at 500.
- `purge_archived()` hard-deletes leads, activities and conversations past 30 days, **and** `automation_runs` older than 90 days regardless of soft-delete state — *"the fastest-growing table in the schema… with nothing deleting it."*
- `Archived.tsx` is the recovery screen, built because the RPCs shipped with zero callers: *"'deletion is recoverable' was true of the database and invisible to the person who would need to recover something"* (`Archived.tsx:8`).

**The RLS incident is the most instructive story in this repo.** On 22 September
an archived record appeared in both the Students list and the Archived list at
once. `archive_lead` had run correctly and `deleted_at` was set. The first fix
re-asserted the three `*_read` policies — and changed nothing, because

> `20260922100000_soft_delete_restrictive.sql:1` — *"leads_read was correct the whole time. The rule was not overwritten — it was OUT-VOTED."*

PostgreSQL ORs permissive policies together. `leads_read` saying "deleted_at is
null AND you're a member" does nothing while `super_all_leads` sits beside it
saying "you're a super admin" with no such condition. Three offending policies
(`super_all_leads`, `conversations_org`, `super_read_conversations`) are defined
in **no migration in this repo** — they were created in the Supabase dashboard
before migration history began, which is exactly why reading the migrations made
everything look right. The real fix adds a **RESTRICTIVE** SELECT policy per
table, which is AND-ed after the permissive ones are OR-ed and therefore cannot
be out-voted by any policy that exists now or is added later, including one
created in the dashboard.

`SELECT` only, deliberately: `archive_lead`, `restore_lead` and `archived_leads`
are all `SECURITY DEFINER`, so the way back still works, and `service_role` has
`BYPASSRLS`, so edge functions are untouched. Verified in the app, not just the
catalogue — Students went 22 → 21, Archived unchanged with Restore intact.

Because the offending policies were super-admin-only, this only ever affected
super admins. Less severe than first reported.

**What is not soft-deletable.** `organizations` has **no DELETE policy at all**
after `20260908110000_delete_guards.sql` — a delete would cascade through 19
tables. `payments` and `subscriptions` foreign keys were changed from CASCADE to
**RESTRICT**, because Indian tax rules require retention: *"an organisation that
has ever paid cannot be deleted at all until someone deals with the money
deliberately."*

**Still true and acknowledged:** the ordinary hard `DELETE` on `leads` still
exists, restricted to org admins. The soft-delete RPCs are what the UI calls,
but the permanent path remains reachable.

**Status: Working**, after two corrective migrations.

**Verified by.** No test file. `check_soft_delete_rls()` is a live diagnostic
callable by `service_role`, and it reports policy *kind* (permissive vs
restrictive) rather than just predicate presence — because a permissive policy
carrying the right predicate proves nothing.

---

# 19. Self-monitoring

**What it does.** Two layers. `system-health` actively probes the AI provider,
reply quality, intake, automations and credential exposure once an hour.
`watch_jobs()` is a pure-SQL watchdog that notices when a scheduled job has
stopped, and it deliberately shares no machinery with what it watches.

## Why there are two layers

An eight-day outage, in three parts (`20260914120000_job_watchdog.sql:6-25`):

1. `app_settings.cron_secret` still held the literal placeholder the 3 September migration seeded it with. `call_edge_function` refuses to send when it sees that, so every scheduled HTTP call raised — **2,502 failed attempts, recorded every fifteen minutes in a table nothing reads.**
2. `system-health` is itself one of the jobs that calls out over HTTP with that secret, so it was broken by the same root cause. *"The alarm was wired to the thing it was alarming about."*
3. When the secret was finally set, the dashboard textarea paste carried an invisible trailing newline, and every call 401'd indistinguishably from a wrong secret. `call_edge_function` now `btrim()`s it.

Commercially the worst casualty was `nurture`: follow-up email is a headline
feature on every paid plan and it was silently off for eight days across every
customer.

## `system-health` — the five checks

| Check | What it does | Advisory? |
|---|---|---|
| `checkAi` | Live POST to Groq with that org's actual key and model | no |
| `checkRecentReplies` | Scans 24h of `chat_messages` for the fallback-apology prefix; `fail` at ≥50%, `warn` at any | no |
| `checkIntake` | Active `webhook_keys` row + lead recency | **yes** |
| `checkAutomations` | `automation_runs.ok` failures over 7 days | no |
| `checkSecurity` | Plaintext credentials in `agent_config` while active counsellor accounts exist | no |

**The advisory distinction is the fix for a permanently-on alarm.** Tenant
quietness used to roll into the platform-wide status, so `overall` sat at `warn`
forever, `stale_jobs()` returned `system-health` on every call, and the operator
alarm never turned off.

> `system-health/index.ts:44` — *"A permanently-on alarm is not an alarm."*

That is precisely how the eight-day outage went unnoticed. A day-one account now
gets "Nothing's wrong — just quiet" instead of amber, and the heartbeat detail
names the org and the check rather than the literal string `overall warn`.

Three further fixes in the same file:

- **A cross-tenant leak.** `requireCronOrMember` resolved `orgId` from the token but the handler used `?org=` from the query string. *"Any counsellor in any tenant could read any other tenant's health by changing one query parameter… omitting it entirely returned every organisation on the platform"*, and `POST {alert:true}` *"fired Telegram alerts into other tenants' chats and spent their Groq keys."* Non-super-admins are now pinned to their own org.
- **Heartbeat ownership.** The heartbeat write was unconditional, so any dashboard poll reset `job_heartbeats.last_run_at` and masked a dead cron behind an open browser tab. Now only the scheduler stamps it. First-person note: *"I hit this myself: checking a deploy by calling this endpoint from the browser wrote a heartbeat and masked the real cron state I was trying to read."*
- **Every read in the five checks is now error-checked.** `checkSecurity` was the worst: a refused read returned **"No keys stored in the database"** — the one check whose job is noticing stored credentials could only ever return an all-clear when it could not see them.

**`HealthCard.tsx`** surfaces this on the Dashboard and renders nothing when
healthy. Its own bug: the `fetch` carried **no auth headers at all**, so it 401'd
every time and rendered `null` — *"the card that exists precisely so a three-day
silent outage is never repeated was itself silent, in a way indistinguishable
from 'everything is healthy'."* It now sends the member's JWT and shows an
explicit *"Health checks unavailable — this is not a report that everything is
fine"* state.

## `watch_jobs()` — the pure-SQL watchdog

`20260914120000_job_watchdog.sql:235-420`. No edge function and no HTTP in the
detection path, because *"every previous alarm in this system depended on the
machinery it was meant to watch."* Three detectors:

1. **Heartbeat problems** — never reported, stale beyond 2× its threshold, or reporting an unhealthy status.
2. **A pg_cron job failing ≥2 times/hour** — `status = 'failed'` specifically, not `<> 'succeeded'`, to avoid false positives on in-flight runs.
3. **An edge function returning non-2xx ≥2 times/hour**, attributed by name via a new `edge_call_log` table, because `net._http_response` does not record which function a response belongs to.

Incidents land in `job_incidents` with `UNIQUE (job_name, kind) WHERE
resolved_at IS NULL`, which is what stops the 2,502-rows-in-eight-days shape
repeating. The watchdog excludes itself from its own detection to avoid a
feedback loop. Notification is Telegram and is *"a bonus on top, never the
mechanism."*

**Its first act on install day was to catch a real warn**, which is the outcome
you want from a monitor.

## The cron secret mechanism

- `call_edge_function(name, body)` — `SECURITY DEFINER`, validates the name against `^[a-z0-9][a-z0-9-]{0,62}$` (closing a prior blind SSRF where any string was concatenated into the URL), reads `app_settings.cron_secret`, **raises if unset or still the placeholder**, sends it as `x-cron-secret`, `btrim()`'d. Revoked from `public`, `anon`, `authenticated`.
- `app_settings` has RLS enabled with **zero policies** — *"A secret readable over PostgREST is not a secret."*
- `_shared/cron-auth.ts` — `requireCronSecret()` refuses **every** request when `CRON_SECRET` is unset, including plausible-looking ones, to avoid repeating the `app-signup` bug: `if (SECRET && header !== SECRET)` *"leaves the endpoint wide open whenever the secret is missing, which is the deployment default."*
- `requireCronOrMember()` accepts the secret **or** an active member's JWT, added because the secret broke two legitimate UI buttons. `orgId` and `role` are derived only from the token's `profiles` row, never from the body — otherwise the secret would have traded an anonymous cross-tenant hole for an authenticated one.

**Status: Working with caveats.** Two, both structural:

- **Four scheduled jobs are not watched by heartbeat.** `purge-archived`, `reconcile-webhooks`, `prune-webhook-deliveries` and `mark-lapsed-subscriptions` are plain SQL called directly by `cron.schedule`, have no `job_heartbeats` rows, and never route through `call_edge_function`. Detector (1) does not see them and detector (3) cannot. Their only cover is detector (2), pg_cron's own failure count — which catches a job that *errors*, not one that has been unscheduled or is silently doing nothing.
- **Nothing watches the watchman.** The watchdog survives an edge-function or HTTP outage because it is pure SQL on pg_cron. It cannot survive pg_cron itself dying, because it runs on pg_cron. The honest mitigation is an external ping, not a cleverer query.

**Verified by.** `_shared/cron-auth.test.cjs` — roughly 40 assertions covering
fail-closed on an unset secret, trim behaviour, constant-time compare (same-length
wrong secret, prefix, case), the cross-tenant invariant that org and role come
from the token and not the request, membership status checks, `adminOnly`
gating, and that a failed `profiles` read denies with 503 rather than silently
passing. This is the best-reasoned security test in the repo.
`system-health/index.ts` itself has **no automated test** — its correctness is
argued only in comments.

---

# 20. Super-admin console

**What it does.** A cross-tenant control plane at `/admin`: every org's plan,
usage, member count and record count, with plan grants and suspension.

**How it works.** `Admin.tsx` calls four RPCs, each of which re-checks
`is_super_admin()` **inside the function body**, not merely by grant:
`admin_list_orgs()`, `admin_set_plan()`, `admin_set_org_active()`,
`admin_recent_actions()`. Every mutation writes an `admin_audit` row with actor
email, action, org and a JSON detail.

**There is deliberately no delete path.**

> `20260908100000_super_admin.sql:31` — *"a DELETE cascades through every record, activity and transcript that tenant owns, with nothing to restore from."*

The migration's own verify block asserts no delete policy exists on
`organizations`.

**Status: Partially built.** Three concrete gaps:

- **`admin_set_member(profile_id, role, status, note)` is built, granted and audited — and has zero callers in `app/src`.** It exists for the "the only admin left the company" scenario and there is no way to invoke it from the console.
- **No way to open a tenant's records.** The org table's only per-row actions are Plan and Suspend/Restore. There is no drill-down, no record browser, no view-as. Nothing in RLS would prevent it — super admin already has read access to every org-scoped table — it is simply not built. `RUN-THIS-NEXT.md:652` records hitting this while supporting MNB Research.
- **Per-org record counts include deleted rows**, so they will not match what the customer sees on their own usage screen. Deliberate for now.

Three error-handling fixes in the console itself are worth noting because they
affect whether its numbers can be trusted: a failed `plan_limits` read used to
silently zero the MRR figure and render an empty Plans table under copy claiming
these are the enforced rows; a failed audit-log read rendered "Nothing yet."
under copy promising "every cross-tenant change". Both now show explicit error
states. MRR is labelled as *listed price of effective plan*, not real revenue.

**Verified by.** No automated test. Manual `PASS`/`FAIL` verify block at the end
of the migration.

---

# 21. Reports & CSV export

**What it does.** Charts, a funnel, a source breakdown and a counsellor
leaderboard — plus a CSV export of every record.

**How it works.** All four metrics are `useMemo` computations over the leads
already loaded into browser memory (`Reports.tsx:47-101`). None are DB views or
RPCs. **The charts and leaderboard therefore cover only the loaded page**, and
the screen says so explicitly rather than hiding it: *"The charts and
leaderboard below cover only these — the CSV export covers every record"*
(`Reports.tsx:303`).

**The CSV export is the one thing on the screen that covers everything.**
`exportCsv()` (`:127-278`) calls `fetchAllLeads()` which pages server-side with
progress reporting, fetches notes in chunks of 100 ids (because ids go in the
URL and a 10,000-record export would otherwise produce a request no server will
accept), and discovers custom-field columns dynamically from the exported rows
so each industry pack gets its own columns. UTF-8 BOM for Excel and Devanagari,
CRLF rows, proper quote escaping including bare `\r`.

Soft-deleted rows are excluded structurally — `fetchAllLeads` runs under the
RESTRICTIVE RLS policy and cannot see them.

**Failure is deliberately loud.** Every failure path says explicitly whether a
file was written, after a bug where a `try/finally` with no `catch` cleared the
busy state and said nothing: *"The person then re-runs it, or worse, assumes the
download is in their Downloads folder and leaves"* (`:263`).

**Status: Working with caveats** — the export is complete, the charts are
partial-but-labelled.

**Verified by.** No automated test. `AUDIT-2026-09-17.md:174` assessed both
import and export as sound.

---

# 22. Calendar, Activity, Dashboard

**Calendar** (`Calendar.tsx`) — a month grid of follow-ups. Two fixed bugs
worth recording. Local date keys were built with `toISOString()` (UTC) while
grid cells came from local midnights; in IST those disagree for the first 5h30m
of every date, so *"every follow-up appeared one day late, 'today' highlighted
tomorrow's box"* — on the one screen whose job is "who am I calling today". And
`next_follow_up_at` is written by the CSV importer, the lead webhook and
automations, none of which validate it; a malformed date threw `RangeError`
inside a `useMemo` with no error boundary, *"which used to take the whole app
down."* The header count is server-computed; the grid plots loaded records only
and says so.

**Activity** (`Activity.tsx`) — org-wide feed, last 300 rows, no pagination. A
failed read used to render "Nothing logged yet", indistinguishable from an empty
org; now surfaces an error.

**Dashboard** (`Dashboard.tsx`) — entirely reshaped by the industry pack.
`exactKpi()` computes an exact org-wide figure for the three KPI kinds
expressible as sums over server-side stage counts (`total`, `stage_count`,
`conversion`); the other five (`new_today`, `due_today`, `overdue`, `avg_score`,
`sum_field`) depend on per-row values no count query can reach and are labelled
partial with a `+` suffix and "of the N loaded". This fixes a bug where *"a
5,000-record customer read their dashboard as a description of 1,000 records
with nothing saying so."*

**Status: Working with caveats** (partial counts, clearly labelled).
**Verified by.** No automated test for any of the three.

---

# The fourteen edge functions

Deploy flags are the authoritative list in `scripts/deploy-all.sh`, which
**refuses to run** if any directory under `supabase/functions/` is missing from
it. That check exists because the same gap bit twice: on 6 September `api` and
`save-integration` were absent and simply never shipped while everything looked
done; on 17 September `system-health` and `billing-webhook` sat undeployed for
five days for the same reason.

| Function | Purpose | Deploy flag | What actually guards it | Called by |
|---|---|---|---|---|
| `chat-agent` | The AI chatbot; answers visitors, captures leads | `--no-verify-jwt` | `hit_rate_limit` 20/min per org+IP, org slug required with no default, 2000-char message cap | `widget.js` on customer sites |
| `lead-webhook` | Public lead intake (forms, WhatsApp, Zapier, Meta) | `--no-verify-jwt` | `webhook_keys.key` query param (plaintext), `hit_rate_limit` 60/min, 32 KB body cap | Third-party senders |
| `api` | Customer REST API | `--no-verify-jwt` | `resolve_api_key()` SHA-256 lookup + per-route scope check + `plan_allows_api()`. **No rate limit** | Customer systems |
| `app-signup` | Marketing-site signup → lead in the `abrobot` org | `--no-verify-jwt` | `x-app-secret` header, constant-time, fails closed | `app.abrobot.ai` |
| `billing-webhook` | Cashfree payment / refund / dispute events | `--no-verify-jwt` | HMAC-SHA256 over `timestamp + rawBody`, constant-time, fails closed on unset secret | Cashfree |
| `run-automations` | Automation sweep + event dispatch | `--no-verify-jwt` | `requireCronOrMember()` — `x-cron-secret` or an active member's JWT | pg_cron every 15 min; `trg_notify_lead_change`; Automations "Test run" |
| `nurture` | Daily follow-up email + the unsubscribe endpoint | `--no-verify-jwt` | `requireCronSecret()`; the `?unsub=` path is token-authenticated | pg_cron daily 09:30 UTC; unsubscribe links |
| `summarize-chats` | AI summary of a conversation transcript | `--no-verify-jwt` | `requireCronOrMember()` | Conversations screen "✨ AI summary" button. **Not scheduled** |
| `system-health` | The five live health checks | `--no-verify-jwt` | `requireCronOrMember()`; non-super-admins pinned to their own org | pg_cron hourly; `HealthCard.tsx` |
| `whatsapp-send` | Send a WhatsApp message to a lead | JWT **on** | Supabase JWT + `profiles` lookup + `whatsapp_allowance()` | `LeadDetail.tsx` |
| `send-campaign` | One-off email to a filtered audience | JWT **on** | Supabase JWT + `org_admin`/`super_admin` only + `email_allowance()` | `Templates.tsx`, `LeadDetail.tsx` |
| `save-integration` | Write-only credential storage and test sends | JWT **on** | Supabase JWT + admin role | `Integrations.tsx` |
| `billing-checkout` | Create a Cashfree order | JWT **on** | Supabase JWT + admin role; price read server-side | `Settings.tsx` |
| `rescore-leads` | Batch recompute `leads.score` | JWT **on** | Supabase JWT + active member, own org only | **Nothing.** No caller anywhere in `app/src` |

The `--no-verify-jwt` flags are load-bearing in both directions. Deploying
`chat-agent`, `lead-webhook` or `app-signup` *without* the flag turns on JWT
verification and silently kills lead intake. Deploying `whatsapp-send` *with*
it removes the check that stops one org sending WhatsApp billed to another.

---

# Every scheduled job

| Job | Cron | What it does | How you know it ran |
|---|---|---|---|
| `abrobot-run-automations` | `*/15 * * * *` | `call_edge_function('run-automations')` — the sweep | `job_heartbeats` (watched), `automation_sweep_state`, `automation_runs` |
| `abrobot-system-health` | `0 * * * *` | `call_edge_function('system-health', {alert:true})` | `job_heartbeats` (watched), `alarm_status` in the response |
| `abrobot-nurture` | `30 9 * * *` | `call_edge_function('nurture')` — daily follow-up | `job_heartbeats` (watched), `activities` rows per send |
| `job-watchdog` | `*/15 * * * *` | `watch_jobs()` — pure SQL, opens/resolves incidents | `job_heartbeats` (self, excluded from its own detection), `job_incidents` |
| `purge-archived` | `15 3 * * *` | `purge_archived()` — 30-day leads, 90-day `automation_runs` | **`cron.job_run_details` only.** No heartbeat |
| `reconcile-webhooks` | `*/5 * * * *` | `reconcile_webhook_deliveries()` | **`cron.job_run_details` only**; indirectly `webhook_deliveries.reconciled_at` |
| `prune-webhook-deliveries` | `45 3 * * *` | `prune_webhook_deliveries()` — 7-day retention | **`cron.job_run_details` only.** No heartbeat |
| `mark-lapsed-subscriptions` | `30 2 * * *` | `mark_lapsed_subscriptions()` — reporting only; `effective_plan()` is what actually enforces expiry | **`cron.job_run_details` only.** No heartbeat |
| *(GitHub Actions)* `backup` | `30 19 * * *` | `pg_dump` of `public` + `auth`, gzipped, AES-256 encrypted, uploaded as a 90-day artifact | Actions run history; optional Telegram ping; the job round-trips the dump and fails if it is under 10 KB, missing a core table, or lacks the completion marker |

Only the first four have heartbeats. `summarize-chats` is seeded in
`job_heartbeats` with `watch = false` precisely because it has no cron entry —
*"'has never reported' is its correct permanent state, not an incident."*

The nightly backup exists because the Supabase free tier has no point-in-time
recovery: without it, an accidental mass delete or a bad migration is permanent
for five tenants' live data. Its header is blunt about the limit of the
substitute — *"Rehearse that on a scratch project BEFORE you need it. An
untested backup is a hope, not a backup."*

---

# External dependencies

| Service | Used for | What breaks if it goes down | Is the failure visible? |
|---|---|---|---|
| **Supabase** (Postgres, Auth, Edge, pg_cron, pg_net) | Everything | Total outage. No CRM, no intake, no auth, no jobs — and no monitoring either, since `job_incidents`, `job_heartbeats` and the watchdog all live inside it | **No.** Every alarm in the system is raised from inside Supabase. This is the single point of failure with no external observer |
| **Groq** | The AI chat agent, chat summaries | Visitors get a generic apology; lead capture drops to whatever the fallback asks for. CRM otherwise unaffected | **Yes, with a 3-day precedent.** `checkAi` does a live probe hourly and `checkRecentReplies` flags a spike in fallback apologies — both built after the agent apologised to every visitor for three days with nothing saying so |
| **Resend** | Nurture sequences, one-off campaigns, signup welcome | All outbound email stops | **Yes, now.** `nurture` sets its heartbeat to `warn` and returns 500 on failures. Before the B6 fix a run where 2,400 of 2,500 sends failed reported `ok` |
| **Meta WhatsApp Cloud API** | Manual sends, inbound autoreply | WhatsApp send and autoreply stop | **Partially.** Errors are passed through to the caller, including Meta's real codes (e.g. `131047` for the 24h window). There is no health check and no heartbeat. Currently moot — no tenant has it configured |
| **Telegram** | Per-org new-lead alerts, operator incident alerts | Alerts silently stop | **No, and this is the sharp one.** Alerts are best-effort by design and never throw into the request path. Per-org failures return a `reason` in the webhook response body but nothing monitors that. Operator alerts fail silently — which is tolerable only because `job_incidents` is the durable record and Telegram is explicitly *"a bonus on top, never the mechanism"* |
| **Cashfree** | Checkout, payment/refund webhooks | No new purchases; existing plans unaffected, since entitlement is read from `subscriptions` not from Cashfree | **Partially.** A failed checkout is visible to the customer immediately. A *missed webhook* is not — the payment row stays `created` and the plan is never granted, with nothing sweeping for it. There is no reconciliation job for stuck payments |
| **Cloudflare Pages** | Serving the frontend, `widget.js` and the policy pages | App and every customer's chat widget stop loading | **No.** Nothing monitors the CDN |
| **GitHub Actions** | CI, nightly encrypted backup | No CI gate; no off-platform backup | **Partially.** The backup job pings Telegram on both success and failure *if* `OPS_TELEGRAM_*` secrets are set — *"a backup job that has been failing for three weeks looks exactly like one that has been working"* |

---

# Test coverage map

Eleven test files, all under `supabase/functions/_shared/`. CI
(`.github/workflows/ci.yml`) runs them repo-wide, plus `tsc --noEmit`, a
`vite build`, `deno check` on all fourteen functions, and a `pglast` parse check
on every migration and script.

| File | Covers | Notable |
|---|---|---|
| `run-actions.test.cjs` | Every automation action | Fake postgrest client that resolves with `{error}` and never throws — proves every write checks its error |
| `cron-auth.test.cjs` | `requireCronSecret` / `requireCronOrMember` | ~40 assertions; fail-closed, constant-time compare, org from token not request |
| `widget-linkify.test.cjs` | Widget XSS | 124 DOM-parsed assertions across **both** widget copies |
| `template.test.cjs` | Merge tokens + escape ordering | Carries one deliberately-failing documented case |
| `automations.test.cjs` | Trigger/condition/cooldown evaluation | Re-proves the "blank comparison value must be inert" fix |
| `stage.test.cjs` | `firstStageKey()` | Cross-tenant scoping, fallback path, never rejects |
| `score.test.ts` | Scoring maths | Breakdown-sums-to-score invariant |
| `sequences.test.ts` | Nurture segment grouping | A segment with its own sequence must not also inherit the default |
| `cashfree.test.cjs` | `verifyWebhook()` only | 5 assertions |
| `whatsapp-creds.test.cjs` | Credential pairing only | 10 assertions |
| `http.test.cjs` | `fetchWithTimeout` | |

**What is untested.** Every edge function *handler*. The entire frontend. All
SQL — triggers, RLS policies, `grant_plan_from_payment`,
`revoke_plan_from_payment`, `accept_invite`, `guard_profile_changes`,
`fire_webhooks`, `is_safe_webhook_url`, `watch_jobs`. SQL correctness is
asserted by verify blocks at the bottom of each migration, run by hand in the
Supabase SQL editor at apply time and never again.

CI itself has a history worth knowing: every `.test.cjs` printed `SKIP` and
exited 0 for an unknown period — *"a green tick over zero assertions, which is
worse than having no tests at all: it looks like coverage."* esbuild and jsdom
are now installed on the runner and **a skip is a hard failure**.

---

# Known gaps — what is genuinely not built

Distinct from things that are built and broken. These simply do not exist.

**Product**

- **No auto-renewal.** Subscriptions expire and the customer pays again by hand. No eNACH, no UPI AutoPay.
- **No proration preview or plan-change guard at checkout.** The SQL that makes a plan change value-conserving exists; the confirmation flag and prorated-end-date display that the migration asks for do not.
- **No reconciliation for stuck payments.** A Cashfree webhook that never arrives leaves a `payments` row at `created` forever, and nothing sweeps for it.
- **Invites send no email.** The screen says so, but getting the link to the invitee is manual.
- **`send_email_template` is not an automation action.** Deliberate — unattended sending needs nurture's unsubscribe and rate handling.
- **`assign_to` has no UI control**, though it is implemented and tested.
- **`admin_set_member` has no UI control**, though it is implemented and audited.
- **`rescore-leads` has no caller at all.** Scores are never refreshed after intake.
- **The super-admin console cannot open a tenant's records.** Supporting a customer requires signing in as them.
- **No merge tool for duplicates.** Dedupe no longer matches archived records, so re-contacting someone whose record was archived creates a new one; if both are later restored there is no way to combine them.
- **No campaign attribution.** No `utm_*` columns anywhere, despite capture happening on customer marketing pages.
- **No WhatsApp template sending.** `max_whatsapp_marketing` exists as a plan cap with nothing able to consume it.
- **No `send_whatsapp` automation action.** WhatsApp is human-triggered or autoreply only.
- **Pack switching does not remap existing records' stages.** A commented-out script exists; running it is a manual, per-org decision.
- **Drag-and-drop is desktop-only.** Touch uses the Move button.

**Platform and safety**

- **No rate limiting on the public REST API.** `hit_rate_limit()` exists and is called from two places, neither of which is `api/index.ts`.
- **No domain allowlist for the chat widget.** `Access-Control-Allow-Origin: *` and an org slug that is public by construction.
- **No cursor pagination on the API.** Offset only, documented as able to skip or repeat rows under concurrent writes.
- **No DNS-rebinding defence on outbound webhooks.** The SSRF guard validates the literal address correctly; the real fix is resolving and pinning the IP in an edge function, outside Postgres.
- **Four scheduled jobs have no heartbeat.** `purge-archived`, `reconcile-webhooks`, `prune-webhook-deliveries`, `mark-lapsed-subscriptions` are visible only through `cron.job_run_details`, which catches a job that errors, not one that has stopped.
- **Nothing watches the watchman.** The watchdog survives an HTTP or edge-function outage. It cannot survive pg_cron, because it runs on pg_cron. The honest mitigation is an external ping.
- **No CDN monitoring.** If Cloudflare stops serving, every customer's widget and the app go dark with no alarm.
- **`20260816120000_agent_config_secret_hardening.sql` Step 3 is not applied.** Plaintext credentials on `agent_config` are readable by any active org member with the service-role bypass out of the picture; this is dormant only because no org has a non-admin member yet. `system-health`'s `checkSecurity` exists to detect the moment that changes.
- **Three RLS policies exist in no migration.** `super_all_leads`, `conversations_org` and `super_read_conversations` were created in the Supabase dashboard before migration history began. RESTRICTIVE policies neutralise them for soft delete; nothing prevents the same thing happening again on another table or verb.
- **The frontend cutover is incomplete.** `_redirects` still routes eight paths to the legacy bundle, which still owns the marketing, pricing and trial flows.
- **`abrobot-crm-site-v15/widget.js` is a second, older widget copy at a publicly reachable path.** It carries the XSS fix and is covered by the test suite, but it is a stale build served from the CDN.

**Open with a date**

- **Meta payment method by 30 September.** Hard deadline, still open.
- **A leftover test account holds counsellor access to live student records.** `audit_sec_1789801652_202348@gmail.com`, joined 20 September. Deliberately not removed — revoking access is the owner's call.
- **~80 audit findings remain**, led by the unchecked-`{error}` sweep, then empty-vs-error states on six screens, then accessibility (~59 of 75 inputs have no programmatic label; `.pill-green` is 2.24:1 against WCAG AA).

---

## The failure shape this codebase keeps producing

Worth stating once, because it explains why so many entries above are about
monitoring rather than features. Nearly every incident recorded here is the same
bug wearing different clothes: **something that looks like success and isn't.**

- `postgrest-js` resolves with `{data: null, error}` — it does not throw. A refused write is indistinguishable from a successful one unless you check.
- PostgREST truncates at 1,000 rows. When the truncated value feeds a boolean, truncation does not shorten the answer, it **inverts** it.
- A signal written somewhere nothing reads is the same as no signal. 2,502 cron failures sat in `cron.job_run_details` for eight days.
- An empty state used as an error state tells the user a confident lie: "Nothing logged yet", "No keys stored in the database", "Nothing would fire right now".

The defences now in place — fail-closed RPC checks, bounded queries with resume
cursors, durable incident rows before any notification, and explicit
"unavailable" states distinct from "empty" — are all reactions to specific
instances of that one shape.
