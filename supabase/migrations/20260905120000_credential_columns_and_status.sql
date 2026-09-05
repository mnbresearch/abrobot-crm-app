-- AbroBot CRM — take the credential columns away from the browser, and give
-- the browser an honest answer about what is actually configured.
--
-- ── Why this is now possible ────────────────────────────────────────────────
-- 20260816120000_agent_config_secret_hardening.sql catalogued four approaches
-- and rejected all of them. Three of those rejections still stand. The fourth
-- is now stale, and one that was dismissed too quickly turns out to be right.
--
-- Restated: agent_config keeps groq_api_key, resend_api_key, whatsapp_token,
-- telegram_bot_token and app_secret on the same row as the greeting. Policy
-- agent_config_org grants SELECT to any active member, and RLS is row-level,
-- so a counsellor who can read the greeting can read the tokens.
--
-- That note dismissed column GRANTs on the grounds that Supabase authenticates
-- every end user as the single `authenticated` role, so privileges cannot tell
-- a counsellor from an admin. True — and irrelevant, because **no browser user
-- of either kind needs these columns**. Admins configure credentials through
-- the save-integration edge function, which uses the service role. So the
-- distinction the note was trying to draw never had to be drawn.
--
-- Verified before writing this, rather than assumed:
--   * app/src — the only three agent_config touches are SetupChecklist
--     (enabled, knowledge, notify_new_leads), Settings' explicit 23-column
--     select, and a comment. No secret column is named anywhere in the
--     frontend, and lib/types.ts deliberately omits them from the interface.
--   * supabase/functions — every reader (chat-agent, system-health,
--     _shared/notify, _shared/whatsapp, save-integration) runs on
--     SUPABASE_SERVICE_ROLE_KEY, which bypasses both RLS and column
--     privileges.
--
-- One sharp edge worth stating plainly: Settings saves with
-- upsert({...cfg}) → INSERT ... ON CONFLICT DO UPDATE. Postgres checks INSERT
-- privileges per *named* column, and cfg is built from the explicit select
-- above, so no secret column is ever named. Revoking INSERT/UPDATE on them as
-- well therefore costs nothing today and means a future careless `select("*")`
-- fails loudly at the point of the mistake instead of quietly shipping tokens
-- to a browser.

begin;

-- ── 1. Column privileges ────────────────────────────────────────────────────
-- The obvious version of this,
--
--     revoke select (whatsapp_token, …) on public.agent_config from authenticated;
--
-- DOES NOTHING HERE, and does nothing quietly. Postgres treats a table-level
-- privilege as covering every column, including ones added later, and a
-- column-level REVOKE cannot carve a hole in it — it emits
-- "no privileges could be revoked for column" as a *warning* and returns
-- success. Supabase grants ALL on every table in `public` to `authenticated`
-- and `anon` by default, so that is exactly the situation, and the migration
-- would have reported success while changing nothing.
--
-- The working shape is: drop the table-level privilege, then grant back
-- column-level on everything except the credentials. Generated rather than
-- typed out, because a hand-written column list silently stops protecting the
-- table the day someone runs ALTER TABLE ADD COLUMN — the new column would
-- simply not be in the GRANT, and would be unreadable, which is a confusing
-- outage rather than a leak, but still avoidable.
do $$
declare
  v_secret text[] := array['groq_api_key','resend_api_key','whatsapp_token',
                           'telegram_bot_token','app_secret'];
  v_cols   text;
  v_role   text;
  v_missing text[];
begin
  -- Fail loudly if a column name here has drifted from the table. Silently
  -- "protecting" a column that does not exist is how this migration would
  -- appear to pass while a renamed credential column stayed wide open.
  select array_agg(x) into v_missing
    from unnest(v_secret) as x
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_config' and column_name = x);
  if v_missing is not null then
    raise exception 'agent_config has no column(s) %; update v_secret before running', v_missing;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'agent_config'
     and not (column_name = any (v_secret));

  foreach v_role in array array['authenticated','anon'] loop
    execute format('revoke select, insert, update on public.agent_config from %I', v_role);
    execute format('grant select (%s) on public.agent_config to %I', v_cols, v_role);
    execute format('grant insert (%s) on public.agent_config to %I', v_cols, v_role);
    execute format('grant update (%s) on public.agent_config to %I', v_cols, v_role);
  end loop;
end $$;

-- Two consequences worth being explicit about:
--
-- * A future ALTER TABLE ADD COLUMN is NOT covered by these grants, so the
--   new column will be invisible to the browser until this block is re-run.
--   That is the safe direction to fail in, but it will look like a bug, so it
--   is written down here and in the verify block below.
-- * A later `grant select on public.agent_config to authenticated` — what a
--   broad "fix permissions" script does — restores the table-level privilege
--   and silently hands the credentials back. There is no DDL that pins this
--   shut; step 3 is how you check.

-- ── 2. What IS configured? Booleans, for anyone in the org ──────────────────
-- The setup checklist has to answer "are alerts working?" and until now it
-- answered by reading a toggle. A toggle with no bot token behind it is a
-- checklist that certifies a broken configuration as done — worse than an
-- unticked box, because the customer stops looking.
--
-- security definer so it can see the columns the caller now cannot; it returns
-- only whether each value is non-empty, never the value.
create or replace function public.integration_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c record;
  v_org uuid := public.my_org();
begin
  if v_org is null or not public.is_active_member() then
    return jsonb_build_object('error', 'not a member');
  end if;

  select * into c from public.agent_config where org_id = v_org;

  return jsonb_build_object(
    'whatsapp', jsonb_build_object(
      'configured', coalesce(nullif(btrim(c.whatsapp_token), ''), null) is not null
                and coalesce(nullif(btrim(c.whatsapp_phone_id), ''), null) is not null,
      'autoreply',  coalesce(c.whatsapp_autoreply, false)),
    'telegram', jsonb_build_object(
      -- The platform bot token is a legitimate fallback for the token, but
      -- never for the chat id: the chat id names THIS customer's channel, so
      -- alerts cannot work without one no matter what the platform holds.
      'configured', coalesce(nullif(btrim(c.telegram_bot_token), ''), null) is not null
                and coalesce(nullif(btrim(c.telegram_chat_id), ''), null) is not null,
      'alerts_on',  coalesce(c.notify_new_leads, false)),
    'ai', jsonb_build_object(
      'own_key', coalesce(nullif(btrim(c.groq_api_key), ''), null) is not null),
    'email', jsonb_build_object(
      'own_key', coalesce(nullif(btrim(c.resend_api_key), ''), null) is not null)
  );
end;
$$;

comment on function public.integration_status() is
  'Booleans only: which integrations have credentials behind them, for the caller''s org. Exists so the browser can show setup state without ever reading a credential.';

-- SECURITY DEFINER functions are granted EXECUTE to PUBLIC by default, which
-- would include anon. Narrow it before granting.
revoke all on function public.integration_status() from public, anon;
grant execute on function public.integration_status() to authenticated;

commit;

-- ── 3. Verify — run this after applying ─────────────────────────────────────
-- (a) Expect ZERO rows. Any row is a credential the browser can still reach.
--     information_schema.column_privileges only reports column-level grants,
--     so check has_column_privilege too — it accounts for the table-level
--     grant that would otherwise hide the problem from the first query.
--
--   select c.column_name,
--          has_column_privilege('authenticated','public.agent_config',c.column_name,'SELECT') as auth_select,
--          has_column_privilege('anon','public.agent_config',c.column_name,'SELECT')          as anon_select
--     from information_schema.columns c
--    where c.table_schema='public' and c.table_name='agent_config'
--      and c.column_name in ('groq_api_key','resend_api_key','whatsapp_token',
--                            'telegram_bot_token','app_secret')
--      and (has_column_privilege('authenticated','public.agent_config',c.column_name,'SELECT')
--        or has_column_privilege('anon','public.agent_config',c.column_name,'SELECT'));
--
-- (b) Expect EVERY other column to be true — a false here means the Settings
--     screen has gone read-blind on that field.
--
--   select c.column_name,
--          has_column_privilege('authenticated','public.agent_config',c.column_name,'SELECT') as readable
--     from information_schema.columns c
--    where c.table_schema='public' and c.table_name='agent_config'
--      and c.column_name not in ('groq_api_key','resend_api_key','whatsapp_token',
--                                'telegram_bot_token','app_secret')
--    order by 2, 1;
--
-- (c) And the honest-status path:
--
--   select public.integration_status();
