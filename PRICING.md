# Pricing — and why the limits are what they are

Updated **11 September 2026**. This version supersedes the 8 September one.
There is no free trial. **₹999 Starter is the front door**: sign up free, set
everything up, pay to switch it on.

| | Free | Starter | Growth | Business | Enterprise |
|---|---|---|---|---|---|
| **Price / month** | ₹0 | **₹999** | ₹2,499 | ₹4,999 | Custom |
| Users | 1 | 3 | 10 | 30 | Unlimited |
| Records | **50** | 1,000 | 10,000 | 50,000 | Unlimited |
| AI replies / mo | **50** | 1,000 | 5,000 | 10,000 | Unlimited |
| Emails / mo | **20** | 300 | 3,000 | 6,000 | Unlimited |
| **WhatsApp service / mo** | — | — | **1,500** | **3,000** | Unlimited |
| **WhatsApp marketing / mo** | — | — | **300** | **600** | Unlimited |
| Automations | — | 3 | 25 | 100 | Unlimited |
| **REST API + webhooks** | — | — | — | **✓** | ✓ |

Free is no longer read-only. It was 0 records / 0 AI replies, which made the
product look broken to everyone who signed up. It is now 50 / 50 / 20 — enough
to import a small list, watch the agent answer, and decide. That costs us about
**₹6.38 per signup** and it is a hard ceiling, not a soft one. See
[Customer acquisition cost](#customer-acquisition-cost).

---

## What changed and why

The 8 September model was re-derived from scratch on 11 September against the
code and against live vendor pricing. **The model was internally consistent — it
reproduced to 83.6% / 62.4% / 64.2% against its stated 84% / 61% / 63%. The
inputs were wrong.** Eight of them:

| # | What was wrong | Effect |
|---|---|---|
| 1 | **GST on revenue was never subtracted.** 18% was added to costs but ₹999 was treated as 100% revenue. | ₹152 of every ₹999 is not ours. Biggest single correction. |
| 2 | **Token volume understated ~3×.** Model assumed 1,200 in / 350 out. | Per-reply cost ₹0.037 → **₹0.093**. |
| 3 | **FX never stated.** The arithmetic implied ~₹88/USD. | Now **₹95.57/USD**, stated explicitly. |
| 4 | **Fallback models were never costed, and the chain was broken.** | Chain fixed; falling back is now *cheaper*, not more expensive. |
| 5 | **The "marketing WhatsApp worst case" does not exist today.** | There is no template-sending code. Worst case is ₹201, not ₹1,295. |
| 6 | **Resend marginal rate was 2.25× the bucket rate.** | ₹0.038 → **₹0.086** per email past the bucket. |
| 7 | **Supabase Pro assumed shared across 25 customers.** | It becomes mandatory at the **3rd–5th** customer. |
| 8 | **Six costs were omitted entirely.** | GST, support labour, Resend Pro, accounting, failed Groq attempts, refunds. |

One thing the 11 September re-derivation *also* got wrong, and this document
corrects: it reported the uncapped-marketing case as live, and it called the
qwen fallback "16× the primary". Neither holds. Marketing templates cannot be
sent at all (item 5), and qwen at correct token volumes is 4.3×, not 16× — moot
either way, since qwen is out of the chain.

---

## How to read every number below

- **Revenue is net of GST.** Inter-state supply of SaaS requires GST
  registration from the first transaction — there is no threshold. Net revenue
  is price ÷ 1.18. Starter ₹999 → **₹847**. Growth ₹2,499 → **₹2,118**.
  Business ₹4,999 → **₹4,236**.
- **Margin percentages are against net revenue**, not the sticker price. A
  percentage of ₹999 would be flattering and meaningless.
- **Vendor costs are quoted as billed.** Groq and Resend invoice from abroad
  with no GST on the invoice (IGST is payable under reverse charge and is
  creditable once registered, so the net cost is the invoice amount). Meta bills
  in India and the ₹0.134 below is GST-inclusive. If you do *not* claim input
  credit on Groq and Resend, subtract **2.5 points from Starter and 6.2 points
  from Growth and Business** at full AI and email entitlement.
- Every input is marked **SOURCED** (URL + date checked) or **ASSUMED**.
  Assumed means exactly that: a guess with a reason, not a measurement.

---

## Unit costs (11 September 2026)

**FX: ₹95.57 = $1.00.** SOURCED — RBI reference rate, checked 11 Sep 2026
(https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx). Every dollar figure
below is converted at this rate. The previous version of this document never
stated an FX rate; its arithmetic implied ~₹88, which is an 8% understatement of
every dollar-denominated cost.

### AI replies

| Model | $/M in | $/M out | ₹ per reply | Status | Source |
|---|---|---|---|---|---|
| `openai/gpt-oss-120b` (primary) | 0.15 | 0.60 | **₹0.0932** | live | SOURCED — https://groq.com/pricing, 11 Sep 2026 |
| `openai/gpt-oss-20b` (fallback) | 0.075 | 0.30 | **₹0.0466** | live | SOURCED — same, 11 Sep 2026 |
| `llama-3.1-8b-instant` | — | — | — | **shut down 16 Aug 2026** | SOURCED — Groq deprecations, 11 Sep 2026 |
| `qwen/qwen3.6-27b` | 0.60 | 3.00 | ₹0.4014 | **removed** | SOURCED — Groq preview tier, 11 Sep 2026 |

**Token volume: ~4,500 in / 500 out. ASSUMED, but grounded.** The code's own
comment at `supabase/functions/chat-agent/index.ts:533` records the observed
system prompt as **~14,600 characters** — about **3,650 tokens before any
conversation history**. The history query at `index.ts:376` attaches up to **20**
prior messages. 3,650 + history + the current user message lands around 4,500.
The old 1,200-token assumption was not measured against anything.

```
input   4,500 × $0.15 / 1M  = $0.000675
output    500 × $0.60 / 1M  = $0.000300
                              ---------
                              $0.000975  × ₹95.57  =  ₹0.0932
```

**The fallback chain was broken and is now fixed.** As committed on 8 September
the chain was `gpt-oss-120b → llama-3.1-8b-instant → qwen/qwen3.6-27b`.
`llama-3.1-8b-instant` had been shut down by Groq on **16 August 2026** and was
still in production — a dead link in the middle of the chain, so every fallback
went straight to qwen, a *Preview* model at 4× the input and 5× the output price
of the primary (₹0.4014 per reply, **4.3×**). Both are now replaced by a single
fallback, `openai/gpt-oss-20b`, at exactly **half** the primary's price.

**Falling back is now cheaper than succeeding.** That is the property to
preserve: a degraded month costs less, not more. It was the opposite before.

**Failed attempts are billed.** `ATTEMPTS = 2` over a 2-model chain
(`index.ts:526`) means up to **4 billed calls** for one reply that a visitor
sees once — and the documented "returned reasoning only, no content" case
(`index.ts:529-542`) discards a full paid response and retries. Ceiling per
reply is 2 × ₹0.0932 + 2 × ₹0.0466 = **₹0.2796**, three times the headline rate.
The model below uses ₹0.0932; treat that as a floor.

### Email

| Item | Rate | Source |
|---|---|---|
| Resend free tier | 3,000/mo — **but capped at 100/day** | SOURCED — https://resend.com/pricing, 11 Sep 2026 |
| Resend Pro | $20/mo = **₹1,911**, includes 50,000 | SOURCED — same |
| In-bucket rate | $20 ÷ 50,000 = $0.0004 = ₹0.0382 | derived |
| **Overage rate** | **$0.90 per 1,000 = $0.0009 = ₹0.0860** | SOURCED — same |

Two things the old model missed. First, the overage rate is **2.25× the bucket
rate**, and the old model costed every email at the bucket rate. Second, the
free tier's **100/day** cap makes Pro effectively mandatory the moment any
customer sends real volume: a single Growth customer is entitled to 3,000
emails a month, which cannot be delivered inside 100/day without spreading a
campaign over a month. **Resend Pro is a fixed cost from the first paying
customer**, not an optional upgrade.

The 50,000 bucket is exhausted by **8 Business customers** (8 × 6,000 = 48,000)
or 17 Growth. Past that, every email is ₹0.086. The model below costs all email
at ₹0.086 — conservative, and correct at any scale worth planning for. Below
about 8 customers, emails are effectively free inside the bucket and real
margins are a few points better than shown.

### WhatsApp

| Item | Rate (incl. GST) | Source |
|---|---|---|
| Service message (free-form) | **₹0.134** from 1 Oct 2026 | SOURCED — Meta WhatsApp Business pricing, 11 Sep 2026 |
| Marketing template | ₹1.04 | SOURCED 8 Sep 2026 — **not re-verified 11 Sep** |
| Utility template | ₹0.134 | SOURCED — same as service, from 1 Oct 2026 |

**The "marketing worst case" does not apply today, and the earlier analysis was
wrong about this.** `supabase/functions/_shared/whatsapp.ts` has exactly one
sender — `sendWhatsAppText` — and it posts `type: "text"` (line 54): a free-form
**service** message, the cheapest category there is. Grep for `type: "template"`
across `supabase/functions` returns nothing. **A customer cannot send a
marketing message, because the code to send one does not exist.**

So the real Growth worst case is not 1,500 marketing templates at ₹1.04
(₹1,560). It is:

```
1,500 service messages × ₹0.134 = ₹201
```

That is a 7.8× overstatement in the previous analysis, and it is why Growth and
Business are comfortably positive below rather than −18% and −14%.

**This is a property of today's code, not of the pricing.** Migration
`20260911100000_whatsapp_economics.sql` adds `plan_limits.max_whatsapp_marketing`
(free 0 / starter 0 / growth 300 / business 600 / enterprise unlimited) with its
own `whatsapp_marketing` meter, so that **when template sending is built it
cannot silently blow the model**. Scenario (c) below prices that world.

### Everything else

| Item | Cost | Source |
|---|---|---|
| Payment gateway | 2.30% of **gross** price (1.95% + GST) | SOURCED — https://www.cashfree.com/payment-gateway-charges/, 11 Sep 2026 |
| Supabase Pro | $25/mo = **₹2,389** | SOURCED — https://supabase.com/pricing, 11 Sep 2026 |
| Resend Pro | $20/mo = **₹1,911** | SOURCED — https://resend.com/pricing, 11 Sep 2026 |
| Accounting + GST filing | **₹1,500–3,000/mo**, modelled at ₹2,000 | ASSUMED — small-practice CA retainer, Indian market |
| Support labour | **₹300/hr** | ASSUMED — founder time at an opportunity cost, not a salary |
| Refunds / chargebacks | ASSUMED 0 in the tables below | see [Refund exposure](#refund-exposure) |

Gateway is charged on the gross ₹999, not on net revenue. On Starter that is
**₹23** — genuinely a rounding error, and the old document was right that it is
not the problem.

**Supabase Pro becomes mandatory at the 3rd–5th customer, not the 25th.** The
free tier gives 500 MB of database. One Business customer at 50,000 records plus
10,000 AI replies/month (≈20,000 `chat_messages` rows/month, 240,000 a year) is
roughly 50 MB of leads plus 120 MB of messages before indexes, and indexes
roughly double it — **~340 MB from one customer inside a year**, on a 500 MB
ceiling, with `FREE-TIER-HARDENING.md` already reporting 503s on parallel
queries. Row-size estimates here are ASSUMED (1 KB per lead, 0.5 KB per
message); the conclusion is not sensitive to them being off by half.

---

## Margins

Allocated over **25 paying customers**, the same base the previous version used,
so the correction is apples-to-apples. Fixed platform cost is Supabase Pro +
Resend Pro = ₹4,300/mo = **₹172 per customer at n = 25**. Accounting, support
and acquisition are below the line and are handled in
[Break-even](#break-even).

Three scenarios:

- **(a) Assumed mix** — ASSUMED 60% of the AI allowance, 50% of email, 50% of
  WhatsApp. A plausible engaged customer. There is no usage data behind this
  because there are no paying customers yet; it is a guess and should be
  replaced the moment there is a month of real telemetry.
- **(b) 100% of every entitlement** — every allowance fully drained, all
  WhatsApp service, because service is all the code can send. **This is the true
  worst case today.**
- **(c) 100% of every entitlement with marketing at the new cap** — the future
  case, once template sending exists and `max_whatsapp_marketing` binds.

| Plan | Claimed (8 Sep) | **(a) Assumed mix** | **(b) 100% entitlement** | (c) With marketing at cap |
|---|---|---|---|---|
| Starter ₹999 | 84% | **68.8%** | **62.9%** | 62.9% |
| Growth ₹2,499 | 61% | **65.1%** | **45.5%** | 32.7% |
| Business ₹4,999 | 63% | **69.2%** | **49.6%** | 36.7% |

Every cell is positive. Scenario (a) comes out *above* the old "realistic"
column for Growth and Business, which looks wrong until you see why: the old
column assumed 100% of AI and email *and* a 20% marketing mix that is not
physically possible. Correcting the marketing error outweighs adding GST.
Scenario (b) is the honest comparison, and there Growth and Business fall by
15–16 points against the claim.

### The arithmetic, shown

**Starter ₹999, scenario (b):**

```
gross                                       999.00
  less GST (999 ÷ 1.18)                    −152.39
net revenue                                  846.61
  gateway            999 × 2.30%            − 22.98
  AI        1,000 replies × ₹0.0932         − 93.18
  email        300 emails × ₹0.0860         − 25.80
  WhatsApp                       (none)     −  0.00
                                            --------
contribution                                 704.65
  platform infra   ₹4,300 ÷ 25              −172.03
                                            --------
operating profit                             532.62   =  62.9% of net revenue
```

**Growth ₹2,499, scenario (b):**

```
net revenue (2,499 ÷ 1.18)                 2,117.80
  gateway          2,499 × 2.30%            − 57.48
  AI        5,000 replies × ₹0.0932         −465.90
  email      3,000 emails × ₹0.0860         −258.04
  WhatsApp    1,500 service × ₹0.134        −201.00
                                            --------
contribution                               1,135.38
  platform infra                            −172.03
                                            --------
operating profit                             963.35   =  45.5% of net revenue
```

**Business ₹4,999, scenario (b):**

```
net revenue (4,999 ÷ 1.18)                 4,236.44
  gateway          4,999 × 2.30%            −114.98
  AI       10,000 replies × ₹0.0932         −931.81
  email      6,000 emails × ₹0.0860         −516.08
  WhatsApp    3,000 service × ₹0.134        −402.00
                                            --------
contribution                               2,271.58
  platform infra                            −172.03
                                            --------
operating profit                           2,099.55   =  49.6% of net revenue
```

**Growth, scenario (c)** — 1,200 service + 300 marketing:

```
  WhatsApp  1,200 × ₹0.134   =  160.80
            300 × ₹1.04      =  312.00      −472.80
operating profit                             691.55   =  32.7% of net revenue
```

### What the marketing cap is worth

If template sending shipped *without* `max_whatsapp_marketing` — every WhatsApp
message a marketing template — the same plans model at:

| Plan | Marketing uncapped | With the cap (scenario c) |
|---|---|---|
| Growth | **−18.7%** | +32.7% |
| Business | **−14.6%** | +36.7% |

That 51-point swing on Growth is the entire justification for the column. The
cap is not an optimisation; it is the thing that preserves "an unusual customer
costs you margin, never money" for a feature that does not exist yet.

---

## Break-even

Contribution per Starter at full entitlement is **₹704.65**. Against fixed cost:

| Covering | Fixed / month | Starters needed |
|---|---|---|
| Supabase Pro + Resend Pro | ₹4,300 | 4,300 ÷ 704.65 = 6.10 → **7** |
| + accounting / GST filing | ₹6,301 | 6,301 ÷ 704.65 = 8.94 → **9** |
| + one support hour per customer per month | ₹6,301, contribution ₹404.65 | 6,301 ÷ 404.65 = 15.57 → **16** |

**7–9 paying customers covers infrastructure. 16+ covers infrastructure plus one
hour of human attention per customer per month.**

Below 7, Starter loses money on an allocated basis: at n = 5, platform cost per
customer is ₹860 against ₹705 of contribution.

### Support labour is the whole story on ₹999

```
Starter contribution              ₹704.65
  ÷ ₹300 per hour
                                  = 2.35 hours
```

**A ₹999 customer absorbs about two and a quarter hours of support a month
before contribution reaches zero.** (2.4 hours if their email stays inside the
Resend Pro bucket, which gives ₹719 of contribution.)

That is the sentence to remember. GST and labour are the whole story on Starter:
after GST, gateway and vendor costs you keep about ₹705, and two support calls a
month erase it. **₹999 is viable — but only as a genuinely zero-touch plan.** If
onboarding a Starter takes three hours, Starter is a loss leader and should be
priced or scoped as one deliberately.

Growth absorbs 3.8 hours, Business 7.6. Those are not generous either.

---

## Customer acquisition cost

Free is now 50 records / 50 AI replies / 20 emails.

```
AI       50 replies × ₹0.0932  =  ₹4.66
email    20 emails  × ₹0.0860  =  ₹1.72
records  50 rows                  negligible
                                  -------
cost per free signup              ₹6.38
```

**This is a hard ceiling, enforced by `consume_usage` on the same path as every
paid meter.** A free org cannot exceed it, whatever it does. At 100 signups a
month that is ₹638; at a 10% conversion rate, ₹64 of acquisition cost per paying
customer, repaid in under three days of Starter contribution.

Treat this as the cheapest customer-acquisition line in the business and do not
be tempted to raise the ceiling without re-running this arithmetic — the cost
scales linearly with signups, including fraudulent ones, and nothing else in the
model does.

---

## Abuse

The rate limit is **20 requests per 60 seconds, keyed on org + IP**
(`chat-agent/index.ts:339-352`, `hit_rate_limit`). That is:

```
20/min × 60 × 24 × 30 = 864,000 requests per month from one IP
```

A Starter's entire 1,000-reply allowance drains in **50 minutes** from a single
machine. Direct Groq cost of that:

| Case | Arithmetic | Cost |
|---|---|---|
| Every reply lands on the first attempt | 1,000 × ₹0.0932 | **₹93** |
| A quarter exhaust the full 2×2 chain | 93.18 + 250 × (0.0932 + 2 × 0.0466) | **₹140** |
| Every reply exhausts the chain | 1,000 × ₹0.2796 | ₹280 |

**₹93–140 against ₹847 of net revenue** — 11% to 17% of a Starter's monthly
revenue burned by one abusive IP in under an hour, with the allowance meter
having done its job correctly the whole time. Under the old broken chain (which
fell through to qwen) the same attack cost ₹616–760; removing qwen cut the worst
case by roughly 4×.

**The rate limit has been moved above the database writes.** It previously ran
*after* six writes, so a refused request still inserted a conversation, a user
message, a lead, an activity row and consumed a shared edge-function invocation.
It now sits at `index.ts:339`, before every write
(`index.ts:324-334` records the move).

Still open, and both worth doing before the first paying customer:

1. **A per-org daily burst cap.** The per-minute limit is the wrong shape — it
   throttles speed, not volume, and 864,000/month of headroom on a 1,000-reply
   plan is not a limit in any useful sense. A daily cap at, say, 3× the pro-rata
   daily allowance would make this a non-event.
2. **A hard spend limit on the Groq account.** Every control above is ours and
   can fail; a vendor-side ceiling cannot. `hit_rate_limit`'s error is not
   captured at `index.ts:339` (`const { data: rl }` only), so an RPC failure
   **fails open** — the same bug class that was fixed for `consume_usage` at
   `index.ts:461-465` and is still present here.

---

## Refund exposure

Modelled at zero above, which is optimistic and deliberate — there is no
history to estimate from. Two things make it worth a line:

- The CRM's own refund policy says subscriptions are *"generally non-refundable
  for the current cycle"* (`refund:37`).
- The MNB Research agent's knowledge base advertises a **RESULTS GUARANTEE**
  under which the most recent monthly fee is refunded — on the page where
  payment is taken.

Those contradict. If the guarantee is honoured on 5% of Starters, that is
**₹50 per customer per month**, or 7% of contribution. Resolve the contradiction
before it becomes a number.

---

## Two deadlines

1. **30 September 2026 — 19 days.** Meta requires a **payment method on file**
   or it stops delivering WhatsApp **service** messages from 1 October. This is
   an operational action with a date, not a pricing decision. Nothing in this
   document survives missing it.
2. **1 October 2026.** Service messages become chargeable at ₹0.134. The
   previous version of this document had that, but missed two things:
   - **Utility templates sent inside an open service window also lose their free
     status.** For a CRM whose traffic is replies and reminders, that is the
     largest free bucket disappearing, not a marginal one.
   - There is a new **1,000 free service messages per phone number per month**
     allowance. At one number, that covers **two-thirds of a Growth customer's
     entire 1,500 service entitlement** — worth roughly ₹134/month per number,
     and we are not currently claiming it. Confirm the per-number scope before
     modelling it into a plan; the tables above do not.

---

## Where each limit came from

- **Starter has no WhatsApp.** Still the single line that keeps ₹999 profitable
  under every usage pattern, and the clearest reason to move to Growth.
- **Emails are capped low on Starter (300).** Sending reputation is shared
  across every tenant: one account sending badly hurts everyone's
  deliverability. This limit protects other customers, not us. It also keeps
  Starter well inside the Resend Pro bucket.
- **API is Business-only.** Near-zero marginal cost, high perceived value — the
  right thing to reserve for the tier that pays most.
- **AI replies are generous, but less obviously so than before.** At ₹0.0932 a
  reply, Growth's 5,000 costs **₹466** — 22% of net revenue, not the 8% the old
  ₹0.04 figure implied. This is no longer the feature to be casually liberal
  with; it is the second-largest variable cost after nothing.
- **Business AI stays at 10,000.** At 20,000 and corrected inputs, Business
  models at 27% in scenario (b). Dropping it was right and the corrected numbers
  make the case more strongly than the old ones did.
- **Free is 50 / 50 / 20.** Enough to evaluate the product, capped at ₹6.38.

---

## What would most improve margin, in order

1. **Trim the ~14,600-character system prompt.** It is **81% of input tokens**
   and **56% of the total cost of every single AI reply**. Halving it takes a
   reply from ₹0.0932 to ₹0.0670 — a **28% cut to the largest variable cost in
   the business**, with no plan change, no vendor negotiation and no customer
   impact if done carefully. Nothing else on this list is close.
2. **Use Groq's cached-input pricing.** Cached input bills at **50%**. The
   system prompt is identical on every request, which is the exact shape caching
   is for. On its own: another 28%. **Combined with (1): ₹0.0932 → ₹0.0539, a
   42% reduction** — worth ₹392/month on one Business customer, or **9.3 points
   of net-revenue margin** on Growth and Business at full AI entitlement, and
   4.6 points on Starter.
3. **Cut the history window from 20 messages to 6.** The remaining ~850 input
   tokens are history plus the current message. Most of a support conversation's
   relevant context is in the last few turns, and 20 is a number nobody chose
   deliberately.
4. **Fix the retry loop.** 2 attempts × 2 models is up to 4 billed calls for one
   visible reply, and the reasoning-only failure discards a fully paid response.
   Capping the chain and handling that case in-model is free money.
5. **Claim the 1,000 free service messages per number per month** from 1 October
   — worth ~₹134/month per number, subject to confirming the per-number scope.
6. **Sell overage instead of stopping at the cap.** At the cap the feature stops.
   That is the honest default, but "buy 1,000 more AI replies for ₹299" is
   ~70% margin revenue the model currently leaves on the table entirely.
7. **Add a per-org daily burst cap and a Groq spend limit.** Not margin so much
   as variance: this is the difference between a bad month and an unbounded one.
8. **Raise Growth.** At 45.5% in scenario (b) it is the weakest plan, and it is
   weak because 5,000 AI replies plus 3,000 emails plus 1,500 WhatsApp is a lot
   of entitlement for ₹2,499. Either price it at ₹2,999 or trim the AI
   allowance. Items 1–2 may make this unnecessary.

**Not on this list: the payment gateway.** It is ₹23 on Starter. Cashfree also
waives the platform fee for new merchants up to ₹20 lakh GMV **until 31 March
2027**, so real margins are ~2.3 points better than shown until then. Do not
build the plan around a discount with an expiry date.

---

## Verifying any of this

```sql
select plan, label, price_inr, max_seats, max_leads, max_ai_messages,
       max_emails, max_whatsapp, max_whatsapp_marketing, whatsapp, api_access
  from plan_limits order by position;
```

Model inputs, in the code:

| Input | Where |
|---|---|
| System prompt size (~14,600 chars) | `supabase/functions/chat-agent/index.ts:533` |
| History window (20 messages) | `supabase/functions/chat-agent/index.ts:376` |
| Model chain and retry count | `supabase/functions/chat-agent/index.ts:57-58, 526` |
| Rate limit (20/60s, org+IP) | `supabase/functions/chat-agent/index.ts:339-352` |
| Only WhatsApp sender, `type: "text"` | `supabase/functions/_shared/whatsapp.ts:37-56` |
| `max_whatsapp_marketing` per plan | `supabase/migrations/20260911100000_whatsapp_economics.sql:44-47` |
| Free plan 50 / 50 / 20 | `supabase/migrations/20260911090000_tenant_agent_defaults.sql:299-304` |
| Original margin model (superseded) | `supabase/migrations/20260908090000_pricing_reset.sql` header |

Sources, all checked 11 September 2026 unless noted:
[Groq pricing](https://groq.com/pricing) ·
[Resend pricing](https://resend.com/pricing) ·
[Supabase pricing](https://supabase.com/pricing) ·
[Meta WhatsApp Business pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) ·
[Cashfree charges](https://www.cashfree.com/payment-gateway-charges/) ·
[RBI reference rate](https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx) ·
GST registration threshold: CGST Act s.24 (compulsory registration for
inter-state supply) · WhatsApp marketing rate ₹1.04 carried over from
[WhatsApp API pricing India 2026](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026),
checked 8 September 2026 and **not re-verified** — it is the one input in this
document still resting on the older check, and it only affects scenario (c).
