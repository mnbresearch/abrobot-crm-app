import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { FieldDef, Lead, PipelineStage } from "../lib/types";

export function Spinner() {
  return (
    <div className="center">
      <div className="spin" />
    </div>
  );
}

export function Card({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || action) && (
        <div className="card-title">
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Empty({ icon = "📭", title, hint, action }: { icon?: string; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div style={{ fontWeight: 700, color: "var(--ink)" }}>{title}</div>
      {hint && <div className="sub" style={{ marginTop: 5, maxWidth: 420, marginInline: "auto" }}>{hint}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function Toast({ msg, err, onDone }: { msg: string; err?: boolean; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className={`toast${err ? " err" : ""}`}>{msg}</div>;
}

export function useToast() {
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const node = toast ? <Toast msg={toast.msg} err={toast.err} onDone={() => setToast(null)} /> : null;
  return {
    node,
    show: (msg: string) => setToast({ msg }),
    error: (msg: string) => setToast({ msg, err: true }),
  };
}

/** Score chip. Colour bands chosen to match the scoring model's intent:
 *  70+ is "call them now", 40–69 "worth working", below 40 "nurture". */
export function ScoreChip({ score }: { score: number }) {
  const color = score >= 70 ? "var(--green)" : score >= 40 ? "var(--amber)" : "var(--muted)";
  return (
    <span className="score" title={`Lead score ${score}/100`}>
      <span className="score-bar">
        <span className="score-fill" style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color }} />
      </span>
      <span className="mono" style={{ fontWeight: 700, fontSize: 12.5, color }}>{score}</span>
    </span>
  );
}

export function StagePill({ stageKey, stages }: { stageKey: string; stages: PipelineStage[] }) {
  const s = stages.find((x) => x.key === stageKey);
  if (!s) return <span className="pill pill-muted">{stageKey}</span>;
  const cls = s.is_won ? "pill pill-green" : s.is_lost ? "pill pill-red" : "pill";
  return <span className={cls} style={s.color ? { background: `${s.color}22`, color: s.color } : undefined}>{s.label}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(28,25,23,.45)",
        display: "grid", placeItems: "center", zIndex: 40, padding: 18,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: wide ? 720 : 460, maxHeight: "88vh", overflowY: "auto" }}
      >
        <div className="card-title">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Renders one custom field definition as an input. */
export function FieldInput({
  def, value, onChange,
}: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const v = value ?? "";

  if (def.type === "textarea") {
    return <textarea className="textarea" value={String(v)} onChange={(e) => onChange(e.target.value)} />;
  }
  if (def.type === "select") {
    return (
      <select className="select" value={String(v)} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (def.type === "multiselect") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="row-wrap">
        {def.options.map((o) => {
          const on = arr.includes(o);
          return (
            <button
              key={o}
              type="button"
              className={on ? "pill" : "pill pill-muted"}
              style={{ border: "none", cursor: "pointer" }}
              onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])}
            >
              {o}
            </button>
          );
        })}
      </div>
    );
  }
  if (def.type === "checkbox") {
    return (
      <label className="row" style={{ cursor: "pointer" }}>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        <span className="sub">{def.label}</span>
      </label>
    );
  }

  const inputType =
    def.type === "number" || def.type === "currency" ? "number"
    : def.type === "date" ? "date"
    : def.type === "email" ? "email"
    : def.type === "phone" ? "tel"
    : def.type === "url" ? "url"
    : "text";

  return (
    <input
      className="input"
      type={inputType}
      value={String(v)}
      onChange={(e) => onChange(def.type === "number" || def.type === "currency" ? Number(e.target.value) : e.target.value)}
    />
  );
}

/** Resolve a column key against a lead — built-in column or custom field. */
export function cellValue(lead: Lead, key: string): string {
  switch (key) {
    case "name": return lead.name;
    case "email": return lead.email ?? "—";
    case "phone": return lead.phone ?? "—";
    case "source": return lead.source;
    case "target_country": return lead.target_country ?? "—";
    case "course": return lead.course ?? "—";
    case "course_level": return lead.course_level ?? "—";
    case "intake": return lead.intake ?? "—";
    case "budget_inr": return lead.budget_inr ? `₹${Number(lead.budget_inr).toLocaleString("en-IN")}` : "—";
    default: {
      const v = lead.custom?.[key];
      if (v === undefined || v === null || v === "") return "—";
      if (Array.isArray(v)) return v.join(", ");
      if (typeof v === "boolean") return v ? "Yes" : "No";
      if (typeof v === "number" && /amount|budget|ctc|value|fee|quote|mrr/.test(key)) {
        return `₹${v.toLocaleString("en-IN")}`;
      }
      return String(v);
    }
  }
}

export function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
