-- AbroBot CRM — make the nurture sequence belong to the tenant.
--
-- ── What was wrong ──────────────────────────────────────────────────────────
-- nurture/index.ts hardcoded three study-abroad emails: AbroBot's wordmark,
-- AbroBot's Calendly, AbroBot's WhatsApp number, "your university shortlist",
-- "based on 25 lakh+ real student journeys". It defaulted to slug 'abrobot',
-- and — the part that made it dangerous — the per-org check was fail-OPEN:
--
--     if (cfg && cfg.nurture_enabled === false) skip
--
-- An org that had never opened Settings had no agent_config row, so `cfg` was
-- null and the condition was false: it sent. On a single-tenant AbroBot this
-- was a sensible default. On a product sold to dental clinics and law firms it
-- means the first time cron runs correctly, a clinic's patients receive email
-- about university shortlists, signed AbroBot, from a domain the clinic has
-- never heard of. That is a spam complaint against OUR sending domain, which
-- costs every other tenant their deliverability.
--
-- It has been harmless only because cron was dead. Fixing cron without fixing
-- this would have shipped the bug.
--
-- ── The shape of the fix ────────────────────────────────────────────────────
-- The sequence becomes content the tenant writes, in the Templates screen they
-- already have — which also gives message_templates its first real purpose;
-- until now it was a notepad nothing read.
--
-- A tenant with no nurture templates sends nothing. Not "sends the default" —
-- nothing. There is no sensible default follow-up copy for a business you know
-- nothing about, and inventing one is exactly the failure above.

begin;

-- ── 1. Templates gain a nurture step ────────────────────────────────────────
alter table public.message_templates
  add column if not exists nurture_step integer;

comment on column public.message_templates.nurture_step is
  'When set (0,1,2…) this template IS the nurture email for that step. NULL means an ordinary template a human picks by hand. Only channel=email rows are used by the nurture engine.';

-- A step can only mean one thing per org, otherwise "step 1" is ambiguous and
-- which email a customer receives depends on row order.
create unique index if not exists message_templates_org_nurture_step
  on public.message_templates (org_id, nurture_step)
  where nurture_step is not null;

-- ── 2. Nurture is off unless switched on ────────────────────────────────────
alter table public.agent_config
  alter column nurture_enabled set default false;

-- Existing rows: leave an explicit true alone, but a NULL means "never
-- decided", and never-decided must not mean "email my customers".
update public.agent_config set nurture_enabled = false where nurture_enabled is null;

comment on column public.agent_config.nurture_enabled is
  'Opt-IN. The engine sends only when this is exactly true AND the org has nurture templates. Default false: automated email to a tenant''s contacts is never something to switch on for them.';

-- ── 3. Keep AbroBot's own sequence working ──────────────────────────────────
-- The three emails that were compiled into the edge function, moved into data
-- for the one org they were actually written for. Tokens are the same set the
-- Templates screen documents and LeadDetail already substitutes.
do $$
declare v_org uuid;
begin
  select id into v_org from public.organizations where slug = 'abrobot';
  if v_org is null then
    raise notice 'no org with slug abrobot — skipping seed';
    return;
  end if;

  insert into public.message_templates (org_id, name, channel, subject, body, nurture_step)
  values
    (v_org, 'Nurture 1 — free assessment', 'email',
     '{{first_name}}, your free AbroBot study-abroad assessment',
     'Hi {{first_name}},

Thanks for reaching out to {{brand}} about {{course}} in {{country}}.

Here is how we can help you move forward:
• A profile-matched university shortlist (ambitious / target / safe)
• A cautious read on your visa and admission chances
• Scholarships you actually qualify for

The fastest next step is a quick, free call with a counsellor who can map this out for you personally.', 0),

    (v_org, 'Nurture 2 — this week''s plan', 'email',
     '{{first_name}}, a few things worth doing this week for {{country}}',
     'Hi {{first_name}},

Intakes and scholarship deadlines for {{country}} move faster than most students expect. To stay ahead for {{course}}, this is the order that works best:

1. Lock your university shortlist early — more scholarship seats are open
2. Start your SOP
3. Check your visa readiness before you apply

Want a counsellor to build this plan around your profile? Grab a free slot below.', 1),

    (v_org, 'Nurture 3 — last nudge', 'email',
     '{{first_name}}, one last nudge from {{brand}}',
     'Hi {{first_name}},

I don''t want your {{country}} plan to stall. If now is the right time, a 15-minute free call is the quickest way to get a clear, personalised roadmap — universities, scholarships, visa and costs.

Otherwise, book a time that suits you below and a counsellor will take it from there.', 2)
  on conflict (org_id, nurture_step) where nurture_step is not null do nothing;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   select o.slug, c.nurture_enabled,
--          (select count(*) from message_templates t
--            where t.org_id = o.id and t.nurture_step is not null) as steps
--     from organizations o left join agent_config c on c.org_id = o.id
--    order by o.slug;
--
-- Any org with nurture_enabled = true and steps = 0 sends nothing, by design.
