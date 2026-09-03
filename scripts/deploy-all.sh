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

echo "==> chat-agent  (strips <think> chain-of-thought; JWT off)"
$SUPA functions deploy chat-agent --no-verify-jwt

echo "==> app-signup  (fixes the enum bug discarding every signup; JWT off)"
$SUPA functions deploy app-signup --no-verify-jwt

echo "==> lead-webhook  (WhatsApp autoreply plan gate; JWT off)"
$SUPA functions deploy lead-webhook --no-verify-jwt

echo "==> whatsapp-send  (plan gate; JWT ON, deliberately)"
$SUPA functions deploy whatsapp-send
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
git commit -m "Strip model reasoning from replies; render markdown in widget; enforce plan limits and expiry; add MNB Research org" \
  || echo "    (nothing to commit)"

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
