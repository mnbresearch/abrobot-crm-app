-- All four organisations are ours. Put them on enterprise: unlimited on every
-- limit, and effective_plan() never auto-expires an enterprise org, so none of
-- them can be cut off by the trial or subscription clock.
--
-- Run in the Supabase SQL editor for project pomsltnrxvbcafwtbtlc.

begin;

update public.organizations
   set plan = 'enterprise'
 where plan is distinct from 'enterprise';

-- Every org should read enterprise / enterprise. If any row still shows
-- something else, ROLLBACK instead of committing and send me the row.
select name,
       plan                        as purchased,
       public.effective_plan(id)   as effective,
       (select count(*) from public.leads l where l.org_id = organizations.id) as records
  from public.organizations
 order by name;

commit;
