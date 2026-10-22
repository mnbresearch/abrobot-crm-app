#!/usr/bin/env bash
#
# Deploys everything: checks first, then every edge function, then the
# frontend (site/), then commits and pushes so Cloudflare Pages picks it up.
#
# RUN IT, DO NOT PASTE IT:
#     bash scripts/deploy-all.sh "Short description of this release"
#
# Pasting a multi-line block into a terminal is how we ended up with a stray
# directory called "#" earlier in this project. Running the file avoids that.
#
# Order, and why:
#   1. Pre-flight — function list drift, frontend typecheck + build, node
#      tests, deno check, and the site/ allowlist build + test. Nothing is
#      deployed until ALL of these pass, so a type error or a failing test
#      can no longer ship half a release (functions live, frontend not).
#   2. Edge functions — every one, from the FUNCTIONS list below.
#   3. Verify the same list is live.
#   4. Commit and push — Cloudflare Pages deploys site/ from the push.
#
# Safe to re-run. Stops at the first failure rather than half-deploying.
#
# ── Cloudflare Pages publishes site/, not the repo root ─────────────────────
# Until 14 October 2026 Pages served the repository root, which published every
# doc, migration, edge-function source and script (/FEATURES.md,
# /supabase/migrations/*.sql, /app/src/**, /.env.example ... all answered 200).
# site/ is now an allowlist rebuilt on every deploy by scripts/build-site.sh,
# and wrangler.toml sets pages_build_output_dir = "site".
#
# IF CLOUDFLARE IGNORES wrangler.toml (check after the first deploy: the
# commands printed at the end of this script must show text/html, not
# markdown, for /FEATURES.md), set the
# output directory in the dashboard:
#   Workers & Pages → abrobot-crm-app → Settings → Builds & deployments →
#   Build configuration → Build output directory: site
# then retry the deployment.

set -euo pipefail

PROJECT_REF="pomsltnrxvbcafwtbtlc"
SUPA="npx -y supabase@latest"
SITE_URL="https://crm.mnbresearch.com"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "Repo: $ROOT"
echo

# ── The function list: the single source of truth ───────────────────────────
#
# name:flag. The deploy loop AND the live verification both read this list, so
# it cannot be updated in one place and forgotten in the other. Twice a
# function existed in supabase/functions/ and was absent from a hand-written
# deploy sequence (6 September: `api` and `save-integration` never shipped;
# 17 September: system-health and billing-webhook fixes sat undeployed five
# days). The drift check below refuses to run if the list and the directory
# disagree in either direction.
#
# The --no-verify-jwt flags are load-bearing. Turning JWT verification ON for a
# function that outside parties call silently kills it:
#   chat-agent, lead-webhook   browser widget, forms, third-party webhooks
#   app-signup                 app.abrobot.ai, no Supabase session
#   api                        customer REST API — the AbroBot API key is the auth
#   nurture, run-automations,
#   system-health,
#   checkout-recovery          pg_cron (no JWT) — the shared secret in
#                              _shared/cron-auth.ts is the boundary, and it fails
#                              CLOSED when CRON_SECRET is unset, so set the
#                              secret BEFORE deploying these
#   summarize-chats            called by a signed-in member from Conversations;
#                              requireCronOrMember inside is the boundary (it is
#                              NOT scheduled by pg_cron)
#   billing-webhook            Cashfree — HMAC signature verified, fails closed
#   resend-events              Resend — Svix signature verified, fails closed
#   checkout-recovery          also serves the unsubscribe link, opened with no
#                              session (the unsubscribe token is the boundary)
#
# JWT ON (empty flag), deliberately: each acts as a specific signed-in member,
# and that check is what stops one organisation spending another's money or
# reading another's records:
#   whatsapp-send, send-campaign, save-integration, billing-checkout, rescore-leads
FUNCTIONS=(
  "chat-agent:--no-verify-jwt"
  "app-signup:--no-verify-jwt"
  "lead-webhook:--no-verify-jwt"
  "api:--no-verify-jwt"
  "nurture:--no-verify-jwt"
  "run-automations:--no-verify-jwt"
  "summarize-chats:--no-verify-jwt"
  "system-health:--no-verify-jwt"
  "billing-webhook:--no-verify-jwt"
  "checkout-recovery:--no-verify-jwt"
  "resend-events:--no-verify-jwt"
  "whatsapp-send:"
  "send-campaign:"
  "save-integration:"
  "billing-checkout:"
  "rescore-leads:"
)

# ════════════════════════════════════════════════════════════════════════════
# 1. PRE-FLIGHT — nothing below this block deploys anything
# ════════════════════════════════════════════════════════════════════════════

echo "==> [1/6] Checking the deploy list against supabase/functions/"
DRIFT=0
for dir in "$ROOT"/supabase/functions/*/; do
  name="$(basename "$dir")"
  # _shared holds imported modules, not a deployable function.
  [ "$name" = "_shared" ] && continue
  [ -f "$dir/index.ts" ] || continue
  found=0
  for entry in "${FUNCTIONS[@]}"; do
    [ "${entry%%:*}" = "$name" ] && { found=1; break; }
  done
  if [ "$found" -eq 0 ]; then
    echo "    NOT IN THIS SCRIPT: $name" >&2
    DRIFT=1
  fi
done
for entry in "${FUNCTIONS[@]}"; do
  name="${entry%%:*}"
  if [ ! -f "$ROOT/supabase/functions/$name/index.ts" ]; then
    echo "    LISTED BUT NO SOURCE: $name (supabase/functions/$name/index.ts)" >&2
    DRIFT=1
  fi
done
if [ "$DRIFT" -ne 0 ]; then
  echo >&2
  echo "The FUNCTIONS list and supabase/functions/ disagree. Fix the list (with the" >&2
  echo "right JWT flag), then re-run. Refusing to deploy a partial set." >&2
  exit 1
fi
echo "    all ${#FUNCTIONS[@]} functions accounted for"
echo

echo "==> [2/6] Frontend: install, typecheck, build"
cd "$ROOT/app"
npm ci --silent || npm install --silent
npm run typecheck
npm run build
cd "$ROOT"
if grep -l "sourceMappingURL" app/dist/assets/*.js >/dev/null 2>&1; then
  echo "A bundle references a source map. Set sourcemap:\"hidden\" in app/vite.config.ts." >&2
  exit 1
fi
echo

echo "==> [3/6] Unit tests (node)"
# The .test.cjs suites transpile TypeScript with esbuild and use jsdom for the
# widget XSS suite. Without them they print SKIP and pass — CI installs both
# and treats a SKIP as a failure; locally it is a warning.
node --test tests/*.test.cjs supabase/functions/_shared/*.test.cjs
echo

echo "==> [4/6] Edge functions: deno check"
if command -v deno >/dev/null 2>&1; then
  DENO_FAIL=0
  for entry in "${FUNCTIONS[@]}"; do
    name="${entry%%:*}"
    if deno check --no-lock "supabase/functions/$name/index.ts" >/dev/null 2>&1; then
      echo "    ok    $name"
    else
      echo "    FAIL  $name" >&2
      deno check --no-lock "supabase/functions/$name/index.ts" 2>&1 | tail -20 >&2
      DENO_FAIL=1
    fi
  done
  [ "$DENO_FAIL" -eq 0 ] || { echo "deno check failed — nothing has been deployed." >&2; exit 1; }
elif [ "${SKIP_DENO_CHECK:-}" = "1" ]; then
  echo "    deno not installed; SKIP_DENO_CHECK=1 set — relying on CI's deno check."
else
  echo "    deno is not installed, so the edge functions cannot be typechecked here." >&2
  echo "    Install it (brew install deno), or re-run with SKIP_DENO_CHECK=1 if CI" >&2
  echo "    is green for this commit. Nothing has been deployed." >&2
  exit 1
fi
echo

echo "==> [5/6] Building site/ (the publish allowlist)"
# The root index.html is kept as a copy of the build because tests compare it
# with app/index.html (tests/seo-shell.test.cjs) and with site/index.html.
# Non-map assets are also still copied to the root assets/ directory: if
# Cloudflare were ever to fall back to serving the repo root, the shell would
# at least load rather than white-screen. Source maps never leave app/dist.
cp app/dist/index.html index.html
find app/dist/assets -type f ! -name '*.map' -exec cp {} assets/ \;
rm -f assets/*.map
bash scripts/build-site.sh --from-dist
node --test tests/publish-allowlist.test.cjs
echo

# ════════════════════════════════════════════════════════════════════════════
# 2. DEPLOY
# ════════════════════════════════════════════════════════════════════════════

echo "==> [6/6] Deploying"
echo "--> Linking Supabase project"
$SUPA link --project-ref "$PROJECT_REF"
echo

for entry in "${FUNCTIONS[@]}"; do
  name="${entry%%:*}"
  flag="${entry#*:}"
  if [ -n "$flag" ]; then
    echo "--> $name  (JWT off)"
    $SUPA functions deploy "$name" "$flag"
  else
    echo "--> $name  (JWT ON)"
    $SUPA functions deploy "$name"
  fi
done
echo

# ── Prove they are actually there ───────────────────────────────────────────
# `functions deploy` can succeed for some and fail for others in a long chain,
# and the failure scrolls past. This asks the platform what it is really
# serving, for the SAME list. A missing function answers NOT_FOUND; a deployed
# one answers something else, whatever that something is.
echo "--> Verifying what is live"
BASE="https://${PROJECT_REF}.supabase.co/functions/v1"
CHECK_FILE="$(mktemp)"
MISSING=0
for entry in "${FUNCTIONS[@]}"; do
  f="${entry%%:*}"
  code=$(curl -sS --max-time 20 -o "$CHECK_FILE" -w '%{http_code}' \
         -X OPTIONS "$BASE/$f" 2>/dev/null || echo 000)
  if grep -q NOT_FOUND "$CHECK_FILE" 2>/dev/null; then
    echo "    MISSING  $f"; MISSING=1
  else
    echo "    live     $f  (HTTP $code)"
  fi
done
rm -f "$CHECK_FILE"
if [ "$MISSING" -ne 0 ]; then
  echo
  echo "One or more functions are not deployed. Scroll up for the error." >&2
  exit 1
fi
echo

# ── Ship the frontend ───────────────────────────────────────────────────────
echo "--> Committing"
git add -A
# Pass a message as the first argument:
#   bash scripts/deploy-all.sh "SEO foundation: robots, sitemap, meta, schema"
# Falls back to a dated message rather than a misleading one.
MSG="${1:-Deploy $(date +%Y-%m-%d)}"
git commit -m "$MSG" || echo "    (nothing to commit)"

echo "--> Pushing"
git push

echo
echo "Done. Cloudflare Pages will pick up the push within a minute or two."
echo
echo "Then verify. Repo files must NOT be served: each of these must print"
echo "text/html (the app shell from the /* catch-all), never text/markdown,"
echo "application/sql, video/mp2t (.ts) or text/plain:"
echo
echo "  for p in /FEATURES.md /supabase/functions/api/index.ts /scripts/deploy-all.sh \\"
echo "           /.env.example /legacy.html /assets/index-BW4JtkZt.js.map; do"
echo "    printf '%-40s ' \"\$p\"; curl -s -o /dev/null -w '%{http_code} %{content_type}\\n' $SITE_URL\$p"
echo "  done"
echo
echo "And these must still work:"
echo "  curl -s -o /dev/null -w '%{http_code} %{content_type}\\n' $SITE_URL/widget.js   # 200 javascript"
echo "  curl -s -o /dev/null -w '%{http_code} %{redirect_url}\\n' $SITE_URL/get         # 301 .../login"
echo "  curl -s -o /dev/null -w '%{http_code} %{content_type}\\n' $SITE_URL/favicon.svg # 200 image/svg+xml"
echo
echo "If /FEATURES.md comes back as markdown, Cloudflare is serving the repo root:"
echo "set Build output directory = site in the dashboard (see the top of this"
echo "script) and retry the deployment."
