# AbroBot CRM → multi-industry CRM platform

Plan for turning a study-abroad CRM into a platform any industry can run on,
with per-tenant isolation, self-serve AI chatbot deployment, and an admin panel
that controls everything.

---

## The one thing that decides everything else

**Roughly 70% of what you asked for is frontend work, and the frontend source
does not exist.**

| What you asked for | Where it lives |
|---|---|
| "Industries the user can choose from" | Onboarding UI — **frontend** |
| "Full alterations within the admin panel" | Settings UI — **frontend** |
| "Chatbot deployed in a second" | Installer UI + snippet — **frontend** (engine exists) |
| "Individual plan owners" | Billing + entitlement UI — **frontend** |
| "Seamlessly connect and give data" | Dashboards, reports — **frontend** |
| "No one can use someone else's work" | RLS — **backend, mostly done** |
| Industry packs, pipelines, custom fields | **backend — built today** |

The current UI is a minified bundle. It cannot render a stage that isn't one of
the eight hardcoded study-abroad values, cannot show a custom field, and has no
industry picker. Every backend capability below is invisible until there is a
frontend that can express it.

So this is the decision: **build a new frontend.** Not as a rewrite-everything
big bang — as a new app that runs alongside the live one against the same
database, taking over screen by screen.

---

## Phase 0 — done today (backend, committed)

- `industries` — 14 packs with real, sector-specific pipelines
- `pipeline_stages` — per-org stages, replacing the hardcoded enum
- `field_defs` + `leads.custom` — per-org custom fields with a GIN index
- `apply_industry_pack()` — idempotent onboarding seeder
- Two-way sync trigger so the **old bundle and a new frontend can run
  simultaneously** — the migration path that makes everything else safe
- Lead scoring, Telegram alerts, WhatsApp send/autoreply, nurture toggle fix

Industry packs seeded: Hospital & Clinic, Study Abroad, School & Coaching,
Real Estate, Law Firm, Dental & Aesthetic, Gym & Wellness, Financial Services,
Automotive, Travel, Recruitment, Home Services, B2B/SaaS, General.

Each pack carries its own terminology (a hospital sees "Patients", not
"Leads"), its own funnel, its own fields, and a persona for the AI agent with
sector-appropriate guardrails — the hospital agent refuses clinical advice, the
legal agent refuses opinions on the merits, the finance agent refuses to
guarantee approval.

---

## Phase 1 — tenant isolation ("no one can use someone else's work")

The existing model is sound: `is_super_admin() OR (org_id = my_org() AND
is_active_member())`, applied through 20 policies. New tables follow it, with
configuration writes narrowed to `is_org_admin()` — a counsellor should not be
able to redefine the pipeline.

Still to do:

1. **A tenancy test suite.** Assert, per table, that org A cannot read, update
   or delete org B's rows — executed as a real authenticated user, not as
   service role. Isolation nobody tests is isolation nobody has.
2. **Storage isolation** for the document uploads implied by `leads.docs`.
3. **Close the `agent_config` secret leak** before the first counsellor joins.
4. **Rate limiting** on the public endpoints (`lead-webhook`, `chat-agent`) —
   currently a valid key can be replayed without limit.
5. **Audit log** — who changed what, which is table stakes for hospitals and
   law firms.

---

## Phase 2 — chatbot deployed in a second

The engine already exists and is good: `chat-agent` (Groq, config-driven,
lead capture) plus a 16 KB `widget.js`. What's missing is the *experience*:

1. Pick industry → agent is pre-configured from the pack. Zero blank-page setup.
2. One snippet, copy button:
   `<script src="https://crm.mnbresearch.com/widget.js" data-org="acme"></script>`
3. Live preview beside the settings, updating as you type.
4. "Test it" — talk to your own bot before shipping.
5. Verified-install indicator, so "is it live?" is answerable.

Backend needed: a `widget_installs` table to record first-seen domain and
last ping. Everything else is UI.

---

## Phase 3 — plans and entitlements

`organizations` already carries `plan`, `trial_started_at`, `trial_days`,
`credits_total`, `credits_used`.

Needs a `plan_limits` table (seats, leads, AI messages, WhatsApp sends,
industries) and enforcement in the edge functions — currently nothing checks
credits server-side, so limits are advisory only. **A limit enforced only in
the browser is not a limit**, and this is where revenue leaks.

---

## Phase 4 — the new frontend

React + Vite + TypeScript, running alongside the live app on the same Supabase.

Reuses what was recovered: the exact CSS token set from `index-B9KeoLgM.css`
(amber `--brand: #b45309`, `--radius: 16px`, three shadow tiers), so new screens
are visually indistinguishable from the old ones. Plus Plus Jakarta Sans, the
route list, and the UI copy mined from the bundle.

Order of takeover — highest value and least risk first:

1. **Settings / admin panel** — industry picker, pipeline editor, custom
   fields, agent config with live preview, widget installer. This is where
   "full alterations within the admin panel" actually lands.
2. **Leads list + lead page** — dynamic columns from `field_defs`, dynamic
   stages from `pipeline_stages`, industry terminology throughout.
3. **Pipeline board** — drag between per-org stages.
4. **Dashboards and reports** — the "seamlessly give data" piece.
5. Everything else, as it gets touched.

Throughout, the old bundle keeps serving any route not yet taken over. The
stage-sync trigger is what makes that safe.

---

## What "revolutionise with simplicity" should mean here

Concretely, three things, in priority order:

1. **Ninety-second onboarding.** Pick industry → pipeline, fields and AI agent
   are configured → copy one snippet → a real lead arrives. No blank slate.
2. **One screen per job.** The current app has 19 routes; several are
   near-duplicates (`/priority`, `/myday`, `/leads` all answer "what do I do
   now?"). Fewer, sharper screens beats more features.
3. **The CRM tells you what to do next**, rather than being a filing cabinet
   you must interrogate. Scoring is built; next is a single ranked "today"
   view driven by score, follow-up date and stage age.

The instinct to add features to every industry is the one I'd push back on.
A hospital does not want a CRM with real-estate fields hidden in a menu — it
wants a CRM that looks like it was built for hospitals. That's exactly what
industry packs do, and why they were the right first build.
