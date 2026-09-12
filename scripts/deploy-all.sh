#!/usr/bin/env bash
#
# Deploys everything outstanding: 4 edge functions, the widget fix, and the
# frontend.
#
# RUN IT, DO NOT PASTE IT:
#     bash scripts/deploy-all.sh
#
# Pasting a multi-line block into a terminal is how we ended up with a stray
# directory called "#" earlier in this project. Running the file avoids that.
#
# Safe to re-run. Stops at the first failure rather than half-deploying.

set -euo pipefail

PROJECT_REF="pomsltnrxvbcafwtbtlc"
SUPA="npx -y supabase@latest"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "Repo: $ROOT"
echo

# ── 1. Link ─────────────────────────────────────────────────────────────────
echo "==> Linking Supabase project"
$SUPA link --project-ref "$PROJECT_REF"
echo

# ── 2. Edge functions ───────────────────────────────────────────────────────
#
# The --no-verify-jwt flags are load-bearing. chat-agent, lead-webhook and
# app-signup are called by outside parties that have no Supabase JWT: a browser
# widget, third-party webhooks, and app.abrobot.ai. Deploying them WITHOUT the
# flag turns on JWT verification and silently kills lead intake.
#
# whatsapp-send deliberately KEEPS verification on. It is called by a signed-in
# counsellor from the CRM, and that check is what stops another org sending
# WhatsApp messages billed to your account.

# This list used to hold four functions, and the other six were left to a long
# one-off command pasted from a document. On 6 September that is exactly what
# went wrong: the migrations were applied, but `api` and `save-integration` were
# never deployed at all, and `nurture` was still serving the old single-tenant
# build — while everything looked done.
#
# So every function is listed here now. One script, no memory required.

echo "==> chat-agent  (strips <think> chain-of-thought; JWT off)"
$SUPA functions deploy chat-agent --no-verify-jwt

echo "==> app-signup  (fixes the enum bug discarding every signup; JWT off)"
$SUPA functions deploy app-signup --no-verify-jwt

echo "==> lead-webhook  (WhatsApp autoreply plan gate; JWT off)"
$SUPA functions deploy lead-webhook --no-verify-jwt

echo "==> api  (customer REST API; JWT off — the AbroBot key IS the auth)"
$SUPA functions deploy api --no-verify-jwt

# These three are called by pg_cron, which carries no Supabase JWT, so the
# platform gate has to be off and the shared secret in _shared/cron-auth.ts is
# the real boundary. That code fails CLOSED when CRON_SECRET is unset — so if
# you have not set the secret yet, set it BEFORE deploying these, or the
# scheduled jobs will start refusing themselves.
echo "==> nurture  (per-tenant follow-up; JWT off, cron secret enforced)"
$SUPA functions deploy nurture --no-verify-jwt

echo "==> run-automations  (JWT off, cron secret or member)"
$SUPA functions deploy run-automations --no-verify-jwt

echo "==> summarize-chats  (JWT off, cron secret or member)"
$SUPA functions deploy summarize-chats --no-verify-jwt

# JWT ON, deliberately: each of these acts as a specific signed-in member, and
# that check is what stops one organisation spending another's money or reading
# another's records.
echo "==> whatsapp-send  (plan gate; JWT ON)"
$SUPA functions deploy whatsapp-send

echo "==> send-campaign  (email; JWT ON)"
$SUPA functions deploy send-campaign

echo "==> save-integration  (write-only credentials; JWT ON)"
$SUPA functions deploy save-integration
echo

# ── 2b. Prove they are actually there ───────────────────────────────────────
# `functions deploy` can succeed for some and fail for others in a long chain,
# and the failure scrolls past. This asks the platform what it is really
# serving. A missing function answers NOT_FOUND; a deployed one answers
# something else, whatever that something is.
echo "==> Verifying what is live"
BASE="https://${PROJECT_REF}.supabase.co/functions/v1"
MISSING=0
for f in chat-agent app-signup lead-webhook api nurture run-automations \
         summarize-chats whatsapp-send send-campaign save-integration; do
  code=$(curl -sS --max-time 20 -o /tmp/abx-deploy-check -w '%{http_code}' \
         -X OPTIONS "$BASE/$f" 2>/dev/null || echo 000)
  if grep -q NOT_FOUND /tmp/abx-deploy-check 2>/dev/null; then
    echo "    MISSING  $f"; MISSING=1
  else
    echo "    live     $f  (HTTP $code)"
  fi
done
rm -f /tmp/abx-deploy-check
if [ "$MISSING" -ne 0 ]; then
  echo
  echo "One or more functions are not deployed. Scroll up for the error." >&2
  exit 1
fi
echo

# ── 3. Frontend ─────────────────────────────────────────────────────────────
# Cloudflare Pages serves this repo's root, so the built app has to be copied
# out of app/dist and committed. Building first means a type error stops the
# deploy here rather than shipping a broken bundle.

echo "==> Building the frontend"
cd "$ROOT/app"
npm ci --silent || npm install --silent
npm run build
cd "$ROOT"

echo "==> Copying the build to the repo root"

# Source maps are deliberately NOT copied.
#
# vite.config.ts sets sourcemap: "hidden", which strips the
# //# sourceMappingURL comment so a browser will not fetch a map on its own.
# That is not the same as not publishing them: the files were still copied
# here, committed, and served by Cloudflare at a completely guessable URL
# (foo.js -> foo.js.map). 8.4 MB of fully commented TypeScript — including
# every incident post-mortem written in these comments — was one request away.
#
# The maps stay in app/dist/ where they are useful for symbolicating a stack
# trace locally. They just do not go to the CDN.
find app/dist/assets -type f ! -name '*.map' -exec cp {} assets/ \;
cp app/dist/index.html index.html

# Old builds are never removed by this script (deliberately — widget.js and the
# policy pages live at the root and must survive). But maps that earlier
# deploys copied here are still being served, so clear those out.
rm -f assets/*.map
echo

# ── 4. Ship ─────────────────────────────────────────────────────────────────
echo "==> Committing"
git add -A
# The message was hardcoded to one release's description, so every deploy since
# has been committed as "Strip model reasoning from replies…" regardless of what
# actually changed. Pass one as the first argument:
#
#   bash scripts/deploy-all.sh "SEO foundation: robots, sitemap, meta, schema"
#
# Falls back to a dated message rather than a misleading one.
MSG="${1:-Deploy $(date +%Y-%m-%d)}"
git commit -m "$MSG" || echo "    (nothing to commit)"

echo "==> Pushing"
git push

echo
echo "Done. Cloudflare Pages will pick up the push within a minute or two."
echo
echo "Then verify:"
echo "  1. Open abrobot.ai, ask 'which universities suit a 7.0 IELTS?' a few"
echo "     times. No <think> block should ever appear, and bold should render"
echo "     as bold rather than **asterisks**."
echo "  2. Swap the Chatbase script on mnbresearch.com for the line in"
echo "     MNB-RESEARCH-SETUP.md."
