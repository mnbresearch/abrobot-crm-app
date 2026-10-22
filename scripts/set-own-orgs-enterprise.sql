-- Put OUR OWN organisations on enterprise: unlimited on every limit, and
-- effective_plan() never auto-expires an enterprise org, so they cannot be cut
-- off by the subscription clock.
--
-- Run in the Supabase SQL editor for project pomsltnrxvbcafwtbtlc.
--
-- ── Why this file changed (14 October 2026) ──────────────────────────────────
-- It used to run
--     update public.organizations set plan = 'enterprise'
--      where plan is distinct from 'enterprise';
-- with no slug filter. That was written when every organisation in the
-- database was ours. Self-serve signup has existed since September, so running
-- it today would give every customer — free and paying — unlimited enterprise
-- for nothing. It now touches ONLY the slugs listed below, by name.
--
-- Safe to re-run: an org already on enterprise is left untouched (the update
-- matches zero rows for it), and an unknown slug changes nothing — the report
-- at the end says which listed slugs were not found.

begin;

update public.organizations
   set plan = 'enterprise'
 where slug in ('abrobot', 'mnb-research')
   and plan is distinct from 'enterprise';

-- Both listed orgs should read enterprise / enterprise, and the "orgs NOT
-- touched" line should show every other organisation unchanged. If anything
-- looks wrong, ROLLBACK instead of committing.
select name::text                  as name,
       slug::text                  as slug,
       plan::text                  as purchased,
       public.effective_plan(id)   as effective
  from public.organizations
 where slug in ('abrobot', 'mnb-research')
union all
select '— listed slug not found: ' || s, s, null::text, null::text
  from unnest(array['abrobot', 'mnb-research']) as s
 where not exists (select 1 from public.organizations o where o.slug = s)
union all
select '— orgs NOT touched by this script', null::text,
       count(*)::text || ' org(s)', null::text
  from public.organizations
 where slug not in ('abrobot', 'mnb-research')
 order by 1;

commit;
