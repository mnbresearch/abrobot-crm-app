-- AbroBot CRM — soft delete, so a mistake is survivable without paying for PITR.
-- NOT APPLIED.
--
-- The problem this solves: Supabase's free tier has no point-in-time recovery,
-- so a DELETE is permanent. The nightly pg_dump (.github/workflows/backup.yml)
-- narrows that to "up to 24 hours of loss", which is a real improvement but
-- still means restoring a whole database to recover one record.
--
-- Soft delete closes the rest of the gap for free: a delete becomes an UPDATE
-- that sets deleted_at, the row stops appearing anywhere, and it is restorable
-- with one statement for 30 days. Combined with the previous migration
-- restricting DELETE to admins, "someone destroyed our data" stops being a
-- category of incident and becomes an undo.
--
-- Idempotent.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The column
-- ════════════════════════════════════════════════════════════════════════════

alter table public.leads         add column if not exists deleted_at timestamptz;
alter table public.activities    add column if not exists deleted_at timestamptz;
alter table public.conversations add column if not exists deleted_at timestamptz;

-- Partial indexes: the app only ever queries live rows, so index only those.
-- Cheaper to maintain and smaller than a full index.
create index if not exists leads_live_idx
  on public.leads (org_id, created_at desc) where deleted_at is null;
create index if not exists activities_live_idx
  on public.activities (lead_id, created_at desc) where deleted_at is null;
create index if not exists conversations_live_idx
  on public.conversations (org_id, last_message_at desc) where deleted_at is null;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Hide deleted rows from every reader
-- ════════════════════════════════════════════════════════════════════════════
-- Enforced in RLS rather than in application queries. Every screen, every edge
-- function and every direct PostgREST call gets the same answer, and nobody
-- has to remember to add `.is("deleted_at", null)` to a new query.

drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads
  for select using (
    deleted_at is null
    and (public.is_super_admin() or (org_id = public.my_org() and public.is_active_member()))
  );

do $$
declare t text;
begin
  foreach t in array array['activities', 'conversations'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format($f$
      create policy %1$I on public.%2$I for select using (
        deleted_at is null
        and (public.is_super_admin()
             or (org_id = public.my_org() and public.is_active_member()))
      )$f$, t || '_read', t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Archive and restore
-- ════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER so they can write deleted_at on rows the caller can no
-- longer SELECT once archived — a plain UPDATE cannot restore a row it is not
-- allowed to see.

create or replace function public.archive_lead(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid;
begin
  select org_id into v_org from public.leads where id = p_lead_id;
  if v_org is null then
    return jsonb_build_object('ok', false, 'reason', 'not found');
  end if;
  if not (public.is_super_admin()
          or (v_org = public.my_org() and public.is_active_member())) then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  update public.leads set deleted_at = now() where id = p_lead_id and deleted_at is null;
  -- The record's history goes with it, so an archived lead does not leave
  -- orphaned activities visible in the org feed.
  update public.activities set deleted_at = now() where lead_id = p_lead_id and deleted_at is null;

  return jsonb_build_object('ok', true, 'restorable_until', (now() + interval '30 days')::date);
end;
$$;

create or replace function public.restore_lead(p_lead_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_deleted timestamptz;
begin
  select org_id, deleted_at into v_org, v_deleted from public.leads where id = p_lead_id;
  if v_org is null then
    return jsonb_build_object('ok', false, 'reason', 'not found');
  end if;
  -- Restoring is an admin action: it brings back data someone chose to remove.
  if not (public.is_super_admin() or (v_org = public.my_org() and public.is_org_admin())) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if v_deleted is null then
    return jsonb_build_object('ok', true, 'already_live', true);
  end if;

  update public.leads set deleted_at = null where id = p_lead_id;
  -- Only history archived in the same sweep, so a note deleted last month is
  -- not silently resurrected too.
  update public.activities set deleted_at = null
   where lead_id = p_lead_id and deleted_at between v_deleted - interval '5 seconds'
                                               and v_deleted + interval '5 seconds';

  return jsonb_build_object('ok', true, 'restored', true);
end;
$$;

grant execute on function public.archive_lead(uuid) to authenticated;
grant execute on function public.restore_lead(uuid) to authenticated;
revoke all on function public.archive_lead(uuid) from public, anon;
revoke all on function public.restore_lead(uuid) from public, anon;

-- What an admin needs to actually find something to restore.
create or replace function public.archived_leads()
returns table (id uuid, name text, email text, phone text, deleted_at timestamptz, days_left integer)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.name, l.email, l.phone, l.deleted_at,
         greatest(0, 30 - extract(day from now() - l.deleted_at)::int)
    from public.leads l
   where l.deleted_at is not null
     and (public.is_super_admin() or (l.org_id = public.my_org() and public.is_org_admin()))
   order by l.deleted_at desc
   limit 500;
$$;

grant execute on function public.archived_leads() to authenticated;
revoke all on function public.archived_leads() from public, anon;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Purge, and keep the biggest table from filling a 500 MB database
-- ════════════════════════════════════════════════════════════════════════════
-- Thirty days is the promise: long enough to notice a mistake, short enough
-- that a deletion request is honoured in a reasonable window.

create or replace function public.purge_archived()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare n_leads int; n_acts int; n_convs int; n_runs int;
begin
  delete from public.activities    where deleted_at < now() - interval '30 days';
  get diagnostics n_acts = row_count;
  delete from public.conversations where deleted_at < now() - interval '30 days';
  get diagnostics n_convs = row_count;
  delete from public.leads         where deleted_at < now() - interval '30 days';
  get diagnostics n_leads = row_count;

  -- automation_runs is the fastest-growing table in the schema — one row per
  -- rule per lead per fire, forever, with nothing deleting it. On the free
  -- tier's 500 MB that is a real ceiling, and 90 days is more audit history
  -- than anyone reads.
  delete from public.automation_runs where created_at < now() - interval '90 days';
  get diagnostics n_runs = row_count;

  return jsonb_build_object('leads', n_leads, 'activities', n_acts,
                            'conversations', n_convs, 'automation_runs', n_runs);
end;
$$;

revoke all on function public.purge_archived() from public, anon, authenticated;

select cron.unschedule('purge-archived')
 where exists (select 1 from cron.job where jobname = 'purge-archived');

select cron.schedule('purge-archived', '15 3 * * *', $$ select public.purge_archived(); $$);

commit;


-- ── Using it ────────────────────────────────────────────────────────────────
--   select public.archive_lead('<lead uuid>');
--   select * from public.archived_leads();
--   select public.restore_lead('<lead uuid>');
--
-- Note the ordinary DELETE path still exists and is still permanent — the
-- previous migration limited it to admins. Soft delete is what the UI should
-- call; a hard DELETE should be reserved for a genuine erasure request.
