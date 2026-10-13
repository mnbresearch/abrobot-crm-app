-- AbroBot CRM — behavioural tests for product analytics and abandoned-checkout
-- eligibility. Run the whole file in the Supabase SQL editor AFTER applying
-- 20261013100000_product_analytics.sql and 20261013110000_checkout_recovery.sql.
-- The last statement is the report: every row should say PASS.
--
-- Same safety model as scripts/test-api-keys.sql: everything happens inside one
-- sub-block that ends with a sentinel error, so PostgreSQL rolls ALL of it back.
-- No probe user, org, payment, event or setting survives; nothing existing is
-- modified. Results leave the rolled-back block in a variable.

create temp table if not exists _growth_results (ord int, test text, verdict text, detail text);
truncate _growth_results;

do $t$
declare
  r     jsonb := '[]'::jsonb;
  ua    uuid := gen_random_uuid();
  oa    uuid;
  pay1  uuid;
  pay2  uuid;
  n     bigint;
  ok    boolean;
  v     jsonb;
  t0    timestamptz := now();
begin
  begin
    -- ── fixtures ───────────────────────────────────────────────────────────
    insert into auth.users (id, email) values (ua, 'growthtest@example.invalid');
    insert into public.organizations (name, slug, active, plan, trial_started_at, trial_days, credits_total, credits_used)
    values ('Growth Test', 'zz-growthtest', true, 'free', now(), 0, 0, 0) returning id into oa;
    perform set_config('app.profile_bootstrap', 'on', true);
    insert into public.profiles (id, org_id, role, status, email, full_name)
    values (ua, oa, 'org_admin', 'active', 'growthtest@example.invalid', 'Growth Tester')
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, status = excluded.status,
                                   full_name = excluded.full_name;

    -- ── 1. server events come from the tables ──────────────────────────────
    select count(*) into n from public.product_events where org_id = oa and event = 'workspace_created';
    r := r || jsonb_build_object('t', 'creating a workspace records workspace_created', 'ok', n = 1, 'd', n || ' event');

    insert into public.payments (org_id, order_id, plan, amount, period_months, status, customer_email, created_by, created_at)
    values (oa, 'zz_test_' || gen_random_uuid(), 'growth', 2999, 1, 'created', 'growthtest@example.invalid', ua, now() - interval '3 hours')
    returning id into pay1;

    select count(*) into n from public.product_events where org_id = oa and event = 'checkout_started' and props->>'payment_id' = pay1::text;
    r := r || jsonb_build_object('t', 'a payment row records checkout_started', 'ok', n = 1, 'd', n || ' event');

    -- ── 2. the browser path ────────────────────────────────────────────────
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    ok := public.track_event('page_view', 'sessiontest01', '/leads/123?token=SECRET#frag',
                             '{"route":"/leads/:id","email":"leak@example.com","plan":"growth"}'::jsonb);
    r := r || jsonb_build_object('t', 'a signed-in page_view is accepted', 'ok', ok, 'd', ok::text);

    ok := public.track_event('payment_succeeded', 'sessiontest01', '/settings', '{}'::jsonb);
    r := r || jsonb_build_object('t', 'the browser CANNOT claim a payment', 'ok', ok = false, 'd', ok::text);

    ok := public.track_event('drop table', null, null, '{}'::jsonb);
    r := r || jsonb_build_object('t', 'unknown events are refused', 'ok', ok = false, 'd', ok::text);

    begin
      insert into public.product_events (event, source) values ('payment_succeeded', 'server');
      ok := false;
    exception when others then ok := true; end;
    r := r || jsonb_build_object('t', 'the browser cannot insert events directly', 'ok', ok, 'd', ok::text);

    select count(*) into n from public.product_events;
    r := r || jsonb_build_object('t', 'a tenant user cannot read analytics', 'ok', n = 0, 'd', n || ' rows visible');

    begin
      v := public.analytics_overview(30);
      ok := false;
    exception when others then ok := true; end;
    r := r || jsonb_build_object('t', 'a tenant admin cannot open the platform dashboard', 'ok', ok, 'd', ok::text);

    execute 'reset role';

    select count(*) into n from public.product_events
     where session_id = 'sessiontest01' and event = 'page_view'
       and user_id = ua and org_id = oa and path = '/leads/123'
       and props = '{"route":"/leads/:id","plan":"growth"}'::jsonb;
    r := r || jsonb_build_object('t', 'user/org come from the JWT; query string, fragment and unknown props are stripped',
                                 'ok', n = 1, 'd', n || ' row');

    -- ── 3. abandoned-checkout eligibility ──────────────────────────────────
    -- pay1 is 3 hours old and unpaid; the default first delay is 2 hours.
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.payment_id = pay1;
    r := r || jsonb_build_object('t', 'an unpaid 3-hour-old checkout is eligible', 'ok', n = 1, 'd', n || ' row');

    select count(*) into n from public.checkout_recovery_candidates(200) c
     where c.payment_id = pay1 and c.email = 'growthtest@example.invalid' and c.attempt = 1;
    r := r || jsonb_build_object('t', 'it goes to the admin who started it, as reminder 1', 'ok', n = 1, 'd', n || ' row');

    -- A second, newer checkout from the same org: only the newest is chased.
    insert into public.payments (org_id, order_id, plan, amount, period_months, status, customer_email, created_by, created_at)
    values (oa, 'zz_test_' || gen_random_uuid(), 'growth', 29990, 12, 'dropped', 'growthtest@example.invalid', ua, now() - interval '150 minutes')
    returning id into pay2;
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
    r := r || jsonb_build_object('t', 'one thread per workspace, however many attempts', 'ok', n = 1, 'd', n || ' row');

    -- A reminder sent recently about a DIFFERENT checkout (pay1) to the same
    -- address. pay2 itself has never been chased, so only the 20-hour
    -- per-address cap can exclude it — which is what this proves.
    insert into public.checkout_followups (payment_id, org_id, recipient_email, attempt, mode, status)
    values (pay1, oa, 'growthtest@example.invalid', 1, 'live', 'sent');
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
    r := r || jsonb_build_object('t', 'nobody gets two reminders within 20 hours, whatever the checkout', 'ok', n = 0, 'd', n || ' rows');
    delete from public.checkout_followups where payment_id = pay1;

    -- The claim index blocks a duplicate live send of the same attempt.
    insert into public.checkout_followups (payment_id, org_id, recipient_email, attempt, mode, status)
    values (pay2, oa, 'growthtest@example.invalid', 1, 'live', 'pending');
    begin
      insert into public.checkout_followups (payment_id, org_id, recipient_email, attempt, mode, status)
      values (pay2, oa, 'growthtest@example.invalid', 1, 'live', 'pending');
      ok := false;
    exception when unique_violation then ok := true; end;
    r := r || jsonb_build_object('t', 'the same reminder cannot be claimed twice', 'ok', ok, 'd', ok::text);

    -- ...but a FAILED attempt releases the claim so the next run can retry.
    update public.checkout_followups set status = 'failed' where payment_id = pay2;
    begin
      insert into public.checkout_followups (payment_id, org_id, recipient_email, attempt, mode, status)
      values (pay2, oa, 'growthtest@example.invalid', 1, 'live', 'pending');
      ok := true;
    exception when unique_violation then ok := false; end;
    r := r || jsonb_build_object('t', 'a failed send can be retried', 'ok', ok, 'd', ok::text);

    delete from public.checkout_followups where payment_id = pay2;

    -- A member who has LEFT the workspace is not chased.
    perform set_config('app.profile_bootstrap', 'on', true);
    update public.profiles set status = 'disabled' where id = ua;
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
    r := r || jsonb_build_object('t', 'someone no longer active in the workspace is not emailed', 'ok', n = 0, 'd', n || ' rows');
    update public.profiles set status = 'active' where id = ua;

    -- Suppressed address.
    insert into public.platform_email_suppressions (email, reason, source) values ('growthtest@example.invalid', 'unsubscribed', 'test');
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
    r := r || jsonb_build_object('t', 'an unsubscribed address is never emailed', 'ok', n = 0, 'd', n || ' rows');
    delete from public.platform_email_suppressions where email = 'growthtest@example.invalid';

    -- A LAPSED customer trying to renew must be eligible. ('expired' has the
    -- highest position in plan_limits, which once excluded exactly them.)
    update public.organizations set plan = 'growth' where id = oa;
    insert into public.subscriptions (org_id, plan, status, current_period_end, updated_at)
    values (oa, 'growth', 'active', now() - interval '90 days', now())
    on conflict (org_id) do update set plan = 'growth', status = 'active', current_period_end = now() - interval '90 days';
    if public.effective_plan(oa) = 'expired' then
      select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
      r := r || jsonb_build_object('t', 'a lapsed (expired) customer abandoning a renewal IS reminded', 'ok', n = 1, 'd', n || ' row');
    else
      r := r || jsonb_build_object('t', 'a lapsed (expired) customer abandoning a renewal IS reminded', 'ok', false,
                                   'd', 'fixture did not produce an expired plan: ' || public.effective_plan(oa));
    end if;

    -- Already on the plan (renewed by support): not chased.
    update public.subscriptions set current_period_end = now() + interval '20 days' where org_id = oa;
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
    r := r || jsonb_build_object('t', 'a workspace already on that plan is not chased', 'ok', n = 0, 'd', n || ' rows');
    update public.organizations set plan = 'free' where id = oa;
    delete from public.subscriptions where org_id = oa;

    -- Paid afterwards.
    update public.payments set status = 'paid', paid_at = now() where id = pay2;
    select count(*) into n from public.checkout_recovery_candidates(200) c where c.org_id = oa;
    r := r || jsonb_build_object('t', 'a workspace that has since paid is not chased', 'ok', n = 0, 'd', n || ' rows');

    select count(*) into n from public.product_events where org_id = oa and event = 'payment_succeeded';
    r := r || jsonb_build_object('t', 'the verified status change records payment_succeeded', 'ok', n = 1, 'd', n || ' event');

    -- ── 4. the dashboard runs for a super admin ────────────────────────────
    perform set_config('app.profile_bootstrap', 'on', true);
    update public.profiles set role = 'super_admin' where id = ua;
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    v := public.analytics_overview(30);
    execute 'reset role';
    r := r || jsonb_build_object('t', 'the dashboard returns a 7-step funnel for a super admin',
                                 'ok', jsonb_array_length(v->'funnel') = 7, 'd', left((v->'funnel')::text, 120));

    raise exception using errcode = 'ZZ999', message = 'rollback';
  exception
    when sqlstate 'ZZ999' then null;
    when others then
      r := r || jsonb_build_object('t', 'the test itself', 'ok', false, 'd', sqlstate || ': ' || left(sqlerrm, 200));
  end;

  begin execute 'reset role'; exception when others then null; end;

  insert into _growth_results
  select ord::int, e->>'t', case when (e->>'ok')::boolean then 'PASS' else 'FAIL' end, e->>'d'
    from jsonb_array_elements(r) with ordinality as x(e, ord);
end $t$;

select ord, test, verdict, detail from _growth_results order by verdict = 'PASS', ord;
