-- Per-organisation chatbot health. Read-only.
--
-- Split into its own file because the Supabase SQL editor displays only the
-- LAST result set — putting this alongside the domain query meant this one was
-- never visible. My mistake; one query per file from here on.

select
  o.name                                        as org,
  public.effective_plan(o.id)                   as plan,

  coalesce(ac.enabled, false)                   as agent_on,
  case when coalesce(ac.groq_api_key, '') <> '' then 'set' else 'MISSING' end
                                                as groq_key,
  coalesce(nullif(ac.model, ''), 'default')     as model,
  case when coalesce(ac.onboarded, false) then 'yes' else 'no' end
                                                as onboarded,

  -- null max_ai_messages = unlimited (enterprise)
  coalesce((select max_ai_messages::text from public.plan_of(o.id)), 'unlimited')
                                                as ai_limit,
  coalesce((select uc.value from public.usage_counters uc
             where uc.org_id = o.id
               and uc.period = to_char(now(), 'YYYY-MM')
               and uc.metric  = 'ai_messages'), 0)
                                                as ai_used_this_month,

  (select count(*) from public.conversations c where c.org_id = o.id)
                                                as chats_total,
  (select max(c.last_message_at) from public.conversations c where c.org_id = o.id)
                                                as last_chat,
  (select count(*) from public.leads l
    where l.org_id = o.id and l.source = 'website')
                                                as leads_from_widget,
  (select count(*) from public.webhook_keys wk
    where wk.org_id = o.id and wk.active)       as active_keys

from public.organizations o
left join public.agent_config ac on ac.org_id = o.id
order by o.name;

-- Reading it:
--   agent_on = false     -> switched off in Settings for that org
--   groq_key = MISSING   -> widget loads but cannot answer anything
--   onboarded = no       -> Settings > AI Agent never completed
--   active_keys = 0      -> nothing on the website can reach us at all
--   chats_total = 0      -> backend fine; embed absent, or nobody has used it
--
-- ai_limit must read "unlimited" for all four orgs now they are on enterprise.
