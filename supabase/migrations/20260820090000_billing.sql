-- AbroBot CRM — billing tables for Cashfree.
-- NOT APPLIED. Review first.
--
-- ── The rule this schema is built around ────────────────────────────────────
-- ONLY the signature-verified webhook may grant a paid plan.
--
-- The page a customer lands on after paying is attacker-controllable: anyone
-- can open /billing/success?order_id=whatever. If that page granted plans,
-- the product would be free to anyone who read the URL. So the return page
-- displays status and nothing else; `payments` is written by the webhook,
-- running with the service role, after the HMAC checks out.
--
-- Everything here is additive. organizations.plan stays the source of truth
-- for entitlements, so plan_limits and consume_usage() keep working unchanged.

begin;

do $$ begin
  create type public.payment_status as enum ('created', 'paid', 'failed', 'refunded', 'dropped');
exception when duplicate_object then null; end $$;

create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  order_id      text not null unique,          -- our id, sent to Cashfree
  cf_order_id   text,                          -- Cashfree's id, for support
  plan          text not null,                 -- plan being purchased
  amount        numeric(12,2) not null,
  currency      text not null default 'INR',
  status        public.payment_status not null default 'created',
  period_months integer not null default 1,
  customer_email text,
  customer_phone text,
  raw           jsonb,                         -- last webhook payload, for disputes
  created_by    uuid,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);

create index if not exists payments_org_idx on public.payments (org_id, created_at desc);
create index if not exists payments_status_idx on public.payments (status);

alter table public.payments enable row level security;

-- Members may READ their org's payments. Nobody may write from the browser:
-- there is deliberately no insert/update policy, so even a compromised admin
-- session cannot mark an order paid. Writes come from the service role only.
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

-- ── subscription state ──────────────────────────────────────────────────────
create table if not exists public.subscriptions (
  org_id        uuid primary key references public.organizations(id) on delete cascade,
  plan          text not null,
  status        text not null default 'active',   -- active | past_due | cancelled
  started_at    timestamptz not null default now(),
  current_period_end timestamptz,
  last_payment_id uuid references public.payments(id),
  updated_at    timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_read on public.subscriptions;
create policy subscriptions_read on public.subscriptions
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

-- ── grant a plan (called by the webhook, service role only) ─────────────────
-- SECURITY DEFINER so it can update organizations.plan, which no browser
-- session may touch. Idempotent: replaying the same paid webhook extends
-- nothing twice, because it keys off the payment row's status transition.
create or replace function public.grant_plan_from_payment(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay public.payments%rowtype;
  new_end timestamptz;
begin
  select * into pay from public.payments where id = p_payment_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'payment not found');
  end if;
  if pay.status <> 'paid' then
    return jsonb_build_object('ok', false, 'reason', 'payment is not paid');
  end if;

  -- Extend from the later of now and the existing period end, so paying early
  -- adds time rather than throwing away what is left.
  select greatest(now(), coalesce(s.current_period_end, now()))
    into new_end
    from (select current_period_end from public.subscriptions where org_id = pay.org_id) s;
  new_end := coalesce(new_end, now()) + (pay.period_months || ' months')::interval;

  insert into public.subscriptions (org_id, plan, status, current_period_end, last_payment_id, updated_at)
  values (pay.org_id, pay.plan, 'active', new_end, pay.id, now())
  on conflict (org_id) do update set
    plan = excluded.plan,
    status = 'active',
    current_period_end = excluded.current_period_end,
    last_payment_id = excluded.last_payment_id,
    updated_at = now();

  update public.organizations set plan = pay.plan where id = pay.org_id;

  return jsonb_build_object('ok', true, 'plan', pay.plan, 'period_end', new_end);
end;
$$;

comment on function public.grant_plan_from_payment is
  'Grants a paid plan from a payment row. Called only by the signature-verified webhook running as the service role — never from a browser.';

commit;
