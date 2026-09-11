import { useEffect, useState } from "react";

// Theme handling.
//
// Three states, not two: "system" is the default because most people have
// already told their OS what they want, and asking again is a small rudeness.
// Only an explicit choice is persisted.

export type Theme = "light" | "dark" | "system";
const KEY = "abrobot-theme";

// localStorage THROWS rather than returning null in Safari Lockdown Mode, in a
// third-party iframe with storage blocked, and with site data disabled.
// main.tsx already wraps initTheme() for exactly this reason and says so — but
// useTheme() was left unguarded, and it runs during App's first render. An
// exception there is thrown inside the render phase, which the ErrorBoundary
// catches and turns into "Something went wrong" for the WHOLE app; Reload does
// nothing, because the next render throws in the same place. A wrong theme is a
// rounding error. A permanently dead app is not.
function readStored(): Theme | null {
  try {
    return (localStorage.getItem(KEY) as Theme | null) ?? null;
  } catch {
    return null;
  }
}

function writeStored(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // The preference simply does not persist across reloads here. The theme
    // still applies for this session, which is the part the user can see.
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function resolveTheme(t: Theme): "light" | "dark" {
  return t === "system" ? (systemPrefersDark() ? "dark" : "light") : t;
}

export function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", resolveTheme(t));
}

/** Read the stored preference before React mounts, to avoid a flash. */
export function initTheme(): Theme {
  const stored = readStored() ?? "system";
  applyTheme(stored);
  return stored;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? "system");

  useEffect(() => {
    applyTheme(theme);
    writeStored(theme);
  }, [theme]);

  // Follow the OS live while on "system" — someone using automatic
  // light/dark at sunset should see this app change with everything else.
  useEffect(() => {
    if (theme !== "system") return;
    // Optional-chained for the same reason as the storage guards above:
    // resolveTheme() already treats a missing matchMedia as "light", so this
    // must not be the one line that still throws in a locked-down browser.
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const cycle = () => setTheme((t) => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));

  return { theme, setTheme, cycle, resolved: resolveTheme(theme) };
}
