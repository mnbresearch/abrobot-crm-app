-- Prove the plan limits actually bite — WITHOUT touching a live organisation.
--
-- Why this exists: all four of our organisations are on enterprise, which is
-- unlimited and never expires. Correct for us, but it means none of the
-- enforcement added in 20260821080000 is exercised by normal use. The first
-- time that code runs for real would otherwise be against a paying customer,
-- which is the worst possible place to find a mistake.
--
-- Everything runs inside a transaction that ROLLS BACK. Nothing persists — not
-- the test org, not the temporary edits to plan_limits.
--
-- Run the WHOLE file in one go. The Supabase editor shows only the last result
-- set and hides RAISE NOTICE, so every check writes into one table that is
-- selected at the end.

begin;

-- A REGULAR table, not a temporary one. Temp tables live in a per-session
-- schema, and the Supabase SQL editor talks through a connection pooler, so
-- the DO block below can execute on a different session than the CREATE — and
-- then `results` genuinely does not exist. A normal table has no such problem,
-- and the ROLLBACK at the end removes it just the same.
drop table if exists public.zz_enforcement_results;
create table public.zz_enforcement_results (
  seq        serial,
  check_name text,
  expected   text,
  got        text,
  verdict    text
);

do $$
declare
  org   uuid;
  v     text;
  n     integer;
begin
  -- ── setup: a throwaway org on the cheapest paid plan ─────────────────────
  insert into public.organizations
    (name, slug, active, plan, trial_started_at, trial_days, credits_total, credits_used)
  values
    ('ZZ Enforcement Test', 'zz-test-' || substr(md5(random()::text), 1, 8),
     true, 'starter', now(), 7, 0, 0)
  returning id into org;

  -- ── 1. Starter must NOT have WhatsApp ────────────────────────────────────
  v := public.plan_allows_whatsapp(org)::text;
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('WhatsApp blocked on Starter', 'false', v,
          case when v = 'false' then 'PASS' else 'FAIL' end);

  -- ── 2. Growth must have it ───────────────────────────────────────────────
  update public.organizations set plan = 'growth' where id = org;
  v := public.plan_allows_whatsapp(org)::text;
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('WhatsApp allowed on Growth', 'true', v,
          case when v = 'true' then 'PASS' else 'FAIL' end);

  -- ── 3. A subscription 30 days lapsed expires ─────────────────────────────
  insert into public.subscriptions (org_id, plan, status, current_period_end)
  values (org, 'growth', 'active', now() - interval '30 days');

  v := public.effective_plan(org);
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('Lapsed 30d -> effective plan', 'expired', v,
          case when v = 'expired' then 'PASS' else 'FAIL' end);

  v := public.plan_allows_whatsapp(org)::text;
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('Lapsed 30d -> WhatsApp revoked', 'false', v,
          case when v = 'false' then 'PASS' else 'FAIL' end);

  -- ── 4. Within the 3-day grace window, access is retained ─────────────────
  update public.subscriptions set current_period_end = now() - interval '1 day'
   where org_id = org;
  v := public.effective_plan(org);
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('Lapsed 1d (inside grace) -> still live', 'growth', v,
          case when v = 'growth' then 'PASS' else 'FAIL' end);

  -- ── 5. Seats follow the EFFECTIVE plan, not the purchased one ────────────
  v := public.plan_seat_cap(org)::text;
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('Seat cap while live', '10', v,
          case when v = '10' then 'PASS' else 'FAIL' end);

  update public.subscriptions set current_period_end = now() - interval '30 days'
   where org_id = org;
  v := public.plan_seat_cap(org)::text;
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('Seat cap once expired', '1', v,
          case when v = '1' then 'PASS' else 'FAIL' end);

  -- ── 6. An unrecognised plan must fail CLOSED ─────────────────────────────
  -- There is no FK on organizations.plan, so before the fix a typo produced a
  -- NULL limit — and every guard reads NULL as "unlimited".
  --
  -- The lapsed subscription from step 5 MUST be cleared first. Leaving it in
  -- place sends effective_plan down the expiry branch, which returns 'expired'
  -- before the unknown-plan fallback is ever reached — so the check passes or
  -- fails on the wrong code path entirely. (This is exactly what happened on
  -- the first run: got 0, the expired cap, not 100.)
  delete from public.subscriptions where org_id = org;

  update public.organizations set plan = 'gorwth' where id = org;   -- typo, on purpose
  select max_leads::text into v from public.plan_of(org);
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('Unknown plan falls back to trial (not unlimited)', '100',
          coalesce(v, 'NULL = unlimited'),
          case when v = '100' then 'PASS' else 'FAIL' end);

  -- ── 7. Record cap: inbound survives, deliberate creation does not ────────
  update public.organizations set plan = 'starter' where id = org;
  update public.plan_limits set max_leads = 2 where plan = 'starter';  -- rolled back

  insert into public.leads (org_id, name, source, stage)
  values (org, 'Lead one', 'website', 'new'),
         (org, 'Lead two', 'website', 'new');

  -- At the cap. Inbound must STILL be accepted — never drop a real enquiry.
  begin
    insert into public.leads (org_id, name, source, stage)
    values (org, 'Inbound over cap', 'website', 'new');
    select count(*) into n from public.leads where org_id = org;
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Inbound accepted over the cap', '3 leads', n || ' leads',
            case when n = 3 then 'PASS' else 'FAIL' end);
  exception when others then
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Inbound accepted over the cap', '3 leads', 'BLOCKED: ' || sqlerrm, 'FAIL');
  end;

  -- A manual add at the cap must be refused.
  begin
    insert into public.leads (org_id, name, source, stage)
    values (org, 'Manual over cap', 'manual', 'new');
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Manual add blocked at the cap', 'rejected', 'ALLOWED', 'FAIL');
  exception when others then
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Manual add blocked at the cap', 'rejected', left(sqlerrm, 60), 'PASS');
  end;

  -- CSV import is the same deliberate path.
  begin
    insert into public.leads (org_id, name, source, stage)
    values (org, 'Imported over cap', 'csv_import', 'new');
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('CSV import blocked at the cap', 'rejected', 'ALLOWED', 'FAIL');
  exception when others then
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('CSV import blocked at the cap', 'rejected', left(sqlerrm, 60), 'PASS');
  end;

  -- ── 8. Automations ───────────────────────────────────────────────────────
  update public.plan_limits set max_automations = 1 where plan = 'starter';

  insert into public.automations (org_id, name, trigger, enabled)
  values (org, 'Rule A', 'lead_created', true);

  begin
    insert into public.automations (org_id, name, trigger, enabled)
    values (org, 'Rule B', 'lead_created', true);
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Second active automation blocked', 'rejected', 'ALLOWED', 'FAIL');
  exception when others then
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Second active automation blocked', 'rejected', left(sqlerrm, 60), 'PASS');
  end;

  -- A PAUSED rule must still be creatable: someone at their cap should be able
  -- to draft the next one rather than being stuck.
  begin
    insert into public.automations (org_id, name, trigger, enabled)
    values (org, 'Rule C paused', 'lead_created', false);
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Paused automation still allowed at cap', 'allowed', 'allowed', 'PASS');
  exception when others then
    insert into public.zz_enforcement_results (check_name, expected, got, verdict)
    values ('Paused automation still allowed at cap', 'allowed',
            'BLOCKED: ' || left(sqlerrm, 50), 'FAIL');
  end;

  -- ── 9. Our own orgs must be untouched by any of this ─────────────────────
  select count(*) into n
    from public.organizations
   where name <> 'ZZ Enforcement Test'
     and public.effective_plan(id) = 'expired';
  insert into public.zz_enforcement_results (check_name, expected, got, verdict)
  values ('No real org is expired', '0', n::text,
          case when n = 0 then 'PASS' else 'FAIL' end);
end $$;

select verdict, check_name, expected, got from public.zz_enforcement_results order by seq;

rollback;

-- Every row must read PASS. Nothing above persists — the rollback removes the
-- test org, its leads and automations, and restores plan_limits.
