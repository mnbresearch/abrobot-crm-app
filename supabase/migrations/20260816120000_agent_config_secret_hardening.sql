-- AbroBot CRM — reduce credential exposure in public.agent_config
--
-- NOT APPLIED. Review before running.
--
-- ── The problem ──────────────────────────────────────────────────────────────
-- Policy `agent_config_org` grants ALL (incl. SELECT) to any *active member*:
--
--   using: (is_super_admin() OR ((org_id = my_org()) AND is_active_member()))
--
-- agent_config holds groq_api_key, resend_api_key, whatsapp_token,
-- telegram_bot_token and app_secret, and the CRM frontend selects from the
-- table directly. So any counsellor can read those values from the browser.
--
-- Current exposure: DORMANT. profiles holds 1 super_admin + 1 org_admin and
-- zero counsellors, so nobody today can see a credential they aren't already
-- entitled to. This becomes live with the first counsellor invite.
--
-- ── Approaches that do NOT work (checked, so nobody re-treads this) ─────────
-- 1. Tighten the row policy to admins only.
--    BREAKS LOGIN. The auth bootstrap runs
--      agent_config.select("onboarded")
--    for *every* user, not just admins. RLS is row-level, so there is no way
--    to hide the secret columns while leaving `onboarded` readable.
--
-- 2. Column-level GRANTs.
--    Supabase authenticates every end user as the single `authenticated`
--    role, so column privileges cannot distinguish counsellor from admin.
--
-- 3. Replace the table with a masking view (NULL out secrets for non-admins).
--    BREAKS SETTINGS SAVE. The frontend persists with
--      .upsert(payload, { onConflict: "org_id" })
--    which PostgREST issues as INSERT ... ON CONFLICT DO UPDATE. Postgres
--    rejects ON CONFLICT against a view backed by INSTEAD OF triggers, and an
--    auto-updatable view cannot carry the masking CASE expressions. Verified
--    incompatible, not merely awkward.
--
-- 4. Move secrets to a separate agent_secrets table.
--    Correct end state, but the Settings page does select("*") + upsert() with
--    the secret columns inline — that is frontend code, which no longer
--    exists in source form. Blocked on the frontend rebuild.
--
-- ── What this migration therefore does ──────────────────────────────────────
-- Step 1 (safe, additive): add an is_org_admin() helper, so the eventual fix
--         and any admin-only policy has a tested predicate to build on.
-- Step 2 (safe, additive): an admin-only view for reading secrets, so future
--         frontend code has a correct path to migrate onto. Nothing uses it
--         yet; adding it changes no current behaviour.
-- Step 3 (OPTIONAL, commented out): empty the secret columns and rely on
--         edge-function environment secrets instead. This is the only option
--         that actually removes the exposure today. See the notes before it.

begin;

-- ── Step 1: role predicate ──────────────────────────────────────────────────
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.status = 'active'
      and p.role in ('org_admin', 'super_admin')
  );
$$;

comment on function public.is_org_admin() is
  'True when the caller is an active org_admin or super_admin. Companion to is_active_member().';

grant execute on function public.is_org_admin() to authenticated;

-- ── Step 2: admin-only secret reader ────────────────────────────────────────
-- security_invoker = on so the underlying table RLS still applies; the extra
-- is_org_admin() predicate narrows it further. Nothing reads this yet — it
-- exists so the rebuilt Settings page has a correct target.
create or replace view public.agent_config_secrets
with (security_invoker = on) as
select
  org_id,
  groq_api_key,
  resend_api_key,
  whatsapp_token,
  telegram_bot_token,
  app_secret
from public.agent_config
where public.is_org_admin();

comment on view public.agent_config_secrets is
  'Admin-only read path for agent_config credentials. Read-only by design: writes must continue to go to agent_config until the frontend is rebuilt.';

commit;


-- ── Step 3 (OPTIONAL — read carefully, then run by hand) ────────────────────
-- Removes the exposure now, without waiting for the frontend.
--
-- Preconditions — all three edge-function paths already fall back to
-- environment secrets, so emptying the columns does not break delivery:
--   chat-agent      cfg.groq_api_key      || GROQ_API_KEY        (pre-existing)
--   _shared/notify  telegram_bot_token    || TELEGRAM_BOT_TOKEN  (added 2026-08-16)
--   _shared/whatsapp whatsapp_token       || WHATSAPP_TOKEN      (added 2026-08-16)
--
-- resend_api_key is stored but never read by any function — nurture,
-- send-campaign and app-signup all use the RESEND_API_KEY env var. Clearing it
-- has no runtime effect at all.
--
-- Before running:
--   1. Set the corresponding function secrets:
--        npx supabase@latest secrets set GROQ_API_KEY=... TELEGRAM_BOT_TOKEN=... WHATSAPP_TOKEN=...
--   2. Copy the existing values somewhere safe first:
--        select org_id, groq_api_key, resend_api_key, whatsapp_token, telegram_bot_token
--        from public.agent_config;
--   3. Treat every value you just copied as compromised and rotate it — these
--      have been readable by the browser, so assume they leaked.
--
-- Note: the Settings page will then show these fields blank. That is expected;
-- saving a new value still works and will again take precedence over the env
-- fallback.
--
-- update public.agent_config set
--   groq_api_key      = null,
--   resend_api_key    = null,
--   whatsapp_token    = null,
--   telegram_bot_token = null;
--
-- app_secret is deliberately NOT cleared: app-signup compares against the
-- APP_WEBHOOK_SECRET env var, and app.abrobot.ai is out of scope for this work.
