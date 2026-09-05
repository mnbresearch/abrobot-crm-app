import { useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, Empty, Modal, Spinner, useToast } from "../components/ui";

// Templates, and the two things that make them more than a notepad:
//
//  1. **Send.** Until now nothing in the product could send an email. The
//     send-campaign edge function existed, was correctly authenticated, and had
//     zero callers — so the merge tokens documented right here were substituted
//     by no code path anywhere. This screen is where that gets wired up.
//
//  2. **Follow-up steps.** An email template can be marked as step 1, 2 or 3 of
//     the automatic follow-up sequence. Previously that sequence was three
//     study-abroad emails compiled into the nurture function, signed AbroBot,
//     sent for whichever tenant cron happened to run. Now it is content each
//     business writes for itself — and a business that writes none sends none.

interface Template {
  id: string;
  org_id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  nurture_step: number | null;
  created_at: string;
}

const TOKENS = ["{{first_name}}", "{{name}}", "{{country}}", "{{course}}", "{{brand}}"];

// Hours after the previous message, matching GAP_HOURS in the nurture function.
const STEP_TIMING = ["about an hour after the record is created", "3 days later", "4 days after that"];

export function Templates() {
  const { org, ui, isAdmin, stages } = useApp();
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const [nurtureOn, setNurtureOn] = useState<boolean | null>(null);
  const [sending, setSending] = useState<Template | null>(null);
  const toast = useToast();

  const load = async () => {
    if (!org) return;
    const [tpl, cfg] = await Promise.all([
      supabase.from("message_templates").select("*").eq("org_id", org.id).order("created_at"),
      supabase.from("agent_config").select("nurture_enabled").eq("org_id", org.id).maybeSingle(),
    ]);
    setRows((tpl.data as Template[]) ?? []);
    setNurtureOn(cfg.data?.nurture_enabled ?? false);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [org]);

  const sequence = useMemo(
    () => rows.filter((r) => r.nurture_step !== null).sort((a, b) => a.nurture_step! - b.nurture_step!),
    [rows],
  );

  const save = async () => {
    if (!org || !editing) return;
    if (!editing.name?.trim() || !editing.body?.trim()) { toast.error("Name and message are required"); return; }

    // A WhatsApp template cannot be a step in an email sequence. Silently
    // storing one would produce a follow-up step the engine skips forever,
    // which looks like the sequence is running when it is not.
    const step = editing.channel === "whatsapp" ? null : (editing.nurture_step ?? null);

    const payload = {
      org_id: org.id,
      name: editing.name.trim(),
      channel: editing.channel ?? "email",
      subject: editing.subject?.trim() || null,
      body: editing.body,
      nurture_step: step,
    };
    const { error } = editing.id
      ? await supabase.from("message_templates").update(payload).eq("id", editing.id)
      : await supabase.from("message_templates").insert(payload);
    if (error) {
      // The unique index on (org_id, nurture_step) is the likeliest failure,
      // and "duplicate key value violates..." tells a business owner nothing.
      toast.error(
        /message_templates_org_nurture_step/.test(error.message)
          ? "Another template is already that follow-up step. Change one of them first."
          : error.message,
      );
      return;
    }
    setEditing(null);
    await load();
    toast.show("Template saved");
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("message_templates").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await load();
    toast.show("Deleted");
  };

  if (loading) return <Spinner />;

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>Templates</h1>
          <p className="sub" style={{ marginTop: 2 }}>Reusable messages for email and WhatsApp</p>
        </div>
        <div className="spacer" />
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setEditing({ channel: "email", body: "" })}>
            + New template
          </button>
        )}
      </div>

      {/* The follow-up sequence, stated plainly, because "automatic email is
          switched on" and "automatic email will actually send" were different
          things and nothing on screen said so. */}
      <Card title={<h2>Automatic follow-up</h2>}>
        {nurtureOn === false ? (
          <p className="sub">
            Off. Nothing is emailed automatically. Turn it on in <b>Settings → AI Agent</b> once you
            have written the messages below.
          </p>
        ) : sequence.length === 0 ? (
          <p className="sub">
            Switched on, but <b>no follow-up messages are written yet, so nothing is being sent.</b>{" "}
            Mark an email template as step 1 to start the sequence.
          </p>
        ) : (
          <>
            <p className="sub" style={{ marginBottom: 8 }}>
              {sequence.length} message{sequence.length > 1 ? "s" : ""}, sent automatically to any{" "}
              {ui.leadNoun.toLowerCase()} with an email address who has not reached a won or lost stage,
              until they reply or unsubscribe.
            </p>
            <ol className="sub" style={{ margin: 0, paddingLeft: 20 }}>
              {sequence.map((t) => (
                <li key={t.id} style={{ marginBottom: 3 }}>
                  <b>{t.name}</b> — {STEP_TIMING[t.nurture_step!] ?? "later"}
                </li>
              ))}
            </ol>
          </>
        )}
      </Card>

      {rows.length === 0 ? (
        <Card>
          <Empty
            icon="📄"
            title="No templates yet"
            hint={`Write the messages your team sends most — first response, follow-up, ${ui.leadNoun.toLowerCase()} re-engagement.`}
          />
        </Card>
      ) : (
        <div className="grid grid-2">
          {rows.map((t) => (
            <Card
              key={t.id}
              title={
                <div>
                  <h2>{t.name}</h2>
                  <div className="row-wrap" style={{ marginTop: 4, gap: 5 }}>
                    <span className="pill pill-muted">
                      {t.channel === "whatsapp" ? "💬 WhatsApp" : "✉️ Email"}
                    </span>
                    {t.nurture_step !== null && (
                      <span className="pill">🔁 Follow-up step {t.nurture_step + 1}</span>
                    )}
                  </div>
                </div>
              }
              action={
                isAdmin && (
                  <div className="row">
                    {t.channel !== "whatsapp" && (
                      <button className="btn btn-sm" onClick={() => setSending(t)}>✉️ Send</button>
                    )}
                    <button className="btn btn-sm" onClick={() => setEditing(t)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => void remove(t.id)}>🗑</button>
                  </div>
                )
              }
            >
              {t.subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.subject}</div>}
              <div className="sub" style={{ whiteSpace: "pre-wrap", maxHeight: 150, overflow: "hidden" }}>{t.body}</div>
            </Card>
          ))}
        </div>
      )}

      {sending && <SendModal template={sending} stages={stages} onClose={() => setSending(null)} toast={toast} />}

      {editing && (
        <Modal title={editing.id ? "Edit template" : "New template"} onClose={() => setEditing(null)} wide>
          <div className="field">
            <label className="label">Name</label>
            <input
              className="input"
              value={editing.name ?? ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="First response"
              autoFocus
            />
          </div>
          <div className="field">
            <label className="label">Channel</label>
            <select
              className="select"
              value={editing.channel ?? "email"}
              onChange={(e) => setEditing({ ...editing, channel: e.target.value })}
            >
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </div>
          {editing.channel !== "whatsapp" && (
            <>
              <div className="field">
                <label className="label">Subject</label>
                <input
                  className="input"
                  value={editing.subject ?? ""}
                  onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">Use in automatic follow-up</label>
                <select
                  className="select"
                  value={editing.nurture_step === null || editing.nurture_step === undefined ? "" : String(editing.nurture_step)}
                  onChange={(e) =>
                    setEditing({ ...editing, nurture_step: e.target.value === "" ? null : Number(e.target.value) })}
                >
                  <option value="">No — I send this by hand</option>
                  <option value="0">Step 1 — {STEP_TIMING[0]}</option>
                  <option value="1">Step 2 — {STEP_TIMING[1]}</option>
                  <option value="2">Step 3 — {STEP_TIMING[2]}</option>
                </select>
                <p className="sub" style={{ fontSize: 12, marginTop: 5 }}>
                  Steps are sent automatically, in order, and stop as soon as someone reaches a won or
                  lost stage or unsubscribes.
                </p>
              </div>
            </>
          )}
          <div className="field">
            <label className="label">Message</label>
            <textarea
              className="textarea"
              style={{ minHeight: 170 }}
              value={editing.body ?? ""}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            />
            <div className="row-wrap" style={{ marginTop: 7 }}>
              {TOKENS.map((tk) => (
                <button
                  key={tk}
                  type="button"
                  className="pill pill-muted"
                  style={{ border: "none", cursor: "pointer" }}
                  onClick={() => setEditing({ ...editing, body: (editing.body ?? "") + tk })}
                >
                  {tk}
                </button>
              ))}
            </div>
            <p className="sub" style={{ fontSize: 12, marginTop: 5 }}>
              Click a token to insert it. It's replaced with the record's details when the message is
              sent. A token we don't recognise is left as-is rather than blanked, so a typo is visible
              rather than silently deleting half a sentence.
            </p>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </div>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}

// ── Send ────────────────────────────────────────────────────────────────────
// Two-step by design. Sending a few hundred emails is not undoable, and the
// one number that matters — how many people this reaches — is the number the
// composer never showed. So: pick an audience, see the count, then send.
function SendModal({
  template, stages, onClose, toast,
}: {
  template: Template;
  stages: { key: string; label: string }[];
  onClose: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [stageKey, setStageKey] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");

  const audience = () => ({ stage_key: stageKey || undefined, onlyMine: onlyMine || undefined });

  // Any change to the audience invalidates a count the person may be looking
  // at. Sending against a stale count is how "it went to 12 people" becomes
  // "it went to 1,200".
  const changeStage = (v: string) => { setStageKey(v); setCount(null); };
  const changeMine = (v: boolean) => { setOnlyMine(v); setCount(null); };

  const check = async () => {
    setBusy(true);
    try {
      const r = await callFunction<{ matched: number; capped: boolean; remaining: number | null }>(
        "send-campaign", {
          subject: template.subject || template.name,
          body: template.body,
          audience: audience(),
          count_only: true,
        });
      setCount(r.matched);
      setRemaining(r.remaining);
      if (r.capped) toast.error("More than 2,000 match — only the first 2,000 would be sent.");
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const sendTest = async () => {
    if (!testTo.trim()) { toast.error("Enter an address for the test"); return; }
    setBusy(true);
    try {
      await callFunction("send-campaign", {
        subject: template.subject || template.name,
        body: template.body,
        test_to: testTo.trim(),
      });
      toast.show(`Test sent to ${testTo.trim()}`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const sendAll = async () => {
    setBusy(true);
    try {
      const r = await callFunction<{ sent: number; matched: number; errors: string[] }>("send-campaign", {
        subject: template.subject || template.name,
        body: template.body,
        audience: audience(),
      });
      // Partial failure is the normal case with email — a few bounced
      // addresses in a batch of hundreds. Reporting only the successes would
      // hide it.
      if (r.errors?.length) {
        toast.error(`Sent ${r.sent} of ${r.matched}. ${r.errors.length} failed — first: ${r.errors[0]}`);
      } else {
        toast.show(`Sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}`);
      }
      onClose();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={`Send "${template.name}"`} onClose={onClose} wide>
      {!template.subject && (
        <p className="sub" style={{ marginBottom: 10 }}>
          This template has no subject line, so the template name will be used as the subject.
        </p>
      )}

      <div className="field">
        <label className="label">Who should receive it?</label>
        <select className="select" value={stageKey} onChange={(e) => changeStage(e.target.value)}>
          <option value="">Everyone with an email address</option>
          {stages.map((s) => <option key={s.key} value={s.key}>Only: {s.label}</option>)}
        </select>
        <label className="row" style={{ marginTop: 8, gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => changeMine(e.target.checked)} />
          <span className="sub">Only the ones assigned to me</span>
        </label>
        <p className="sub" style={{ fontSize: 12, marginTop: 6 }}>
          Anyone who has unsubscribed is always excluded.
        </p>
      </div>

      <div className="field">
        <label className="label">Send a test to yourself first</label>
        <div className="row">
          <input
            className="input"
            placeholder="you@example.com"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <button className="btn" disabled={busy} onClick={() => void sendTest()}>Send test</button>
        </div>
      </div>

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />

      {count === null ? (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void check()}>
            {busy ? "Checking…" : "Check how many"}
          </button>
        </div>
      ) : count === 0 ? (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="sub">No one matches that audience.</p>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <p className="sub">
              This will email <b>{count}</b> {count === 1 ? "person" : "people"}. It cannot be undone.
            </p>
            {remaining !== null && (
              <p className="sub" style={{ fontSize: 12, marginTop: 3 }}>
                {remaining < count
                  // Said before the button is pressed, not after a partial send:
                  // stopping halfway leaves no way to tell who received it.
                  ? <>Only <b>{remaining}</b> left in this month's allowance — narrow the audience or upgrade.</>
                  : <>{remaining} of this month's email allowance remaining.</>}
              </p>
            )}
          </div>
          <div className="row">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || (remaining !== null && remaining < count)}
              onClick={() => void sendAll()}
            >
              {busy ? "Sending…" : `Send to ${count}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
