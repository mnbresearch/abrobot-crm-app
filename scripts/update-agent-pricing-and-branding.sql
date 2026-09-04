-- AbroBot CRM — authoritative pricing for the abrobot agent, plus two branding fixes.
--
-- Three changes:
--   1. abrobot: replace the pricing knowledge with the supplied text, verbatim.
--   2. abrobot: contact and booking URL -> https://www.abrobot.ai/support
--   3. mnb-research: pin the logo so it survives the site tag being removed.
--
-- Safe to re-run. The original knowledge is backed up first, so this is
-- reversible — see the bottom of the file.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Back up the current knowledge before touching it
-- ════════════════════════════════════════════════════════════════════════════
-- 13,804 characters of tuned instructions. Losing it to a bad regex would be
-- a genuinely bad afternoon, and this table already exists for operational
-- values with RLS enabled and no policies, so it is not readable from a browser.

create table if not exists public.app_settings (
  key text primary key, value text not null, updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

insert into public.app_settings (key, value)
select 'backup_knowledge_abrobot_' || to_char(now(), 'YYYYMMDD_HH24MI'), ac.knowledge
  from public.agent_config ac
  join public.organizations o on o.id = ac.org_id
 where o.slug = 'abrobot'
on conflict (key) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Strip the invented packages
-- ════════════════════════════════════════════════════════════════════════════
-- The live agent has been quoting a "Document Essentials Pack" with per-student
-- prices — I saw it do this while testing. Those names are somewhere in these
-- 13,804 characters, and simply appending correct pricing would leave the model
-- choosing between two contradictory sources. It has already shown which one it
-- picks.
--
-- Sentence-level removal rather than line-level: the knowledge is prose, so
-- cutting whole lines would take real content with it.

update public.agent_config ac
   set knowledge = regexp_replace(
         regexp_replace(
           regexp_replace(
             regexp_replace(
               ac.knowledge,
               '[^.!?\n]*Document Essentials Pack[^.!?\n]*[.!?]?', '', 'gi'),
             '[^.!?\n]*Application Success Pack[^.!?\n]*[.!?]?', '', 'gi'),
           '[^.!?\n]*(Study Abroad )?Launch Pack[^.!?\n]*[.!?]?', '', 'gi'),
         '[^.!?\n]*Elite Admission Studio[^.!?\n]*[.!?]?', '', 'gi')
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'abrobot';

-- Also drop the two other invented ones seen in live replies.
update public.agent_config ac
   set knowledge = regexp_replace(
         regexp_replace(ac.knowledge,
           '[^.!?\n]*Scholarship Hunter Pro[^.!?\n]*[.!?]?', '', 'gi'),
         '[^.!?\n]*Visa Ready Program[^.!?\n]*[.!?]?', '', 'gi')
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'abrobot';

-- Tidy the gaps left behind.
update public.agent_config ac
   set knowledge = regexp_replace(regexp_replace(ac.knowledge, '[ \t]{2,}', ' ', 'g'),
                                  E'\n{3,}', E'\n\n', 'g')
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'abrobot';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Append the authoritative pricing, verbatim
-- ════════════════════════════════════════════════════════════════════════════
-- Appended rather than inserted mid-document so the text stays exactly as
-- supplied, and placed last because later instructions carry more weight with
-- most models. The framing around it is deliberately absolute — the failure
-- mode here is invention, not omission.

update public.agent_config ac
   set knowledge = ac.knowledge || $kb$

## PRICING — THE ONLY PRICING THAT EXISTS
This section overrides anything else in these instructions. If a price is not
listed here, you do not know it: say you will have a human confirm it and take
their contact details. Never invent, estimate, round, or infer a price.

AbroBot pricing (single source of truth: abrobot.ai/pricing). Free: every account gets 5 credits a month plus a one-time 15-credit welcome grant; up to 3 counsellor chats a day; no card needed. Subscriptions (monthly, or annual at 20% off): Starter ₹999/month for 20 credits (₹9,588/year); Growth ₹2,499/month for 60 credits (₹23,988/year); Pro ₹4,999/month for 150 credits (₹47,998/year); Elite ₹9,999/month for 400 credits (₹95,998/year). Credit packs, available to everyone including free users, never expire: Micro Burst ₹499 for 10 credits; Credit Surge ₹999 for 25; Infinite Top-up ₹3,999 for 150. Expert services: SOP Optimisation ₹1,499; Uni-Select 10 ₹2,999; Interview Prep Session ₹1,999; Visa Guidance ₹3,499. Concierge admissions from ₹49,999, quoted after we see the profile. Credit costs: 1 credit for a chat or question-based tool; 5 for a document draft or deep university scan; 8 for a plagiarism scan; 10 for Resume Radar, Profile Evaluator, Originality Check or Similar-cohort outcomes; budget planner, loan estimator and tracker are free. Failed tool runs are refunded automatically. There are no other packs, bundles or prices — never quote a "Document Essentials Pack", "Application Success Pack", "Launch Pack" or "Elite Admission Studio". Support: mridulnanda@abrobot.ai.
$kb$
  from public.organizations o
 where o.id = ac.org_id
   and o.slug = 'abrobot'
   and position('THE ONLY PRICING THAT EXISTS' in ac.knowledge) = 0;  -- idempotent

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Contact and booking URL
-- ════════════════════════════════════════════════════════════════════════════
-- Both, because the widget uses contact_url for "Talk to expert" and
-- booking_url for the CTA button, and they were pointing at two different
-- places (a contactus page and a personal Calendly).

update public.agent_config ac
   set contact_url = 'https://www.abrobot.ai/support',
       booking_url = 'https://www.abrobot.ai/support'
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'abrobot';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Pin the MNB Research logo
-- ════════════════════════════════════════════════════════════════════════════
-- The widget falls back to AbroBot's logo when logo_url is null, so an MNB
-- Research visitor would see the wrong brand. Setting it explicitly means it
-- holds even if the site tag changes.

update public.agent_config ac
   set logo_url = 'https://www.mnbresearch.com/web/image/website/1/favicon'
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'mnb-research';

commit;


-- ── Verify ──────────────────────────────────────────────────────────────────
select o.slug,
       length(ac.knowledge)                                        as knowledge_chars,
       position('THE ONLY PRICING THAT EXISTS' in ac.knowledge) > 0 as has_new_pricing,
       (ac.knowledge ilike '%Document Essentials Pack%')            as still_has_bad_pack_1,
       (ac.knowledge ilike '%Application Success Pack%')            as still_has_bad_pack_2,
       (ac.knowledge ilike '%Launch Pack%')                         as still_has_bad_pack_3,
       (ac.knowledge ilike '%Elite Admission Studio%')              as still_has_bad_pack_4,
       ac.contact_url, ac.booking_url, ac.logo_url
  from public.agent_config ac
  join public.organizations o on o.id = ac.org_id
 where o.slug in ('abrobot', 'mnb-research')
 order by o.slug;

-- All four still_has_bad_pack_* must be false, and has_new_pricing true.

-- ── If it goes wrong ────────────────────────────────────────────────────────
-- The original is saved. To see the backups:
--   select key, length(value) from public.app_settings
--    where key like 'backup_knowledge_abrobot_%' order by key desc;
--
-- To restore one:
--   update public.agent_config ac set knowledge =
--     (select value from public.app_settings where key = '<the key above>')
--    from public.organizations o where o.id = ac.org_id and o.slug = 'abrobot';
