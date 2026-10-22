/**
 * site/ is the only thing Cloudflare Pages publishes. These assertions are the
 * contract that keeps it an allowlist.
 *
 * Until 14 October 2026 Pages served the repository root, so every doc,
 * migration, edge-function source file and script in this repo was a public
 * URL (/FEATURES.md, /supabase/migrations/*.sql, /app/src/**, /.env.example ...).
 * scripts/build-site.sh now rebuilds site/ from an explicit list on every
 * deploy and wrangler.toml points Pages at it. This test fails if:
 *
 *   - anything that is not meant to be public lands in site/ (source, docs,
 *     SQL, scripts, source maps, env files, whole repo directories);
 *   - a page in site/ links to a local file or route that does not exist there
 *     (a broken link, or a link that only worked because the repo root was
 *     published);
 *   - an allowlisted source file was edited but site/ was not rebuilt, so the
 *     edit would silently not go live;
 *   - the retired legacy app comes back (legacy.html, /get rewrites).
 *
 * Paths resolve from __dirname — never a hardcoded absolute path.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const STATIC_FILES = [
  "product.html", "pricing.html", "contact-us.html", "privacy-policy.html",
  "terms-and-conditions.html", "refund-and-cancellation-policy.html", "unsubscribe.html",
  "llms.txt", "robots.txt", "sitemap.xml", "_headers", "_redirects",
  "widget.js", "track.js", "og-cover.png", "favicon.svg",
];

test("site/ exists and wrangler.toml publishes it", () => {
  assert.ok(fs.existsSync(SITE), "site/ is missing — run: bash scripts/build-site.sh");
  const toml = read("wrangler.toml");
  assert.match(toml, /^pages_build_output_dir\s*=\s*"site"\s*$/m,
    "wrangler.toml must set pages_build_output_dir = \"site\"");
  assert.match(toml, /^name\s*=\s*"[^"]+"\s*$/m, "wrangler.toml must name the Pages project");
});

const files = fs.existsSync(SITE) ? walk(SITE) : [];

test("site/ contains no source, docs, SQL, scripts, maps or env files", () => {
  const bad = files.filter((f) =>
    /\.(md|sql|ts|tsx|sh|map|cjs|mjs\.map|toml|lock)$/i.test(f) ||
    /(^|\/)\.env/.test(f) || /(^|\/)package(-lock)?\.json$/.test(f));
  assert.deepStrictEqual(bad, [], `must not be published: ${bad.join(", ")}`);
});

test("site/ contains no repository directories", () => {
  for (const d of ["supabase", "scripts", "app", "tests", "node_modules", ".git", ".github",
                   "abrobot-crm-site-v15"]) {
    assert.ok(!fs.existsSync(path.join(SITE, d)), `site/${d}/ must not exist`);
  }
  const top = fs.readdirSync(SITE);
  const dirs = top.filter((n) => fs.statSync(path.join(SITE, n)).isDirectory());
  assert.deepStrictEqual(dirs, ["assets"], `only site/assets/ may be a directory, found: ${dirs.join(", ")}`);
});

test("site/ top level is exactly the allowlist plus index.html", () => {
  const top = fs.readdirSync(SITE).filter((n) => fs.statSync(path.join(SITE, n)).isFile()).sort();
  assert.deepStrictEqual(top, [...STATIC_FILES, "index.html"].sort());
});

test("the retired legacy app is not published", () => {
  assert.ok(!fs.existsSync(path.join(SITE, "legacy.html")), "legacy.html must not be in site/");
  const stray = files.filter((f) => /^(index-[A-Za-z0-9_-]+\.js|exceljs\.min-.*\.js|pdf\.worker\..*)$/.test(f));
  assert.deepStrictEqual(stray, [], `legacy root bundles published: ${stray.join(", ")}`);
  const redirects = read("_redirects");
  assert.doesNotMatch(redirects, /^[^#\n]*\/legacy/m, "_redirects still routes to the legacy app");
  assert.match(redirects, /^\/get\s+\/login\s+301\s*$/m, "_redirects must 301 /get to /login");
});

test("every allowlisted file in site/ is identical to its source (site/ is not stale)", () => {
  for (const f of STATIC_FILES) {
    const a = fs.readFileSync(path.join(ROOT, f));
    const b = fs.readFileSync(path.join(SITE, f));
    assert.ok(a.equals(b), `site/${f} differs from ${f} — re-run: bash scripts/build-site.sh`);
  }
  assert.ok(read("index.html") === fs.readFileSync(path.join(SITE, "index.html"), "utf8"),
    "site/index.html differs from the root index.html build copy — re-run the deploy build");
});

// SPA routes served by the /* -> /index.html catch-all. /login is the
// signed-out entry point; the rest come from App.tsx's KNOWN list.
function spaRoutes() {
  const app = read("app/src/App.tsx");
  const m = app.match(/const KNOWN = \[([\s\S]*?)\];/);
  assert.ok(m, "could not find KNOWN routes in app/src/App.tsx");
  return new Set(["/login", ...[...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])]);
}

function resolves(urlPath, routes) {
  const p = decodeURIComponent(urlPath.split(/[?#]/)[0]) || "/";
  if (p === "/") return true;
  if (routes.has(p) || /^\/leads\/[^/]+$/.test(p)) return true;
  const rel = p.replace(/^\//, "");
  if (rel.includes("..")) return false;
  const full = path.join(SITE, rel);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) return true;
  return fs.existsSync(full + ".html");
}

test("every local href/src in site/*.html resolves inside site/", () => {
  const routes = spaRoutes();
  const broken = [];
  for (const f of files.filter((n) => n.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(SITE, f), "utf8");
    // Values containing a quote are JS string concatenation inside an inline
    // script (href="' + WA + '"), not real attributes — skipped.
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      let u = m[1];
      if (/^(mailto:|tel:|data:|#|javascript:)/.test(u) || u.includes("'")) continue;
      if (/^https?:\/\//.test(u)) {
        const url = new URL(u);
        if (url.hostname !== "crm.mnbresearch.com") continue;
        u = url.pathname + url.search;
      }
      if (!u.startsWith("/")) continue;
      if (!resolves(u, routes)) broken.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(broken, [], `unresolved local links:\n  ${broken.join("\n  ")}`);
});

test("no page links to the retired /get signup", () => {
  for (const f of [...files.filter((n) => n.endsWith(".html")), "llms.txt"]) {
    const text = fs.readFileSync(path.join(SITE, f), "utf8");
    assert.doesNotMatch(text, /(crm\.mnbresearch\.com|href=")\/get\b/, `${f} still links to /get`);
  }
});

test("every static page declares the favicon", () => {
  for (const f of files.filter((n) => n.endsWith(".html") && n !== "index.html")) {
    const html = fs.readFileSync(path.join(SITE, f), "utf8");
    assert.match(html, /<link rel="icon" href="\/favicon\.svg"/, `${f} has no favicon link`);
  }
});

test("every asset the shell loads is present, and nothing in assets/ is a map", () => {
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const refs = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, "index.html references no /assets/ files — not a built shell");
  for (const r of refs) {
    assert.ok(fs.existsSync(path.join(SITE, "assets", r)), `site/assets/${r} missing`);
  }
  const maps = files.filter((f) => f.endsWith(".map"));
  assert.deepStrictEqual(maps, []);
});
