-- ════════════════════════════════════════════════════════════════════════════
-- Turn on new-lead Telegram alerts for the mnb-research organisation.
--
-- WHY THIS IS SQL AND NOT A CLICK IN THE APP
-- ──────────────────────────────────────────
-- The Platform console shows mnb-research with TEAM = 0. No profile has
-- org_id = mnb-research, so there is no account that can sign in to that
-- tenant and open Settings -> Integrations. That is also the reason the chat
-- ID was never set in the first place.
--
-- The super-admin console cannot do it either: its Members dialog is
-- admin_set_member, a lockout-recovery tool that changes an EXISTING member's
-- role or status. It takes a user id, and a profile carries a single org_id —
-- so pointing the owner's own account at mnb-research would take away his
-- access to abrobot. Not a trade worth making for a config field.
--
-- WHY IT MATTERS MORE THAN IT LOOKS
-- ─────────────────────────────────
-- The landing page's live assistant board captures into mnb-research
-- (DEMO_ORG in app/src/routes/Landing.tsx). With zero members, a lead captured
-- there is in a tenant nobody can open in the UI. The Telegram alert is
-- currently the ONLY way a human finds out that someone left their details on
-- the front page. Until a member exists, this is not a nicety.
--
-- notify.ts returns { sent: false, reason: "not_configured" } when EITHER the
-- token or the chat id is missing, and that return value is not surfaced
-- anywhere a person looks. So this has been failing silently, not loudly.
--
-- The bot token is deliberately NOT set here: notify.ts falls back to
-- PLATFORM_TELEGRAM_TOKEN (the TELEGRAM_BOT_TOKEN project secret) whenever an
-- org has none of its own, which is what the Integrations screen means by
-- "Leave blank to use ours". Nothing secret belongs in this file.
-- ════════════════════════════════════════════════════════════════════════════

-- ── STEP 1: get the chat id ─────────────────────────────────────────────────
-- On your phone, message @userinfobot on Telegram. It replies with your
-- numeric Id. That is the chat id for alerts sent to you personally.
--
-- For a TEAM GROUP instead: add the bot to the group, send any message there,
-- and use the group's id — those start with -100 (note the minus sign).
--
-- A chat id is an identifier, not a credential. It is safe in this file.

-- ── STEP 2: replace the placeholder and run ─────────────────────────────────

-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ CORRECTED 29 Sep 2026. The first version of this file COMMITTED THE      │
-- │ LITERAL PLACEHOLDER, and its guard is why.                               │
-- │                                                                          │
-- │ It read:                                                                 │
-- │     select count(*) into n ... where telegram_chat_id = 'PASTE_CHAT_ID_HERE';
-- │     if n <> 1 then raise exception ...                                   │
-- │                                                                          │
-- │ which RAISES when the placeholder has been replaced and PASSES when it   │
-- │ has not — precisely backwards. The check meant to stop an unedited run   │
-- │ was the thing that waved it through.                                     │
-- │                                                                          │
-- │ The guard below now asserts the value is a Telegram chat id: all digits, │
-- │ optional leading minus for a group. That rejects the placeholder without │
-- │ having to name it, so no future edit of the placeholder text can slip    │
-- │ past it either.                                                          │
-- └──────────────────────────────────────────────────────────────────────────┘

begin;

update public.agent_config ac
   set telegram_chat_id = '1845062994',   -- MRIDUL NANDA, via @userinfobot 29 Sep 2026
       -- Belt and braces: alerts are already on for this org, but a chat id
       -- with the flag off would be just as silent as no chat id at all.
       notify_new_leads = true
  from public.organizations o
 where o.id = ac.org_id
   and o.slug = 'mnb-research';

do $$
declare n int; v text;
begin
  select count(*), max(ac.telegram_chat_id) into n, v
    from public.agent_config ac
    join public.organizations o on o.id = ac.org_id
   where o.slug = 'mnb-research';

  if n <> 1 then
    raise exception
      'Expected exactly 1 agent_config row for mnb-research, found %. '
      'Nothing was changed.', n;
  end if;

  -- Positive assertion about the SHAPE of the value, not the absence of one
  -- particular string. A Telegram chat id is digits, with a leading minus for
  -- a group (-100...). The placeholder cannot satisfy this, and neither can a
  -- half-pasted value or an @username.
  if v is null or v !~ '^-?[0-9]+$' then
    raise exception
      'telegram_chat_id is "%", which is not a Telegram chat id. Replace the '
      'placeholder with the number @userinfobot gives you (or the group id, '
      'which starts with -100). Nothing was changed.', coalesce(v, '<null>');
  end if;
end $$;

commit;

-- ── STEP 3: verify the stored state ─────────────────────────────────────────
select o.slug,
       ac.notify_new_leads                                as alerts_on,
       ac.telegram_chat_id is not null
         and ac.telegram_chat_id <> ''                    as chat_id_set,
       ac.telegram_chat_id                                as chat_id,
       ac.telegram_bot_token is not null                  as has_own_token_else_platform,
       ac.telegram_chat_id ~ '^-?[0-9]+$'                 as chat_id_looks_numeric
  from public.agent_config ac
  join public.organizations o on o.id = ac.org_id
 where o.slug = 'mnb-research';

-- ── If you are NOT setting the real id right now, run this ──────────────────
-- The broken first version of this file committed the literal string
-- 'PASTE_CHAT_ID_HERE' into telegram_chat_id. That value cannot receive a
-- message, but it is not null — so Integrations now renders "•••••• (saved)"
-- and its status object reports chat_id_set: true. The screen asserts the
-- alerts are configured when they cannot fire: worse than the blank it
-- replaced, because a blank is honest.
--
-- Clearing it restores the honest "not configured" state until you have the
-- real number. Delete these three lines once the real id is in.
--
--   update public.agent_config ac set telegram_chat_id = null
--     from public.organizations o
--    where o.id = ac.org_id and o.slug = 'mnb-research'
--      and ac.telegram_chat_id !~ '^-?[0-9]+$';

-- ── STEP 4: prove it end to end ─────────────────────────────────────────────
-- Stored state is not delivery. The only thing that proves the whole path —
-- including that the TELEGRAM_BOT_TOKEN project secret is actually set, and
-- that you have pressed Start on the bot so it is allowed to message you — is
-- a message arriving.
--
-- Telegram will NOT deliver to a user who has never started a conversation
-- with the bot. If the row above looks right and nothing arrives, that is the
-- most likely cause: open the bot in Telegram and press Start, then retry.
--
-- Easiest check: submit a test enquiry through the assistant on
-- https://crm.mnbresearch.com/ and leave a name. A Telegram message should
-- follow within a few seconds.
