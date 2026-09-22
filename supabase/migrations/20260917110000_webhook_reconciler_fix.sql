-- AbroBot CRM — stop the reconciler disabling healthy endpoints. (Audit B8.)
--
-- ════════════════════════════════════════════════════════════════════════════
-- The bug
-- ════════════════════════════════════════════════════════════════════════════
-- reconcile_webhook_deliveries() selects rows to process with:
--
--     where wd.request_id is not null and wd.status_code is null
--
-- so `status_code is null` means "not reconciled yet". It then writes the
-- response's status_code back onto the row.
--
-- But a pg_net *timeout* has status_code = NULL. Writing NULL back leaves the
-- row matching the selection predicate, so the next run five minutes later
-- picks it up again, and increments failure_count again, and so on — one slow
-- response is recounted as a fresh failure twelve times an hour.
--
-- Twenty consecutive failures disables the endpoint. A customer whose server
-- answers in, say, six seconds when pg_net's patience is five is therefore
-- disabled roughly **100 minutes** after their first slow reply, by a counter
-- that measured one event twenty times. Integrations.tsx renders no active
-- badge and no resume control for outbound endpoints, so there is no way back
-- from inside the product.
--
-- The shape is the one this codebase keeps producing: a single value asked to
-- carry two meanings. `status_code is null` means both "we have not looked at
-- this yet" and "the request did not complete", and the code cannot tell which
-- it is holding.
--
-- ════════════════════════════════════════════════════════════════════════════
-- The fix
-- ════════════════════════════════════════════════════════════════════════════
-- Give "have we looked at this" its own column. reconciled_at is set exactly
-- once, unconditionally, whatever the outcome — so a timeout is recorded as a
-- timeout, counted as one failure, and never seen again.

begin;

-- ── 1. A marker that means only one thing ───────────────────────────────────

alter table public.webhook_deliveries
  add column if not exists reconciled_at timestamptz;

comment on column public.webhook_deliveries.reconciled_at is
  'When the pg_net response for this delivery was matched back onto the row. Separate from status_code because a timeout has no status code, and using its absence as the "not yet processed" flag made every timeout re-count as a fresh failure on each five-minute run.';

-- Backfill: anything that already has a status code was plainly reconciled.
-- Rows still lacking one are left unmarked on purpose — they will be picked up
-- by the corrected function on its next run, counted once, and then marked.
update public.webhook_deliveries
   set reconciled_at = coalesce(reconciled_at, created_at)
 where status_code is not null and reconciled_at is null;

-- The scan predicate, so this stays cheap as the table grows. Partial: once a
-- row is reconciled it is never selected again, so the index only ever holds
-- the small unprocessed tail.
create index if not exists webhook_deliveries_unreconciled_idx
  on public.webhook_deliveries (request_id)
  where reconciled_at is null and request_id is not null;

-- ── 2. Undo the damage the bug has already done ─────────────────────────────
-- Every failure_count in this table was produced by the broken counter, so not
-- one of them is trustworthy. Zero them all and re-enable everything that was
-- switched off.
--
-- I first tried to be surgical about this — repair only endpoints carrying the
-- bug's fingerprint, leave the ones killed by genuine 500s alone. There is no
-- sound fingerprint. A null status_code is equally consistent with "timed out
-- and was re-counted twenty times" and with "sent four minutes ago and the
-- response has not landed yet", and net._http_response self-purges within
-- hours, so the older the damage the less evidence survives. Any rule I wrote
-- would have been a guess dressed as a diagnosis.
--
-- So: the blunt repair, and it is the right one, because the two ways of being
-- wrong are not symmetric. Re-enabling a genuinely dead endpoint costs twenty
-- more delivery attempts, after which the corrected counter disables it again
-- — self-correcting within a couple of hours. Leaving a wrongly-disabled
-- endpoint off is silent, permanent, and (until the Resume button added
-- alongside this migration) unrecoverable from inside the product.
--
-- last_error is preserved rather than overwritten, so a customer looking at an
-- endpoint that goes straight back to failing still sees the real reason.
update public.webhook_endpoints
   set failure_count = 0,
       active        = true
 where failure_count > 0 or not active;

-- ── 3. The corrected reconciler ─────────────────────────────────────────────

create or replace function public.reconcile_webhook_deliveries()
returns integer
language plpgsql
security definer
set search_path = public, net
as $$
declare
  d record;
  n integer := 0;
  v_failed boolean;
  v_error  text;
begin
  for d in
    select wd.id, wd.endpoint_id, wd.request_id,
           r.status_code, r.error_msg, r.timed_out
      from public.webhook_deliveries wd
      join net._http_response r on r.id = wd.request_id
     where wd.request_id is not null
       -- Was `wd.status_code is null`. That is the bug: a timeout has no
       -- status code, so the row stayed selectable forever.
       and wd.reconciled_at is null
     order by wd.created_at
     limit 500
  loop
    -- NULL is not a success. `between` on NULL yields NULL, which is not true,
    -- so this is a failure — but now it is a failure that gets *named*, and
    -- counted exactly once.
    v_failed := d.status_code is null or d.status_code not between 200 and 299;

    v_error := case
                 when d.error_msg is not null and d.error_msg <> '' then d.error_msg
                 when coalesce(d.timed_out, false) then 'Timed out waiting for your server'
                 when d.status_code is null then 'No response recorded'
                 else 'HTTP ' || d.status_code::text
               end;

    update public.webhook_deliveries
       set status_code   = d.status_code,
           error         = case when v_failed then v_error else null end,
           -- Set unconditionally, on every path. This single line is the fix:
           -- whatever happened, this row has now been accounted for.
           reconciled_at = now()
     where id = d.id;

    if not v_failed then
      update public.webhook_endpoints
         set failure_count = 0, last_status = d.status_code,
             last_error = null, last_success_at = now()
       where id = d.endpoint_id;
    else
      update public.webhook_endpoints
         set failure_count = failure_count + 1,
             last_status   = d.status_code,
             last_error    = v_error,
             -- Twenty consecutive failures is a dead endpoint, not a blip.
             -- This threshold is unchanged; what changed is that reaching it
             -- now requires twenty distinct failed deliveries rather than one
             -- slow delivery observed twenty times.
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
  'Joins pg_net responses back onto webhook_deliveries, updates endpoint health, and disables an endpoint after 20 consecutive genuinely failed deliveries. Each delivery is accounted for exactly once, via reconciled_at. Scheduled every 5 minutes.';

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as ord, 'reconciled_at exists' as check,
         coalesce((select 'PASS' from information_schema.columns
                    where table_schema = 'public' and table_name = 'webhook_deliveries'
                      and column_name = 'reconciled_at'), 'FAIL') as detail

  union all
  select 2, 'the function no longer keys off status_code',
         case when pg_get_functiondef('public.reconcile_webhook_deliveries()'::regprocedure)
                   like '%wd.reconciled_at is null%'
               and pg_get_functiondef('public.reconcile_webhook_deliveries()'::regprocedure)
                   not like '%and wd.status_code is null%'
              then 'PASS' else 'FAIL — still selecting on status_code' end

  union all
  select 3, 'deliveries that would have been re-counted forever',
         (select count(*)::text || ' row(s) with a response but no status code'
            from public.webhook_deliveries wd
            join net._http_response r on r.id = wd.request_id
           where r.status_code is null)

  union all
  select 4, 'endpoint state after the repair',
         coalesce((select string_agg(url || ' — ' || case when active then 'active' else 'PAUSED' end
                                     || ', ' || failure_count || ' failures'
                                     || coalesce(', last error: ' || left(last_error, 60), ''), '; ')
                     from public.webhook_endpoints), 'no endpoints configured')

  union all
  select 5, 'any endpoint still disabled',
         coalesce((select count(*)::text from public.webhook_endpoints where not active), '0')

  union all
  select 6, 'unreconciled backlog',
         (select count(*)::text || ' delivery row(s) awaiting the next 5-minute run'
            from public.webhook_deliveries where reconciled_at is null and request_id is not null)
) t order by ord;
