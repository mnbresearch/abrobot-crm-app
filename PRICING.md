# Pricing — and why the limits are what they are

Updated 8 September 2026. There is no free trial. **₹999 Starter is the front
door**: sign up free, set everything up, pay to switch it on.

| | Starter | Growth | Business | Enterprise |
|---|---|---|---|---|
| **Price / month** | **₹999** | ₹2,499 | ₹4,999 | Custom |
| Users | 3 | 10 | 30 | Unlimited |
| Records | 1,000 | 10,000 | 50,000 | Unlimited |
| AI replies / mo | 1,000 | 5,000 | 10,000 | Unlimited |
| Emails / mo | 300 | 3,000 | 6,000 | Unlimited |
| **WhatsApp / mo** | — | **1,500** | **3,000** | Unlimited |
| Automations | 3 | 25 | 100 | Unlimited |
| **REST API + webhooks** | — | — | **✓** | ✓ |

Before paying, an organisation sits on `free`: read-only. They can configure
the pipeline, fields and AI agent and look at everything. Capture, AI, email
and WhatsApp are off. Nothing they set up is lost when they pay.

---

## The hole this closed

`plan_limits.whatsapp` was a **boolean**. Growth and Business granted WhatsApp
with no volume cap and nothing metered it.

Meta bills per message in India, and a **marketing template costs about seven
times a service one** — ₹1.04 against ₹0.15, both including GST. So:

- **2,407 marketing messages consumed an entire ₹2,499 Growth subscription.**
  Every message after that was a loss, and nothing in the system noticed.
- Modelled at the old limits, Business came out at **−39% margin**.

One enthusiastic customer could cost more than they paid. `max_whatsapp` now
exists, is metered through the same `consume_usage` path as AI replies and
email, and both the manual send and the unattended autoreply respect it.

---

## Unit costs (September 2026, INR, incl. 18% GST)

| Item | Cost | Source |
|---|---|---|
| AI reply (Groq `gpt-oss-120b`, ~1,200 in / 350 out) | ₹0.040 | $0.15/M in, $0.60/M out |
| Email (Resend) | ₹0.042 | $20 per 50,000 |
| WhatsApp service/utility template | ₹0.15 | Meta India ₹0.13 |
| WhatsApp **marketing** template | ₹1.04 | Meta India ₹0.88 |
| Payment gateway | 2.30% of price | Cashfree 1.95% + GST |
| Supabase Pro | ₹2,200/mo total | shared across all customers |

Two things that change soon and are worth watching:

- **From 1 October 2026 Meta charges for _service_ messages too**, at the
  utility rate. Inbound-reply traffic stops being free. The caps above already
  assume it.
- India moved to local-currency billing in January 2026 and the marketing rate
  rose about 10%. Expect that to continue.

---

## Margins

Computed, not estimated — the model is in the migration header and reproducible.
Assumes 25 paying customers sharing Supabase Pro.

| Plan | Realistic | Worst case | Best case |
|---|---|---|---|
| Starter ₹999 | **84%** | 84% | 84% |
| Growth ₹2,499 | **61%** | 19% | 72% |
| Business ₹4,999 | **63%** | 21% | 74% |

**Realistic** = 80% service/utility WhatsApp, 20% marketing. That is the mix a
CRM produces: most traffic here is replies and reminders, not campaigns.

**Worst case** = every WhatsApp message a marketing template. The point of the
cap is that this case is never negative. An unusual customer costs you margin,
never money.

Starter carries no WhatsApp at all, which is why it holds 84% whatever happens
— and why it can be the cheap way in without being the loss leader.

Margins improve with scale: the only fixed cost is Supabase Pro, so at 100
customers Starter is 90%.

---

## Where each limit came from

- **Starter has no WhatsApp.** Not a downsell — it is the single line that keeps
  a ₹999 plan profitable under every usage pattern. It is also the clearest
  reason to move to Growth.
- **Emails are capped low on Starter (300).** Sending reputation is shared
  across every tenant: one account sending badly hurts everyone else's
  deliverability. This is the limit that protects other customers, not us.
- **API is Business-only.** It costs almost nothing to serve, which makes it
  the right thing to reserve for the tier that pays most — high perceived
  value, near-zero marginal cost.
- **AI replies are generous** because they are genuinely cheap (₹0.04). 5,000
  replies costs ₹202. This is the feature to be liberal with.
- **Business AI dropped from 20,000 to 10,000.** At 20,000 the plan modelled at
  53% even before WhatsApp. Nobody was using 20,000, and it was never
  advertised as unlimited.

---

## Things to revisit

1. **The gateway is free until 31 March 2027.** Cashfree waives the platform
   fee for new merchants up to ₹20 lakh GMV. The margins above ignore that, so
   real margins are ~2.3 points better until it ends — do not build the plan
   around a discount with an expiry date.
2. **Marketing templates should probably be an add-on.** Right now a customer
   can spend their whole WhatsApp allowance on marketing at 7× the cost. The
   cap makes that survivable, not optimal. Metering by *category* would let
   Growth include 1,500 utility and sell marketing separately.
3. **Nothing charges for overage.** At the cap the feature stops. That is the
   honest default, but "buy 1,000 more" is money left on the table.
4. **Supabase Pro is still not on.** These numbers assume ₹2,200/mo for it.
   On the free tier the margins are better and the risk is a paused project.

---

## Verifying any of this

```sql
select plan, label, price_inr, max_seats, max_leads, max_ai_messages,
       max_emails, max_whatsapp, whatsapp, api_access
  from plan_limits order by position;
```

The margin model lives in the header of
`supabase/migrations/20260908090000_pricing_reset.sql`, with every input named
so the arithmetic can be re-run when Meta or Groq change their rates.

Sources: [Meta WhatsApp Business pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [WhatsApp API pricing India 2026](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026) · [Groq pricing](https://www.cloudzero.com/blog/groq-pricing/) · [Cashfree charges](https://www.cashfree.com/payment-gateway-charges/)
