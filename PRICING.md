# Does the business model work?

Answering the question directly: **yes, the pricing works. The enforcement did not.**

Written 28 Aug 2026, after auditing what the code actually does versus what the
pricing page promises.

---

## 1. The thing worth correcting first

The worry was that generous teammate limits dilute what we charge. That reads
the cost structure backwards.

**Seats do not cost us money.** Ten users and three users hit the same
database, the same edge functions, the same Postgres. The marginal cost of the
tenth seat is effectively zero.

What *does* cost money, per unit, is:

| Driver | Real cost | Who pays it |
|---|---|---|
| AI chat messages | ~₹0.03 each (Groq, ~1,250 tokens) | us |
| WhatsApp conversations | ~₹0.80 each (Meta) | us |
| Email sends | ~₹0.27 each (Resend) | us |
| Seats | ₹0 | nobody |

So seats are a **value metric**, not a cost driver — a bigger team gets more
value from the CRM, so a bigger team pays more. That is a good reason to cap
them, and they were already capped at 3 / 10 / 30 and correctly enforced.

Seats were never the leak. Three other things were.

---

## 2. Margins

Assuming an org uses ~80% of its allowance (heavy users; most use far less):

| Plan | Price | AI | WhatsApp | Email | Variable cost | Margin | % |
|---|---:|---:|---:|---:|---:|---:|---:|
| Starter | ₹999 | ₹30 | ₹0 | ₹5 | ₹36 | **₹963** | 96% |
| Growth | ₹2,499 | ₹152 | ₹240 | ₹54 | ₹446 | **₹2,053** | 82% |
| Business | ₹4,999 | ₹607 | ₹640 | ₹270 | ₹1,517 | **₹3,482** | 70% |

Fixed infrastructure is ~₹3,960/month (Supabase Pro + Resend). **Break-even is
four Starter customers, or two Growth.**

Margins decline as customers move up, which is the correct shape — the bigger
plans are the ones actually consuming. Nothing here is priced below cost even
if a customer maxes out every allowance.

**The pricing is not the problem.**

---

## 3. What the audit actually found

| Limit | Sold as | Was it enforced? |
|---|---|---|
| Seats | 3 / 10 / 30 | ✅ Yes |
| AI messages | 1k / 5k / 20k per month | ✅ Yes |
| Records | 1k / 10k / 50k | ❌ Displayed only |
| Automations | 5 / 25 / 100 | ❌ Displayed only |
| WhatsApp | Growth and above | ❌ **Never checked** |
| **Subscription expiry** | monthly | ❌ **Never checked** |
| **Trial expiry** | 7 days | ❌ **Never checked** |

The last two matter far more than the first three, and neither was on the
original list of concerns.

`subscriptions.current_period_end` was written by the payment webhook and read
by nothing. `organizations.trial_started_at` likewise. There was no code
anywhere that reduced anyone's access, ever.

The practical effect: **pay ₹2,499 once and hold Growth forever.** Start a
7-day trial and it never ends. We were not selling a subscription — we were
selling a perpetual licence at a monthly price, by accident. No customer had
hit that yet only because the product is young.

---

## 4. How it is fixed

`20260821080000_enforce_plan_limits.sql`

**One function decides entitlement.** `plan_of(org)` resolves what an
organisation is entitled to *right now*, accounting for trial and subscription
expiry. Every limit check reads it. Expiry cannot be forgotten at a call site
because no call site computes it.

`organizations.plan` is never overwritten — it keeps recording what was bought.
Only the *effective* plan changes. A renewal therefore restores full access the
moment the webhook lands: no repair job, no lost history.

**Three days of grace.** Cards fail and UPI mandates lapse. Cutting off a
paying customer at midnight over a failed card loses accounts that wanted to
stay.

**The expired tier is read-only, not locked-out.** Sign in, see everything,
export it. What stops is *new* — records, AI replies, WhatsApp, automations.
Holding a customer's own data hostage converts a lapsed account into a
chargeback and a bad review; removing ongoing value is enough.

**Record limits are deliberately asymmetric:**

- **Inbound** (chat widget, webhook) — accepted over the limit, always.
- **Deliberate** (manual add, CSV import) — blocked, with a message.

An inbound record is a real person who just messaged our customer. Dropping it
means our customer loses business and blames the CRM. That loses the account;
it does not upsell it. Upgrade pressure comes from the blocked bulk paths and
the meter, not from binning enquiries.

**Warning before cut-off.** Settings shows a banner from seven days out.
Someone who learns they lapsed by watching a send fail files a support ticket;
someone who saw it coming renews.

---

## 5. Bugs found while doing this

Four, all pre-existing:

1. **`consume_usage` was callable by anyone, anonymously**, with any `org_id`.
   A stranger with a browser could burn a paying customer's monthly AI
   allowance to zero. Now revoked from `public`, `anon` and `authenticated`.

2. **`usage_snapshot` read the purchased plan**, so a lapsed org's Settings page
   would have cheerfully reported "5,000 AI messages" while the server refused
   at zero.

3. **`plan_of` failed open.** There is no foreign key from
   `organizations.plan` to `plan_limits.plan`, so a single typo would have
   produced a NULL limit — which every guard reads as *unlimited*. Now falls
   back to trial.

4. **`app-signup` inserted `source: "app"`**, which is not a member of the
   `lead_source` enum. Every insert failed with 22P02, the error was discarded,
   and the endpoint returned `ok: true` while recording nothing. **Signups from
   app.abrobot.ai have been dropping on the floor.** Fixed to `"other"`, and
   the error is now surfaced rather than swallowed.

Bug 4 is the same silent-write-failure pattern found three times before in this
codebase. It is worth a dedicated pass over every `.insert(` and `.update(`
that ignores its error.

---

## 6. Honest read on direction

**What is working:** margins are healthy at every tier. The value metric
(seats) is the right one — it scales with how much the customer gets, not with
what they cost us. The AI allowance, which is the true variable cost, was
already enforced atomically.

**What to watch:**

- **₹999 with no WhatsApp is a hard sell in India.** WhatsApp is how Indian
  businesses talk to customers. Starter may need a small WhatsApp allowance —
  say 100 conversations — to stop being a plan nobody picks. Worth watching
  the conversion split before changing anything.
- **Multiple free trials via multiple emails.** One org per account is
  enforced, but one *person* can hold several accounts. Not worth solving
  until it is observed.
- **Annual is priced at 10× monthly** ("2 months free"). That is a 17%
  discount for a 12× cash-flow improvement — good, and worth pushing harder in
  the UI than it currently is.

**Before selling into healthcare or legal:** terms, privacy policy and a DPA.
Not optional in those verticals, and not written yet.

---

## Verify after applying

```sql
-- Who is live, who has lapsed
select o.name, o.plan as purchased, effective_plan(o.id) as effective,
       s.current_period_end
  from organizations o left join subscriptions s on s.org_id = o.id
 order by 3, 1;
```

Expiry (rolls back, safe to run):

```sql
begin;
  update subscriptions set current_period_end = now() - interval '30 days'
   where org_id = '<org>';
  select effective_plan('<org>');         -- expect: expired
  select plan_allows_whatsapp('<org>');   -- expect: false
rollback;
```
