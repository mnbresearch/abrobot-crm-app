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

    // Vite's default target ("modules") assumes Chrome 87+, so it emits `??=`
    // and `?.` natively. Any Android System WebView still on Chrome 84 or
    // below — common on Android 7/8 handsets and the cheap tablets used at
    // clinic and coaching-centre front desks — hits a SyntaxError at PARSE
    // time. That is not a degraded experience: it is a blank white page,
    // before a single line of our code runs, with nothing to explain it.
    // Downlevelling costs a few KB and removes the entire failure class.
    target: "es2017",

    // "hidden" still generates the maps (so a stack trace can be symbolicated)
    // but strips the //# sourceMappingURL comment, so browsers don't fetch
    // them and Cloudflare isn't serving 3.7 MB of our commented TypeScript to
    // anyone who asks. The maps were being published: every incident
    // post-mortem written in these comments was publicly readable.
    // Upload them to an error tracker instead of the CDN.
    sourcemap: "hidden",

    rollupOptions: {
      output: {
        // The `react` chunk used to be EMPTY (44 bytes — just a sourcemap
        // comment). With jsx: "react-jsx" the app imports react/jsx-runtime,
        // which wasn't listed, so Rollup folded React into the index chunk and
        // the long-term-cacheable vendor chunk never existed.
        //
        // `charts` is still split, but note it is NOT lazy: App.tsx statically
        // imports Dashboard and Reports, so Vite modulepreloads all ~560 KB of
        // recharts before the login form paints. Fixing that needs React.lazy
        // at the route level — a code change, not a config one.
        manualChunks: {
          react: ["react", "react-dom", "react/jsx-runtime"],
          charts: ["recharts"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
