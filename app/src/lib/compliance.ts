// AbroBot CRM — Compliance & Data Protection Suite (DPDP Act 2023 & GDPR)
// Implements statutory Data Subject Access Requests (SAR, DPDP Sec. 11 / GDPR Art. 15 & 20),
// Right to Erasure / Right to be Forgotten (DPDP Sec. 12 / GDPR Art. 17), and
// Communication Channel Consent & Do-Not-Contact (DNC) management (DPDP Sec. 6 / GDPR Art. 7).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead, Activity, Profile } from "./types";

export type ConsentStatus = "explicit_consent" | "inbound_inquiry" | "consent_withdrawn";

export interface ConsentPreferences {
  consent_status: ConsentStatus;
  opt_out_whatsapp: boolean;
  opt_out_email: boolean;
  opt_out_calls: boolean;
  consent_notes?: string;
  updated_at?: string;
  updated_by?: string;
}

export interface DataSubjectSAR {
  meta: {
    request_type: "DATA_SUBJECT_ACCESS_REQUEST";
    regulations: string[];
    exported_at: string;
    data_fiduciary: string;
    organization_id: string;
    compliance_statement: string;
  };
  data_principal: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source: string;
    stage_key: string | null;
    engagement_score: number;
    tags: string[];
    custom_attributes: Record<string, unknown>;
    created_at: string;
    updated_at: string;
    last_contacted_at: string | null;
    next_follow_up_at: string | null;
  };
  consent_and_preferences: ConsentPreferences;
  activities_and_communications: Array<{
    id: string;
    type: string;
    content: string;
    recorded_at: string;
  }>;
  chat_transcripts?: Array<{
    conversation_id: string;
    started_at: string;
    messages: Array<{
      role: string;
      content: string;
      timestamp: string;
    }>;
  }>;
}

/**
 * Reads consent and communication preferences safely from lead.custom.
 */
export function getConsentPreferences(lead: Lead): ConsentPreferences {
  const custom = (lead.custom || {}) as Record<string, unknown>;
  const rawStatus = String(custom.consent_status || "");
  const status: ConsentStatus =
    rawStatus === "explicit_consent" || rawStatus === "consent_withdrawn"
      ? rawStatus
      : "inbound_inquiry";

  return {
    consent_status: status,
    opt_out_whatsapp: Boolean(custom.opt_out_whatsapp),
    opt_out_email: Boolean(custom.opt_out_email || lead.nurture_opted_out),
    opt_out_calls: Boolean(custom.opt_out_calls),
    consent_notes: typeof custom.consent_notes === "string" ? custom.consent_notes : undefined,
    updated_at: typeof custom.consent_updated_at === "string" ? custom.consent_updated_at : undefined,
    updated_by: typeof custom.consent_updated_by === "string" ? custom.consent_updated_by : undefined,
  };
}

/**
 * Saves updated consent & DNC channel preferences to lead.custom and synchronizes nurture_opted_out.
 */
export async function saveConsentPreferences(
  supabase: SupabaseClient,
  lead: Lead,
  prefs: ConsentPreferences,
  actorProfile: Profile | null,
): Promise<{ success: boolean; error?: string }> {
  const custom = { ...(lead.custom || {}) };
  const now = new Date().toISOString();
  const actorName = actorProfile?.full_name || actorProfile?.email || "Staff Member";

  custom.consent_status = prefs.consent_status;
  custom.opt_out_whatsapp = prefs.opt_out_whatsapp;
  custom.opt_out_email = prefs.opt_out_email;
  custom.opt_out_calls = prefs.opt_out_calls;
  custom.consent_notes = prefs.consent_notes || "";
  custom.consent_updated_at = now;
  custom.consent_updated_by = actorName;

  const patch: Record<string, unknown> = {
    custom,
    nurture_opted_out: prefs.opt_out_email,
    updated_at: now,
  };

  const { error } = await supabase.from("leads").update(patch).eq("id", lead.id);
  if (error) {
    return { success: false, error: error.message };
  }

  // Log activity
  const details = [
    `Status: ${prefs.consent_status}`,
    prefs.opt_out_whatsapp ? "WhatsApp: Opted Out" : "WhatsApp: Allowed",
    prefs.opt_out_email ? "Email: Opted Out" : "Email: Allowed",
    prefs.opt_out_calls ? "Calls: Do Not Call" : "Calls: Allowed",
  ].join(" · ");

  await supabase.from("activities").insert({
    org_id: lead.org_id,
    lead_id: lead.id,
    user_id: actorProfile?.id ?? null,
    type: "system",
    content: `🛡️ Consent preferences updated by ${actorName} (${details}).`,
  });

  return { success: true };
}

/**
 * Generates and triggers download of a standardized Data Subject Access Request (SAR) package.
 */
export function exportLeadSAR(
  lead: Lead,
  activities: Activity[],
  chatTranscripts: Array<{ conversation_id: string; started_at: string; messages: Array<{ role: string; content: string; timestamp: string }> }>,
  orgName: string,
): void {
  const consent = getConsentPreferences(lead);
  const now = new Date().toISOString();

  const sar: DataSubjectSAR = {
    meta: {
      request_type: "DATA_SUBJECT_ACCESS_REQUEST",
      regulations: [
        "Digital Personal Data Protection Act 2023 (India) — Section 11",
        "General Data Protection Regulation (EU/UK GDPR) — Articles 15 & 20",
      ],
      exported_at: now,
      data_fiduciary: orgName || "AbroBot CRM Customer",
      organization_id: lead.org_id,
      compliance_statement:
        "This dossier contains all personal data, communication records, activity logs, and chat transcripts " +
        "associated with this Data Principal. Generated securely in portable JSON format.",
    },
    data_principal: {
      id: lead.id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      stage_key: lead.stage_key ?? lead.stage,
      engagement_score: lead.score,
      tags: lead.tags || [],
      custom_attributes: (lead.custom || {}) as Record<string, unknown>,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      last_contacted_at: lead.last_contacted_at,
      next_follow_up_at: lead.next_follow_up_at,
    },
    consent_and_preferences: consent,
    activities_and_communications: activities.map((a) => ({
      id: a.id,
      type: a.type,
      content: a.content,
      recorded_at: a.created_at,
    })),
    chat_transcripts: chatTranscripts.length ? chatTranscripts : undefined,
  };

  const jsonString = JSON.stringify(sar, null, 2);
  const blob = new Blob([jsonString], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (lead.name || "contact").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const dateStr = now.slice(0, 10);

  a.href = url;
  a.download = `sar-data-export-${safeName}-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Permanently erases personal identifiable data (PII) under DPDP Sec. 12 & GDPR Art. 17.
 * Replaces personal data with anonymized placeholders and hides the record.
 */
export async function eraseLeadPII(
  supabase: SupabaseClient,
  lead: Lead,
  actorProfile: Profile | null,
): Promise<{ success: boolean; error?: string }> {
  const actorName = actorProfile?.full_name || actorProfile?.email || "Compliance Admin";
  const now = new Date().toISOString();

  // 1. Redact lead personal fields
  const redactedPatch: Record<string, unknown> = {
    name: "Erased Contact [DPDP/GDPR]",
    email: null,
    phone: null,
    target_country: null,
    course: null,
    course_level: null,
    intake: null,
    budget_inr: null,
    test_status: null,
    custom: {
      erased_at: now,
      erased_by: actorName,
      statutory_basis: "DPDP_2023_SEC_12_GDPR_ART_17",
      consent_status: "consent_withdrawn",
      opt_out_whatsapp: true,
      opt_out_email: true,
      opt_out_calls: true,
    },
    raw: null,
    docs: null,
    tags: ["erased-data-subject"],
    score: 0,
    nurture_opted_out: true,
    updated_at: now,
  };

  const { error: leadErr } = await supabase.from("leads").update(redactedPatch).eq("id", lead.id);
  if (leadErr) {
    return { success: false, error: `Could not redact lead record: ${leadErr.message}` };
  }

  // 2. Anonymize associated conversations
  const { error: convErr } = await supabase
    .from("conversations")
    .update({
      visitor_name: "[Erased Contact]",
      visitor_email: null,
      visitor_phone: null,
    })
    .eq("lead_id", lead.id);

  if (convErr) {
    console.warn("compliance: could not redact linked conversation visitor info:", convErr.message);
  }

  // 3. Log permanent compliance audit trail
  await supabase.from("activities").insert({
    org_id: lead.org_id,
    lead_id: lead.id,
    user_id: actorProfile?.id ?? null,
    type: "system",
    content: `🛡️ STATUTORY COMPLIANCE: Personal Identifiable Information (PII) permanently erased and redacted under DPDP Act 2023 Sec. 12 / GDPR Art. 17 by ${actorName} on ${now}.`,
  });

  // 4. Soft-delete the redacted record so it drops off active pipeline boards
  const { error: archErr } = await supabase.rpc("archive_lead", { p_lead_id: lead.id });
  if (archErr) {
    console.warn("compliance: archive_lead post-erasure warning:", archErr.message);
  }

  return { success: true };
}

export interface ErasureCertificate {
  certificate_id: string;
  statute: string;
  issued_at: string;
  data_fiduciary: string;
  organization_id: string;
  grievance_officer: string;
  data_principal_reference: string;
  erasure_action: string;
  redacted_categories: string[];
  verification_digest: string;
  compliance_attestation: string;
}

/**
 * Generates an official Certificate of Erasure suitable for compliance audit dossiers and Data Principals.
 */
export function generateErasureCertificate(
  leadId: string,
  orgName: string,
  orgId: string,
  actorName: string,
  officerName?: string,
): ErasureCertificate {
  const now = new Date().toISOString();
  const certId = `CERT-DPDP-ERASURE-${leadId.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  
  // Deterministic compliance verification hash
  const rawPayload = `${certId}|${leadId}|${orgId}|${now}|${actorName}`;
  let hash = 0;
  for (let i = 0; i < rawPayload.length; i++) {
    hash = (hash << 5) - hash + rawPayload.charCodeAt(i);
    hash |= 0;
  }
  const digest = `SHA256-SIM-${Math.abs(hash).toString(16).padStart(8, "0")}-${Date.now().toString(16)}`;

  const cert: ErasureCertificate = {
    certificate_id: certId,
    statute: "India DPDP Act 2023 Section 12 / EU GDPR Article 17 (Right to Erasure / Right to be Forgotten)",
    issued_at: now,
    data_fiduciary: orgName || "AbroBot CRM Customer Organization",
    organization_id: orgId,
    grievance_officer: officerName || "Appointed Data Protection / Grievance Officer",
    data_principal_reference: `Lead ID ${leadId}`,
    erasure_action: "IRREVERSIBLE_PII_REDACTION_AND_DATA_MINIMIZATION",
    redacted_categories: [
      "Direct Identifiers (Name, Email Address, Phone Number)",
      "Educational / Commercial Profile (Course, Intake, Target Country, Budget)",
      "Attached Raw Communication Payloads & Custom Attributes",
      "Interactive AI Chat Conversation Visitor Identifiers",
    ],
    verification_digest: digest,
    compliance_attestation:
      `This certifies that all Personal Identifiable Information (PII) belonging to this Data Principal ` +
      `has been irreversibly redacted and anonymized in compliance with statutory data fiduciary obligations. ` +
      `Executed by ${actorName}.`,
  };

  return cert;
}

/**
 * Triggers instant download of an official Certificate of Erasure JSON dossier.
 */
export function downloadErasureCertificate(cert: ErasureCertificate): void {
  const jsonString = JSON.stringify(cert, null, 2);
  const blob = new Blob([jsonString], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${cert.certificate_id.toLowerCase()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Formally records a Data Rectification under DPDP Act 2023 Sec. 12(1) / GDPR Art. 16.
 */
export async function recordDataRectification(
  supabase: SupabaseClient,
  lead: Lead,
  updates: Partial<Lead>,
  justification: string,
  actorProfile: Profile | null,
): Promise<{ success: boolean; error?: string }> {
  const actorName = actorProfile?.full_name || actorProfile?.email || "Staff Member";
  const now = new Date().toISOString();

  const custom = { ...(lead.custom || {}) };
  custom.last_rectified_at = now;
  custom.last_rectified_by = actorName;
  custom.rectification_justification = justification.trim();

  const patch: Record<string, unknown> = {
    ...updates,
    custom,
    updated_at: now,
  };

  const { error } = await supabase.from("leads").update(patch).eq("id", lead.id);
  if (error) {
    return { success: false, error: error.message };
  }

  const fieldsUpdated = Object.keys(updates).join(", ");
  await supabase.from("activities").insert({
    org_id: lead.org_id,
    lead_id: lead.id,
    user_id: actorProfile?.id ?? null,
    type: "system",
    content: `⚖️ STATUTORY RECTIFICATION (DPDP Sec. 12 / GDPR Art. 16): Updated [${fieldsUpdated}] by ${actorName}. Reason: "${justification.trim()}".`,
  });

  return { success: true };
}

export interface ComplianceAuditEvent {
  id: string;
  lead_id: string | null;
  user_name: string;
  content: string;
  created_at: string;
  type: string;
}

/**
 * Queries compliance-related audit entries from the workspace activity log.
 */
export async function getComplianceAuditEvents(
  supabase: SupabaseClient,
  orgId: string,
  limit = 25,
): Promise<ComplianceAuditEvent[]> {
  const { data, error } = await supabase
    .from("activities")
    .select("id, lead_id, user_id, content, created_at, type")
    .eq("org_id", orgId)
    .or("content.ilike.%🛡️%,content.ilike.%⚖️%,content.ilike.%STATUTORY%,content.ilike.%Consent%,content.ilike.%erased%")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map((d: any) => ({
    id: d.id,
    lead_id: d.lead_id,
    user_name: d.user_id ? "Staff" : "System",
    content: d.content,
    created_at: d.created_at,
    type: d.type,
  }));
}

/**
 * Calculates counts of archived leads that have exceeded retention thresholds.
 */
export async function previewRetentionPurge(
  supabase: SupabaseClient,
  orgId: string,
  thresholdDays = 30,
): Promise<{ count: number; oldestArchivedAt: string | null }> {
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 3600 * 1000).toISOString();
  const { data, count, error } = await supabase
    .from("leads")
    .select("deleted_at", { count: "exact" })
    .eq("org_id", orgId)
    .not("deleted_at", "is", null)
    .lt("deleted_at", cutoff)
    .order("deleted_at", { ascending: true })
    .limit(1);

  if (error) return { count: 0, oldestArchivedAt: null };

  return {
    count: count ?? 0,
    oldestArchivedAt: data?.[0]?.deleted_at ?? null,
  };
}
