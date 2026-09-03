# Pre-launch audit — 1 Sep 2026

Six deep reviews: database security, edge-function security, silent failures,
business-logic correctness, reliability/operations, frontend quality, schema at
scale, and product gaps. Everything below is grounded in code that was read or
behaviour that was observed.

---

# STOP — do this before you read the rest

**Every fix from this entire session is uncommitted.** `git log` HEAD is
`7953779`, dated 27 August. Working tree: **15 modified files, 13 untracked** —
including `20260821080000_enforce_plan_limits.sql` and
`20260901090000_security_hardening.sql`, two migrations that define your live
database's security posture.

This repo has already lost its entire frontend source once. It is one `rm -rf`
from doing it again, and this time the migrations go with it.

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app
git add -A
git commit -m "Security hardening, stage-key intake fix, error boundary, widget guards"
git push
```

I could not do this for you — my sandbox can create but not remove files in
`.git`, which is the lock-file problem that has blocked git all session.

---

# Fixed in this pass

| # | Fix | Why it mattered |
|---|---|---|
| 1 | **Inbound leads now land in the org's real first stage** | 11 of 13 industry packs have no stage keyed `new`, but both intake paths defaulted to it — so every widget and webhook lead was **invisible on the Pipeline board** for hospitals, clinics, law firms, gyms, agencies. Live at 21 records. |
| 2 | **Widget refuses to guess a tenant** | `document.currentScript` is null under Google Tag Manager, Shopify and most site builders — and the fallback was the literal string `"abrobot"`. A hospital installing via GTM got AbroBot's agent, AbroBot's knowledge base, and their visitors filed into **AbroBot's CRM**. |
| 3 | **Widget double-load guard** | The `built` flag was a closure variable, so a second script tag built a second widget with its own chat session. |
| 4 | **Widget renders even if config hangs** | `boot()` was reachable only from `.then`/`.catch`. A promise that never settles — cold start, captive-portal wifi — meant **no chat button at all, forever**, silently. |
| 5 | **ErrorBoundary + `initTheme` guard** | Any render throw was a permanent white screen. `initTheme` runs *before* React and throws in Safari Lockdown Mode, so it could blank the page before the boundary could catch anything. |
| 6 | **`build.target: es2017`** | The shipped bundle used native `??=`. Android WebView ≤ Chrome 84 — normal on Android 7/8 and cheap clinic tablets — hit a **SyntaxError at parse time**: blank page, before any of our code ran. |
| 7 | **`sourcemap: "hidden"`** | 3.7 MB of maps were being served publicly. Your complete commented TypeScript, including every incident post-mortem, was downloadable from `crm.mnbresearch.com`. |
| 8 | **Calendar day bucketing** | `toISOString()` gives a **UTC** day; the grid cells are local midnights. In IST every follow-up showed **one day late**, "today" highlighted tomorrow, and the day list ran 05:30→05:29. On the screen whose entire job is "who am I calling today". |
| 9 | **Calendar date guard** | A malformed `next_follow_up_at` threw `RangeError` inside a `useMemo` and took the whole app down. |

Plus, earlier in the session: the `<think>` chain-of-thought leak, the
`app-signup` enum bug discarding every signup, six silent failures, and the
plan-limit enforcement suite.

**All verified:** frontend typechecks, six edge functions pass `deno check`, 14
SQL files parse, widget XSS tests pass (zero tags emitted for every injection
attempt), `stripReasoning` passes, and the three widget install scenarios behave
correctly.

---

# Critical — not yet fixed

## C1. Pay once, keep the plan forever
`grant_plan_from_payment` is world-callable via PostgREST and not idempotent —
each call adds another month. Pay ₹999, loop it, own the plan for a decade.
**Fixed in `20260901090000_security_hardening.sql`, which is not applied.**

## C2. Self-serve signup fails 100% of the time
`guard_profile_changes` blocks the `org_id` change that `create_organisation`
must make, and `SECURITY DEFINER` does not change `auth.uid()`. Anyone signing
up today is stuck. **Same unapplied migration.**

## C3. `organizations.slug` has no unique constraint
`create_organisation` uses check-then-insert to find a free slug — a textbook
race. Two people signing up as "Acme" at the same moment both get `acme`, and
then **both organisations' chat widgets return "multiple rows returned"
forever**. Needs two concurrent signups, not scale.

```sql
alter table public.organizations add constraint organizations_slug_uniq unique (slug);
```

## C4. Four unauthenticated endpoints take the target org from the request body
`run-automations`, `nurture`, `system-health`, `summarize-chats` are all
`--no-verify-jwt`.

- `POST {"dry_run":true}` with no org → **lead names and rule names for every
  tenant**.
- `POST {"org":"victim"}` to `nurture` → emails 200 of another tenant's leads
  from your domain and advances their `nurture_step`.
- `summarize-chats` doesn't dedupe `conversation_ids` — one request with the
  same id 150 times buys 19 Groq completions. Loop it and the widget dies **on
  every customer's site simultaneously**, because the Groq key is shared.

A shared cron-secret header is ~10 lines across four files.

## C5. There are no backups
Supabase free tier has no PITR and no restorable backups. No `pg_dump` cron, no
soft-delete anywhere, and `payments.org_id` is `ON DELETE CASCADE` — so deleting
an organisation **destroys its financial records**, the ones you need for a
chargeback.

The recovery story for a customer mass-delete, a bad migration, or a corrupted
org is currently: *there is none.*

---

# High

**`send-campaign` is an open mail relay.** `test_to` sends attacker-controlled
HTML with an attacker-controlled subject to **any address on the internet**,
from your verified domain, by any active member of any org, unrated-limited.
That makes domain blocklisting an attack rather than an accident.

**`send-campaign` never checks `role`** — it selects it and drops it. Any
counsellor on a trial can mass-mail 2,000 leads.

**`app-signup` fails open** when `APP_WEBHOOK_SECRET` is unset, which is the
deployment default.

**Cron failures are completely invisible.** `pg_cron` records that
`select call_edge_function(...)` succeeded — which it does the instant `pg_net`
queues the request. The HTTP result goes to `net._http_response`, which nothing
reads and which self-purges in ~6 hours. *A nightly job could fail for a month
with zero signal.* Rotating the Supabase publishable key silently kills all
three jobs, because it's hardcoded in `call_edge_function`.

**Nothing would tell you lead intake stopped.** `checkIntake` warns after
**14 days** of zero leads, and warnings never alert. Mean time to notice: a
customer phones you.

**`system-health` alerts go to the customer, not to you.** They route through
that org's own `agent_config.telegram_chat_id` — so a customer who never
configured Telegram means **you are never told their system is down**, and one
who did receives a raw internal security finding.

**`system-health` samples without `ORDER BY`** — it reads the *oldest* 200
replies, so during an outage it reports green. That is precisely the failure it
was built to catch.

**Two of six automation triggers can never fire.** `stage_changed` is in the UI
and nothing dispatches it. And `chat-agent` never calls
`fireEventAutomations` — so round-robin **doesn't apply to leads from your own
widget**, the product's stated differentiator.

**Lead score is capped at 37/100 for 12 of 13 industries.** `score.ts` only
reads study-abroad columns; every other pack's data is in `custom`, which it
never touches. Every lead in a dental or hospital org is permanently grey
"cold", and `ScoreChip` renders "37/100".

**`nurture` is hardcoded to `slug = "abrobot"`** with hardcoded study-abroad
copy, while every other customer's Settings shows the toggle enabled.

**Three server paths still read the legacy `stage` enum**, which freezes at
`'new'` forever for non-study-abroad orgs. Consequence: `nurture` emails
**every lead in the org indefinitely, including discharged patients**;
round-robin counts closed leads as open; campaign segmentation is impossible.

**Dashboards start lying at 2,000 leads.** `useLeads` reads 2,000 and every KPI,
funnel, chart and CSV export is computed in JS over that slice. You sell 50,000.
The `truncated` flag exists and **no screen reads it**. A customer with 12,000
records sees "2,000 leads" and an export that silently drops 10,000 rows.

**`run-automations` reads `limit(5000)` with no `ORDER BY`** — at plan scale
your automation engine covers a random 10% of an org's data.

**A 1-month plan purchase converts an entire annual term.** Buy Growth annual
(₹24,990), then Business for one month (₹4,999) → 13 months of Business for
₹29,989 against a ₹64,987 list price. Available to anyone who notices.

**Deleting a pipeline stage silently hides every lead in it.** No confirmation,
no FK, and `Pipeline.tsx` drops leads whose `stage_key` has no column.

---

# Accessibility — blocks hospital and law-firm procurement

- **Zero `htmlFor` across 51 labels.** The Add Lead dialog reads as "edit,
  blank" ×3. Fails WCAG 1.3.1 and 3.3.2 — the two lines most often cited on a
  VPAT.
- **Table and board rows are not keyboard-reachable.** A keyboard-only user
  cannot open a lead from the leads list at all.
- **Modal has no focus trap, no restore, no `role="dialog"`.** Zero `role=`
  attributes in the entire codebase.
- **Seven contrast failures**, including "Overdue" badges at 3.1:1 and white on
  the primary button's amber gradient end at 2.2:1.
- **Toasts are not announced** — every success and error message is silent to a
  screen reader.

---

# What to do, in order

1. **`git commit && git push`.** Everything else is downstream of this.
2. **Upgrade Supabase to Pro** and add a nightly `pg_dump` off-platform. One
   month of one Business customer covers it, and it fixes three of the top five
   3am scenarios in a single purchase.
3. **Apply `20260901090000_security_hardening.sql`** (C1, C2) and add the slug
   unique constraint (C3).
4. **Add a cron-secret header** to the four unauthenticated functions (C4), and
   make `send-campaign`'s `test_to` equal the caller's own email.
5. **Run `scripts/deploy-all.sh`** to ship everything fixed above.
6. **Add an operator alert channel** and turn `checkIntake` into a real
   volume-drop check. Add a cron heartbeat table.
7. **Render the `truncated` flag** as a visible banner — today, as a stopgap.
   It converts silent wrongness into an honest limitation.
8. **Add a GitHub Action** running `tsc --noEmit` + the three existing test
   files. There is no CI at all right now.
9. Then: the `htmlFor` pass, indexes, soft-delete, and "send from the lead
   record" — which remains the biggest product gap, since `whatsapp-send` and
   `send-campaign` are fully built with **no UI calling either**.

---

# Still unverified

**Tenant isolation has never been tested with two real organisations.** It is
the single most valuable outstanding test, and the Supabase dashboard dropped
the project session every time I tried today.

**Four tables' RLS policies exist only in the database, in no migration:**
`organizations`, `profiles`, `webhook_keys`, and DELETE on `leads`. Until you
run the `pg_policy` query at the bottom of the hardening migration, you cannot
answer *"can a customer set their own plan to enterprise, or delete all their
leads?"*

Also worth checking: whether `leads.assigned_to` is `ON DELETE CASCADE`. If it
is, **removing a departed employee deletes their entire book of business.**
