#!/usr/bin/env bash
#
# Builds site/ — the ONLY directory Cloudflare Pages publishes.
#
#     bash scripts/build-site.sh              # from app/dist (after `npm run build`)
#     bash scripts/build-site.sh --from-root  # from the committed root index.html
#
# WHY THIS EXISTS
# ───────────────
# Until 14 October 2026 Cloudflare Pages served the REPOSITORY ROOT. Every file
# in the repo was therefore a public URL: /FEATURES.md, /AUDIT-2026-09.md,
# /supabase/migrations/*.sql, /supabase/functions/**, /scripts/*, /app/src/**,
# /.env.example all answered 200. That is the full incident history, the schema,
# the RLS policies and every edge function's source, one guessable request away.
#
# The fix is an allowlist, not a denylist. site/ is rebuilt from scratch on
# every deploy and contains exactly the files listed below plus the CURRENT
# app build. A new doc, script or migration added to the repo is unpublished by
# default; publishing something requires adding it to STATIC_FILES here, on
# purpose. wrangler.toml points Pages at site/ (pages_build_output_dir).
#
# If Cloudflare ignores wrangler.toml for this project, set it by hand:
#   Cloudflare dashboard → Workers & Pages → abrobot-crm-app → Settings →
#   Builds & deployments → Build configuration → Build output directory: site
#
# Called by scripts/deploy-all.sh and deploy-frontend.sh. Safe to re-run.
#
# What is deliberately NOT published:
#   - *.map source maps (vite writes them; they stay in app/dist for local
#     symbolication only)
#   - legacy.html and the old root-level index-*.js / exceljs.min-*.js /
#     pdf.worker bundles (the legacy app is retired; the files stay in git as
#     history, they are just not copied here)
#   - stale chunks in the root assets/ directory from earlier builds — only the
#     assets the current index.html actually loads (and what those load) are
#     copied
#   - everything else: docs, SQL, scripts, supabase/, app/, tests/, .env.example

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

MODE="dist"
case "${1:-}" in
  ""|--from-dist) MODE="dist" ;;
  --from-root)    MODE="root" ;;
  *) echo "usage: bash scripts/build-site.sh [--from-dist|--from-root]" >&2; exit 2 ;;
esac

# Every static file the public site needs, and nothing else. Each one is
# referenced by a page, a crawler, or a third-party embed:
#   policy/marketing pages   linked from the landing page and from each other
#   unsubscribe.html         linked from every marketing email footer
#   widget.js                embedded on customers' websites — must never 404
#   track.js                 first-party analytics, loaded by the static pages
#   og-cover.png             og:image / JSON-LD logo
#   favicon.svg              <link rel="icon"> on every static page
#   llms.txt robots.txt sitemap.xml   crawlers
#   _headers _redirects      Cloudflare Pages configuration
STATIC_FILES=(
  product.html
  pricing.html
  contact-us.html
  privacy-policy.html
  terms-and-conditions.html
  refund-and-cancellation-policy.html
  unsubscribe.html
  llms.txt
  robots.txt
  sitemap.xml
  _headers
  _redirects
  widget.js
  track.js
  og-cover.png
  favicon.svg
)

if [ "$MODE" = "dist" ]; then
  SRC_INDEX="$ROOT/app/dist/index.html"
  SRC_ASSETS="$ROOT/app/dist/assets"
else
  SRC_INDEX="$ROOT/index.html"
  SRC_ASSETS="$ROOT/assets"
fi

[ -f "$SRC_INDEX" ]  || { echo "build-site: $SRC_INDEX not found (run the app build first)" >&2; exit 1; }
[ -d "$SRC_ASSETS" ] || { echo "build-site: $SRC_ASSETS not found" >&2; exit 1; }
for f in "${STATIC_FILES[@]}"; do
  [ -f "$ROOT/$f" ] || { echo "build-site: missing static file $f — refusing to publish an incomplete site" >&2; exit 1; }
done

# Build into a fresh temporary directory OUTSIDE the repo and swap it in at
# the end, so a failure halfway never leaves a half-populated site/ (or a stray
# build directory) for deploy-all.sh's `git add -A` to commit.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/abrobot-site.XXXXXX")"
mkdir -p "$TMP/assets"
trap 'rm -rf "$TMP"' EXIT

for f in "${STATIC_FILES[@]}"; do
  cp "$ROOT/$f" "$TMP/$f"
done
cp "$SRC_INDEX" "$TMP/index.html"

# Copy the assets the shell needs. Starting from index.html, follow every
# /assets/... and ./chunk.js reference transitively through JS and CSS, so a
# lazily-imported chunk (exceljs, pdf.worker, a route split) is included and
# an unreferenced stale chunk is not. In dist mode every non-map file in
# app/dist/assets is the current build (vite empties dist on each build), so
# those are all copied too — harmless, and it covers asset URLs built at
# runtime that a static scan cannot see.
node - "$SRC_INDEX" "$SRC_ASSETS" "$TMP/assets" "$MODE" <<'JS'
const fs = require("fs");
const path = require("path");
const [indexFile, srcAssets, outAssets, mode] = process.argv.slice(2);

const REF = /(?:\/assets\/|["'`(]\.\/)([A-Za-z0-9._-]+\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|ico|wasm|json))/g;
const refsIn = (text) => [...text.matchAll(REF)].map((m) => m[1]);

const wanted = new Set();
const queue = refsIn(fs.readFileSync(indexFile, "utf8"));
if (mode === "dist") {
  for (const f of fs.readdirSync(srcAssets)) {
    if (!f.endsWith(".map") && fs.statSync(path.join(srcAssets, f)).isFile()) queue.push(f);
  }
}
const missing = [];
while (queue.length) {
  const name = queue.shift();
  if (wanted.has(name) || name.endsWith(".map")) continue;
  const src = path.join(srcAssets, name);
  if (!fs.existsSync(src)) { missing.push(name); continue; }
  wanted.add(name);
  if (/\.(m?js|css)$/.test(name)) queue.push(...refsIn(fs.readFileSync(src, "utf8")));
}
if (missing.length) {
  // A reference to a file that does not exist would be a broken page once
  // published. Some matches inside minified JS are string fragments rather
  // than real imports, so only references from index.html itself are fatal.
  const fromIndex = new Set(refsIn(fs.readFileSync(indexFile, "utf8")));
  const fatal = missing.filter((m) => fromIndex.has(m));
  if (fatal.length) {
    console.error("build-site: index.html references assets that do not exist: " + fatal.join(", "));
    process.exit(1);
  }
}
for (const name of [...wanted].sort()) {
  fs.copyFileSync(path.join(srcAssets, name), path.join(outAssets, name));
  console.log("    assets/" + name);
}
JS

# ── Guard rails: refuse to publish anything that is not meant to be public ──
BAD="$(find "$TMP" -type f \( -name '*.map' -o -name '*.md' -o -name '*.sql' -o -name '*.ts' \
          -o -name '*.tsx' -o -name '*.sh' -o -name '*.cjs' -o -name '.env*' \) -print)"
if [ -n "$BAD" ]; then
  echo "build-site: refusing to publish:" >&2
  echo "$BAD" >&2
  exit 1
fi
for d in supabase scripts app tests node_modules .git; do
  [ ! -e "$TMP/$d" ] || { echo "build-site: refusing to publish directory $d/" >&2; exit 1; }
done

# Replace site/ wholesale: a file dropped from the allowlist, or a chunk from
# a previous build, must disappear from the published directory too.
rm -rf "$ROOT/site"
cp -R "$TMP" "$ROOT/site"

echo "build-site: site/ rebuilt from $MODE ($(find "$ROOT/site" -type f | wc -l | tr -d ' ') files)"
