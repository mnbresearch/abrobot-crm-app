// AbroBot CRM — automated email follow-up, per tenant.
//
// Deploy:  supabase functions deploy nurture --no-verify-jwt
// Secrets:
//   RESEND_API_KEY   platform sending key (a tenant's own key overrides it)
//   NURTURE_FROM     optional; default 'hello@updates.mnbresearch.com'
//   CRON_SECRET      required — see _shared/cron-auth.ts
//
// POST {}                     -> every eligible org
// POST {"org":"slug"}         -> one org
// GET  ?unsub=<token>         -> unsubscribe (the footer link)
//
// ── What this used to be, and why it changed ────────────────────────────────
// This function contained three study-abroad emails signed AbroBot, defaulted
// to org 'abrobot', and treated a missing agent_config row as consent to send.
// As a single-tenant tool that was fine. As a product sold to other businesses
// it meant the first correct cron run would email a dental clinic's patients
// about university shortlists — from our sending domain, earning spam
// complaints that would land on every other tenant's deliverability.
//
// So: the copy now belongs to the tenant (message_templates.nurture_step, i.e.
// the Templates screen), sending is opt-IN, and an org with no templates sends
// nothing rather than falling back to somebody else's marketing.

import { createClient } from "npm:@supabase/supabase-js@2";
import { requireCronSecret } from "../_shared/cron-auth.ts";
import { applyTemplate, escapeHtml, textToHtml } from "../_shared/template.ts";
import { fetchWithTimeout } from "../_shared/http.ts";
import {
  buildSequences,
  sequenceNames,
  type NurtureTemplate,
  type Sequence,
} from "../_shared/sequences.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const PLATFORM_RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_ADDRESS = Deno.env.get("NURTURE_FROM") || "hello@updates.mnbresearch.com";
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

// Gap before each step, in hours: ~1h after capture, then +3 days, +4 days.
// Steps beyond the third reuse the last gap.
const GAP_HOURS = [1, 72, 96];

// A ceiling on the whole run, not just per org.
//
// ORGS_PER_RUN x LEADS_PER_ORG allows 2,500 sends in one invocation on the
// shared platform Resend key, whose free tier is 100/day. After an outage the
// backlog is exactly large enough to hit that, so the first recovery run would
// 429 partway and throw for everything after — which, before the heartbeat fix
// above, it reported as success.
//
// Stopping short is recoverable: the next run picks the backlog up. Burning the
// day's provider quota is not.
const MAX_SENDS_PER_RUN = 80;
const ORGS_PER_RUN = 25;   // free-tier edge functions have a wall-clock budget
const LEADS_PER_ORG = 100;

type Tpl = NurtureTemplate;

// deno-lint-ignore no-explicit-any
type Lead = any;

function buildEmail(tpl: Tpl, lead: Lead, brand: string, unsubUrl: string, contactUrl: string) {
  const subject = applyTemplate(tpl.subject || `A quick follow-up from ${brand}`, lead, brand);
  const bodyHtml = textToHtml(applyTemplate(tpl.body, lead, brand));

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6;font-size:15px">
  <div style="text-align:center;padding:8px 0 18px;font-size:19px;font-weight:800">${escapeHtml(brand)}</div>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
  <p style="font-size:12px;color:#64748b">
    You are receiving this because you enquired with ${escapeHtml(brand)}. Reply to this email to reach us, or
    <a href="${unsubUrl}" style="color:#64748b">unsubscribe</a>.${
      contactUrl ? ` <a href="${escapeHtml(contactUrl)}" style="color:#64748b">Contact ${escapeHtml(brand)}</a>.` : ""
    }
  </p>
</div>`;

  return { subject, html };
}

async function sendEmail(
  key: string,
  from: string,
  to: string,
  replyTo: string | null,
  subject: string,
  html: string,
  unsubUrl: string,
) {
  const r = await fetchWithTimeout("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      from,
      to: [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject,
      html,
      // RFC 8058. Gmail and Yahoo require one-click unsubscribe for bulk
      // senders; without these headers this mail is filtered on reputation
      // regardless of how good the copy is.
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

// ── one organisation ────────────────────────────────────────────────────────
async function runOrg(org: { id: string; name: string; slug: string }) {
  const { data: cfg, error: cfgErr } = await supabase
    .from("agent_config")
    .select("nurture_enabled, resend_api_key, resend_from, resend_reply_to, brand_name, contact_url, booking_url")
    .eq("org_id", org.id).maybeSingle();

  // A failed read here is already fail-safe — cfg is null, so the opt-in check
  // below refuses — but it reported the tenant as "nurture is off", which is a
  // configuration state, not a fault. Six weeks of a tenant's follow-up not
  // running would have looked like a deliberate setting on every run report.
  if (cfgErr) {
    return {
      org: org.slug,
      skipped: `could not read nurture settings: ${cfgErr.message}`,
      sent: 0,
      failed: true,
    };
  }

  // Opt-in, explicitly. A missing config row is not consent.
  if (cfg?.nurture_enabled !== true) {
    return { org: org.slug, skipped: "nurture is off", sent: 0 };
  }

  const { data: tplRows, error: tplErr } = await supabase
    .from("message_templates")
    .select("subject, body, nurture_step, nurture_segment")
    .eq("org_id", org.id)
    .eq("channel", "email")
    .not("nurture_step", "is", null)
    .order("nurture_step", { ascending: true });

  // Same shape as the config read: fail-safe in effect, but it reported a
  // refused read as "no nurture templates written" — telling the operator the
  // tenant had never done the setup, when in fact we could not look.
  if (tplErr) {
    return {
      org: org.slug,
      skipped: `could not read templates: ${tplErr.message}`,
      sent: 0,
      failed: true,
    };
  }

  const templates = (tplRows ?? []) as Tpl[];
  if (templates.length === 0) {
    // The important branch. No templates means this tenant has never written
    // follow-up copy, so there is nothing legitimate to send on their behalf.
    return { org: org.slug, skipped: "no nurture templates written", sent: 0 };
  }

  // Grouping rules, and the reasoning behind them, live in _shared/sequences.ts
  // where they are covered by tests.
  const seqs = buildSequences(templates);

  const key = (cfg.resend_api_key || "").trim() || PLATFORM_RESEND_KEY;
  if (!key) return { org: org.slug, skipped: "no Resend key", sent: 0 };

  // The plan's monthly email allowance. Unattended sending is exactly where a
  // limit matters most: nobody is watching, and it runs again in an hour.
  // Fail CLOSED — see the same fix in send-campaign. null means "unlimited",
  // so an errored RPC would have removed the cap on an unattended job that
  // runs again every hour.
  const { data: allowance, error: allowErr } = await supabase.rpc("email_allowance", { p_org_id: org.id });
  if (allowErr) {
    console.error(`nurture: email_allowance failed for ${org.slug}:`, allowErr.message);
    return { org: org.slug, skipped: "could not read the email allowance", sent: 0 };
  }
  let budget: number | null = allowance?.remaining ?? null;
  if (budget === 0) {
    return { org: org.slug, skipped: "monthly email allowance used up", sent: 0 };
  }

  const brand = (cfg.brand_name || org.name || "").trim() || org.slug;

  // ── The key and the From address must belong to the same account ────────
  //
  // Display name is the tenant's; on the PLATFORM key the address stays on our
  // verified domain, because a tenant's own domain is not SPF/DKIM-authorised
  // for us and would fail authentication outright.
  //
  // But a tenant's OWN Resend key was being paired with our address, and their
  // account has not verified our domain — so Resend rejects every message with
  // a 403. Integrations actively invites an admin to paste their own key, and
  // doing so silently turned that tenant's entire follow-up programme off.
  // `agent_config.resend_from` and `resend_reply_to` existed for this and were
  // read by no code at all: the columns, the UI and the sender disagreed.
  //
  // So: own key → own From address, and refuse rather than send from an
  // address the key cannot authenticate. Refusing is visible in the run report
  // and fixable in a minute; a 100% rejection rate looks like nothing at all.
  const ownKey = (cfg.resend_api_key || "").trim();
  const ownFrom = (cfg.resend_from || "").trim();

  // WARN, do not refuse.
  //
  // My first version returned `failed: true` here and stopped the org. That was
  // wrong on two counts, and the second is the serious one:
  //
  //   * `resend_from` is NULL for every tenant today — nothing has ever
  //     written it — so the guard would have stopped follow-up for every
  //     organisation with its own key, the moment it deployed, until an admin
  //     happened to visit Integrations. That is breaking working customers to
  //     fix a suspected fault.
  //   * The fault is only *suspected*. The reasoning is that Resend rejects a
  //     tenant key paired with our domain — sound in principle, but unverified
  //     against this account, and `save-integration`'s own `test_email` still
  //     pairs them, so an admin testing the connection would see it succeed.
  //
  // So: prefer the tenant's address when set, keep today's behaviour exactly
  // when it is not, and make the suspect combination visible in the run report
  // rather than acting on it. If the 403s are real, this surfaces them with a
  // name attached; if they are not, nothing was broken to find out.
  const fromAddress = ownKey && ownFrom ? ownFrom : FROM_ADDRESS;
  const senderMismatch = !!ownKey && !ownFrom;
  const from = `${brand.replace(/["<>\\]/g, "")} <${fromAddress}>`;

  // Replies must reach the tenant, not us. The old function routed every
  // reply to a personal Gmail — which for any customer other than AbroBot
  // means their prospect's answer goes to a stranger. The org's longest-
  // standing admin is the closest thing to an owner inbox we hold.
  // Left unchecked on purpose, and this is the one place that is right: a
  // failed read yields no reply-to, the email still sends, and a missing
  // Reply-To header degrades the message without misdirecting anyone. Refusing
  // to send over it would be the worse trade.
  const { data: adminRow } = await supabase.from("profiles")
    .select("email").eq("org_id", org.id).eq("status", "active")
    .in("role", ["org_admin", "super_admin"])
    .order("created_at", { ascending: true }).limit(1).maybeSingle();

  // An explicitly configured reply-to wins over the inferred admin inbox.
  // `agent_config.resend_reply_to` has existed since 20260905120000 and was
  // read by nothing, so a tenant who deliberately set "replies go to
  // sales@ourcompany.com" was silently overruled by whichever admin happened
  // to be created first.
  const replyTo = (cfg.resend_reply_to || "").trim() || (adminRow?.email || "").trim() || null;

  // Terminal stages are where follow-up must stop: a customer who has bought,
  // or explicitly said no, should not keep getting "one last nudge". The old
  // code allow-listed three legacy stage names, which meant every industry
  // pack that does not use them nurtured nobody — or, once stage_key landed,
  // nurtured people who had already converted.
  const { data: terminal, error: terminalErr } = await supabase
    .from("pipeline_stages").select("key")
    .eq("org_id", org.id).or("is_won.eq.true,is_lost.eq.true");

  // FAIL CLOSED. This is the one unchecked read in this file that was not
  // safe: postgrest-js resolves with { data: null, error }, so a refused read
  // left `terminal` null, `stop` empty, and the guard at the send site is
  // `if (stop.size)` — which then skips the exclusion ENTIRELY and emails the
  // people it exists to protect. A customer who has already paid gets "just
  // one last nudge about enrolling", and someone who explicitly said no gets
  // chased. Sending nothing for one cycle is the cheaper mistake by a wide
  // margin, so a read failure stops this org rather than widening the audience.
  if (terminalErr) {
    return {
      org: org.slug,
      skipped: `could not read pipeline stages, refusing to send: ${terminalErr.message}`,
      sent: 0,
      failed: true,
    };
  }

  const stop = new Set((terminal ?? []).map((s: { key: string }) => s.key));

  // Zero terminal stages is not an error, but it means nobody is EVER excluded
  // from follow-up — there is no stage that counts as won or lost, so the
  // sequence runs at everyone until it ends. That is a misconfiguration worth
  // surfacing rather than silently honouring, so it is reported on the result
  // and rolls up into the heartbeat.
  const noTerminalStages = stop.size === 0;

  // ── Who to consider, one sequence at a time ───────────────────────────────
  //
  // This used to be a single unordered `.limit(100)` over every record below
  // the org's longest sequence, with the sequence choice made in the loop. That
  // is a starvation bug, and a bad one. Records that can NEVER be sent — a
  // segment nobody wrote copy for, or one that finished a shorter sequence —
  // still satisfied the query, so they were re-fetched every hour forever. Once
  // a hundred of them accumulate, the page is entirely full of them and records
  // that SHOULD receive an email are never fetched at all. Follow-up stops, and
  // the run report says "candidates: 100" the whole time.
  //
  // MNB Research is exactly that shape today: a crm-website sequence and no
  // default, so every consulting enquiry in the org is permanently ineligible.
  //
  // So the filtering moves into the query. Each sequence gets its own pass,
  // bounded by ITS OWN maxStep, and only fetches records it could actually
  // send to. Ordered oldest-first so the page is deterministic rather than
  // whatever Postgres felt like returning.
  const named = [...seqs.bySegment.keys()];
  const quotedSegments = named.map((s) => `"${s.replace(/"/g, '""')}"`).join(",");

  // deno-lint-ignore no-explicit-any
  type Q = any;
  const passes: { label: string; seq: Sequence; narrow: (q: Q) => Q }[] = [
    ...named.map((s) => ({
      label: s,
      seq: seqs.bySegment.get(s)!,
      narrow: (q: Q) => q.eq("segment", s),
    })),
    // The default sequence covers two disjoint groups, queried separately.
    // They could be one `.or()`, but a second or() alongside the terminal-stage
    // one relies on PostgREST's AND-ing of repeated params, and `segment not in
    // (...)` is NULL for a NULL segment — the classic trap that would silently
    // drop every unsegmented record. Two plain filters cannot be misread.
    ...(seqs.def
      ? [
        { label: "default", seq: seqs.def, narrow: (q: Q) => q.is("segment", null) },
        ...(named.length
          ? [{
            label: "default (unwritten segments)",
            seq: seqs.def,
            narrow: (q: Q) => q.not("segment", "in", `(${quotedSegments})`),
          }]
          : []),
      ]
      : []),
  ];

  const now = Date.now();
  let sent = 0;
  let considered = 0;
  let quota = LEADS_PER_ORG;   // shared across passes: the per-org work budget
  const errors: string[] = [];
  const perSequence: Record<string, number> = {};

  for (const pass of passes) {
    if (quota <= 0) break;
    if (budget !== null && budget <= 0) break;

    // ── Only fetch leads that are actually DUE ──────────────────────────
    //
    // This used to select on step alone — "could this lead EVER be sent" —
    // and then evaluate due-ness in JavaScript after the page had been
    // fetched. Ordered oldest-first with .limit(quota), the oldest N leads
    // occupied the whole page whether or not they were due, including through
    // their entire 72h and 96h waiting windows.
    //
    // Worked example, 300 overdue leads, three steps, daily cron:
    //   day 1  leads 1-100 sent step 0
    //   day 2  leads 1-100 fetched again, all inside 72h → 0 sent
    //   day 3  same → 0 sent
    //   day 4  leads 1-100 sent step 1
    //   ...
    //   leads 201-300 receive their first email about 17 days later.
    //
    // The run report said `considered: 100, sent: 0` and the heartbeat said
    // ok. This is the same starvation the comment below describes, one level
    // up in the query rather than in the budget.
    //
    // The gap depends on nurture_step, so the filter has to be per step.
    //
    // Two queries per step rather than one nested .or(): a lead is due if it
    // has never been sent to (measure from created_at) or was last sent to
    // before the cutoff. Expressed with .is/.lt only, because getting a
    // nested PostgREST or() subtly wrong here means either emailing people
    // early or not at all, and neither is visible until a customer complains.
    const dueLeads: Lead[] = [];
    let passErr: string | null = null;

    for (let step = 0; step < pass.seq.maxStep && quota > 0; step++) {
      const gapMs = (GAP_HOURS[step] ?? GAP_HOURS[GAP_HOURS.length - 1]) * 3600_000;
      const cutoff = new Date(now - gapMs).toISOString();

      const base = () => {
        let b = supabase.from("leads")
          .select("id, name, email, phone, target_country, course, course_level, intake, custom, segment, stage_key, nurture_step, nurture_last_sent_at, nurture_token, created_at")
          .eq("org_id", org.id)
          // Deletion is enforced in RLS only, and this runs as the service
          // role. Without this, the follow-up engine keeps emailing people the
          // customer deleted — the most visible possible version of this bug,
          // and one with consent implications rather than merely cosmetic ones.
          .is("deleted_at", null)
          .not("email", "is", null)
          .eq("nurture_opted_out", false)
          .eq("nurture_step", step)
          .order("created_at", { ascending: true })
          .limit(quota);

        b = pass.narrow(b);

        if (stop.size) {
          // Quoted: a stage key is normally a slug, but nothing enforces that,
          // and an unquoted comma or parenthesis in one key would silently
          // reshape the filter — which here means emailing people who have
          // already converted.
          const list = [...stop].map((k) => `"${k.replace(/"/g, '""')}"`).join(",");
          b = b.or(`stage_key.is.null,stage_key.not.in.(${list})`);
        }
        return b;
      };

      // Never sent to: the gap runs from when the record was created.
      const neverSent = await base().is("nurture_last_sent_at", null).lt("created_at", cutoff);
      // Sent to before: the gap runs from the last send.
      const sentBefore = await base().lt("nurture_last_sent_at", cutoff);

      if (neverSent.error || sentBefore.error) {
        passErr = (neverSent.error ?? sentBefore.error)!.message;
        break;
      }
      dueLeads.push(...((neverSent.data ?? []) as Lead[]));
      dueLeads.push(...((sentBefore.data ?? []) as Lead[]));
    }

    if (passErr) {
      // One pass failing must not silently cancel the others.
      errors.push(`${pass.label}: ${passErr}`);
      continue;
    }

    const leads = dueLeads.slice(0, quota);
    considered += leads.length;

    for (const l of leads) {
      if (budget !== null && budget <= 0) break;
      if (quota <= 0) break;

      // NOTE: quota is spent on WORK DONE, not on rows looked at.
      //
      // Decrementing here — one per lead examined — reintroduced the exact
      // starvation this rewrite removed, one level down. A first pass whose
      // leads are all still inside their gap window would `continue` a hundred
      // times, burn the entire per-org budget on doing nothing, and every later
      // pass would be skipped because quota hit zero. Segment A's not-yet-due
      // records would silently starve segment B's due ones, every run, forever.
      //
      // Skipping a lead is nearly free (no write, no send), so it should not
      // cost budget. The `.limit(quota)` above still bounds how much we fetch.
      const seq = pass.seq;
      const tpl = seq.byStep.get(l.nurture_step);

      const gapH = GAP_HOURS[l.nurture_step] ?? GAP_HOURS[GAP_HOURS.length - 1];
      const since = l.nurture_last_sent_at
        ? now - new Date(l.nurture_last_sent_at).getTime()
        : now - new Date(l.created_at).getTime();
      // Checked BEFORE the hole-advance below. A gap at step 0 would otherwise
      // advance a record seconds after it was created, collapsing the deliberate
      // one-hour wait before the first email.
      if (since < gapH * 3600_000) continue;

      if (!tpl) {
        // A hole in the sequence — someone deleted step 2 of three. Advance
        // past it WITHOUT sending, so step 3 is still reachable. Simply
        // skipping (what this did before) left every mid-sequence record
        // stalled on the missing step permanently, and re-fetched it hourly
        // for good measure. nurture_last_sent_at is deliberately untouched, so
        // the next step's gap is still measured from the last real send.
        const { error: holeErr } = await supabase.from("leads")
          .update({ nurture_step: l.nurture_step + 1 }).eq("id", l.id);
        // Not swallowed: if this write fails the record is re-fetched and
        // re-advanced on every run for ever, which is a silent infinite loop
        // dressed up as a no-op.
        if (holeErr) errors.push(`${l.id}: could not advance past a missing step (${holeErr.message})`);
        quota--;   // a write happened
        continue;
      }

      try {
        const unsubUrl = `${FN_BASE}/nurture?unsub=${l.nurture_token}`;
        const { subject, html } = buildEmail(tpl, l, brand, unsubUrl, (cfg.contact_url || "").trim());

        await sendEmail(key, from, l.email, replyTo, subject, html, unsubUrl);

        // Advance the step BEFORE anything else can fail. If the activity insert
        // errors after a successful send, the worst outcome must be a missing
        // log line, never the same email again on the next run.
        const { error: stepErr } = await supabase.from("leads").update({
          nurture_step: l.nurture_step + 1,
          nurture_last_sent_at: new Date().toISOString(),
        }).eq("id", l.id);
        if (stepErr) {
          // Cannot record that we sent → we would resend. Say so loudly.
          console.error(`nurture: SENT to ${l.email} but could not advance step:`, stepErr.message);
          errors.push(`${l.id}: sent but step not advanced (${stepErr.message})`);
        }

        await supabase.from("activities").insert({
          org_id: org.id, lead_id: l.id, type: "email",
          // seq.maxStep, not an org-wide bound: telling someone this was "email
          // 2 of 5" when their sequence has two is a small lie that makes the
          // history unreadable once an org runs more than one sequence.
          content: `Follow-up email ${l.nurture_step + 1} of ${seq.maxStep} sent automatically to ${l.email}` +
            (tpl.nurture_segment ? ` (${tpl.nurture_segment} sequence).` : "."),
        });
        sent++;
        quota--;   // a send happened — this is what the per-org budget is for
        perSequence[pass.label] = (perSequence[pass.label] ?? 0) + 1;
        if (budget !== null) budget--;
      } catch (e) {
        errors.push(`${l.email}: ${(e as Error).message}`);
      }
    }
  }

  if (sent > 0) {
    await supabase.rpc("consume_usage", { p_org_id: org.id, p_metric: "emails", p_amount: sent });
  }

  // `unaddressed` counts records this org has written nobody's copy for. It is
  // no longer a loop counter — those records are now excluded by the query, so
  // it has to be asked for directly. It is worth one extra request per org
  // because it is the single number that distinguishes "segmentation is
  // working" from "half my contacts silently stopped receiving follow-up the
  // day I added an audience", and nothing else on the run report would show it.
  let unaddressed = 0;
  if (named.length && !seqs.def) {
    const { count } = await supabase.from("leads")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .is("deleted_at", null)   // must match the send query above, or the
                                // diagnostic counts records it would never mail
      .not("email", "is", null)
      .eq("nurture_opted_out", false)
      .or(`segment.is.null,segment.not.in.(${quotedSegments})`);
    unaddressed = count ?? 0;
  }

  return {
    org: org.slug,
    considered,
    sent,
    sequences: sequenceNames(seqs),
    ...(Object.keys(perSequence).length ? { by_sequence: perSequence } : {}),
    ...(unaddressed ? { unaddressed } : {}),
    // Reported, not enforced. No won/lost stage means nothing ever removes a
    // record from follow-up, so a customer who buys keeps receiving the
    // sequence to its end. That is a tenant misconfiguration rather than a
    // fault here, and refusing to send would be an overreach — but it is
    // invisible from the outside, so it says so on every run.
    ...(noTerminalStages ? { warning: "no won/lost stage configured — nobody is excluded from follow-up" } : {}),
    // Reported, never enforced. If this org's own Resend key is being rejected
    // for sending from our domain, `errors` will fill with 403s and this line
    // says why in one sentence instead of leaving someone to work it out.
    ...(senderMismatch
      ? {
        sender_warning:
          "this organisation has its own Resend key but no sending address of its own, so mail goes " +
          `out from ${FROM_ADDRESS} on their key — if Resend is rejecting these, set an address in Integrations`,
      }
      : {}),
    errors,
  };
}


// The cron-death detector only works if something actually reports in.
// record_heartbeat() shipped with zero callers, so job_heartbeats stayed at
// "never reported" and stale_jobs() flagged every job stale forever — the
// monitoring was itself the thing that was broken.
async function heartbeat(status: string, detail?: string) {
  try {
    await supabase.rpc("record_heartbeat", {
      p_job: "nurture", p_status: status, p_detail: detail ?? null,
    });
  } catch (e) {
    // Never let reporting health break the work whose health is reported.
    console.warn("heartbeat failed:", (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // ── unsubscribe ───────────────────────────────────────────────────────────
  // Kept ahead of the cron check: the recipient clicking this link has no
  // secret, and must never be told "unauthorized" for trying to opt out.
  const url = new URL(req.url);
  const unsub = url.searchParams.get("unsub");
  if (unsub) {
    // A GET must not change anything.
    //
    // Corporate link scanners, spam filters and mail clients prefetch every
    // URL in a message — including the List-Unsubscribe one — before a human
    // ever sees it. Acting on GET meant recipients were being unsubscribed by
    // software they do not control, and we would have had no idea: from our
    // side it looks exactly like a person choosing to leave.
    //
    // RFC 8058 one-click is a POST, so real one-click still works. A human
    // clicking the link in the footer gets a page with a button.
    if (req.method === "GET") {
      return new Response(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">
           <h2>Unsubscribe?</h2>
           <p>You will stop receiving follow-up emails. This cannot be undone from this page.</p>
           <form method="POST">
             <button type="submit" style="background:#b45309;color:#fff;border:none;padding:12px 26px;
               border-radius:8px;font-size:15px;cursor:pointer">Yes, unsubscribe me</button>
           </form>
         </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }
    // Telling someone they are unsubscribed when they are not is the one bug
    // here with legal weight. .select() makes the update report which rows it
    // actually changed, so a stale token cannot render a false confirmation.
    const { data: optedOut, error: unsubErr } = await supabase
      .from("leads")
      .update({ nurture_opted_out: true })
      .eq("nurture_token", unsub)
      .select("id");

    const page = (title: string, body: string, status: number) =>
      new Response(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px">` +
        `<h2>${title}</h2><p>${body}</p></body></html>`,
        { status, headers: { "Content-Type": "text/html" } },
      );

    if (unsubErr) {
      console.error("nurture: unsubscribe FAILED for token", unsub, unsubErr.message);
      return page(
        "We couldn't process that just now",
        "Please email contact@mnbresearch.com and we will remove you straight away. " +
        "We are sorry for the trouble.",
        500,
      );
    }
    if (!optedOut?.length) {
      return page(
        "You're not on this list",
        "That link has already been used, or the address is no longer subscribed. " +
        "If you are still receiving email, contact us at contact@mnbresearch.com.",
        200,
      );
    }
    return page(
      "You're unsubscribed",
      "You won't receive more follow-up emails. You can still reach us anytime at contact@mnbresearch.com.",
      200,
    );
  }

  // ── the scheduled run ─────────────────────────────────────────────────────
  const cronAuth = requireCronSecret(req, CORS);
  if (!cronAuth.ok) return cronAuth.response!;

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let slug: string | null = null;
  try {
    const body = await req.json();
    if (body?.org && typeof body.org === "string") slug = body.org;
  } catch { /* empty body is the normal cron case */ }

  // No org named = every org. This replaces the old default of 'abrobot',
  // which silently made a multi-tenant cron job a single-tenant one: every
  // other customer's follow-up simply never ran.
  let orgs: { id: string; name: string; slug: string }[];
  if (slug) {
    const { data } = await supabase.from("organizations")
      .select("id, name, slug").eq("slug", slug).maybeSingle();
    if (!data) return json({ error: "org not found" }, 404);
    orgs = [data];
  } else {
    const { data, error } = await supabase.from("organizations")
      .select("id, name, slug").eq("active", true).limit(ORGS_PER_RUN);
    if (error) return json({ error: error.message }, 500);
    orgs = data ?? [];
  }

  const results = [];
  let runSent = 0;
  let cappedAt: string | null = null;

  for (const org of orgs) {
    // Stop before the provider does. See MAX_SENDS_PER_RUN.
    if (runSent >= MAX_SENDS_PER_RUN) {
      cappedAt = org.slug;
      console.warn(`nurture: run cap of ${MAX_SENDS_PER_RUN} reached before ${org.slug}; the rest resume next run`);
      break;
    }
    try {
      const r = await runOrg(org);
      runSent += r.sent ?? 0;
      results.push(r);
    } catch (e) {
      // One tenant's misconfiguration must not stop the others' follow-up.
      console.error(`nurture: org ${org.slug} threw:`, e);
      results.push({ org: org.slug, error: (e as Error).message, sent: 0 });
    }
  }

  const sent = results.reduce((n, r) => n + (r.sent ?? 0), 0);

  // `bad` used to count ONLY orgs whose runOrg threw. Per-lead failures — a
  // Resend rejection, a step that could not be advanced, a pass whose query
  // errored — were pushed into r.errors and read by nothing. A run in which
  // 2,400 of 2,500 sends failed wrote last_status = 'ok', and stale_jobs()
  // stayed quiet because the heartbeat was fresh.
  //
  // That mattered most on a restart: the Resend free tier is 100/day, so the
  // first run after an outage 429s partway through and every send after it
  // throws. The old heartbeat reported `ok, 100 sent, 0 failed`.
  //
  // The lead-level failures are the ones that cost a customer their follow-up,
  // so they decide the status.
  const threw = results.filter((r) => "error" in r).length;

  // `failed: true` is the OTHER way an org can go wrong, added alongside the
  // fail-closed reads above: runOrg returns rather than throwing, so nothing
  // here would have seen it. An org refused because its pipeline stages could
  // not be read would have been counted as an ordinary skip and the run would
  // have reported `ok` — which is precisely the shape of bug those reads were
  // being hardened against. A signal has to be read by something.
  const refused = results.filter((r) => (r as { failed?: boolean }).failed === true).length;

  const failures = results.reduce((n, r) => n + ((r as { errors?: string[] }).errors?.length ?? 0), 0);

  // Worth surfacing even though it sends nothing: an org with no won/lost
  // stage never stops following anyone up.
  const unbounded = results.filter((r) => (r as { warning?: string }).warning).length;

  const degraded = threw > 0 || refused > 0 || failures > 0;

  const detail = `${results.length} org(s), ${sent} sent` +
    (threw ? `, ${threw} org(s) failed` : "") +
    (refused ? `, ${refused} org(s) refused (read error — nothing sent)` : "") +
    (failures ? `, ${failures} lead-level failure(s)` : "") +
    (unbounded ? `, ${unbounded} org(s) have no won/lost stage` : "") +
    (cappedAt ? `, run cap reached before ${cappedAt}` : "");

  await heartbeat(degraded ? "warn" : "ok", detail);

  // A non-2xx so recent_cron_failures() sees it too. The heartbeat is the
  // primary signal; this is the second one, because the whole reason this bug
  // survived eight days is that a single channel nobody reads is the same as
  // no channel at all.
  //
  // Threshold, not any-failure: one bounced address should not red the job.
  const lost = sent === 0 && failures > 0;
  if (lost || failures > Math.max(10, sent)) {
    console.error(`nurture: ${failures} failure(s) against ${sent} send(s) — reporting the run as failed`);
    return json({ ok: false, orgs: results.length, sent, failures, results }, 500);
  }

  return json({ ok: true, orgs: results.length, sent, failures, capped_before: cappedAt, results });
});
