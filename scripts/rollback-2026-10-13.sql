-- AbroBot CRM — switch OFF everything the 13 October 2026 release added to the
-- database, without deleting any data.
--
-- Use only if one of the new triggers is suspected of interfering with
-- payments, signup or API keys. It removes the TRIGGERS and the CRON JOBS and
-- closes the browser entry point; it leaves every table, row, function and
-- column in place, so re-applying scripts/apply-2026-10-13.sql restores it all.
--
-- The API keeps working either way: resolve_api_key and create_api_key were
-- never changed.

-- API key guard rails and history
drop trigger if exists api_keys_guard_update on public.api_keys;
drop trigger if exists api_keys_guard_insert on public.api_keys;
drop trigger if exists api_keys_log_insert   on public.api_keys;
drop trigger if exists api_keys_log_update   on public.api_keys;

-- Product analytics capture
drop trigger if exists payments_product_events        on public.payments;
drop trigger if exists subscriptions_product_events   on public.subscriptions;
drop trigger if exists organizations_product_events   on public.organizations;
drop trigger if exists profiles_product_events        on public.profiles;
drop trigger if exists pipeline_stages_product_events on public.pipeline_stages;
drop trigger if exists api_keys_product_events        on public.api_keys;
revoke execute on function public.track_event(text, text, text, jsonb) from anon, authenticated;

-- Scheduled jobs
select cron.unschedule('purge-product-events')
  where exists (select 1 from cron.job where jobname = 'purge-product-events');
select cron.unschedule('abrobot-checkout-recovery')
  where exists (select 1 from cron.job where jobname = 'abrobot-checkout-recovery');
update public.job_heartbeats set watch = false
 where job_name in ('purge-product-events', 'checkout-recovery');

-- Reminders off (the function also refuses to send while disabled)
update public.checkout_recovery_settings set enabled = false, dry_run = true where id;

select 'rolled back: triggers removed, jobs unscheduled, reminders off — no data deleted' as result;
