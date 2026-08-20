import { useEffect, useState } from "react";
import { Modal } from "./ui";

// Keyboard shortcuts, opened with "?" — the convention in every tool that
// respects power users. Navigation shortcuts are single letters after "g",
// which is the pattern people already know from GitHub, Linear and Gmail.

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Search records and jump anywhere" },
  { keys: ["g", "d"], label: "Go to dashboard" },
  { keys: ["g", "l"], label: "Go to records" },
  { keys: ["g", "p"], label: "Go to pipeline" },
  { keys: ["g", "c"], label: "Go to calendar" },
  { keys: ["g", "r"], label: "Go to reports" },
  { keys: ["g", "s"], label: "Go to settings" },
  { keys: ["t"], label: "Toggle light / dark / system" },
  { keys: ["?"], label: "Show this list" },
  { keys: ["esc"], label: "Close anything open" },
];

export function ShortcutsHelp({ navigate, cycleTheme }: { navigate: (to: string) => void; cycleTheme: () => void }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // "g" then a letter. The buffer resets after a second so a stray "g"
    // doesn't silently arm a jump minutes later.
    let awaitingG = false;
    let timer: number | undefined;

    const isTyping = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") { e.preventDefault(); setOpen(true); return; }

      if (awaitingG) {
        awaitingG = false;
        window.clearTimeout(timer);
        const map: Record<string, string> = {
          d: "/", l: "/leads", p: "/pipeline", c: "/calendar",
          r: "/reports", s: "/settings", a: "/automations", t: "/team",
        };
        const dest = map[e.key.toLowerCase()];
        if (dest) { e.preventDefault(); navigate(dest); }
        return;
      }

      if (e.key.toLowerCase() === "g") {
        awaitingG = true;
        timer = window.setTimeout(() => { awaitingG = false; }, 1000);
        return;
      }

      if (e.key.toLowerCase() === "t") { e.preventDefault(); cycleTheme(); }
    };

    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.clearTimeout(timer); };
  }, [navigate, cycleTheme]);

  if (!open) return null;

  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)}>
      {SHORTCUTS.map((s) => (
        <div
          key={s.label}
          className="row"
          style={{ justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)" }}
        >
          <span>{s.label}</span>
          <span className="row" style={{ gap: 4 }}>
            {s.keys.map((k) => <span key={k} className="kbd">{k}</span>)}
          </span>
        </div>
      ))}
      <p className="sub" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        Shortcuts are ignored while you're typing in a field.
      </p>
    </Modal>
  );
}
