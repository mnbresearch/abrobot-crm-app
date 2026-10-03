import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, Empty, LoadError, Spinner, timeAgo, useToast } from "../components/ui";

/**
 * Integrations — API keys, inbound capture keys, and outbound webhooks.
 *
 * This screen is the one the Install tab has been telling customers to visit
 * ("Create a key under webhook keys first") since launch. It did not exist, so
 * every non-widget intake path — website forms, Facebook Lead Ads, IndiaMART,
 * Zapier — was unreachable, and the pricing page's "API & webhooks" line
 * described nothing at all.
 */

const API_BASE =
  (import.meta.env.VITE_SUPABASE_URL ?? "https://pomsltnrxvbcafwtbtlc.supabase.co") +
  "/functions/v1";

interface ApiKey {
  id: string; name: string; key_prefix: string; scopes: string[];
  last_used_at: string | null; use_count: number; created_at: string; expires_at: string | null;
}
interface WebhookKey {
  id: string; key: string; label: string; source: string; active: boolean; created_at: string;
  // Free-text audience. Records captured on this key inherit it, and Templates
  // can then address them with their own follow-up sequence. Deliberately not
  // `source`, which is a fixed enum shared by every tenant on the platform.
  segment: string | null;
}
interface Endpoint {
  id: string; url: string; secret: string; events: string[]; active: boolean;
  description: string | null; failure_count: number; last_status: number | null;
  last_error: string | null; last_success_at: string | null;
}

/**
 * Credential status. Booleans only — never the values.
 *
 * agent_config keeps the WhatsApp and Telegram tokens on the same row as the
 * greeting, so any read path the browser has to one is a read path to the
 * other. There is deliberately no way to display a saved token, to anyone.
 */
interface IntegrationStatus {
  whatsapp: { configured: boolean; phone_id_set: boolean; display_number: string | null; autoreply: boolean };
  telegram: { configured: boolean; chat_id_set: boolean; alerts_on: boolean };
  email: {
    own_key: boolean;
    nurture_on: boolean;
    /**
     * Not a secret — it is stamped on every message this tenant sends — so
     * unlike the keys it comes back as a value and is safe to display. It is
     * also the only way this screen can tell an admin that their key and their
     * domain disagree BEFORE a campaign reports "Sent 0 of 412".
     */
    from_address: string | null;
    reply_to: string | null;
    /** own key saved, no sending address: the combination that cannot send. */
    needs_from_address: boolean;
  };
}

const SCOPES = [
  { id: "leads:read",          label: "Read records" },
  { id: "leads:write",         label: "Create and update records" },
  { id: "stages:read",         label: "Read pipeline stages" },
  { id: "conversations:read",  label: "Read chat conversations" },
];

const EVENTS = [
  { id: "lead.created",       label: "A record is created" },
  { id: "lead.stage_changed", label: "A record moves stage" },
];

/**
 * A credential pill with three states, because there are three.
 *
 * `status` is null both before the check and after it FAILS, and every consumer
 * on this screen read null as a fact: "not connected", "shared key", follow-up
 * "off". So a dropped status call told an org with a live WhatsApp number that
 * it had none — and the remedy that screen suggests is re-entering a Meta
 * token, which overwrites a working credential with whatever the admin can find
 * in a hurry. The reasoning was already written out for `apiAccess` below; this
 * applies it to the channels too.
 */
function StatusPill({
  known, on, onLabel, offLabel,
}: {
  /** False when the status read failed or hasn't returned — then neither label is safe. */
  known: boolean;
  on: boolean;
  onLabel: string;
  offLabel: string;
}) {
  if (!known) {
    return (
      <span className="pill pill-muted" title="The status check didn't return — this is not a report that it is off.">
        couldn't check
      </span>
    );
  }
  return (
    <span className={on ? "pill pill-green" : "pill pill-muted"}>{on ? onLabel : offLabel}</span>
  );
}

// Sends the admin to the plan screen. Settings honours ?tab=, so this lands on
// Plan & usage rather than the Industry tab.
function navigateToPlan() {
  window.history.pushState({}, "", "/settings?tab=usage");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function Integrations() {
  const { org, isAdmin, ui } = useApp();
  const toast = useToast();

  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [hooks, setHooks] = useState<WebhookKey[] | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Shown once, never retrievable. Held in state only.
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>(["leads:read"]);
  const [hookLabel, setHookLabel] = useState("");
  const [hookSegment, setHookSegment] = useState("");
  const [epUrl, setEpUrl] = useState("");
  const [epEvents, setEpEvents] = useState<string[]>(["lead.created"]);

  // Channels
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  // Why the status read failed, kept so the channel cards can say "couldn't
  // check" rather than "off". Without it, null is doing two jobs at once.
  const [statusError, setStatusError] = useState<string | null>(null);
  // The API and webhooks are a Business-plan feature. The server enforces it
  // (api/index.ts returns 402), but offering a "Create key" button that always
  // fails is the kind of dead end this screen exists to remove.
  const [apiAccess, setApiAccess] = useState<boolean | null>(null);
  const [waToken, setWaToken] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waNumber, setWaNumber] = useState("");
  const [waTestTo, setWaTestTo] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [emKey, setEmKey] = useState("");
  const [emFrom, setEmFrom] = useState("");
  const [emReplyTo, setEmReplyTo] = useState("");
  const [emTestTo, setEmTestTo] = useState("");

  const load = async () => {
    // Returning here without setting these left all three null, and the render
    // below treats null as "still loading" — so the screen spun forever, because
    // `load` only re-runs when `org` changes and `org` is what is missing. Empty
    // lists instead, matching the `setLoading(false)` guard in Team.tsx,
    // Templates.tsx and Automations.tsx.
    if (!org) { setKeys([]); setHooks([]); setEndpoints([]); return; }
    const [k, w, e] = await Promise.all([
      supabase.from("api_keys").select("*").eq("org_id", org.id)
        .is("revoked_at", null).order("created_at", { ascending: false }),
      supabase.from("webhook_keys").select("*").eq("org_id", org.id)
        .order("created_at", { ascending: false }),
      supabase.from("webhook_endpoints").select("*").eq("org_id", org.id)
        .order("created_at", { ascending: false }),
    ]);
    const firstErr = k.error || w.error || e.error;
    if (firstErr) { setError(firstErr.message); return; }
    setError(null);
    setKeys((k.data as ApiKey[]) ?? []);
    setHooks((w.data as WebhookKey[]) ?? []);
    setEndpoints((e.data as Endpoint[]) ?? []);

    // Separate call: this goes through an edge function because the browser
    // must never be able to read the tokens themselves.
    try {
      const s = await callFunction<IntegrationStatus>("save-integration", { action: "status" });
      setStatus(s);
      setStatusError(null);
      if (org) {
        const { data: snap, error: snapErr } = await supabase.rpc("usage_snapshot", { p_org_id: org.id });
        // The error was dropped and `?? null` swallowed the result, so a failed
        // RPC set apiAccess to null — the same value as "we haven't checked".
        // Whichever way the UI reads null, it is asserting something about the
        // customer's entitlements that it does not actually know. Left null,
        // but said out loud, so the screen can stay non-committal rather than
        // guess in either direction.
        if (snapErr) {
          console.error("integrations: plan entitlements unavailable —", snapErr.message);
          toast.error(`Couldn't check what your plan includes (${snapErr.message}) — API access is shown as unconfirmed below.`);
          setApiAccess(null);
        } else {
          setApiAccess((snap as { api_access?: boolean } | null)?.api_access ?? null);
        }
      }
      if (s?.whatsapp?.display_number) setWaNumber(s.whatsapp.display_number);
      // Same treatment as the WhatsApp display number: these are values, not
      // credentials, so the form shows what is actually saved rather than an
      // empty box that reads as "not set".
      if (s?.email?.from_address) setEmFrom(s.email.from_address);
      if (s?.email?.reply_to) setEmReplyTo(s.email.reply_to);
    } catch (e) {
      // Channel config is optional; a failure here must not blank the rest of
      // the screen, which is the part that always works.
      setStatus(null);
      // But it must not read as "nothing is connected" either. Every pill below
      // branches on `statusKnown`, so the cards say "couldn't check" instead of
      // asserting a disconnection that would invite an admin to re-enter tokens
      // over working ones.
      setStatusError((e as Error).message || "status check failed");
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [org]);

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast.show(`${what} copied`); }
    catch { toast.error("Couldn't copy — select and copy manually"); }
  };

  // ── API keys ──────────────────────────────────────────────────────────────
  const createKey = async () => {
    if (!keyName.trim()) { toast.error("Give the key a name"); return; }
    if (!keyScopes.length) { toast.error("Pick at least one permission"); return; }
    setBusy(true);
    const { data, error } = await supabase.rpc("create_api_key", {
      p_name: keyName.trim(), p_scopes: keyScopes, p_expires_days: null,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    const res = data as { key?: string };
    if (res?.key) setFreshKey(res.key);
    setKeyName("");
    await load();
  };

  const revokeKey = async (id: string, name: string) => {
    if (!confirm(`Revoke "${name}"? Anything using this key stops working immediately.`)) return;
    // `.select("id")` so a refusal is distinguishable from success. PostgREST
    // answers an UPDATE whose WHERE matches no VISIBLE row with 204 and
    // error: null — identical to a real revoke. "Key revoked" over a key that is
    // still live is the worst lie this screen can tell: the admin stops looking
    // for the thing that is reading their whole database.
    const { data, error } = await supabase.from("api_keys")
      .update({ revoked_at: new Date().toISOString() }).eq("id", id).select("id");
    if (error) { toast.error(error.message); return; }
    if (!data?.length) {
      await load();
      toast.error(`"${name}" was NOT revoked — it may still be working. You no longer have permission to revoke it, or it is already gone.`);
      return;
    }
    toast.show("Key revoked");
    await load();
  };

  // ── Inbound capture keys ──────────────────────────────────────────────────
  const createHook = async () => {
    if (!org) return;
    if (!hookLabel.trim()) { toast.error("Name it — 'Website form', 'Facebook Ads'…"); return; }
    setBusy(true);
    const key = "wh_" + crypto.randomUUID().replace(/-/g, "");
    // Normalised to a slug. The value is matched exactly against a template's
    // audience, so "CRM Website" and "crm website" being different audiences —
    // with the difference invisible on screen — is a trap not worth leaving out.
    const segment = hookSegment.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40) || null;
    const { error } = await supabase.from("webhook_keys").insert({
      org_id: org.id, key, label: hookLabel.trim(), source: "website", active: true, segment,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setHookLabel("");
    setHookSegment("");
    toast.show("Capture URL created");
    await load();
  };

  const toggleHook = async (h: WebhookKey) => {
    // Same as revokeKey: no visible row means 204 with error: null, so pausing a
    // capture URL appeared to work while the URL kept accepting leads — or, the
    // other way round, a URL the user believed they had re-enabled stayed off and
    // every form submission went nowhere.
    const { data, error } = await supabase.from("webhook_keys")
      .update({ active: !h.active }).eq("id", h.id).select("id");
    if (error) { toast.error(error.message); return; }
    if (!data?.length) {
      await load();
      toast.error(`"${h.label}" was not changed — it is no longer there, or you no longer have permission to change it.`);
      return;
    }
    await load();
  };

  // ── Outbound endpoints ────────────────────────────────────────────────────
  const addEndpoint = async () => {
    if (!org) return;
    let u: URL;
    try { u = new URL(epUrl.trim()); } catch { toast.error("That isn't a valid URL"); return; }
    if (u.protocol !== "https:") { toast.error("The URL must be https"); return; }
    if (!epEvents.length) { toast.error("Pick at least one event"); return; }
    setBusy(true);
    const { error } = await supabase.from("webhook_endpoints").insert({
      org_id: org.id, url: u.toString(), events: epEvents, active: true,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setEpUrl("");
    toast.show("Endpoint added");
    await load();
  };

  // Outbound endpoints could be added and removed but never paused or resumed,
  // while the reconciler was free to disable one on its own. That combination
  // made auto-disable a one-way door: the endpoint stopped receiving events,
  // the row still said nothing about it, and the only route back was deleting
  // and re-adding — which issues a new signing secret the customer then has to
  // redeploy. Resuming also clears the failure counter, because otherwise the
  // endpoint returns already 19 failures deep and the next slow reply kills it
  // again immediately.
  const toggleEndpoint = async (e: Endpoint) => {
    // Same as the two above: 204 with error: null when no visible row matched, so
    // "Endpoint resumed" was said over an endpoint that is still disabled — which
    // sends the customer off to debug their own receiver for events that were
    // never going to be sent.
    const { data, error } = await supabase.from("webhook_endpoints")
      .update({ active: !e.active, failure_count: 0, last_error: null })
      .eq("id", e.id)
      .select("id");
    if (error) { toast.error(error.message); return; }
    if (!data?.length) {
      await load();
      toast.error("The endpoint was not changed — it is no longer there, or you no longer have permission to change it.");
      return;
    }
    toast.show(e.active ? "Endpoint paused" : "Endpoint resumed");
    await load();
  };

  const removeEndpoint = async (id: string, url: string) => {
    if (!confirm(`Stop sending events to ${url}?`)) return;
    // A DELETE matching no visible row is also a 204 with error: null, so
    // "Endpoint removed" was printed over an endpoint that is still being sent
    // every lead — and the reload then put it back in the list.
    const { data, error } = await supabase.from("webhook_endpoints").delete().eq("id", id).select("id");
    if (error) { toast.error(error.message); return; }
    if (!data?.length) {
      await load();
      toast.error(`${url} was NOT removed — it may still be receiving events. It is already gone, or you no longer have permission to remove it.`);
      return;
    }
    toast.show("Endpoint removed");
    await load();
  };

  // ── Channels ──────────────────────────────────────────────────────────────
  const saveWhatsApp = async () => {
    setBusy(true);
    try {
      await callFunction("save-integration", {
        action: "save_whatsapp",
        token: waToken, phone_id: waPhoneId, display_number: waNumber,
      });
      setWaToken("");   // never keep a token in component state after saving
      toast.show("WhatsApp settings saved");
      await load();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  const testWhatsApp = async () => {
    if (!waTestTo.trim()) { toast.error("Enter a number to test with"); return; }
    setBusy(true);
    try {
      const r = await callFunction<{ ok: boolean; error?: string; meta_code?: number }>(
        "save-integration", { action: "test_whatsapp", to: waTestTo.trim() });
      if (r.ok) toast.show("Sent — check WhatsApp on that number");
      else toast.error(r.meta_code ? `${r.error} (Meta code ${r.meta_code})` : r.error ?? "Failed");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  const saveTelegram = async () => {
    setBusy(true);
    try {
      await callFunction("save-integration", {
        action: "save_telegram", bot_token: tgToken, chat_id: tgChat, notify: true,
      });
      setTgToken("");
      toast.show("Telegram settings saved");
      await load();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  const testTelegram = async () => {
    setBusy(true);
    try {
      const r = await callFunction<{ ok: boolean; error?: string }>(
        "save-integration", { action: "test_telegram" });
      if (r.ok) toast.show("Sent — check your Telegram");
      else toast.error(r.error ?? "Failed");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  const saveEmail = async () => {
    setBusy(true);
    try {
      // save_email reads api_key, from_address and reply_to. For all three an
      // empty string means "leave what is stored alone" and the literal "-"
      // clears it, so sending the trimmed values is safe: an admin changing
      // only their sending address does not have to re-paste a key they no
      // longer have.
      const r = await callFunction<{ ok: boolean; warning?: string }>(
        "save-integration",
        {
          action: "save_email",
          api_key: emKey,
          from_address: emFrom.trim(),
          reply_to: emReplyTo.trim(),
        },
      );
      setEmKey("");
      // The warning is the whole point of the save returning anything: it means
      // the save SUCCEEDED and the result cannot send. "Email settings saved"
      // on its own is true and useless.
      if (r?.warning) toast.error(r.warning);
      else toast.show("Email settings saved");
      await load();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  const testEmail = async () => {
    setBusy(true);
    try {
      const r = await callFunction<{ ok: boolean; error?: string; using?: string }>(
        "save-integration", { action: "test_email", to: emTestTo });
      if (r.ok) toast.show(`Sent to ${emTestTo} using ${r.using ?? "the configured key"}`);
      else toast.error(r.error ?? "Failed");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };

  if (!isAdmin) {
    return (
      <Card>
        <Empty icon="🔒" title="Admins only"
          hint="API keys can read your whole database, so only admins can manage them." />
      </Card>
    );
  }
  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!keys || !hooks || !endpoints) return <Spinner />;

  const captureUrl = (k: string) => `${API_BASE}/lead-webhook?key=${k}`;

  // The single question every channel card below has to answer honestly: did we
  // actually get an answer from save-integration? `status` being null is not an
  // answer, and each `status?.x` read silently treated it as one.
  // Three states, not two.
  //
  // `status !== null` alone conflated "the check FAILED" with "the check has
  // not come back yet" — and those are not simultaneous. The spinner above
  // clears as soon as the three table reads land, while the status call is a
  // separate round trip to an edge function that may be cold-starting. So on
  // every single page load this rendered "We couldn't read your WhatsApp
  // settings — reload before changing anything" for a second or two, on a
  // screen whose whole job this session was to stop saying things it does not
  // know. Fixing null-means-two-things by introducing a different
  // null-means-two-things would have been a poor trade.
  //
  // `statusError` is set only in the catch, so it distinguishes the two
  // precisely: not loaded yet → say nothing; failed → say we could not check.
  const statusSettled = status !== null || statusError !== null;
  const statusKnown = status !== null;

  return (
    <div className="stack">
      <div>
        <h1>Integrations</h1>
        <p className="sub" style={{ marginTop: 2 }}>
          Connect {org?.name ?? "your CRM"} to anything else you use.
        </p>
      </div>

      {/* The key is shown exactly once. Make that impossible to miss. */}
      {freshKey && (
        <Card>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Copy this key now</div>
          <p className="sub" style={{ marginTop: 0 }}>
            This is the only time it will ever be shown. We store a one-way hash, so
            we genuinely cannot recover it for you — if it's lost, revoke and make another.
          </p>
          <div className="code" style={{ wordBreak: "break-all", marginTop: 10 }}>{freshKey}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => void copy(freshKey, "API key")}>
              Copy key
            </button>
            <button className="btn" onClick={() => setFreshKey(null)}>I've saved it</button>
          </div>
        </Card>
      )}

      {/* ── Channels ──────────────────────────────────────────────────────── */}
      <Card title="WhatsApp">
        <p className="sub" style={{ marginTop: -8 }}>
          {/* Three branches, because "we couldn't ask" must not be phrased as an
              instruction to connect something that may already be connected —
              saving a token over a live one is how a working number breaks. */}
          {statusSettled && !statusKnown
            ? `We couldn't read your WhatsApp settings${statusError ? ` (${statusError})` : ""}, so this card can't tell you whether it's connected. Reload before changing anything — saving a token here replaces whatever is already saved.`
            : status?.whatsapp.configured
              ? "Connected. Your team can message records from the CRM, and inbound WhatsApp arrives as records."
              : "Connect Meta's WhatsApp Cloud API so your team can message records from the CRM."}
          {" "}
          <StatusPill
            known={statusKnown}
            on={!!status?.whatsapp.configured}
            onLabel="connected"
            offLabel="not connected"
          />
        </p>

        <div className="field">
          <label className="label" htmlFor="wa-phone-id">Phone Number ID</label>
          <input id="wa-phone-id" className="input" value={waPhoneId}
            onChange={(e) => setWaPhoneId(e.target.value)}
            placeholder={status?.whatsapp.phone_id_set ? "•••••• (saved — type to replace)" : "e.g. 123456789012345"} />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Meta Business → WhatsApp → API Setup. It's the long number under your test
            or live phone number, not the phone number itself.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="wa-token">Access token</label>
          <input id="wa-token" className="input" type="password" value={waToken}
            onChange={(e) => setWaToken(e.target.value)}
            placeholder={status?.whatsapp.configured ? "•••••• (saved — leave blank to keep)" : "EAAG..."} />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Once saved it can never be displayed again — not here, not anywhere. Leave
            blank to keep the current one. Use a <b>permanent</b> System User token;
            the 24-hour test token will stop working tomorrow.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="wa-number">Display number (optional)</label>
          <input id="wa-number" className="input" value={waNumber}
            onChange={(e) => setWaNumber(e.target.value)} placeholder="+91 98765 43210" />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Shown in your chat widget so visitors can reach you directly.
          </p>
        </div>

        <div className="row row-wrap">
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void saveWhatsApp()} disabled={busy}>Save WhatsApp</button>
          <input className="input" style={{ maxWidth: 190 }} value={waTestTo}
            onChange={(e) => setWaTestTo(e.target.value)} placeholder="Test to +91…" />
          <button className="btn" onClick={() => void testWhatsApp()} disabled={busy}>
            Send test
          </button>
        </div>
        <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
          Meta only allows free-form messages within 24 hours of the customer's last
          message. Outside that window you need an approved template — we pass Meta's
          error straight through rather than pretending it sent.
        </p>
      </Card>

      <Card title="Telegram alerts">
        <p className="sub" style={{ marginTop: -8 }}>
          A ping the moment a record arrives.{" "}
          <StatusPill
            known={statusKnown}
            on={!!status?.telegram.configured}
            onLabel="connected"
            offLabel="not connected"
          />
        </p>

        <div className="field">
          <label className="label" htmlFor="tg-token">Bot token (optional)</label>
          <input id="tg-token" className="input" type="password" value={tgToken}
            onChange={(e) => setTgToken(e.target.value)}
            placeholder={status?.telegram.configured ? "•••••• (saved)" : "Leave blank to use ours"} />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Blank uses the AbroBot bot — fine for most people. Supply your own from
            @BotFather if you want alerts to come from your own brand.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="tg-chat">Chat ID</label>
          <input id="tg-chat" className="input" value={tgChat}
            onChange={(e) => setTgChat(e.target.value)}
            placeholder={status?.telegram.chat_id_set ? "•••••• (saved — type to replace)" : "e.g. -1001234567890"} />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Message <b>@userinfobot</b> on Telegram and it replies with your ID. For a
            group, add the bot to the group first — group IDs start with a minus sign.
            This is required; there is no sensible default for "where do your alerts go".
          </p>
        </div>

        <div className="row">
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void saveTelegram()} disabled={busy}>Save Telegram</button>
          <button className="btn" onClick={() => void testTelegram()} disabled={busy}>
            Send test alert
          </button>
        </div>
      </Card>

      {/* ── Email ─────────────────────────────────────────────────────────── */}
      <Card title="Email">
        <p className="sub" style={{ marginTop: -8 }}>
          Used when you send from a record, send a template to an audience, and for
          automatic follow-up.
          <span style={{ marginLeft: 8 }}>
            <StatusPill
              known={statusKnown}
              on={!!status?.email.own_key}
              onLabel="your own key"
              offLabel="shared key"
            />
          </span>
        </p>

        {/* Only claim they are on the shared address if we know they are. This
            paragraph reads as a deliverability warning about their current
            setup; off a failed status read it was a warning about nothing. */}
        {statusKnown && !status?.email.own_key && (
          <p className="sub" style={{ fontSize: 12, marginTop: 6 }}>
            You are currently sending on our shared address. That works, but your
            deliverability then depends on every other customer's sending behaviour —
            and theirs on yours. Your own Resend key isolates you from both directions.
          </p>
        )}

        {statusSettled && !statusKnown && (
          <p className="sub" style={{ fontSize: 12, marginTop: 6 }}>
            We couldn't read your email settings, so this card can't say whether you're on
            your own Resend key or the shared address. Reload before saving — pasting a key
            here replaces a saved one.
          </p>
        )}

        {/* The one combination that silently sends nothing. Saving a key with no
            sending address used to be accepted, confirmed, and then fail on
            every message — the sender kept using OUR address, which the
            tenant's own Resend account has never verified, so Resend rejected
            it. This says so on the card rather than leaving it to be discovered
            as a 100% failure rate on a campaign. */}
        {statusKnown && status?.email.needs_from_address && (
          <div
            className="card"
            style={{ marginTop: 12, padding: 12, background: "var(--bg)", borderColor: "var(--amber)" }}
          >
            {/* Describes what actually happens. An earlier draft refused to
                send in this state and this copy was written for that; the
                refusal was dropped because it would have stopped follow-up for
                every tenant with their own key. Telling someone "nothing will
                go out" while mail is going out is the worse of the two errors. */}
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              ⚠️ Your key is saved, but no sending address is set
            </div>
            <p className="sub" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.8 }}>
              Mail still goes out — on your key, from our shared address. Your Resend account
              has not verified our domain, so Resend may reject those messages before they reach
              anyone. Set a sending address on a domain <b>you</b> have verified in Resend and
              they will go out under your own name instead.
            </p>
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="em-key">Resend API key</label>
          <input id="em-key" className="input" type="password" autoComplete="off" value={emKey}
            onChange={(e) => setEmKey(e.target.value)}
            placeholder={status?.email.own_key ? "•••••• (saved — leave blank to keep)" : "re_..."} />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Free at <b>resend.com</b> — 3,000 emails a month. Paste <b>-</b> to remove a saved
            key and go back to the shared one. Like every credential here, this can never be
            displayed again once saved.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="em-from">Sending address</label>
          <input id="em-from" className="input" type="email" autoComplete="off" value={emFrom}
            onChange={(e) => setEmFrom(e.target.value)} placeholder="hello@yourdomain.com" />
          <p className="sub" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.8 }}>
            Required <b>only</b> if you use your own Resend key above — and then it is genuinely
            required. It must be on a domain you have verified inside your own Resend account,
            because that account has not verified ours and will reject anything sent from it.
            Leave blank to keep what is saved; paste <b>-</b> to clear it.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="em-reply">Reply-to address (optional)</label>
          <input id="em-reply" className="input" type="email" autoComplete="off" value={emReplyTo}
            onChange={(e) => setEmReplyTo(e.target.value)} placeholder="sales@yourdomain.com" />
          <p className="sub" style={{ fontSize: 12, marginTop: 4 }}>
            Where replies land if that differs from the sending address — a shared inbox, for
            example. Paste <b>-</b> to clear it.
          </p>
        </div>

        <div className="field">
          <label className="label" htmlFor="em-test">Send a test to</label>
          <input id="em-test" className="input" value={emTestTo}
            onChange={(e) => setEmTestTo(e.target.value)} placeholder="you@example.com" />
        </div>

        <div className="row">
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void saveEmail()} disabled={busy}>Save email settings</button>
          <button className="btn" onClick={() => void testEmail()} disabled={busy || !emTestTo.trim()}>
            Send test email
          </button>
        </div>

        <p className="sub" style={{ fontSize: 12, marginTop: 10 }}>
          {/* "off" was printed for an unread status too — which tells an org
              whose sequence IS running that nothing is going out, the opposite
              of the truth and the one thing they'd check here. */}
          Automatic follow-up is{" "}
          <b>{!statusSettled ? "loading" : !statusKnown ? "not something we could check just now" : status?.email.nurture_on ? "on" : "off"}</b>. It sends only
          the messages you have marked as follow-up steps in <b>Templates</b> — with none
          written, nothing is sent.
        </p>
      </Card>

      {/* ── API keys ──────────────────────────────────────────────────────── */}
      {/* The server returns 402 for a key on a plan without API access, so
          offering the button anyway would be a dead end — the exact thing this
          screen was built to remove. Say what it costs instead. */}
      {apiAccess === false && (
        <Card title="API keys & webhooks">
          <p className="sub" style={{ marginTop: -8 }}>
            Included on the <b>Business</b> plan and above. The REST API lets your own systems read
            and push records; outbound webhooks tell you the moment anything changes.
          </p>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={navigateToPlan}>
            See plans →
          </button>
        </Card>
      )}

      {apiAccess !== false && (
      <Card title="API keys">
        <p className="sub" style={{ marginTop: -8 }}>
          For reading and writing records from your own systems. Base URL{" "}
          <code>{API_BASE}/api/v1</code>
        </p>

        <div className="row row-wrap" style={{ marginTop: 12, marginBottom: 6 }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="What is it for? e.g. Zapier"
            value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void createKey()} disabled={busy}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
        <div className="row row-wrap" style={{ gap: 14, marginBottom: 14 }}>
          {SCOPES.map((s) => (
            <label key={s.id} className="row" style={{ cursor: "pointer", gap: 6 }}>
              <input type="checkbox" checked={keyScopes.includes(s.id)}
                onChange={(e) => setKeyScopes(e.target.checked
                  ? [...keyScopes, s.id] : keyScopes.filter((x) => x !== s.id))} />
              <span style={{ fontSize: 13 }}>{s.label}</span>
            </label>
          ))}
        </div>

        {keys.length === 0 ? (
          <Empty icon="🔑" title="No API keys yet"
            hint="Create one to pull your records into a spreadsheet, a dashboard, or another system." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Key</th><th>Can do</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td style={{ fontWeight: 600 }}>{k.name}</td>
                    <td><code style={{ fontSize: 12 }}>{k.key_prefix}…</code></td>
                    <td className="sub" style={{ fontSize: 12 }}>
                      {k.scopes.map((s) => SCOPES.find((x) => x.id === s)?.label ?? s).join(", ")}
                    </td>
                    <td className="sub" style={{ fontSize: 12 }}>
                      {k.last_used_at ? `${timeAgo(k.last_used_at)} · ${k.use_count} calls` : "never"}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-danger"
                        onClick={() => void revokeKey(k.id, k.name)}>Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      )}

      {/* ── Inbound capture ───────────────────────────────────────────────── */}
      <Card title={`Capture URLs — send ${ui.leadNounPlural.toLowerCase()} in`}>
        <p className="sub" style={{ marginTop: -8 }}>
          Point a website form, Facebook Lead Ads, IndiaMART, or a Zapier action at one of
          these. Anything that arrives is scored, assigned and alerted like any other record.
        </p>

        <div className="row row-wrap" style={{ marginTop: 12, marginBottom: 6 }}>
          <input className="input" style={{ maxWidth: 260 }}
            placeholder="Where from? e.g. Website contact form"
            value={hookLabel} onChange={(e) => setHookLabel(e.target.value)} />
          <input className="input" style={{ maxWidth: 200 }}
            placeholder="Audience (optional)"
            value={hookSegment} onChange={(e) => setHookSegment(e.target.value)} />
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void createHook()} disabled={busy}>Create capture URL</button>
        </div>
        <p className="sub" style={{ fontSize: 12, marginBottom: 12 }}>
          <b>Audience</b> is optional and only affects automatic follow-up. Give one, and you can
          write a follow-up sequence in <b>Templates</b> just for the {ui.leadNounPlural.toLowerCase()}{" "}
          that arrive here — useful when one form asks about a different product than another.
          Leave it blank and they join your normal sequence.
        </p>

        {hooks.length === 0 ? (
          <Empty icon="📥" title="No capture URLs yet"
            hint="The chat widget works without one. You need a URL here for forms and ad platforms." />
        ) : hooks.map((h) => (
          <div key={h.id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ fontWeight: 600 }}>
                {h.label}{" "}
                <span className={h.active ? "pill pill-green" : "pill pill-muted"}>
                  {h.active ? "active" : "paused"}
                </span>
                {h.segment && <span className="pill pill-muted" style={{ marginLeft: 5 }}>🎯 {h.segment}</span>}
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => void copy(captureUrl(h.key), "URL")}>Copy</button>
                <button className="btn btn-sm" onClick={() => void toggleHook(h)}>
                  {h.active ? "Pause" : "Resume"}
                </button>
              </div>
            </div>
            <div className="code" style={{ marginTop: 6, fontSize: 11.5, wordBreak: "break-all" }}>
              {captureUrl(h.key)}
            </div>
          </div>
        ))}

        <p className="sub" style={{ fontSize: 12, marginTop: 12 }}>
          POST JSON with any of <code>name</code>, <code>email</code>, <code>phone</code>,{" "}
          <code>message</code>. WhatsApp Cloud API and Twilio payloads are recognised
          automatically. Treat the URL as a password — anyone holding it can add records.
        </p>
      </Card>

      {/* ── Outbound ──────────────────────────────────────────────────────── */}
      {apiAccess !== false && (
      <Card title="Outbound webhooks — get notified when things happen">
        <p className="sub" style={{ marginTop: -8 }}>
          We POST to your URL when a record is created or moves stage, so your own systems
          can react. Every request is signed, so you can verify it came from us.
        </p>

        <div className="row row-wrap" style={{ marginTop: 12, marginBottom: 8 }}>
          <input className="input" style={{ maxWidth: 320 }} type="url"
            placeholder="https://yoursystem.com/hooks/abrobot"
            value={epUrl} onChange={(e) => setEpUrl(e.target.value)} />
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void addEndpoint()} disabled={busy}>Add endpoint</button>
        </div>
        <div className="row row-wrap" style={{ gap: 14, marginBottom: 14 }}>
          {EVENTS.map((ev) => (
            <label key={ev.id} className="row" style={{ cursor: "pointer", gap: 6 }}>
              <input type="checkbox" checked={epEvents.includes(ev.id)}
                onChange={(e) => setEpEvents(e.target.checked
                  ? [...epEvents, ev.id] : epEvents.filter((x) => x !== ev.id))} />
              <span style={{ fontSize: 13 }}>{ev.label}</span>
            </label>
          ))}
        </div>

        {endpoints.length === 0 ? (
          <Empty icon="📡" title="No endpoints yet"
            hint="Add one to push records into your own database, Slack, or another tool the moment they arrive." />
        ) : endpoints.map((e) => (
          <div key={e.id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, wordBreak: "break-all" }}>
                  {e.url}{" "}
                  {/* There was no badge here at all, so an endpoint that had
                      been switched off automatically looked identical to one
                      that was working. */}
                  <span className={e.active ? "pill pill-green" : "pill pill-muted"}>
                    {e.active ? "active" : "paused"}
                  </span>
                </div>
                <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                  {e.events.join(", ")}
                  {e.last_success_at && ` · last delivered ${timeAgo(e.last_success_at)}`}
                  {e.failure_count > 0 && (
                    <span style={{ color: "var(--red)" }}>
                      {" "}· {e.failure_count} recent failure{e.failure_count === 1 ? "" : "s"}
                      {e.last_error ? ` (${e.last_error.slice(0, 60)})` : ""}
                    </span>
                  )}
                </div>
                {!e.active && (
                  <div className="sub" style={{ fontSize: 12, marginTop: 4, color: "var(--amber)" }}>
                    Paused — we aren't sending events here. Resume once your endpoint is answering.
                  </div>
                )}
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => void copy(e.secret, "Signing secret")}>
                  Copy secret
                </button>
                <button className="btn btn-sm" onClick={() => void toggleEndpoint(e)}>
                  {e.active ? "Pause" : "Resume"}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => void removeEndpoint(e.id, e.url)}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}

        <p className="sub" style={{ fontSize: 12, marginTop: 12, lineHeight: 1.8 }}>
          Verify a delivery by computing <code>HMAC-SHA256(rawBody, yourSecret)</code> and
          comparing it to the <code>X-AbroBot-Signature</code> header (format{" "}
          <code>sha256=…</code>). Compare in constant time. If it doesn't match, reject it —
          the signature is the only thing distinguishing us from anyone who guessed your URL.
        </p>
      </Card>
      )}

      {toast.node}
    </div>
  );
}
