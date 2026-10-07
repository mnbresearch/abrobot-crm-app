-- ════════════════════════════════════════════════════════════════════════════
-- Marketplace and ad-platform lead sources.
--
-- The capture URL now recognises IndiaMART, JustDial, TradeIndia and Google Ads
-- lead-form payloads natively (supabase/functions/_shared/sources.ts), and
-- records which one a lead came from in leads.source — so the Dashboard and
-- Reports "by source" charts attribute marketplace leads correctly instead of
-- lumping them under "website".
--
-- Two parts:
--   1. Add the values to the lead_source enum.
--   2. Teach guard_lead_limit that they are INBOUND. Inbound capture is exempt
--      from the record cap on paid plans ("losing a real enquiry because a
--      counter rolled over costs that customer far more than the row costs
--      us"). An IndiaMART enquiry is exactly that kind of enquiry. Without this
--      step a paying customer at their cap would have IndiaMART leads refused
--      while identical website leads were accepted.
--
-- guard_lead_limit is GENERATED from its current definition in
-- 20261001090000_plan_guard_truthfulness.sql with exactly one textual change —
-- the inbound list — rather than retyped. Retyping a function from memory is
-- how an earlier migration nearly shipped without its authorisation check.
--
-- Additions only. Nothing is removed and every existing limit still applies.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Enum values ──────────────────────────────────────────────────────────
-- Outside a transaction block, each on its own: ALTER TYPE ... ADD VALUE cannot
-- have its new value USED in the same transaction that adds it, and keeping
-- these separate means a re-run is a no-op rather than an error.
alter type public.lead_source add value if not exists 'indiamart';
alter type public.lead_source add value if not exists 'justdial';
alter type public.lead_source add value if not exists 'tradeindia';
alter type public.lead_source add value if not exists 'google_ads';
alter type public.lead_source add value if not exists 'meta_ads';

-- ── 2. Treat them as inbound in the record-cap guard ────────────────────────
-- The guard compares `new.source::text` against text literals, so it does not
-- depend on the enum values above being committed first.
begin;

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
  inbound := new.source::text in
             ('website', 'whatsapp', 'chatbase', 'email', 'referral',
              'indiamart', 'justdial', 'tradeindia', 'google_ads', 'meta_ads');

  select max_leads into lim from public.plan_of(new.org_id);
  if lim is null then return new; end if;                 -- unlimited

  select public.effective_plan(new.org_id) into v_plan;

  -- Inbound capture is allowed to run past the cap on a PAID plan: losing a
  -- real enquiry because a counter rolled over costs that customer far more
  -- than the row costs us, and they are paying.
  if inbound and lim > 0 and v_plan not in ('free', 'expired') then
    return new;
  end if;

  -- Count-then-insert is still deliberately not atomic — taking a lock on every
  -- insert to prevent an occasional off-by-one overage would slow the hot intake
  -- path to protect revenue measured in fractions of a rupee.
  --
  -- NOT `deleted_at is null` alone. archive_lead() is one click and
  -- purge_archived() does not hard-delete for 30 days, so counting only live
  -- rows would let any org capture to the cap, archive, and capture again —
  -- repeatedly, inside that window. Free (50) would be effectively unlimited.
  --
  -- A row still occupies the plan until it is actually purged, so that is what
  -- is counted: live rows, plus archived rows not yet past the purge horizon.
  -- Archiving therefore frees a slot after 30 days, which is what "archive some
  -- first" can honestly promise.
  select count(*) into used
    from public.leads
   where org_id = new.org_id
     and (deleted_at is null or deleted_at > now() - interval '30 days');

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

  -- "archive some first" is now true, with a delay: an archived row stops
  -- counting once purge_archived() passes it, 30 days on.
  raise exception
    'Your plan includes % records and you have %. Upgrade to add more, or archive some first.', lim, used
    using errcode = 'P0001';
end;
$$;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — static inspection only. No function is called: an earlier verify
-- block in this repo called a function that refuses callers without a JWT, and
-- the SQL editor has none.
-- ════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'lead_source'
      and e.enumlabel in ('indiamart','justdial','tradeindia','google_ads','meta_ads'))  as new_enum_values,
  (select pg_get_functiondef(p.oid) like '%''indiamart'', ''justdial'', ''tradeindia'', ''google_ads'', ''meta_ads''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_lead_limit')                       as guard_treats_them_inbound,
  -- The previous fix must have survived the redefinition.
  (select pg_get_functiondef(p.oid) like '%deleted_at > now() - interval ''30 days''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'guard_lead_limit')                       as archived_rule_intact;
-- Expect: 5, true, true
