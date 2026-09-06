-- One query, one result set: Supabase's editor only shows the last one.
-- Every row should read PASS. Anything else names what is missing.
with cred as (
  select count(*) n from information_schema.columns c
   where c.table_schema='public' and c.table_name='agent_config'
     and c.column_name in ('groq_api_key','resend_api_key','whatsapp_token','telegram_bot_token','app_secret')
     and (has_column_privilege('authenticated','public.agent_config',c.column_name,'SELECT')
       or has_column_privilege('anon','public.agent_config',c.column_name,'SELECT'))
), readable as (
  select count(*) n from information_schema.columns c
   where c.table_schema='public' and c.table_name='agent_config'
     and c.column_name not in ('groq_api_key','resend_api_key','whatsapp_token','telegram_bot_token','app_secret')
     and not has_column_privilege('authenticated','public.agent_config',c.column_name,'SELECT')
)
select * from (
  select 1 ord, '1. cron secret table (app_settings)' chk,
         case when to_regclass('public.app_settings') is not null then 'PASS' else 'MISSING — migration 1 not applied' end res
  union all select 2, '2. job heartbeats',
         case when to_regclass('public.job_heartbeats') is not null then 'PASS' else 'MISSING — migration 1' end
  union all select 3, '3. soft delete (leads.deleted_at)',
         case when exists (select 1 from information_schema.columns where table_name='leads' and column_name='deleted_at')
              then 'PASS' else 'MISSING — migration 2' end
  union all select 4, '4. api_keys table',
         case when to_regclass('public.api_keys') is not null then 'PASS' else 'MISSING — migration 3' end
  union all select 5, '5. webhook_endpoints table',
         case when to_regclass('public.webhook_endpoints') is not null then 'PASS' else 'MISSING — migration 3' end
  union all select 6, '6. lead-change trigger fires webhooks + automations',
         case when exists (select 1 from pg_trigger where tgname like '%notify_lead_change%' and not tgisinternal)
              then 'PASS' else 'MISSING — migration 3' end
  union all select 7, '7. credentials UNREADABLE by browser',
         case when (select n from cred) = 0 then 'PASS'
              else 'FAIL — ' || (select n from cred)::text || ' credential column(s) still readable' end
  union all select 8, '8. every other agent_config column still readable',
         case when (select n from readable) = 0 then 'PASS'
              else 'FAIL — ' || (select n from readable)::text || ' column(s) went read-blind; Settings will break' end
  union all select 9, '9. integration_status() exists',
         case when to_regprocedure('public.integration_status()') is not null then 'PASS' else 'MISSING — migration 4' end
  union all select 10, '10. message_templates.nurture_step',
         case when exists (select 1 from information_schema.columns where table_name='message_templates' and column_name='nurture_step')
              then 'PASS' else 'MISSING — migration 5' end
  union all select 11, '11. nurture is opt-IN (no NULLs, default false)',
         case when (select count(*) from public.agent_config where nurture_enabled is null) = 0
               and coalesce((select column_default from information_schema.columns
                              where table_name='agent_config' and column_name='nurture_enabled'),'') like '%false%'
              then 'PASS' else 'FAIL — some orgs would be emailed without opting in' end
  union all select 12, '12. abrobot follow-up sequence seeded',
         coalesce((select case when count(*) = 3 then 'PASS — 3 steps'
                               else 'only ' || count(*)::text || ' step(s)' end
                     from public.message_templates t
                     join public.organizations o on o.id = t.org_id
                    where o.slug='abrobot' and t.nurture_step is not null), 'no abrobot org')
  union all select 13, '13. plan_limits.max_emails set',
         case when (select count(*) from public.plan_limits where max_emails is not null) >= 5
              then 'PASS' else 'FAIL — allowances not populated' end
  union all select 14, '14. email_allowance() exists',
         case when to_regprocedure('public.email_allowance(uuid)') is not null then 'PASS' else 'MISSING — migration 6' end
  union all select 15, '15. consume_usage knows ''emails''',
         case when (select pg_get_functiondef(oid) from pg_proc
                     where oid = to_regprocedure('public.consume_usage(uuid,text,integer)')) like '%max_emails%'
              then 'PASS' else 'FAIL — still only meters AI replies' end
  union all select 16, '16. email_allowance not callable by strangers',
         case when has_function_privilege('anon','public.email_allowance(uuid)','EXECUTE')
              then 'FAIL — anon can read any org''s usage' else 'PASS' end
) x order by ord;
