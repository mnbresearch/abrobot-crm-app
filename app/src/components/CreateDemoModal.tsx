import { useState } from "react";
import { supabase, callFunction } from "../lib/supabase";
import { Modal, useToast } from "./ui";

export interface DemoHandoverDetails {
  org_id: string;
  name: string;
  slug: string;
  industry: string;
  admin_email: string;
  admin_name?: string | null;
  duration_days: number;
  expires_at: string;
  features: Record<string, any>;
  leads_seeded: number;
}

interface CreateDemoModalProps {
  onClose: () => void;
  onSuccess: (handover: DemoHandoverDetails) => void;
}

const INDUSTRY_OPTIONS = [
  { slug: "study_abroad", label: "Study Abroad & Test Prep", icon: "🎓" },
  { slug: "real_estate", label: "Real Estate & Property", icon: "🏢" },
  { slug: "dental_clinic", label: "Dental & Healthcare Clinic", icon: "🦷" },
  { slug: "immigration", label: "Immigration & Visa Consultancy", icon: "✈️" },
  { slug: "wholesale", label: "B2B Wholesale & Distribution", icon: "📦" },
  { slug: "fitness", label: "Fitness & Wellness Studio", icon: "🏋️" },
  { slug: "edtech", label: "EdTech & Online Courses", icon: "💻" },
  { slug: "general", label: "General Sales & High-Ticket CRM", icon: "🎯" },
];

export function CreateDemoModal({ onClose, onSuccess }: CreateDemoModalProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugCustomized, setSlugCustomized] = useState(false);
  const [industry, setIndustry] = useState("study_abroad");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [durationDays, setDurationDays] = useState<number>(7);
  const [basePlan, setBasePlan] = useState("growth");

  // Feature toggles & custom limits
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiLimit, setAiLimit] = useState(250);

  const [whatsappEnabled, setWhatsappEnabled] = useState(true);
  const [whatsappLimit, setWhatsappLimit] = useState(100);

  const [nurtureEnabled, setNurtureEnabled] = useState(true);
  const [emailsLimit, setEmailsLimit] = useState(500);

  const [automationsEnabled, setAutomationsEnabled] = useState(true);
  const [automationsLimit, setAutomationsLimit] = useState(5);

  const [apiAccess, setApiAccess] = useState(true);
  const [complianceEnabled, setComplianceEnabled] = useState(true);
  const [seatsLimit, setSeatsLimit] = useState(5);
  const [leadsLimit, setLeadsLimit] = useState(500);
  const [seedDemoData, setSeedDemoData] = useState(true);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slugCustomized) {
      const generated = val
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      setSlug(generated);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      setErr("Enter an organization name (at least 2 characters)");
      return;
    }
    const cleanEmail = adminEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      setErr("Enter a valid admin email address");
      return;
    }

    setBusy(true);
    setErr(null);

    const features = {
      ai_enabled: aiEnabled,
      ai_messages_limit: aiEnabled ? aiLimit : 0,
      whatsapp_enabled: whatsappEnabled,
      whatsapp_limit: whatsappEnabled ? whatsappLimit : 0,
      nurture_enabled: nurtureEnabled,
      emails_limit: nurtureEnabled ? emailsLimit : 0,
      automations_enabled: automationsEnabled,
      automations_limit: automationsEnabled ? automationsLimit : 0,
      api_access: apiAccess,
      compliance_enabled: complianceEnabled,
      seats_limit: seatsLimit,
      leads_limit: leadsLimit,
    };

    const payload = {
      name: cleanName,
      slug: slug.trim() || undefined,
      industry,
      admin_email: cleanEmail,
      admin_name: adminName.trim() || undefined,
      duration_days: durationDays,
      base_plan: basePlan,
      features,
      seed_demo_data: seedDemoData,
    };

    try {
      let result: any = null;

      // 1. Try calling the admin-provision-demo edge function first
      try {
        result = await callFunction<DemoHandoverDetails>("admin-provision-demo", payload);
      } catch (fnErr) {
        // Fall back to direct RPC
        const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_provision_demo_org", {
          p_name: payload.name,
          p_slug: payload.slug,
          p_industry: payload.industry,
          p_admin_email: payload.admin_email,
          p_admin_name: payload.admin_name,
          p_duration_days: payload.duration_days,
          p_base_plan: payload.base_plan,
          p_features: payload.features,
          p_seed_demo_data: payload.seed_demo_data,
        });

        if (rpcErr) throw new Error(rpcErr.message);
        result = rpcData;
      }

      if (!result) throw new Error("Provisioning returned no response");

      toast.show(`Demo workspace ${cleanName} provisioned successfully!`);
      onSuccess(result as DemoHandoverDetails);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Provision 7-Day Demo Account" onClose={onClose} wide>
      <form onSubmit={submit} className="stack" style={{ gap: 18 }}>
        <p className="sub" style={{ marginTop: -6, fontSize: 13.5 }}>
          Create an isolated client demonstration workspace with custom features, realistic industry leads,
          and strict 7-day validity. Once the 7-day period expires, upgrading is compulsorily required.
        </p>

        {err && <div className="pill pill-red" style={{ padding: "8px 12px" }}>{err}</div>}

        {/* Section 1: Client & Workspace Details */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>1. Workspace &amp; Client Details</div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field">
              <label className="label">Organization Name *</label>
              <input
                className="input"
                required
                placeholder="e.g. Apex Global Consultants"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                autoFocus
              />
            </div>

            <div className="field">
              <label className="label">Workspace URL Slug</label>
              <input
                className="input"
                placeholder="e.g. apex-global"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugCustomized(true);
                }}
              />
            </div>

            <div className="field">
              <label className="label">Industry Template Pack</label>
              <select
                className="input"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              >
                {INDUSTRY_OPTIONS.map((ind) => (
                  <option key={ind.slug} value={ind.slug}>
                    {ind.icon} {ind.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label">Base Plan Template</label>
              <select
                className="input"
                value={basePlan}
                onChange={(e) => setBasePlan(e.target.value)}
              >
                <option value="growth">Growth Tier (Recommended for Demos)</option>
                <option value="business">Business / Pro Tier</option>
                <option value="enterprise">Enterprise Tier</option>
                <option value="starter">Starter Tier</option>
              </select>
            </div>

            <div className="field">
              <label className="label">Admin Full Name</label>
              <input
                className="input"
                placeholder="e.g. Aman Singhania"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
              />
            </div>

            <div className="field">
              <label className="label">Admin Work Email *</label>
              <input
                className="input"
                type="email"
                required
                placeholder="e.g. aman@apexglobal.edu"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Section 2: Demo Expiry & Compulsory Upgrade Policy */}
        <div
          className="card"
          style={{
            padding: 14,
            background: "rgba(249, 115, 22, 0.04)",
            border: "1px solid rgba(249, 115, 22, 0.2)",
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>
                ⏳ 2. Strict 7-Day Demo Expiration Policy
              </div>
              <div className="sub" style={{ fontSize: 12.5, marginTop: 2 }}>
                Valid for exactly 7 days with <b>0 Grace Days</b>. Upon expiration, access is locked until a paid plan is chosen.
              </div>
            </div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span className="pill pill-green" style={{ fontWeight: 700 }}>
                Compulsory Upgrade Enforced
              </span>
              <select
                className="input input-sm"
                style={{ width: 110 }}
                value={durationDays}
                onChange={(e) => setDurationDays(Number(e.target.value))}
              >
                <option value={7}>7 Days</option>
                <option value={14}>14 Days</option>
                <option value={30}>30 Days</option>
              </select>
            </div>
          </div>
        </div>

        {/* Section 3: Feature Customization & Quotas */}
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
            3. Feature Customization &amp; Quotas
          </div>

          <div className="stack" style={{ gap: 12 }}>
            {/* AI Concierge */}
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <label className="row" style={{ gap: 8, cursor: "pointer", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={aiEnabled}
                  onChange={(e) => setAiEnabled(e.target.checked)}
                />
                <span>🤖 AI Chatbot Concierge &amp; Inbound Widget</span>
              </label>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <span className="pill pill-green" style={{ fontSize: 11 }}>
                  🛡️ Zero-Code Guardrails Active
                </span>
                <select
                  className="input input-sm"
                  disabled={!aiEnabled}
                  value={aiLimit}
                  onChange={(e) => setAiLimit(Number(e.target.value))}
                >
                  <option value={100}>100 msgs</option>
                  <option value={250}>250 msgs</option>
                  <option value={500}>500 msgs</option>
                  <option value={1000}>1,000 msgs</option>
                  <option value={5000}>5,000 msgs</option>
                </select>
              </div>
            </div>

            {/* WhatsApp */}
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <label className="row" style={{ gap: 8, cursor: "pointer", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={whatsappEnabled}
                  onChange={(e) => setWhatsappEnabled(e.target.checked)}
                />
                <span>💬 WhatsApp Cloud API Integration</span>
              </label>
              <select
                className="input input-sm"
                disabled={!whatsappEnabled}
                value={whatsappLimit}
                onChange={(e) => setWhatsappLimit(Number(e.target.value))}
              >
                <option value={50}>50 msgs</option>
                <option value={100}>100 msgs</option>
                <option value={250}>250 msgs</option>
                <option value={500}>500 msgs</option>
              </select>
            </div>

            {/* Automated Nurture */}
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <label className="row" style={{ gap: 8, cursor: "pointer", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={nurtureEnabled}
                  onChange={(e) => setNurtureEnabled(e.target.checked)}
                />
                <span>📧 Automated Email Follow-up Campaigns</span>
              </label>
              <select
                className="input input-sm"
                disabled={!nurtureEnabled}
                value={emailsLimit}
                onChange={(e) => setEmailsLimit(Number(e.target.value))}
              >
                <option value={200}>200 emails</option>
                <option value={500}>500 emails</option>
                <option value={1000}>1,000 emails</option>
                <option value={2500}>2,500 emails</option>
              </select>
            </div>

            {/* Automations Engine */}
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <label className="row" style={{ gap: 8, cursor: "pointer", fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={automationsEnabled}
                  onChange={(e) => setAutomationsEnabled(e.target.checked)}
                />
                <span>⚡ Automations Engine (Event Workflows)</span>
              </label>
              <select
                className="input input-sm"
                disabled={!automationsEnabled}
                value={automationsLimit}
                onChange={(e) => setAutomationsLimit(Number(e.target.value))}
              >
                <option value={3}>3 workflows</option>
                <option value={5}>5 workflows</option>
                <option value={10}>10 workflows</option>
                <option value={25}>25 workflows</option>
              </select>
            </div>

            {/* Toggles for API & Compliance */}
            <div className="row row-wrap" style={{ gap: 16, marginTop: 4 }}>
              <label className="row" style={{ gap: 8, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                <input
                  type="checkbox"
                  checked={apiAccess}
                  onChange={(e) => setApiAccess(e.target.checked)}
                />
                <span>🔌 Inbound Webhooks &amp; REST API Access</span>
              </label>

              <label className="row" style={{ gap: 8, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                <input
                  type="checkbox"
                  checked={complianceEnabled}
                  onChange={(e) => setComplianceEnabled(e.target.checked)}
                />
                <span>🛡️ DPDP 2023 &amp; GDPR Statutory Compliance Suite</span>
              </label>
            </div>

            {/* Quotas for Seats & Leads */}
            <div className="grid grid-2" style={{ gap: 12, marginTop: 8 }}>
              <div className="field">
                <label className="label">Team Seats Limit</label>
                <input
                  type="number"
                  className="input"
                  min={1}
                  max={50}
                  value={seatsLimit}
                  onChange={(e) => setSeatsLimit(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label className="label">Max Leads Capacity</label>
                <input
                  type="number"
                  className="input"
                  min={50}
                  max={10000}
                  step={50}
                  value={leadsLimit}
                  onChange={(e) => setLeadsLimit(Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Section 4: Sample Data Pre-seeding */}
        <div
          className="card"
          style={{
            padding: 14,
            background: "rgba(16, 185, 129, 0.04)",
            border: "1px solid rgba(16, 185, 129, 0.2)",
          }}
        >
          <label className="row" style={{ gap: 10, cursor: "pointer", alignItems: "flex-start" }}>
            <input
              type="checkbox"
              style={{ marginTop: 3 }}
              checked={seedDemoData}
              onChange={(e) => setSeedDemoData(e.target.checked)}
            />
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: "#065f46" }}>
                📊 Pre-seed workspace with 6 realistic industry leads &amp; deals
              </div>
              <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>
                Seeds realistic inquiries across stages with activity histories, intent scores (62-98), and tags,
                making the demo pipeline instantly vibrant for client presentations.
              </div>
            </div>
          </label>
        </div>

        <div className="row" style={{ justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Provisioning Demo Workspace…" : "🚀 Provision 7-Day Demo Account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DemoHandoverModal({
  details,
  onClose,
}: {
  details: DemoHandoverDetails;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const expiryFormatted = new Date(details.expires_at).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const loginUrl = `${window.location.origin}/login`;

  const copyHandover = async () => {
    const summary = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 YOUR 7-DAY ABROBOT CRM DEMO WORKSPACE IS READY!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏢 Workspace: ${details.name}
🌐 Direct Login URL: ${loginUrl}
📧 Admin Username: ${details.admin_email}
🔑 Access Mode: Instant Magic-Link OTP (enter your email at login URL)

⏳ Evaluation Window:
• Duration: ${details.duration_days} Days (Strict window · Valid until ${expiryFormatted})
• Policy: Compulsory upgrade required at conclusion to retain active workspace access

✨ Configured Demo Features & Quotas:
• 🤖 AI Concierge Widget: Active with zero-code cybersecurity shield (${details.features?.ai_messages_limit ?? 250} msgs)
• 💬 WhatsApp Cloud API: Active (${details.features?.whatsapp_limit ?? 100} msgs)
• 📧 Automated Nurture Sequences: Active (${details.features?.emails_limit ?? 500} emails)
• ⚡ Automations Engine: Up to ${details.features?.automations_limit ?? 5} active workflows
• 🛡️ DPDP 2023 / GDPR Statutory Compliance Suite: Active (Certificate of Erasure & SAR Export)
• 👥 Team Seats: Up to ${details.features?.seats_limit ?? 5} active members
• 📊 Pre-Loaded Industry Data: ${details.leads_seeded} realistic pipeline deals, activities & AI scores initialized

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
To get started right away:
1. Open ${loginUrl}
2. Enter ${details.admin_email} and click "Send sign-in link"
3. Open the link received in your inbox to enter your workspace.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      toast.show("Complete handover summary copied to clipboard!");
      setTimeout(() => setCopied(false), 4000);
    } catch {
      toast.error("Could not copy automatically. Please copy the details manually.");
    }
  };

  return (
    <Modal title="Demo Workspace Provisioned Successfully" onClose={onClose} wide>
      <div className="stack" style={{ gap: 16 }}>
        <div
          style={{
            textAlign: "center",
            padding: "20px 16px",
            background: "linear-gradient(180deg, rgba(16, 185, 129, 0.08) 0%, rgba(16, 185, 129, 0.02) 100%)",
            borderRadius: 8,
            border: "1px solid rgba(16, 185, 129, 0.2)",
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 4 }}>🎉</div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: "#065f46" }}>
            7-Day Demo Workspace Ready for Client Handover
          </h2>
          <p className="sub" style={{ fontSize: 13.5, maxWidth: 540, margin: "4px auto 0" }}>
            Workspace <b>{details.name}</b> has been provisioned with strict 7-day validity and zero-code security guardrails.
          </p>
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div className="sub" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            Workspace Credentials &amp; Access
          </div>

          <div className="grid grid-2" style={{ gap: 10, fontSize: 13 }}>
            <div>
              <span className="sub">Organization:</span> <b>{details.name}</b>
            </div>
            <div>
              <span className="sub">Slug:</span> <code>{details.slug}</code>
            </div>
            <div>
              <span className="sub">Admin Email:</span> <b>{details.admin_email}</b>
            </div>
            <div>
              <span className="sub">Access Method:</span> <span>Magic-Link OTP &amp; Invite</span>
            </div>
            <div>
              <span className="sub">Validity:</span>{" "}
              <span className="pill pill-green">7 Days · Until {expiryFormatted}</span>
            </div>
            <div>
              <span className="sub">Upgrade Policy:</span>{" "}
              <span className="pill pill-orange">Compulsory Upgrade at Day 7</span>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 14 }}>
          <div className="sub" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            Enabled Features &amp; Quotas
          </div>

          <div className="row row-wrap" style={{ gap: 8 }}>
            <span className="pill pill-muted">🤖 AI Concierge ({details.features?.ai_messages_limit ?? 250} msgs)</span>
            <span className="pill pill-muted">💬 WhatsApp ({details.features?.whatsapp_limit ?? 100} msgs)</span>
            <span className="pill pill-muted">📧 Nurture ({details.features?.emails_limit ?? 500} emails)</span>
            <span className="pill pill-muted">⚡ Automations ({details.features?.automations_limit ?? 5} rules)</span>
            <span className="pill pill-muted">👥 {details.features?.seats_limit ?? 5} Seats</span>
            <span className="pill pill-muted">🗂️ {details.features?.leads_limit ?? 500} Leads Cap</span>
            <span className="pill pill-muted">🛡️ DPDP 2023 Compliance</span>
            <span className="pill pill-green">📊 {details.leads_seeded} Realistic Leads Loaded</span>
          </div>
        </div>

        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <button
            className={`btn ${copied ? "btn-primary" : ""}`}
            onClick={copyHandover}
            style={{ fontWeight: 700 }}
          >
            {copied ? "✓ Copied to Clipboard!" : "📋 Copy Client Handover Summary"}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Done &amp; View in Platform Admin
          </button>
        </div>
      </div>
    </Modal>
  );
}
