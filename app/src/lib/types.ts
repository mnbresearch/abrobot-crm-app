// Types mirroring the live schema (see RECOVERED-SCHEMA.md).
// Read from the database, not guessed — the schema is the contract.

export type UserRole = "super_admin" | "org_admin" | "counsellor";
export type MemberStatus = "pending" | "active" | "disabled";

export type ActivityType =
  | "note" | "call" | "whatsapp" | "email" | "meeting"
  | "stage_change" | "assignment" | "system";

export type LeadSource =
  | "whatsapp" | "chatbase" | "email" | "website" | "csv_import"
  | "pdf_import" | "manual" | "referral" | "other";

/** Legacy enum. Retained for compatibility; new code reads `stage_key`. */
export type LegacyStage =
  | "new" | "contacted" | "counselled" | "application"
  | "offer" | "visa" | "enrolled" | "lost";

export type FieldType =
  | "text" | "textarea" | "number" | "currency" | "date"
  | "select" | "multiselect" | "checkbox" | "email" | "phone" | "url";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  brand_color: string | null;
  logo_url: string | null;
  active: boolean;
  created_at: string;
  plan: string;
  trial_started_at: string;
  trial_days: number;
  credits_total: number;
  credits_used: number;
  industry_slug: string | null;
}

export interface Profile {
  id: string;
  org_id: string | null;
  full_name: string;
  email: string;
  role: UserRole;
  status: MemberStatus;
  created_at: string;
}

export interface Lead {
  id: string;
  org_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: LeadSource;
  stage: LegacyStage;
  stage_key: string | null;
  target_country: string | null;
  course: string | null;
  course_level: string | null;
  intake: string | null;
  budget_inr: number | null;
  test_status: string | null;
  score: number;
  assigned_to: string | null;
  tags: string[];
  next_follow_up_at: string | null;
  last_contacted_at: string | null;
  raw: unknown;
  created_at: string;
  updated_at: string;
  docs: unknown;
  lost_reason: string | null;
  nurture_step: number;
  nurture_opted_out: boolean;
  custom: Record<string, unknown>;
}

export interface Activity {
  id: string;
  org_id: string;
  lead_id: string;
  user_id: string | null;
  type: ActivityType;
  content: string;
  created_at: string;
}

export interface PipelineStage {
  id: string;
  org_id: string;
  key: string;
  label: string;
  position: number;
  color: string | null;
  is_won: boolean;
  is_lost: boolean;
}

export interface FieldDef {
  id: string;
  org_id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  required: boolean;
  show_in_list: boolean;
  section: string | null;
  position: number;
}

export interface IndustryRow {
  slug: string;
  name: string;
  icon: string | null;
  tagline: string | null;
  lead_noun: string;
  lead_noun_plural: string;
  agent_persona: string | null;
  position: number;
  active: boolean;
}

export interface AgentConfig {
  org_id: string;
  enabled: boolean;
  agent_name: string;
  welcome_message: string;
  knowledge: string;
  greeting: string | null;
  teaser: string | null;
  header_title: string | null;
  header_subtitle: string | null;
  quick_replies: string | null;
  cta_text: string | null;
  widget_color: string | null;
  widget_position: string | null;
  persona: string | null;
  tone: string | null;
  temperature: number | null;
  model: string | null;
  max_tokens: number | null;
  languages: string | null;
  away_message: string | null;
  booking_url: string | null;
  brand_name: string | null;
  whatsapp: string | null;
  contact_url: string | null;
  industry: string | null;
  notify_new_leads: boolean;
  telegram_chat_id: string | null;
  nurture_enabled: boolean;
  onboarded: boolean;
}
