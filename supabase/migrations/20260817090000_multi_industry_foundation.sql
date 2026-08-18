-- AbroBot CRM → multi-industry CRM platform
-- Foundation migration. NOT APPLIED — review first.
--
-- ── Why this exists ─────────────────────────────────────────────────────────
-- Today the product is hardcoded to study-abroad in the *database itself*:
--
--     lead_stage  = new, contacted, counselled, application, offer, visa, enrolled, lost
--
-- A hospital does not have a "visa" stage. Because stage is a Postgres ENUM,
-- every org on the platform is forced to share one study-abroad pipeline. That
-- single enum is the main thing blocking "a CRM for all industries".
--
-- ── Design ──────────────────────────────────────────────────────────────────
--  industries       catalogue of packs (terminology + stages + fields + agent
--                   persona) that an org picks once during onboarding
--  pipeline_stages  per-org stages, replacing the enum
--  field_defs       per-org custom fields; values land in leads.custom jsonb
--  leads.stage_key  text stage, running ALONGSIDE the existing enum
--
-- ── Migration safety ────────────────────────────────────────────────────────
-- STRICTLY ADDITIVE. The live frontend is a minified bundle we cannot change,
-- and it reads/writes leads.stage as an enum. So:
--   * leads.stage (enum) is untouched and remains the source of truth for now
--   * leads.stage_key is added, backfilled, and kept in sync BOTH WAYS by a
--     trigger, so old and new clients can run simultaneously
--   * every new table is additive; nothing existing is dropped or renamed
-- Once the new frontend is live and writing stage_key, the enum column can be
-- retired in a later migration.
--
-- ── Tenancy ─────────────────────────────────────────────────────────────────
-- Every new table carries org_id and gets RLS mirroring the existing model:
-- super admins see everything, members see only their own org. Read access for
-- members; writes restricted to org admins (via is_org_admin(), added in
-- 20260816120000). Configuration is an admin concern — counsellors should not
-- be able to redefine the pipeline.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. INDUSTRY CATALOGUE  (global, read-only to tenants)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.industries (
  slug            text primary key,
  name            text not null,
  icon            text,                       -- emoji shown in the picker
  tagline         text,
  -- what a "lead" is called here: patient, client, student, buyer…
  lead_noun       text not null default 'Lead',
  lead_noun_plural text not null default 'Leads',
  -- seed data applied when an org adopts the pack
  default_stages  jsonb not null default '[]'::jsonb,
  default_fields  jsonb not null default '[]'::jsonb,
  agent_persona   text,
  agent_knowledge text,
  quick_replies   text,
  position        integer not null default 100,
  active          boolean not null default true
);

comment on table public.industries is
  'Catalogue of industry packs. Global reference data — every tenant may read, nobody but a super admin may write.';

alter table public.industries enable row level security;

drop policy if exists industries_read on public.industries;
create policy industries_read on public.industries
  for select using (active or public.is_super_admin());

drop policy if exists industries_write on public.industries;
create policy industries_write on public.industries
  for all using (public.is_super_admin()) with check (public.is_super_admin());

-- ════════════════════════════════════════════════════════════════════════════
-- 2. PER-ORG PIPELINE STAGES  (replaces the hardcoded enum)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  key         text not null,                  -- stable machine key
  label       text not null,                  -- what the user sees
  position    integer not null default 0,
  color       text,
  is_won      boolean not null default false, -- terminal success
  is_lost     boolean not null default false, -- terminal failure
  created_at  timestamptz not null default now(),
  unique (org_id, key)
);

comment on column public.pipeline_stages.key is
  'Stable identifier written to leads.stage_key. Renaming a label must never change the key.';

create index if not exists pipeline_stages_org_pos_idx
  on public.pipeline_stages (org_id, position);

alter table public.pipeline_stages enable row level security;

drop policy if exists pipeline_stages_read on public.pipeline_stages;
create policy pipeline_stages_read on public.pipeline_stages
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

drop policy if exists pipeline_stages_write on public.pipeline_stages;
create policy pipeline_stages_write on public.pipeline_stages
  for all using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  ) with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. PER-ORG CUSTOM FIELDS
-- ════════════════════════════════════════════════════════════════════════════

do $$ begin
  create type public.field_type as enum
    ('text','textarea','number','currency','date','select','multiselect','checkbox','email','phone','url');
exception when duplicate_object then null; end $$;

create table if not exists public.field_defs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  key         text not null,                  -- key inside leads.custom
  label       text not null,
  type        public.field_type not null default 'text',
  options     jsonb not null default '[]'::jsonb,  -- for select/multiselect
  required    boolean not null default false,
  show_in_list boolean not null default false,     -- surface as a table column
  section     text,                                -- grouping on the lead page
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (org_id, key)
);

create index if not exists field_defs_org_pos_idx on public.field_defs (org_id, position);

alter table public.field_defs enable row level security;

drop policy if exists field_defs_read on public.field_defs;
create policy field_defs_read on public.field_defs
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

drop policy if exists field_defs_write on public.field_defs;
create policy field_defs_write on public.field_defs
  for all using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  ) with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 4. LEADS: additive columns
-- ════════════════════════════════════════════════════════════════════════════

alter table public.leads add column if not exists custom     jsonb not null default '{}'::jsonb;
alter table public.leads add column if not exists stage_key  text;

comment on column public.leads.stage_key is
  'Per-org pipeline stage. Kept in sync with the legacy stage enum by trg_leads_stage_sync until the old frontend is retired.';

-- GIN index so custom-field filtering stays fast as orgs add fields
create index if not exists leads_custom_gin_idx on public.leads using gin (custom);
create index if not exists leads_org_stage_key_idx on public.leads (org_id, stage_key);

-- organizations: which pack this tenant runs
alter table public.organizations
  add column if not exists industry_slug text references public.industries(slug);

-- ── two-way sync between the legacy enum and the new text column ────────────
-- The old bundle writes `stage`; new code writes `stage_key`. Whichever
-- changed, mirror it to the other so both clients see a consistent lead.
create or replace function public.sync_lead_stage()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.stage_key is null then
      new.stage_key := new.stage::text;
    elsif new.stage_key is distinct from new.stage::text then
      -- only mirror back when the key is one the legacy enum understands
      begin
        new.stage := new.stage_key::public.lead_stage;
      exception when invalid_text_representation then
        null;  -- custom stage with no enum equivalent; leave the enum as-is
      end;
    end if;
    return new;
  end if;

  if new.stage is distinct from old.stage then
    new.stage_key := new.stage::text;            -- legacy client moved it
  elsif new.stage_key is distinct from old.stage_key then
    begin
      new.stage := new.stage_key::public.lead_stage;  -- new client moved it
    exception when invalid_text_representation then
      null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_stage_sync on public.leads;
create trigger trg_leads_stage_sync
  before insert or update on public.leads
  for each row execute function public.sync_lead_stage();

-- backfill existing rows
update public.leads set stage_key = stage::text where stage_key is null;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. SEED: industry packs
-- ════════════════════════════════════════════════════════════════════════════
-- Stage sets are modelled on how each sector actually runs its funnel, not a
-- generic rename of the same six steps.

begin;

insert into public.industries
  (slug, name, icon, tagline, lead_noun, lead_noun_plural, position, default_stages, default_fields, agent_persona)
values
-- ── Healthcare ─────────────────────────────────────────────────────────────
('hospital', 'Hospital & Clinic', '🏥',
 'Patient enquiries, appointments and follow-ups',
 'Patient', 'Patients', 10,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"triaged","label":"Triaged","position":1},
   {"key":"appointment_booked","label":"Appointment Booked","position":2},
   {"key":"consulted","label":"Consulted","position":3},
   {"key":"treatment_planned","label":"Treatment Planned","position":4},
   {"key":"admitted","label":"Admitted","position":5},
   {"key":"discharged","label":"Discharged","position":6,"is_won":true},
   {"key":"not_proceeding","label":"Not Proceeding","position":7,"is_lost":true}]'::jsonb,
 '[{"key":"department","label":"Department","type":"select","options":["Cardiology","Orthopaedics","Oncology","Paediatrics","Neurology","General Medicine","ENT","Dermatology"],"show_in_list":true},
   {"key":"preferred_doctor","label":"Preferred Doctor","type":"text"},
   {"key":"appointment_at","label":"Appointment","type":"date","show_in_list":true},
   {"key":"insurance_provider","label":"Insurance Provider","type":"text"},
   {"key":"referred_by","label":"Referred By","type":"text"}]'::jsonb,
 'You are a calm, precise hospital front-desk assistant. Help with departments, doctors, timings and appointments. Never give medical advice, diagnosis, or dosage guidance — always direct clinical questions to a qualified doctor. If anyone describes an emergency, tell them immediately to call emergency services.'),

-- ── Education / study abroad (the original) ────────────────────────────────
('study_abroad', 'Study Abroad', '🎓',
 'Student counselling, applications and visas',
 'Student', 'Students', 20,
 '[{"key":"new","label":"New","position":0},
   {"key":"contacted","label":"Contacted","position":1},
   {"key":"counselled","label":"Counselled","position":2},
   {"key":"application","label":"Application","position":3},
   {"key":"offer","label":"Offer","position":4},
   {"key":"visa","label":"Visa","position":5},
   {"key":"enrolled","label":"Enrolled","position":6,"is_won":true},
   {"key":"lost","label":"Lost","position":7,"is_lost":true}]'::jsonb,
 '[{"key":"target_country","label":"Target Country","type":"select","options":["USA","Canada","UK","Australia","Germany","New Zealand","Ireland","Singapore","Other"],"show_in_list":true},
   {"key":"course_level","label":"Course Level","type":"select","options":["Bachelors","Masters","MBA","PhD","Diploma","Language course"]},
   {"key":"intake","label":"Intake","type":"text"},
   {"key":"test_status","label":"Test Status","type":"text"},
   {"key":"budget_inr","label":"Budget (INR)","type":"currency","show_in_list":true}]'::jsonb,
 'You are a warm, knowledgeable study-abroad counsellor. Help with countries, courses, intakes, budgets and tests. Never promise admission or visa outcomes.'),

-- ── Schools & coaching ─────────────────────────────────────────────────────
('education', 'School & Coaching', '📚',
 'Admissions enquiries and batch enrolment',
 'Enquiry', 'Enquiries', 30,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"counselled","label":"Counselled","position":1},
   {"key":"demo_class","label":"Demo Class","position":2},
   {"key":"application","label":"Application","position":3},
   {"key":"fee_pending","label":"Fee Pending","position":4},
   {"key":"enrolled","label":"Enrolled","position":5,"is_won":true},
   {"key":"dropped","label":"Dropped","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"grade","label":"Grade / Class","type":"text","show_in_list":true},
   {"key":"program","label":"Program","type":"text","show_in_list":true},
   {"key":"batch_preference","label":"Batch Preference","type":"select","options":["Morning","Afternoon","Evening","Weekend"]},
   {"key":"fee_quoted","label":"Fee Quoted","type":"currency"}]'::jsonb,
 'You are a friendly admissions assistant. Help with programs, batches, fees and demo classes.'),

-- ── Real estate ────────────────────────────────────────────────────────────
('real_estate', 'Real Estate', '🏡',
 'Buyer and tenant enquiries through to closing',
 'Buyer', 'Buyers', 40,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"qualified","label":"Qualified","position":1},
   {"key":"site_visit","label":"Site Visit","position":2},
   {"key":"negotiation","label":"Negotiation","position":3},
   {"key":"booking","label":"Booking","position":4},
   {"key":"agreement","label":"Agreement","position":5},
   {"key":"closed","label":"Closed","position":6,"is_won":true},
   {"key":"lost","label":"Lost","position":7,"is_lost":true}]'::jsonb,
 '[{"key":"property_type","label":"Property Type","type":"select","options":["Apartment","Villa","Plot","Commercial","Office","Warehouse"],"show_in_list":true},
   {"key":"bhk","label":"Configuration","type":"select","options":["1 BHK","2 BHK","3 BHK","4 BHK","5+ BHK"]},
   {"key":"locality","label":"Preferred Locality","type":"text","show_in_list":true},
   {"key":"budget_max","label":"Budget","type":"currency","show_in_list":true},
   {"key":"possession","label":"Possession","type":"select","options":["Ready to move","Under construction"]}]'::jsonb,
 'You are a professional property advisor. Help with localities, configurations, budgets and site visits. Never quote a final price — always route to a human advisor.'),

-- ── Legal ──────────────────────────────────────────────────────────────────
('legal', 'Law Firm', '⚖️',
 'Client intake, matters and retainers',
 'Client', 'Clients', 50,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"conflict_check","label":"Conflict Check","position":1},
   {"key":"consultation","label":"Consultation","position":2},
   {"key":"proposal","label":"Proposal Sent","position":3},
   {"key":"retained","label":"Retained","position":4,"is_won":true},
   {"key":"declined","label":"Declined","position":5,"is_lost":true}]'::jsonb,
 '[{"key":"matter_type","label":"Matter Type","type":"select","options":["Corporate","Litigation","Family","Property","Criminal","IP","Tax","Employment"],"show_in_list":true},
   {"key":"opposing_party","label":"Opposing Party","type":"text"},
   {"key":"jurisdiction","label":"Jurisdiction","type":"text"},
   {"key":"urgency","label":"Urgency","type":"select","options":["Routine","Urgent","Emergency"],"show_in_list":true}]'::jsonb,
 'You are a professional legal intake assistant. Capture the nature of the matter and urgency. NEVER give legal advice or opinions on the merits of a case — always route to a qualified lawyer.'),

-- ── Healthcare adjacent: dental/aesthetic clinics ──────────────────────────
('clinic', 'Dental & Aesthetic Clinic', '🦷',
 'Treatment enquiries and repeat visits',
 'Patient', 'Patients', 60,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"consultation","label":"Consultation","position":1},
   {"key":"quote_given","label":"Quote Given","position":2},
   {"key":"treatment_started","label":"Treatment Started","position":3},
   {"key":"completed","label":"Completed","position":4,"is_won":true},
   {"key":"not_proceeding","label":"Not Proceeding","position":5,"is_lost":true}]'::jsonb,
 '[{"key":"treatment","label":"Treatment","type":"text","show_in_list":true},
   {"key":"quote_amount","label":"Quote","type":"currency","show_in_list":true},
   {"key":"next_visit","label":"Next Visit","type":"date"}]'::jsonb,
 'You are a friendly clinic assistant. Help with treatments, pricing ranges and appointments. Never give clinical advice.'),

-- ── Fitness & wellness ─────────────────────────────────────────────────────
('fitness', 'Gym & Wellness', '💪',
 'Trials, memberships and renewals',
 'Member', 'Members', 70,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"trial_booked","label":"Trial Booked","position":1},
   {"key":"trial_done","label":"Trial Done","position":2},
   {"key":"negotiation","label":"Negotiation","position":3},
   {"key":"member","label":"Member","position":4,"is_won":true},
   {"key":"lapsed","label":"Lapsed","position":5,"is_lost":true}]'::jsonb,
 '[{"key":"goal","label":"Goal","type":"select","options":["Weight loss","Muscle gain","General fitness","Rehab","Sports"],"show_in_list":true},
   {"key":"plan_interest","label":"Plan","type":"select","options":["Monthly","Quarterly","Half-yearly","Annual"]},
   {"key":"preferred_time","label":"Preferred Time","type":"text"}]'::jsonb,
 'You are an upbeat, encouraging fitness assistant. Help with plans, timings and trials. Never give medical or injury advice.'),

-- ── Financial services ─────────────────────────────────────────────────────
('finance', 'Financial Services', '💰',
 'Loans, insurance and advisory pipelines',
 'Applicant', 'Applicants', 80,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"eligibility","label":"Eligibility Check","position":1},
   {"key":"documents","label":"Documents Collected","position":2},
   {"key":"underwriting","label":"Underwriting","position":3},
   {"key":"approved","label":"Approved","position":4},
   {"key":"disbursed","label":"Disbursed","position":5,"is_won":true},
   {"key":"rejected","label":"Rejected","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"product","label":"Product","type":"select","options":["Home loan","Personal loan","Business loan","Insurance","Mutual funds","Credit card"],"show_in_list":true},
   {"key":"amount","label":"Amount","type":"currency","show_in_list":true},
   {"key":"monthly_income","label":"Monthly Income","type":"currency"},
   {"key":"employment","label":"Employment","type":"select","options":["Salaried","Self-employed","Business","Retired"]}]'::jsonb,
 'You are a careful financial services assistant. Capture requirements and eligibility basics. NEVER give investment advice or guarantee approval, rates or returns.'),

-- ── Automotive ─────────────────────────────────────────────────────────────
('automotive', 'Automotive Dealership', '🚗',
 'Test drives, bookings and deliveries',
 'Buyer', 'Buyers', 90,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"test_drive","label":"Test Drive","position":1},
   {"key":"quotation","label":"Quotation","position":2},
   {"key":"finance","label":"Finance Approval","position":3},
   {"key":"booked","label":"Booked","position":4},
   {"key":"delivered","label":"Delivered","position":5,"is_won":true},
   {"key":"lost","label":"Lost","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"model","label":"Model","type":"text","show_in_list":true},
   {"key":"variant","label":"Variant","type":"text"},
   {"key":"fuel","label":"Fuel","type":"select","options":["Petrol","Diesel","CNG","Electric","Hybrid"]},
   {"key":"exchange","label":"Exchange Vehicle","type":"checkbox"},
   {"key":"finance_required","label":"Finance Required","type":"checkbox"}]'::jsonb,
 'You are a helpful dealership assistant. Help with models, variants, test drives and finance options. Never confirm final on-road pricing.'),

-- ── Travel ─────────────────────────────────────────────────────────────────
('travel', 'Travel & Tourism', '✈️',
 'Itinerary enquiries through to booking',
 'Traveller', 'Travellers', 100,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"itinerary_sent","label":"Itinerary Sent","position":1},
   {"key":"negotiation","label":"Negotiation","position":2},
   {"key":"advance_paid","label":"Advance Paid","position":3},
   {"key":"booked","label":"Booked","position":4},
   {"key":"travelled","label":"Travelled","position":5,"is_won":true},
   {"key":"cancelled","label":"Cancelled","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"destination","label":"Destination","type":"text","show_in_list":true},
   {"key":"travel_date","label":"Travel Date","type":"date","show_in_list":true},
   {"key":"pax","label":"Travellers","type":"number"},
   {"key":"package_type","label":"Package","type":"select","options":["Budget","Standard","Premium","Luxury"]},
   {"key":"budget","label":"Budget","type":"currency"}]'::jsonb,
 'You are an enthusiastic travel consultant. Help with destinations, dates, group size and budgets.'),

-- ── Recruitment ────────────────────────────────────────────────────────────
('recruitment', 'Recruitment & Staffing', '🧑‍💼',
 'Candidate pipelines and placements',
 'Candidate', 'Candidates', 110,
 '[{"key":"sourced","label":"Sourced","position":0},
   {"key":"screened","label":"Screened","position":1},
   {"key":"submitted","label":"Submitted to Client","position":2},
   {"key":"interview","label":"Interview","position":3},
   {"key":"offer","label":"Offer","position":4},
   {"key":"placed","label":"Placed","position":5,"is_won":true},
   {"key":"rejected","label":"Rejected","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"role","label":"Role","type":"text","show_in_list":true},
   {"key":"experience_years","label":"Experience (years)","type":"number","show_in_list":true},
   {"key":"current_ctc","label":"Current CTC","type":"currency"},
   {"key":"expected_ctc","label":"Expected CTC","type":"currency"},
   {"key":"notice_period","label":"Notice Period","type":"text"},
   {"key":"skills","label":"Skills","type":"text"}]'::jsonb,
 'You are a professional recruitment assistant. Capture role interest, experience and availability. Never discuss other candidates or share salary data.'),

-- ── Home services ──────────────────────────────────────────────────────────
('home_services', 'Home Services', '🔧',
 'Site visits, quotes and jobs',
 'Customer', 'Customers', 120,
 '[{"key":"enquiry","label":"Enquiry","position":0},
   {"key":"site_visit","label":"Site Visit","position":1},
   {"key":"quoted","label":"Quoted","position":2},
   {"key":"scheduled","label":"Scheduled","position":3},
   {"key":"completed","label":"Completed","position":4,"is_won":true},
   {"key":"lost","label":"Lost","position":5,"is_lost":true}]'::jsonb,
 '[{"key":"service","label":"Service","type":"text","show_in_list":true},
   {"key":"address","label":"Address","type":"textarea"},
   {"key":"preferred_slot","label":"Preferred Slot","type":"text"},
   {"key":"quote_amount","label":"Quote","type":"currency","show_in_list":true}]'::jsonb,
 'You are a practical home-services assistant. Capture the service needed, location and preferred timing.'),

-- ── B2B / SaaS ─────────────────────────────────────────────────────────────
('b2b_saas', 'B2B / SaaS Sales', '💻',
 'Demos, trials and subscriptions',
 'Lead', 'Leads', 130,
 '[{"key":"new","label":"New","position":0},
   {"key":"qualified","label":"Qualified","position":1},
   {"key":"demo","label":"Demo","position":2},
   {"key":"trial","label":"Trial","position":3},
   {"key":"proposal","label":"Proposal","position":4},
   {"key":"won","label":"Won","position":5,"is_won":true},
   {"key":"lost","label":"Lost","position":6,"is_lost":true}]'::jsonb,
 '[{"key":"company","label":"Company","type":"text","show_in_list":true},
   {"key":"team_size","label":"Team Size","type":"number"},
   {"key":"use_case","label":"Use Case","type":"textarea"},
   {"key":"mrr_potential","label":"MRR Potential","type":"currency","show_in_list":true}]'::jsonb,
 'You are a crisp B2B sales assistant. Qualify company, team size and use case, then offer a demo.'),

-- ── Generic fallback ───────────────────────────────────────────────────────
('general', 'General Business', '🏢',
 'A simple, industry-neutral pipeline',
 'Lead', 'Leads', 999,
 '[{"key":"new","label":"New","position":0},
   {"key":"contacted","label":"Contacted","position":1},
   {"key":"qualified","label":"Qualified","position":2},
   {"key":"proposal","label":"Proposal","position":3},
   {"key":"won","label":"Won","position":4,"is_won":true},
   {"key":"lost","label":"Lost","position":5,"is_lost":true}]'::jsonb,
 '[]'::jsonb,
 'You are a helpful business assistant. Understand what the visitor needs and capture their contact details.')

on conflict (slug) do update set
  name = excluded.name, icon = excluded.icon, tagline = excluded.tagline,
  lead_noun = excluded.lead_noun, lead_noun_plural = excluded.lead_noun_plural,
  default_stages = excluded.default_stages, default_fields = excluded.default_fields,
  agent_persona = excluded.agent_persona, position = excluded.position;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. APPLYING A PACK TO AN ORG
-- ════════════════════════════════════════════════════════════════════════════
-- Called once at onboarding (and re-runnable). Idempotent: existing stages and
-- fields with the same key are left alone, so a tenant's customisations
-- survive re-application.

begin;

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
  -- authorisation: super admin, or an admin acting on their own org
  if not (public.is_super_admin()
          or (p_org_id = public.my_org() and public.is_org_admin())) then
    raise exception 'not authorised to configure this organisation';
  end if;

  select * into ind from public.industries where slug = p_slug and active;
  if not found then
    raise exception 'unknown industry pack: %', p_slug;
  end if;

  for s in select * from jsonb_array_elements(ind.default_stages) loop
    insert into public.pipeline_stages (org_id, key, label, position, is_won, is_lost)
    values (
      p_org_id,
      s->>'key',
      s->>'label',
      coalesce((s->>'position')::int, 0),
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
      f->>'label',
      coalesce((f->>'type')::public.field_type, 'text'),
      coalesce(f->'options', '[]'::jsonb),
      coalesce((f->>'show_in_list')::boolean, false),
      coalesce((f->>'position')::int, n_fields)
    )
    on conflict (org_id, key) do nothing;
    n_fields := n_fields + 1;
  end loop;

  update public.organizations set industry_slug = p_slug where id = p_org_id;

  -- seed the chat agent's persona if the org has not written its own
  update public.agent_config
     set persona  = coalesce(nullif(persona, ''), ind.agent_persona),
         industry = coalesce(nullif(industry, ''), p_slug)
   where org_id = p_org_id;

  return jsonb_build_object(
    'ok', true, 'industry', p_slug,
    'stages_seeded', n_stages, 'fields_seeded', n_fields
  );
end;
$$;

grant execute on function public.apply_industry_pack(uuid, text) to authenticated;

comment on function public.apply_industry_pack is
  'Seed an org with an industry pack''s stages, fields and agent persona. Idempotent — existing keys are preserved.';

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- 7. BACKFILL: put every existing org on the study-abroad pack
-- ════════════════════════════════════════════════════════════════════════════
-- Preserves today's behaviour exactly — the seeded stage keys are identical to
-- the current lead_stage enum values, so nothing shifts.

begin;

insert into public.pipeline_stages (org_id, key, label, position, is_won, is_lost)
select o.id, s.key, s.label, s.position, s.is_won, s.is_lost
from public.organizations o
cross join (values
  ('new','New',0,false,false),
  ('contacted','Contacted',1,false,false),
  ('counselled','Counselled',2,false,false),
  ('application','Application',3,false,false),
  ('offer','Offer',4,false,false),
  ('visa','Visa',5,false,false),
  ('enrolled','Enrolled',6,true,false),
  ('lost','Lost',7,false,true)
) as s(key,label,position,is_won,is_lost)
on conflict (org_id, key) do nothing;

update public.organizations
   set industry_slug = 'study_abroad'
 where industry_slug is null;

commit;
