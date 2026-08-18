import { createClient } from "@supabase/supabase-js";

// The publishable key is designed to be shipped in the browser; RLS is what
// enforces tenancy. Read from env so staging/prod can differ — the legacy
// bundle hardcoded these, which is part of why the project ref had to be
// archaeologically recovered from a minified file.
const url = import.meta.env.VITE_SUPABASE_URL ?? "https://pomsltnrxvbcafwtbtlc.supabase.co";
const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable__p-fQqmGXL0dPB5InuCznQ_U0NxtXIc";

export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const FUNCTIONS_BASE = `${url}/functions/v1`;

/** Call an edge function with the current user's access token attached. */
export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `${name} failed (${res.status})`);
  return json as T;
}
