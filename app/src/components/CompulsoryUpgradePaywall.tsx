import { useState } from "react";
import { useApp } from "../lib/store";
import { callFunction } from "../lib/supabase";
import { track } from "../lib/analytics";
import { useToast } from "./ui";

interface PaywallProps {
  onBypass?: () => void;
}

export function CompulsoryUpgradePaywall({ onBypass }: PaywallProps) {
  const { org, profile, isSuperAdmin, signOut } = useApp();
  const [months, setMonths] = useState<1 | 12>(1);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const toast = useToast();

  const checkout = async (planKey: string) => {
    setBusyPlan(planKey);
    track("plan_selected", { plan: planKey, months });

    try {
      const r = await callFunction<{ payment_session_id: string; env: string; order_id: string }>(
        "billing-checkout",
        { plan: planKey, months },
      );

      // On-demand load Cashfree SDK
      const sdkUrl = "https://sdk.cashfree.com/js/v3/cashfree.js";
      if (!document.querySelector(`script[src="${sdkUrl}"]`)) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = sdkUrl;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Could not load the payment gateway SDK"));
          document.head.appendChild(s);
        });
      }

      const CF = (window as unknown as { Cashfree?: (o: unknown) => { checkout: (o: unknown) => Promise<void> } }).Cashfree;
      if (!CF) throw new Error("Cashfree payment gateway is currently unavailable");

      const cf = CF({ mode: r.env === "production" ? "production" : "sandbox" });
      track("checkout_opened", { plan: planKey, months });
      await cf.checkout({ paymentSessionId: r.payment_session_id, redirectTarget: "_self" });
    } catch (e) {
      toast.error((e as Error).message || "Checkout could not be initialized");
    } finally {
      setBusyPlan(null);
    }
  };

  const PLANS = [
    {
      key: "starter",
      name: "Starter",
      badge: null,
      price: months === 1 ? 999 : 799,
      period: months === 1 ? "/mo" : "/mo (billed annually)",
      features: [
        "1,000 Leads Capacity",
        "2 Team Seats",
        "AI Chatbot Concierge (1,000 msgs)",
        "Email Marketing Campaigns",
        "Standard Analytics & Pipeline Board",
      ],
      notIncluded: ["WhatsApp Cloud API", "Automations Engine", "Inbound Webhooks / API"],
    },
    {
      key: "growth",
      name: "Growth",
      badge: "⭐ Recommended",
      price: months === 1 ? 2999 : 2399,
      period: months === 1 ? "/mo" : "/mo (billed annually)",
      features: [
        "5,000 Leads Capacity",
        "5 Team Seats",
        "AI Chatbot Concierge (5,000 msgs)",
        "WhatsApp Cloud API (1,000 msgs/mo)",
        "Automated Email Nurture Sequences",
        "Automations Engine (10 live rules)",
        "Lead Scoring & Predictive Analytics",
      ],
      notIncluded: ["Inbound Webhooks / API"],
    },
    {
      key: "business",
      name: "Business / Pro",
      badge: "🚀 Enterprise Ready",
      price: months === 1 ? 6999 : 5599,
      period: months === 1 ? "/mo" : "/mo (billed annually)",
      features: [
        "25,000 Leads Capacity",
        "15 Team Seats",
        "AI Chatbot Concierge (20,000 msgs)",
        "WhatsApp Cloud API (5,000 msgs/mo)",
        "Unlimited Automations Workflows",
        "Inbound Webhooks & REST API Access",
        "DPDP 2023 & GDPR Statutory Compliance Suite",
        "Priority Support & Dedicated Account Manager",
      ],
      notIncluded: [],
    },
  ];

  return (
    <div className="auth-wrap" style={{ minHeight: "100vh", padding: "40px 16px", background: "var(--bg)" }}>
      <div style={{ maxWidth: 960, width: "100%", margin: "0 auto" }}>
        {/* Top bar with org & sign out */}
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 24 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ fontSize: 24 }}>🎓</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{org?.name ?? "AbroBot CRM"}</div>
              <div className="sub" style={{ fontSize: 12 }}>Signed in as {profile?.email}</div>
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            {isSuperAdmin && onBypass && (
              <button className="btn btn-sm btn-ghost" onClick={onBypass} style={{ color: "var(--industry)" }}>
                🛡️ Super Admin Bypass →
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void signOut()}>
              Sign Out
            </button>
          </div>
        </div>

        {/* Lock Banner */}
        <div
          className="card"
          style={{
            textAlign: "center",
            padding: "32px 24px",
            marginBottom: 28,
            border: "1px solid var(--border)",
            background: "linear-gradient(180deg, rgba(239, 68, 68, 0.04) 0%, rgba(239, 68, 68, 0.01) 100%)",
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 8 }}>🔒</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 8, color: "var(--text)" }}>
            Your 7-Day Demo Period Has Concluded
          </h1>
          <p className="sub" style={{ fontSize: 15, maxWidth: 650, margin: "0 auto 16px", lineHeight: 1.6 }}>
            The 7-day evaluation window for <b>{org?.name}</b> has reached its expiration date.
            To resume access to your lead pipeline, AI concierge, WhatsApp sequences, and automations,
            please select a subscription plan below to upgrade.
          </p>

          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 16px",
              borderRadius: 8,
              background: "rgba(16, 185, 129, 0.1)",
              border: "1px solid rgba(16, 185, 129, 0.2)",
              fontSize: 13,
              color: "#059669",
              fontWeight: 600,
            }}
          >
            <span>🛡️ All Workspace Data &amp; Pipelines Preserved</span>
            <span style={{ opacity: 0.7 }}>·</span>
            <span style={{ fontWeight: 400 }}>Instantly unlocked upon payment confirmation</span>
          </div>
        </div>

        {/* Billing cycle toggle */}
        <div className="row" style={{ justifyContent: "center", marginBottom: 24, gap: 8 }}>
          <button
            className={`btn btn-sm${months === 1 ? " btn-primary" : ""}`}
            onClick={() => setMonths(1)}
          >
            Monthly Billing
          </button>
          <button
            className={`btn btn-sm${months === 12 ? " btn-primary" : ""}`}
            onClick={() => setMonths(12)}
          >
            Annual Billing <span className="pill pill-green" style={{ marginLeft: 6, fontSize: 10 }}>Save 20%</span>
          </button>
        </div>

        {/* Pricing Cards Grid */}
        <div className="grid grid-3" style={{ gap: 16, marginBottom: 32 }}>
          {PLANS.map((p) => {
            const isRec = p.key === "growth";
            const isBusy = busyPlan === p.key;

            return (
              <div
                key={p.key}
                className="card"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: 24,
                  position: "relative",
                  border: isRec ? "2px solid var(--industry, #f97316)" : "1px solid var(--border)",
                  boxShadow: isRec ? "0 8px 24px rgba(249, 115, 22, 0.12)" : "none",
                }}
              >
                {p.badge && (
                  <div
                    style={{
                      position: "absolute",
                      top: -12,
                      left: "50%",
                      transform: "translateX(-50%)",
                      background: "var(--industry, #f97316)",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "3px 12px",
                      borderRadius: 12,
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                    }}
                  >
                    {p.badge}
                  </div>
                )}

                <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 4 }}>{p.name}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 16 }}>
                  <span style={{ fontSize: 28, fontWeight: 800 }}>₹{p.price.toLocaleString("en-IN")}</span>
                  <span className="sub" style={{ fontSize: 12 }}>{p.period}</span>
                </div>

                <div style={{ flex: 1, marginBottom: 20 }}>
                  <div className="sub" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
                    Included Features:
                  </div>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }}>
                    {p.features.map((f, i) => (
                      <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "#10b981", fontWeight: "bold" }}>✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                    {p.notIncluded.map((f, i) => (
                      <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 6, opacity: 0.45 }}>
                        <span style={{ color: "#94a3b8" }}>✕</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  className={`btn ${isRec ? "btn-primary" : ""}`}
                  style={{ width: "100%", padding: "10px 16px", fontWeight: 700 }}
                  onClick={() => void checkout(p.key)}
                  disabled={busyPlan !== null}
                >
                  {isBusy ? "Opening Checkout…" : `Upgrade to ${p.name}`}
                </button>
              </div>
            );
          })}
        </div>

        {/* Enterprise & Custom Assistance */}
        <div
          className="card"
          style={{
            padding: "20px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            background: "var(--card-bg)",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Looking for an Enterprise or Custom Setup?</div>
            <div className="sub" style={{ fontSize: 13, marginTop: 2 }}>
              Dedicated compute, custom WhatsApp sender ID, multi-branch partitioning, or invoicing via GST.
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <a
              className="btn btn-sm"
              href="mailto:hello@updates.mnbresearch.com?subject=Enterprise%20Upgrade%20Inquiry%20-%20AbroBot%20CRM"
            >
              ✉️ Contact Enterprise Team
            </a>
            <a
              className="btn btn-sm btn-ghost"
              href="tel:+919711488480"
            >
              📞 Call +91 97114 88480
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
