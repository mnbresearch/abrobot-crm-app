# MNB Research — CRM org, agent, and getting off Chatbase

## What was actually wrong

You said the chat "was working before but it got out of the website." It is
still on the website — but it is **not ours**.

`www.mnbresearch.com` loads:

```
https://www.chatbase.co/embed.min.js
```

That is **Chatbase**, the paid third-party tool. The bubble works, it answers
visitors, and every lead it captures stays inside Chatbase. There was no MNB
Research organisation in the CRM at all, so nothing could reach it.

So you are paying a competitor to run the chat on the one site that exists to
sell your own chat product. That is the thing to fix.

For reference, the site also loads Apollo's website tracker and a Calendly
widget, so there are three separate third-party scripts doing lead capture on
that page.

---

## Step 1 — run the SQL

`scripts/create-mnb-research-org.sql`

I built and validated it (9 statements, parses clean) but could **not** run it.
Partway through this session the Supabase dashboard stopped resolving project
`pomsltnrxvbcafwtbtlc` for the browser session — every attempt to open the SQL
editor bounced to the organisation list. Your account is still signed in, but
`nandadynastybuilders-2809` no longer appears among your orgs, which matches the
Vercel-managed-org permission problem we hit earlier in this project.

Open the SQL editor, paste the file, run it. It is idempotent — safe to re-run.

It creates:

- **Organisation** "MNB Research", slug `mnb-research`, on **enterprise**
  (unlimited, never expires — same as your other four).
- **Consulting pipeline**, because no consulting industry pack exists and
  "General Business" does not describe how you sell:
  `New Enquiry → Qualified → Assessment Booked → Assessment Done → Proposal Sent → Engaged / Lost`
  Assessment Booked is deliberately its own stage — that is where revenue sits
  waiting, and it is the number you will want on the dashboard.
- **Five custom fields**: Company, Their Industry, Problem To Solve, Timeline,
  Product/Service — mirroring the "finish the sentence" form already on your
  homepage, so the AI collects the same things.
- **The agent**, with a 6,192-character knowledge base covering every figure on
  your site: the three engagement types, six practices, the ₹9,999 assessment
  and that it is credited back, all four engagement bands with real prices, all
  twelve products with their pricing, the Results Guarantee, minimum
  commitments, and the five FAQ answers.
- **A webhook key** for the website.

The last statement prints the webhook key. **You need it for step 2.**

---

## Step 2 — replace Chatbase on the site

Find this in your site template and **delete it**:

```html
<script src="https://www.chatbase.co/embed.min.js" ...></script>
```

Put this in its place, before `</body>`:

```html
<script src="https://abrobot-crm-app.pages.dev/widget.js" data-org="mnb-research" defer></script>
```

That is the whole integration. Everything else — greeting, colours, quick
replies, persona, knowledge — is already in the CRM and editable from
Settings → AI Agent without touching the site again.

Deploy `widget.js` first (see `DEPLOY-REMAINING.md`) so the markdown fix ships
with it, otherwise MNB's answers will show literal `**asterisks**` the same way
AbroBot's currently do.

---

## Step 3 — fix the pricing contradiction on the website

You confirmed the **CRM is right**, so the website copy is what changes.

On `mnbresearch.com/pricing`, the AbroBot CRM card currently reads:

> **₹1,499** per month, flat per business
> AI agent on site and WhatsApp. Never per seat.

It should read:

> **From ₹999** per month
> AI agent on your site and WhatsApp. Starter ₹999 (3 users), Growth ₹2,499
> (10 users), Business ₹4,999 (30 users).

**There is a second edit, and it matters more.** Further down, under "What the
price always includes", you promise:

> **No per-seat billing** — Our products are priced per business. Adding your
> ninth user does not change the invoice.

That is now false for AbroBot CRM specifically: adding a ninth user on Starter
is blocked, and the seat cap is enforced in the database. Either narrow that
claim to the products where it still holds (YarnTally, Raksha AI, CreatorLift,
ABROFIT), or drop it. Leaving it as a blanket promise is the kind of thing a
customer screenshots when they hit the cap.

The knowledge base I wrote already states the correct tiers, so **the AI will
give the right answer even before you edit the page.** But it will then be
contradicting the pricing table directly above it, which is worse than either
version alone — so do this edit.

---

## What I could not verify

I have not seen this agent answer a question, because I could not run the SQL.
Once you have, ask it these four — they exercise the parts most likely to be
wrong:

1. *"What does an AI engagement cost?"* — should lead with the ₹9,999
   assessment and that it is credited back, then give the bands.
2. *"How much is AbroBot CRM?"* — should say ₹999 / ₹2,499 / ₹4,999 with seat
   counts, **not** ₹1,499.
3. *"Can you do my company's tax filing?"* — should decline to give tax advice
   and offer a TaxSense AI walkthrough instead. This tests the guardrails.
4. *"How long until I see ROI?"* — should refuse to promise a figure and point
   at the assessment. This is the guardrail that protects you legally.

If any of those four is wrong, tell me what it said and I will fix the
knowledge base.
