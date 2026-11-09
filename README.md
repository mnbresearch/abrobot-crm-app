# AbroBot CRM — Security, Intelligence & Platform Engine

Multi-industry AI CRM with native WhatsApp Cloud API integration, Groq LLM Copilot, Natural Language Automation Builder, 1-Click AI Lead Enrichment, and DPDP Act 2023 / GDPR compliance shield.

---

## Testing & Quality Assurance

Run the entire verification suite (TypeScript checks + 141 unit/integration/security tests) in one command:

```bash
export PATH=/opt/homebrew/bin:$PATH
npm --prefix app run typecheck && node --test tests/*.test.cjs supabase/functions/_shared/*.test.cjs
```

### Pre-commit Secret Scanner
Verify that zero private keys or live API tokens are staged or committed:

```bash
./scripts/secret-scan.sh
```

### Production Build & Allowlist Verification
Verify Cloudflare Pages security allowlist (22 public files strictly in `site/`):

```bash
./deploy-frontend.sh
```

---

## Audit & Compliance Documentation

Full AppSec, scalability, and competitor moat reports are stored under `/audit/`:
* `audit/AUDIT_REPORT.md`: Comprehensive security scorecard and remediated findings.
* `audit/NEEDS_YOUR_ACTION.md`: Exact dashboard setup steps for Cashfree, Resend, and Meta Cloud API.
* `audit/CAPACITY.md`: Concurrent user capacity, bottlenecks, and cloud cost projections.
* `audit/COMPETITORS.md`: Competitive intelligence matrix (Attio, folk, Sierra, Respond.io) and strategic moat.
* `audit/SECURITY_RUNBOOK.md`: Key rotation SOPs, emergency lockdown, and disaster recovery.
