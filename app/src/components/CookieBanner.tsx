import { useEffect, useState } from "react";

const STORAGE_KEY = "abrobot_dpdp_ack";

export function CookieBanner() {
  const [acknowledged, setAcknowledged] = useState(true);

  useEffect(() => {
    try {
      const ack = localStorage.getItem(STORAGE_KEY);
      if (!ack) setAcknowledged(false);
    } catch {
      // Storage access blocked / Safari Lockdown
      setAcknowledged(true);
    }
  }, []);

  const handleAcknowledge = () => {
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // ignore
    }
    setAcknowledged(true);
  };

  if (acknowledged) return null;

  return (
    <aside
      role="region"
      aria-label="Privacy and Data Protection Notice"
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        width: "calc(100% - 32px)",
        maxWidth: 780,
        zIndex: 9999,
        background: "var(--card, #ffffff)",
        color: "var(--text, #1e293b)",
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: 14,
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
        padding: "14px 18px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        backdropFilter: "blur(8px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 260 }}>
        <span style={{ fontSize: 20, flexShrink: 0, marginTop: 1 }}>🛡️</span>
        <div style={{ fontSize: 13, lineHeight: 1.55 }}>
          <strong>Privacy &amp; Data Protection (DPDP Act 2023 &amp; GDPR):</strong> We use strictly essential
          session cookies and anonymised telemetry to secure and operate your CRM workspace. We do not use third-party
          advertising trackers or sell personal data.{" "}
          <a
            href="/privacy-policy"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--industry, #2563eb)", textDecoration: "underline", fontWeight: 500 }}
          >
            Learn more in our Privacy Policy
          </a>
          .
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <button
          className="btn btn-sm btn-primary"
          style={{ whiteSpace: "nowrap", padding: "6px 14px", fontWeight: 600, fontSize: 13 }}
          onClick={handleAcknowledge}
        >
          Got it
        </button>
      </div>
    </aside>
  );
}
