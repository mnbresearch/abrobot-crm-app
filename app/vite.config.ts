import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Assets use absolute paths because the app is served behind an SPA fallback
// (`/*  /index.html  200`) — the same _redirects rule the legacy bundle uses.
// A relative base breaks nested routes like /leads/:id, which is exactly the
// bug fixed in the legacy app's "v17: fix nested-route blank page" deploy.
export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    sourcemap: true, // the whole point of this rebuild — never lose source again
    rollupOptions: {
      output: {
        // Charts are ~60% of the bundle and only the dashboard needs them.
        // Splitting keeps first paint on the leads list fast.
        manualChunks: {
          react: ["react", "react-dom"],
          charts: ["recharts"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
