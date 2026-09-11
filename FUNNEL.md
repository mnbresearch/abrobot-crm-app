# The sales funnel — 8 September 2026

Your marketing site sells lead capture and captured no leads. Every button on
it left the site: signup, or WhatsApp. Someone interested but not ready left no
trace at all, and you never found out they existed.

That's now closed, and the funnel runs on your own product.

---

## What changed

**`product.html`** — three additions.

1. **An enquiry form** (`#start`). Name, phone, email, business, plan, and an
   optional "what do you want it to do". It posts to your own `lead-webhook`,
   so an enquiry lands in the CRM, scores itself, assigns itself, pings your
   phone and enters a follow-up sequence — the product doing its own selling.
2. **The plan buttons now open it,** carrying which plan was clicked. They used
   to open WhatsApp, where the enquiry lived in a phone and the CRM never knew.
3. **A ten-question FAQ** — the funnel stage that was missing between "this
   looks good" and "I'll pay". Why there's no trial, why ₹999, who owns the
   data, how hard migration is, cancellation, WhatsApp costs, tenant isolation,
   whether a developer is needed, what happens when the AI is wrong, and what
   isn't ready yet. Answered plainly, including the awkward ones — the last
   question names white-label and multi-brand as not available and tells people
   not to buy on that basis.

**`pricing.html`** — every plan now links into the form with that plan
preselected. It listed prices and then offered no way to respond to them.

**Your chat widget is now on all five marketing pages.** It was on none of
them. A product whose pitch is "an AI agent on your site in minutes" was the
one site not running one. It points at the MNB Research agent, whose knowledge
base already carries the current ₹999 / ₹2,499 / ₹4,999 tiers.

---

## The feature underneath it

You asked what I'd deepen. This is it, and the funnel is why it was needed.

**Follow-up sequences are now per-audience.** Until now one organisation got
one sequence: every contact with an email address received identical copy. MNB
Research is the case that breaks it — the same CRM holds people asking about a
₹9,999 consulting assessment and people asking to buy a ₹999 CRM. One sequence
is either vague enough to persuade nobody, or confidently about the wrong
product half the time.

So a capture key can now carry an **audience**, records inherit it, and a
template can name the audience it's written for. Templates naming none stay the
default sequence — so nothing changes for anyone who doesn't touch it.

Three rules, tested in `supabase/functions/_shared/sequences.test.ts`:

- an audience with its own sequence gets **only** that sequence
- an audience without one falls back to the default
- if neither exists, **nothing is sent** — silence beats the wrong pitch

Set an audience when creating a capture URL in **Integrations**; pick it on a
template in **Templates**.

### One design decision worth knowing about

The obvious way to do this was to segment on `leads.source`. It would have been
wrong, and expensively so. `source` is a Postgres enum with nine fixed values —
writing `'crm-website'` raises `22P02`, which is the *exact* bug already
recorded in `DEPLOY-REMAINING.md` against `app-signup`, where `source: "app"`
made every signup fail while the endpoint returned `ok: true`. Here it would
have aborted the transaction and rolled the whole migration back silently.

I built it that way first. It's in the migration's header comment as a warning,
because the next person to reach for `source` deserves to find the reasoning.

---

## Two bugs fixed on the way

Both were live, both pre-date this work.

**Follow-up would have quietly stopped for busy tenants.** The engine fetched
100 records per org per run, unordered, filtered only by the org's *longest*
sequence. Records that could never be sent — finished, or in an audience with
no copy — matched that filter forever and were re-fetched every hour. Once a
hundred accumulated, they filled the page and records that *should* have been
emailed were never fetched at all. Follow-up stops; the log still says
"candidates: 100". Now each sequence gets its own query, bounded by its own
length, ordered oldest-first, fetching only records it can actually send to.

**A gap in a sequence stalled everyone in it permanently.** Delete step 2 of
three and every mid-sequence contact stopped at step 1 forever, because the
engine skipped the missing step without advancing past it. It now advances
through the hole without sending, so step 3 is reachable.

Smaller ones: a returning enquirer's details were discarded on the dedupe path
(so someone who chatted first and then filled the form kept no audience, and
received nothing); `Bob <bob@x.com>` was stored verbatim as an email address and
would have silently failed to send; the Templates screen showed "switched on"
when it had actually failed to read whether it was on; and the merge-token list
was hardcoded to study-abroad fields, so every other industry's custom fields
were unusable and undiscoverable.

---

## To go live

### Step 1 — SQL

Run `supabase/migrations/20260908120000_nurture_segments.sql`.

**Expect:** 7 check rows — 5 reading PASS, plus two that report a count rather
than a verdict:

- `CRM buyers have their own follow-up` → **3 step(s), audience crm-website**
- `no existing record was swept into the new sequence` → **0 record(s)**, which
  is correct before the first submission and is the check asserting that
  nothing already in your CRM was pulled into the new sequence

Then a final row printing the **capture key**. Copy it.

### Step 2 — paste the key

In `product.html`, find:

```js
var CAPTURE_KEY = "PASTE_CRM_WEBSITE_CAPTURE_KEY_HERE";
```

Replace with the key from step 1. It's a capture-only credential — it can create
records in that one organisation and read nothing — which is why it's safe in
page source, like a Google Analytics ID.

**Until you do this the form refuses to send** and tells the visitor to WhatsApp
instead, rather than silently swallowing enquiries.

### Step 3 — Terminal

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/deploy-all.sh
```

**Expect:** ten `live` lines. `nurture` and `lead-webhook` both changed.

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && rm -f .git/index.lock && git add -A && git commit -m "Sales funnel: capture form, FAQ, widget, per-audience follow-up" && git push
```

### Step 4 — send yourself one

Open `crm.mnbresearch.com/product`, click a plan, fill the form with your own
details, send.

| Check | Where | Expect |
|---|---|---|
| The record exists | CRM → MNB Research → records | Your name, source `website` |
| The plan came through | open it | **Product / Service** = the plan you clicked |
| The audience is set | open it | segment `crm-website` |
| The alert fired | your phone | Telegram, within about a minute |
| Follow-up is queued | Templates | Three `CRM …` steps, audience `crm-website` |

About an hour later, email 1 should arrive. **Unsubscribe from it** — that's the
one path that is embarrassing to have broken, and testing it costs nothing.

---

## Worth knowing

- **Consulting enquiries still get no automatic follow-up.** They have no
  default sequence, which is what they had yesterday. If you want one, write a
  step 1 in Templates with audience **Everyone** — it will then reach every
  record that isn't `crm-website`, including old ones. Check the count before
  you switch it on.
- **The widget on the marketing site answers as MNB Research**, not as a
  CRM-specific agent. Its knowledge base does carry the current CRM tiers, so
  the answers are right. A dedicated agent would be better and is a small job.
- **`?plan=` deep links work** — `/product?plan=Growth` opens the form with
  Growth selected. Useful for ads and email.
- **The form is one page.** If enquiries are thin, the first thing to try is
  cutting the email field, not adding copy — three required fields is already at
  the upper end for an Indian SME audience.
