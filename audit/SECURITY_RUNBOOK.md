# AbroBot CRM — Security & Incident Response Runbook
**Date**: 9 November 2026  
**Auditor**: Antigravity Platform Engineering Lead  

---

## 1. Key Rotation Procedures

### A. Groq API Key Rotation
If a Groq key is suspected of compromise or rate limiting:
1. Open [Groq Console API Keys](https://console.groq.com/keys).
2. Generate a new API key (`gsk_...`).
3. Set the new secret in Supabase Edge Functions:
   ```bash
   supabase secrets set GROQ_API_KEY="gsk_new_key..."
   ```
4. Verify chat functionality by running:
   ```bash
   curl -X POST "https://<project-ref>.supabase.co/functions/v1/chat-agent" \
     -H "Content-Type: application/json" \
     -d '{"message":"hello", "conversation_id":"00000000-0000-0000-0000-000000000000", "org_slug":"demo"}'
   ```
5. Revoke the old key in Groq Console.

### B. Resend Email Key Rotation
1. Open [Resend API Keys](https://resend.com/api-keys).
2. Create a new API Key (`re_...`).
3. Update Supabase Edge Functions:
   ```bash
   supabase secrets set RESEND_API_KEY="re_new_key..."
   ```
4. Verify by running the recovery email test suite:
   ```bash
   node --test supabase/functions/_shared/recovery-email.test.cjs
   ```
5. Revoke the old key in Resend dashboard.

### C. Cashfree Secret Rotation
1. In [Cashfree Merchant Portal](https://merchant.cashfree.com/), generate a new Secret Key.
2. Update the Edge Function secrets immediately:
   ```bash
   supabase secrets set CASHFREE_SECRET_KEY="cfsk_new..."
   ```
3. Run the reconciliation test suite to verify signature validation:
   ```bash
   node --test supabase/functions/_shared/cashfree.test.cjs supabase/functions/_shared/cashfree-reconcile.test.cjs
   ```

### D. CRON_SECRET Rotation
1. Generate a new 64-character hex secret:
   ```bash
   NEW_CRON=$(openssl rand -hex 32)
   ```
2. Update Edge Function secrets:
   ```bash
   supabase secrets set CRON_SECRET="$NEW_CRON"
   ```
3. In Supabase SQL Editor, update the database setting atomically:
   ```sql
   update public.app_settings
      set value = '<new_hex_secret>'
    where key = 'cron_secret';
   ```
4. Run the cron authentication verification suite:
   ```bash
   node --test supabase/functions/_shared/cron-auth.test.cjs
   ```

---

## 2. Compromised Account or Feature Lockdown

### Suspend a Tenant Organization
If an organization is abusive or breached, suspend it immediately from the Super Admin Console (`/admin`) or via SQL:
```sql
update public.organizations
   set active = false
 where id = '<org_uuid>';
```
*Effect*: Active sessions are rejected by RLS (`public.is_active_member()` returns false) and all inbound webhooks/chats are dropped.

### Revoke an Individual Member's Access
```sql
update public.profiles
   set status = 'disabled'
 where id = '<user_uuid>';
```
*Effect*: RLS immediately blocks all reads and writes on tenant records.

### Disable AI Chat Widget Platform-Wide (Emergency Circuit Breaker)
```sql
update public.agent_config
   set enabled = false;
```

---

## 3. Database Backup & Disaster Recovery

### Point-in-Time Recovery (PITR)
* Supabase maintains continuous Write-Ahead Log (WAL) archiving for 7–30 days.
* In the Supabase Dashboard → **Settings** → **Database** → **Backups**:
  1. Select **Point in Time Recovery**.
  2. Choose the exact timestamp prior to the incident (UTC).
  3. Click **Restore Database**.

### Manual Snapshot & Emergency Restore
* To take a point-in-time snapshot:
  ```bash
  pg_dump -h db.<project-ref>.supabase.co -U postgres -d postgres -F c -b -v -f crm_emergency_backup.dump
  ```
* To restore into a staging or scratch database:
  ```bash
  pg_restore -h db.<scratch-ref>.supabase.co -U postgres -d postgres -v -c crm_emergency_backup.dump
  ```

---

## 4. Emergency Contacts & Triage SLA
* **Security & Platform Lead**: contact@mnbresearch.com / mridul@mnbresearch.com
* **Incident SLA**:
  * P0 (Data breach, Cross-tenant leak, Service down): Response < 15 mins.
  * P1 (Key compromise, Webhook failure, Degradation): Response < 1 hour.
  * P2 (Minor UI or non-security issue): Response < 24 hours.
