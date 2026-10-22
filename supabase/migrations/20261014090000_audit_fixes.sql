-- AbroBot CRM — audit fixes, 14 October 2026.
--
-- Apply by hand in the Supabase SQL editor, after 20261013110000. Idempotent:
-- safe to re-run. Additive: nothing is dropped except policies this file
-- recreates in the same statement.
--
-- Every function redefined below is copied VERBATIM from its most recent
-- definition and changed only where commented:
--
--   archived_leads()            20260903150000_soft_delete.sql
--   guard_profile_changes()     20260901090000_security_hardening.sql
--   accept_invite()             20260901090000_security_hardening.sql
--   consume_usage(uuid,text,int) 20260908090000_pricing_reset.sql
--   grant_plan_from_payment()   20260917090000_billing_plan_change_and_refunds.sql
--   revoke_plan_from_payment()  20260917090000_billing_plan_change_and_refunds.sql
--
--   a. agent_config writes are admin-only (RESTRICTIVE insert/update/delete)
--   b. agent_config.whatsapp_autoreply_text
--   c. conversations.page_url may only be NULL, 'whatsapp' or http(s)://…
--   d. archived_leads() is always the caller's own org
--   e. an org admin cannot demote or disable a super admin
--   f. accept_invite() requires a confirmed email
--   g. consume_usage() counts only what it allows
--   h. refund/chargeback revocation subtracts what the payment actually granted

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- a. agent_config writes: admins only
-- ════════════════════════════════════════════════════════════════════════════
-- agent_config_org (created in the dashboard, see RECOVERED-SCHEMA.md) is
--   ALL using (is_super_admin() OR (org_id = my_org() AND is_active_member()))
-- so any active counsellor could rewrite the org's AI agent, alert routing and
-- sender identity from the browser. These RESTRICTIVE policies are ANDed with
-- it for writes only; SELECT is untouched, so every member still reads the
-- non-secret columns the checklist and Templates screens need.
--
-- No CREATE OR REPLACE POLICY exists, so each is dropped and recreated in this
-- transaction.
drop policy if exists agent_config_admin_insert on public.agent_config;
create policy agent_config_admin_insert on public.agent_config
  as restrictive for insert
  with check (public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin()));

drop policy if exists agent_config_admin_update on public.agent_config;
create policy agent_config_admin_update on public.agent_config
  as restrictive for update
  using      (public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin()))
  with check (public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin()));

drop policy if exists agent_config_admin_delete on public.agent_config;
create policy agent_config_admin_delete on public.agent_config
  as restrictive for delete
  using (public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin()));

-- ════════════════════════════════════════════════════════════════════════════
-- b. WhatsApp auto-reply text
-- ════════════════════════════════════════════════════════════════════════════
alter table public.agent_config
  add column if not exists whatsapp_autoreply_text text;

do $$ begin
  alter table public.agent_config
    add constraint agent_config_whatsapp_autoreply_text_len
    check (whatsapp_autoreply_text is null or char_length(whatsapp_autoreply_text) <= 500);
exception when duplicate_object then null;
end $$;

comment on column public.agent_config.whatsapp_autoreply_text is
  'Text sent as the automatic reply to an inbound WhatsApp message. NULL means the built-in default. At most 500 characters. Not a secret.';

-- agent_config's browser privileges are COLUMN grants (20260905120000), so a
-- new column is invisible to the browser until granted. Not a secret, and the
-- RESTRICTIVE policies above confine writes to admins.
grant select (whatsapp_autoreply_text), insert (whatsapp_autoreply_text),
      update (whatsapp_autoreply_text)
  on public.agent_config to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- c. conversations.page_url
-- ════════════════════════════════════════════════════════════════════════════
-- chat-agent stores whatever the widget posts as page_url, and the
-- Conversations screen renders it. Only an http(s) URL (the widget sends
-- location.href) or the 'whatsapp' marker is meaningful; anything else —
-- javascript:, data:, free text — is nulled, then refused.
update public.conversations
   set page_url = null
 where page_url is not null
   and page_url <> 'whatsapp'
   and page_url !~* '^https?://';

-- A BEFORE trigger normalises bad input to NULL rather than letting the CHECK
-- reject the insert: a conversation must never fail to start (and a visitor
-- lose their chat) because of where the widget was embedded. The CHECK is the
-- backstop for anything that bypasses the trigger.
create or replace function public.conversations_sanitize_page_url()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.page_url is not null
     and new.page_url <> 'whatsapp'
     and new.page_url !~* '^https?://' then
    new.page_url := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_conversations_sanitize_page_url on public.conversations;
create trigger trg_conversations_sanitize_page_url
  before insert or update of page_url on public.conversations
  for each row execute function public.conversations_sanitize_page_url();

do $$ begin
  alter table public.conversations
    add constraint conversations_page_url_safe
    check (page_url is null or page_url = 'whatsapp' or page_url ~* '^https?://')
    not valid;
exception when duplicate_object then null;
end $$;

alter table public.conversations validate constraint conversations_page_url_safe;

-- ════════════════════════════════════════════════════════════════════════════
-- d. archived_leads(): own org only
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.archived_leads()
returns table (id uuid, name text, email text, phone text, deleted_at timestamptz, days_left integer)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, l.email, l.phone, l.deleted_at,
         greatest(0, 30 - extract(day from now() - l.deleted_at)::int)
    from public.leads l
   where l.deleted_at is not null
     -- Always this org. A super admin's Archived screen is their own org's,
     -- not every tenant's: is_super_admin() used to stand in place of the org
     -- test, so the screen listed (and offered to restore) other tenants'
     -- records. Cross-tenant recovery is an operator task done in SQL.
     and l.org_id = public.my_org()
     and (public.is_super_admin() or public.is_org_admin())
   order by l.deleted_at desc
   limit 500;
$$;

grant execute on function public.archived_leads() to authenticated;
revoke all on function public.archived_leads() from public, anon;

-- ════════════════════════════════════════════════════════════════════════════
-- e. guard_profile_changes(): a super admin's row is a super admin's business
-- ════════════════════════════════════════════════════════════════════════════
-- Bootstrap bypass (app.profile_bootstrap) and the no-JWT bypass are kept as
-- they were. The trigger itself (trg_guard_profile_changes) is unchanged and
-- keeps pointing at this function, so it is not recreated.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id   uuid := auth.uid();
  caller_role public.user_role;
  seat_cap    integer;
  active_now  integer;
  is_insert   boolean := (tg_op = 'INSERT');
begin
  -- Service role / migrations / edge functions: no JWT, already fully trusted.
  if caller_id is null then
    return new;
  end if;

  -- The sanctioned bootstrap paths (create_organisation, accept_invite).
  if current_setting('app.profile_bootstrap', true) = 'on' then
    return new;
  end if;

  select role into caller_role from public.profiles where id = caller_id;

  -- ── INSERT ───────────────────────────────────────────────────────────────
  -- The guard used to be UPDATE-only, so every check below could be skipped by
  -- inserting a profile row instead of updating one. If a permissive
  -- self-insert policy exists, that was a one-request path to platform
  -- super_admin. A new profile may only ever be your own, unprivileged, and
  -- unattached to an org.
  if is_insert then
    if new.id <> caller_id and coalesce(caller_role, 'counsellor') <> 'super_admin' then
      raise exception 'You can only create your own profile' using errcode = '42501';
    end if;
    if coalesce(caller_role, 'counsellor') <> 'super_admin' then
      if new.role is distinct from 'counsellor'::public.user_role then
        raise exception 'A new profile cannot be created with an elevated role'
          using errcode = '42501';
      end if;
      if new.org_id is not null then
        raise exception 'Join an organisation through an invite, not by creating a profile'
          using errcode = '42501';
      end if;
      if new.status = 'active'::public.member_status then
        raise exception 'A new profile cannot activate itself' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- ── UPDATE ───────────────────────────────────────────────────────────────
  if new.org_id is distinct from old.org_id
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Only a super admin can move a member to another organisation'
      using errcode = '42501';
  end if;

  -- Email is the identity accept_invite() matches on, so letting a user edit
  -- it freely is a way into someone else's organisation. Only a super admin
  -- may change it; users change their email through Supabase Auth.
  if new.email is distinct from old.email
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Email is managed by your login and cannot be edited here'
      using errcode = '42501';
  end if;

  -- A super admin's row is not an org admin's to manage. org_admin may change
  -- role and status for rows in their org, and nothing distinguished the one
  -- row that holds platform-wide reach: an org admin could demote or disable
  -- a super admin who happened to sit in their organisation. Only a super
  -- admin may change another super admin's role or access.
  if (new.role is distinct from old.role or new.status is distinct from old.status)
     and old.role = 'super_admin'::public.user_role
     and coalesce(caller_role, 'counsellor'::public.user_role) <> 'super_admin' then
    raise exception 'Only a super admin can change a super admin''s role or access'
      using errcode = '42501';
  end if;

  if new.role is distinct from old.role then
    if caller_role = 'super_admin' then
      null;
    elsif caller_role = 'org_admin' then
      if new.role = 'super_admin' then
        raise exception 'Only a super admin can grant super admin' using errcode = '42501';
      end if;
      if new.id = caller_id then
        raise exception 'You cannot change your own role. Ask a super admin.' using errcode = '42501';
      end if;
    else
      raise exception 'Only an admin can change roles' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if coalesce(caller_role, 'counsellor'::public.user_role)
       not in ('org_admin'::public.user_role, 'super_admin'::public.user_role) then
      raise exception 'Only an admin can change access' using errcode = '42501';
    end if;
  end if;

  if new.status = 'active'::public.member_status
     and old.status is distinct from 'active'::public.member_status then
    seat_cap := public.plan_seat_cap(new.org_id);
    if seat_cap is not null then
      select count(*) into active_now
        from public.profiles
       where org_id = new.org_id
         and status = 'active'::public.member_status
         and id <> new.id;
      if active_now + 1 > seat_cap then
        if seat_cap = 0 then
          raise exception
            'Your subscription has ended, so new members cannot be activated. Renew to add people again.'
            using errcode = 'P0001';
        end if;
        raise exception
          'Seat limit reached: this plan allows % active member(s). Upgrade to add more.',
          seat_cap using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- f. accept_invite(): only a confirmed inbox can claim an invite
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.accept_invite()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  prof       public.profiles%rowtype;
  inv        public.invites%rowtype;
  jwt_email  text;
  seat_cap   integer;
  active_now integer;
  confirmed_at timestamptz;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  prof := public.ensure_profile();
  if prof.org_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already in an organisation');
  end if;

  -- Identity from the auth system, never from a table the user can write.
  select email, email_confirmed_at into jwt_email, confirmed_at from auth.users where id = uid;
  if jwt_email is null then
    return jsonb_build_object('ok', false, 'reason', 'no email on this account');
  end if;

  -- An invite is addressed to an inbox, so only someone who has proved they
  -- control that inbox may claim it. Without this, signing up with an
  -- invited address and never confirming it was enough to join the org.
  if confirmed_at is null then
    return jsonb_build_object('ok', false, 'reason', 'confirm your email address first');
  end if;

  select * into inv
    from public.invites
   where lower(email) = lower(jwt_email)
     and accepted_at is null
   order by created_at
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no pending invite');
  end if;

  -- Defence in depth behind the CHECK constraint: an ops script or a future
  -- migration could bypass the constraint, and this path grants real power.
  if inv.role = 'super_admin'::public.user_role then
    return jsonb_build_object('ok', false, 'reason', 'invalid invite');
  end if;

  seat_cap := public.plan_seat_cap(inv.org_id);
  if seat_cap is not null then
    select count(*) into active_now
      from public.profiles
     where org_id = inv.org_id and status = 'active';
    if active_now + 1 > seat_cap then
      return jsonb_build_object('ok', false, 'reason',
        format('That organisation has used all %s seats on its plan', seat_cap));
    end if;
  end if;

  perform set_config('app.profile_bootstrap', 'on', true);

  update public.profiles
     set org_id = inv.org_id, role = inv.role, status = 'active'
   where id = uid;

  update public.invites set accepted_at = now() where id = inv.id;

  return jsonb_build_object('ok', true, 'org_id', inv.org_id, 'role', inv.role);
end;
$$;

revoke all on function public.accept_invite() from public, anon;
grant execute on function public.accept_invite() to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- g. consume_usage(): refused attempts are not usage
-- ════════════════════════════════════════════════════════════════════════════
-- Same signature, same return shape {allowed, used, limit}. On refusal `used`
-- is now the real count rather than count + the refused amount.
create or replace function public.consume_usage(
  p_org_id uuid, p_metric text, p_amount integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_limit  integer;
  v_new    integer;
begin
  select case p_metric
           when 'ai_messages'       then max_ai_messages
           when 'emails'            then max_emails
           when 'whatsapp_messages' then max_whatsapp
           else null
         end
    into v_limit
    from public.plan_of(p_org_id);

  -- Unlimited: count it and allow it.
  if v_limit is null then
    insert into public.usage_counters (org_id, period, metric, value)
    values (p_org_id, v_period, p_metric, p_amount)
    on conflict (org_id, period, metric)
    do update set value = public.usage_counters.value + p_amount
    returning value into v_new;
    return jsonb_build_object('allowed', true, 'used', v_new, 'limit', v_limit);
  end if;

  -- Limited: increment ONLY when the result stays within the limit. This used
  -- to increment first and check afterwards, so every refused attempt was
  -- still counted and the meter read 1437/1000 for an org that had sent 1000.
  -- The guarded UPDATE is atomic: concurrent callers re-check the WHERE
  -- against the row as it is after the other's increment.
  insert into public.usage_counters (org_id, period, metric, value)
  values (p_org_id, v_period, p_metric, 0)
  on conflict (org_id, period, metric) do nothing;

  update public.usage_counters
     set value = value + p_amount
   where org_id = p_org_id and period = v_period and metric = p_metric
     and value + p_amount <= v_limit
  returning value into v_new;

  if not found then
    select value into v_new from public.usage_counters
     where org_id = p_org_id and period = v_period and metric = p_metric;
    return jsonb_build_object('allowed', false, 'used', coalesce(v_new, 0), 'limit', v_limit);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_new, 'limit', v_limit);
end;
$$;

revoke all on function public.consume_usage(uuid, text, integer) from public, anon, authenticated;

-- record_usage: the unconditional counter, for callers that meter AFTER the
-- fact (send-campaign, nurture, the lead-webhook WhatsApp autoreply). They
-- gate on a snapshot read first and then report what was actually sent.
-- Routing that report through the guarded consume_usage above would drop the
-- WHOLE batch from the meter whenever two senders overlapped near the limit,
-- leaving the counter low and letting later sends through. Usage that has
-- already happened is always recorded; consume_usage stays the reserve-first
-- gate for chat-agent, summarize-chats and whatsapp-send.
--
-- (No clamp of existing counters: for those post-send callers a counter above
-- its limit can be real usage, so clamping would undercount.)
create or replace function public.record_usage(
  p_org_id uuid, p_metric text, p_amount integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text := to_char(now(), 'YYYY-MM');
  v_new    integer;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('recorded', 0);
  end if;
  insert into public.usage_counters (org_id, period, metric, value)
  values (p_org_id, v_period, p_metric, p_amount)
  on conflict (org_id, period, metric)
  do update set value = public.usage_counters.value + p_amount
  returning value into v_new;
  return jsonb_build_object('recorded', p_amount, 'used', v_new);
end;
$$;

revoke all on function public.record_usage(uuid, text, integer) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- h. Revocation subtracts what the payment granted, in today's plan's terms
-- ════════════════════════════════════════════════════════════════════════════
-- revoke_plan_from_payment subtracted pay.period_months from whatever plan is
-- current. After a plan change in between, that removes the wrong plan's
-- time: refund a ₹999 Starter month after moving to Business and the customer
-- loses a month of ₹4,999 Business; refund a Business month after moving to
-- Starter and only one Starter month (₹999 of value) is taken back for a
-- ₹4,999 refund. The grant now records what it actually added, and the revoke
-- converts it by list price. Rows granted before this migration have NULL
-- granted_seconds and keep the old behaviour.
alter table public.payments add column if not exists granted_plan    text;
alter table public.payments add column if not exists granted_seconds bigint;

comment on column public.payments.granted_plan is
  'The plan this payment''s grant was applied in. Set by grant_plan_from_payment.';
comment on column public.payments.granted_seconds is
  'The purchased period this payment added, in seconds of granted_plan (carried credit excluded). revoke_plan_from_payment converts it by price_inr ratio into the plan current at revocation. NULL for grants before 20261014090000.';

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
  granted_secs  bigint;
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

  -- Record what THIS payment bought, in the plan it bought it in: the
  -- purchased months as seconds, excluding the carried credit (which is money
  -- paid earlier). revoke_plan_from_payment converts this by price ratio if
  -- the org has since moved to another plan, instead of subtracting raw
  -- months from whatever plan happens to be current.
  granted_secs := extract(epoch from ((now() + (pay.period_months || ' months')::interval) - now()))::bigint;
  update public.payments
     set granted_plan = pay.plan, granted_seconds = granted_secs
   where id = pay.id;

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
  v_secs          numeric;
  v_granted_price numeric;
  v_current_price numeric;
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

  if pay.granted_seconds is null then
    -- Granted before 20261014090000 recorded what was granted: old behaviour.
    new_end := coalesce(sub.current_period_end, now())
             - (pay.period_months || ' months')::interval;
  else
    -- Take back the VALUE this payment added, expressed in the plan the org
    -- is on now. Subtracting raw months from whatever plan is current let a
    -- refunded Business month remove a month of a later Starter purchase
    -- (customer harmed), or a refunded Starter year remove a year of Business
    -- (customer harmed far worse), and the reverse for the exploit direction.
    v_secs := pay.granted_seconds;
    if coalesce(pay.granted_plan, pay.plan) is distinct from sub.plan then
      select price_inr into v_granted_price from public.plan_limits
       where plan = coalesce(pay.granted_plan, pay.plan);
      select price_inr into v_current_price from public.plan_limits
       where plan = sub.plan;
      -- Either side unvaluable (enterprise is null, free/expired are zero):
      -- fall back to the raw seconds rather than guess.
      if v_granted_price is not null and v_current_price is not null and v_current_price > 0 then
        v_secs := pay.granted_seconds * (v_granted_price / v_current_price);
      end if;
    end if;
    new_end := coalesce(sub.current_period_end, now())
             - make_interval(secs => v_secs::double precision);
  end if;

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

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- j. Verify (static: no JWT in the SQL editor, so nothing auth-gated is called)
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as ord, 'a. agent_config insert/update/delete are admin-only (restrictive)' as check,
         case when (select count(*) from pg_policies
                     where schemaname = 'public' and tablename = 'agent_config'
                       and permissive = 'RESTRICTIVE'
                       and policyname in ('agent_config_admin_insert','agent_config_admin_update','agent_config_admin_delete')
                       and coalesce(qual, '') || coalesce(with_check, '') ~ 'is_org_admin') = 3
              then 'PASS' else 'FAIL' end as result
  union all
  select 2, 'a. agent_config SELECT has no restrictive admin policy (members still read)',
         case when not exists (select 1 from pg_policies
                                where schemaname = 'public' and tablename = 'agent_config'
                                  and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
                                  and coalesce(qual, '') ~ 'is_org_admin')
              then 'PASS' else 'FAIL' end
  union all
  select 3, 'b. agent_config.whatsapp_autoreply_text exists with a 500-char check',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'agent_config'
                              and column_name = 'whatsapp_autoreply_text' and data_type = 'text')
               and exists (select 1 from pg_constraint
                            where conname = 'agent_config_whatsapp_autoreply_text_len'
                              and conrelid = 'public.agent_config'::regclass)
              then 'PASS' else 'FAIL' end
  union all
  select 4, 'b. browser can read/write whatsapp_autoreply_text',
         case when has_column_privilege('authenticated', 'public.agent_config', 'whatsapp_autoreply_text', 'UPDATE')
               and has_column_privilege('authenticated', 'public.agent_config', 'whatsapp_autoreply_text', 'SELECT')
              then 'PASS' else 'FAIL' end
  union all
  select 5, 'c. conversations.page_url check is VALIDATED',
         case when exists (select 1 from pg_constraint
                            where conname = 'conversations_page_url_safe'
                              and conrelid = 'public.conversations'::regclass and convalidated)
              then 'PASS' else 'FAIL' end
  union all
  select 6, 'c. no conversation holds a non-http(s), non-whatsapp page_url',
         case when not exists (select 1 from public.conversations
                                where page_url is not null and page_url <> 'whatsapp'
                                  and page_url !~* '^https?://')
              then 'PASS' else 'FAIL' end
  union all
  select 7, 'c. page_url sanitising trigger present',
         case when exists (select 1 from pg_trigger
                            where tgname = 'trg_conversations_sanitize_page_url'
                              and tgrelid = 'public.conversations'::regclass)
              then 'PASS' else 'FAIL' end
  union all
  select 8, 'd. archived_leads() always filters org_id = my_org()',
         case when pg_get_functiondef('public.archived_leads()'::regprocedure)
                   ~ 'and l\.org_id = public\.my_org\(\)\s+and \(public\.is_super_admin\(\) or public\.is_org_admin\(\)\)'
              then 'PASS' else 'FAIL' end
  union all
  select 9, 'e. guard_profile_changes protects super admin rows, keeps bootstrap bypass',
         case when pg_get_functiondef('public.guard_profile_changes()'::regprocedure)
                   ~ 'old\.role = ''super_admin'''
               and pg_get_functiondef('public.guard_profile_changes()'::regprocedure)
                   ~ 'app\.profile_bootstrap'
              then 'PASS' else 'FAIL' end
  union all
  select 10, 'e. trg_guard_profile_changes still attached',
         case when exists (select 1 from pg_trigger
                            where tgname = 'trg_guard_profile_changes'
                              and tgrelid = 'public.profiles'::regclass and not tgisinternal)
              then 'PASS' else 'FAIL' end
  union all
  select 11, 'f. accept_invite requires email_confirmed_at',
         case when pg_get_functiondef('public.accept_invite()'::regprocedure) ~ 'email_confirmed_at'
              then 'PASS' else 'FAIL' end
  union all
  select 12, 'g. consume_usage increments only within the limit',
         case when pg_get_functiondef('public.consume_usage(uuid,text,integer)'::regprocedure)
                   ~ 'value \+ p_amount <= v_limit'
              then 'PASS' else 'FAIL' end
  union all
  select 13, 'g. no current-period meter above its plan limit',
         case when not exists (
                select 1 from public.usage_counters c
                 cross join lateral public.plan_of(c.org_id) p
                 where c.period = to_char(now(), 'YYYY-MM')
                   and c.value > case c.metric
                                   when 'ai_messages'       then p.max_ai_messages
                                   when 'emails'            then p.max_emails
                                   when 'whatsapp_messages' then p.max_whatsapp
                                 end)
              then 'PASS' else 'FAIL' end
  union all
  select 14, 'h. payments.granted_plan / granted_seconds exist',
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'payments'
                       and column_name in ('granted_plan', 'granted_seconds')) = 2
              then 'PASS' else 'FAIL' end
  union all
  select 15, 'h. grant records granted_seconds; revoke converts by price',
         case when pg_get_functiondef('public.grant_plan_from_payment(uuid)'::regprocedure) ~ 'granted_seconds'
               and pg_get_functiondef('public.grant_plan_from_payment(uuid)'::regprocedure) ~ 'credit_days'
               and pg_get_functiondef('public.revoke_plan_from_payment(uuid,text)'::regprocedure) ~ 'v_granted_price / v_current_price'
               and pg_get_functiondef('public.revoke_plan_from_payment(uuid,text)'::regprocedure) ~ 'period_months'
              then 'PASS' else 'FAIL' end
  union all
  select 16, 'h/g. none of the money functions is callable from a browser',
         case when has_function_privilege('authenticated', 'public.revoke_plan_from_payment(uuid, text)', 'execute')
                or has_function_privilege('authenticated', 'public.grant_plan_from_payment(uuid)', 'execute')
                or has_function_privilege('authenticated', 'public.consume_usage(uuid, text, integer)', 'execute')
                or has_function_privilege('anon', 'public.consume_usage(uuid, text, integer)', 'execute')
                or has_function_privilege('authenticated', 'public.record_usage(uuid, text, integer)', 'execute')
                or has_function_privilege('anon', 'public.record_usage(uuid, text, integer)', 'execute')
              then 'FAIL' else 'PASS' end
  union all
  select 17, 'g. record_usage exists for post-send metering',
         case when to_regprocedure('public.record_usage(uuid, text, integer)') is not null then 'PASS' else 'FAIL' end
) t order by ord;
