-- SECURITY FIX — restore the authorisation check on apply_industry_pack.
--
-- ── What happened ───────────────────────────────────────────────────────────
-- The original function (20260817090000, line 554 grants it to `authenticated`)
-- opened with:
--
--     if not (public.is_super_admin()
--             or (p_org_id = public.my_org() and public.is_org_admin())) then
--       raise exception 'not authorised to configure this organisation';
--     end if;
--
-- 20260911090000 replaced the whole function to make it seed the agent's
-- greeting, subtitle, chips and knowledge. The replacement was written from the
-- shape of the original body and the authorisation block was not carried over.
-- The grant to `authenticated` was re-issued. So since that migration was
-- applied, the function has been a CROSS-TENANT WRITE PRIMITIVE.
--
-- ── What it allowed ─────────────────────────────────────────────────────────
-- Any authenticated user — the free plan is self-serve, so anyone at all — who
-- knew another organisation's UUID could call:
--
--     select apply_industry_pack('<victim org uuid>', 'study_abroad');
--
-- and, in that victim's organisation:
--
--   * insert pipeline stages onto their board
--   * insert custom field definitions against their records
--   * change organizations.industry_slug, which re-labels the whole UI
--   * write persona, knowledge, greeting, header_subtitle and quick_replies
--     into agent_config wherever those were empty — i.e. reconfigure the AI
--     agent running on the victim's own website
--
-- It is SECURITY DEFINER, so RLS does not stop any of it. Nothing is read back
-- to the attacker, so this is integrity and availability rather than
-- confidentiality — but re-pointing a live business's website agent is not a
-- small thing, and "they would need the UUID" is an obstacle, not a control.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Restore the check, verbatim in intent, as the first statement in the body —
-- before any read of `industries` and long before any write. Everything else in
-- the 20260911090000 version is preserved exactly.

begin;

create or replace function public.apply_industry_pack(p_org_id uuid, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ind        public.industries%rowtype;
  s          jsonb;
  f          jsonb;
  n_stages   int := 0;
  n_fields   int := 0;
begin
  -- AUTHORISATION. First statement in the body, deliberately: this function is
  -- SECURITY DEFINER and granted to `authenticated`, so it is the only thing
  -- standing between a logged-in stranger and another tenant's configuration.
  --
  -- Dropped by accident in 20260911090000 when the function was rewritten to
  -- seed agent copy. Restored here. If you rewrite this function again, this
  -- block moves with it.
  if not (public.is_super_admin()
          or (p_org_id = public.my_org() and public.is_org_admin())) then
    raise exception 'not authorised to configure this organisation'
      using errcode = 'P0001';
  end if;

  select * into ind from public.industries where slug = p_slug and active;
  if not found then
    raise exception 'unknown industry pack: %', p_slug;
  end if;

  for s in select * from jsonb_array_elements(ind.default_stages) loop
    insert into public.pipeline_stages (org_id, key, label, position, is_won, is_lost)
    values (
      p_org_id,
      s->>'key',
      coalesce(s->>'label', initcap(replace(s->>'key', '_', ' '))),
      coalesce((s->>'position')::int, n_stages),
      coalesce((s->>'is_won')::boolean, false),
      coalesce((s->>'is_lost')::boolean, false)
    )
    on conflict (org_id, key) do nothing;
    n_stages := n_stages + 1;
  end loop;

  for f in select * from jsonb_array_elements(ind.default_fields) loop
    insert into public.field_defs (org_id, key, label, type, options, show_in_list, position)
    values (
      p_org_id,
      f->>'key',
      coalesce(f->>'label', initcap(replace(f->>'key', '_', ' '))),
      coalesce((f->>'type')::public.field_type, 'text'),
      coalesce(f->'options', '[]'::jsonb),
      coalesce((f->>'show_in_list')::boolean, false),
      coalesce((f->>'position')::int, n_fields)
    )
    on conflict (org_id, key) do nothing;
    n_fields := n_fields + 1;
  end loop;

  update public.organizations set industry_slug = p_slug where id = p_org_id;

  -- Seed the whole agent, not just its persona. Anything the business has
  -- already written is preserved. The trailing '' on knowledge matters:
  -- agent_config.knowledge is NOT NULL, so a pack added later without
  -- agent_knowledge would otherwise fail inside create_organisation — i.e.
  -- signup itself breaks, not merely the pack.
  update public.agent_config
     set persona         = coalesce(nullif(persona, ''),         ind.agent_persona),
         industry        = coalesce(nullif(industry, ''),        p_slug),
         knowledge       = coalesce(nullif(knowledge, ''),       ind.agent_knowledge, ''),
         quick_replies   = coalesce(nullif(quick_replies, ''),   ind.quick_replies),
         greeting        = coalesce(nullif(greeting, ''),        ind.agent_greeting),
         header_subtitle = coalesce(nullif(header_subtitle, ''), ind.agent_subtitle)
   where org_id = p_org_id;

  return jsonb_build_object(
    'ok', true, 'industry', p_slug,
    'stages_seeded', n_stages, 'fields_seeded', n_fields
  );
end;
$$;

revoke all on function public.apply_industry_pack(uuid, text) from public, anon;
grant execute on function public.apply_industry_pack(uuid, text) to authenticated;

comment on function public.apply_industry_pack is
  'Seed an org with an industry pack''s stages, fields and complete agent copy. Idempotent, never overwrites anything the business has written itself. AUTHORISATION IS INSIDE THE BODY — super admin, or an org_admin acting on their own org — because this is SECURITY DEFINER and granted to authenticated, so RLS does not apply.';

-- ════════════════════════════════════════════════════════════════════════════
-- Two read-only functions that also take an arbitrary org id
-- ════════════════════════════════════════════════════════════════════════════
-- plan_of() and effective_plan() are SECURITY DEFINER, granted to
-- `authenticated` (20260821080000), and check nothing. Any logged-in user who
-- knows an org UUID can read that organisation's plan, seat cap, record cap and
-- expiry state.
--
-- Less serious than the above — it is competitor intelligence, not customer
-- data, and no write is possible. But neither is called from the browser:
-- `grep -r '\.rpc("plan_of"' app/src` returns nothing, and the only frontend
-- references to effective_plan are a comment and a column name in the admin
-- list, which comes from admin_list_orgs. They exist to be called by other
-- SECURITY DEFINER functions and by triggers, which run as the definer and do
-- not need the grant.
--
-- So: revoke from authenticated. If some screen turns out to need one, it
-- should go through usage_snapshot(), which asks the same question and DOES
-- check the caller.
revoke all on function public.plan_of(uuid)        from public, anon, authenticated;
revoke all on function public.effective_plan(uuid) from public, anon, authenticated;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'apply_industry_pack authorises the caller' as check,
       case when pg_get_functiondef('public.apply_industry_pack(uuid, text)'::regprocedure)
                 like '%not authorised to configure this organisation%'
            then 'PASS' else 'FAIL — the check is still missing' end as result
union all
select 'the check runs before any write',
       case when position('not authorised' in
                  pg_get_functiondef('public.apply_industry_pack(uuid, text)'::regprocedure))
                < position('insert into public.pipeline_stages' in
                  pg_get_functiondef('public.apply_industry_pack(uuid, text)'::regprocedure))
            then 'PASS' else 'FAIL — a write happens before the check' end
union all
select 'plan_of is no longer callable by any logged-in user',
       case when not has_function_privilege('authenticated', 'public.plan_of(uuid)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'effective_plan is no longer callable by any logged-in user',
       case when not has_function_privilege('authenticated', 'public.effective_plan(uuid)', 'execute')
            then 'PASS' else 'FAIL' end
union all
select 'the app can still read its own usage',
       case when has_function_privilege('authenticated', 'public.usage_snapshot(uuid)', 'execute')
            then 'PASS — and usage_snapshot checks the caller' else 'FAIL — Settings will break' end
union all
-- Every SECURITY DEFINER function that takes an org id and is reachable by a
-- logged-in user. Each one needs a check in its body. Read this list.
select 'org-id functions still reachable by authenticated',
       coalesce((select string_agg(p.proname, ', ' order by p.proname)
                   from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.prosecdef
                    and pg_get_function_identity_arguments(p.oid) like '%uuid%'
                    and has_function_privilege('authenticated', p.oid, 'execute')),
                'none');
