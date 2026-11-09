# AbroBot CRM — Needs Your Action (Operations & Keys)
**Date**: 9 November 2026  
**Auditor**: Antigravity Platform Engineering Lead  

Follow these exact steps in your provider dashboards before switching production traffic:

---

## 1. Third-Party Provider Credentials Setup (Priority: Critical)

### A. Cashfree Payments (PG & Subscriptions)
1. Log into [Cashfree Merchant Dashboard](https://merchant.cashfree.com/merchants/login).
2. Go to **Developers** → **API Keys** → Generate Production `App ID` and `Secret Key`.
3. In **Developers** → **Webhooks**, set the Webhook URL to:  
   `https://<your-supabase-project-ref>.supabase.co/functions/v1/billing-webhook`
4. Subscribe to events: `PAYMENT_SUCCESS_WEBHOOK`, `SUBSCRIPTION_NEW`, `SUBSCRIPTION_CANCELLED`.
5. Set environment secrets via Supabase CLI or dashboard:
   ```bash
   supabase secrets set CASHFREE_APP_ID="<production_app_id>"
   supabase secrets set CASHFREE_SECRET_KEY="<production_secret_key>"
   supabase secrets set CASHFREE_ENV="production"
   ```

### B. Resend Email Domain & API Key
1. Log into [Resend Dashboard](https://resend.com/domains).
2. Add your sending domain (e.g., `updates.mnbresearch.com` or `crm.mnbresearch.com`).
3. Add the required SPF, DKIM, and DMARC DNS records in your Cloudflare / DNS provider.
4. Verify domain status (must show green `Verified`).
5. Under **API Keys**, create a key with full sending access:
   ```bash
   supabase secrets set RESEND_API_KEY="re_..."
   supabase secrets set NURTURE_FROM="AbroBot Updates <hello@updates.mnbresearch.com>"
   supabase secrets set NURTURE_REPLY_TO="contact@mnbresearch.com"
   ```

### C. Meta WhatsApp Cloud API (Platform Default)
1. In [Meta Developers Portal](https://developers.facebook.com/), open your WhatsApp Business App.
2. Under **WhatsApp** → **API Setup**, retrieve your `Phone number ID` and generate a Permanent System User Token.
3. Set the secrets:
   ```bash
   supabase secrets set WHATSAPP_PHONE_ID="<phone_id>"
   supabase secrets set WHATSAPP_TOKEN="EAAG..."
   supabase secrets set META_GRAPH_VERSION="v21.0"
   ```

---

## 2. Platform Scheduler & Cron Secret (Priority: High)

1. Generate a high-entropy 64-character hex secret:
   ```bash
   openssl rand -hex 32
   ```
2. Store the secret in Supabase Edge Function environment:
   ```bash
   supabase secrets set CRON_SECRET="<generated_hex_secret>"
   ```
3. Update database `app_settings` with the matching secret:
   ```sql
   insert into public.app_settings (key, value)
   values ('cron_secret', '<generated_hex_secret>')
   on conflict (key) do update set value = excluded.value;
   ```

---

## 3. Super Admin MFA & Security Hygiene (Priority: Medium)

1. Log in to the CRM with your super admin email.
2. In Supabase Dashboard → **Authentication** → **Users**, verify MFA is enabled for all `super_admin` role accounts.
3. Ensure no personal credentials or staging keys are left in `.env` files on developer machines.
