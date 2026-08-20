import { useEffect, useState } from "react";

// Theme handling.
//
// Three states, not two: "system" is the default because most people have
// already told their OS what they want, and asking again is a small rudeness.
// Only an explicit choice is persisted.

export type Theme = "light" | "dark" | "system";
const KEY = "abrobot-theme";

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
  const stored = (localStorage.getItem(KEY) as Theme | null) ?? "system";
  applyTheme(stored);
  return stored;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme | null) ?? "system");

  useEffect(() => {
    applyTheme(theme);
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  }, [theme]);

  // Follow the OS live while on "system" — someone using automatic
  // light/dark at sunset should see this app change with everything else.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const cycle = () => setTheme((t) => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));

  return { theme, setTheme, cycle, resolved: resolveTheme(theme) };
}
