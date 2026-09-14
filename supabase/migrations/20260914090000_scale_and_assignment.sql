-- AbroBot CRM — make the hot paths correct and fast at real volume.
--
-- Three problems, all invisible at ten records and all certain at ten thousand.
--
-- ════════════════════════════════════════════════════════════════════════════
-- PROBLEM 1 — round-robin silently stops being round-robin
-- ════════════════════════════════════════════════════════════════════════════
-- Two places compute "who has the fewest open leads" by fetching every assigned
-- lead in the org and counting them in JavaScript:
--
--   _shared/run-actions.ts:54   .select("assigned_to").eq("org_id", orgId)
--                                 .not("assigned_to", "is", null)
--   lead-webhook/index.ts:225   .select("assigned_to").eq("org_id", wk.org_id)
--                                 .not("stage","in","(enrolled,lost)")
--
-- Neither has a `.limit()`, so both are silently capped by PostgREST's max-rows
-- (1,000 on this project). Past a thousand assigned leads the counts are
-- computed from an arbitrary slice, and assignment quietly skews to whoever
-- happens to look idle in that slice. Business sells 50,000 records.
--
-- It is also a performance problem in its own right: every single inbound lead
-- drags up to a thousand rows across the wire to count them.
--
-- The fix is to count in the database, where counting belongs.
--
-- ════════════════════════════════════════════════════════════════════════════
-- PROBLEM 2 — a lead can be assigned to someone in another organisation
-- ════════════════════════════════════════════════════════════════════════════
-- leads.assigned_to is a bare `uuid` with no foreign key and no org check. The
-- automation action `assign_to` writes `String(step.value)` straight into it
-- (run-actions.ts:70), and step.value is whatever the tenant typed into their
-- own rule. So an org admin can assign their lead to a profile id belonging to
-- a different customer, or to a UUID that is nobody at all.
--
-- RLS still stops the other org from READING the lead, so this is not a data
-- leak. It is data corruption: an assignee who cannot see their own queue, a
-- round-robin denominator that counts a stranger, and any screen that resolves
-- assigned_to to a name showing a person from another company.
--
-- ════════════════════════════════════════════════════════════════════════════
-- PROBLEM 3 — the most common queries have no index
-- ════════════════════════════════════════════════════════════════════════════
-- Before this migration the only index on `leads` was (org_id, stage_key), plus
-- (org_id, segment) from 20260908120000. Everything else — the leads list, the
-- dedupe on every intake, the follow-up calendar, the lead timeline, the chat
-- history read on every single agent turn — was a sequential scan.
--
-- Small tables hide this completely. It arrives all at once.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Indexes for the queries the code actually runs
-- ════════════════════════════════════════════════════════════════════════════
-- Plain CREATE INDEX, not CONCURRENTLY: concurrently cannot run inside a
-- transaction, and at today's row counts these build in milliseconds. If this
-- is ever re-run against a large table, split it out and use CONCURRENTLY.

-- The Leads list and its pagination. `.order("created_at", desc)` with
-- `.range()` — the single most-executed query in the product.
create index if not exists leads_org_created_idx
  on public.leads (org_id, created_at desc);

-- Round-robin, and the "assigned to me" filter.
create index if not exists leads_org_assigned_idx
  on public.leads (org_id, assigned_to)
  where assigned_to is not null;

-- The follow-up calendar and the "who to call next" queue.
create index if not exists leads_org_followup_idx
  on public.leads (org_id, next_follow_up_at)
  where next_follow_up_at is not null;

-- Dedupe. lead-webhook, chat-agent and the public API all look a person up by
-- email or phone before creating them — on every inbound enquiry, which is the
-- one path that must never be slow.
create index if not exists leads_org_email_idx
  on public.leads (org_id, lower(email))
  where email is not null;

create index if not exists leads_org_phone_idx
  on public.leads (org_id, phone)
  where phone is not null;

-- The nurture engine's per-sequence sweep: not opted out, has an email,
-- below its step ceiling.
create index if not exists leads_org_nurture_idx
  on public.leads (org_id, nurture_step)
  where nurture_opted_out = false and email is not null;

-- A record's timeline, newest first.
create index if not exists activities_lead_created_idx
  on public.activities (lead_id, created_at desc);

-- Read on EVERY agent turn: the last 20 messages of a conversation.
create index if not exists chat_messages_conv_created_idx
  on public.chat_messages (conversation_id, created_at);

-- The Conversations list.
create index if not exists conversations_org_last_idx
  on public.conversations (org_id, last_message_at desc);

-- The automation cooldown check — one query per enabled automation per lead,
-- so on a Business plan with 100 rules this runs 100 times per new lead.
--
-- NOT created here. 20260819090000_automations_and_plan_limits.sql:104 already
-- built automation_runs_lookup_idx on exactly these columns in exactly this
-- order. A second index under a different name would have been built anyway,
-- because `if not exists` matches on the index NAME, not its definition — so
-- the guard reads as safe and isn't. That is double the write amplification on
-- the most append-heavy table in the system, for no read benefit.
--
-- 20260914100000 drops automation_runs_cooldown_idx if an earlier run of this
-- migration already created it.

-- Keyset pagination in run-automations walks `where org_id = ? and id > ?
-- order by id`. Without this the planner falls back to the primary key on id
-- alone and scans forward through every other tenant's rows, so the cost of a
-- page grows with the size of the whole table rather than the org.
-- Partial, because the sweep pages with `.is("deleted_at", null)`.
create index if not exists leads_org_id_idx
  on public.leads (org_id, id)
  where deleted_at is null;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Count assignment load in the database
-- ════════════════════════════════════════════════════════════════════════════
-- Returns one row per ACTIVE member with their current open-lead count,
-- lightest first — so the caller takes the first row and is done. Members with
-- zero leads are included, which is the case the JavaScript version got right
-- only because it seeded the map from the team list first.
--
-- "Open" means not in a won or lost stage, read from the org's own
-- pipeline_stages rather than the hardcoded ('enrolled','lost') list that
-- lead-webhook still uses — those two keys only exist in the study-abroad pack,
-- so for every other industry the old filter excluded nothing and counted
-- closed leads as open.

create or replace function public.org_assignment_load(p_org_id uuid)
returns table (user_id uuid, open_leads bigint)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         count(l.id) filter (
           where l.id is not null
             and coalesce(ps.is_won, false) = false
             and coalesce(ps.is_lost, false) = false
         ) as open_leads
    from public.profiles p
    left join public.leads l
      on l.org_id = p.org_id and l.assigned_to = p.id
    left join public.pipeline_stages ps
      on ps.org_id = l.org_id and ps.key = l.stage_key
   where p.org_id = p_org_id
     and p.status = 'active'
   group by p.id
   order by open_leads asc, p.id asc;
$$;

-- Same posture as every other SECURITY DEFINER function that takes an org id:
-- not reachable from the browser. The edge functions call it with the service
-- role, which is not subject to these grants.
revoke all on function public.org_assignment_load(uuid) from public, anon, authenticated;

comment on function public.org_assignment_load is
  'Active members of an org with their open-lead counts, lightest first. Replaces fetching every assigned lead and counting in JavaScript, which was silently truncated by PostgREST max-rows past 1,000 leads and skewed assignment from that point on.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. An assignee must belong to the same organisation
-- ════════════════════════════════════════════════════════════════════════════
-- A foreign key alone would not be enough — profiles(id) is unique platform
-- wide, so an FK would happily accept another customer's user. The org has to
-- be part of the check, which means a trigger.

create or replace function public.guard_lead_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  if new.assigned_to is null then
    return new;
  end if;

  -- Unchanged on UPDATE: skip, so this never blocks an ordinary edit and never
  -- costs a lookup on the hot path.
  if tg_op = 'UPDATE' and old.assigned_to is not distinct from new.assigned_to then
    return new;
  end if;

  select exists (
    select 1 from public.profiles
     where id = new.assigned_to
       and org_id = new.org_id
       and status = 'active'
  ) into v_ok;

  if not v_ok then
    raise exception
      'Cannot assign this record to that user: they are not an active member of this organisation.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_lead_assignee on public.leads;
create trigger trg_guard_lead_assignee
  before insert or update of assigned_to on public.leads
  for each row execute function public.guard_lead_assignee();

comment on function public.guard_lead_assignee is
  'Refuses an assigned_to that is not an active member of the record''s own organisation. leads.assigned_to has no foreign key, and a plain FK would not help: profiles.id is unique across the platform, so it would accept another customer''s user. The automation action assign_to writes a tenant-supplied UUID straight through, which is how this gets reached.';

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'the hot-path indexes exist' as check,
       case when (select count(*) from pg_indexes
                   where schemaname = 'public'
                     and indexname in ('leads_org_created_idx','leads_org_assigned_idx',
                                       'leads_org_followup_idx','leads_org_email_idx',
                                       'leads_org_phone_idx','leads_org_nurture_idx',
                                       'leads_org_id_idx',
                                       'activities_lead_created_idx',
                                       'chat_messages_conv_created_idx',
                                       'conversations_org_last_idx')) = 10
            then 'PASS — all 10' else 'CHECK — some did not create' end as result
union all
select 'assignment load is counted in the database',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'org_assignment_load')
            then 'PASS' else 'FAIL' end
union all
select 'the assignee guard is attached to leads',
       case when exists (select 1 from pg_trigger
                          where tgname = 'trg_guard_lead_assignee' and not tgisinternal)
            then 'PASS' else 'FAIL' end
union all
-- Anything already mis-assigned. The trigger only guards from now on, so an
-- existing bad row stays until someone looks at it. Expected: none.
select 'existing records assigned outside their own org',
       coalesce((select count(*)::text || ' record(s) — investigate'
                   from public.leads l
                  where l.assigned_to is not null
                    and not exists (select 1 from public.profiles p
                                     where p.id = l.assigned_to and p.org_id = l.org_id)
                 having count(*) > 0),
                'none')
union all
select 'the leads table is no longer sequential-scan only',
       (select count(*)::text || ' indexes on public.leads'
          from pg_indexes where schemaname = 'public' and tablename = 'leads');

-- What the new load query returns for each org. Lightest-loaded member first;
-- that first row is what round-robin will now pick.
select o.slug, p.full_name, l.open_leads
  from public.organizations o
  cross join lateral public.org_assignment_load(o.id) l
  join public.profiles p on p.id = l.user_id
 order by o.slug, l.open_leads;
