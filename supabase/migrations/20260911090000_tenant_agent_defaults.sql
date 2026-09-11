-- AbroBot CRM — every tenant's agent becomes their own.
--
-- ── The bug this fixes ──────────────────────────────────────────────────────
-- A dental clinic that signed up got a website widget headed "Study-abroad
-- assistant · online", greeting their patients with "Ask me anything about
-- universities, scholarships, visas or SOPs", offering AbroBot's Calendly, and
-- backed by a model explicitly told it was a study-abroad counsellor.
--
-- This was not an error path. It was the SUCCESS path, for every organisation
-- on the platform except AbroBot's own.
--
-- Two halves caused it:
--
--   1. create_organisation seeds four fields on agent_config — enabled,
--      agent_name, welcome_message and an EMPTY knowledge string. apply_
--      industry_pack adds two more, persona and industry. Every other column
--      stays NULL.
--
--   2. chat-agent's publicConfig() and buildSystemPrompt() fill each NULL with
--      AbroBot's study-abroad copy, because when this was a single-tenant tool
--      that was simply what the product was.
--
-- The edge function is fixed separately (its defaults become brand-neutral).
-- This migration fixes the data half: industry packs learn to seed the fields
-- that drive what a visitor actually sees, so a clinic's widget is a clinic's
-- widget from the first second.
--
-- The columns to hold this already existed and were never populated:
-- industries.agent_knowledge and industries.quick_replies were declared in
-- 20260817090000 line 55, and the seed INSERT below them lists neither.
--
-- ── Also in here ────────────────────────────────────────────────────────────
-- The 'free' plan gets a small real allowance, because a free plan of zero is
-- indistinguishable from a broken product: the widget answered nothing and the
-- capture path rejected every enquiry with "Your subscription has ended" — to
-- accounts created an hour earlier.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Industry packs learn what their agent should say
-- ════════════════════════════════════════════════════════════════════════════
-- greeting / subtitle / quick replies are what the VISITOR sees before anyone
-- types. knowledge is what the MODEL is told when the business has not yet
-- written its own. All four are written per pack, in that pack's own language.
--
-- quick_replies format is "Label|Prompt", one per line — the format parseChips
-- in chat-agent actually parses. (The Settings screen used to offer a
-- single-line comma-separated input, which could never produce it; that is
-- fixed in the same release.)
--
-- The knowledge text is deliberately about HOW TO HELP, not about the specific
-- business — we do not know the business. It tells the model what kind of
-- enquiry it is handling and what to collect, and says plainly that it must not
-- invent specifics. A business that writes its own knowledge replaces it.

-- agent_knowledge and quick_replies were declared in 20260817090000 and never
-- populated. The greeting and subtitle have no home at all yet, so they get
-- one — they are the two strings a visitor reads before anything else, and
-- leaving them to the edge function's default is what put "Study-abroad
-- assistant · online" on a dental clinic's website.
alter table public.industries
  add column if not exists agent_greeting text,
  add column if not exists agent_subtitle text;

comment on column public.industries.agent_greeting is
  'First message the widget shows a visitor for this industry, before the business writes its own.';
comment on column public.industries.agent_subtitle is
  'Line under the widget header, e.g. "Patient assistant · online".';

create temporary table _pack_agent (
  slug       text primary key,
  subtitle   text not null,
  greeting   text not null,
  chips      text not null,
  knowledge  text not null
) on commit drop;

insert into _pack_agent values

('hospital', 'Patient assistant · online',
 'Hello 👋 I can help with departments, doctors, timings and appointments. What do you need?',
 E'🏥 Departments|What departments and specialities do you have?\n📅 Book a visit|I''d like to book an appointment.\n🕐 Timings|What are your OPD timings?\n💳 Insurance|Which insurance providers do you accept?',
 'You are the front-desk assistant for a hospital or clinic. Help visitors with departments, doctors, timings, appointments and insurance, and collect their name and phone so the desk can call back. NEVER give medical advice, a diagnosis, or dosage guidance — direct every clinical question to a qualified doctor. If anyone describes an emergency, tell them immediately to call emergency services. Do not invent doctor names, fees, timings or availability: if you have not been told, say a colleague will confirm and take their number.'),

('study_abroad', 'Study-abroad assistant · online',
 'Hi there 👋 Tell me your target country and course, and I''ll point you in the right direction.',
 E'🎓 Universities|Which universities would suit my profile?\n💰 Scholarships|What scholarships could I qualify for?\n🛂 Visa help|Can you help me with my student visa?\n📅 Talk to a counsellor|I''d like to speak to a counsellor.',
 'You are a study-abroad counsellor. Help students with country and course choice, university shortlisting, scholarships, applications and student visas. Collect their target country, study level and rough academic background so a counsellor can follow up properly. Never guarantee a visa, an admission or a scholarship — say that outcomes depend on the full profile and the university''s own decision. Do not invent fees, deadlines, rankings or success rates.'),

('education', 'Admissions assistant · online',
 'Hi 👋 Ask me about courses, batches, fees or admissions — or tell me what you''re looking for.',
 E'📚 Courses|What courses and batches do you offer?\n🕐 Batch timings|What are the batch timings?\n💳 Fees|What are the fees and payment options?\n📅 Book a visit|I''d like to visit or speak to someone.',
 'You are the admissions assistant for a school, college or coaching institute. Help with courses, batches, timings, eligibility and the admission process, and collect the student''s name, phone and the course they are interested in. Do not invent fees, seat availability, results or faculty names — if you have not been told, say the admissions team will confirm.'),

('real_estate', 'Property assistant · online',
 'Hi 👋 Tell me what you''re looking for — location, budget and type — and I''ll help narrow it down.',
 E'🏡 Available properties|What properties do you have available?\n📍 Locations|Which locations do you cover?\n💰 Budget|What can I get in my budget?\n📅 Site visit|I''d like to book a site visit.',
 'You are a property assistant for a real-estate business. Help buyers and tenants with locations, configurations, budgets, possession timelines and site visits, and collect their budget, preferred location and whether they are buying or renting. Do not invent prices, availability, approvals, RERA numbers or possession dates — say a consultant will confirm. Never give legal, tax or investment advice.'),

('legal', 'Client assistant · online',
 'Hello 👋 Tell me broadly what the matter is about and I''ll arrange the right person to speak with you.',
 E'⚖️ Practice areas|What kinds of matters do you handle?\n📅 Consultation|I''d like to book a consultation.\n💼 Process|How does engaging you work?\n🕐 Timings|When can I speak to someone?',
 'You are the client-intake assistant for a law firm. Help enquirers understand which practice areas the firm handles and how a consultation works, and collect their name, phone and a one-line description of the matter. NEVER give legal advice, an opinion on the merits, or an estimate of outcome — say plainly that advice can only come from a lawyer after reviewing the facts. Do not invent fees, timelines or case results. Treat everything shared as confidential.'),

('clinic', 'Clinic assistant · online',
 'Hi 👋 I can help with treatments, timings and appointments. What would you like to know?',
 E'🦷 Treatments|What treatments do you offer?\n📅 Book an appointment|I''d like to book an appointment.\n💳 Cost|What does a consultation cost?\n🕐 Timings|What are your clinic timings?',
 'You are the front-desk assistant for a dental or aesthetic clinic. Help with treatments offered, consultation process, timings and appointments, and collect the visitor''s name, phone and what they are interested in. NEVER give clinical advice, a diagnosis, or say whether a treatment is suitable for someone — that is for the clinician after an examination. Do not invent prices, results, recovery times or before/after claims.'),

('fitness', 'Membership assistant · online',
 'Hey 👋 Tell me your goal and I''ll explain which membership or programme fits best.',
 E'💪 Memberships|What memberships do you offer?\n🏃 Personal training|Do you offer personal training?\n🕐 Timings|What are your opening hours?\n📅 Free trial|Can I come and try a session?',
 'You are the membership assistant for a gym or wellness studio. Help with memberships, classes, personal training, timings and trial sessions, and collect the visitor''s name, phone and fitness goal. Do not give medical, injury, nutrition-prescription or supplement advice — suggest they speak to a qualified trainer or doctor. Do not invent prices, trainer credentials or results.'),

('finance', 'Client assistant · online',
 'Hello 👋 Tell me what you''re looking for and I''ll connect you with the right adviser.',
 E'💰 Services|What services do you offer?\n📄 Documents|What documents will I need?\n📅 Speak to an adviser|I''d like to speak to an adviser.\n🕐 Process|How long does the process take?',
 'You are the client assistant for a financial-services business. Help enquirers understand which services are offered, what documents are usually needed and how to start, and collect their name, phone and what they need help with. NEVER give investment, tax, insurance or financial advice, never recommend a product, and never quote a return — say an adviser will discuss their circumstances. Do not invent rates, eligibility or approval odds.'),

('automotive', 'Showroom assistant · online',
 'Hi 👋 Tell me which model you''re interested in and I''ll help with availability and a test drive.',
 E'🚗 Models|Which models do you have?\n📅 Test drive|I''d like to book a test drive.\n💰 Finance|What finance options are available?\n🔧 Service|I need to book a service.',
 'You are the showroom assistant for a vehicle dealership. Help with models, variants, availability, test drives, finance and service bookings, and collect the visitor''s name, phone and the model they are interested in. Do not invent on-road prices, discounts, waiting periods, interest rates or approval outcomes — say the sales team will confirm the current figure.'),

('travel', 'Travel assistant · online',
 'Hi 👋 Where are you thinking of going, and roughly when? I''ll take it from there.',
 E'✈️ Destinations|What destinations do you cover?\n📦 Packages|What packages do you offer?\n🛂 Visa help|Do you help with visas?\n📅 Plan a trip|I''d like to plan a trip.',
 'You are the travel assistant for a tour operator or travel agency. Help with destinations, packages, rough timings and visa support, and collect the traveller''s destination, approximate dates and group size. Do not invent prices, availability, flight timings, visa outcomes or entry requirements — say a consultant will confirm, since these change constantly.'),

('recruitment', 'Hiring assistant · online',
 'Hi 👋 Are you hiring, or looking for a role? Either way I can point you the right way.',
 E'🧑‍💼 Open roles|What roles are you hiring for?\n📄 Submit a CV|I''d like to send my CV.\n🏢 Hire through you|We''re looking to hire.\n🕐 Process|How does your process work?',
 'You are the assistant for a recruitment or staffing firm. Help candidates and employers understand what the firm does and how its process works, and collect name, phone, and whether the person is hiring or job-seeking plus the role involved. Do not invent salaries, client names, placement rates or guarantees of a job or a hire.'),

('home_services', 'Booking assistant · online',
 'Hi 👋 Tell me what needs doing and where, and I''ll get someone to you.',
 E'🔧 Services|What services do you provide?\n📅 Book a visit|I''d like to book a visit.\n💰 Charges|What do you charge?\n📍 Areas|Which areas do you cover?',
 'You are the booking assistant for a home-services business. Help with what services are offered, which areas are covered and how a visit is booked, and collect the customer''s name, phone, locality and a one-line description of the job. Do not invent prices, arrival times or warranty terms — say the team will confirm the charge after seeing the job.'),

('b2b_saas', 'Sales assistant · online',
 'Hi 👋 Tell me what you''re trying to solve and I''ll tell you honestly whether we''re a fit.',
 E'💻 What it does|What does the product actually do?\n💰 Pricing|How does pricing work?\n📅 Book a demo|I''d like a demo.\n🔌 Integrations|What does it integrate with?',
 'You are the sales assistant for a B2B software business. Help visitors understand what the product does, who it suits and how to evaluate it, and collect their name, work email, company and the problem they are trying to solve. Do not invent pricing, features, integrations, customer names, security certifications or timelines — say a human will confirm. If the product is not a fit, say so.'),

('general', 'Assistant · online',
 'Hi 👋 How can we help? Tell me what you''re looking for and I''ll point you the right way.',
 E'💬 What you do|What do you do?\n💰 Pricing|How much does it cost?\n📅 Talk to someone|I''d like to speak to someone.\n🕐 Timings|What are your working hours?',
 'You are the assistant on a business''s website. Help visitors understand what the business offers and take their enquiry, collecting name, phone or email, and what they need. Do not invent prices, services, availability, timings or credentials — if you have not been told something, say a colleague will confirm and take their contact details instead of guessing.');

update public.industries i
   set agent_knowledge = p.knowledge,
       quick_replies   = p.chips,
       agent_greeting  = p.greeting,
       agent_subtitle  = p.subtitle
  from _pack_agent p
 where i.slug = p.slug;

-- Every pack must now carry agent copy, or a tenant on that pack silently falls
-- back to whatever the edge function's generic default is.
do $$
declare v_missing text;
begin
  select string_agg(slug, ', ') into v_missing
    from public.industries
   where active and (agent_knowledge is null or quick_replies is null
                  or agent_greeting is null or agent_subtitle is null);
  if v_missing is not null then
    raise notice 'Industry packs still without agent copy: %', v_missing;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. apply_industry_pack seeds what the visitor sees
-- ════════════════════════════════════════════════════════════════════════════
-- Previously this set persona and industry only. Those two drive the model's
-- tone, but NOTHING the visitor reads before they type — the greeting, the
-- subtitle and the chips were all left NULL, which is where AbroBot's
-- study-abroad copy got in.
--
-- coalesce(nullif(col, ''), …) throughout: a business that has written its own
-- copy must never have it overwritten by a re-run, and '' is how the signup
-- path writes "not set" for knowledge.

create or replace function public.apply_industry_pack(p_org_id uuid, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ind        public.industries%rowtype;
  s          jsonb;
  f          jsonb;
  n_stages   int := 0;
  n_fields   int := 0;
begin
  select * into ind from public.industries where slug = p_slug and active;
  if not found then
    raise exception 'unknown industry pack: %', p_slug;
  end if;

  for s in select * from jsonb_array_elements(ind.default_stages) loop
    insert into public.pipeline_stages (org_id, key, label, position, is_won, is_lost)
    values (
      p_org_id,
      s->>'key',
      coalesce(s->>'label', initcap(replace(s->>'key', '_', ' '))),
      coalesce((s->>'position')::int, n_stages),
      coalesce((s->>'is_won')::boolean, false),
      coalesce((s->>'is_lost')::boolean, false)
    )
    on conflict (org_id, key) do nothing;
    n_stages := n_stages + 1;
  end loop;

  for f in select * from jsonb_array_elements(ind.default_fields) loop
    insert into public.field_defs (org_id, key, label, type, options, show_in_list, position)
    values (
      p_org_id,
      f->>'key',
      coalesce(f->>'label', initcap(replace(f->>'key', '_', ' '))),
      coalesce((f->>'type')::public.field_type, 'text'),
      coalesce(f->'options', '[]'::jsonb),
      coalesce((f->>'show_in_list')::boolean, false),
      coalesce((f->>'position')::int, n_fields)
    )
    on conflict (org_id, key) do nothing;
    n_fields := n_fields + 1;
  end loop;

  update public.organizations set industry_slug = p_slug where id = p_org_id;

  -- Seed the whole agent, not just its persona. Anything the business has
  -- already written is preserved.
  update public.agent_config
     set persona         = coalesce(nullif(persona, ''),         ind.agent_persona),
         industry        = coalesce(nullif(industry, ''),        p_slug),
         -- The trailing '' matters: agent_config.knowledge is NOT NULL. A pack
         -- added later without agent_knowledge would otherwise raise a
         -- not-null violation INSIDE create_organisation — i.e. signup itself
         -- fails, not merely the pack.
         knowledge       = coalesce(nullif(knowledge, ''),       ind.agent_knowledge, ''),
         quick_replies   = coalesce(nullif(quick_replies, ''),   ind.quick_replies),
         greeting        = coalesce(nullif(greeting, ''),        ind.agent_greeting),
         header_subtitle = coalesce(nullif(header_subtitle, ''), ind.agent_subtitle)
   where org_id = p_org_id;

  return jsonb_build_object(
    'ok', true, 'industry', p_slug,
    'stages_seeded', n_stages, 'fields_seeded', n_fields
  );
end;
$$;

grant execute on function public.apply_industry_pack(uuid, text) to authenticated;

comment on function public.apply_industry_pack is
  'Seed an org with an industry pack''s stages, fields and complete agent copy — persona, knowledge, greeting, subtitle and quick replies. Idempotent, and never overwrites anything the business has written itself.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Backfill every organisation already on the platform
-- ════════════════════════════════════════════════════════════════════════════
-- Every org that signed up before this migration has NULL greeting, subtitle
-- and quick_replies, and an empty knowledge string — i.e. every one of them is
-- currently showing AbroBot's study-abroad widget on their own website.

do $$
declare v_fixed int;
begin
  update public.agent_config ac
     -- Trailing '' for the same reason as apply_industry_pack above: knowledge
    -- is NOT NULL, so a pack with no agent_knowledge would abort the whole
    -- migration here — a hundred lines after the guard that detected exactly
    -- that condition and only printed a notice about it.
    set knowledge       = coalesce(nullif(ac.knowledge, ''),       i.agent_knowledge, ''),
         quick_replies   = coalesce(nullif(ac.quick_replies, ''),   i.quick_replies),
         greeting        = coalesce(nullif(ac.greeting, ''),        i.agent_greeting),
         header_subtitle = coalesce(nullif(ac.header_subtitle, ''), i.agent_subtitle),
         persona         = coalesce(nullif(ac.persona, ''),         i.agent_persona)
    from public.organizations o
    join public.industries i on i.slug = coalesce(o.industry_slug, 'general')
   where ac.org_id = o.id
     and (ac.greeting is null or ac.greeting = ''
       or ac.header_subtitle is null or ac.header_subtitle = ''
       or ac.quick_replies is null or ac.quick_replies = ''
       or ac.knowledge is null or ac.knowledge = '');
  get diagnostics v_fixed = row_count;
  raise notice 'Backfilled agent copy for % organisation(s).', v_fixed;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. A free plan that demonstrates the product instead of looking broken
-- ════════════════════════════════════════════════════════════════════════════
-- 'free' was 0 records, 0 AI replies, 0 emails. So a new customer followed the
-- setup checklist, pasted the widget on their site, and every visitor was told
-- "Our assistant is taking a short break" while every enquiry was rejected.
-- Nothing on screen explained that this was the plan working as designed.
--
-- 50 and 50 is deliberately small — enough to paste the widget, watch a real
-- enquiry arrive on your phone and map a sample CSV, and nowhere near enough to
-- run a business on. The marketing copy now states these two numbers exactly.
--
-- Cost of the AI half at the realistic per-reply figure (~₹0.09) is about ₹4.50
-- per signup. That is a cheap demonstration and a hard ceiling.

update public.plan_limits
   set max_leads       = 50,
       max_ai_messages = 50,
       max_emails      = 20,
       label           = 'Free'
 where plan = 'free';

comment on table public.plan_limits is
  'One row per plan. ''free'' is a real, small working allowance so a new account can prove the product on its own website; ''expired'' is read-only. Both are floors the app must degrade to gracefully, never error states.';

-- This comment is stored in the database and still described the old zero
-- allowance — "Read-only until they pay: capture, AI and sending are off". It
-- was the last place in the repo asserting that, and a stale comment on a
-- function about plan selection is exactly the kind that gets believed.
comment on function public.new_org_plan() is
  'The plan a brand-new organisation starts on. ''free'' is a small but working allowance — 50 records in total, plus 50 AI replies and 20 emails per month — so a new account can put the agent on its own website and watch a real enquiry arrive before paying. Note the asymmetry: records are a standing cap counted by guard_lead_limit over the whole table, while AI replies and emails are usage counters that reset on the 1st. It is a ceiling, not a trial: it does not expire.';

-- ── The error copy ──────────────────────────────────────────────────────────
-- At lim = 0 the trigger said "Your subscription has ended, so new records are
-- paused" — to accounts that had never had a subscription. With a free
-- allowance the zero case now only means 'expired', but a plan can still be set
-- to 0 by hand, so the message distinguishes the two rather than assuming.

create or replace function public.guard_lead_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim      int;
  used     int;
  inbound  boolean;
  v_plan   text;
begin
  -- Cast to text before comparing. leads.source is the lead_source ENUM, so an
  -- unknown literal here is not a false comparison — it is a hard
  -- "invalid input value for enum" that plpgsql only raises on the first
  -- insert, long after the migration appeared to succeed.
  -- Valid labels: whatsapp, chatbase, email, website, csv_import, pdf_import,
  --               manual, referral, other
  inbound := new.source::text in
             ('website', 'whatsapp', 'chatbase', 'email', 'referral');

  select max_leads into lim from public.plan_of(new.org_id);
  if lim is null then return new; end if;                 -- unlimited

  select public.effective_plan(new.org_id) into v_plan;

  -- Inbound capture is allowed to run past the cap on a PAID plan: losing a
  -- real enquiry because a counter rolled over costs that customer far more
  -- than the row costs us, and they are paying.
  --
  -- The `lim > 0` test used to be the whole guard, which was safe only while
  -- free was zero. Raising free to 50 records would have turned that clause
  -- into "inbound is unlimited on the free plan" — every widget, webhook and
  -- WhatsApp capture waved through, because the widget is precisely the path a
  -- free account uses. The advertised 50 would have been unenforceable on the
  -- only route anyone takes to reach it.
  if inbound and lim > 0 and v_plan not in ('free', 'expired') then
    return new;
  end if;

  -- Count-then-insert is not atomic: two concurrent inserts can both read
  -- used = lim - 1 and both proceed. Deliberately not locked. Taking a lock on
  -- every insert to prevent an occasional off-by-one overage would slow the
  -- hot intake path to protect revenue measured in fractions of a rupee.
  select count(*) into used from public.leads where org_id = new.org_id;
  if used < lim then return new; end if;

  if v_plan = 'expired' then
    raise exception
      'Your subscription has ended, so new records are paused. Your existing data is safe and still exportable — renew to continue.'
      using errcode = 'P0001';
  end if;

  if v_plan = 'free' then
    raise exception
      'The free plan includes % records and you have used all of them. Choose a plan to keep capturing — your existing records stay exactly as they are.', lim
      using errcode = 'P0001';
  end if;

  raise exception
    'Your plan includes % records and you have %. Upgrade to add more, or archive some first.', lim, used
    using errcode = 'P0001';
end;
$$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'every active industry pack has agent copy' as check,
       case when not exists (
              select 1 from public.industries
               where active and (agent_knowledge is null or agent_knowledge = ''
                              or quick_replies   is null or quick_replies   = ''
                              or agent_greeting  is null or agent_greeting  = ''
                              or agent_subtitle  is null or agent_subtitle  = ''))
            then 'PASS' else 'FAIL — a pack would fall back to the generic default' end as result
union all
-- Checks the two strings a VISITOR reads, not the knowledge text. The travel
-- pack legitimately mentions visa support, so scanning knowledge for "visa"
-- fails on correct data — a check that cries wolf gets ignored, which is worse
-- than no check.
select 'no pack greets a non-student with study-abroad copy',
       case when not exists (
              select 1 from public.industries
               where active and slug <> 'study_abroad'
                 and (agent_subtitle ilike '%study-abroad%'
                   or agent_greeting ilike '%scholarship%'
                   or agent_greeting ilike '%universit%'))
            then 'PASS' else 'FAIL — study-abroad copy leaked into another pack' end
union all
select 'apply_industry_pack seeds greeting, subtitle and chips',
       case when (select count(*) from regexp_matches(
                    pg_get_functiondef('public.apply_industry_pack(uuid, text)'::regprocedure),
                    'greeting|header_subtitle|quick_replies', 'g')) >= 3
            then 'PASS' else 'FAIL' end
union all
select 'no organisation is left on the generic fallback',
       case when not exists (
              select 1 from public.agent_config
               where greeting is null or greeting = ''
                  or header_subtitle is null or header_subtitle = ''
                  or knowledge is null or knowledge = '')
            then 'PASS' else 'FAIL — an org would still show the edge function default' end
union all
select 'the free plan can actually demonstrate the product',
       coalesce((select case when max_leads > 0 and max_ai_messages > 0
                             then 'PASS — ' || max_leads || ' records, ' || max_ai_messages || ' AI replies'
                             else 'FAIL — still zero' end
                   from public.plan_limits where plan = 'free'), 'FAIL — no free row')
union all
select 'a new account is never told its subscription ended',
       case when pg_get_functiondef('public.guard_lead_limit()'::regprocedure) like '%free plan includes%'
            then 'PASS' else 'FAIL' end
union all
select 'industry packs available',
       (select count(*)::text || ' active packs' from public.industries where active);

-- What every org's widget will now say. Any row reading 'Study-abroad
-- assistant' that is not a study-abroad business is a bug.
select o.slug, o.industry_slug, ac.header_subtitle, left(ac.greeting, 60) as greeting
  from public.organizations o
  join public.agent_config ac on ac.org_id = o.id
 order by o.slug;
