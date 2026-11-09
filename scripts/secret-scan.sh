#!/usr/bin/env bash
# AbroBot CRM — Pre-commit & CI Secret Scanner
# Fails if private keys, high-entropy tokens, or live credentials are found in source.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶ Scanning repository for exposed credentials and private keys..."

FAIL=0

check_pattern() {
  local pattern="$1"
  local desc="$2"
  local matches
  matches=$(grep -rnE \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=dist \
    --exclude-dir=assets \
    --exclude="*.test.cjs" \
    --exclude="*.map" \
    -e "$pattern" . || true)
  if [ -n "$matches" ]; then
    echo "❌ ALERT: $desc detected:"
    echo "$matches" | head -n 10
    FAIL=1
  fi
}

# 1. Private keys
check_pattern "-----BEGIN (RSA )?PRIVATE KEY-----" "RSA/Private Key"

# 2. Live production Stripe / Cashfree / Provider tokens
check_pattern "sk_live_[0-9a-zA-Z]{24,}" "Live Stripe/Payment secret key"
check_pattern "gsk_[0-9a-zA-Z]{32,}" "Live Groq API key"
check_pattern "re_[0-9a-zA-Z]{24,}" "Live Resend API key"
check_pattern "whsec_[0-9a-zA-Z]{24,}" "Live Webhook signing secret"

# 3. Connection URIs with raw passwords
check_pattern "postgres(ql)?://[a-zA-Z0-9_]+:[^@]+@[a-zA-Z0-9.-]+" "PostgreSQL URI with hardcoded password"

if [ "$FAIL" -ne 0 ]; then
  echo "❌ Secret scan FAILED. Remove committed secrets before proceeding."
  exit 1
fi

echo "✔ Secret scan PASSED: 0 exposed credentials detected."
exit 0
