-- Did the industry repair land, and what is left to decide?
--
-- Read-only. Run this after 20260911110000_fix_industry_assignment.sql.
--
-- Why it exists: that migration's final reporting query had `group by o.slug`
-- while a correlated subquery referenced `o.id`, which Postgres rejects with
-- 42803. The error came from line 202 — forty-six lines AFTER the `commit;` —
-- so the repair itself applied cleanly and only the report failed to render.
-- This is that report, corrected, plus the checks the editor swallowed when it
-- showed the error instead of the earlier result set.
--
-- The Supabase SQL editor shows only the LAST result set, so run the four
-- blocks below ONE AT A TIME if you want to see all of them.

-- ── 1. Who is on which pack now ─────────────────────────────────────────────
-- Expect: abrobot and ednex on study_abroad. aa-enterprises on wholesale.
-- toppers-hub on education. mnb-research on general.
select o.slug,
       o.industry_slug,
       ac.header_subtitle,
       left(coalesce(ac.greeting, ''), 55)  as greeting,
       left(coalesce(ac.persona, ''), 55)   as persona,
       left(coalesce(ac.knowledge, ''), 55) as knowledge
  from public.organizations o
  left join public.agent_config ac on ac.org_id = o.id
 order by o.slug;

-- ── 2. Is any agent still briefed for the wrong business? ───────────────────
-- This is the one that matters. Expect ZERO rows.
select o.slug, o.industry_slug,
       case when ac.persona   ilike '%study-abroad%' then 'persona'   end as bad_persona,
       case when ac.knowledge ilike '%study-abroad%' then 'knowledge' end as bad_knowledge
  from public.agent_config ac
  join public.organizations o on o.id = ac.org_id
 where o.industry_slug is distinct from 'study_abroad'
   and (ac.persona ilike '%study-abroad%' or ac.knowledge ilike '%study-abroad%');

-- ── 3. The pipeline mismatch, which nothing has touched ─────────────────────
-- `group by o.id` — see the header. Grouping by the primary key makes every
-- other organisations column legal inside the aggregate, including in the
-- correlated count.
select o.slug,
       o.industry_slug                                as now_on_pack,
       string_agg(ps.key, ' → ' order by ps.position) as current_stages,
       (select count(*) from public.leads l where l.org_id = o.id) as records
  from public.organizations o
  join public.pipeline_stages ps on ps.org_id = o.id
 where o.slug in ('aa-enterprises', 'toppers-hub')
 group by o.id, o.slug, o.industry_slug;

-- ── 4. Where those records actually sit ─────────────────────────────────────
-- Read this before deciding whether the remap at the bottom of the migration
-- is worth running. If every record is in one or two stages, the remap is
-- trivial. If they are spread across `visa` and `offer`, the mapping matters.
select o.slug, l.stage_key, count(*) as records
  from public.leads l
  join public.organizations o on o.id = l.org_id
 where o.slug in ('aa-enterprises', 'toppers-hub')
 group by o.slug, l.stage_key
 order by o.slug, count(*) desc;
