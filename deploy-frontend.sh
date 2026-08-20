#!/usr/bin/env bash
#
# Deploy the new frontend to the repo root, where Cloudflare Pages serves from.
#
# What this does NOT touch, on purpose:
#   widget.js                  the embeddable chat widget, live on other sites
#   *.html policy pages        pricing, contact, terms, refunds, product
#   index-*.js / *.css         the legacy bundle, still serving /get and friends
#   _redirects                 hand-written; routes legacy paths to legacy.html
#
# The old index.html is preserved as legacy.html so the marketing, pricing,
# trial and credit flows keep working on the same domain.
#
# Rollback:  git checkout HEAD~1 -- index.html && git commit && git push
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

echo "▶ Building the new app…"
cd "$ROOT/app"
npm run build

if [ ! -f "$ROOT/app/dist/index.html" ]; then
  echo "✗ Build produced no dist/index.html — stopping before anything is changed."
  exit 1
fi

cd "$ROOT"

# ── preserve the legacy entry point ──────────────────────────────────────────
# Only on the first run: after that, index.html is already the new app and
# copying it would overwrite the legacy one with a copy of the new app.
if [ ! -f legacy.html ]; then
  if grep -q 'index-Bw0EU57x.js\|index-[A-Za-z0-9_-]*\.js' index.html 2>/dev/null; then
    cp index.html legacy.html
    echo "✔ Saved the legacy bundle entry as legacy.html"
  else
    echo "⚠ index.html does not look like the legacy bundle — not creating legacy.html."
    echo "  Check it by hand before continuing."
    exit 1
  fi
else
  echo "• legacy.html already exists — leaving it alone"
fi

# ── copy the new build in ────────────────────────────────────────────────────
# cp, never rm: nothing existing is deleted, so the widget and policy pages
# survive regardless of what the build produced.
echo "▶ Copying app/dist → repo root…"
cp -R app/dist/assets . 2>/dev/null || true
cp app/dist/index.html .
# Vite emits its own _redirects from app/public; ours is hand-written and
# routes the legacy paths, so keep the repo-root one.
rm -f assets/.gitkeep 2>/dev/null || true

echo
echo "✔ Ready. Review before pushing:"
echo
git status --short | head -20
echo
echo "Then:"
echo "  git add -A && git commit -m \"Deploy new frontend; legacy routes via legacy.html\" && git push"
echo
echo "After Cloudflare redeploys, check ALL of these:"
echo "  https://crm.mnbresearch.com/          → new app"
echo "  https://crm.mnbresearch.com/get       → legacy landing + pricing"
echo "  https://crm.mnbresearch.com/pricing   → pricing page"
echo "  https://crm.mnbresearch.com/widget.js → the chat widget still loads"
