import { useCallback, useEffect, useState } from "react";

// Minimal popstate router, matching the legacy app's approach (it also used a
// hand-rolled router rather than react-router). Keeping the same model means
// URLs stay identical during the takeover, so a user's bookmarks and the old
// app's links keep working whichever frontend serves them.

export function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    // Push the full target (query and all) but route on the PATHNAME only.
    //
    // This used to do `setPath(to)` with whatever string it was handed. App.tsx
    // routes on exact equality, so `navigate("/settings?tab=install")` set path
    // to a value that matched no route and failed isKnown() — the shell
    // rendered "Page not found" while the topbar, which matches with
    // startsWith, still said "Settings". Four of the seven onboarding CTAs
    // landed there, so a brand-new customer's first clicks looked like a broken
    // deploy.
    //
    // onPop already reads window.location.pathname, which is why navigating by
    // hand elsewhere in the app worked and this did not.
    const url = new URL(to, window.location.origin);
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    window.history.pushState({}, "", to);
    setPath(url.pathname);
    window.scrollTo(0, 0);
  }, []);

  return { path, navigate };
}

/** Matches "/leads/:id" style patterns. Returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}
