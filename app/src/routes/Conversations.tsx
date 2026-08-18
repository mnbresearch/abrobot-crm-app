import { useCallback, useEffect, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, Empty, Spinner, timeAgo, useToast } from "../components/ui";

// Website chat transcripts captured by the chat-agent edge function.
// Two panes: conversation list, and the selected transcript.

interface Conversation {
  id: string;
  lead_id: string | null;
  visitor_name: string | null;
  visitor_email: string | null;
  visitor_phone: string | null;
  page_url: string | null;
  message_count: number;
  created_at: string;
  last_message_at: string;
}

interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

export function Conversations({ navigate }: { navigate: (to: string) => void }) {
  const { org } = useApp();
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!org) return;
    void (async () => {
      const { data } = await supabase
        .from("conversations")
        .select("*")
        .eq("org_id", org.id)
        .order("last_message_at", { ascending: false })
        .limit(200);
      setConvos((data as Conversation[]) ?? []);
      setLoading(false);
    })();
  }, [org]);

  const open = useCallback(async (c: Conversation) => {
    setSelected(c);
    setSummary(null);
    const { data } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", c.id)
      .order("created_at");
    setMessages((data as ChatMessage[]) ?? []);
  }, []);

  // Uses the recovered summarize-chats edge function rather than duplicating
  // the prompt client-side — the transcript never leaves the server.
  const summarise = async () => {
    if (!selected || !org) return;
    setSummarising(true);
    try {
      const r = await callFunction<{ summaries: Record<string, { summary: string; interest: string }> }>(
        "summarize-chats",
        { org: org.slug, conversation_ids: [selected.id] },
      );
      const s = r.summaries?.[selected.id];
      setSummary(s ? `${s.summary}\n\nInterest: ${s.interest}` : "No summary returned.");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSummarising(false);
  };

  if (loading) return <Spinner />;

  return (
    <div className="stack">
      <div>
        <h1>Conversations</h1>
        <p className="sub" style={{ marginTop: 2 }}>{convos.length} website chats</p>
      </div>

      {convos.length === 0 ? (
        <Card>
          <Empty
            icon="💬"
            title="No conversations yet"
            hint="Install the chat widget from Settings → Install Widget and visitor chats will appear here."
          />
        </Card>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "minmax(260px, 340px) 1fr", alignItems: "start" }}>
          <Card title="Recent">
            <div style={{ maxHeight: "62vh", overflowY: "auto", margin: -4 }}>
              {convos.map((c) => (
                <button
                  key={c.id}
                  className="nav-item"
                  style={{
                    borderRadius: 10,
                    background: selected?.id === c.id ? "var(--industry-soft)" : undefined,
                    display: "block",
                  }}
                  onClick={() => void open(c)}
                >
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    {c.visitor_name || c.visitor_email || c.visitor_phone || "Anonymous visitor"}
                  </div>
                  <div className="sub" style={{ fontSize: 12 }}>
                    {c.message_count} messages · {timeAgo(c.last_message_at)}
                  </div>
                </button>
              ))}
            </div>
          </Card>

          {selected ? (
            <Card
              title={selected.visitor_name || selected.visitor_email || "Transcript"}
              action={
                <div className="row">
                  {selected.lead_id && (
                    <button className="btn btn-sm" onClick={() => navigate(`/leads/${selected.lead_id}`)}>
                      Open record →
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={summarise} disabled={summarising}>
                    {summarising ? "Summarising…" : "✨ AI summary"}
                  </button>
                </div>
              }
            >
              {selected.page_url && (
                <p className="sub" style={{ marginTop: -8, marginBottom: 12, wordBreak: "break-all" }}>
                  Started on {selected.page_url}
                </p>
              )}

              {summary && (
                <div style={{ background: "var(--industry-soft)", borderRadius: 12, padding: 13, marginBottom: 14, whiteSpace: "pre-wrap" }}>
                  {summary}
                </div>
              )}

              <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
                {messages.map((m) => {
                  const mine = m.role === "assistant";
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-start" : "flex-end", marginBottom: 9 }}>
                      <div
                        style={{
                          maxWidth: "78%",
                          padding: "9px 13px",
                          borderRadius: 13,
                          background: mine ? "var(--card)" : "var(--industry)",
                          color: mine ? "var(--text)" : "#fff",
                          border: mine ? "1px solid var(--border)" : "none",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {m.content}
                        <div style={{ fontSize: 10.5, opacity: 0.65, marginTop: 3 }}>{timeAgo(m.created_at)}</div>
                      </div>
                    </div>
                  );
                })}
                {messages.length === 0 && <p className="sub">No messages in this conversation.</p>}
              </div>
            </Card>
          ) : (
            <Card>
              <Empty icon="💬" title="Pick a conversation" hint="Select one on the left to read the transcript." />
            </Card>
          )}
        </div>
      )}
      {toast.node}
    </div>
  );
}
