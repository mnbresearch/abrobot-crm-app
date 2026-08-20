import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider } from "./lib/store";
import { initTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/app.css";

// Applied before the first paint so there is no flash of the wrong theme —
// the detail that separates apps that feel considered from ones that don't.
initTheme();

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");

createRoot(el).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
