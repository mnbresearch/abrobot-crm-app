-- AbroBot CRM — two ways money leaves the business without anyone noticing.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BUG 1 — buy one month of a higher plan, inherit the whole remaining term
-- ════════════════════════════════════════════════════════════════════════════
-- grant_plan_from_payment extends the period from the EXISTING end date and
-- overwrites the plan, and never compares the two:
--
--   select greatest(now(), coalesce(s.current_period_end, now())) into new_end ...
--   new_end := new_end + (pay.period_months || ' months')::interval;
--   ... on conflict (org_id) do update set plan = excluded.plan, ...
--
-- That is right for a renewal of the same plan — "paying early adds time rather
-- than throwing away what is left", as the original comment says. Across plans
-- it is a ₹35,001 hole, reachable through the ordinary UI:
--
--   1. Buy Starter annual      ₹9,990   → period_end = T+12mo, plan = starter
--   2. Buy Business monthly    ₹4,999   → period_end = T+13mo, plan = business
--
--   Thirteen months of Business for ₹14,989 instead of ₹49,990.
--
-- The mirror case harms the customer instead: clicking a cheaper plan converts
-- their remaining paid months to the cheaper tier, no proration, no refund —
-- which is a valid claim under the Refund Policy's "billing errors" clause.
--
-- Nothing upstream defends against it. billing-checkout never compares the
-- requested plan to the live one, and Settings only disables the button for the
-- plan you are already on.
--
-- THE FIX: carry the unused time across as VALUE, not as time.
--
--   remaining_days × (old plan's monthly price ÷ new plan's monthly price)
--
-- Same plan behaves exactly as before. Upgrading converts the leftover into a
-- smaller number of more expensive days; downgrading converts it into a larger
-- number of cheaper ones, which is the fair direction and costs us nothing.
--
-- Worked example, the exploit above: 365 days of Starter remaining, at list
-- rates 999 / 4999, credits 72.9 days. One purchased month plus that credit is
-- ~103 days of Business for ₹14,989 — versus 396 days before. The annual
-- discount rides along at list rate, which is slightly generous to the
-- customer; that is deliberate. A proration that shortchanges someone who just
-- upgraded is worse than one that rounds their way.
--
-- ════════════════════════════════════════════════════════════════════════════
-- BUG 2 — a refund or a chargeback never removes access
-- ════════════════════════════════════════════════════════════════════════════
-- billing-webhook handles PAYMENT_SUCCESS, PAYMENT_FAILED and USER_DROPPED.
-- There is no refund branch and no dispute branch, and nothing anywhere ever
-- writes the 'refunded' value that the payment_status enum has defined since
-- day one.
--
-- The manual remedy fails too. effective_plan does this:
--
--   select current_period_end, status into s from public.subscriptions ...
--
-- — and then never reads `status`. Only current_period_end decides entitlement,
-- so setting subscriptions.status = 'cancelled' by hand revokes nothing. The
-- whole status machinery is write-only: mark_lapsed_subscriptions has been
-- writing 'past_due' into a column no decision consults.
--
-- Refund an annual Business order through the Cashfree dashboard and the
-- customer keeps ₹49,990 of plan for twelve months. A chargeback is identical,
-- so the sequence "pay → get granted → charge back → keep the plan" works.
--
-- THE FIX: revoke_plan_from_payment(), the exact inverse of the grant, plus
-- making effective_plan read the status it already selects.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Audit columns for a reversal
-- ════════════════════════════════════════════════════════════════════════════
-- granted_at is NOT cleared on revoke. It is the compare-and-swap that makes
-- the grant idempotent (20260901090000), and clearing it would re-arm a replay
-- of the original webhook. revoked_at is a separate fact.

alter table public.payments add column if not exists revoked_at    timestamptz;
alter table public.payments add column if not exists revoke_reason text;

comment on column public.payments.revoked_at is
  'When the plan granted by this payment was taken back (refund, chargeback, manual reversal). Separate from granted_at, which stays set so the grant cannot be replayed.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The grant, now aware that plans differ
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.grant_plan_from_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay           public.payments%rowtype;
  sub           public.subscriptions%rowtype;
  new_end       timestamptz;
  credit_days   numeric := 0;
  remaining     numeric := 0;
  old_price     numeric;
  new_price     numeric;
  carried       boolean := false;
begin
  -- Claim the grant. `and granted_at is null` makes this a compare-and-swap:
  -- concurrent webhook deliveries race here, exactly one wins, and the loser
  -- gets no row back. Replay is a no-op rather than a free month.
  update public.payments
     set granted_at = now()
   where id = p_payment_id
     and status = 'paid'
     and granted_at is null
  returning * into pay;

  if not found then
    return jsonb_build_object('ok', true, 'already_granted', true);
  end if;

  select * into sub from public.subscriptions where org_id = pay.org_id;

  -- ── How much of the old period carries over ──────────────────────────────
  if found
     and sub.current_period_end is not null
     and sub.current_period_end > now()
     -- A cancelled or refunded subscription has no time left to carry. Without
     -- this, refunding and immediately re-buying would resurrect the refunded
     -- months.
     and coalesce(sub.status, 'active') not in ('cancelled', 'refunded', 'chargeback')
  then
    remaining := extract(epoch from (sub.current_period_end - now())) / 86400.0;

    if sub.plan = pay.plan then
      -- Same plan: time carries as time. This is the original behaviour and it
      -- is correct — paying early should add to what you have.
      credit_days := remaining;
      carried     := true;
    else
      select price_inr into old_price from public.plan_limits where plan = sub.plan;
      select price_inr into new_price from public.plan_limits where plan = pay.plan;

      -- Enterprise has a null price and free/expired are zero. If either side
      -- cannot be valued, carry nothing rather than guess — a wrong guess here
      -- is either a refund claim or a revenue hole.
      if old_price is not null and new_price is not null and new_price > 0 then
        credit_days := remaining * (old_price::numeric / new_price::numeric);
        carried     := true;
      end if;
    end if;
  end if;

  new_end := now()
           + (pay.period_months || ' months')::interval
           + make_interval(secs => (credit_days * 86400.0)::double precision);

  insert into public.subscriptions
    (org_id, plan, status, current_period_end, last_payment_id, updated_at)
  values
    (pay.org_id, pay.plan, 'active', new_end, pay.id, now())
  on conflict (org_id) do update set
    plan = excluded.plan, status = 'active',
    current_period_end = excluded.current_period_end,
    last_payment_id = excluded.last_payment_id, updated_at = now();

  update public.organizations set plan = pay.plan where id = pay.org_id;

  return jsonb_build_object(
    'ok', true, 'org_id', pay.org_id, 'plan', pay.plan, 'until', new_end,
    'previous_plan', sub.plan,
    'carried_days', round(credit_days, 2),
    'prorated', carried and sub.plan is distinct from pay.plan);
end;
$$;

revoke all on function public.grant_plan_from_payment(uuid) from public, anon, authenticated;

comment on function public.grant_plan_from_payment is
  'Grants the plan a payment bought. Same-plan renewals add time; a plan CHANGE converts the unused remainder to value at list rates rather than inheriting it wholesale — which previously let 13 months of Business be bought for the price of Starter annual plus one month.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The reversal
-- ════════════════════════════════════════════════════════════════════════════
-- Subtracts exactly the period this payment added. For a same-plan grant that
-- is the precise inverse. For a prorated cross-plan grant it removes the
-- purchased months and leaves the carried credit, which errs toward the
-- customer — correct, because the credit represents money they paid earlier
-- and are not getting back.
--
-- If that lands at or before now, access ends immediately and the status is set
-- so effective_plan refuses it even if a later migration changes the date
-- arithmetic.

create or replace function public.revoke_plan_from_payment(
  p_payment_id uuid,
  p_reason     text default 'refund'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay      public.payments%rowtype;
  sub      public.subscriptions%rowtype;
  new_end  timestamptz;
  v_status text;
begin
  if p_reason not in ('refund', 'chargeback', 'manual') then
    raise exception 'unknown revoke reason: %', p_reason using errcode = 'P0001';
  end if;

  update public.payments
     set status = case when p_reason = 'chargeback' then status else 'refunded'::public.payment_status end,
         revoked_at = now(),
         revoke_reason = p_reason
   where id = p_payment_id
     and granted_at is not null
     and revoked_at is null
  returning * into pay;

  if not found then
    -- Either never granted (nothing to take back) or already revoked. Both are
    -- success for a webhook that may be delivered more than once.
    return jsonb_build_object('ok', true, 'nothing_to_revoke', true);
  end if;

  select * into sub from public.subscriptions where org_id = pay.org_id;
  if not found then
    return jsonb_build_object('ok', true, 'org_id', pay.org_id, 'no_subscription', true);
  end if;

  new_end := coalesce(sub.current_period_end, now())
           - (pay.period_months || ' months')::interval;

  if new_end <= now() then
    new_end  := now();
    v_status := case when p_reason = 'chargeback' then 'chargeback' else 'refunded' end;
  else
    v_status := sub.status;
  end if;

  update public.subscriptions
     set current_period_end = new_end,
         status = v_status,
         updated_at = now()
   where org_id = pay.org_id;

  return jsonb_build_object('ok', true, 'org_id', pay.org_id,
                            'until', new_end, 'status', v_status,
                            'reason', p_reason);
end;
$$;

revoke all on function public.revoke_plan_from_payment(uuid, text)
  from public, anon, authenticated;
grant execute on function public.revoke_plan_from_payment(uuid, text) to service_role;

comment on function public.revoke_plan_from_payment is
  'Takes back the plan a payment bought, on refund or chargeback. Idempotent: a redelivered webhook revokes once. granted_at is deliberately left set so the original grant cannot be replayed afterwards.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Make effective_plan read the status it already selects
-- ════════════════════════════════════════════════════════════════════════════
-- Three terminal statuses only. 'past_due' is deliberately NOT here:
-- mark_lapsed_subscriptions writes it only once the grace period has already
-- elapsed, so the date check below has expired the org anyway — and treating it
-- as terminal would cut off anyone the grace window is meant to protect.

create or replace function public.effective_plan(p_org_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o record;
  s record;
begin
  select id, plan into o from public.organizations where id = p_org_id;
  if not found then return 'free'; end if;

  if o.plan is null or o.plan in ('free', 'trial') then return 'free'; end if;
  if o.plan = 'enterprise' then return 'enterprise'; end if;

  select current_period_end, status into s
    from public.subscriptions where org_id = p_org_id;

  -- No subscription row for a paid plan means it was set by hand (our own
  -- organisations, or a support grant). Honour it.
  if not found or s.current_period_end is null then return o.plan; end if;

  -- Refunded or charged back: the money is gone, so the plan goes with it.
  -- This line is the whole point of the migration — `status` was selected here
  -- and never read, which made every manual cancellation silently ineffective.
  if coalesce(s.status, 'active') in ('cancelled', 'refunded', 'chargeback') then
    return 'expired';
  end if;

  -- Grace days after the period ends: cards fail and finance teams are slow,
  -- and cutting a paying customer off at midnight on day zero loses accounts
  -- that wanted to stay.
  if now() > s.current_period_end + make_interval(days => public.grace_days()) then
    return 'expired';
  end if;

  return o.plan;
end;
$$;

revoke all on function public.effective_plan(uuid) from public, anon, authenticated;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'a plan change no longer inherits the old period' as check,
       case when pg_get_functiondef('public.grant_plan_from_payment(uuid)'::regprocedure)
                 ~ 'credit_days'
            then 'PASS' else 'FAIL — old definition still live' end as result
union all
select 'a refund can take the plan back',
       case when to_regprocedure('public.revoke_plan_from_payment(uuid, text)') is not null
            then 'PASS' else 'FAIL' end
union all
select 'effective_plan reads subscription status',
       case when pg_get_functiondef('public.effective_plan(uuid)'::regprocedure)
                 ~ 'refunded'
            then 'PASS' else 'FAIL — status is still selected and ignored' end
union all
select 'neither is callable from a browser',
       case when has_function_privilege('authenticated','public.revoke_plan_from_payment(uuid, text)','execute')
              or has_function_privilege('authenticated','public.grant_plan_from_payment(uuid)','execute')
            then 'FAIL' else 'PASS' end
union all
-- Anyone who already exploited bug 1. A subscription whose plan does not match
-- the plan of its own last payment, or whose remaining term is longer than the
-- payments backing it could have bought.
select 'organisations holding more plan than they paid for',
       coalesce((select string_agg(o.slug || ' (' || s.plan || ' until '
                                   || to_char(s.current_period_end,'DD Mon YYYY') || ')', ', ')
                   from public.subscriptions s
                   join public.organizations o on o.id = s.org_id
                   left join public.payments p on p.id = s.last_payment_id
                  where s.current_period_end > now()
                    and p.plan is distinct from s.plan),
                'none')
union all
select 'payments granted but never revoked, by plan',
       coalesce((select string_agg(plan || ': ' || n, ', ')
                   from (select plan, count(*) as n from public.payments
                          where granted_at is not null and revoked_at is null
                          group by plan) x),
                'none');

-- ── Still to do, outside SQL ────────────────────────────────────────────────
-- billing-webhook must call revoke_plan_from_payment on REFUND_STATUS_WEBHOOK
-- and on dispute events. Until it does, this function exists and only an
-- operator can invoke it:
--
--   select public.revoke_plan_from_payment(
--     (select id from public.payments where order_id = 'abcrm_…'), 'refund');
--
-- billing-checkout should also refuse a plan change unless the request carries
-- an explicit flag, and show the customer the prorated end date before it
-- redirects to Cashfree. Proration that is correct but unexplained still
-- generates a support ticket.
