/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Origin the customer-facing widget snippet points at, e.g.
   * "https://crm.mnbresearch.com". Set this per deployment; it must be a
   * permanent public host, because it ends up inside a <script src> tag on
   * other companies' websites. Settings falls back to the production domain
   * when it is unset, which is what stops a preview or localhost URL being
   * handed out. No trailing slash needed — it is stripped.
   */
  readonly VITE_WIDGET_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
