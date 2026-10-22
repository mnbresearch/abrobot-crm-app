import { useState } from "react";
import type { ToolKind } from "../lib/industries";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import { calcAffordability, calcCtc, calcEmi, calcRoi, calcTripCost, inr, quoteTotal, triage } from "../lib/tools";
import type { FieldDef, Lead } from "../lib/types";

// The industry-specific tool shown on the lead page. One component switching on
// tool kind, so adding an industry means adding a case here plus a registry
// entry — not a new screen.

export function IndustryTool({ kind, label, lead, onLeadChange }: {
  kind: ToolKind; label?: string; lead: Lead;
  /** Told when a tool writes to the record, so the page shows the new value. */
  onLeadChange?: (lead: Lead) => void;
}) {
  const { fields } = useApp();
  if (kind === "none") return null;
  return (
    <div className="card">
      <div className="card-title">
        <h2>🧰 {label ?? "Tool"}</h2>
      </div>
      {kind === "emi" && <EmiTool lead={lead} fields={fields} />}
      {kind === "budget_match" && <AffordabilityTool />}
      {kind === "triage" && <TriageTool lead={lead} />}
      {kind === "ctc_compare" && <CtcTool lead={lead} />}
      {kind === "trip_cost" && <TripTool lead={lead} />}
      {kind === "roi" && <RoiTool lead={lead} />}
      {kind === "quote" && <QuoteTool lead={lead} fields={fields} onLeadChange={onLeadChange} />}
    </div>
  );
}

const numOf = (v: unknown, fallback = 0) => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
};

const Row = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
  <div className="row" style={{ justifyContent: "space-between", padding: "5px 0" }}>
    <span className="sub">{k}</span>
    <span className="mono" style={{ fontWeight: strong ? 800 : 600, fontSize: strong ? 16 : 14 }}>{v}</span>
  </div>
);

const Caveat = ({ text }: { text: string }) => (
  <p className="sub" style={{ marginTop: 10, fontSize: 12, borderTop: "1px solid var(--border)", paddingTop: 9 }}>
    ⚠️ {text}
  </p>
);

// ── finance / automotive ────────────────────────────────────────────────────
// The loan amount was pre-filled from custom.amount, which only the finance
// pack has. The automotive pack (model, variant, fuel, exchange, finance
// required) carries no price at all, so its EMI box was always blank while the
// code implied it was reading something. Now: the pack's own amount field if
// it has one — `amount`, else its first currency field — and an honest empty
// box with a hint when it has none.
function emiSourceField(fields: FieldDef[]): FieldDef | null {
  return fields.find((f) => f.key === "amount")
    ?? fields.find((f) => f.type === "currency")
    ?? null;
}

function EmiTool({ lead, fields }: { lead: Lead; fields: FieldDef[] }) {
  const source = emiSourceField(fields);
  const prefill = source ? numOf(lead.custom?.[source.key], 0) : 0;
  const [amount, setAmount] = useState(String(prefill || ""));
  const [rate, setRate] = useState("9");
  const [months, setMonths] = useState("60");
  const r = calcEmi(Number(amount), Number(rate), Number(months));

  return (
    <>
      <div className="row" style={{ gap: 9 }}>
        <div style={{ flex: 2 }}>
          <label className="label">Loan amount</label>
          <input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000000" />
          <p className="sub" style={{ fontSize: 11.5, marginTop: 3 }}>
            {prefill
              ? `From this record's ${source!.label}.`
              : "Price less down payment (and any exchange value)."}
          </p>
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Rate %</label>
          <input className="input" type="number" step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Months</label>
          <input className="input" type="number" value={months} onChange={(e) => setMonths(e.target.value)} />
        </div>
      </div>
      {r && (
        <div style={{ marginTop: 12 }}>
          <Row k="Monthly EMI" v={inr(r.emi)} strong />
          <Row k="Total interest" v={inr(r.totalInterest)} />
          <Row k="Total payable" v={inr(r.totalPayable)} />
          <Caveat text={r.caveat} />
        </div>
      )}
    </>
  );
}

// ── real estate ─────────────────────────────────────────────────────────────
function AffordabilityTool() {
  const [income, setIncome] = useState("");
  const [existing, setExisting] = useState("0");
  const r = calcAffordability(Number(income), Number(existing));

  return (
    <>
      <div className="row" style={{ gap: 9 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Monthly net income</label>
          <input className="input" type="number" value={income} onChange={(e) => setIncome(e.target.value)} placeholder="150000" />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Existing EMIs</label>
          <input className="input" type="number" value={existing} onChange={(e) => setExisting(e.target.value)} />
        </div>
      </div>
      {r && (
        <div style={{ marginTop: 12 }}>
          <Row k="Comfortable budget" v={inr(r.comfortable)} strong />
          <Row k="Stretch budget" v={inr(r.stretch)} />
          <Row k="Max EMI" v={`${inr(r.maxEmi)}/mo`} />
          <Caveat text={r.caveat} />
        </div>
      )}
    </>
  );
}

// ── hospital / clinic ───────────────────────────────────────────────────────
function TriageTool({ lead }: { lead: Lead }) {
  const [text, setText] = useState("");
  const r = triage(text || lead.name);

  return (
    <>
      <label className="label">Describe the enquiry in the patient's words</label>
      <textarea
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. severe chest pain since morning"
        style={{ minHeight: 70 }}
      />
      {text.trim() && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 9 }}>
            <span className="pill" style={{ background: `${r.color}1a`, color: r.color, fontSize: 13 }}>
              {r.band === "emergency" ? "🚨" : r.band === "urgent" ? "⚡" : "🗓️"} {r.label}
            </span>
          </div>
          <p style={{ marginTop: 9, marginBottom: 0 }}>{r.advice}</p>
          <Caveat text="Routing aid for front-desk staff only. This is not a clinical assessment and must never replace a qualified clinician's judgement." />
        </div>
      )}
    </>
  );
}

// ── recruitment ─────────────────────────────────────────────────────────────
function CtcTool({ lead }: { lead: Lead }) {
  const [cur, setCur] = useState(String(numOf(lead.custom?.current_ctc, 0) || ""));
  const [exp, setExp] = useState(String(numOf(lead.custom?.expected_ctc, 0) || ""));
  const r = calcCtc(Number(cur), Number(exp));

  return (
    <>
      <div className="row" style={{ gap: 9 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Current CTC (annual)</label>
          <input className="input" type="number" value={cur} onChange={(e) => setCur(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Expected CTC (annual)</label>
          <input className="input" type="number" value={exp} onChange={(e) => setExp(e.target.value)} />
        </div>
      </div>
      {r && (
        <div style={{ marginTop: 12 }}>
          <Row k="Hike" v={`${r.hikePct}%  (${inr(r.hikeAmount)})`} strong />
          <Row k="Current monthly" v={inr(r.monthlyCurrent)} />
          <Row k="Expected monthly" v={inr(r.monthlyExpected)} />
          <p className="sub" style={{ marginTop: 9 }}>{r.verdict}</p>
        </div>
      )}
    </>
  );
}

// ── travel ──────────────────────────────────────────────────────────────────
function TripTool({ lead }: { lead: Lead }) {
  const [land, setLand] = useState("");
  const [flight, setFlight] = useState("");
  const [pax, setPax] = useState(String(numOf(lead.custom?.pax, 2)));
  const [margin, setMargin] = useState("15");
  const r = calcTripCost(Number(land), Number(flight), Number(pax), Number(margin));

  return (
    <>
      <div className="row" style={{ gap: 9 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Land cost (total)</label>
          <input className="input" type="number" value={land} onChange={(e) => setLand(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Flight / head</label>
          <input className="input" type="number" value={flight} onChange={(e) => setFlight(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ gap: 9, marginTop: 9 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Travellers</label>
          <input className="input" type="number" value={pax} onChange={(e) => setPax(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Margin %</label>
          <input className="input" type="number" value={margin} onChange={(e) => setMargin(e.target.value)} />
        </div>
      </div>
      {r && (
        <div style={{ marginTop: 12 }}>
          <Row k="Quote per head" v={inr(r.perHead)} strong />
          <Row k="Cost before margin" v={inr(r.total)} />
          <Row k={`Total with ${r.marginPct}% margin`} v={inr(r.withMargin)} />
        </div>
      )}
    </>
  );
}

// ── study abroad ────────────────────────────────────────────────────────────
function RoiTool({ lead }: { lead: Lead }) {
  const [tuition, setTuition] = useState(String(lead.budget_inr ?? ""));
  const [living, setLiving] = useState("800000");
  const [years, setYears] = useState("2");
  const [salary, setSalary] = useState("");
  const r = calcRoi(Number(tuition), Number(living), Number(years), Number(salary));

  return (
    <>
      <div className="row" style={{ gap: 9 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Tuition (total)</label>
          <input className="input" type="number" value={tuition} onChange={(e) => setTuition(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Living / year</label>
          <input className="input" type="number" value={living} onChange={(e) => setLiving(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ gap: 9, marginTop: 9 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Years</label>
          <input className="input" type="number" value={years} onChange={(e) => setYears(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Expected salary / year</label>
          <input className="input" type="number" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="6000000" />
        </div>
      </div>
      {r && (
        <div style={{ marginTop: 12 }}>
          <Row k="Total cost" v={inr(r.totalCost)} strong />
          {r.paybackYears !== null && <Row k="Payback" v={`${r.paybackYears} years`} />}
          <p className="sub" style={{ marginTop: 9 }}>{r.verdict}</p>
          {r.caveat && <Caveat text={r.caveat} />}
        </div>
      )}
    </>
  );
}

// ── generic quote builder ───────────────────────────────────────────────────
// The pack field a quote total belongs in. Clinic and home-services packs have
// quote_amount; education calls the same thing fee_quoted. Packs with neither
// (fitness) get no save button rather than a write to a field nobody shows.
const QUOTE_FIELD_KEYS = ["quote_amount", "fee_quoted"];

function QuoteTool({ lead, fields, onLeadChange }: {
  lead: Lead; fields: FieldDef[]; onLeadChange?: (lead: Lead) => void;
}) {
  const [lines, setLines] = useState([{ label: "", amount: 0 }]);
  const [discount, setDiscount] = useState("0");
  const [tax, setTax] = useState("18");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ msg: string; err?: boolean } | null>(null);
  const t = quoteTotal(lines, Number(discount), Number(tax));
  const target = QUOTE_FIELD_KEYS.map((k) => fields.find((f) => f.key === k)).find(Boolean) ?? null;

  // The total was computed and then thrown away — the number a customer was
  // just quoted lived only on this screen until someone retyped it into the
  // record. This writes it to the pack's quote field.
  const saveToRecord = async () => {
    if (!target || !(t.total > 0)) return;
    setSaving(true);
    setStatus(null);
    const before = lead.custom ?? {};
    const next = { ...before, [target.key]: t.total };
    // `.select("id")` so a refusal is distinguishable from success: an UPDATE
    // matching no visible row is a 204 with error: null.
    const { data, error } = await supabase.from("leads").update({ custom: next }).eq("id", lead.id).select("id");
    setSaving(false);
    if (error) { setStatus({ msg: error.message, err: true }); return; }
    if (!data?.length) {
      setStatus({ msg: "Not saved — this record is no longer visible to you, or you no longer have permission to change it.", err: true });
      return;
    }
    onLeadChange?.({ ...lead, custom: next });
    setStatus({ msg: `Saved ${inr(t.total)} as this record's ${target.label}.` });
  };

  return (
    <>
      {lines.map((l, i) => (
        <div className="row" style={{ gap: 9, marginBottom: 8 }} key={i}>
          <input
            className="input"
            placeholder="Item"
            value={l.label}
            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
          />
          <input
            className="input"
            type="number"
            placeholder="0"
            style={{ maxWidth: 130 }}
            value={l.amount || ""}
            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))}
          />
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setLines(lines.length === 1 ? [{ label: "", amount: 0 }] : lines.filter((_, j) => j !== i))}
            aria-label="Remove line"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => setLines([...lines, { label: "", amount: 0 }])}>+ Add line</button>

      <div className="row" style={{ gap: 9, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <label className="label">Discount %</label>
          <input className="input" type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label">Tax %</label>
          <input className="input" type="number" value={tax} onChange={(e) => setTax(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <Row k="Subtotal" v={inr(t.subtotal)} />
        {t.discount > 0 && <Row k="Discount" v={`− ${inr(t.discount)}`} />}
        <Row k={`Tax (${tax}%)`} v={inr(t.tax)} />
        <Row k="Total" v={inr(t.total)} strong />
      </div>
      {target && (
        <div className="row" style={{ marginTop: 10, gap: 9, alignItems: "center" }}>
          <button
            className={`btn btn-sm${saving ? " btn-busy" : ""}`}
            onClick={() => void saveToRecord()}
            disabled={saving || !(t.total > 0)}
          >
            {saving ? "Saving…" : `Save to record (${target.label})`}
          </button>
          {status && (
            <span className="sub" style={{ fontSize: 12, color: status.err ? "var(--red)" : undefined }}>
              {status.msg}
            </span>
          )}
        </div>
      )}
    </>
  );
}
