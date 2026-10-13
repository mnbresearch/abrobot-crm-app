-- ════════════════════════════════════════════════════════════════════════════
-- First-party product analytics for AbroBot CRM itself (not for tenants' data).
--
-- Answers the questions the platform owner could not answer without SQL:
-- how many people reach the landing page, how many ask for a sign-in link, how
-- many create a workspace, finish onboarding, open checkout, and pay — and
-- where they drop off.
--
-- DESIGN
--
--   * No third-party tracker. The privacy policy promises "no third-party
--     analytics", and that stays true: events go to our own database.
--
--   * MONEY AND ACCOUNTS ARE NEVER TAKEN FROM THE BROWSER. Payment, checkout,
--     subscription, workspace and API-key events are written by TRIGGERS on the
--     tables that the signature-verified webhook and the server functions
--     write. A browser redirect back from Cashfree proves nothing, so it is
--     recorded as `checkout_returned` and never counted as a payment.
--
--   * The browser can only send events from a fixed allow-list, through
--     track_event(), which: derives user and org from the JWT (never from the
--     request), strips the query string and fragment from the path (magic-link
--     tokens and order ids live there), keeps only allow-listed property keys
--     with short string values, and rate-limits per session and globally.
--
--   * No cookies and no persistent identifier for signed-out visitors: the
--     session id is a random value in sessionStorage, gone when the tab closes.
--     The client sends nothing at all when Do Not Track or Global Privacy
--     Control is on.
--
--   * Retention 13 months, purged daily. Deleting a user nulls user_id on their
--     events (FK on delete set null); closing a workspace deletes its events
--     (cascade); forget_user_analytics() erases one person on request.
--
-- Additions only. Every trigger swallows its own errors, so analytics can never
-- block a payment, a signup or a key creation.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.product_events (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  event       text not null,
  source      text not null check (source in ('client', 'server')),
  org_id      uuid references public.organizations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  session_id  text,
  path        text,
  props       jsonb not null default '{}'::jsonb
);

create index if not exists product_events_time_idx  on public.product_events (occurred_at desc);
create index if not exists product_events_event_idx on public.product_events (event, occurred_at desc);
create index if not exists product_events_org_idx   on public.product_events (org_id, occurred_at desc) where org_id is not null;
-- For user deletion (FK set null) and forget_user_analytics, which would
-- otherwise scan the whole table.
create index if not exists product_events_user_idx  on public.product_events (user_id) where user_id is not null;

alter table public.product_events enable row level security;

drop policy if exists product_events_super_read on public.product_events;
create policy product_events_super_read on public.product_events
  for select using (public.is_super_admin());

revoke insert, update, delete on public.product_events from anon, authenticated;

comment on table public.product_events is
  'First-party product analytics. Client events only via track_event(); server events only via triggers on payments, subscriptions, organizations, profiles, pipeline_stages and api_keys. Readable by platform super admins. 13-month retention.';

-- ── 1. Server-side writer (definer-only, never granted) ─────────────────────
create or replace function public.log_product_event(
  p_event text, p_org uuid, p_user uuid, p_props jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.product_events (event, source, org_id, user_id, props)
  values (p_event, 'server', p_org, p_user, coalesce(p_props, '{}'::jsonb));
exception when others then
  raise warning 'product event % not recorded: %', p_event, sqlerrm;
end;
$$;

revoke all on function public.log_product_event(text, uuid, uuid, jsonb) from public, anon, authenticated;

-- ── 2. Browser-side writer ──────────────────────────────────────────────────
create or replace function public.track_event(
  p_event text, p_session text default null, p_path text default null, p_props jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array[
    'landing_view', 'pricing_view', 'product_view', 'contact_view',
    'login_view', 'login_link_requested', 'login_succeeded',
    'page_view', 'feature_used',
    'plan_selected', 'checkout_opened', 'checkout_returned'
  ];
  v_keys    text[] := array['plan', 'months', 'feature', 'route', 'referrer_host',
                            'utm_source', 'utm_medium', 'utm_campaign', 'result'];
  v_props   jsonb := '{}'::jsonb;
  v_session text;
  v_path    text;
  v_uid     uuid := auth.uid();
  v_ip      text;
  k         text;
  v         jsonb;
  rl        jsonb;
begin
  if p_event is null or not (p_event = any(v_allowed)) then return false; end if;

  v_session := case when p_session ~ '^[A-Za-z0-9_-]{8,64}$' then p_session else null end;
  -- Path only. Query strings and fragments carry magic-link tokens, order ids
  -- and anything a page chose to put there; none of it belongs in analytics.
  v_path := left(split_part(split_part(coalesce(p_path, ''), '?', 1), '#', 1), 200);
  if v_path = '' then v_path := null; end if;

  if jsonb_typeof(p_props) = 'object' then
    for k, v in select * from jsonb_each(p_props) loop
      if k = any(v_keys) and jsonb_typeof(v) in ('string', 'number', 'boolean') then
        v_props := v_props || jsonb_build_object(k, left(v #>> '{}', 80));
      end if;
    end loop;
  end if;

  -- Per caller and global caps. A flood is dropped silently: the browser does
  -- not wait on this call and has nothing useful to do with a refusal.
  --
  -- Anonymous callers are bucketed by client IP, not by the session id they
  -- send: a session id is caller-chosen, so keying on it would let a script
  -- mint a fresh bucket per request. PostgREST exposes the request headers;
  -- Cloudflare (in front of Supabase) sets cf-connecting-ip.
  begin
    v_ip := nullif(coalesce(
      current_setting('request.headers', true)::json->>'cf-connecting-ip',
      split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1)), '');
  exception when others then v_ip := null; end;

  -- If no IP header reaches PostgREST, fall back to the session id rather
  -- than one shared bucket that would drop every visitor's events.
  rl := public.hit_rate_limit('evt:' || coalesce(v_uid::text, 'ip:' || v_ip, 'sid:' || v_session, 'anon'), 60, 60);
  if (rl->>'allowed')::boolean is not true then return false; end if;
  if v_uid is null then
    -- ~860k rows/day at most even under sustained abuse; real traffic is a
    -- tiny fraction of this.
    rl := public.hit_rate_limit('evt:anon-global', 600, 60);
    if (rl->>'allowed')::boolean is not true then return false; end if;
  end if;

  insert into public.product_events (event, source, org_id, user_id, session_id, path, props)
  values (p_event, 'client',
          case when v_uid is null then null else public.my_org() end,
          v_uid, v_session, v_path, v_props);
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.track_event(text, text, text, jsonb) from public;
grant execute on function public.track_event(text, text, text, jsonb) to anon, authenticated;

-- ── 3. Triggers on the tables that hold the truth ───────────────────────────

-- Checkout and payment outcome. Status is written only by the service role
-- (billing-checkout creates 'created'; the verified webhook moves it on), so
-- these events are as trustworthy as the payments table itself.
create or replace function public.track_payment_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_product_event('checkout_started', new.org_id, new.created_by,
      jsonb_build_object('plan', new.plan, 'months', new.period_months, 'amount', new.amount, 'payment_id', new.id));
  elsif new.status is distinct from old.status then
    perform public.log_product_event(
      case new.status::text
        when 'paid'     then 'payment_succeeded'
        when 'failed'   then 'payment_failed'
        when 'dropped'  then 'payment_dropped'
        when 'refunded' then 'payment_refunded'
        else 'payment_' || new.status::text end,
      new.org_id, new.created_by,
      jsonb_build_object('plan', new.plan, 'months', new.period_months, 'amount', new.amount, 'payment_id', new.id));
  end if;
  return new;
exception when others then
  raise warning 'track_payment_event: %', sqlerrm;
  return new;
end $$;

drop trigger if exists payments_product_events on public.payments;
create trigger payments_product_events
  after insert or update of status on public.payments
  for each row execute function public.track_payment_event();

create or replace function public.track_subscription_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_product_event('subscription_activated', new.org_id, null,
      jsonb_build_object('plan', new.plan, 'period_end', new.current_period_end));
  elsif new.status is distinct from old.status then
    perform public.log_product_event('subscription_' || coalesce(new.status, 'unknown'), new.org_id, null,
      jsonb_build_object('plan', new.plan, 'from', old.status));
  elsif new.current_period_end > old.current_period_end then
    perform public.log_product_event(
      case when new.plan is distinct from old.plan then 'subscription_plan_changed' else 'subscription_renewed' end,
      new.org_id, null,
      jsonb_build_object('plan', new.plan, 'from_plan', old.plan, 'period_end', new.current_period_end));
  end if;
  return new;
exception when others then
  raise warning 'track_subscription_event: %', sqlerrm;
  return new;
end $$;

drop trigger if exists subscriptions_product_events on public.subscriptions;
create trigger subscriptions_product_events
  after insert or update on public.subscriptions
  for each row execute function public.track_subscription_event();

create or replace function public.track_org_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_product_event('workspace_created', new.id, auth.uid(),
    jsonb_build_object('plan', new.plan, 'industry', new.industry_slug));
  return new;
exception when others then
  raise warning 'track_org_created: %', sqlerrm;
  return new;
end $$;

drop trigger if exists organizations_product_events on public.organizations;
create trigger organizations_product_events
  after insert on public.organizations
  for each row execute function public.track_org_created();

create or replace function public.track_user_registered()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_product_event('user_registered', null, new.id, '{}'::jsonb);
  return new;
exception when others then
  raise warning 'track_user_registered: %', sqlerrm;
  return new;
end $$;

drop trigger if exists profiles_product_events on public.profiles;
create trigger profiles_product_events
  after insert on public.profiles
  for each row execute function public.track_user_registered();

-- Onboarding is complete when the workspace gets its pipeline: the app's own
-- definition (store.tsx: needsOnboarding = no stages). Logged once per org.
create or replace function public.track_onboarding_completed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.product_events
                  where org_id = new.org_id and event = 'onboarding_completed') then
    perform public.log_product_event('onboarding_completed', new.org_id, auth.uid(), '{}'::jsonb);
  end if;
  return new;
exception when others then
  raise warning 'track_onboarding_completed: %', sqlerrm;
  return new;
end $$;

drop trigger if exists pipeline_stages_product_events on public.pipeline_stages;
create trigger pipeline_stages_product_events
  after insert on public.pipeline_stages
  for each row execute function public.track_onboarding_completed();

create or replace function public.track_api_key_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_product_event('api_key_created', new.org_id, new.created_by,
    jsonb_build_object('scopes', new.scopes, 'rotation', new.rotated_from is not null));
  return new;
exception when others then
  raise warning 'track_api_key_created: %', sqlerrm;
  return new;
end $$;

drop trigger if exists api_keys_product_events on public.api_keys;
create trigger api_keys_product_events
  after insert on public.api_keys
  for each row execute function public.track_api_key_created();

-- ── 4. Retention and erasure ────────────────────────────────────────────────
create or replace function public.purge_product_events()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.product_events where occurred_at < now() - interval '13 months';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.purge_product_events() from public, anon, authenticated;

-- A DPDP erasure request for one person. Super admin only, and audited.
create or replace function public.forget_user_analytics(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_super_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  delete from public.product_events where user_id = p_user;
  get diagnostics n = row_count;
  perform public.log_admin_action('forget_user_analytics', null, jsonb_build_object('user_id', p_user, 'rows', n));
  return n;
end $$;

revoke all on function public.forget_user_analytics(uuid) from public, anon;
grant execute on function public.forget_user_analytics(uuid) to authenticated;

-- ── 5. The dashboard's single read ──────────────────────────────────────────
-- Platform-wide, so super admin only. Funnel steps that have a source of truth
-- in a real table are counted from that table, not from events, so the
-- dashboard is right about history from before this migration. Steps that only
-- exist as browser events say so via `client_events_since`.
create or replace function public.analytics_overview(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  d      integer := greatest(1, least(coalesce(p_days, 30), 400));
  since  timestamptz := now() - make_interval(days => d);
  out    jsonb;
begin
  if not public.is_super_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  with
  ev as (select * from public.product_events where occurred_at >= since),
  sess as (
    select event, count(distinct coalesce(session_id, user_id::text, id::text)) as n
      from ev where source = 'client' group by event
  ),
  orgs as (select id, created_at from public.organizations where created_at >= since),
  pays as (select * from public.payments where created_at >= since)
  select jsonb_build_object(
    'days', d,
    'client_events_since', (select min(occurred_at) from public.product_events where source = 'client'),
    'funnel', jsonb_build_array(
      jsonb_build_object('step', 'Visited landing page',     'count', coalesce((select n from sess where event = 'landing_view'), 0),         'basis', 'browser sessions'),
      jsonb_build_object('step', 'Viewed pricing',           'count', coalesce((select n from sess where event = 'pricing_view'), 0),         'basis', 'browser sessions'),
      jsonb_build_object('step', 'Requested sign-in link',   'count', coalesce((select n from sess where event = 'login_link_requested'), 0), 'basis', 'browser sessions'),
      jsonb_build_object('step', 'Created a workspace',      'count', (select count(*) from orgs),                                           'basis', 'organizations table'),
      -- Not "has a pipeline": create_organisation seeds the pipeline at once,
      -- so that step always equalled the one above it. A first real record is
      -- the first moment the product has done something for them.
      jsonb_build_object('step', 'Captured a first record',  'count', (select count(*) from orgs o where exists (select 1 from public.leads l where l.org_id = o.id)), 'basis', 'workspaces with any record'),
      jsonb_build_object('step', 'Opened checkout',          'count', (select count(distinct org_id) from pays),                             'basis', 'payments table'),
      jsonb_build_object('step', 'Paid',                     'count', (select count(distinct org_id) from pays where status = 'paid'),      'basis', 'verified payment webhook')
    ),
    'activation', jsonb_build_object(
      'new_workspaces',               (select count(*) from orgs),
      -- Same basis as the funnel step: any record ever, archived included.
      'with_a_record',                (select count(*) from orgs o where exists (select 1 from public.leads l where l.org_id = o.id)),
      'with_a_second_member',         (select count(*) from orgs o where (select count(*) from public.profiles p where p.org_id = o.id and p.status = 'active') > 1),
      'users_signed_in_in_period',    (select count(*) from auth.users u where u.last_sign_in_at >= since)
    ),
    'payments', jsonb_build_object(
      'started',   (select count(*) from pays),
      'paid',      (select count(*) from pays where status = 'paid'),
      'failed',    (select count(*) from pays where status = 'failed'),
      'dropped',   (select count(*) from pays where status = 'dropped'),
      'pending',   (select count(*) from pays where status = 'created'),
      'refunded',  (select count(*) from pays where status = 'refunded'),
      'revenue_inr', (select coalesce(sum(amount), 0) from pays where status = 'paid'),
      'abandoned', (select count(*) from pays p
                     where p.status in ('created', 'dropped', 'failed')
                       and p.created_at < now() - interval '1 hour'
                       and not exists (select 1 from public.payments q
                                        where q.org_id = p.org_id and q.status = 'paid' and q.created_at >= p.created_at))
    ),
    'api', jsonb_build_object(
      'active_keys',       (select count(*) from public.api_keys where revoked_at is null and (expires_at is null or expires_at > now())),
      'orgs_with_keys',    (select count(distinct org_id) from public.api_keys where revoked_at is null),
      'keys_used_in_period', (select count(*) from public.api_keys where last_used_at >= since),
      'total_calls',       (select coalesce(sum(use_count), 0) from public.api_keys)
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'event', event, 'count', n) order by day, event)
        from (select date_trunc('day', occurred_at)::date as day, event, count(*) as n
                from ev
               where event in ('landing_view', 'pricing_view', 'login_link_requested', 'login_succeeded',
                               'workspace_created', 'checkout_started', 'payment_succeeded')
               group by 1, 2) x), '[]'::jsonb),
    'top_events', coalesce((
      select jsonb_agg(jsonb_build_object('event', event, 'source', source, 'count', n) order by n desc)
        from (select event, source, count(*) as n from ev group by 1, 2 order by 3 desc limit 25) x), '[]'::jsonb),
    'top_features', coalesce((
      select jsonb_agg(jsonb_build_object('route', route, 'users', users, 'views', n) order by users desc)
        from (select path as route, count(distinct user_id) as users, count(*) as n
                from ev where event = 'page_view' and path is not null
               group by 1 order by 2 desc limit 15) x), '[]'::jsonb)
  ) into out;

  return out;
end;
$$;

revoke all on function public.analytics_overview(integer) from public, anon;
grant execute on function public.analytics_overview(integer) to authenticated;

commit;

-- ── 6. Daily retention job (outside the transaction — cron.schedule commits) ─
select cron.unschedule('purge-product-events')
  where exists (select 1 from cron.job where jobname = 'purge-product-events');
select cron.schedule('purge-product-events', '25 3 * * *', $$select public.purge_product_events();$$);

-- Plain SQL, so its own cron success IS the work: map it into the heartbeat
-- sync the same way purge-archived is (see 20260924093000).
insert into public.cron_job_heartbeat_map (cron_jobname, job_name, note)
values ('purge-product-events', 'purge-product-events', 'plain SQL: select public.purge_product_events()')
on conflict (cron_jobname) do nothing;

insert into public.job_heartbeats (job_name, stale_after, last_status, last_detail, watch)
values ('purge-product-events', interval '48 hours', 'ok', 'seeded 13 Oct — awaiting first sync from cron.job_run_details', true)
on conflict (job_name) do update set stale_after = excluded.stale_after;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — static. Expect every row PASS.
-- ════════════════════════════════════════════════════════════════════════════
select 'events table, super-admin read only' as check,
       case when to_regclass('public.product_events') is not null
             and not has_table_privilege('authenticated', 'public.product_events', 'INSERT')
             and not has_table_privilege('anon', 'public.product_events', 'INSERT')
            then 'PASS' else 'FAIL' end as result
union all
select 'browser can call track_event',
       case when has_function_privilege('anon', 'public.track_event(text, text, text, jsonb)', 'EXECUTE')
            then 'PASS' else 'FAIL' end
union all
select 'browser cannot call the server writer',
       case when has_function_privilege('anon', 'public.log_product_event(text, uuid, uuid, jsonb)', 'EXECUTE')
              or has_function_privilege('authenticated', 'public.log_product_event(text, uuid, uuid, jsonb)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'six source-of-truth triggers installed',
       case when (select count(*) from pg_trigger where not tgisinternal and tgname in
                   ('payments_product_events', 'subscriptions_product_events', 'organizations_product_events',
                    'profiles_product_events', 'pipeline_stages_product_events', 'api_keys_product_events')) = 6
            then 'PASS' else 'FAIL' end
union all
select 'track_event refuses unknown events',
       case when public.track_event('drop_table_users', null, null, '{}'::jsonb) = false then 'PASS' else 'FAIL' end
union all
select 'retention job scheduled',
       case when exists (select 1 from cron.job where jobname = 'purge-product-events') then 'PASS' else 'FAIL' end;
