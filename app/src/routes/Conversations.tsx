import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { supabase, callFunction } from "../lib/supabase";
import { Card, Empty, LoadError, Spinner, timeAgo, useToast } from "../components/ui";

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
  security_flag?: string | null;
  security_details?: string | null;
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
  const [msgError, setMsgError] = useState<string | null>(null);
  // Kept in state rather than only toasted: the toast is gone in 3.2 seconds
  // and what remains on screen is "0 website chats" and "No conversations yet"
  // — a claim about the org's data made out of a failed request.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);
  // Why there is no summary, kept apart from the summary itself. Every
  // non-answer used to collapse into "No summary returned." — an exhausted AI
  // allowance, a failed AI call and a chat with nothing in it all read the
  // same, so nobody could tell whether to upgrade, retry or give up.
  const [summaryProblem, setSummaryProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "security" | "contact">("all");
  // True while a transcript is being fetched. Without it the pane showed
  // "No messages in this conversation." for the length of the request — a
  // statement about the chat, made before we had read it.
  const [msgLoading, setMsgLoading] = useState(false);
  // The conversation whose transcript is wanted NOW. Clicking a second chat
  // while the first is loading must not let the first answer land in its pane.
  const wanted = useRef<string | null>(null);
  const toast = useToast();

  const formatSecurityBadge = (flag?: string | null) => {
    if (!flag) return null;
    switch (flag) {
      case "code_query_blocked":
        return { label: "🛡️ Code Query Blocked", bg: "rgba(239, 68, 68, 0.12)", color: "#b91c1c" };
      case "prompt_injection_blocked":
        return { label: "🔒 Prompt Injection Blocked", bg: "rgba(245, 158, 11, 0.15)", color: "#92400e" };
      case "prompt_leak_blocked":
        return { label: "🤐 Prompt Leak Blocked", bg: "rgba(168, 85, 247, 0.15)", color: "#6b21a8" };
      case "sanitized_code_leak":
        return { label: "⚠️ Output Sanitized", bg: "rgba(239, 68, 68, 0.12)", color: "#b91c1c" };
      default:
        return { label: "🛡️ Guardrail Deflected", bg: "rgba(239, 68, 68, 0.12)", color: "#b91c1c" };
    }
  };

  const load = useCallback(async () => {
    if (!org) { setLoading(false); return; }   // never leave the spinner up forever
    setLoading(true);
    const { data, error: loadErr } = await supabase
      .from("conversations")
      .select("*")
      .eq("org_id", org.id)
      .order("last_message_at", { ascending: false })
      .limit(200);
    // An unread error rendered an empty state, which reads as "you have
    // none" rather than "we could not check".
    if (loadErr) { setLoadError(loadErr.message); toast.error(`Could not load conversations: ${loadErr.message}`); }
    else { setLoadError(null); setConvos((data as Conversation[]) ?? []); }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  useEffect(() => { void load(); }, [load]);

  const open = useCallback(async (c: Conversation) => {
    setSelected(c);
    setSummary(null);
    setSummaryProblem(null);
    setMessages([]);
    setMsgError(null);
    setMsgLoading(true);
    wanted.current = c.id;
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", c.id)
      .order("created_at");
    if (wanted.current !== c.id) return;
    setMsgLoading(false);
    // The error was dropped, so a failed read rendered the transcript pane
    // empty — which reads as "this visitor said nothing", on a conversation the
    // list beside it says has messages. Worse, "Summarise" was still offered
    // over what looked like an empty chat.
    if (error) {
      setMsgError(error.message);
      return;
    }
    setMsgError(null);
    setMessages((data as ChatMessage[]) ?? []);
  }, []);

  // Uses the recovered summarize-chats edge function rather than duplicating
  // the prompt client-side — the transcript never leaves the server.
  const summarise = async () => {
    if (!selected || !org) return;
    setSummarising(true);
    setSummary(null);
    setSummaryProblem(null);
    try {
      // summarize-chats answers 200 in three non-summary cases, and each needs
      // its own sentence:
      //   { summaries: {}, skipped: "monthly AI allowance used up" }  — the plan
      //   { summaries: {} } with messages on screen — the AI call failed (the
      //     function skips a failed batch rather than erroring)
      //   { summaries: {} } with no messages — nothing to summarise
      // `errors` is read too, so a per-batch reason surfaces as soon as the
      // function starts returning one.
      const r = await callFunction<{
        summaries: Record<string, { summary: string; interest: string }>;
        skipped?: string;
        errors?: string[];
      }>(
        "summarize-chats",
        { org: org.slug, conversation_ids: [selected.id] },
      );
      const s = r.summaries?.[selected.id];
      if (s) {
        setSummary(`${s.summary}\n\nInterest: ${s.interest}`);
      } else if (r.skipped) {
        setSummaryProblem(
          /allowance/i.test(r.skipped)
            ? "Your plan's AI allowance for this month is used up, so no summary was made. It resets on the 1st — or upgrade in Settings → Plan & usage."
            : `No summary was made: ${r.skipped}.`,
        );
      } else if (r.errors?.length) {
        setSummaryProblem(`The AI summary failed: ${r.errors[0]}`);
      } else if (messages.length === 0) {
        setSummaryProblem("There are no messages in this conversation to summarise.");
      } else {
        setSummaryProblem("The AI service didn't return a summary for this conversation — it may be busy or rate-limited. Try again in a minute.");
      }
    } catch (e) {
      // A refusal (503 allowance check, 404 org) is shown where the summary
      // would have been, not only in a toast that is gone in three seconds.
      setSummaryProblem((e as Error).message);
      toast.error((e as Error).message);
    }
    setSummarising(false);
  };

  if (loading) return <Spinner />;
  // Checked before the header, because the header itself asserts a number:
  // "0 website chats" beside "No conversations yet" is a failed read wearing
  // the clothes of a fact. Same early-return shape as Archived and Leads.
  if (loadError) return <LoadError message={loadError} onRetry={() => void load()} />;

  const securityCount = convos.filter((c) => Boolean(c.security_flag)).length;
  const contactCount = convos.filter((c) => Boolean(c.visitor_email || c.visitor_phone)).length;
  const visibleConvos = convos.filter((c) => {
    if (filter === "security") return Boolean(c.security_flag);
    if (filter === "contact") return Boolean(c.visitor_email || c.visitor_phone);
    return true;
  });

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
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              <button
                className={`btn btn-xs ${filter === "all" ? "btn-primary" : ""}`}
                onClick={() => setFilter("all")}
                style={{ fontSize: 11, padding: "3px 8px" }}
              >
                All ({convos.length})
              </button>
              <button
                className={`btn btn-xs ${filter === "security" ? "btn-primary" : ""}`}
                onClick={() => setFilter("security")}
                style={{ fontSize: 11, padding: "3px 8px", color: filter === "security" ? undefined : (securityCount ? "#b91c1c" : undefined) }}
              >
                🛡️ Guardrails ({securityCount})
              </button>
              <button
                className={`btn btn-xs ${filter === "contact" ? "btn-primary" : ""}`}
                onClick={() => setFilter("contact")}
                style={{ fontSize: 11, padding: "3px 8px" }}
              >
                👤 Contacts ({contactCount})
              </button>
            </div>

            <div style={{ maxHeight: "62vh", overflowY: "auto", margin: -4 }}>
              {visibleConvos.length === 0 ? (
                <div className="sub" style={{ padding: "16px 8px", textAlign: "center", fontSize: 12.5 }}>
                  No conversations match this filter.
                </div>
              ) : (
                visibleConvos.map((c) => {
                  const badge = formatSecurityBadge(c.security_flag);
                  return (
                    <button
                      key={c.id}
                      className="nav-item"
                      style={{
                        borderRadius: 10,
                        background: selected?.id === c.id ? "var(--industry-soft)" : undefined,
                        display: "block",
                        marginBottom: 4,
                      }}
                      onClick={() => void open(c)}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.visitor_name || c.visitor_email || c.visitor_phone || "Anonymous visitor"}
                        </div>
                      </div>
                      <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                        {c.message_count} messages · {timeAgo(c.last_message_at)}
                      </div>
                      {badge && (
                        <div style={{ marginTop: 4 }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 6px",
                              borderRadius: 4,
                              fontSize: 10.5,
                              fontWeight: 600,
                              background: badge.bg,
                              color: badge.color,
                            }}
                          >
                            {badge.label}
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })
              )}
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
                  <button className="btn btn-sm" onClick={summarise} disabled={summarising || msgLoading}>
                    {summarising ? "Summarising…" : "✨ AI summary"}
                  </button>
                </div>
              }
            >
              {selected.security_flag && (
                <div
                  style={{
                    background: "rgba(239, 68, 68, 0.08)",
                    border: "1px solid rgba(239, 68, 68, 0.28)",
                    borderRadius: 12,
                    padding: "12px 14px",
                    marginBottom: 14,
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ fontWeight: 700, color: "#b91c1c", display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span>🛡️ Security Guardrail Active</span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: formatSecurityBadge(selected.security_flag)?.bg,
                        color: formatSecurityBadge(selected.security_flag)?.color,
                      }}
                    >
                      {formatSecurityBadge(selected.security_flag)?.label}
                    </span>
                  </div>
                  <div style={{ color: "var(--text)", fontSize: 12.5 }}>
                    A visitor attempted a restricted request{selected.security_details ? ` (${selected.security_details})` : ""}.
                    The agent automatically enforced your strict security boundaries, refused code generation / system override, and steered the conversation back to your business offerings.
                  </div>
                </div>
              )}

              {selected.page_url && (
                <p className="sub" style={{ marginTop: -8, marginBottom: 12, wordBreak: "break-all" }}>
                  Started on {selected.page_url}
                </p>
              )}

              {summaryProblem && (
                <div className="sub" style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 13, marginBottom: 14 }}>
                  ⚠️ {summaryProblem}
                </div>
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
                {/* "No messages" and "we could not read the messages" are very
                    different statements about a customer's data. */}
                {msgLoading
                  ? <p className="sub">Loading the transcript…</p>
                  : msgError
                    ? <LoadError message={msgError} onRetry={() => void open(selected)} />
                    : messages.length === 0 && <p className="sub">No messages in this conversation.</p>}
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
