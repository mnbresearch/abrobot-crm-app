# Run this — 11 September 2026

Everything outstanding, in order. Two places to work:

- **SQL** — Supabase → your CRM project → SQL Editor
- **Terminal** — the Terminal app on your Mac

Steps 1–5 take about fifteen minutes. Step 6 is the one only you can do.

> Earlier runbooks are superseded. `FUNNEL.md` describes the 8 September funnel
> work and its one manual step (step 4 below); this file is the running order.

---

## Step 1 — SQL: the agent belongs to each tenant

Open `supabase/migrations/20260911090000_tenant_agent_defaults.sql`, paste the
whole file, Run.

**This is the important one.** Until it runs, every organisation on the platform
shows AbroBot's study-abroad widget on their own website — "Study-abroad
assistant · online", a greeting about universities and visas, and your Calendly
offered to their customers. Not as an error: as the normal case, because
`create_organisation` seeded four fields and everything else fell through to a
default written when this was a single-tenant tool.

It also gives the `free` plan a real allowance — 50 records, 50 AI replies, 20
emails — so a new account can actually demonstrate the product instead of
telling every visitor the assistant is "taking a short break" and rejecting
enquiries with *"Your subscription has ended"* on day one.

**Expect:** 7 rows — 6 PASS plus a count of active industry packs (14). Then a
table of every org's widget subtitle and greeting. **Read that table.** Any row
saying "Study-abroad assistant" that is not a study-abroad business is a bug;
tell me and stop.

## Step 1b — SQL: put two customers on the right industry

**Run this because step 1's table told us to.** It showed `aa-enterprises` (a
yarn and textile supplier) and `toppers-hub` (a coaching academy) both sitting
on the **study-abroad** pack.

Their greeting and subtitle looked right in that table, because both wrote their
own and the backfill correctly preserved them. The problem is the two columns
the table does not print — `persona` and `knowledge`, which are what the model
is actually told. Both were briefed as *"a warm, knowledgeable study-abroad
counsellor"*. A buyer asking the yarn supplier for a quote on 40s combed cotton
was talking to a study-abroad counsellor behind a header that said "Yarn &
textile supplier".

Open `supabase/migrations/20260911110000_fix_industry_assignment.sql`, paste,
Run.

It adds a **Wholesale & Distribution** pack (a large category of Indian SME the
product had no home for), repoints both organisations, and repairs their agent
copy — but only where that copy is still the study-abroad pack's text word for
word. Anything either business wrote itself is left alone.

**Expect:** 4 rows. `only genuine study-abroad businesses are on that pack`
should read **PASS — abrobot and ednex only**. The last row flags any *other*
organisation that looks misassigned; if it says REVIEW, send me the list.

**It deliberately does not touch their pipeline stages.** Their boards still
have `visa` and `enrolled` columns, and `leads.stage_key` points at those, so
remapping moves real records. The bottom of the file prints their current stages
and a commented, ready-to-run remap. Read it, check the mapping against how
those businesses actually sell, then run it one org at a time.

## Step 1c — SQL: move their boards onto the right pipeline

Step 1b repointed the two organisations but deliberately left their pipeline
stages alone, because `leads.stage_key` references them. The check afterwards
showed the volumes: **aa-enterprises has 2 records, toppers-hub has 0.** That is
as cheap as this will ever get — the cost of a stage remap is entirely in the
records that have to move.

Open `scripts/remap-industry-stages.sql`, paste, Run.

It syncs both boards to their pack, moves the records onto the nearest
equivalent stage, removes the study-abroad columns nothing is using, and
**refuses to commit if a single record would be stranded** — it raises rather
than reporting, so a half-finished remap is impossible.

**Expect:** two notices (`aa-enterprises → wholesale pack: N record(s) moved`),
then 3 PASS rows and the final board layouts.

If you skip this, the yarn wholesaler keeps a board with **visa** and
**enrolled** columns, and every enquiry captured from here on lands in a
study-abroad stage its own pack does not define.

## Step 2 — SQL: a ceiling on expensive WhatsApp

Open `supabase/migrations/20260911100000_whatsapp_economics.sql`, paste, Run.

Marketing templates cost Meta about 7.5× a service message. Nothing in the
product can send one today — there is no template code path at all — but the
allowance made no distinction, so the day someone adds template sending the cap
would silently permit 7.5× the cost it was sized for. This builds the ceiling
before the thing it limits exists.

**Expect:** 4 PASS/INFO rows and the per-plan marketing caps.

## Step 3 — SQL: segmented follow-up

Open `supabase/migrations/20260908120000_nurture_segments.sql`, paste, Run.

Lets one organisation run different follow-up sequences for different audiences
— which is what keeps consulting enquiries and CRM buyers in MNB Research from
receiving each other's emails.

**Expect:** 7 rows, then a final row printing the **capture key**. Copy it.

## Step 4 — Paste the capture key

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/set-capture-key.sh
```

It asks for the key, checks it looks right, edits the one line in
`product.html`, and tells you what to do next. Nothing is typed on the command
line, so the key stays out of your shell history.

**Lost the key?** The script prints the query, or run this in the SQL editor:

```sql
select wk.key
  from public.webhook_keys wk
  join public.organizations o on o.id = wk.org_id
 where o.slug = 'mnb-research' and wk.segment = 'crm-website' and wk.active;
```

Doing it by hand is fine too — it is one line, number 695 in `product.html`:

```js
var CAPTURE_KEY = "PASTE_CRM_WEBSITE_CAPTURE_KEY_HERE";
```

The key is capture-only: anything holding it can create a record in that one
organisation and read nothing at all. That is why it belongs in page source,
the same way a Google Analytics ID does.

**Until you do this the enquiry form on your own site refuses to send** and
tells visitors to WhatsApp instead. It fails safe, but it captures nothing.

## Step 5 — Terminal: deploy and commit

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/deploy-all.sh
```

Deploys all ten edge functions and rebuilds the frontend. **Five functions
changed** in this release — `chat-agent`, `nurture`, `lead-webhook`,
`summarize-chats` — plus `widget.js`, which ships with the frontend build.

**Expect:** ten `live` lines, no `MISSING`.

`widget.js` is served from the site root, so the frontend deploy is what
publishes it. Until it does, existing customers' widgets keep the old
AbroBot-branded fallbacks.

Then:

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && rm -f .git/index.lock && git add -A && git commit -m "Per-tenant agent, working free plan, honest pricing copy, mobile nav, pagination" && git push
```

## Step 6 — Browser: sign up as a stranger

**This is the only remaining risk, and this release is exactly the kind that
needs it.** Twenty minutes.

**Sign up a throwaway account and pick an industry that is NOT study abroad** —
a dental clinic, say. Then:

| Where | Do | Expect |
|---|---|---|
| Settings → AI Agent | Look at the greeting and subtitle | **Clinic** wording. Not one word about universities, scholarships or visas |
| Settings → Install Widget | Copy the snippet | Host is `crm.mnbresearch.com`, `data-org` is your slug |
| Any test page | Paste the snippet, load it | Widget appears; header is your business; **no AbroBot logo, no orange, no Calendly** |
| The widget | Ask it something | Answers as a clinic assistant, and does not offer to book a counselling call |
| The widget | Give it your name and phone | Record appears in the CRM within about a minute |
| Leads → Import | Import a 10-row CSV | Works — free includes 50 records |
| Leads → Import | Try a 200-row CSV | Refused **up front** with a clear number and an Upgrade link. Nothing half-imported |
| Your phone | Open the CRM | **A menu button.** Tap it, navigate, tap a link — drawer closes |
| Your phone | Pipeline | "Move ▾" on a card opens a stage picker |
| Settings → Plan & usage | Look | Says you are on Free with a small allowance — **not** "capturing is off" |

Anything misbehaves — tell me what you clicked and what happened.

---

## What changed in this release

| Area | |
|---|---|
| **Agent** | Industry packs seed greeting, subtitle, quick replies and knowledge. Every AbroBot default removed from `chat-agent` and `widget.js`, including the `BOOKING_URL` environment fallback. Two customers' hardcoded configs removed from `widget.js` — it was shipping their phone numbers to every other customer's site |
| **Free plan** | 0 → 50 records, 50 AI replies, 20 emails. Inbound capture no longer bypasses the cap on free, so the number means something |
| **Mobile** | A navigation drawer. There was one breakpoint in the whole app and it deleted the sidebar with nothing to replace it. Kanban cards are movable by touch |
| **Scale** | Server-side pagination, true record counts, and a CSV export that pages the whole set. Nothing could reach record 2,001 before, on a plan selling 50,000 |
| **Import** | Pre-flight against the allowance, stop on first failure, progress. It used to commit some chunks and silently drop the rest |
| **Cost** | Dead model removed from the fallback chain (Groq shut it down on 16 Aug and nobody noticed). Rate limit moved above the database writes. `summarize-chats` now meters what it spends |
| **Copy** | Four add-ons that could not be bought, an auto-renew claim the code contradicts, a cancel button that does not exist, "1 login for all your brands", unsourced competitor prices, overstated backups, and two false claims of my own about importing on the free plan |

## Still open

- **30 September — 19 days.** Meta needs a payment method on file or WhatsApp
  service messages stop being delivered from 1 October. Operational, not code.
- **No GST invoice is generated.** `pricing.html` now says invoice-on-request
  rather than promising one, but for Indian B2B buyers this is worth building.
- **No DPA or sub-processor list.** Your Terms say you act as a processor;
  Supabase, Groq, Resend, Meta, Telegram and Cashfree are disclosed nowhere.
- **`scripts/api-isolation-test.sh`** still needs API keys from two orgs.
- **Stage counts** fan out one head-count request per stage. Degrades safely
  now, but the real fix is a grouped-count RPC.
- **A rehearsed restore.** The nightly `pg_dump` has never been restored from.

## Reference

| File | What |
|---|---|
| `RUN-THIS.md` | this |
| `STATE-OF-THE-PRODUCT.md` | the full audit this release answers |
| `FUNNEL.md` | the sales funnel and its capture key |
| `PRICING.md` | corrected margin model, with every input sourced or marked assumed |
| `scripts/verify-all.sql` | 18 schema checks |
| `scripts/tenant-isolation-test.sql` | 16 isolation checks |
| `scripts/superadmin-audit.sql` | who can reach what |
