-- ════════════════════════════════════════════════════════════════════════════
-- Abandoned-checkout follow-up, for AbroBot CRM's own customers.
--
-- When a workspace admin opens Cashfree checkout and does not complete it, one
-- (optionally two) plain service emails remind them, with a link back to
-- Settings → Plan. The checkout_recovery edge function sends them; this file
-- holds the configuration, the send log, the suppression list, and the single
-- query that decides who is eligible.
--
-- SAFE BY DEFAULT: the feature ships DISABLED and in DRY-RUN mode. Nothing is
-- emailed until a platform super admin turns it on in the Platform screen.
--
-- Who can receive one — every condition must hold:
--   * the payment row is 'created', 'dropped' or 'failed' (statuses written
--     only by billing-checkout and the signature-verified webhook), at least
--     `first_delay_minutes` old and at most 7 days old;
--   * the SAME organisation has no paid payment since that checkout began,
--     and is not already on the plan it tried to buy or a higher one;
--   * it is that organisation's most recent unpaid checkout (one thread per
--     org, however many times they clicked Upgrade);
--   * the recipient is the admin who started the checkout, still an active
--     member, in a still-active workspace;
--   * the address is not on platform_email_suppressions (unsubscribed or
--     bounced), and has not received ANY recovery email in the last 20 hours;
--   * fewer than `max_attempts` live emails have gone for this checkout, and
--     the previous one is at least `repeat_after_hours` old.
--
-- Additions only.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── settings: exactly one row ───────────────────────────────────────────────
create table if not exists public.checkout_recovery_settings (
  id                  boolean primary key default true check (id),
  enabled             boolean not null default false,
  dry_run             boolean not null default true,
  first_delay_minutes integer not null default 120 check (first_delay_minutes between 15 and 10080),
  repeat_after_hours  integer not null default 48  check (repeat_after_hours between 12 and 336),
  max_attempts        integer not null default 2   check (max_attempts between 1 and 3),
  test_recipient      text check (test_recipient is null or test_recipient ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$'),
  updated_at          timestamptz not null default now(),
  updated_by          uuid
);
insert into public.checkout_recovery_settings (id) values (true) on conflict (id) do nothing;

alter table public.checkout_recovery_settings enable row level security;
drop policy if exists checkout_recovery_settings_super on public.checkout_recovery_settings;
create policy checkout_recovery_settings_super on public.checkout_recovery_settings
  for all using (public.is_super_admin()) with check (public.is_super_admin());
grant select, update on public.checkout_recovery_settings to authenticated;
revoke insert, delete on public.checkout_recovery_settings from authenticated, anon;

create or replace function public.touch_checkout_recovery_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  begin
    perform public.log_admin_action('checkout_recovery_settings', null,
      jsonb_build_object('enabled', new.enabled, 'dry_run', new.dry_run,
                         'first_delay_minutes', new.first_delay_minutes,
                         'repeat_after_hours', new.repeat_after_hours, 'max_attempts', new.max_attempts));
  exception when others then null; end;
  return new;
end $$;

drop trigger if exists checkout_recovery_settings_touch on public.checkout_recovery_settings;
create trigger checkout_recovery_settings_touch
  before update on public.checkout_recovery_settings
  for each row execute function public.touch_checkout_recovery_settings();

-- ── suppression list (platform mail, not tenants' nurture lists) ────────────
create table if not exists public.platform_email_suppressions (
  email      text primary key check (email = lower(email)),
  reason     text not null check (reason in ('unsubscribed', 'bounced', 'complained', 'manual')),
  source     text,
  created_at timestamptz not null default now()
);
alter table public.platform_email_suppressions enable row level security;
drop policy if exists platform_email_suppressions_super on public.platform_email_suppressions;
create policy platform_email_suppressions_super on public.platform_email_suppressions
  for all using (public.is_super_admin()) with check (public.is_super_admin());
grant select, insert, delete on public.platform_email_suppressions to authenticated;

-- ── the send log, which is also the dedupe ──────────────────────────────────
create table if not exists public.checkout_followups (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references public.payments(id) on delete cascade,
  org_id              uuid not null references public.organizations(id) on delete cascade,
  recipient_email     text not null,
  attempt             integer not null,
  mode                text not null check (mode in ('live', 'dry_run', 'test')),
  status              text not null check (status in ('pending', 'sent', 'failed', 'would_send')),
  error               text,
  provider_message_id text,
  unsub_token         uuid not null default gen_random_uuid() unique,
  created_at          timestamptz not null default now()
);

-- Insert-before-send: the function claims (payment, attempt) by inserting a
-- 'pending' row FIRST and only then calls the provider. Two overlapping runs
-- cannot both claim it, so a customer cannot get the same email twice. A
-- 'failed' row does not hold the claim, so the next run retries.
create unique index if not exists checkout_followups_claim
  on public.checkout_followups (payment_id, attempt)
  where mode = 'live' and status in ('pending', 'sent');

create index if not exists checkout_followups_recent on public.checkout_followups (created_at desc);
create index if not exists checkout_followups_email on public.checkout_followups (lower(recipient_email), created_at desc);

alter table public.checkout_followups enable row level security;
drop policy if exists checkout_followups_super_read on public.checkout_followups;
create policy checkout_followups_super_read on public.checkout_followups
  for select using (public.is_super_admin());
revoke insert, update, delete on public.checkout_followups from authenticated, anon;

-- ── who is eligible right now ───────────────────────────────────────────────
create or replace function public.checkout_recovery_candidates(p_limit integer default 50)
returns table (
  payment_id uuid, order_id text, org_id uuid, org_name text, plan text, plan_label text, amount numeric,
  period_months integer, email text, full_name text, started_at timestamptz,
  attempt integer, last_sent_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (select * from public.checkout_recovery_settings where id),
  latest as (
    -- One thread per organisation: only its newest unpaid checkout.
    select distinct on (p.org_id) p.*
      from public.payments p
     where p.status in ('created', 'dropped', 'failed')
       and p.created_at > now() - interval '7 days'
     order by p.org_id, p.created_at desc
  ),
  sent as (
    select f.payment_id, count(*) filter (where f.status = 'sent') as n,
           max(f.created_at) filter (where f.status = 'sent') as last_at,
           count(*) filter (where f.status = 'failed') as failures
      from public.checkout_followups f where f.mode = 'live' group by f.payment_id
  )
  select p.id, p.order_id, p.org_id, o.name, p.plan, coalesce(pl.label, p.plan), p.amount, p.period_months,
         lower(pr.email), pr.full_name, p.created_at,
         coalesce(sent.n, 0)::integer + 1, sent.last_at
    from latest p
    cross join s
    join public.organizations o on o.id = p.org_id and o.active
    -- The person who started the checkout, and only while they are still an
    -- active member of THIS workspace. No fallback to the address recorded on
    -- the order: someone who has left must not be chased about a plan for a
    -- company they no longer work for.
    join public.profiles pr on pr.id = p.created_by and pr.org_id = p.org_id and pr.status = 'active' 
    left join public.plan_limits pl on pl.plan = p.plan
    left join sent on sent.payment_id = p.id
   where p.created_at < now() - make_interval(mins => s.first_delay_minutes)
     and pr.email is not null
     and not exists (select 1 from public.payments q
                      where q.org_id = p.org_id and q.status = 'paid' and q.created_at >= p.created_at)
     -- Already on that plan or a higher one (e.g. upgraded by support): nothing
     -- to recover. 'expired' and 'free' are never "higher" — 'expired' carries
     -- the highest position in plan_limits, and without this a lapsed customer
     -- abandoning a renewal (the person most worth a reminder) was excluded.
     and (public.effective_plan(p.org_id) in ('expired', 'free')
          or coalesce((select cur.position from public.plan_limits cur
                        where cur.plan = public.effective_plan(p.org_id)), -1) < coalesce(pl.position, 2147483647))
     and not exists (select 1 from public.platform_email_suppressions x
                      where x.email = lower(pr.email))
     and coalesce(sent.n, 0) < s.max_attempts
     and coalesce(sent.failures, 0) < 3
     and (sent.last_at is null or sent.last_at < now() - make_interval(hours => s.repeat_after_hours))
     and not exists (select 1 from public.checkout_followups r
                      where r.mode = 'live' and r.status = 'sent'
                        and lower(r.recipient_email) = lower(pr.email)
                        and r.created_at > now() - interval '20 hours')
   order by p.created_at
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.checkout_recovery_candidates(integer) from public, anon, authenticated;

-- The same list for the Platform screen, behind a super-admin check.
create or replace function public.checkout_recovery_preview()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query select to_jsonb(c) from public.checkout_recovery_candidates(50) c;
end $$;

revoke all on function public.checkout_recovery_preview() from public, anon;
grant execute on function public.checkout_recovery_preview() to authenticated;

commit;

-- ── schedule: hourly. The function itself returns early while disabled. ─────
select cron.unschedule('abrobot-checkout-recovery')
  where exists (select 1 from cron.job where jobname = 'abrobot-checkout-recovery');
select cron.schedule('abrobot-checkout-recovery', '20 * * * *',
  $$select public.call_edge_function('checkout-recovery', '{"mode":"run"}'::jsonb)$$);

-- An edge-function job: it reports its own heartbeat (never via the cron map —
-- see the comment on cron_job_heartbeat_map).
insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail, watch)
values ('checkout-recovery', interval '3 hours', 'ok', 'seeded 13 Oct — awaiting first run', true)
on conflict (job_name) do update set stale_after = excluded.stale_after;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — static. Expect every row PASS.
-- ════════════════════════════════════════════════════════════════════════════
select 'ships disabled and in dry-run' as check,
       case when (select not enabled and dry_run from public.checkout_recovery_settings where id)
            then 'PASS' else 'CHECK — already switched on' end as result
union all
select 'candidate query runs',
       case when (select count(*) from public.checkout_recovery_candidates(5)) >= 0 then 'PASS' else 'FAIL' end
union all
select 'browser cannot write the send log',
       case when has_table_privilege('authenticated', 'public.checkout_followups', 'INSERT') then 'FAIL' else 'PASS' end
union all
select 'browser cannot call the raw candidate query',
       case when has_function_privilege('authenticated', 'public.checkout_recovery_candidates(integer)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'scheduled hourly',
       case when exists (select 1 from cron.job where jobname = 'abrobot-checkout-recovery') then 'PASS' else 'FAIL' end;
