import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { FieldDef, Lead, PipelineStage } from "../lib/types";

export function Spinner() {
  return (
    <div className="center">
      <div className="spin" />
    </div>
  );
}

/**
 * Skeleton shaped like the content that's coming.
 *
 * A skeleton that matches the eventual layout reads as "nearly there"; a
 * centred spinner reads as "something might be wrong", because it carries no
 * information about what you're waiting for.
 */
export function Skeleton({ kind = "page" }: { kind?: "page" | "table" | "cards" }) {
  if (kind === "table") {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading">
        <div className="skel skel-line" style={{ width: 180, height: 22 }} />
        <div className="table-wrap" style={{ padding: 14 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skel skel-row" style={{ opacity: 1 - i * 0.13 }} />
          ))}
        </div>
      </div>
    );
  }
  if (kind === "cards") {
    return (
      <div className="grid grid-2" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skel" style={{ height: 148, borderRadius: "var(--radius)" }} />
        ))}
      </div>
    );
  }
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      <div className="skel skel-line" style={{ width: 220, height: 26 }} />
      <div className="grid grid-kpi">
        {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skel skel-kpi" />)}
      </div>
      <div className="skel" style={{ height: 240, borderRadius: "var(--radius)" }} />
    </div>
  );
}

/**
 * Count-up number.
 *
 * Only animates when the value actually changes, and never on a re-render with
 * the same value — a KPI that re-rolls every time you blink is noise, not
 * delight. Respects prefers-reduced-motion by jumping straight to the value.
 */
export function AnimatedNumber({ value, duration = 620 }: { value: string; duration?: number }) {
  const numeric = Number(String(value).replace(/[^\d.-]/g, ""));
  const animatable = Number.isFinite(numeric) && Math.abs(numeric) > 0 && /^[\d,.\s]+%?$/.test(value.trim());
  const [shown, setShown] = useState(animatable ? 0 : numeric);

  // Tracks what is currently on screen, so a re-triggered animation resumes
  // from there rather than snapping back to zero.
  //
  // An earlier version guarded with `if (prev.current === target) return`,
  // which broke badly under React StrictMode: the first effect pass started
  // the animation and was immediately cleaned up, the second pass saw the
  // target unchanged and bailed, and every KPI sat at 0 permanently. On a CRM
  // dashboard that reads as "you have no leads" — the most damaging possible
  // failure, and one a screenshot mid-animation looks fine in.
  //
  // The rule this encodes: an effect must be safe to run twice. Guarding on
  // "did I already start" is exactly the assumption StrictMode exists to break.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    if (!animatable) { setShown(numeric); return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setShown(numeric); return; }

    const from = shownRef.current;
    if (from === numeric) return;

    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo — quick off the mark, settles gently. Matches --ease-out.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setShown(from + (numeric - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Land on the exact value even if the frame loop is interrupted — a
    // counter that stops at 10.97 and renders "11" by luck is not good enough.
    return () => { cancelAnimationFrame(raf); setShown(numeric); };
  }, [numeric, animatable, duration]);

  if (!animatable) return <>{value}</>;
  const suffix = value.trim().endsWith("%") ? "%" : "";
  return <>{Math.round(shown).toLocaleString("en-IN")}{suffix}</>;
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

/**
 * Shown when data could not be loaded — never an <Empty>.
 *
 * The distinction matters more than it looks. "You have no records" and "we
 * could not reach the server" look identical to a user, but one of them means
 * their data is gone. Rendering a failed request as a tidy empty state is how
 * a customer with 4,000 leads gets told they have none, believes it, and
 * calls support.
 */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card" style={{ borderColor: "var(--red)" }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <span style={{ fontSize: 22 }}>⚠️</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>Couldn't load your data</div>
          <p className="sub" style={{ marginTop: 4 }}>
            Nothing has been lost — this screen just can't reach the server right now.
            {message ? ` (${message})` : ""}
          </p>
        </div>
        {onRetry && <button className="btn btn-sm btn-primary" onClick={onRetry}>Retry</button>}
      </div>
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal-card"
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
