-- AbroBot CRM — final pre-launch hardening.
--
-- Five separate problems, all found by auditing what the code actually does
-- rather than what its comments claim. Each section says what breaks without
-- the fix.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. A webhook must never be able to destroy lead capture
-- ════════════════════════════════════════════════════════════════════════════
-- notify_lead_change() wrapped the *automation* dispatch in an exception
-- handler, with a comment explaining exactly why:
--
--     "Never let automation dispatch block the write that triggered it. A lead
--      saved without its automation is recoverable; a lead lost because Zapier
--      was slow is not."
--
-- Correct — and the two fire_webhooks() calls immediately above it were left
-- outside that protection. It is an AFTER INSERT trigger on public.leads, so a
-- raise inside fire_webhooks aborts the insert on ALL FIVE creation paths at
-- once: chat widget, capture URL, CSV import, manual add, and the API.
--
-- This has not bitten yet for a reason worth writing down: fire_webhooks loops
-- over webhook_endpoints, and with no endpoints configured the loop body never
-- executes, so the broken pgcrypto hmac() call inside it was never reached.
-- The moment a customer adds their first webhook endpoint, that protection
-- disappears. The same rule has to apply to both dispatches.

create or replace function public.notify_lead_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb;
  evt     text;
begin
  payload := jsonb_build_object(
    'id', new.id, 'name', new.name, 'email', new.email, 'phone', new.phone,
    'source', new.source, 'stage', new.stage_key, 'score', new.score,
    'assigned_to', new.assigned_to, 'tags', new.tags, 'custom', new.custom,
    'created_at', new.created_at
  );

  if tg_op = 'INSERT' then
    evt := 'lead_created';
  elsif new.stage_key is distinct from old.stage_key then
    evt := 'stage_changed';
    payload := payload || jsonb_build_object('previous_stage', old.stage_key);
  else
    return new;
  end if;

  -- Outbound webhooks. Now inside a handler, for the same reason as below.
  begin
    perform public.fire_webhooks(
      new.org_id,
      case when evt = 'lead_created' then 'lead.created' else 'lead.stage_changed' end,
      payload);
  exception when others then
    raise warning 'webhook dispatch failed for lead %: %', new.id, sqlerrm;
  end;

  -- Event-driven automations, fired from here rather than from application
  -- code, because fireEventAutomations() was imported by exactly ONE of the
  -- five paths that create a lead. A trigger is the only place that sees every
  -- write regardless of who made it.
  begin
    perform public.call_edge_function(
      'run-automations',
      jsonb_build_object('event', evt, 'lead_id', new.id, 'org_id', new.org_id)
    );
  exception when others then
    raise warning 'automation dispatch failed for lead %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. SECURITY DEFINER functions that anon can still execute
-- ════════════════════════════════════════════════════════════════════════════
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function. A
-- later `grant execute ... to authenticated` does NOT displace that — it adds
-- to it. So a function that looks locked down by its grant line is still
-- callable by `anon`, i.e. by anyone holding the publishable key that ships in
-- the browser bundle.
--
-- Four of these take an arbitrary p_org_id and perform no authorization check
-- in the body, because they were written to be called by other SECURITY
-- DEFINER functions. Left open, they let a stranger enumerate any
-- organisation's plan, limits, seat cap and expiry date.
--
-- Verified before revoking: app/src calls only apply_industry_pack and
-- usage_snapshot; both check the caller internally and keep their grant. The
-- edge functions use the service role, which grants do not constrain.

do $$
declare
  f text;
  -- Callable by nobody but the service role and other definer functions.
  internal text[] := array[
    'public.plan_of(uuid)',
    'public.effective_plan(uuid)',
    'public.plan_allows_whatsapp(uuid)',
    'public.plan_seat_cap(uuid)',
    'public.ensure_profile()',
    'public.record_heartbeat(text, text, text)',
    -- Platform-wide, not per-tenant: stale_jobs bypasses its own table's
    -- super-admin policy, and recent_cron_failures reads net._http_response,
    -- which holds the HTTP result of every tenant's outbound calls. It was
    -- granted to `authenticated` — every logged-in customer.
    'public.stale_jobs()',
    'public.recent_cron_failures(integer)'
  ];
begin
  foreach f in array internal loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', f);
    else
      raise notice 'skipping % (does not exist)', f;
    end if;
  end loop;

  -- These two ARE for the browser, but must not be reachable anonymously.
  -- Revoke from PUBLIC first, then grant, or the revoke is a no-op.
  foreach f in array array['public.apply_industry_pack(uuid, text)',
                           'public.usage_snapshot(uuid)'] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon', f);
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Webhook deliveries that never record what happened
-- ════════════════════════════════════════════════════════════════════════════
-- fire_webhooks inserts a delivery row and never returns to it, because
-- net.http_post is fire-and-forget and its result lands in net._http_response.
-- Nothing joined that back. So webhook_deliveries.status_code / error /
-- duration_ms were always NULL, and webhook_endpoints.failure_count /
-- last_status / last_error / last_success_at were written by nothing.
--
-- The Integrations screen renders those four columns. A customer whose
-- endpoint returns 500 on every event sees "never delivered, no failures"
-- forever. The table comment promised "here is the 500 your server returned at
-- 14:03"; that promise is kept here.
--
-- The migration also referred to "the auto-disable in deliver_webhooks()".
-- No function of that name exists anywhere, so dead endpoints were retried
-- indefinitely. That is written now too.

alter table public.webhook_deliveries
  add column if not exists request_id bigint;

create index if not exists webhook_deliveries_request_id
  on public.webhook_deliveries (request_id) where request_id is not null;

comment on column public.webhook_deliveries.request_id is
  'pg_net request id, so the response can be matched back to this row once it arrives.';

-- fire_webhooks, rebuilt to remember the request id.
create or replace function public.fire_webhooks(
  p_org_id uuid, p_event text, p_payload jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  ep   record;
  body jsonb;
  sig  text;
  rid  bigint;
  n    integer := 0;
begin
  for ep in
    select * from public.webhook_endpoints
     where org_id = p_org_id and active and p_event = any(events)
  loop
    body := jsonb_build_object(
      'event', p_event,
      'org_id', p_org_id,
      'created_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'data', p_payload
    );

    sig := encode(hmac(body::text, ep.secret, 'sha256'), 'hex');

    select net.http_post(
      url     := ep.url,
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'X-AbroBot-Event', p_event,
                   'X-AbroBot-Signature', 'sha256=' || sig
                 ),
      body    := body,
      timeout_milliseconds := 8000
    ) into rid;

    insert into public.webhook_deliveries (endpoint_id, org_id, event, payload, request_id)
    values (ep.id, p_org_id, p_event, body, rid);

    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke all on function public.fire_webhooks(uuid, text, jsonb) from public, anon, authenticated;

-- Match pg_net's responses back onto the delivery rows, roll the endpoint's
-- health forward, and disable an endpoint that has failed 20 times running.
create or replace function public.reconcile_webhook_deliveries()
returns integer
language plpgsql
security definer
set search_path = public, net
as $$
declare
  d record;
  n integer := 0;
begin
  for d in
    select wd.id, wd.endpoint_id, wd.request_id,
           r.status_code, r.error_msg
      from public.webhook_deliveries wd
      join net._http_response r on r.id = wd.request_id
     where wd.request_id is not null
       and wd.status_code is null
     limit 500
  loop
    update public.webhook_deliveries
       set status_code = d.status_code,
           error       = d.error_msg
     where id = d.id;

    if d.status_code between 200 and 299 then
      update public.webhook_endpoints
         set failure_count = 0, last_status = d.status_code,
             last_error = null, last_success_at = now()
       where id = d.endpoint_id;
    else
      update public.webhook_endpoints
         set failure_count = failure_count + 1,
             last_status = d.status_code,
             last_error = coalesce(d.error_msg, 'HTTP ' || coalesce(d.status_code::text, '?')),
             -- Twenty consecutive failures is a dead endpoint, not a blip.
             -- Retrying it forever wastes our budget and buries the real
             -- signal. The customer can re-enable it once they have fixed it.
             active = case when failure_count + 1 >= 20 then false else active end
       where id = d.endpoint_id;
    end if;

    n := n + 1;
  end loop;

  return n;
end;
$$;

revoke all on function public.reconcile_webhook_deliveries() from public, anon, authenticated;

comment on function public.reconcile_webhook_deliveries() is
  'Joins pg_net responses back onto webhook_deliveries, updates endpoint health, and disables an endpoint after 20 consecutive failures. Scheduled every 5 minutes.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. The email allowance was invisible on the Plan & usage screen
-- ════════════════════════════════════════════════════════════════════════════
-- usage_snapshot() feeds Settings → Plan & usage, which shows four meters. It
-- was never extended with the email allowance — the tightest cap in the
-- product (50/month on trial) and the only one whose limit is other people's
-- deliverability. A customer should not discover it mid-send.

-- Extended from the definition in 20260821080000, key for key. I first
-- rewrote this from scratch and dropped `plan`, `period`, `access_until` and
-- `days_left` — all four of which Settings reads — which would have broken the
-- Plan & usage screen to add a meter to it. Copy the original, add one block.
create or replace function public.usage_snapshot(p_org_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_org    record;
  v_eff    text;
  v_limits public.plan_limits%rowtype;
  v_until  timestamptz;
  v_ai integer; v_leads integer; v_seats integer; v_autos integer; v_emails integer;
begin
  if not (public.is_super_admin() or (p_org_id = public.my_org() and public.is_active_member())) then
    raise exception 'not authorised';
  end if;

  select plan, trial_started_at, trial_days into v_org
    from public.organizations where id = p_org_id;

  v_eff := public.effective_plan(p_org_id);
  select * into v_limits from public.plan_limits where plan = v_eff;

  if v_org.plan = 'trial' then
    v_until := v_org.trial_started_at + make_interval(days => coalesce(v_org.trial_days, 7));
  else
    select current_period_end into v_until from public.subscriptions where org_id = p_org_id;
  end if;

  select coalesce(value, 0) into v_ai from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'ai_messages';
  select coalesce(value, 0) into v_emails from public.usage_counters
   where org_id = p_org_id and period = v_period and metric = 'emails';
  select count(*) into v_leads from public.leads      where org_id = p_org_id;
  select count(*) into v_seats from public.profiles   where org_id = p_org_id and status = 'active';
  select count(*) into v_autos from public.automations where org_id = p_org_id and enabled;

  return jsonb_build_object(
    'plan',           v_eff,
    'purchased_plan', coalesce(v_org.plan, 'trial'),
    'label',          coalesce(v_limits.label, 'Free trial'),
    'period',         v_period,
    'is_expired',     v_eff = 'expired',
    'access_until',   v_until,
    'days_left',      case when v_until is null then null
                           else greatest(0, ceil(extract(epoch from (v_until - now())) / 86400)::int) end,
    'ai_messages', jsonb_build_object('used', coalesce(v_ai, 0),     'limit', v_limits.max_ai_messages),
    'emails',      jsonb_build_object('used', coalesce(v_emails, 0), 'limit', v_limits.max_emails),
    'leads',       jsonb_build_object('used', v_leads,               'limit', v_limits.max_leads),
    'seats',       jsonb_build_object('used', v_seats,               'limit', v_limits.max_seats),
    'automations', jsonb_build_object('used', v_autos,               'limit', v_limits.max_automations),
    'whatsapp',    coalesce(v_limits.whatsapp, false)
  );
end;
$$;

revoke all on function public.usage_snapshot(uuid) from public, anon;
grant execute on function public.usage_snapshot(uuid) to authenticated;

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Schedule the reconciler  (outside the transaction — cron.schedule commits)
-- ════════════════════════════════════════════════════════════════════════════
select cron.unschedule('reconcile-webhooks')
 where exists (select 1 from cron.job where jobname = 'reconcile-webhooks');

select cron.schedule('reconcile-webhooks', '*/5 * * * *',
  $$select public.reconcile_webhook_deliveries();$$);

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect every row PASS.
select 'fire_webhooks wrapped in notify_lead_change' as check,
       case when (select prosrc from pg_proc where oid = 'public.notify_lead_change()'::regprocedure)
                 ~ 'begin\s+perform public\.fire_webhooks'
            then 'PASS' else 'FAIL — a webhook error can still abort lead capture' end as result
union all
select 'anon cannot read another org''s plan',
       case when has_function_privilege('anon', 'public.plan_of(uuid)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'authenticated cannot read platform job status',
       case when has_function_privilege('authenticated', 'public.stale_jobs()', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'authenticated cannot read every tenant''s HTTP results',
       case when has_function_privilege('authenticated', 'public.recent_cron_failures(integer)', 'EXECUTE')
            then 'FAIL' else 'PASS' end
union all
select 'usage_snapshot reports the email allowance',
       case when (public.usage_snapshot((select id from public.organizations order by created_at limit 1))
                  ? 'emails')
            then 'PASS' else 'FAIL' end
union all
select 'webhook reconciler is scheduled',
       case when exists (select 1 from cron.job where jobname = 'reconcile-webhooks')
            then 'PASS' else 'FAIL' end
union all
select 'reconciler runs',
       case when public.reconcile_webhook_deliveries() >= 0 then 'PASS' else 'FAIL' end;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Rate-limit the one endpoint that has to stay open
-- ════════════════════════════════════════════════════════════════════════════
-- chat-agent is called by the widget on a visitor's browser, so it cannot
-- require a key — the org comes from the page. That is unavoidable and fine.
-- What was missing is any limit at all, and slugs are public (they are in the
-- embed snippet everyone can read). So anyone could:
--
--   * drain a competitor's monthly AI allowance to zero, at which point their
--     widget starts telling real prospects it is "taking a short break";
--   * burn their Groq key, which they pay for;
--   * push junk records into their pipeline.
--
-- A counter per (org, caller, minute). Not a defence against a determined
-- distributed attacker — nothing at this layer is — but it turns "one script,
-- one afternoon, allowance gone" into something that needs real effort, and it
-- costs one upsert per message.

create table if not exists public.rate_limits (
  bucket     text primary key,           -- org:caller:minute
  hits       integer not null default 0,
  expires_at timestamptz not null
);

alter table public.rate_limits enable row level security;
-- No policies: the service role bypasses RLS, and nobody else has any business
-- reading this.

create index if not exists rate_limits_expires on public.rate_limits (expires_at);

create or replace function public.hit_rate_limit(
  p_key text, p_limit integer, p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text;
  v_hits   integer;
begin
  -- The window is part of the key, so expiry is implicit: a new window is a
  -- new row, and old rows are swept below rather than needing a scheduled job
  -- to reset counters.
  v_bucket := p_key || ':' || (floor(extract(epoch from now()) / p_window_seconds))::bigint;

  insert into public.rate_limits (bucket, hits, expires_at)
  values (v_bucket, 1, now() + make_interval(secs => p_window_seconds * 2))
  on conflict (bucket) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;

  -- Opportunistic cleanup, ~1 call in 100, so the table cannot grow forever
  -- without adding another cron job to forget about.
  if random() < 0.01 then
    delete from public.rate_limits where expires_at < now();
  end if;

  return jsonb_build_object('allowed', v_hits <= p_limit, 'hits', v_hits, 'limit', p_limit);
end;
$$;

revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;

comment on function public.hit_rate_limit(text, integer, integer) is
  'Fixed-window counter. Used by chat-agent, which cannot authenticate its callers because it serves a public website widget.';
