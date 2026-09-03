-- Is the AI chatbot healthy for every organisation?
--
-- Read-only. Safe to run any time.
--
-- Why now: 20260821080000 changed consume_usage and revoked EXECUTE from anon
-- and authenticated. chat-agent has NOT been redeployed yet, so it still calls
-- the 4-argument signature. That signature still exists, and chat-agent talks
-- to Postgres with the service role, which kept its grant — so the widget
-- should be unaffected. This proves it rather than assuming it.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Per-organisation health
-- ════════════════════════════════════════════════════════════════════════════
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

  -- Live traffic. The widget writes a `conversations` row per visitor.
  (select count(*) from public.conversations c where c.org_id = o.id)
                                                as chats_total,
  (select count(*) from public.conversations c
    where c.org_id = o.id and c.last_message_at > now() - interval '7 days')
                                                as chats_7d,
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


-- ════════════════════════════════════════════════════════════════════════════
-- 2. Which websites are actually reaching us?
-- ════════════════════════════════════════════════════════════════════════════
-- page_url is recorded per conversation, so this shows every domain the widget
-- has been embedded on and whether it is still live. A site you expect to see
-- and do not is one where the embed is missing or broken.

select
  o.name as org,
  coalesce(
    nullif(split_part(split_part(c.page_url, '://', 2), '/', 1), ''),
    '(no page_url recorded)'
  )                                as domain,
  count(*)                         as chats,
  max(c.last_message_at)           as last_chat,
  case
    when max(c.last_message_at) > now() - interval '7 days'  then 'active'
    when max(c.last_message_at) > now() - interval '30 days' then 'quiet (7-30d)'
    else 'DORMANT (30d+)'
  end                              as status
from public.conversations c
join public.organizations o on o.id = c.org_id
group by 1, 2
order by max(c.last_message_at) desc nulls last;


-- ════════════════════════════════════════════════════════════════════════════
-- How to read this
-- ════════════════════════════════════════════════════════════════════════════
--   agent_on = false     -> switched off in Settings for that org
--   groq_key = MISSING   -> no LLM key; the widget loads but cannot answer
--   onboarded = no       -> Settings > AI Agent was never completed
--   active_keys = 0      -> nothing on the website can reach us at all
--   chats_total = 0      -> backend fine; the embed is not on the site, or
--                           nobody has used it yet
--
-- ai_limit should read "unlimited" for all four orgs now they are on
-- enterprise. Any number there means that org is not on enterprise.
--
-- Query 2 returning no rows for a site means that site has NEVER reached the
-- chat backend — check the embed snippet is present in its HTML.
