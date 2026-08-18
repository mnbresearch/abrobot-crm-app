import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { Card, Empty, Modal, Spinner, useToast } from "../components/ui";

// Reusable message templates for email and WhatsApp, with merge tokens the
// send-campaign / nurture functions understand.

interface Template {
  id: string;
  org_id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  created_at: string;
}

const TOKENS = ["{{name}}", "{{first_name}}", "{{country}}", "{{course}}", "{{brand}}"];

export function Templates() {
  const { org, ui, isAdmin } = useApp();
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const toast = useToast();

  const load = async () => {
    if (!org) return;
    const { data } = await supabase.from("message_templates").select("*").eq("org_id", org.id).order("created_at");
    setRows((data as Template[]) ?? []);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [org]);

  const save = async () => {
    if (!org || !editing) return;
    if (!editing.name?.trim() || !editing.body?.trim()) { toast.error("Name and body are required"); return; }
    const payload = {
      org_id: org.id,
      name: editing.name.trim(),
      channel: editing.channel ?? "email",
      subject: editing.subject?.trim() || null,
      body: editing.body,
    };
    const { error } = editing.id
      ? await supabase.from("message_templates").update(payload).eq("id", editing.id)
      : await supabase.from("message_templates").insert(payload);
    if (error) { toast.error(error.message); return; }
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
                  <span className="pill pill-muted" style={{ marginTop: 4 }}>
                    {t.channel === "whatsapp" ? "💬 WhatsApp" : "✉️ Email"}
                  </span>
                </div>
              }
              action={
                isAdmin && (
                  <div className="row">
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
            <div className="field">
              <label className="label">Subject</label>
              <input
                className="input"
                value={editing.subject ?? ""}
                onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
              />
            </div>
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
              Click a token to insert it. It's replaced with the record's details when the message is sent.
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
