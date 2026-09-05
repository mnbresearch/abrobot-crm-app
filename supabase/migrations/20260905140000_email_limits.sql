-- AbroBot CRM — meter outbound email against the plan.
--
-- ── Why ─────────────────────────────────────────────────────────────────────
-- Until email existed there was nothing to meter. Now Templates → Send will
-- deliver up to 2,000 messages per click and the automatic follow-up runs
-- unattended, and both go out through OUR verified sending domain.
--
-- That last part is what makes this a limit rather than a pricing knob. AI
-- replies cost money when abused; email costs *reputation*, and reputation is
-- shared. One trial account blasting 2,000 cold emails gets the sending domain
-- flagged, and every other tenant's follow-up starts landing in spam. The
-- tenant who caused it is not the tenant who pays for it.
--
-- Same machinery as ai_messages: one counter per org per calendar month,
-- checked by plan_of() so expiry is accounted for at a single place.

begin;

-- ── 1. The allowance ────────────────────────────────────────────────────────
alter table public.plan_limits
  add column if not exists max_emails integer;

comment on column public.plan_limits.max_emails is
  'Outbound emails per calendar month. NULL = unlimited. 0 = none (expired accounts keep read access, but stop sending).';

update public.plan_limits set max_emails = v.max_emails
  from (values
    ('trial',       50),
    ('starter',   1000),
    ('growth',    5000),
    ('business', 20000),
    ('enterprise', null::integer),
    ('expired',      0)
  ) as v(plan, max_emails)
 where public.plan_limits.plan = v.plan;

-- The trial number is deliberately small. 50 emails is enough to see the
-- feature work on your own contacts and far too few to run a cold campaign,
-- which is exactly the shape of the risk.

-- ── 2. Teach consume_usage the new metric ───────────────────────────────────
-- Same signature, so the 4-argument shim and every existing grant still apply.
create or replace function public.consume_usage(
  p_org_id uuid, p_metric text, p_amount integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_limit  integer;
  v_new    integer;
begin
  select case p_metric
           when 'ai_messages' then max_ai_messages
           when 'emails'      then max_emails
           else null
         end
    into v_limit
    from public.plan_of(p_org_id);

  insert into public.usage_counters (org_id, period, metric, value)
  values (p_org_id, v_period, p_metric, p_amount)
  on conflict (org_id, period, metric)
  do update set value = public.usage_counters.value + p_amount
  returning value into v_new;

  if v_limit is not null and v_new > v_limit then
    return jsonb_build_object('allowed', false, 'used', v_new, 'limit', v_limit);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_new, 'limit', v_limit);
end;
$$;

-- ── 3. How many are left? ───────────────────────────────────────────────────
-- The composer needs this BEFORE sending, because refusing halfway through a
-- 400-person send leaves the tenant with no idea who received it. A dedicated
-- read is the difference between "you have 120 left, this needs 400" and a
-- partial send they have to reconstruct from activity logs.
create or replace function public.email_allowance(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'limit', l.max_emails,
    'used',  coalesce(u.value, 0),
    'remaining', case when l.max_emails is null then null
                      else greatest(l.max_emails - coalesce(u.value, 0), 0) end
  )
  from public.plan_of(p_org_id) l
  left join public.usage_counters u
    on u.org_id = p_org_id
   and u.period = to_char(now(), 'YYYY-MM')
   and u.metric = 'emails';
$$;

-- SECURITY DEFINER defaults to EXECUTE for PUBLIC, and this one takes an
-- org_id, so left open any stranger could read another org's usage. The edge
-- functions use the service role and are unaffected.
revoke all on function public.email_allowance(uuid) from public, anon, authenticated;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select plan, label, max_emails from plan_limits order by position;
--   select public.email_allowance((select id from organizations where slug = 'abrobot'));
