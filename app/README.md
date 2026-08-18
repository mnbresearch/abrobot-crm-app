# AbroBot CRM — v2 frontend

React + Vite + TypeScript. Runs **alongside** the legacy minified bundle
against the same Supabase project, so routes can be taken over one at a time
instead of in a big-bang cutover.

## Run it

```bash
cd app
npm install
npm run dev
```

Then open http://localhost:5173

> Paste those lines one at a time. Do **not** append a `# comment` to
> `npm run dev` — npm forwards it to vite as an argument, vite treats it as the
> project root, and you get a stray `app/#` directory and an empty page.

Optional `.env.local` (defaults point at the live project):

```
VITE_SUPABASE_URL=https://pomsltnrxvbcafwtbtlc.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

```bash
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + production build
```

## Prerequisite

Apply `supabase/migrations/20260817090000_multi_industry_foundation.sql` first.
Without it there is no `industries`, `pipeline_stages` or `field_defs` table
and the app will show an empty pipeline.

## How industries work

Two halves, deliberately split:

| Layer | Owns | Why |
|---|---|---|
| Database (`industries`, `pipeline_stages`, `field_defs`) | stages, custom fields, terminology, agent persona | per-tenant and editable at runtime |
| `src/lib/industries.ts` | dashboard KPIs, quick actions, list columns, which tool shows | code, ships with the app |

Adding an industry = one row in the `industries` seed + one entry in the
registry. No new screens.

Picking an industry calls `apply_industry_pack()`, which seeds stages, fields
and the agent persona in a single atomic, authorisation-checked call.

## What changes per industry

- **Terminology** — a hospital sees "Patients", a law firm "Clients", a
  recruiter "Candidates". Sidebar, buttons and headings all follow.
- **Dashboard KPIs** — a hospital tracks *Currently Admitted*; a recruiter
  tracks *Offers Out*; real estate tracks *Pipeline Value*.
- **Pipeline** — genuinely different funnels, not renamed steps.
- **Quick actions** — "Book appointment" vs "Schedule site visit" vs
  "Submit to client".
- **Accent colour** — one CSS variable (`--industry`) re-themes the shell.
- **A sector tool** — EMI calculator, affordability check, triage bands,
  CTC comparison, trip costing, course ROI, quote builder.

## Structure

```
src/
  lib/
    industries.ts   industry UI registry + KPI computation
    tools.ts        pure sector calculators (testable, reusable server-side)
    store.tsx       auth + org + stages + fields context
    router.ts       popstate router (same model as the legacy app)
    supabase.ts     client + edge function helper
    types.ts        mirrors the live schema
  components/
    ui.tsx          primitives, dynamic field renderer
    IndustryTool.tsx  the sector calculators as UI
  routes/
    Login, Onboarding, Dashboard, Leads, LeadDetail, Pipeline, Settings
```

## Notes

- **Sourcemaps are on in production.** This whole rebuild exists because the
  original source was lost and no maps were ever emitted. Never turn this off.
- **Styling is plain CSS with custom properties**, matching the legacy app —
  not Tailwind. The tokens in `styles/tokens.css` are recovered verbatim from
  `index-B9KeoLgM.css`, so new screens are visually identical to old ones.
- **The Settings screen never selects credential columns** from
  `agent_config`. It has no need for them, and not selecting them means they
  never reach the browser.
- `stage_key` is the source of truth for stage; a database trigger mirrors it
  to the legacy `stage` enum so the old bundle stays consistent.
