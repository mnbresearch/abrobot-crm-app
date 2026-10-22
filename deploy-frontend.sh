#!/usr/bin/env bash
#
# Frontend-only build: rebuilds the app and site/ (the publish directory)
# WITHOUT deploying any edge function. For a full release use:
#
#     bash scripts/deploy-all.sh "message"
#
# Cloudflare Pages publishes site/ (wrangler.toml: pages_build_output_dir),
# NOT the repo root. site/ is an allowlist built by scripts/build-site.sh —
# the same builder deploy-all.sh uses, so the two can never publish different
# things. Source maps are never copied anywhere outside app/dist.
#
# History: this script used to preserve the old bundle as legacy.html and
# `cp -R app/dist/assets .`, which copied the .map files to the repo root where
# Cloudflare served them. The legacy app was retired on 14 October 2026;
# legacy.html stays in git as history but is no longer published.
#
# Rollback: git revert the deploy commit and push (site/ is committed, so the
# previous site/ comes back with it).
#
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

echo "▶ Typecheck and build…"
cd "$ROOT/app"
npm run build

if [ ! -f "$ROOT/app/dist/index.html" ]; then
  echo "✗ Build produced no dist/index.html — stopping before anything is changed."
  exit 1
fi
cd "$ROOT"

if grep -l "sourceMappingURL" app/dist/assets/*.js >/dev/null 2>&1; then
  echo "✗ A bundle references a source map. Set sourcemap:\"hidden\" in app/vite.config.ts." >&2
  exit 1
fi

# Root copies: index.html is compared against app/index.html and site/index.html
# by the tests; the root assets/ copy (never .map) is a fallback only.
cp app/dist/index.html index.html
find app/dist/assets -type f ! -name '*.map' -exec cp {} assets/ \;
rm -f assets/*.map

echo "▶ Building site/…"
bash scripts/build-site.sh --from-dist
node --test tests/publish-allowlist.test.cjs tests/seo-shell.test.cjs tests/csp.test.cjs

echo
echo "✔ Ready. Review before pushing:"
echo
git --no-optional-locks status --short | head -30
echo
echo "Then:"
echo "  git add -A && git commit -m \"Frontend: <what changed>\" && git push"
echo
echo "After Cloudflare redeploys, check:"
echo "  https://crm.mnbresearch.com/            → the app (landing when signed out)"
echo "  https://crm.mnbresearch.com/get         → 301 to /login"
echo "  https://crm.mnbresearch.com/pricing     → pricing page"
echo "  https://crm.mnbresearch.com/widget.js   → the chat widget still loads"
echo "  https://crm.mnbresearch.com/FEATURES.md → the app shell (text/html), NOT markdown"
