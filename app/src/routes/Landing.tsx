import { useCallback, useEffect, useRef, useState } from "react";
import { FUNCTIONS_BASE } from "../lib/supabase";
import "../styles/landing.css";

/**
 * The public landing page.
 *
 * Until now `/` rendered the sign-in form: anyone arriving from a link, a
 * search result or a business card met a password-less login box and no
 * explanation of what they had arrived at. The product pages existed at
 * /product and /pricing, but nothing pointed at them from the front door.
 *
 * Signed-in users never see this — App.tsx routes them straight to their
 * dashboard, exactly as before. Only `/` changes, and only when there is no
 * session; every other route still goes to the sign-in form, so bookmarks
 * into the app are unaffected.
 *
 * ── The demo is real ───────────────────────────────────────────────────────
 * The board below calls the SAME `chat-agent` endpoint the customer widget
 * uses. Nothing is scripted or pre-recorded. That is the point: a canned
 * animation of an AI answering questions proves nothing, and anyone
 * evaluating this product has seen a hundred of them.
 *
 * It talks to the `mnb-research` organisation deliberately. MNB Research is
 * the business that sells this CRM, and its agent already holds a knowledge
 * base about the product — so a visitor's question is answered accurately,
 * and if they leave a contact detail it lands in the right sales pipeline.
 * Pointing this at `abrobot` instead would file prospective CRM buyers into a
 * study-abroad counselling pipeline, where nobody would ever work them.
 */

const DEMO_ORG = "mnb-research";

/** Suggested openers. Each is a question a real buyer actually asks. */
const PROMPTS = [
  "What can your AI do on its own?",
  "How do you capture leads from WhatsApp?",
  "What happens when a lead goes quiet?",
  "How much does it cost?",
];

/**
 * The capability rail.
 *
 * Every entry here is a feature that genuinely exists and is deployed — the
 * temptation on a page like this is to list the roadmap, and a prospect who
 * signs up for something described here and cannot find it is worse than one
 * who never signed up. `ask` fires the real agent, so the copy and the
 * demonstration cannot drift apart.
 */
const CAPABILITIES: { icon: string; title: string; detail: string; ask: string }[] = [
  {
    icon: "💬",
    title: "Answers, day or night",
    detail: "Trained on your business, not a generic bot. It handles the question and keeps the conversation going.",
    ask: "What can your AI do on its own?",
  },
  {
    icon: "🎯",
    title: "Captures the enquiry",
    detail: "Asks for one detail at the right moment and files a record — no form, no drop-off.",
    ask: "How do you capture a lead from a chat?",
  },
  {
    icon: "⭐",
    title: "Scores and prioritises",
    detail: "Ranks every enquiry on intent and urgency so your team works the right one first.",
    ask: "How does lead scoring work?",
  },
  {
    icon: "🔀",
    title: "Routes to the right person",
    detail: "Assigns by workload so nothing lands in a shared inbox and waits.",
    ask: "How do you assign leads to my team?",
  },
  {
    icon: "🔔",
    title: "Tells you instantly",
    detail: "A Telegram or WhatsApp alert the moment something worth your attention arrives.",
    ask: "How do I get notified about a new lead?",
  },
  {
    icon: "✉️",
    title: "Follows up by itself",
    detail: "Runs your follow-up sequence on schedule, and stops the moment someone replies or buys.",
    ask: "What happens when a lead goes quiet?",
  },
];

interface Msg { role: "you" | "bot"; text: string }

export function Landing({ navigate }: { navigate: (to: string) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [activeCap, setActiveCap] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const msgsRef = useRef<HTMLDivElement>(null);
  // Guards against a reply landing after the component has gone.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  const ask = useCallback(async (text: string, capTitle?: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setStarted(true);
    setActiveCap(capTitle ?? null);
    setMsgs((m) => [...m, { role: "you", text: q }]);
    setDraft("");
    setBusy(true);

    try {
      const r = await fetch(`${FUNCTIONS_BASE}/chat-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          org: DEMO_ORG,
          message: q,
          // Carrying the id keeps this one conversation rather than starting a
          // fresh thread per question — so follow-ups like "and the price?"
          // actually make sense to the agent.
          ...(convId ? { conversation_id: convId } : {}),
        }),
      });

      const j = await r.json().catch(() => ({}));
      if (!aliveRef.current) return;

      // A 429 is the rate limiter, and it is the one failure a visitor can
      // cause themselves. Say so plainly rather than showing it as a fault.
      if (r.status === 429) {
        setMsgs((m) => [...m, {
          role: "bot",
          text: "That's a lot of questions at once — give me a few seconds and ask again.",
        }]);
        return;
      }

      if (j?.conversation_id) setConvId(j.conversation_id);

      // Never render a raw error to a prospect. If the agent is unreachable,
      // the page should still leave them somewhere useful rather than showing
      // them the product failing on its own front page.
      setMsgs((m) => [...m, {
        role: "bot",
        text: j?.reply
          || "I can't reach my notes this second. The product tour at /product covers all of this — or sign in and try it on your own data.",
      }]);
    } catch {
      if (!aliveRef.current) return;
      setMsgs((m) => [...m, {
        role: "bot",
        text: "Something went wrong reaching the assistant. Have a look at /product in the meantime.",
      }]);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy, convId]);

  return (
    <div className="lp">
      {/* ── nav ─────────────────────────────────────────────────────────── */}
      <nav className="lp-nav">
        <div className="lp-wrap lp-nav-in">
          <div className="lp-logo">
            <span className="lp-logo-mark" aria-hidden="true">🎓</span>
            AbroBot CRM
          </div>
          <div className="lp-nav-links">
            <a className="lp-nav-link lp-hide-sm" href="/product">Product</a>
            <a className="lp-nav-link lp-hide-sm" href="/pricing">Pricing</a>
            <button className="lp-nav-link" onClick={() => navigate("/login")}>Sign in</button>
          </div>
        </div>
      </nav>

      {/* ── hero + the board ────────────────────────────────────────────── */}
      <header className="lp-hero">
        <div className="lp-grid-bg" aria-hidden="true" />
        <div className="lp-wrap lp-hero-in">
          <span className="lp-eyebrow">
            <span className="lp-dot" aria-hidden="true" />
            The assistant below is live — ask it anything
          </span>

          <h1 className="lp-h1">The CRM that <em>works the leads</em> while you sleep.</h1>
          <p className="lp-sub">
            It answers your enquiries, captures who they are, scores them, routes them to the
            right person and follows up — on its own, in the background, every day. You open
            the app to a list of people worth calling, not a pile of unread messages.
          </p>

          <div className="lp-cta-row">
            <button className="lp-btn lp-btn-primary" onClick={() => navigate("/login")}>
              Start free →
            </button>
            <a className="lp-btn lp-btn-ghost" href="/product">See everything it does</a>
          </div>
          <p className="lp-note">Free plan, no card. Built for Indian SMEs.</p>

          {/* The board */}
          <section className="lp-board" aria-label="Live AI assistant demonstration">
            <div className="lp-chat">
              <div className="lp-board-head">
                <span className="lp-tl" aria-hidden="true"><i /><i /><i /></span>
                Live assistant · answering right now
              </div>

              <div className="lp-msgs" ref={msgsRef} aria-live="polite" aria-atomic="false">
                {!started && (
                  <div className="lp-msg lp-msg-bot">
                    Hello. I'm the same assistant your customers would talk to — ask me what
                    I can do, how I capture a lead, or what any of it costs.
                  </div>
                )}
                {msgs.map((m, i) => (
                  <div key={i} className={`lp-msg ${m.role === "you" ? "lp-msg-you" : "lp-msg-bot"}`}>
                    {m.text}
                  </div>
                ))}
                {busy && (
                  <div className="lp-msg lp-msg-bot lp-typing" aria-label="Assistant is typing">
                    <i /><i /><i />
                  </div>
                )}
              </div>

              {!started && (
                <div className="lp-chips">
                  {PROMPTS.map((p) => (
                    <button key={p} className="lp-chip" disabled={busy} onClick={() => void ask(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              )}

              <form
                className="lp-composer"
                onSubmit={(e) => { e.preventDefault(); void ask(draft); }}
              >
                <label className="sr-only" htmlFor="lp-q">Ask the assistant a question</label>
                <input
                  id="lp-q"
                  className="lp-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Ask it anything…"
                  disabled={busy}
                  autoComplete="off"
                />
                <button className="lp-send" type="submit" disabled={busy || !draft.trim()}>
                  {busy ? "…" : "Ask"}
                </button>
              </form>
            </div>

            <div className="lp-caps">
              {CAPABILITIES.map((c) => (
                <button
                  key={c.title}
                  className={`lp-cap${activeCap === c.title ? " is-live" : ""}`}
                  disabled={busy}
                  onClick={() => void ask(c.ask, c.title)}
                >
                  <span className="lp-cap-ico" aria-hidden="true">{c.icon}</span>
                  <span>
                    <span className="lp-cap-t">{c.title}</span>
                    <span className="lp-cap-d">{c.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </header>

      {/* ── what it does unattended ─────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-wrap">
          <p className="lp-kicker">Runs without you</p>
          <h2 className="lp-h2">Six things it does while nobody is watching</h2>
          <p className="lp-lede">
            Not suggestions or drafts waiting for approval. These run on their own schedule
            and finish the job — and every one of them is switched on from a single screen.
          </p>

          <div className="lp-cards">
            {CAPABILITIES.map((c) => (
              <article className="lp-card" key={c.title}>
                <div className="lp-card-ico" aria-hidden="true">{c.icon}</div>
                <h3>{c.title}</h3>
                <p>{c.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── how it works ───────────────────────────────────────────────── */}
      <section className="lp-section lp-section-alt">
        <div className="lp-wrap">
          <p className="lp-kicker">Live the same afternoon</p>
          <h2 className="lp-h2">Three steps, and it starts working</h2>
          <p className="lp-lede">
            No integration project and no consultant. The longest part is deciding what you
            want it to say.
          </p>

          <div className="lp-steps">
            <div className="lp-step">
              <div className="lp-step-n">1</div>
              <h3>Tell it about your business</h3>
              <p>
                Paste in what you do, your services and your prices. That becomes the
                assistant's knowledge — it answers from your words, not a generic script.
              </p>
            </div>
            <div className="lp-step">
              <div className="lp-step-n">2</div>
              <h3>Put it on your website</h3>
              <p>
                One line of code, or a capture link for your forms, WhatsApp and ad
                platforms. Enquiries start arriving as records immediately.
              </p>
            </div>
            <div className="lp-step">
              <div className="lp-step-n">3</div>
              <h3>Let it work</h3>
              <p>
                It answers, captures, scores, assigns, alerts and follows up on its own.
                You get a Telegram message when something needs a person.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── closing CTA ────────────────────────────────────────────────── */}
      <section className="lp-section">
        <div className="lp-wrap">
          <div className="lp-final">
            <h2>Stop losing the enquiries you already paid for.</h2>
            <p>
              Most small businesses lose more leads to slow replies than to price. This
              answers in seconds, at 2am, in the middle of your busiest week.
            </p>
            <div className="lp-cta-row" style={{ justifyContent: "center" }}>
              <button className="lp-btn lp-btn-primary" onClick={() => navigate("/login")}>
                Start free →
              </button>
              <a className="lp-btn lp-btn-ghost" href="/pricing">See pricing</a>
            </div>
          </div>
        </div>
      </section>

      <footer className="lp-wrap lp-foot">
        <span>© {new Date().getFullYear()} MNB Research</span>
        <nav className="lp-foot-links" aria-label="Footer">
          <a href="/product">Product</a>
          <a href="/pricing">Pricing</a>
          <a href="/contact-us.html">Contact</a>
          <a href="/terms-and-conditions.html">Terms</a>
          <a href="/refund-and-cancellation-policy.html">Refunds</a>
        </nav>
      </footer>
    </div>
  );
}
