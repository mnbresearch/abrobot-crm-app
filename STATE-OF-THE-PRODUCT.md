# State of the product — 11 September 2026

A full audit: four independent passes over the code, plus my own verification of
every finding below. Nothing here is inferred — every claim names the file and
line, and I read each one myself rather than trusting the pass that found it.

**The headline: do not sell this yet.** Not because it is badly built — the data
layer, tenancy, billing integrity and plan enforcement are genuinely solid — but
because the thing you are actually selling, *"your own AI agent on your own
site"*, does not work for anyone who is not AbroBot. That is fixable in about a
day. Several other things are not one-day fixes, and some are promises already
published that need to come down before a customer reads them.

---

## Your three questions, answered directly

### "Is the chat agent different for everyone?"

**No. Every new customer gets AbroBot's study-abroad agent.**

This is not a fallback for an error case. It is what happens on the **success**
path, for every organisation that signs up.

`create_organisation` seeds only four fields on `agent_config`
(`20260908090000_pricing_reset.sql:401`):

```sql
insert into public.agent_config (org_id, enabled, agent_name, welcome_message, knowledge, onboarded)
values (new_org.id, true, trim(p_name) || ' Assistant', 'Hi! How can we help you today?', '', false)
```

`apply_industry_pack` then sets exactly two more — `persona` and `industry`
(`20260817090000_multi_industry_foundation.sql:541`). Everything else stays
NULL. And `publicConfig` in `chat-agent/index.ts:107` fills every NULL with
AbroBot's:

| Field | What a dental clinic's website shows | Line |
|---|---|---|
| `header_subtitle` | **"Study-abroad assistant · online"** | 113 |
| `greeting` | "…Ask me anything about **universities, scholarships, visas or SOPs**" | 114 |
| `quick_replies` | 🎓 Universities · 💰 Scholarships · 🛂 Visa help | 117 |
| `booking_url` | **AbroBot's Calendly** — `calendly.com/mridulnanda2004/abrobot-meet` | 124 |
| `contact_url` | **`https://www.abrobot.ai/contactus`** | 125 |
| `widget_color` | `#f97316`, AbroBot orange | 126 |
| logo | AbroBot's logo — the server returns `logo_url: null`, and `widget.js:307` skips nulls, so the hardcoded AbroBot logo at `widget.js:63` survives | — |

And the AI itself, `buildSystemPrompt` (`chat-agent/index.ts:136`):

```ts
parts.push(cfg?.knowledge || `You are a helpful, knowledgeable study-abroad counsellor for ${brand}.`);
```

`knowledge` is seeded as `''`, which is falsy — so **every new tenant's model is
told it is a study-abroad counsellor.** Then, unconditionally and regardless of
industry (line 153), it is instructed to ask for the visitor's *"target country,
study level"*, assess *"visa/admission competitiveness"*, suggest
*"university/course directions"*, and **offer AbroBot's Calendly link**.

The industry persona is appended *after* that, producing a genuinely
self-contradictory prompt: *"You are a study-abroad counsellor for Smile Dental.
Persona: you are a friendly clinic assistant. Never give clinical advice."*

The plumbing to fix this already exists and was never wired up.
`industries.agent_knowledge` and `industries.quick_replies` are declared
(`20260817090000:55`) — but the seed `INSERT` at line 228 lists only
`(slug, name, icon, tagline, lead_noun, lead_noun_plural, position,
default_stages, default_fields, agent_persona)`. Both columns are NULL for
every one of the 13 industry packs.

### "Can everyone actually copy it?"

**The snippet is wrong for most people who copy it.** `Settings.tsx:933`:

```ts
const base = window.location.origin;
const snippet = `<script src="${base}/widget.js" data-org="${org?.slug ?? "your-org"}" defer></script>`;
```

Whatever host the admin happens to be on becomes the snippet's domain. Three
different domains are in play across the repo — `abrobot-crm-app.pages.dev`
(what `widget.js` and every marketing page use), `crm.mnbresearch.com` (the real
product domain, per your own Terms), and `window.location.origin` (what
customers are handed). An admin on a Cloudflare branch-preview URL copies a
snippet that 404s when Cloudflare reaps that preview. If the store hasn't
loaded, they copy `data-org="your-org"` literally, and the Copy button isn't
disabled.

Also: quick replies **cannot be configured at all.** `Settings.tsx:739` is a
single-line `<input>` labelled *"Quick replies (comma separated)"*. The backend,
`parseChips` (`chat-agent/index.ts:99`), splits on **newlines** with `|` between
label and prompt. A single-line input physically cannot contain a newline, so
everything a customer types becomes one chip. The in-app preview splits on
commas and shows three chips; their live site shows one.

And there is no input at all for `header_title`, `teaser`, `brand_name`,
`whatsapp`, `cta_text`, `widget_position`, `tone`, or `away_message`.

### "Will it actually work?"

**Not on a free account, which is what every trial customer will have.**

The `free` plan is `max_leads = 0, max_ai_messages = 0`
(`20260908090000_pricing_reset.sql:61`). So a new customer pastes the widget,
and:

- the AI answers **zero** messages — every visitor gets *"Our assistant is taking a short break"*
- captured enquiries are **rejected** by `guard_lead_limit`
- the rejection message reads ***"Your subscription has ended, so new records are paused"*** — to someone who signed up an hour ago (`20260821080000_enforce_plan_limits.sql:213`)

Meanwhile `SetupChecklist.tsx:107` is actively telling them to *"Put the chat
widget on your website — this is what turns visitors into records
automatically."* It cannot.

---

## STOP-SHIP — fix before any customer sees this

| # | What | Where | Effort |
|---|---|---|---|
| 1 | **Every tenant's agent is AbroBot's.** Seed `greeting`, `header_subtitle`, `quick_replies`, `widget_color`, `knowledge` per industry; make every default in `publicConfig` and `buildSystemPrompt` brand-neutral; drop `BOOKING_URL` as a cross-tenant fallback — no booking link is far better than a competitor's. | `chat-agent/index.ts:107-160`, `20260817090000:228`, `apply_industry_pack` | ~1 day |
| 2 | **Widget boots into AbroBot branding on any slow response.** A 2500 ms timer calls `bootOnce()` with the hardcoded config; `boot()` bakes colour, header, subtitle, logo and contact link into the DOM at that instant, and the later real config is a no-op because `booted` is already true. A Supabase cold start routinely exceeds 2.5 s. Render nothing, or an unbranded shell, until config arrives. | `widget.js:48-64, 293-310` | ~2 hrs |
| 3 | **Free plan makes the product look broken.** Give `free` a small real allowance (say 50 records / 50 AI replies) so the widget demonstrably works, or stop telling people to install it until they pay. Fix the "subscription has ended" copy for accounts that never had one. | `pricing_reset.sql:61`, `enforce_plan_limits.sql:213` | ~2 hrs |
| 4 | **CSV import commits partially and drops the rest.** Chunks of 200 continue after a failure — 1,500 rows into a Starter org silently commits 1,000 and loses 500, with no record of which. Wrap in one transaction or pre-flight the count. | `Import.tsx:164-175` | ~3 hrs |
| 5 | **No mobile navigation.** One breakpoint in the entire app (`@media (max-width: 820px)`), and it does `.sidebar { display: none }` with nothing to replace it. No hamburger, no drawer — I grepped. On a phone there is **no way to navigate**. Your buyers are phone-first. | `app.css:391` | ~4 hrs |
| 6 | **Dead model in the production fallback chain.** `FALLBACK_MODELS = ["qwen/qwen3.6-27b", "llama-3.1-8b-instant"]` — `llama-3.1-8b-instant` was shut down by Groq on 16 Aug 2026, and `qwen3.6-27b` is a **Preview** model Groq explicitly says not to use in production, at 4×/5× the primary's price. The comment directly above documents the *identical* outage from 19 Aug. Replace with `openai/gpt-oss-20b`. | `chat-agent/index.ts:40` | ~15 min |
| 7 | **Rate limit runs after the expensive work.** `hit_rate_limit` is at line 330; the conversation insert, history read, user-message insert, lead insert and Telegram alert all happen at 239–314. A blocked request still writes rows and burns an edge invocation. One IP at the current limit = 864,000 requests/month, which consumes your entire 500k free edge quota and fills the 500 MB database — breaking the platform for every tenant. Move the check above line 239. | `chat-agent/index.ts:330` | ~30 min |
| 8 | **`useTheme` calls `localStorage` unguarded.** `main.tsx:18` wraps `initTheme()` in try/catch and explains exactly why (Safari Lockdown Mode, blocked storage). `theme.ts:26` was never given the same guard, so in those environments the whole app dies at first render with "Something went wrong" and Reload doesn't help. | `theme.ts:26,32,36` | ~10 min |

---

## What we are promising that is not true

This is the part with legal exposure, and some of it is my fault — see the last
section.

### Selling things that cannot be bought

**Four add-ons are priced on two pages and have no code path whatsoever.** No
table, no column, no UI, no checkout branch. I grepped for `addon` and `add_on`
across all SQL, TS and TSX: **zero hits.**

- Extra team member ₹199/mo
- Extra 10,000 records ₹999/mo
- WhatsApp Business API number ₹1,499/mo
- Custom AI knowledge & training from ₹4,999 one-time

The refund policy even writes refund terms for them
(`refund-and-cancellation-policy.html:42`). Either build them or delete the
prices.

### Two documents on your site describe opposite billing models

- `pricing.html:75` — *"Subscriptions renew automatically each month until cancelled and can be cancelled anytime."*
- `terms-and-conditions.html:36` — *"do not renew automatically — no recurring mandate is created."*

The Terms are correct; the code creates one-time Cashfree orders with no
mandate. Worse, `terms-and-conditions.html:39` **contradicts itself in the same
document**, containing an authorisation to charge *"the applicable recurring
amount"*. A customer who reads "auto-renews", doesn't diarise it, and silently
goes read-only is a chargeback with your own pricing page as their evidence.

### "Cancel from Settings" — there is no such button

`product.html:400` says it. `Settings.tsx` has six tabs and no cancel,
downgrade, or plan-management control of any kind. This was already flagged in
your own `INTEGRATION-STATUS.md:225` and not fixed.

### "1 Login for all your brands"

`product.html:295`. `create_organisation` raises *"This account already belongs
to an organisation"* (`pricing_reset.sql:367`). One account, one org, hard
enforced. The **same page** says twice that multi-brand is not available.

### Data portability — the promise you make most loudly

`product.html:380`: *"Every record, every custom field and every note exports to
CSV from the Reports screen, any time, at no charge… we say this loudly because
the honest test of a CRM is how easy it is to leave."*

`store.tsx:135` is `LEAD_PAGE_LIMIT = 2000`, and the CSV export
(`Reports.tsx:188`) covers only that slice. Business sells 50,000 records. **A
Business customer cannot export record 2,001.** There is no pagination anywhere
in the app — no offset, no cursor, no "load more".

It is probably worse than 2,000. There is no `supabase/config.toml`, so
PostgREST's hosted default `max-rows` applies, and your own code comment
(`Import.tsx:109`) states that default is **1,000**. If so, `.limit(2000)`
returns 1,000, the check `leads.length >= 2000` is never true, and **the amber
"showing only your most recent" banner never appears on any screen** while every
number in the app is computed from 1,000 of however many records exist. Check
`max-rows` on the hosted project — that single setting decides whether the
ceiling is disclosed or silent.

Knock-on: Pipeline and Calendar show no banner at all and print wrong counts;
`Leads.tsx:130` prints "2,000 total" right beside the banner saying there are
more; the Leads search filters client-side over the slice, so older records
return *"Nothing matches that filter"*.

### Three competitors' prices with no source

`product.html:341-343` — Zoho ₹11,200, Freshsales ₹28,792, Kylas ₹12,999, plus
"Not bundled" assertions about each. No citation, no "as of" date anywhere in
the repo. Comparative advertising against named companies with no
substantiation is exposure under the Consumer Protection Act 2019 and an
invitation to a disparagement complaint. Add a source and a date, or remove the
table. (By contrast `PRICING.md` sources every one of its own cost inputs — the
discipline exists, it just wasn't applied here.)

### "Automated backups"

`product.html:425` says *"hosted on Supabase (Postgres) with automated
backups."* Supabase Pro is not purchased, so there are no Supabase backups.
`PRE-LAUNCH-AUDIT.md:94` states it plainly: *"There are no backups."* What
exists is a nightly `pg_dump` to a GitHub Actions artifact with 90-day
retention, which only runs if two repo secrets are set, and whose restore has
never been rehearsed — `FREE-TIER-HARDENING.md` says so itself: *"An untested
backup is a hope, not a backup."* This is a data-durability representation to
businesses storing other people's personal data. Fix the mechanism or the
sentence.

### Sold per tier, not implemented

"Priority support" (Growth), "email support" (Starter), "guided onboarding"
(Business), "dedicated account manager", "SLAs" (Enterprise) — no ticketing, no
queue, no entitlement field, no SLA document. Meanwhile `terms:45` disclaims
uptime entirely, which contradicts the Enterprise SLA you're selling.

"Custom AI tuning" is sold as a **Business** differentiator and is ungated —
every plan including free has the full AI Agent tab. Analytics and the
leaderboard are sold as **Growth** additions and are likewise ungated.

Two features in the landing page's feature list do not exist: **revenue
forecast** and **source ROI** (`product.html:285`) — `grep -i forecast app/src`
returns nothing, and there is no spend input from which ROI could be computed.

"Automated drips and one-click broadcasts **from your own domain**"
(`product.html:286`) is architecturally impossible — `send-campaign/index.ts:131`
explains why: a tenant's domain is not SPF/DKIM-authorised for your sender.

### Statutory gaps

- **No invoice is ever generated.** `pricing.html:75` promises *"GST is shown on your invoice."* The `payments` table has no invoice number, no tax breakdown, no GSTIN. On success, `billing-webhook` fires **one Telegram alert to you** and sends the customer nothing. There is no billing-history screen — nothing in `app/src` reads `payments` at all. Indian B2B buyers need a GST invoice to claim input credit; without one, many simply will not buy.
- **Terms §5 says you are a processor** with no DPA, no sub-processor list, no data-location statement, no breach-notification commitment, no retention schedule. Your actual sub-processors — Supabase, **Groq** (a US LLM host receiving your customers' lead conversations), Resend, Meta, Telegram, Cashfree — are disclosed nowhere. That is a DPDP Act 2023 gap.
- **Two different phone numbers.** `…88481` on product.html and in the AI agent; `…88480` on contact-us, terms and refunds. One of those is your statutory grievance contact.
- **Three different support-response promises**: "same working day" (product.html), "1–2 business days" (contact-us), "within one working day" (the AI agent's knowledge base).

### The AI agent on your own pricing page

`widget.js data-org="mnb-research"` now sits on product, pricing, terms and
refunds. Its knowledge base (`create-mnb-research-org.sql`) has the CRM tiers
right, but **omits every usage cap and the no-trial policy**, while being
instructed *"Give real numbers. Never say 'it depends'"*. It also asserts
"Featured on Shark Tank India", "1,000+ businesses served", "5.0 Google rating"
as fact, and carries a **"RESULTS GUARANTEE… the most recent monthly fee is
refunded"** — which your CRM's own refund policy contradicts
(`refund:37`, *"generally non-refundable for the current cycle"*). An AI making
refund promises your policy denies, on the page where you take payment.

---

## The money

I had the margin model re-derived from scratch and the input prices
re-researched against live sources today, because the ones in `PRICING.md` were
gathered on 8 September and some were already wrong.

**The model is internally consistent — it reproduces to 83.6% / 62.4% / 64.2%
against its stated 84% / 61% / 63%. The inputs are what's wrong.**

| Plan | Claimed | Corrected (assumed mix) | At 100% entitlement, marketing-heavy |
|---|---|---|---|
| Starter ₹999 | 84% | **64%** | 57% |
| Growth ₹2,499 | 61% | **43%** | **−18%** |
| Business ₹4,999 | 63% | **47%** | **−14%** |

Four corrections drive this:

1. **GST on revenue was never subtracted.** The model adds 18% GST to every cost but treats ₹999 as 100% revenue. Inter-state SaaS requires registration from the first transaction, so ₹152 of every ₹999 is not yours. This is the single largest omission.
2. **Token volume is understated ~3×.** The model assumes 1,200 in / 350 out. Your own code comment (`chat-agent/index.ts:428`) records the system prompt as **~14,600 characters** — about 3,650 tokens before any conversation history, and up to 20 prior messages are attached. Realistic is ~4,500 in / 500 out.
3. **The fallback models were never costed.** `qwen/qwen3.6-27b` is $0.60/$3.00 — **16× the primary's per-reply cost**. A month spent on that fallback takes Growth to −130%.
4. **FX.** The model implies ~₹88/USD; it is ₹95.57 today.

The migration header claims *"the worst case is never negative, which is the
property that matters."* Corrected, that is no longer true for Growth or
Business. The fix is already written down as "Things to revisit" item 2 in
`PRICING.md` — **meter marketing WhatsApp separately from utility.** It isn't an
optimisation; it is what restores the design property.

**Break-even: 7–9 paying customers** covers infrastructure. **16+** covers
infrastructure plus one hour of human attention per customer per month. Below 7,
every Starter loses money, because allocated fixed cost at n=5 (₹880) exceeds
Starter's contribution (₹719).

**₹999 is viable — but only as a genuinely zero-touch plan.** The gateway fee
is a non-issue (₹23). GST and labour are the whole story: after GST, gateway and
infra you keep ₹719, and two support hours a month erases it.

Two costs nobody is counting:

- **`summarize-chats` calls Groq on a cron with no `consume_usage` call.** Unmetered AI spend, billed to you, attributed to no customer.
- **Failed Groq attempts are billed.** The retry loop is 2 attempts × 3 models, and the documented "returns reasoning only, no content" case is discarded and retried on the *next, more expensive* model.

**Supabase Pro becomes mandatory at the 3rd–5th customer, not the 25th** the
model assumes — one Business customer at 50,000 records plus 10,000 AI replies a
month (≈20,000 `chat_messages` rows) approaches the 500 MB free limit inside a
year, and `FREE-TIER-HARDENING.md` already reports 503s on parallel queries.

**Abuse case.** The limit is 20/min per org+IP = 864,000 requests/month from one
machine. A Starter's entire 1,000-reply allowance drains in **50 minutes**. If
the chain falls through to qwen, that month costs **₹616–760 against ₹847 of net
revenue** — and because the limit sits after the writes, the attacker also fills
your database and consumes the shared free edge-function quota.

---

## Two deadlines

1. **30 September 2026 — 19 days.** Meta requires a payment method on file or it stops delivering WhatsApp **service** messages from 1 October. This is an operational action, not a pricing one.
2. **1 October 2026.** Service messages become chargeable. `PRICING.md` has this, but misses two things: utility templates sent inside an open service window **also lose their free status** (for a CRM whose traffic is replies and reminders, that is the biggest free bucket disappearing), and there is a new **1,000-free-service-messages per number per month** allowance you are not claiming.

---

## What I got wrong on Tuesday

The FAQ I wrote for `product.html` states: *"signing up is free and stays free.
You can build your pipeline, add your fields, **import your records** and tune
the AI agent without paying anything."* And the migration email I wrote says
*"Export a CSV… Import it… you can do all of it before you pay."*

**Both are false.** Free is `max_leads = 0`, and `csv_import` is not in the
inbound exemption list, so every imported row is rejected. I wrote confident
copy about a flow I had not traced. The existing `pricing.html` line was
carefully worded to say "pipeline, fields and AI agent" and deliberately omitted
importing — I should have noticed why.

I also left `CAPTURE_KEY = "PASTE_..."` in `product.html` while the surrounding
copy uses that form as live proof the product works. It fails safe — it tells
visitors to WhatsApp instead of silently eating enquiries — but the claim is
false as committed.

**None of Tuesday's work is deployed.** The funnel, the segment migration and
both edge-function changes are uncommitted. Given the above, that is fortunate:
fix the copy before it ships.

---

## Order I'd fix these in

**Before any customer (about 2 days):** items 1–8 in the stop-ship table.

**Before any customer reads the site (about half a day, no code):** delete the
four add-on prices; fix `pricing.html`'s auto-renew line and the self-contradiction
in Terms §4; remove "cancel from Settings" or build the button; remove "1 Login
for all your brands"; source-and-date the competitor table or drop it; correct
the backups sentence; correct my import claims in the FAQ and the nurture email;
pick one phone number and one support-response promise; add the caps and the
no-trial policy to the AI agent's knowledge and remove the RESULTS GUARANTEE
from the CRM pages.

**Before the 10th customer (about a week):** server-side pagination, or at
minimum make the truncation banner fire and stop printing wrong counts; GST
invoice generation and a billing-history screen; the Resend "Send invite" button
actually sending; meter marketing WhatsApp separately.

**Before scale:** a DPA and sub-processor list; the API-key isolation test that
is still unrun; a rehearsed restore from one of those pg_dump artifacts.

The foundations here are good — tenant isolation is enforced in the database and
tested with real cross-tenant writes, billing is signature-verified and
fail-closed, plan limits are enforced server-side in triggers rather than in the
browser. That is the hard part and it is done. What is broken is the layer the
customer actually touches, and most of it is a day's work.
