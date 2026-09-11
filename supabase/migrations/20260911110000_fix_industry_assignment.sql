-- AbroBot CRM — put four real customers on the right industry.
--
-- ── What the step-1 verification found ──────────────────────────────────────
-- The table printed at the end of 20260911090000 was there to be READ, and it
-- earned its place. It showed:
--
--   aa-enterprises  industry_slug = study_abroad   "Yarn & textile supplier"
--   toppers-hub     industry_slug = study_abroad   "Coaching · Faridabad"
--   abrobot         industry_slug = study_abroad   correct
--   ednex           industry_slug = study_abroad   correct
--   mnb-research    industry_slug = general        correct
--
-- Two organisations are on the study-abroad pack that have nothing to do with
-- studying abroad: a yarn and textile supplier trading since 1974, and a
-- domestic coaching academy.
--
-- ── Why it looked fine, and why it was not ──────────────────────────────────
-- The two columns that table printed — header_subtitle and greeting — were
-- CORRECT for both, because both organisations have their own copy, written
-- back when widget.js carried hardcoded presets for them. The backfill
-- preserved it, which is exactly what coalesce(nullif(...)) is for.
--
-- The damage is in the two columns the table did not print, which are the ones
-- the MODEL reads:
--
--   persona    — from the pack. Both were told "You are a warm, knowledgeable
--                study-abroad counsellor. Help with countries, courses,
--                intakes, budgets and tests."
--   knowledge  — empty for these orgs, so 20260911090000's backfill helpfully
--                filled it from their (wrong) pack: "You are a study-abroad
--                counsellor. Help students with country and course choice,
--                university shortlisting, scholarships, applications and
--                student visas."
--
-- So a visitor asking the yarn supplier for a quote on 40s combed cotton was
-- talking to a model briefed as a study-abroad counsellor, behind a header
-- that correctly said "Yarn & textile supplier". The greeting was right and
-- everything behind it was wrong — which is harder to spot than both being
-- wrong, and is precisely why that verification query prints the org list.
--
-- Their pipeline boards have the same problem: stages new → contacted →
-- counselled → application → offer → visa → enrolled. A yarn wholesaler has no
-- visa stage.
--
-- ── What this migration does ────────────────────────────────────────────────
-- Section 1 adds a Wholesale & Distribution pack, because 'general' is a poor
-- home for a B2B trading business and this is one of the largest categories of
-- Indian SME the product is aimed at.
--
-- Section 2 repoints the two organisations and repairs their agent copy — but
-- ONLY where the copy is still the study-abroad pack's text verbatim. Anything
-- either business actually wrote for itself is left alone.
--
-- Section 3 REPORTS the pipeline mismatch and does not touch it. Stages are
-- referenced by leads.stage_key, so remapping them moves real records between
-- columns. That is a decision with data behind it, not a cleanup — the ready
-- made remap is printed at the end for you to run deliberately.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. A pack for wholesale, distribution and trading
-- ════════════════════════════════════════════════════════════════════════════

insert into public.industries
  (slug, name, icon, tagline, lead_noun, lead_noun_plural, position,
   default_stages, default_fields, agent_persona,
   agent_knowledge, quick_replies, agent_greeting, agent_subtitle)
values
('wholesale', 'Wholesale & Distribution', '📦',
 'Buyer enquiries, quotations, samples and repeat orders',
 'Buyer', 'Buyers', 135,
 -- A trading funnel is quote-and-sample shaped, not appointment shaped. The
 -- state that matters most is "quoted, waiting" — that is where the money sits.
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"qualified","label":"Qualified","position":1},
   {"key":"quoted","label":"Quotation Sent","position":2},
   {"key":"sample_sent","label":"Sample Sent","position":3},
   {"key":"negotiation","label":"Negotiation","position":4},
   {"key":"order_won","label":"Order Confirmed","position":5,"is_won":true},
   {"key":"lost","label":"Lost","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"product","label":"Product / Material","type":"text","show_in_list":true},
   {"key":"quantity","label":"Quantity","type":"text","show_in_list":true},
   {"key":"quality_grade","label":"Quality / Grade","type":"text"},
   {"key":"delivery_location","label":"Delivery Location","type":"text","show_in_list":true},
   {"key":"target_price","label":"Target Price","type":"currency"},
   {"key":"gstin","label":"GSTIN","type":"text"}]'::jsonb,
 'You are a straight-talking assistant for a wholesale supplier. Buyers here know their trade — be concrete about specification, quantity and lead time, and never waffle.',
 'You are the enquiry assistant for a wholesale, distribution or trading business. Help buyers with what is stocked, minimum order quantities, grades and specifications, lead times and how to get a quotation, and collect their name, phone, the product and grade they want, the quantity, and the delivery location. Do not invent prices, stock availability, lead times or specifications — rates in trading move constantly, so say the team will confirm a firm quotation rather than guessing at one. Ask for GSTIN if they are placing a business order.',
 E'📦 What you supply|What products and grades do you supply?\n💰 Get a quote|I need a quotation — here is my specification and quantity.\n🚚 Delivery|Where do you deliver, and what are the lead times?\n📋 Minimum order|What is your minimum order quantity?',
 'Hi 👋 Tell me the product, grade and quantity you need and I''ll get you a quotation.',
 'Sales assistant · online')
on conflict (slug) do update set
  name = excluded.name, icon = excluded.icon, tagline = excluded.tagline,
  lead_noun = excluded.lead_noun, lead_noun_plural = excluded.lead_noun_plural,
  default_stages = excluded.default_stages, default_fields = excluded.default_fields,
  agent_persona = excluded.agent_persona, agent_knowledge = excluded.agent_knowledge,
  quick_replies = excluded.quick_replies, agent_greeting = excluded.agent_greeting,
  agent_subtitle = excluded.agent_subtitle;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Repoint the two organisations, and repair only what was never theirs
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  r            record;
  v_sa_persona text;
  v_sa_know    text;
  v_fixed      int := 0;
begin
  -- The exact strings a mis-assigned org would be carrying. Matching on them
  -- rather than on "looks study-abroad-ish" means a business that genuinely
  -- wrote about visas for its own reasons is never overwritten.
  select agent_persona, agent_knowledge into v_sa_persona, v_sa_know
    from public.industries where slug = 'study_abroad';

  for r in
    select * from (values
      ('aa-enterprises', 'wholesale'),
      ('toppers-hub',    'education')
    ) as t(slug, correct_industry)
  loop
    if not exists (select 1 from public.organizations where slug = r.slug) then
      raise notice 'No organisation with slug % — skipping.', r.slug;
      continue;
    end if;

    update public.organizations
       set industry_slug = r.correct_industry
     where slug = r.slug;

    -- Repair the agent copy, but only where it is still the study-abroad
    -- pack's text word for word, or empty. Their own greeting and subtitle
    -- survive untouched — those are correct and were written by them.
    update public.agent_config ac
       set persona   = case when ac.persona is null or ac.persona = '' or ac.persona = v_sa_persona
                            then i.agent_persona else ac.persona end,
           knowledge = case when ac.knowledge is null or ac.knowledge = '' or ac.knowledge = v_sa_know
                            then coalesce(i.agent_knowledge, '') else ac.knowledge end,
           -- quick_replies only if they have none of their own; a wrong chip
           -- is visible to every visitor.
           quick_replies = coalesce(nullif(ac.quick_replies, ''), i.quick_replies),
           industry  = r.correct_industry
      from public.organizations o
      join public.industries i on i.slug = r.correct_industry
     where ac.org_id = o.id and o.slug = r.slug;

    v_fixed := v_fixed + 1;
    raise notice 'Repointed % to the % pack.', r.slug, r.correct_industry;
  end loop;

  raise notice '% organisation(s) repaired.', v_fixed;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'the wholesale pack exists and is complete' as check,
       case when exists (select 1 from public.industries
                          where slug = 'wholesale' and active
                            and agent_knowledge is not null and quick_replies is not null
                            and agent_greeting is not null and agent_subtitle is not null)
            then 'PASS' else 'FAIL' end as result
union all
select 'only genuine study-abroad businesses are on that pack',
       coalesce((select 'CHECK — still on study_abroad: ' || string_agg(slug, ', ')
                   from public.organizations
                  where industry_slug = 'study_abroad'
                    and slug not in ('abrobot', 'ednex')),
                'PASS — abrobot and ednex only')
union all
select 'no agent is briefed as a counsellor for the wrong business',
       coalesce((select 'FAIL — ' || string_agg(o.slug, ', ')
                   from public.agent_config ac
                   join public.organizations o on o.id = ac.org_id
                  where o.industry_slug <> 'study_abroad'
                    and (ac.knowledge ilike '%study-abroad counsellor%'
                      or ac.persona   ilike '%study-abroad counsellor%')),
                'PASS')
union all
-- The general form of the same mistake, for organisations I cannot see. An org
-- on the study-abroad pack whose own greeting and subtitle mention nothing
-- about studying abroad is very likely misassigned too.
select 'anything else that looks misassigned',
       coalesce((select 'REVIEW — ' || string_agg(o.slug, ', ')
                   from public.organizations o
                   join public.agent_config ac on ac.org_id = o.id
                  where o.industry_slug = 'study_abroad'
                    and coalesce(ac.header_subtitle, '') not ilike '%study%'
                    and coalesce(ac.greeting, '')        not ilike '%countr%'
                    and coalesce(ac.greeting, '')        not ilike '%universit%'),
                'PASS — nothing else looks wrong');

-- ── Section 3: the pipeline mismatch, reported not touched ──────────────────
-- Their boards still carry study-abroad columns. Nothing above changed a
-- stage, because leads.stage_key points at these and remapping moves real
-- records. Read this, then decide.
-- `group by o.id` and not `group by o.slug`. The correlated subquery below
-- references o.id, and Postgres only lets an outer column appear inside an
-- aggregate query if it is grouped, or is functionally dependent on something
-- grouped. slug is unique in practice but carries no constraint saying so, so
-- the planner cannot infer that id follows from it — hence 42803. Grouping by
-- the primary key makes every other organisations column legal for free.
select o.slug,
       o.industry_slug                                   as now_on_pack,
       string_agg(ps.key, ' → ' order by ps.position)    as current_stages,
       (select count(*) from public.leads l where l.org_id = o.id) as records
  from public.organizations o
  join public.pipeline_stages ps on ps.org_id = o.id
 where o.slug in ('aa-enterprises', 'toppers-hub')
 group by o.id, o.slug, o.industry_slug;

-- ── The remap, if you want it. RUN DELIBERATELY, ONE ORG AT A TIME. ─────────
-- Uncomment, set the slug, read the mapping, then run. It seeds the correct
-- stages, moves every record onto the nearest equivalent, and only then
-- removes the stages left empty.
--
-- begin;
--   -- 1. seed the correct pack's stages alongside the old ones
--   select public.apply_industry_pack(
--            (select id from public.organizations where slug = 'aa-enterprises'),
--            'wholesale');
--
--   -- 2. move the records. Check this mapping against how they actually sell.
--   update public.leads l set stage_key = m.new_key
--     from (values
--       ('new',         'enquiry'),
--       ('contacted',   'qualified'),
--       ('counselled',  'quoted'),
--       ('application', 'negotiation'),
--       ('offer',       'negotiation'),
--       ('visa',        'negotiation'),
--       ('enrolled',    'order_won'),
--       ('lost',        'lost')
--     ) as m(old_key, new_key)
--    where l.org_id = (select id from public.organizations where slug = 'aa-enterprises')
--      and l.stage_key = m.old_key;
--
--   -- 3. drop only the old stages that are now empty
--   delete from public.pipeline_stages ps
--    where ps.org_id = (select id from public.organizations where slug = 'aa-enterprises')
--      and ps.key in ('new','contacted','counselled','application','offer','visa','enrolled')
--      and not exists (select 1 from public.leads l
--                       where l.org_id = ps.org_id and l.stage_key = ps.key);
--
--   -- 4. confirm nothing was stranded before committing
--   select l.stage_key, count(*)
--     from public.leads l
--    where l.org_id = (select id from public.organizations where slug = 'aa-enterprises')
--      and not exists (select 1 from public.pipeline_stages ps
--                       where ps.org_id = l.org_id and ps.key = l.stage_key)
--    group by l.stage_key;
--   -- ^ must return ZERO rows. If it does not, rollback.
-- commit;
