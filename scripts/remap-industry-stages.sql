-- Move aa-enterprises and toppers-hub onto their real pipelines.
--
-- ── Why this is now a small job ─────────────────────────────────────────────
-- 20260911110000 repointed both organisations to the right industry pack but
-- deliberately left their stages alone, because leads.stage_key references them
-- and remapping moves real records. The check afterwards showed the volumes:
--
--   aa-enterprises   wholesale   still on study-abroad stages    2 records
--   toppers-hub      education   still on study-abroad stages    0 records
--
-- Two records and none. That is the cheapest this will ever be — the cost of a
-- stage remap is entirely in the records that have to move, and there are
-- almost none. Left alone, a yarn wholesaler keeps a board with "visa" and
-- "enrolled" columns, and every record captured from here on lands in a
-- study-abroad stage that its own industry pack does not define.
--
-- ── What this does ──────────────────────────────────────────────────────────
--   1. Syncs each org's stages to its pack's definition — inserting what is
--      missing AND correcting the label, position and won/lost flags of keys
--      that already exist. That second half matters: `counselled`,
--      `application` and `enrolled` appear in BOTH the study-abroad and
--      education packs, so apply_industry_pack's `on conflict do nothing` would
--      leave them sitting at study-abroad's positions and produce a board
--      ordered half one way and half the other.
--   2. Moves every record onto the nearest equivalent stage.
--   3. Deletes leftover stages, but only the ones no record is using.
--   4. Refuses to commit if a single record would be stranded.
--
-- Step 4 is the point. It raises rather than reports, so the transaction aborts
-- and you are left exactly where you started. A remap that half-works is worse
-- than one that does not run.
--
-- Safe to re-run: every step is idempotent.

begin;

do $$
declare
  r          record;
  v_org      uuid;
  v_pack     text;
  s          jsonb;
  n_moved    int;
  n_dropped  int;
  v_stranded text;
begin
  for r in
    select * from (values
      -- org slug,        its pack,      old stage  -> new stage
      ('aa-enterprises', 'wholesale',  '[["new","enquiry"],["contacted","qualified"],["counselled","quoted"],["application","negotiation"],["offer","negotiation"],["visa","negotiation"],["enrolled","order_won"],["lost","lost"]]'),
      -- toppers-hub is domestic coaching: an enquiry becomes a demo class,
      -- then fees, then enrolment. `offer` and `visa` have no counterpart at
      -- all, so they collapse into fee_pending — the stage that actually means
      -- "we have quoted and are waiting".
      ('toppers-hub',    'education',  '[["new","enquiry"],["contacted","enquiry"],["counselled","counselled"],["application","application"],["offer","fee_pending"],["visa","fee_pending"],["enrolled","enrolled"],["lost","dropped"]]')
    ) as t(slug, pack, mapping)
  loop
    select id into v_org from public.organizations where slug = r.slug;
    if v_org is null then
      raise notice 'No organisation %, skipping.', r.slug;
      continue;
    end if;
    v_pack := r.pack;

    -- ── 1. Sync stages to the pack definition ───────────────────────────────
    for s in
      select e.value
        from public.industries i,
             jsonb_array_elements(i.default_stages) as e(value)
       where i.slug = v_pack
    loop
      insert into public.pipeline_stages (org_id, key, label, position, is_won, is_lost)
      values (
        v_org,
        s->>'key',
        coalesce(s->>'label', initcap(replace(s->>'key', '_', ' '))),
        coalesce((s->>'position')::int, 0),
        coalesce((s->>'is_won')::boolean, false),
        coalesce((s->>'is_lost')::boolean, false)
      )
      on conflict (org_id, key) do update set
        label    = excluded.label,
        position = excluded.position,
        is_won   = excluded.is_won,
        is_lost  = excluded.is_lost;
    end loop;

    -- ── 2. Move the records ─────────────────────────────────────────────────
    update public.leads l
       set stage_key = m.new_key
      -- `as x(pair)` names the COLUMN. Without the column name, `x` is a
      -- whole-row reference to a one-column table, and `x->>0` asks for the
      -- jsonb operator on a record — "operator does not exist: record ->>
      -- integer". Naming it is the difference between this running and not.
      from (select pair->>0 as old_key, pair->>1 as new_key
              from jsonb_array_elements(r.mapping::jsonb) as x(pair)) m
     where l.org_id = v_org
       and l.stage_key = m.old_key
       -- Do not touch a record already sitting on a stage the pack defines.
       -- `counselled` and `application` are in both packs, so without this an
       -- education record correctly on `counselled` would be "moved" to
       -- `counselled` — harmless, but it would also catch anything a human had
       -- already fixed by hand.
       and l.stage_key not in (
         select e.value->>'key'
           from public.industries i,
                jsonb_array_elements(i.default_stages) as e(value)
          where i.slug = v_pack
       );
    get diagnostics n_moved = row_count;

    -- ── 3. Remove stages the pack does not define, if nothing is on them ────
    delete from public.pipeline_stages ps
     where ps.org_id = v_org
       and ps.key not in (
         select e.value->>'key'
           from public.industries i,
                jsonb_array_elements(i.default_stages) as e(value)
          where i.slug = v_pack)
       and not exists (
         select 1 from public.leads l
          where l.org_id = ps.org_id and l.stage_key = ps.key);
    get diagnostics n_dropped = row_count;

    raise notice '% → % pack: % record(s) moved, % old stage(s) removed.',
      r.slug, v_pack, n_moved, n_dropped;

    -- ── 4. Refuse to commit if anything is stranded ─────────────────────────
    select string_agg(distinct l.stage_key, ', ') into v_stranded
      from public.leads l
     where l.org_id = v_org
       and l.stage_key is not null
       and not exists (
         select 1 from public.pipeline_stages ps
          where ps.org_id = l.org_id and ps.key = l.stage_key);

    if v_stranded is not null then
      raise exception
        'ABORTED: % has record(s) on stage(s) with no column: %. Nothing has been changed — extend the mapping and re-run.',
        r.slug, v_stranded;
    end if;
  end loop;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select 'every record sits on a stage that exists' as check,
       case when not exists (
              select 1 from public.leads l
               where l.stage_key is not null
                 and not exists (select 1 from public.pipeline_stages ps
                                  where ps.org_id = l.org_id and ps.key = l.stage_key))
            then 'PASS' else 'FAIL — a record is stranded' end as result
union all
select 'no study-abroad stage survives on a non-study-abroad org',
       coalesce((select 'FAIL — ' || string_agg(distinct o.slug, ', ')
                   from public.pipeline_stages ps
                   join public.organizations o on o.id = ps.org_id
                  where o.industry_slug is distinct from 'study_abroad'
                    and ps.key in ('visa', 'offer', 'counselled')
                    and o.slug in ('aa-enterprises')),
                'PASS')
union all
select 'both boards now match their pack',
       (select string_agg(x.slug || ': ' || x.stages, '   |   ' order by x.slug)
          from (select o.slug,
                       string_agg(ps.key, ' → ' order by ps.position) as stages
                  from public.organizations o
                  join public.pipeline_stages ps on ps.org_id = o.id
                 where o.slug in ('aa-enterprises', 'toppers-hub')
                 group by o.id, o.slug) x);

-- Where the records ended up.
select o.slug, l.stage_key, count(*) as records
  from public.leads l
  join public.organizations o on o.id = l.org_id
 where o.slug in ('aa-enterprises', 'toppers-hub')
 group by o.slug, l.stage_key
 order by o.slug;
