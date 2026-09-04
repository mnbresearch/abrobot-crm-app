-- AbroBot CRM — stop ordinary members deleting customer data.
-- NOT APPLIED. Read the notes, then run.
--
-- The live policy on leads is:
--
--   leads_org  FOR ALL  USING (is_super_admin()
--                              OR (org_id = my_org() AND is_active_member()))
--
-- FOR ALL includes DELETE. The app has no delete button, so this was invisible
-- — but RLS is the actual boundary, not the UI. Any active member can send
--
--   DELETE /rest/v1/leads?org_id=eq.<their own org>
--
-- with the publishable key (which ships in the browser bundle) and their own
-- session, and erase the organisation's entire lead database. A junior
-- counsellor on their last day can do it from the browser console.
--
-- There are no backups on the free tier, no soft delete, and no undo. So the
-- realistic recovery from that request is: none.
--
-- This migration splits the blanket ALL policy into the four verbs, so reading
-- and working with records stays exactly as it is, and only deletion becomes
-- privileged.

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. leads — the one that matters
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists leads_org on public.leads;

create policy leads_read on public.leads
  for select using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

create policy leads_insert on public.leads
  for insert with check (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

create policy leads_update on public.leads
  for update using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  ) with check (
    -- WITH CHECK spelled out rather than left to default to USING: without it,
    -- nothing stops a member setting org_id to another organisation on update
    -- and moving a record out of their own tenant.
    public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
  );

-- Deletion is an admin action. Note this is still not a good way to remove
-- records — it is permanent and there is nothing to restore from. The right
-- long-term answer is a `deleted_at` column and an Archive action; this
-- migration just stops the blast radius being "any employee".
create policy leads_delete on public.leads
  for delete using (
    public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The record's history — same reasoning
-- ════════════════════════════════════════════════════════════════════════════
-- activities and conversations/chat_messages are the audit trail and the
-- transcript. If a member can delete a lead's history but not the lead, the
-- history is worthless for exactly the disputes it exists to settle.
--
-- Guarded with a DO block: these tables' policies are not in any migration, so
-- their names are only knowable at runtime. If a table or policy is absent
-- this skips it rather than failing the whole migration.

do $$
declare
  t text;
  p text;
begin
  foreach t in array array['activities', 'conversations', 'chat_messages'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'table %.% not present — skipped', 'public', t;
      continue;
    end if;

    -- Replace any FOR ALL policy with verb-specific ones.
    for p in
      select polname from pg_policy
       where polrelid = ('public.' || t)::regclass and polcmd = '*'
    loop
      execute format('drop policy if exists %I on public.%I', p, t);
      raise notice 'replaced FOR ALL policy %.% -> verb-specific', t, p;
    end loop;

    execute format($f$
      create policy %1$I on public.%2$I for select using (
        public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
      )$f$, t || '_read', t);

    execute format($f$
      create policy %1$I on public.%2$I for insert with check (
        public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
      )$f$, t || '_insert', t);

    execute format($f$
      create policy %1$I on public.%2$I for update using (
        public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
      ) with check (
        public.is_super_admin() or (org_id = public.my_org() and public.is_active_member())
      )$f$, t || '_update', t);

    execute format($f$
      create policy %1$I on public.%2$I for delete using (
        public.is_super_admin() or (org_id = public.my_org() and public.is_org_admin())
      )$f$, t || '_delete', t);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. A disabled member should not still read the organisation row
-- ════════════════════════════════════════════════════════════════════════════
-- org_member_read is `id = my_org()` with no is_active_member(). Every other
-- policy in the schema checks it. So someone whose access was revoked can
-- still read their old employer's name, plan, credit balance and trial dates.
-- Small, but it is the only policy in the system that forgets the check.

drop policy if exists org_member_read on public.organizations;
create policy org_member_read on public.organizations
  for select using (id = public.my_org() and public.is_active_member());

commit;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Every row should now show a specific command, and DELETE should require
-- is_org_admin():
--
--   select c.relname, pol.polname,
--          case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
--               when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
--          pg_get_expr(pol.polqual, pol.polrelid) as using_expr
--     from pg_policy pol join pg_class c on c.oid = pol.polrelid
--    where c.relname in ('leads','activities','conversations','chat_messages','organizations')
--    order by 1, 3;
--
-- Anything still reading "ALL" for a non-super-admin policy is a table this
-- migration did not reach — check it by hand.
--
-- Worth also checking the tables this migration does NOT touch, which may have
-- the same blanket ALL shape:
--
--   select c.relname, pol.polname, pg_get_expr(pol.polqual, pol.polrelid)
--     from pg_policy pol join pg_class c on c.oid = pol.polrelid
--    where pol.polcmd = '*'
--      and pg_get_expr(pol.polqual, pol.polrelid) not like '%is_org_admin%'
--      and pg_get_expr(pol.polqual, pol.polrelid) <> 'is_super_admin()'
--    order by 1;
