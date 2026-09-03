import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider } from "./lib/store";
import { initTheme } from "./lib/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/tokens.css";
import "./styles/app.css";

// Applied before the first paint so there is no flash of the wrong theme —
// the detail that separates apps that feel considered from ones that don't.
//
// Wrapped because it touches localStorage, and localStorage THROWS (rather
// than returning null) in Safari Lockdown Mode, in a third-party iframe with
// storage blocked, and with site data disabled. This runs before createRoot,
// so an exception here means nothing renders at all — not even the error
// boundary below. A wrong theme is a rounding error; a blank page is not.
try {
  initTheme();
} catch (e) {
  console.error("initTheme failed, continuing with the default theme:", e);
}

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <App />
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
