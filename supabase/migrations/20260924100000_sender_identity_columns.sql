-- AbroBot CRM — make the tenant sender columns exist in the repo, not just live.
--
-- ════════════════════════════════════════════════════════════════════════════
-- Why
-- ════════════════════════════════════════════════════════════════════════════
-- `agent_config.resend_from` and `agent_config.resend_reply_to` appear in the
-- live schema dump (RECOVERED-SCHEMA.md) and in NO migration in this repo.
-- Like `my_org()` and `super_all_leads` before them, they are dashboard-era
-- objects the migration history does not describe.
--
-- That was harmless while nothing read them. It stopped being harmless the
-- moment nurture, send-campaign and save-integration started selecting them:
-- on any database built from these migrations — a fresh environment, a staging
-- copy, `supabase db reset` — the SELECT fails and BOTH send paths break
-- completely. A column that exists only in production is a column that turns
-- every other environment into a different product.
--
-- `add column if not exists` is a no-op against production, where they already
-- exist, and the repair everywhere else.
--
-- ════════════════════════════════════════════════════════════════════════════
-- What these columns are for
-- ════════════════════════════════════════════════════════════════════════════
-- A tenant may store their own Resend API key (Integrations → Email). Their
-- Resend account has not verified the platform's sending domain, so pairing
-- their key with the platform's From address is expected to be rejected —
-- which is what these columns exist to avoid, and why nothing worked while
-- they were unread.
--
-- Deliberately NOT enforced with a CHECK. The sender code treats a missing
-- address as "use the platform sender", exactly as before, and reports the
-- suspect combination rather than refusing to send. Refusing would have
-- stopped follow-up for every tenant holding their own key the moment it
-- shipped, because these columns are NULL for all of them today.

begin;

alter table public.agent_config
  add column if not exists resend_from text;

alter table public.agent_config
  add column if not exists resend_reply_to text;

comment on column public.agent_config.resend_from is
  'The verified sending address for THIS tenant''s own Resend account. Used only when resend_api_key is also set; otherwise the platform address is used. Read by nurture, send-campaign and save-integration''s test_email — all three must agree, or the connection test passes while real sends fail.';

comment on column public.agent_config.resend_reply_to is
  'Where replies to this tenant''s email should go. Takes precedence over the inferred longest-standing admin inbox.';

-- These columns are not secrets — the From address is on every message the
-- tenant sends — but agent_config's column grants are deliberately narrow
-- (20260905120000 revoked the table and re-granted the non-secret columns), so
-- the browser must not gain a blanket read of the row. Writes go through
-- save-integration under the service role; the browser reads them back through
-- that function's `status` action, which returns them explicitly.
--
-- Nothing is granted here on purpose. Recorded so the omission reads as a
-- decision rather than an oversight.

commit;

-- ════════════════════════════════════════════════════════════════════════════
-- Verify
-- ════════════════════════════════════════════════════════════════════════════
select * from (
  select 1 as ord, 'both columns exist' as check,
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'agent_config'
                       and column_name in ('resend_from', 'resend_reply_to')) = 2
              then 'PASS' else 'FAIL' end as detail

  union all
  -- Expected to be zero today. If it is not, someone configured this by hand
  -- and the sender code will now honour it.
  select 2, 'tenants with their own sending address',
         (select count(*)::text from public.agent_config
           where coalesce(btrim(resend_from), '') <> '')

  union all
  -- THIS is the row that matters. Every org here is sending on its own Resend
  -- key from the platform's address — the combination suspected of being
  -- rejected outright. Nothing is refused; the run reports now name it.
  select 3, 'tenants whose key and sending address disagree',
         coalesce((select string_agg(o.slug, ', ')
                     from public.agent_config c
                     join public.organizations o on o.id = c.org_id
                    where coalesce(btrim(c.resend_api_key), '') <> ''
                      and coalesce(btrim(c.resend_from), '') = ''),
                  'none — every tenant is on the shared sender')
) t order by ord;
