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
interface WebhookKey { id: string; key: string; label: string; source: string; active: boolean; created_at: string }
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
  email: { own_key: boolean; nurture_on: boolean };
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
  const [epUrl, setEpUrl] = useState("");
  const [epEvents, setEpEvents] = useState<string[]>(["lead.created"]);

  // Channels
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [waToken, setWaToken] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waNumber, setWaNumber] = useState("");
  const [waTestTo, setWaTestTo] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [emKey, setEmKey] = useState("");
  const [emTestTo, setEmTestTo] = useState("");

  const load = async () => {
    if (!org) return;
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
      if (s?.whatsapp?.display_number) setWaNumber(s.whatsapp.display_number);
    } catch {
      // Channel config is optional; a failure here must not blank the rest of
      // the screen, which is the part that always works.
      setStatus(null);
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
    const { error } = await supabase.from("api_keys")
      .update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.show("Key revoked");
    await load();
  };

  // ── Inbound capture keys ──────────────────────────────────────────────────
  const createHook = async () => {
    if (!org) return;
    if (!hookLabel.trim()) { toast.error("Name it — 'Website form', 'Facebook Ads'…"); return; }
    setBusy(true);
    const key = "wh_" + crypto.randomUUID().replace(/-/g, "");
    const { error } = await supabase.from("webhook_keys").insert({
      org_id: org.id, key, label: hookLabel.trim(), source: "website", active: true,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setHookLabel("");
    toast.show("Capture URL created");
    await load();
  };

  const toggleHook = async (h: WebhookKey) => {
    const { error } = await supabase.from("webhook_keys")
      .update({ active: !h.active }).eq("id", h.id);
    if (error) { toast.error(error.message); return; }
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

  const removeEndpoint = async (id: string, url: string) => {
    if (!confirm(`Stop sending events to ${url}?`)) return;
    const { error } = await supabase.from("webhook_endpoints").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
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
      await callFunction("save-integration", { action: "save_email", api_key: emKey });
      setEmKey("");
      toast.show("Email settings saved");
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
          {status?.whatsapp.configured
            ? "Connected. Your team can message records from the CRM, and inbound WhatsApp arrives as records."
            : "Connect Meta's WhatsApp Cloud API so your team can message records from the CRM."}
          {" "}
          <span className={status?.whatsapp.configured ? "pill pill-green" : "pill pill-muted"}>
            {status?.whatsapp.configured ? "connected" : "not connected"}
          </span>
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
          <span className={status?.telegram.configured ? "pill pill-green" : "pill pill-muted"}>
            {status?.telegram.configured ? "connected" : "not connected"}
          </span>
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
          <span className={status?.email.own_key ? "pill pill-green" : "pill pill-muted"}
                style={{ marginLeft: 8 }}>
            {status?.email.own_key ? "your own key" : "shared key"}
          </span>
        </p>

        {!status?.email.own_key && (
          <p className="sub" style={{ fontSize: 12, marginTop: 6 }}>
            You are currently sending on our shared address. That works, but your
            deliverability then depends on every other customer's sending behaviour —
            and theirs on yours. Your own Resend key isolates you from both directions.
          </p>
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
          Automatic follow-up is <b>{status?.email.nurture_on ? "on" : "off"}</b>. It sends only
          the messages you have marked as follow-up steps in <b>Templates</b> — with none
          written, nothing is sent.
        </p>
      </Card>

      {/* ── API keys ──────────────────────────────────────────────────────── */}
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

      {/* ── Inbound capture ───────────────────────────────────────────────── */}
      <Card title={`Capture URLs — send ${ui.leadNounPlural.toLowerCase()} in`}>
        <p className="sub" style={{ marginTop: -8 }}>
          Point a website form, Facebook Lead Ads, IndiaMART, or a Zapier action at one of
          these. Anything that arrives is scored, assigned and alerted like any other record.
        </p>

        <div className="row row-wrap" style={{ marginTop: 12, marginBottom: 10 }}>
          <input className="input" style={{ maxWidth: 260 }}
            placeholder="Where from? e.g. Website contact form"
            value={hookLabel} onChange={(e) => setHookLabel(e.target.value)} />
          <button className={`btn btn-primary${busy ? " btn-busy" : ""}`}
            onClick={() => void createHook()} disabled={busy}>Create capture URL</button>
        </div>

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
                <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{e.url}</div>
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
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => void copy(e.secret, "Signing secret")}>
                  Copy secret
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

      {toast.node}
    </div>
  );
}
