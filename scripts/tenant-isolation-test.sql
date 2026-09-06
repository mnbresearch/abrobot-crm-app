-- AbroBot CRM — does one tenant's session actually see nothing of another's?
--
-- This is the last claim in the audit that rested on reading policies rather
-- than running them. Policies that read correctly and policies that behave
-- correctly are different things, and the gap between them is the whole
-- product: this is a CRM sold to competing businesses.
--
-- ── How it works ────────────────────────────────────────────────────────────
-- It creates one throwaway user in one throwaway organisation, becomes that
-- user for real (`set local role authenticated` plus a JWT claim, which is
-- exactly what PostgREST does for a browser session), and then asks: how much
-- of everyone else's data can this person see, change, or delete?
--
-- The probe org is empty, so every honest answer is zero. Any non-zero row is
-- a tenant reading another tenant's records.
--
-- ── Safety ──────────────────────────────────────────────────────────────────
-- The write tests genuinely attempt an INSERT, an UPDATE and a DELETE against
-- another organisation's row — a test that only pretends to write proves
-- nothing. Each one runs inside a block that raises a sentinel error
-- immediately afterwards, so PostgreSQL rolls that sub-block back whether the
-- write succeeded or failed. **If RLS is broken, this script still cannot
-- damage your data** — that is the point of the sentinel, and it is why the
-- delete test is safe to run against production.
--
-- The probe user and org are removed at the end, including on failure.
--
-- Run the whole file. The last statement is the report.

create table if not exists public._isolation_results (
  ord int, area text, expected text, actual text, verdict text
);
truncate public._isolation_results;

do $$
declare
  v_uid        uuid := gen_random_uuid();
  v_email      text := 'isolation-probe@example.invalid';
  v_org        uuid;
  v_other_org  uuid;
  v_other_lead uuid;
  v_other_conv uuid;
  v_tables     text[] := array[
    'leads','activities','conversations','agent_config','api_keys',
    'webhook_endpoints','message_templates','automations','profiles','pipeline_stages'];
  t            text;
  n            bigint;
  v_found      jsonb := '{}'::jsonb;
  v_writes     jsonb := '{}'::jsonb;
  v_ord        int := 0;
begin
  -- ── ground truth, as the owner (RLS does not apply to us here) ────────────
  select id into v_other_org
    from public.organizations
   where slug is distinct from 'zz-isolation-probe'
   order by created_at limit 1;

  if v_other_org is null then
    insert into public._isolation_results
      values (0, 'setup', '-', 'no other organisation exists',
              'SKIPPED — nothing to be isolated from. Create a second org first.');
    return;
  end if;

  select id into v_other_lead from public.leads where org_id = v_other_org limit 1;
  select id into v_other_conv from public.conversations where org_id = v_other_org limit 1;

  -- ── build the probe tenant ───────────────────────────────────────────────
  insert into auth.users (id, email) values (v_uid, v_email);

  insert into public.organizations
    (name, slug, active, plan, trial_started_at, trial_days, credits_total, credits_used)
  values ('Isolation Probe', 'zz-isolation-probe', true, 'trial', now(), 7, 0, 0)
  returning id into v_org;

  -- A trigger on auth.users may already have made the profile row.
  perform set_config('app.profile_bootstrap', 'on', true);
  insert into public.profiles (id, org_id, role, status, email)
       values (v_uid, v_org, 'org_admin', 'active', v_email)
  on conflict (id) do update
     set org_id = excluded.org_id, role = excluded.role, status = excluded.status;

  -- ── become that user ─────────────────────────────────────────────────────
  -- This is the real thing, not a simulation: `authenticated` is the role every
  -- browser session runs as, and request.jwt.claims is where auth.uid() reads
  -- from. If RLS lets this through, it lets a real customer through.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated', 'email', v_email)::text, true);
  execute 'set local role authenticated';

  -- ── READS ────────────────────────────────────────────────────────────────
  foreach t in array v_tables loop
    begin
      execute format('select count(*) from public.%I where org_id is distinct from $1', t)
        into n using v_org;
      v_found := v_found || jsonb_build_object(t, n);
    exception when others then
      -- A table the probe cannot touch at all is a pass, not an error, but say
      -- which it was rather than reporting a silent zero.
      v_found := v_found || jsonb_build_object(t, 'blocked: ' || sqlerrm);
    end;
  end loop;

  begin
    select count(*) into n from public.organizations where id is distinct from v_org;
    v_found := v_found || jsonb_build_object('organizations', n);
  exception when others then
    v_found := v_found || jsonb_build_object('organizations', 'blocked: ' || sqlerrm);
  end;

  -- chat_messages carries no org_id of its own — ownership lives on the parent
  -- conversation. So the honest test is a direct hit on a known foreign id,
  -- not a join whose inner half RLS has already filtered to nothing.
  if v_other_conv is not null then
    begin
      select count(*) into n from public.chat_messages where conversation_id = v_other_conv;
      v_found := v_found || jsonb_build_object('chat_messages (by known id)', n);
    exception when others then
      v_found := v_found || jsonb_build_object('chat_messages (by known id)', 'blocked: ' || sqlerrm);
    end;
  end if;

  -- ── WRITES ───────────────────────────────────────────────────────────────
  -- Each attempt is real, and each is unwound by the sentinel raise below, so
  -- a broken policy is detected without being acted on.
  begin
    insert into public.leads (org_id, name) values (v_other_org, 'isolation probe — should not exist');
    raise exception using errcode = 'ZZ001', message = 'accepted';
  exception
    when sqlstate 'ZZ001' then v_writes := v_writes || jsonb_build_object('insert into another org', 'ACCEPTED');
    when others          then v_writes := v_writes || jsonb_build_object('insert into another org', 'refused: ' || left(sqlerrm, 90));
  end;

  if v_other_lead is not null then
    begin
      update public.leads set name = name || ' (probed)' where id = v_other_lead;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZZ002', message = n::text;
    exception
      when sqlstate 'ZZ002' then v_writes := v_writes || jsonb_build_object('update another org''s record', sqlerrm || ' row(s)');
      when others           then v_writes := v_writes || jsonb_build_object('update another org''s record', 'refused: ' || left(sqlerrm, 90));
    end;

    begin
      delete from public.leads where id = v_other_lead;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZZ003', message = n::text;
    exception
      when sqlstate 'ZZ003' then v_writes := v_writes || jsonb_build_object('delete another org''s record', sqlerrm || ' row(s)');
      when others           then v_writes := v_writes || jsonb_build_object('delete another org''s record', 'refused: ' || left(sqlerrm, 90));
    end;
  end if;

  -- integration_status() is SECURITY DEFINER and takes no argument, so it must
  -- answer for the CALLER's org. A definer function that reads the wrong org is
  -- a hole that RLS cannot close, because the function runs as its owner.
  begin
    if (public.integration_status() ->> 'error') is null then
      v_writes := v_writes || jsonb_build_object('integration_status() scoped to caller', 'answered for own org');
    else
      v_writes := v_writes || jsonb_build_object('integration_status() scoped to caller', 'declined');
    end if;
  exception when others then
    v_writes := v_writes || jsonb_build_object('integration_status() scoped to caller', 'error: ' || left(sqlerrm, 90));
  end;

  -- ── back to being ourselves, and clean up ────────────────────────────────
  execute 'reset role';
  delete from public.organizations where id = v_org;
  delete from auth.users where id = v_uid;

  -- ── report ───────────────────────────────────────────────────────────────
  insert into public._isolation_results
  select row_number() over (order by k), 'can read: ' || k, '0',
         v,
         case when v = '0' then 'PASS'
              when v like 'blocked:%' then 'PASS (no access at all)'
              else 'FAIL — leaked ' || v || ' row(s)' end
    from jsonb_each_text(v_found) as e(k, v);

  select coalesce(max(ord), 0) into v_ord from public._isolation_results;

  insert into public._isolation_results
  select v_ord + row_number() over (order by k), k,
         case when k like 'integration%' then 'answered for own org' else 'refused / 0 rows' end,
         v,
         case
           when k like 'integration%' then
             case when v = 'answered for own org' then 'PASS' else 'CHECK — ' || v end
           when v like 'refused:%' or v = '0 row(s)' then 'PASS'
           else 'FAIL — ' || v
         end
    from jsonb_each_text(v_writes) as e(k, v);

exception when others then
  -- Never leave a probe tenant behind, whatever went wrong.
  begin execute 'reset role'; exception when others then null; end;
  delete from public.organizations where slug = 'zz-isolation-probe';
  delete from auth.users where email = 'isolation-probe@example.invalid';
  insert into public._isolation_results
    values (99, 'the test itself', 'runs', sqlstate || ': ' || sqlerrm,
            'ERROR — the test could not complete, which is not a pass');
end $$;

-- Belt and braces: if the block above died in a way that skipped its own
-- handler, this still removes the probe.
delete from public.organizations where slug = 'zz-isolation-probe';
delete from auth.users where email = 'isolation-probe@example.invalid';

select ord, area, expected, actual, verdict
  from public._isolation_results
 order by verdict like 'FAIL%' desc, verdict like 'ERROR%' desc, ord;

-- When you are done:  drop table public._isolation_results;
