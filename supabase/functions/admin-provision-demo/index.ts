// AbroBot CRM — Super Admin 7-Day Demo Account Provisioner.
// Deploy: supabase functions deploy admin-provision-demo
//
// POST {
//   name: string,
//   slug?: string,
//   industry: string,
//   admin_email: string,
//   admin_name?: string,
//   duration_days?: number,
//   base_plan?: string,
//   features: Record<string, any>,
//   seed_demo_data?: boolean
// }
//
// Requires Super Admin authentication.

import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing auth" }, 401);

  const { data: userData, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !userData?.user) return json({ error: "invalid session" }, 401);

  const { data: callerProfile, error: profErr } = await admin
    .from("profiles")
    .select("id, org_id, role, status, email, full_name")
    .eq("id", userData.user.id)
    .single();

  if (profErr || !callerProfile || callerProfile.status !== "active" || callerProfile.role !== "super_admin") {
    return json({ error: "super admin only" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "malformed JSON payload" }, 400);
  }

  const {
    name,
    slug: rawSlug,
    industry = "study_abroad",
    admin_email,
    admin_name,
    duration_days = 7,
    base_plan = "growth",
    features = {},
    seed_demo_data = true,
  } = body;

  const cleanName = (name ?? "").trim();
  if (cleanName.length < 2) {
    return json({ error: "Organization name must be at least 2 characters" }, 400);
  }

  const cleanEmail = (admin_email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    return json({ error: "A valid admin email is required" }, 400);
  }

  // 1. Try calling the PostgreSQL RPC first if migration is active
  try {
    const { data: rpcData, error: rpcErr } = await admin.rpc("admin_provision_demo_org", {
      p_name: cleanName,
      p_slug: rawSlug || null,
      p_industry: industry,
      p_admin_email: cleanEmail,
      p_admin_name: admin_name || null,
      p_duration_days: duration_days,
      p_base_plan: base_plan,
      p_features: features,
      p_seed_demo_data: seed_demo_data,
    });

    if (!rpcErr && rpcData?.ok) {
      return json(rpcData);
    }
  } catch {
    // Fall back to direct service role execution below
  }

  // 2. Direct Service-Role Provisioning Fallback
  const baseSlug = (rawSlug || cleanName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "demo";

  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const { data: existing } = await admin.from("organizations").select("id").eq("slug", slug).maybeSingle();
    if (!existing) break;
    counter++;
    slug = `${baseSlug}-${counter}`;
    if (counter > 500) {
      slug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
      break;
    }
  }

  const expiry = new Date(Date.now() + Math.max(1, duration_days) * 86400 * 1000).toISOString();

  // Create organization
  const { data: newOrg, error: orgErr } = await admin
    .from("organizations")
    .insert({
      name: cleanName,
      slug,
      active: true,
      plan: base_plan,
      trial_started_at: new Date().toISOString(),
      trial_days: Math.max(1, duration_days),
      credits_total: 0,
      credits_used: 0,
      industry_slug: industry,
      custom: {
        is_demo: true,
        must_upgrade: true,
        trial_duration_days: Math.max(1, duration_days),
        demo_expires_at: expiry,
        features,
      },
    })
    .select("*")
    .single();

  if (orgErr || !newOrg) {
    return json({ error: `Failed to create organization: ${orgErr?.message}` }, 500);
  }

  // Create subscription
  await admin.from("subscriptions").insert({
    org_id: newOrg.id,
    plan: base_plan,
    status: "active",
    current_period_end: expiry,
  });

  // Create agent config
  await admin.from("agent_config").insert({
    org_id: newOrg.id,
    enabled: features.ai_enabled !== false,
    agent_name: `${cleanName} AI Concierge`,
    welcome_message: `Hello! Welcome to ${cleanName}. How can our team assist you today?`,
    knowledge: "Enterprise AI concierge with strict zero-code guardrails.",
    onboarded: false,
  });

  // Apply industry pack stages and field defs
  try {
    await admin.rpc("apply_industry_pack", { p_org_id: newOrg.id, p_slug: industry });
  } catch (err) {
    console.warn("apply_industry_pack fallback warning:", err);
  }

  // Handle user invite & profile link
  const { data: existingProf } = await admin.from("profiles").select("id, org_id").eq("email", cleanEmail).maybeSingle();
  if (existingProf && !existingProf.org_id) {
    await admin.from("profiles").update({
      org_id: newOrg.id,
      full_name: admin_name?.trim() || null,
      role: "org_admin",
      status: "active",
    }).eq("id", existingProf.id);
  }

  await admin.from("invites").insert({
    org_id: newOrg.id,
    email: cleanEmail,
    role: "org_admin",
    invited_by: callerProfile.id,
  });

  // Seed sample data if requested
  let leadsCount = 0;
  if (seed_demo_data) {
    const { data: stages } = await admin
      .from("pipeline_stages")
      .select("key")
      .eq("org_id", newOrg.id)
      .order("position");

    const s0 = stages?.[0]?.key || "new";
    const s1 = stages?.[1]?.key || s0;
    const s2 = stages?.[2]?.key || s1;
    const s3 = stages?.[3]?.key || s2;
    const s4 = stages?.[4]?.key || s3;

    const sampleLeads = [
      {
        org_id: newOrg.id,
        name: "Aarav Sharma",
        email: "aarav.sharma@example.com",
        phone: "+919820112345",
        source: "website",
        stage_key: s0,
        score: 88,
        budget_inr: 1800000,
        tags: ["high-intent", "inbound-web"],
        next_follow_up_at: new Date(Date.now() + 86400 * 1000).toISOString(),
      },
      {
        org_id: newOrg.id,
        name: "Priya Patel",
        email: "priya.patel@example.com",
        phone: "+919876543210",
        source: "whatsapp",
        stage_key: s1,
        score: 76,
        budget_inr: 1200000,
        tags: ["whatsapp", "verified"],
        next_follow_up_at: new Date(Date.now() + 2 * 86400 * 1000).toISOString(),
      },
      {
        org_id: newOrg.id,
        name: "Rohan Verma",
        email: "rohan.v@example.com",
        phone: "+919123456789",
        source: "referral",
        stage_key: s2,
        score: 92,
        budget_inr: 2500000,
        tags: ["priority", "counselling-booked"],
        next_follow_up_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
      },
      {
        org_id: newOrg.id,
        name: "Ananya Iyer",
        email: "ananya.iyer@example.com",
        phone: "+919988776655",
        source: "meta",
        stage_key: s3,
        score: 84,
        budget_inr: 1500000,
        tags: ["application-lodged", "meta-campaign"],
        next_follow_up_at: new Date(Date.now() + 3 * 86400 * 1000).toISOString(),
      },
      {
        org_id: newOrg.id,
        name: "Vikram Malhotra",
        email: "vikram.m@example.com",
        phone: "+919765432109",
        source: "google",
        stage_key: s4,
        score: 98,
        budget_inr: 3200000,
        tags: ["closed-won", "contract-signed"],
      },
      {
        org_id: newOrg.id,
        name: "Kavita Reddy",
        email: "kavita.r@example.com",
        phone: "+919654321098",
        source: "walk_in",
        stage_key: s1,
        score: 62,
        budget_inr: 900000,
        tags: ["nurture-active"],
        next_follow_up_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
      },
    ];

    const { data: insertedLeads } = await admin.from("leads").insert(sampleLeads).select("id, name");
    if (insertedLeads) {
      leadsCount = insertedLeads.length;
      for (const ld of insertedLeads) {
        await admin.from("activities").insert({
          org_id: newOrg.id,
          lead_id: ld.id,
          type: "note",
          content: `Initial inquiry and activity record initialized for demo evaluation of ${ld.name}.`,
        });
      }
    }
  }

  // Audit log
  await admin.from("admin_audit").insert({
    actor_id: callerProfile.id,
    actor_email: callerProfile.email,
    action: "create_demo_org",
    org_id: newOrg.id,
    detail: {
      name: cleanName,
      slug,
      industry,
      admin_email: cleanEmail,
      duration_days: Math.max(1, duration_days),
      features,
      leads_seeded: leadsCount,
    },
  });

  return json({
    ok: true,
    org_id: newOrg.id,
    name: newOrg.name,
    slug: newOrg.slug,
    industry,
    admin_email: cleanEmail,
    admin_name,
    duration_days: Math.max(1, duration_days),
    expires_at: expiry,
    features,
    leads_seeded: leadsCount,
  });
});
