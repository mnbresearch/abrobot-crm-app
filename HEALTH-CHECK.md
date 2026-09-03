# Full app health check — 1 Sep 2026

Walked the live CRM end to end, tested every widget, and exercised the new MNB
Research agent against the database.

---

## Working

**The CRM app — all 12 routes, zero console errors.**
Dashboard, Students, Pipeline, Calendar, Conversations, Templates, Automations,
Reports, Activity, Team, Import, Settings. Every Supabase REST call returned
200 except the four noted below. Dashboard KPIs render real values (16 active,
1 due today, 15 overdue), so the `AnimatedNumber` StrictMode fix is holding —
that was the bug that used to leave every KPI stuck at 0.

**Multi-tenancy, proven in production.** Three sites, three orgs, three
personas, correct attribution, no bleed.

**MNB Research is live and correct.** Config endpoint returns the right brand,
colour and chips. Four test questions:

| Question | Result |
|---|---|
| What does an AI engagement cost? | ₹9,999 assessment first, credited back, then correct bands |
| How much is AbroBot CRM? | ₹999 / ₹2,499 / ₹4,999 with seat counts — **not** the website's ₹1,499 |
| Do my company's tax filing? | Declined, offered TaxSense AI walkthrough |
| How long until ROI? | Refused to give a number, pointed at the assessment |

Both guardrails held. The knowledge base override worked — the agent gives the
correct CRM pricing even though the website still says ₹1,499.

**Plan enforcement** — 17/17 checks passed earlier today.

---

## Problems found

### 1. AbroBot leaks the model's chain-of-thought to visitors

Reasoning models emit their scratchpad in `<think>` tags and Groq passes it
through in `message.content`. Nothing stripped it.

I measured **2 of 4** replies to an ordinary question ("which universities suit
a 7.0 IELTS?") starting with a visible `<think>Here's a thinking process:...`
block. Your own `system-health` endpoint independently reports
**"2 of 9 replies (22%) failed"** — same defect, already being detected and
apparently not acted on.

This is on abrobot.ai, your busiest site — 68 chats, active daily.

**Fixed in code, NOT deployed.** `stripReasoning()` in `chat-agent`, handling
three shapes: closed blocks, an opener that never closes (ran out of tokens
mid-thought), and an orphan closer. An all-scratchpad reply now strips to empty
and falls through to the next model in the chain rather than printing reasoning
— the retry logic was already there, it just needed to be told this counts as a
failure. Seven unit tests pass against the real function.

### 2. Four count queries return 503 on every dashboard load

```
HEAD /rest/v1/leads?select=id&org_id=eq...              503
HEAD /rest/v1/profiles?select=id&...&status=eq.active   503
HEAD /rest/v1/automations?select=id&...&enabled=eq.true 503
HEAD /rest/v1/message_templates?select=id&org_id=eq...  503
```

All four come from `SetupChecklist.tsx`, which fires five queries in one
`Promise.all`. The plain GETs alongside them return 200 — only the
`{ count: 'exact', head: true }` ones fail. Reproduced across repeated reloads.

**I have not established the cause.** I could not reproduce it outside the app
because the anon key is not extractable from the page. Two candidates I could
not distinguish: free-tier connection limits under five parallel queries, or a
PostgREST quirk on HEAD+count. I am not going to assert one without evidence.

**The visible symptom is mild but the pattern is not.** `(leads.count ?? 0) > 0`
turns a 503 into "you have not done this step", so the checklist silently
under-reports setup progress and no error is ever surfaced. This is the same
swallow-the-error pattern found four times before in this codebase.

### 3. The Supabase project is on the FREE plan

The dashboard badge reads **FREE**, not Pro. You are running a production CRM
with paying customers, live lead intake for four businesses, and payment
webhooks on a free-tier project: no SLA, low connection limits, and projects
that pause after inactivity.

This also corrects `PRICING.md`, which assumed ~₹3,960/month of fixed infra on
Supabase Pro. Your real fixed cost is lower, so margins are *better* than I
reported — but the risk is materially higher, and it is a plausible contributor
to problem 2.

Worth pricing Pro against what an outage during a customer's lead intake costs.

### 4. Still undeployed from earlier today

- `widget.js` markdown fix — `**bold**` still renders as literal asterisks on
  all three live sites.
- `chat-agent` with the `<think>` fix (problem 1).
- `app-signup` — still discarding every signup with the `source: "app"` enum
  error.
- `whatsapp-send` and `lead-webhook` plan gates.

The Supabase dashboard's function editor loaded for `chat-agent` once this
morning and has refused since — "Deploy status unavailable" indefinitely, on
every function I tried. CLI commands are in `DEPLOY-REMAINING.md`.

---

## Honest summary

The app itself is in good shape: every screen works, no console errors, the
data layer is sound, multi-tenancy is proven, and the new MNB Research agent
answers accurately with working guardrails.

The problems are all at the edges — one visible quality bug on your busiest
site, one silent-failure pattern, one infrastructure choice, and a deploy queue
that has not drained. Nothing here is architectural, and nothing is losing data.

The one I would act on today is the `<think>` leak, because it is visible to
customers on abrobot.ai right now and your own monitoring has been flagging it.
