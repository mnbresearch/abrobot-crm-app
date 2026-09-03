# Everything outstanding — one command

```
bash scripts/deploy-all.sh
```

Run it, don't paste it. It stops at the first failure rather than
half-deploying, and it is safe to re-run.

---

## What it ships

| Fix | Where | Why it matters |
|---|---|---|
| Strip `<think>` chain-of-thought | `chat-agent` | Visitors on abrobot.ai were seeing the model deliberate about them. Measured 2 of 4 replies; your own `system-health` reports 22% of replies failing. |
| `source: "app"` → `"other"` | `app-signup` | `"app"` is not a `lead_source` enum value, so **every signup failed with 22P02 and was discarded** while the endpoint returned `ok: true`. |
| WhatsApp plan gate | `whatsapp-send` | Your headline Growth feature was usable free on a ₹999 Starter plan. |
| WhatsApp autoreply gate | `lead-webhook` | Closes the back door around the same paid feature. |
| Markdown rendering | `widget.js` | `**bold**` showed as literal asterisks on all three live sites. |
| Count queries → plain GETs | `SetupChecklist.tsx` | Four `HEAD`+count requests 503'd on every dashboard load. |

Already applied to the database earlier: plan-limit enforcement and expiry
(17/17 checks passed), self-serve signup, function grants tightened, and the
MNB Research organisation.

---

## Verification

Every fix was tested before being written into the deploy:

- Frontend typecheck: **pass**
- `deno check` on `app-signup`, `whatsapp-send`, `lead-webhook`: **pass**
  (`chat-agent` has pre-existing npm type-resolution noise — 15 errors before
  my changes, 13 after; none point at the new code)
- `stripReasoning` — 7 cases including unclosed openers and orphan closers:
  **pass**
- `widget.js` markdown + XSS — for every injection attempt the output contains
  **zero** HTML tags; the only tags it can emit are `<strong>` and a
  well-formed `https://` anchor: **pass**
- All three SQL scripts parse: **pass**

Two caveats worth stating plainly. My first XSS check reported a failure
twice — both times the regex was matching *escaped* text (`&lt;script&gt;`,
`onerror=` sitting inside an escaped string) rather than a real tag. The code
was right; the test was wrong. The version above checks which tags are actually
emitted, which is the question that matters.

---

## The one thing the script cannot fix

`chat-agent` deploys with `--no-verify-jwt`, `lead-webhook` and `app-signup`
too. **Those flags are load-bearing.** All three are called by parties with no
Supabase JWT — a browser widget, third-party webhooks, and app.abrobot.ai.
Deploying any of them without the flag turns verification on and silently kills
lead intake.

`whatsapp-send` deliberately keeps verification **on**. That check is what
stops another organisation sending WhatsApp messages billed to your account.

---

## After it runs

1. **abrobot.ai** — ask "which universities suit a 7.0 IELTS?" three or four
   times. No `<think>` block should ever appear, and bold should render as bold.
2. **mnbresearch.com** — swap the Chatbase script for the one line in
   `MNB-RESEARCH-SETUP.md`. Until you do, that site's chat still belongs to
   Chatbase and nothing reaches your CRM.
3. **Pricing page** — the two copy edits in `MNB-RESEARCH-SETUP.md`. The
   "No per-seat billing — adding your ninth user does not change the invoice"
   promise is now false for AbroBot CRM specifically.

---

## Still open, and not a code fix

**Your Supabase project is on the FREE plan.** Production CRM, four businesses'
live lead intake, payment webhooks, no SLA, and projects that pause after
inactivity. It is also a plausible cause of the 503s — I could not confirm
that, because the anon key is not extractable from the page and I could not
reproduce the failure outside the app. The checklist no longer depends on those
queries either way, but the underlying question is worth settling.
