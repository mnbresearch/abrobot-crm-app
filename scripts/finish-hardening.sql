-- Run this now. Everything else in 20260906100000 already committed.
--
-- WHAT HAPPENED: that migration's `commit;` sits after section 4, so sections
-- 1-5 are applied and persistent. The verification block that follows then
-- errored — my mistake, not the migration's: it CALLED usage_snapshot(), which
-- raises 'not authorised' unless the caller is a super-admin or a member of the
-- org, and in the SQL editor you are `postgres`, where auth.uid() is null.
--
-- Two consequences. The check was a guaranteed failure of the *check* rather
-- than of the thing checked — it now reads the function's source instead. And
-- because the failure aborted the rest of the script, section 6 (the chat
-- widget rate limiter) never ran. That is what this file is.
--
-- chat-agent is already deployed calling hit_rate_limit(). It reads only
-- `data` from that RPC, so with the function missing it fails OPEN — the widget
-- keeps working, with no rate limiting. Not broken, just unprotected, until
-- this runs.

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
       -- Reads the function's SOURCE rather than calling it. usage_snapshot
       -- raises 'not authorised' unless the caller is a super-admin or a member
       -- of the org — and in the SQL editor you are `postgres`, where
       -- auth.uid() is null. Calling it here is a guaranteed failure of the
       -- check rather than of the thing being checked.
       case when (select prosrc from pg_proc
                   where oid = 'public.usage_snapshot(uuid)'::regprocedure) like '%''emails''%'
            then 'PASS' else 'FAIL — the email meter is missing from the snapshot' end
union all
select 'webhook reconciler is scheduled',
       case when exists (select 1 from cron.job where jobname = 'reconcile-webhooks')
            then 'PASS' else 'FAIL' end
union all
select 'reconciler runs',
       case when public.reconcile_webhook_deliveries() >= 0 then 'PASS' else 'FAIL' end
union all
select 'rate limiter exists',
       case when to_regprocedure('public.hit_rate_limit(text, integer, integer)') is not null
            then 'PASS' else 'FAIL — chat-agent calls this; without it there is no limit' end
union all
select 'rate limiter counts',
       case when (public.hit_rate_limit('selftest', 1000, 60) ->> 'allowed')::boolean
            then 'PASS' else 'FAIL' end;

