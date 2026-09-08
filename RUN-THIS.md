# Run this — 8 September 2026

> **Status: steps 1–4 completed 8 September 2026.** Every check passed. Kept as
> the record of what was applied and in what order; step 5 is the part that
> remains.


Everything outstanding, in order. Steps 1–4 take about ten minutes. Step 5 is
the one that matters and only you can do it.

Two places to work:

- **Terminal** — the Terminal app on your Mac
- **SQL** — Supabase → your CRM project → SQL Editor

---

## Step 1 — SQL: pricing reset

Open `supabase/migrations/20260908090000_pricing_reset.sql`, paste the whole
file, Run.

Removes the free trial, makes ₹999 Starter the front door, and caps WhatsApp —
which was a boolean with no volume limit, so Growth and Business could cost more
than they earned.

**Expect:** 9 rows, all PASS. Also read the **notices** — if any organisation was
sitting on `trial` it names them, and they are now read-only. To switch one back
on:

```sql
select public.admin_set_plan(
  (select id from organizations where slug = 'YOUR-SLUG'),
  'starter', 12, 'my own organisation');
```

*(That function only exists after step 2. Until then: `update organizations set
plan = 'starter' where slug = 'YOUR-SLUG';`)*

---

## Step 2 — SQL: super admin

Open `supabase/migrations/20260908100000_super_admin.sql`, paste, Run.

You could not previously list organisations or change a plan through the app at
all — every plan change was an `UPDATE` typed by hand, with no record of who did
it. This fixes the reach, adds the operations, and starts an audit trail.

**Expect:** 8 rows, all PASS.

---

## Step 2b — SQL: delete guards

Open `supabase/migrations/20260908110000_delete_guards.sql`, paste, Run.

Removes the API-level DELETE path on organisations (`org_super_all` was
`FOR ALL`, so the platform owner could delete a tenant over PostgREST — one
stray request from destroying 19 tables), and stops `payments` and
`subscriptions` cascading, because tax rules require retaining them whether or
not the customer still exists.

**Expect:** 3 PASS and a count — "17 tables" still cascade, which is 19 minus
those two.

---

## Step 3 — SQL: check the reach

Open `scripts/superadmin-audit.sql`, paste, Run.

Reads the live policies rather than the migration files. Prints a table-by-table
read/insert/update/delete grid, then the admin functions, then **who holds the
super_admin role** — that list should be very short, because each of those
accounts can read every customer's data.

**Expect:** no row with a **GAP** note.

The editor shows only the last result set, so if you want the grid specifically,
run just the first `with rls as (…) select …` block on its own.

---

## Step 4 — Terminal: deploy and commit

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/deploy-all.sh
```

Deploys all ten edge functions, rebuilds the frontend, then asks the platform
which functions are actually live. **Expect:** ten `live` lines, no `MISSING`.

Then:

```
cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && rm -f .git/index.lock && git add -A && git commit -m "Pricing reset, WhatsApp metering, platform admin console" && git push
```

`rm -f .git/index.lock` is harmless — it clears a leftover lock. If git says
*"nothing to commit"*, the deploy script already committed; just `git push`.

---

## Step 5 — Browser: actually use it

**This is the only remaining risk.** Everything above is verified by things I
ran; none of it has been touched by a human. Twenty minutes at
`crm.mnbresearch.com`:

| Where | Do | Expect |
|---|---|---|
| **Platform** (new, sidebar) | Open it | Every org, plan, usage, renewal date |
| Platform | Change one org's plan, give a reason | Appears in the audit log below |
| Settings → Plan & usage | Look | **Emails sent** and **WhatsApp messages** meters; API pill |
| Templates | Open one → **✉️ Send** → test to yourself | Arrives, your brand in the From |
| Templates | **Check how many** | A count *and* remaining allowance |
| A record | **✉️ Email** | Arrives; logged in the record's history |
| A record | **🗄 Archive** → **Archived** → **Restore** | Gone, then back with its history |
| Reports | **⬇ Export CSV**, open in Excel | `custom.*` columns; names not mojibake |
| Dashboard | "Work on these next" | "in 2d" / "tomorrow", **not** "just now" |
| Integrations | On a non-Business plan | API keys replaced by an upgrade card |

**Also worth doing once:** sign up a throwaway account. With the trial gone it
lands read-only, and I have never watched that happen. It should explain itself
and nothing should hard-fail.

Anything misbehaves — tell me what you clicked and what happened.

---

## Later, not now

- **`scripts/api-isolation-test.sh`** (Terminal) — needs an API key from two
  different orgs. Run it when you have a second customer.
- **1 October: Meta starts charging for WhatsApp *service* messages.** Three
  weeks away. The caps already assume it; your cost per customer steps up
  regardless.
- **The 61% Growth margin assumes ~80% service / 20% marketing WhatsApp.** That
  is a judgement about how customers will behave, not a measurement. Watch the
  real mix in the Platform screen once you have traffic.

---

## Reference

| File | What |
|---|---|
| `RUN-THIS.md` | this |
| `PRICING.md` | the plans, unit costs and margin model |
| `LAUNCH-READINESS.md` | 26 defects fixed, with what each would have done |
| `INTEGRATION-STATUS.md` | integrations: what is real, what is not |
| `scripts/verify-all.sql` | 18 schema checks |
| `scripts/tenant-isolation-test.sql` | 16 isolation checks |
| `scripts/superadmin-audit.sql` | who can reach what |
| `scripts/api-isolation-test.sh` | API-key isolation |
