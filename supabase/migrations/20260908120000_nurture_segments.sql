-- AbroBot CRM — follow-up sequences that know who they are talking to.
--
-- ── The limitation ──────────────────────────────────────────────────────────
-- 20260905130000 moved the nurture copy out of the edge function and into the
-- tenant's own Templates screen. That fixed the dangerous half of the problem:
-- a dental clinic no longer emails its patients about university shortlists.
--
-- What it left in place is a smaller assumption that turns out to be wrong for
-- almost every real business: ONE organisation gets ONE sequence. Every record
-- with an email address receives identical copy regardless of what they asked
-- about or which channel they arrived through.
--
-- MNB Research is the case that forces it. The same CRM holds people asking
-- about a ₹9,999 consulting assessment and people asking to buy AbroBot CRM at
-- ₹999 a month. Those are different products, different buyers and different
-- objections. A single sequence must either be so vague it persuades nobody, or
-- it is confidently about the wrong product half the time — which is the study-
-- abroad bug again, wearing a suit.
--
-- ── Why a new column and not leads.source ───────────────────────────────────
-- The obvious move is to segment on leads.source, and it is wrong. `source` is
-- the lead_source ENUM: whatsapp, chatbase, email, website, csv_import,
-- pdf_import, manual, referral, other. Three consequences, each fatal:
--
--   1. A tenant cannot invent a value. Writing 'crm-website' raises 22P02 —
--      which is precisely the bug DEPLOY-REMAINING.md records against
--      app-signup, where `source: "app"` made every signup fail while the
--      endpoint cheerfully returned ok:true. Reintroducing it here would abort
--      the transaction and silently roll this entire migration back.
--   2. The enum is global. Adding a value for one customer's funnel puts it in
--      every other customer's dropdown forever.
--   3. Two capture keys on the same channel share a source, so "issue a second
--      key to segment your follow-up" would not actually segment anything.
--
-- So segmentation gets its own per-tenant, free-text column. `source` keeps
-- meaning "which channel did this arrive on"; `segment` means "which audience
-- is this", which is the tenant's business and not ours to enumerate.
--
-- ── The change ──────────────────────────────────────────────────────────────
-- A capture key may carry a SEGMENT. Records captured on it inherit it. A
-- template may name the segment it is written for. Templates naming none remain
-- the default sequence, exactly as today. So:
--
--   * a tenant who never touches this sees no change whatsoever
--   * a tenant who writes segment-specific copy gets it used for those records
--     and the default for everyone else
--   * a tenant with ONLY segment-specific copy sends nothing to the rest, which
--     is the right failure: silence beats the wrong pitch

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Capture keys carry a segment; records inherit it
-- ════════════════════════════════════════════════════════════════════════════

alter table public.webhook_keys
  add column if not exists segment text;

comment on column public.webhook_keys.segment is
  'Free-text audience label for records captured on this key, e.g. ''crm-website''. Copied to leads.segment at intake and matched against message_templates.nurture_segment. NULL means the record joins the default follow-up sequence. Deliberately not lead_source: that is a global enum a tenant cannot extend.';

alter table public.leads
  add column if not exists segment text;

comment on column public.leads.segment is
  'Which audience this record belongs to, inherited from the capture key. Chooses the follow-up sequence. NULL means the default sequence.';

-- The nurture engine queries one segment at a time, per org, so this is the
-- index it actually uses. Partial: the overwhelming majority of rows are NULL
-- and those are found by the default-sequence query, which cannot use an index
-- on a value it is looking for the absence of.
create index if not exists leads_org_segment_idx
  on public.leads (org_id, segment)
  where segment is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Templates name the audience they are written for
-- ════════════════════════════════════════════════════════════════════════════

alter table public.message_templates
  add column if not exists nurture_segment text;

comment on column public.message_templates.nurture_segment is
  'The audience this follow-up step is written for, matching leads.segment. NULL means the default sequence, used for any record with no sequence of its own. Ignored unless nurture_step is set.';

-- The old index made a step unique per org. It has to become unique per
-- (org, segment) or a tenant cannot have a step 1 for two audiences — which is
-- the entire point of this migration.
--
-- Three deliberate details:
--
--   coalesce() rather than a plain three-column index, because NULLs are
--   distinct in a unique index. Without it a tenant could save two different
--   default step 1 templates and which one a customer receives would depend on
--   row order — the exact ambiguity the original index existed to prevent.
--
--   The parentheses around coalesce() are not decoration. CREATE INDEX only
--   lets you omit them when the expression "has the form of a function call",
--   and COALESCE is a SQL construct rather than an ordinary function.
--
--   channel = 'email' in the predicate, because the engine reads only email
--   templates. Without it a WhatsApp row carrying a step would occupy a slot
--   nothing will ever send, blocking the real email template for that step.
drop index if exists public.message_templates_org_nurture_step;

create unique index if not exists message_templates_org_segment_step
  on public.message_templates (org_id, (coalesce(nurture_segment, '')), nurture_step)
  where nurture_step is not null and channel = 'email';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. A capture key for the CRM's own website
-- ════════════════════════════════════════════════════════════════════════════
-- crm.mnbresearch.com sells AbroBot CRM. Until now every button on it left the
-- site — to a signup page or to WhatsApp — so a visitor who was interested but
-- not ready left no trace at all. A product whose pitch is "capture every lead
-- the moment it arrives" was the only site on the internet not running it.
--
-- source stays 'website' (a real enum member; this genuinely is a website
-- form). segment is what makes these records distinguishable from the
-- consulting enquiries sharing the organisation. The key is separate from the
-- existing website key so it can be revoked on its own if the public page is
-- ever abused, without taking consulting capture down with it.

do $$
declare v_org uuid; v_key text; v_steps int;
begin
  select id into v_org from public.organizations where slug = 'mnb-research';
  if v_org is null then
    raise notice 'No org with slug mnb-research — run scripts/create-mnb-research-org.sql first. Skipping sections 3 and 4.';
    return;
  end if;

  select key into v_key from public.webhook_keys
   where org_id = v_org and segment = 'crm-website' and active limit 1;

  if v_key is null then
    v_key := 'crmweb_' || replace(gen_random_uuid()::text, '-', '');
    insert into public.webhook_keys (org_id, key, label, source, active, segment)
    values (v_org, v_key, 'crm.mnbresearch.com — plan enquiry form', 'website', true, 'crm-website');
    raise notice 'Created the CRM website capture key.';
  else
    raise notice 'CRM website capture key already exists — reusing it.';
  end if;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 4. Follow-up written for someone buying software
  -- ══════════════════════════════════════════════════════════════════════════
  -- Scoped to segment 'crm-website', so consulting enquiries in the same
  -- organisation are untouched by it. They have no default sequence and
  -- therefore still receive nothing, which is the behaviour today.
  --
  -- The copy answers the objections in the order they actually arrive. Nobody
  -- abandons a ₹999 CRM because they wanted more features; they abandon it
  -- because they are not sure it will work with what they already have, and
  -- because moving is a chore. So: first email proves a human is there, second
  -- removes the migration excuse, third gives a reason to decide.
  --
  -- {{custom.interested_in}} is the plan they clicked, filled by lead-webhook
  -- from the form. The field already exists on this org.
  --
  -- Insert-if-absent rather than ON CONFLICT ... DO UPDATE, for two reasons.
  -- Inferring a partial index built on an expression is the fussiest corner of
  -- ON CONFLICT syntax and this file has to run first time. And DO UPDATE would
  -- silently overwrite the copy on every re-run — so any edit made in the
  -- Templates screen would be reverted by a routine migration replay, which is
  -- not a thing a migration should ever do to someone's words.
  insert into public.message_templates
    (org_id, name, channel, subject, body, nurture_step, nurture_segment)
  select v_org, t.name, 'email', t.subject, t.body, t.step, 'crm-website'
    from (values
    ('CRM 1 — what happens next',
     '{{first_name}}, about AbroBot CRM',
     'Hi {{first_name}},

Thanks for asking about AbroBot CRM — you mentioned {{custom.interested_in}}. A real person read your enquiry, and I''ll come back to you today with a straight answer rather than a brochure.

While you wait, the three things people usually want to know:

WHAT IT COSTS. ₹999 a month for Starter, flat for the whole business. Not per user. Three users, 1,000 records, the AI website agent and the full pipeline are all in that price.

WHAT IT DOES. An AI agent sits on your website and answers visitors, captures them as records, and pings your phone within about a minute. Then the pipeline tells you who to call next.

WHEN IT WORKS. Same day. Signing up is free, so you can build your pipeline and tune the agent before you pay anything, and a small free allowance lets you put a few real leads through it and see what happens.

If it would be quicker to just talk, reply to this email or send a WhatsApp to +91 97114 88480.', 0),

    ('CRM 2 — moving from what you use now',
     '{{first_name}}, moving your existing leads across',
     'Hi {{first_name}},

The question that stops most people is not the price — it is the thought of moving.

It is genuinely small:

1. Export what you have now to a CSV. Every CRM and every spreadsheet does this.
2. Import it. The importer matches your columns to ours on screen, so you can see what is going where before anything is saved.
3. Paste one line of code into your website. That is the AI agent live.

Most businesses are running properly inside a day. Being straight about what is free and what is not: building your pipeline and fields costs nothing, and the free allowance is enough records to prove your column mapping on a sample — but bringing your full list across needs a paid plan, because that storage is the thing you are actually buying.

Two things worth saying plainly. Your data stays yours — you can export the whole record set to CSV at any time, including your custom fields, and there is no export fee and no notice period. And there is no lock-in, because there is no subscription to be locked into: each payment buys one month and then stops on its own. We create no recurring mandate on your card, so there is nothing to cancel — if you do not want another month, you simply do not pay for one.

Want me to look at your export and tell you honestly whether it will map cleanly? Reply with it attached.', 1),

    ('CRM 3 — the cost of waiting',
     '{{first_name}}, one last thought on {{brand}}',
     'Hi {{first_name}},

I won''t keep emailing after this one.

The reason to decide either way is simple. Every week without capture, the enquiries that arrive while you are busy, asleep or with another customer are gone — and you never find out how many there were, because nothing recorded them. That number is invisible right up until you start measuring it, which is usually when people wish they had started sooner.

₹999 a month, free to set up before you pay, and nothing to cancel afterwards — each payment buys one month and stops there, with no recurring mandate on your card.

If it is not the right time, that is a perfectly good answer — just reply "not now" and I''ll close it off rather than chase you.

If it is, reply to this email or WhatsApp +91 97114 88480 and I''ll have you live today.', 2)
       ) as t(name, subject, body, step)
   where not exists (
     select 1 from public.message_templates m
      where m.org_id = v_org
        and m.nurture_segment = 'crm-website'
        and m.nurture_step = t.step
   );

  select count(*) into v_steps from public.message_templates
   where org_id = v_org and nurture_segment = 'crm-website' and nurture_step is not null;
  raise notice 'CRM buyer follow-up: % step(s) now written.', v_steps;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'capture keys and records carry a segment' as check,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public'
                     and ((table_name = 'webhook_keys' and column_name = 'segment')
                       or (table_name = 'leads'        and column_name = 'segment')
                       or (table_name = 'message_templates' and column_name = 'nurture_segment'))) = 3
            then 'PASS' else 'FAIL — one of the three columns is missing' end as result
union all
select 'segment is free text, not the lead_source enum',
       case when (select data_type from information_schema.columns
                   where table_schema = 'public' and table_name = 'leads' and column_name = 'segment') = 'text'
            then 'PASS' else 'FAIL — a tenant cannot invent a value' end
union all
select 'a step is unique per audience, not per org',
       case when exists (select 1 from pg_indexes
                          where schemaname = 'public'
                            and indexname = 'message_templates_org_segment_step')
             and not exists (select 1 from pg_indexes
                              where schemaname = 'public'
                                and indexname = 'message_templates_org_nurture_step')
            then 'PASS' else 'FAIL — the old org-wide index is still there' end
union all
select 'the CRM website has its own capture key',
       coalesce((select 'PASS — source ' || wk.source || ', segment ' || wk.segment
                   from public.webhook_keys wk
                   join public.organizations o on o.id = wk.org_id
                  where o.slug = 'mnb-research' and wk.segment = 'crm-website' and wk.active
                  limit 1),
                'FAIL — no active crm-website capture key')
union all
select 'CRM buyers have their own follow-up',
       coalesce((select count(*)::text || ' step(s), audience crm-website'
                   from public.message_templates t
                   join public.organizations o on o.id = t.org_id
                  where o.slug = 'mnb-research' and t.nurture_segment = 'crm-website'
                    and t.nurture_step is not null),
                '0')
union all
-- The point of the whole migration: consulting enquiries in the SAME org must
-- not receive the software copy. They have no default sequence, so they get
-- nothing — which is what they got yesterday.
select 'consulting enquiries are not in that sequence',
       case when not exists (select 1 from public.message_templates t
                              join public.organizations o on o.id = t.org_id
                             where o.slug = 'mnb-research'
                               and t.nurture_step is not null
                               and t.nurture_segment is null)
            then 'PASS — no default sequence, so they receive nothing'
            else 'CHECK — a default sequence exists and will also reach them' end
union all
-- Existing records keep segment NULL, so nothing that is already in the CRM is
-- moved into the new sequence by this migration. Worth asserting rather than
-- assuming: the alternative is emailing a stranger about software they never
-- asked about, on the first cron run after deploy.
select 'no existing record was swept into the new sequence',
       (select count(*)::text || ' record(s) now carry a segment (expected 0 before any form submission)'
          from public.leads where segment is not null);

-- ── The key itself. Paste this into product.html (CAPTURE_KEY). ─────────────
select wk.key as capture_key, wk.label, wk.source, wk.segment
  from public.webhook_keys wk
  join public.organizations o on o.id = wk.org_id
 where o.slug = 'mnb-research' and wk.segment = 'crm-website' and wk.active;
