# Run this next — 24 September 2026

A full-surface build: six parallel audits of every subsystem, then fixes, then
two adversarial review passes over my own work. `FEATURES.md` is the
categorised inventory of everything in the product and its real status.

**Read "Order matters" before running anything.** Two of these migrations are
safe only in the right sequence, and one must be diffed against production
before it is applied at all.

---

## What state everything is in

| | |
|---|---|
| Edge functions | **14 of 14 compile.** Changed but NOT deployed |
| Frontend | `tsc --noEmit` clean. Built but NOT deployed |
| Tests | **10 suites, ~330 assertions, all green** — was 5 suites |
| CI | **was red on every push.** Fixed — see below |
| Migrations | 6 new files written. **None applied** |

I could not deploy or reach the database this session: Chrome is signed into a
Supabase account that does not have this project, and I cannot drive your
terminal. Everything below is verified locally and waiting on you.

---

## 🔴 CI has been red on every push, and it was my fault

Two test files I wrote on 17 September hardcoded an absolute sandbox path.
Two consequences, and the second is worse than the first:

1. On CI the path does not exist, so the suites errored and the `tests` job
   failed on **every push** since. A permanently red build is the same as no
   build — everyone learns to ignore it.
2. On a machine where the path *did* resolve, the suite read the file at that
   fixed location rather than the one in the checkout. It reported PASS about a
   different copy of the repository than the one being built.

Both now resolve from `__dirname`. Proved by copying the tree to a different
path and re-running: all 10 suites pass from anywhere.

Also fixed in `ci.yml`: the test glob was `find supabase`, so a test anywhere
else was silently never run; the Deno step printed "No Deno tests found" and
went **green** when there were none; and it used `--allow-none`, a Deno 1.x
flag, so the first invocation always died and the `||` fallback is what
actually ran. All three now fail loudly.

---

## Order matters

```
1. 20260924100000_sender_identity_columns.sql   ← safe, run first
2. 20260924090000_baseline_predicates.sql       ← DIFF BEFORE RUNNING
3. 20260924093000_job_monitoring_gaps.sql
4. 20260924094000_grant_and_search_path_repair.sql
5. 20260924091000_tenant_isolation_restrictive.sql
6. 20260924092000_lead_dedupe_integrity.sql     ← deploy functions FIRST
```

**#2 must be diffed first.** `my_org()`, `is_super_admin()` and
`is_active_member()` are referenced 157 times across the policies and are
defined in **no migration** — they are dashboard-era objects. That means the
repo cannot rebuild its own database: `supabase db reset` produces one where
every policy raises `42883 function my_org() does not exist`. The migration
captures the live definitions into a table and prints them, so you can compare
before trusting my reconstruction. **Read that output before letting it
replace anything.** Its return types are my assumption, not a fact.

**#6 after the function deploy.** The unique index turns a silent duplicate
into a hard `23505`. `lead-webhook` and `chat-agent` now catch that and treat
it as "someone else just created this person" — but only once deployed. Run it
before, and a racing enquiry is dropped instead of merged. The migration also
refuses to create the index if duplicates already exist, and prints them.

Then deploy:

```bash
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && rm -f .git/index.lock && bash scripts/deploy-all.sh "Full-surface audit: intake, messaging, billing, monitoring, tests"
```

---

## What was found and fixed

### Things that were silently wrong in production

**A blank automation condition matched every lead.** `Number("")` is 0, so
`{field: "score", op: "gt", value: ""}` evaluated as `score > 0` — true for
essentially every record. The builder posts `""` when the value box is left
blank, so a half-finished rule became "match everyone", behind actions like
assign, tag, move stage and notify. On a large tenant that is a mass
reassignment and a mass notification, from a rule that reads as correct on
screen. 16 new assertions; 8 of them fail against the old code.

**`add_tag` destroyed the previous rule's tag.** Two rules tagging the same
lead in one sweep both read the original array: the first wrote
`['vip','hot']`, the second recomputed from `['vip']` and wrote
`['vip','urgent']`. Both reported success.

**A failed alert-settings read reported itself as "alerts disabled".**
`run-actions` only fails a rule on `reason === "error"`, so one broken read
turned every org's new-lead alerts off with every automation still recording
success.

**A failed WhatsApp config read sent from the platform's own number.**
`getWhatsAppConfig` discarded the error and returned `{}` — which is exactly
the shape that resolves to the platform credentials. A transient failure sent
a tenant's message under the platform's verified business name, billed to the
platform's Meta account, and reported `sent: true`.

**`system-health` leaked across tenants.** The org came from `?org=` while the
caller's own org was computed and never used, so any counsellor could read any
tenant's health — credential inventory, intake recency, automation failures —
and `POST {alert:true}` fired Telegram into other tenants' chats.

**`system-health`'s heartbeat was stamped by any browser.** Every dashboard
poll reset `last_run_at`, so the hourly cron could have been failing for weeks
with the board green. That is the eight-day outage shape exactly. **I made this
worse myself** — calling the endpoint from the browser on the 22nd to verify a
deploy wrote a heartbeat and masked the state I was trying to read.

**Intake could destroy stored data.** `lead-webhook`'s pre-read discarded its
error, so on failure `before` was null and both guards inverted: the segment
was overwritten (restarting a mid-sequence lead's follow-up with the wrong
copy) and `custom` was rebuilt from `{}`, wiping every custom field. The merge
that existed to preserve data became the thing that destroyed it.

**The chat agent erased contact details it had already captured.** Contact
fields were written unconditionally from a 20-message window, so once an email
scrolled out of view it was overwritten with `null` — and the dedupe then
missed the lead and created a second record for the same person.

**A partial refund revoked a full year.** A ₹500 goodwill refund on a ₹49,990
annual order removed twelve months of access. And any dispute event revoked,
including ones the merchant *wins* — with no path back, because `granted_at`
stays set.

**Scoring silently drove every score down.** `rescore-leads` read activities
without checking the error, so a failed read made every `engagement_count`
zero and wrote the lower scores — which then drive `score_above` /
`score_below` automations. Both reads were also truncated at 1,000 while
reporting completeness.

**The only public write endpoint had no rate limit and no payload cap.**

### Things that were built but wired to nothing

`FEATURES.md` lists these in full. Completed this session:

- **`rescore-leads`** — complete, authenticated, documented, and called by
  nothing. Scores were written once at intake and never refreshed, though the
  score is defined in terms of engagement and intake proximity, both of which
  drift. Now has a Scoring tab in Settings with preview, resume and honest
  reporting of incomplete runs.
- **`assign_to`** — implemented and unit-tested, absent from the builder. Now
  in the action picker with a member selector.
- **`agent_config.resend_from` / `resend_reply_to`** — columns in the live
  schema read by no code, while Integrations invited admins to paste their own
  Resend key. Now honoured by both send paths, `test_email`, and the UI.
- **`admin_set_member`** — the documented "the only admin left the company"
  recovery path, with no UI. Now in the Platform console.
- **The AI model dropdown** offered two models Groq had shut down, and a pinned
  model goes *first* in the chain, so picking one meant paying a 404 on every
  message. An org already pinned to a dead model now sees it named and flagged
  rather than silently displayed as "platform default".

### Frontend

Five screens rendered confident empty states on failed reads — "No templates
yet", "No members yet", "Nothing logged yet" on a customer record — corrected
only by a toast that vanishes in 3.2 seconds. All now show the error before the
empty state. Plus: a ₹0 MRR figure printed next to real paying customers,
"couldn't check" as a third state on every credential pill, a silent dead
"Copy snippet" button, a lost CSV export, an unguarded `/import` route, and
keyboard access to CSV import.

---

## What the review caught in my own work

I ran two adversarial passes. The first found **10 defects in my fixes**,
including two where my change made things *worse*:

- **`scrubToken` leaked more than the bug it replaced.** My first fix anchored
  on `[^0-9A-Za-z_-]`, which meant a token preceded by a letter — `bot<id>:<tok>`,
  the shape Telegram echoes — stopped matching entirely and printed in full. It
  is now `[^0-9]`. 28 cases verified, 6 new assertions cover exactly the shapes
  that defeated the first attempt.
- **A "fail closed" that didn't.** My chat-agent guard logged the intent, set a
  flag, and then fell straight through and created the duplicate anyway — while
  discarding the one identifier that could have prevented it.
- **A fix that would have stopped working customers.** My `resend_from` guard
  refused to send when a tenant had their own key but no sending address. That
  column is NULL for *every* tenant, so it would have stopped follow-up for all
  of them on deploy, to fix a fault I had not verified. It now warns and sends
  exactly as before.
- **Reconciliation that still let the attack through.** I preferred
  `order_amount` over `payment_amount` — but `order_amount` equals the recorded
  amount by construction in both scenarios the check was written for. It takes
  the minimum now.

The second pass found five more, all fixed: copy still promising a refusal that
had been removed, a "couldn't check" warning shown during normal page load, a
retired model hidden rather than named, a rate limit of 300/min that would burn
a free tenant's entire monthly quota in ten seconds, and an abort reason
discarded before it reached the screen.

I am reporting these because they are the honest answer to "did you check your
own work" — the first pass found real problems, and so did the second.

---

## What I could NOT verify

- **Anything requiring the live database.** No Supabase access this session.
  Every migration reports live state in its verify block rather than assuming
  it; read those outputs.
- **The three legacy predicates** (`my_org` and friends). Reconstructed from
  usage. Diff before applying.
- **Whether a tenant's own Resend key genuinely 403s** against the platform
  domain. Plausible, unverified — which is why nothing refuses to send over it.
- **`deno check`.** Not installed here; I used esbuild, which catches syntax
  and imports but not Deno type errors. CI runs the real check.
- **Nothing was deployed, and no live data was touched.**

---

## Still open, ranked

1. **nandini** — captured 18 September, never contacted, follow-up overdue
   since the 19th. Still the only real new enquiry in a fortnight.
2. **The leftover `audit_sec_…@gmail.com` counsellor account** with live access
   to student records. Your call to disable.
3. **20 of 21 AbroBot students are unassigned** and all are overdue. The
   round-robin machinery exists and is switched off; one automation rule fixes
   it.
4. `chat_messages` has no purge and no archive path — it is the fastest-growing
   table and `purge_archived`'s conversations delete can never match a row.
5. The remaining `FEATURES.md` known gaps: no rate limit on the public REST
   API, no domain allowlist on the widget, no bounce/complaint suppression, no
   per-(campaign,lead) idempotency on bulk sends.
6. **Meta payment method by 30 September.**

---

*Earlier releases follow, oldest last.*

---

# 23 September — what would make this better

## 1. 🔴 A leftover test account has live access to student records

**Team → `audit_sec_1789801652_202348@gmail.com` · counsellor · active ·
joined 3 days ago.** Machine-generated name, epoch decodes to 20 September —
almost certainly residue from an automated security test. It holds
**counsellor** access to real student names, phone numbers and full chat
transcripts. Team → set it to **disabled**, or remove it. Deliberately not done
for you: revoking access is your call.

## 2. 🟠 20 of 21 students belong to nobody

One record out of twenty-one is assigned. Every other student is unowned, in
stage **New**, and overdue. `org_assignment_load()` does least-loaded
round-robin in the database and `assign_round_robin` is an available action —
one rule on *record created* fixes it.

## 3. 🟠 H6 — nurture would email customers who already bought

`pipeline_stages` was read without checking the error, so a refused read left
the won/lost set empty and the send-site guard `if (stop.size)` skipped the
exclusion entirely. Now fails closed.

## 4. 🟡 Measure the capture change in a fortnight

The number to watch is the share of conversations that are a single message —
**97 of 139** before. Conversion once someone sends three messages is already
**14 of 20**.

---

# 22 September — shipped

Commit `90b7820`. Verified live by four independent checks: `/settings?tab=install`
renders Settings rather than "Page not found"; `widget.js` no longer contains
`<a href="$1"`; `system-health` returns an `alarm_status` field that exists only
in the new build; and `system-health` was absent from the old deploy script, so
its new build being live proves the updated script ran.

Archived records no longer appear in the Students list (22 → 21), via a
`RESTRICTIVE` RLS policy — permissive policies are OR-ed, so the correct policy
had been out-voted by an undocumented dashboard one for weeks.

---

# 17 September — the audit fixes

Six agents audited every feature area; 91 confirmed defects in
`AUDIT-2026-09-17.md`. The eight blockers and three lead security findings were
closed: the billing plan-change hole (₹35,001 per exploit through the ordinary
UI), refunds never revoking access, the AI agent reading the *oldest* 20
messages, four onboarding CTAs landing on "Page not found", "Email sent" when
nothing was sent, nurture reporting `ok` while 96% of sends failed, the
webhook reconciler disabling healthy endpoints, the widget XSS, cross-tenant
WhatsApp billing, and an SSRF guard that matched the spelling of an address
rather than its value.
