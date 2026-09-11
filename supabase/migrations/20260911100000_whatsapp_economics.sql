-- AbroBot CRM — a ceiling on the expensive kind of WhatsApp, before it exists.
--
-- ── What the margin review found, and what it got wrong ─────────────────────
-- A re-derivation of the pricing model concluded that Growth and Business go
-- NEGATIVE at full entitlement — a customer sending all 1,500 or 3,000 included
-- WhatsApp messages as MARKETING templates costs more than their subscription.
-- Meta India charges ₹0.8631 for marketing and ₹0.1150 for utility/service, a
-- 7.5x difference, and `max_whatsapp` counts them identically.
--
-- Checked against the code, and the conclusion does not hold TODAY: the product
-- cannot send a marketing message at all. _shared/whatsapp.ts has exactly one
-- sender, sendWhatsAppText, and it posts `type: "text"` — a free-form service
-- message, the cheapest category. There is no template-sending path anywhere in
-- the codebase. So the real worst case is 1,500 x ₹0.134 = ₹201 on Growth, not
-- ₹1,295, and every plan stays comfortably positive.
--
-- ── Why this migration exists anyway ────────────────────────────────────────
-- Because the gap is a trap, not a bug. The day someone adds template sending —
-- and they will, since marketing templates are the obvious next feature — the
-- cap will silently permit 7.5x the cost it was sized for, and the first
-- anyone hears of it is a Meta invoice. The safest moment to build a ceiling is
-- before the thing it limits exists.
--
-- So: a separate, deliberately small marketing allowance, metered on its own
-- counter, defaulting to a number that cannot sink a plan. A template sender
-- added later has to reckon with it rather than discover it.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Marketing gets its own, much smaller allowance
-- ════════════════════════════════════════════════════════════════════════════

alter table public.plan_limits
  add column if not exists max_whatsapp_marketing integer;

comment on column public.plan_limits.max_whatsapp_marketing is
  'Sub-cap within max_whatsapp for MARKETING templates, which Meta bills at roughly 7.5x a utility or service message (₹0.8631 vs ₹0.1150 in India). NULL means unlimited; 0 means marketing is not included on this plan. Counted on its own usage metric, whatsapp_marketing.';

-- Sized so that a plan consuming its entire marketing allowance still clears
-- its other costs. Growth: 300 x ₹0.8631 = ₹259 of a ₹2,118 net subscription.
-- Business: 600 x ₹0.8631 = ₹518 of ₹4,236. Both leave the plan positive even
-- with AI and email also at 100%.
update public.plan_limits set max_whatsapp_marketing = 0    where plan in ('free', 'expired', 'starter');
update public.plan_limits set max_whatsapp_marketing = 300  where plan = 'growth';
update public.plan_limits set max_whatsapp_marketing = 600  where plan = 'business';
update public.plan_limits set max_whatsapp_marketing = null where plan = 'enterprise';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. An allowance function that knows the difference
-- ════════════════════════════════════════════════════════════════════════════
-- Adding an argument rather than replacing the existing signature: whatsapp-send
-- and lead-webhook both call whatsapp_allowance(uuid) today, and a deploy is not
-- atomic with a migration. The one-argument form keeps working and keeps
-- meaning "the overall WhatsApp allowance".

create or replace function public.whatsapp_allowance(p_org_id uuid, p_kind text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_kind = 'marketing' then
      jsonb_build_object(
        'kind',      'marketing',
        'included',  coalesce(l.whatsapp, false)
                       and (l.max_whatsapp_marketing is null or l.max_whatsapp_marketing > 0),
        'limit',     l.max_whatsapp_marketing,
        'used',      coalesce(m.value, 0),
        'remaining', case when l.max_whatsapp_marketing is null then null
                          else greatest(l.max_whatsapp_marketing - coalesce(m.value, 0), 0) end,
        -- Marketing also draws on the overall pool, so a send must satisfy both.
        'overall_remaining', case when l.max_whatsapp is null then null
                          else greatest(l.max_whatsapp - coalesce(u.value, 0), 0) end)
    else
      jsonb_build_object(
        'kind',      'service',
        'included',  coalesce(l.whatsapp, false),
        'limit',     l.max_whatsapp,
        'used',      coalesce(u.value, 0),
        'remaining', case when l.max_whatsapp is null then null
                          else greatest(l.max_whatsapp - coalesce(u.value, 0), 0) end)
  end
    from public.plan_of(p_org_id) l
    left join public.usage_counters u
      on u.org_id = p_org_id
     and u.period = to_char(now(), 'YYYY-MM')
     and u.metric = 'whatsapp_messages'
    left join public.usage_counters m
      on m.org_id = p_org_id
     and m.period = to_char(now(), 'YYYY-MM')
     and m.metric = 'whatsapp_marketing';
$$;

-- Same posture as every other SECURITY DEFINER function taking an arbitrary
-- org id with no check in the body: not reachable from the browser.
revoke all on function public.whatsapp_allowance(uuid, text) from public, anon, authenticated;

comment on function public.whatsapp_allowance(uuid, text) is
  'WhatsApp allowance for a kind of message. p_kind = ''marketing'' reads the separate, smaller marketing sub-cap AND reports the overall remaining, because a marketing send consumes both. Any other value reads the overall allowance. Marketing costs Meta roughly 7.5x a service message, which is why it cannot share one counter.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Deliberately NOT touching usage_snapshot
-- ════════════════════════════════════════════════════════════════════════════
-- The obvious next step is to surface this on Settings → Plan & usage. It is
-- not taken, for two reasons.
--
-- Nothing can send a marketing message yet, so the meter would read 0 / 300 on
-- every account forever — a control that describes a capability the customer
-- does not have, which is the kind of thing this release is removing, not
-- adding.
--
-- And usage_snapshot is the single riskiest function in the schema to edit:
-- Settings reads a dozen keys off it, and rewriting it from memory once
-- already dropped four of them silently. It should be extended in the same
-- change that makes the number mean something, by someone looking at the
-- screen that renders it.
--
-- The ceiling is what matters now, and the ceiling is in place.

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'marketing has its own cap' as check,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'plan_limits'
                            and column_name = 'max_whatsapp_marketing')
            then 'PASS' else 'FAIL' end as result
union all
select 'no plan can spend itself negative on marketing',
       case when not exists (
              select 1 from public.plan_limits
               where price_inr is not null and price_inr > 0
                 -- ₹0.8631 per marketing message; refuse any cap that could
                 -- consume more than a third of the subscription.
                 and max_whatsapp_marketing is not null
                 and (max_whatsapp_marketing * 0.8631) > (price_inr / 3.0))
            then 'PASS' else 'FAIL — a marketing cap exceeds a third of its plan price' end
union all
select 'the one-argument allowance still exists for deployed functions',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'whatsapp_allowance'
                            and pg_get_function_identity_arguments(p.oid) = 'p_org_id uuid')
            then 'PASS' else 'FAIL — whatsapp-send would break on deploy' end
union all
select 'nothing can actually send a marketing message yet',
       'INFO — _shared/whatsapp.ts sends type:"text" only. This cap exists so that whoever adds templates has to reckon with it.'
union all
select 'marketing caps by plan',
       (select string_agg(plan || '=' || coalesce(max_whatsapp_marketing::text, 'unlimited'), ', '
                          order by position)
          from public.plan_limits);
