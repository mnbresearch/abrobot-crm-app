-- ════════════════════════════════════════════════════════════════════════════
-- Correct the mnb-research agent's knowledge about AbroBot CRM.
--
-- WHY THIS EXISTS
-- ───────────────
-- The landing page at crm.mnbresearch.com/ has a live assistant board, and it
-- calls chat-agent with org = 'mnb-research'. That was a reasonable choice —
-- that org already held product knowledge and its pipeline is where CRM buyers
-- belong. But its knowledge base is a MULTI-PRODUCT MNB Research blob, so on
-- the CRM's own front page the agent answers as a general MNB assistant.
--
-- Probed live on 29 September 2026, it said all four of these:
--
--   Q "Can I get WhatsApp alerts when a new lead arrives?"
--   A "Yes - our AbroBot CRM Growth plan (Rs 2,499/month) adds a WhatsApp-
--      enabled AI lead-capture agent that pings you instantly."
--      FALSE. The only new-lead alert primitive is notifyNewLead(), which is
--      Telegram-only. WhatsApp sends TO a lead; nothing alerts the owner.
--
--   Q "Does my subscription auto-renew?"
--   A "Yes - our SaaS plans renew each month until you cancel."
--      FALSE, and commercially the most dangerous of the four. There is no
--      auto-renewal: no eNACH, no UPI AutoPay. Subscriptions expire and the
--      customer pays again by hand. A customer who believes this churns
--      silently and blames us for it.
--
--   Q "What do I get on the free plan?"
--   A "Raksha AI ... ABROFIT ... CreatorLift ... AbroBot (study-abroad
--      mentor) - 10-day free trial."
--      Wrong product entirely, and the trial was retired by
--      20260908090000_pricing_reset.sql. Asked on a page whose hero says
--      "Free plan, no card", this makes the company look incoherent.
--
--   Q "How do I add my team members?"
--   A "Which MNB product are you using (e.g., AbroBot CRM, YarnTally, etc.)?"
--      Asked of someone standing on the AbroBot CRM landing page.
--
-- Also seen: "instant push/email alerts" (neither exists) and an unprompted
-- pitch for a Rs 9,999 AI Transformation Assessment, which is MNB Research
-- consulting, not this product.
--
-- WHY IT PREPENDS RATHER THAN APPENDS
-- ───────────────────────────────────
-- scripts/update-agent-pricing-and-branding.sql learned this the hard way, and
-- its note is worth repeating: "Appending correct pricing under contradictory
-- text just gives the model two sources and lets it choose, and it has already
-- shown you which one it picks." So this does both — it removes the specific
-- false sentences AND puts the authoritative block FIRST, labelled as taking
-- precedence.
--
-- Every number below is from the migrations, not from marketing copy:
--   plan_limits as inserted by 20260908090000_pricing_reset.sql and then
--   overridden for 'free' by 20260911090000_tenant_agent_defaults.sql:307-312
--   (free was 0/0/0 and is now 50 records, 50 AI replies, 20 emails),
--   max_whatsapp / max_whatsapp_marketing from 20260911100000.
--
-- Safe to re-run. Reversible — see the bottom of the file.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. Back up first
-- ────────────────────────────────────────────────────────────────────────────
-- app_settings already exists for operational values, with RLS on and no
-- policies, so it is not readable from a browser.

create table if not exists public.app_settings (
  key text primary key, value text not null, updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

insert into public.app_settings (key, value)
select 'backup_knowledge_mnbresearch_' || to_char(now(), 'YYYYMMDD_HH24MI'),
       coalesce(ac.knowledge, '')
  from public.agent_config ac
  join public.organizations o on o.id = ac.org_id
 where o.slug = 'mnb-research'
on conflict (key) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Remove the false sentences
-- ────────────────────────────────────────────────────────────────────────────
-- Sentence-level, not line-level: the knowledge is prose, so cutting whole
-- lines would take real content with it. Each pattern is anchored on a claim
-- that is provably untrue, not on a topic — "WhatsApp" on its own is fine and
-- must survive, because WhatsApp messaging to leads is real on Growth and up.

-- On the alert patterns, specifically. My first attempt was ONE broad rule:
--   '...(whatsapp|push|sms|email)...{0,80}...(alert|notif|pings you)...'
-- Tested against sample prose it failed in both directions at once. It DESTROYED
-- "Email campaigns let you notify your whole list in one go." — a real feature —
-- and it MISSED "We can notify you by email when a new lead comes in.", because
-- there the channel follows the verb instead of preceding it.
--
-- Hence three narrow rules. Note the asymmetry between P3 and the rest: WhatsApp
-- can be matched loosely because it is NEVER an owner-alert channel, whereas
-- "email" is an everyday campaign and nurture word and must only match when it
-- is bound tightly to an alert noun. All 15 sample sentences now classify
-- correctly in both directions.

update public.agent_config ac
   set knowledge = regexp_replace(
         regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   coalesce(ac.knowledge, ''),
                   -- auto-renewal, in any phrasing that asserts it
                   '[^.!?]*\m(auto[- ]?renew\w*|renews? (each|every) month|recurring (billing|payment|mandate)|until you cancel)\M[^.!?]*[.!?]\s*',
                   '', 'gi'),
                 -- P1: channel bound directly to an alert noun
                 '[^.!?]*\m(whatsapp|push|sms|e-?mail)\M[-\s/]{0,3}\m(alert|alerts|notification|notifications)\M[^.!?]*[.!?]\s*',
                 '', 'gi'),
               -- P2: "notify/alert/ping you by|via|on <channel>"
               '[^.!?]*\m(notify|alert|alerts|notifies|ping|pings)\M\s+you\s+(by|via|on|through)\s+\m(whatsapp|push|sms|e-?mail)\M[^.!?]*[.!?]\s*',
               '', 'gi'),
             -- P3: WhatsApp near any notify verb (safe to be loose; see above)
             '[^.!?]*\mwhatsapp\M[^.!?]{0,80}\m(pings? you|notif\w*|alerts?)\M[^.!?]*[.!?]\s*',
             '', 'gi'),
           -- the retired trial
           '[^.!?]*\m(free trial|[0-9]+[- ]day trial|trial period)\M[^.!?]*[.!?]\s*',
           '', 'gi'),
         -- consulting cross-sell, which does not belong on a CRM product page
         '[^.!?]*\mAI Transformation Assessment\M[^.!?]*[.!?]\s*',
         '', 'gi')
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'mnb-research';

-- Tidy the whitespace those removals leave behind.
update public.agent_config ac
   set knowledge = btrim(regexp_replace(regexp_replace(ac.knowledge, '[ \t]{2,}', ' ', 'g'),
                                        E'\n{3,}', E'\n\n', 'g'))
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'mnb-research';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Prepend the authoritative block
-- ────────────────────────────────────────────────────────────────────────────

update public.agent_config ac
   set knowledge = $kb$== AUTHORITATIVE: AbroBot CRM ==
These facts were verified against the product on 29 September 2026. Where
anything later in this document disagrees with this section, THIS SECTION IS
CORRECT and the other text is out of date. Never contradict it.

SCOPE
On crm.mnbresearch.com you are the assistant for AbroBot CRM, one product. Do
not ask the visitor which MNB product they mean, and do not bring up Raksha AI,
ABROFIT, CreatorLift, YarnTally, the study-abroad mentor, or consulting
engagements such as the AI Transformation Assessment. If someone asks about
those specifically, say they are separate MNB Research products and offer to
pass the enquiry on.

WHAT ABROBOT CRM IS
An AI lead-management CRM for Indian small and medium businesses. An AI agent
answers enquiries on the customer's own website, captures the lead with no form
to fill in, scores it on intent and urgency as it arrives, can route it to the
least-loaded team member, sends the owner a Telegram alert, and runs follow-up
email sequences on a schedule.

PLANS — exact, and enforced in the database
- Free: Rs 0. No card, and it does not expire. 1 user, 50 records in total
  (a standing cap, not monthly), 50 AI replies per month, 20 emails per month.
  No automations, no WhatsApp, no API.
- Starter: Rs 999/month. 3 users, 1,000 records, 1,000 AI replies/month,
  3 automation rules, 300 emails/month. No WhatsApp, no API.
- Growth: Rs 2,499/month. 10 users, 10,000 records, 5,000 AI replies/month,
  25 automation rules, 3,000 emails/month, WhatsApp (1,500 messages/month, of
  which 300 may be marketing). No API.
- Business: Rs 4,999/month. 30 users, 50,000 records, 10,000 AI replies/month,
  100 automation rules, 6,000 emails/month, WhatsApp (3,000/month, 600
  marketing), REST API access.
- Enterprise: custom pricing, no fixed caps.
Prices are per business, not per user. There is no free trial of a paid plan —
the Free plan is the way to try it, and it is a ceiling rather than a countdown.

BILLING — say this accurately, it matters
There is NO auto-renewal. Nothing is charged automatically: no eNACH, no UPI
AutoPay, no stored recurring mandate. A plan runs for its period and then
expires, and the customer pays again by hand to continue. When a plan lapses
the account becomes read-only — the data is untouched and comes straight back
on payment. If asked whether it renews itself, say plainly that it does not and
that we will remind them.

ALERTS — Telegram only
New-lead alerts go to Telegram. The owner connects a Telegram bot in
Integrations by pasting a bot token and a chat ID; until both are set, no alert
is sent. There are no WhatsApp alerts, no push notifications and no email
alerts to the owner. Do not offer them on any plan at any price.
WhatsApp is a channel for messaging the LEAD, not for alerting the owner. It is
available on Growth and above, is sent by a person from the record screen or as
an autoreply, and requires the customer's own Meta WhatsApp Cloud API number.
It is newly built, so describe it as available on Growth and offer a walkthrough
rather than promising it works out of the box.

FOLLOW-UP SEQUENCES
Scheduled email follow-ups run daily. A sequence stops when the record is
marked won or lost, or when the person unsubscribes. It does NOT detect an
email reply — nothing reads inbound email — so do not say it stops when someone
replies.

TEAM
Invites are created in the app, but no invitation email is sent: the admin
copies the invite link and sends it to their colleague themselves. Say so if
asked, and frame it as a link to share.

SCORING
Every enquiry is scored on intent and urgency as it arrives. The score is set at
intake; it is not continuously recalculated. An admin can re-score everything on
demand from Settings, Scoring.

ROUTING
Assignment picks the team member with the fewest open records. It needs an
automation rule, so it is Starter and up — the Free plan has no automations. Say
"Starter and up" rather than implying it works on Free.

HONESTY RULE
If you are not certain something exists, say you will check rather than
guessing. Never invent a feature, a plan, a price, a discount or a deadline. An
enquirer who signs up for something you described and cannot find it is worse
than one who never signed up.

== END AUTHORITATIVE SECTION ==

$kb$ || coalesce(ac.knowledge, '')
  from public.organizations o
 where o.id = ac.org_id
   and o.slug = 'mnb-research'
   -- Idempotent: re-running must not stack the block.
   and coalesce(ac.knowledge, '') not like '%== AUTHORITATIVE: AbroBot CRM ==%';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Guardrails — the short never-say list
-- ────────────────────────────────────────────────────────────────────────────
-- Separate column on purpose: chat-agent puts guardrails in the system prompt
-- alongside the knowledge, and a handful of blunt prohibitions survives model
-- pressure better buried in prose.

update public.agent_config ac
   set guardrails = $g$Never claim any of the following, on any plan, at any price:
- that subscriptions auto-renew, or that anything is charged automatically
- that new-lead alerts can arrive by WhatsApp, push notification or email (Telegram only)
- that a follow-up sequence stops when someone replies to an email
- that there is a free trial of a paid plan
- that invitation emails are sent to new team members
Do not ask which MNB product the visitor means, and do not pitch consulting
engagements. If unsure, offer to check rather than guessing.$g$
  from public.organizations o
 where o.id = ac.org_id and o.slug = 'mnb-research';

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFY — every one of these must read false / 0
-- ════════════════════════════════════════════════════════════════════════════
-- IMPORTANT: every check below runs against `legacy` — the text AFTER the
-- authoritative block — not against the whole column.
--
-- My first version of this query checked ac.knowledge directly, which is wrong
-- in a way that would have looked reassuring: the authoritative block itself
-- contains the strings "auto-renewal", "free trial" and "WhatsApp alerts" (in
-- sentences that NEGATE them, e.g. "There is NO auto-renewal"). So every
-- still_claims_* column would have reported true after a completely successful
-- run, and the natural reaction to that is to run the removals again. Checking
-- only the legacy remainder is the whole point.

with k as (
  select ac.knowledge as full,
         -- NOT coalesce(split_part(...), knowledge): split_part returns '' when
         -- the delimiter is absent, and '' is not NULL, so coalesce would never
         -- fall back. If this script had not run at all, `legacy` would be empty
         -- and every still_claims_* column below would read false — the most
         -- reassuring possible output for the one case that needs attention.
         case when ac.knowledge like '%== END AUTHORITATIVE SECTION ==%'
              then split_part(ac.knowledge, '== END AUTHORITATIVE SECTION ==', 2)
              else ac.knowledge
         end as legacy,
         ac.guardrails
    from public.agent_config ac
    join public.organizations o on o.id = ac.org_id
   where o.slug = 'mnb-research'
)
select
  length(full)                                              as knowledge_chars,
  length(legacy)                                            as legacy_chars,
  full like '%== AUTHORITATIVE: AbroBot CRM ==%'             as has_authoritative_block,
  left(full, 32) = '== AUTHORITATIVE: AbroBot CRM =='        as block_is_first,
  legacy ~* '\mauto[- ]?renew'                               as still_claims_autorenew,
  legacy ~* 'renews? (each|every) month'                     as still_claims_monthly_renewal,
  legacy ~* '\mfree trial\M'                                 as still_offers_trial,
  legacy ~* 'AI Transformation Assessment'                   as still_pitches_consulting,
  legacy ~* '\m(whatsapp|push|sms|e-?mail)\M[-\s/]{0,3}\m(alert|alerts|notification|notifications)\M'
                                                             as still_offers_wrong_channel_alerts,
  legacy ~* '\mwhatsapp\M[^.!?]{0,80}\m(pings? you|notif\w*|alerts?)\M'
                                                             as still_offers_whatsapp_alerts,
  -- Sanity check in the OTHER direction: WhatsApp-to-lead and email campaigns
  -- are real features and must NOT have been collateral damage. If the legacy
  -- text mentioned them before, it should still mention them.
  legacy ~* '\mwhatsapp\M'                                   as whatsapp_still_mentioned_somewhere,
  guardrails is not null                                     as guardrails_set
from k;

-- ════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════════
-- List the backups:
--   select key, length(value) from public.app_settings
--    where key like 'backup_knowledge_mnbresearch_%' order by key desc;
--
-- Restore one:
--   update public.agent_config ac
--      set knowledge = (select value from public.app_settings where key = '<key above>')
--     from public.organizations o
--    where o.id = ac.org_id and o.slug = 'mnb-research';
