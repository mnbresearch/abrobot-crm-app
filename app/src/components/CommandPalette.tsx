import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import { supabase } from "../lib/supabase";
import type { Lead } from "../lib/types";

// ⌘K palette. Search every record and jump anywhere without touching the
// mouse. The single highest-leverage piece of UI in a tool people live in all
// day — the difference between "a CRM I have to navigate" and "a CRM I drive".

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

export function CommandPalette({ navigate }: { navigate: (to: string) => void }) {
  const { org, ui, isAdmin } = useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Lead[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open on ⌘K / Ctrl+K, close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setResults([]);
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  // Debounced record search. 250ms is long enough to avoid a request per
  // keystroke, short enough that it still feels instant.
  useEffect(() => {
    if (!open || !org || q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      const term = q.trim().replace(/[%,()]/g, "");
      const { data } = await supabase
        .from("leads")
        .select("id, name, email, phone, score, stage_key, stage")
        .eq("org_id", org.id)
        .or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
        .limit(8);
      setResults((data as Lead[]) ?? []);
      setCursor(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, org]);

  const nav: Item[] = useMemo(() => {
    const go = (path: string, label: string, icon: string): Item => ({
      id: path, label, icon, hint: "Go to", run: () => { navigate(path); setOpen(false); },
    });
    const items = [
      go("/", "Dashboard", "📊"),
      go("/leads", ui.leadNounPlural, "👥"),
      go("/pipeline", "Pipeline", "🔀"),
      go("/calendar", "Calendar", "📅"),
      go("/conversations", "Conversations", "💬"),
      go("/templates", "Templates", "📄"),
      go("/reports", "Reports", "📈"),
      go("/activity", "Activity", "🗂️"),
      go("/team", "Team", "🧑‍🤝‍🧑"),
    ];
    if (isAdmin) {
      items.push(go("/automations", "Automations", "⚡"), go("/import", "Import", "📥"), go("/settings", "Settings", "⚙️"));
    }
    return items;
  }, [navigate, ui.leadNounPlural, isAdmin]);

  const filteredNav = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return nav;
    return nav.filter((n) => n.label.toLowerCase().includes(term));
  }, [nav, q]);

  const recordItems: Item[] = results.map((l) => ({
    id: l.id,
    label: l.name,
    hint: l.phone ?? l.email ?? undefined,
    icon: ui.icon,
    run: () => { navigate(`/leads/${l.id}`); setOpen(false); },
  }));

  const all = [...recordItems, ...filteredNav];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, all.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); all[cursor]?.run(); }
  };

  if (!open) return null;

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: "fixed", inset: 0, background: "rgba(28,25,23,.4)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: "12vh", zIndex: 60,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 560, padding: 0, overflow: "hidden" }}
      >
        <input
          ref={inputRef}
          className="input"
          style={{ border: "none", borderRadius: 0, borderBottom: "1px solid var(--border)", padding: "15px 17px", fontSize: 15 }}
          placeholder={`Search ${ui.leadNounPlural.toLowerCase()} or jump to a page…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div style={{ maxHeight: "52vh", overflowY: "auto", padding: 7 }}>
          {all.length === 0 && (
            <div className="sub" style={{ padding: 22, textAlign: "center" }}>
              {q.trim().length < 2 ? "Type at least two characters" : "Nothing found"}
            </div>
          )}

          {recordItems.length > 0 && <div className="nav-group" style={{ paddingTop: 6 }}>{ui.leadNounPlural}</div>}
          {all.map((item, i) => {
            const isNavStart = i === recordItems.length && recordItems.length > 0;
            return (
              <div key={`${item.id}-${i}`}>
                {isNavStart && <div className="nav-group">Go to</div>}
                <button
                  className="nav-item"
                  style={{ background: i === cursor ? "var(--industry-soft)" : undefined }}
                  onMouseEnter={() => setCursor(i)}
                  onClick={item.run}
                >
                  <span className="ico">{item.icon}</span>
                  <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>
                  {item.hint && <span className="sub" style={{ fontSize: 12 }}>{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="row" style={{ padding: "9px 15px", borderTop: "1px solid var(--border)", gap: 13 }}>
          <span className="sub" style={{ fontSize: 11.5 }}>↑↓ navigate</span>
          <span className="sub" style={{ fontSize: 11.5 }}>⏎ open</span>
          <span className="sub" style={{ fontSize: 11.5 }}>esc close</span>
        </div>
      </div>
    </div>
  );
}
