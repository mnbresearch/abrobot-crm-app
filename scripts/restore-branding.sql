-- Give three organisations back the branding that used to be hardcoded.
--
-- ── A regression I caused, found by checking the live config ────────────────
-- 20260911090000 and the widget.js rewrite removed two hardcoded paths:
--
--   1. widget.js CFG defaults — AbroBot's orange (#f97316) and AbroBot's logo,
--      applied to EVERY tenant whose config was silent. That was the bug: a
--      dental clinic rendered in AbroBot orange with AbroBot's logo.
--   2. widget.js PRESETS — a block of hardcoded configuration for two named
--      customers, shipped inside a file every OTHER customer downloads.
--
-- Both had to go, and the neutral defaults that replaced them are right. But
-- removing them took real branding with it, because for these three orgs the
-- branding only ever existed in those two places and never in the database.
-- Checking the live config endpoint after the deploy showed it plainly:
--
--   abrobot          widget_color #2f3a4a (was #f97316)   logo_url null
--   aa-enterprises   widget_color #1e40af  ✓ in DB        logo_url null
--   toppers-hub      widget_color #059669  ✓ in DB        logo_url null
--
-- So three live websites are showing 💬 where their logo used to be, and
-- AbroBot's own is slate instead of orange. The colours for the two customers
-- survived because those were already in agent_config; only the logos and the
-- left-hand widget position lived exclusively in the preset block.
--
-- The fix is not to put the values back in the JavaScript. It is to put them
-- where they always belonged — in each organisation's own configuration row,
-- editable by them in Settings → AI Agent, and invisible to every other
-- tenant.
--
-- Safe to re-run. Only fills what is empty, so anything set in Settings since
-- the deploy wins.

begin;

do $$
declare
  r       record;
  v_org   uuid;
  v_done  int := 0;
begin
  for r in
    select * from (values
      -- slug,             logo_url,                                                              colour,     position
      ('abrobot',        'https://www.abrobot.ai/web/image/website/1/logo/AbroBot',               '#f97316',  'right'),
      ('aa-enterprises', 'https://www.aaenterprises.in/web/image/website/1/logo/AA%20Enterprises', null,      'left'),
      ('toppers-hub',    'https://www.topperhubacademy.com/web/image/website/1/logo/toppershubacademy', null, 'left')
    ) as t(slug, logo_url, widget_color, widget_position)
  loop
    select id into v_org from public.organizations where slug = r.slug;
    if v_org is null then
      raise notice 'No organisation %, skipping.', r.slug;
      continue;
    end if;

    -- coalesce(nullif(...)) throughout: if someone has already set a logo or
    -- colour in Settings since the deploy, theirs wins. This restores what was
    -- lost; it does not overwrite what was chosen.
    update public.agent_config
       set logo_url        = coalesce(nullif(logo_url, ''), r.logo_url),
           widget_color    = coalesce(nullif(widget_color, ''), r.widget_color),
           widget_position = coalesce(nullif(widget_position, ''), r.widget_position)
     where org_id = v_org;

    v_done := v_done + 1;
    raise notice 'Restored branding for %.', r.slug;
  end loop;

  raise notice '% organisation(s) updated.', v_done;
end $$;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────
select o.slug,
       coalesce(ac.widget_color, '—')    as colour,
       coalesce(ac.widget_position, '—') as position,
       case when ac.logo_url is null or ac.logo_url = ''
            then 'none — widget shows 💬'
            else 'set' end               as logo
  from public.organizations o
  left join public.agent_config ac on ac.org_id = o.id
 order by o.slug;

-- ednex deliberately has no logo and no colour of its own. It only ever
-- LOOKED branded because it was inheriting AbroBot's orange and AbroBot's logo
-- from the widget default — which is the precise bug this release removed. It
-- now renders neutral slate with a 💬, which is honest. Whoever runs that
-- organisation should set their own in Settings → AI Agent.
--
-- Nothing here is required for the product to work. A tenant with no logo gets
-- a chat glyph, which is fine; a tenant wearing another company's logo is not.

-- ── After running this ──────────────────────────────────────────────────────
-- No deploy needed. The widget reads this from the config endpoint on every
-- page load, so a hard refresh on each site is enough to see it.
