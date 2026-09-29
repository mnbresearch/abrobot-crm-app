/**
 * The SPA shell's search-visibility contract.
 *
 * index.html is one file doing three jobs — landing page, sign-in form, and the
 * shell for fifteen app routes — and it is served for EVERY url on the domain
 * that is not a real file, because `_redirects` ends with `/* /index.html 200`.
 * That makes its <head> unusually load-bearing, and unusually easy to break
 * without noticing: nothing in a build or a typecheck looks at a meta tag.
 *
 * Two specific ways it has already been broken, both of which these assertions
 * would have caught:
 *
 *   - It carried `noindex` for months, which kept the front door — the one page
 *     the product should be found by — out of every search index.
 *   - The root copy is a build artifact (`cp app/dist/index.html index.html`),
 *     so anyone editing the root file instead of app/index.html loses the change
 *     silently at the next deploy. The two are asserted identical here.
 *
 * Paths are resolved from __dirname, never from a hardcoded absolute path. An
 * earlier pair of test files in this repo hardcoded a sandbox path; on CI they
 * errored, and on the machine where the path happened to resolve they tested a
 * DIFFERENT CHECKOUT of the repo and reported PASS. A test that passes against
 * the wrong files is worse than no test.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const appShell = read("app/index.html");
const rootShell = read("index.html");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");
const redirects = read("_redirects");
const appTsx = read("app/src/App.tsx");

const CANONICAL = "https://crm.mnbresearch.com/";
const TITLE = "AbroBot CRM — the AI CRM that works your leads while you sleep";

// Both copies must satisfy every head assertion. The root one is what is
// actually served today; the app one is what the next build will produce.
const shells = [["app/index.html", appShell], ["index.html", rootShell]];

test("the shell is indexable", () => {
  for (const [name, html] of shells) {
    const robotsMeta = html.match(/<meta name="robots" content="([^"]+)"/);
    assert.ok(robotsMeta, `${name}: no robots meta tag at all`);
    assert.doesNotMatch(
      robotsMeta[1], /noindex/i,
      `${name}: robots meta says "${robotsMeta[1]}". noindex here hides the landing page ` +
      `from every search engine. The soft-404 problem it used to guard is handled by the ` +
      `canonical instead — see the comment in app/index.html.`,
    );
    assert.match(robotsMeta[1], /\bindex\b/, `${name}: robots meta should positively say index`);
  }
});

test("a self-referencing canonical absorbs the soft 404s", () => {
  // This is the only thing standing between us and every typo'd url on the
  // domain being indexed as a duplicate of the homepage, because the catch-all
  // returns this file with HTTP 200 rather than a 404.
  for (const [name, html] of shells) {
    const links = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
    assert.strictEqual(links.length, 1, `${name}: expected exactly one canonical, found ${links.length}`);
    assert.strictEqual(links[0][1], CANONICAL, `${name}: canonical must be the bare origin + /`);
  }
  // If the catch-all ever goes away the canonical stops being load-bearing, so
  // assert the premise rather than letting the reasoning above go stale.
  assert.match(
    redirects, /^\/\*\s+\/index\.html\s+200\s*$/m,
    "_redirects no longer ends with the /* -> /index.html 200 catch-all. " +
    "Re-check whether the blanket canonical is still the right call.",
  );
});

test("the title and description describe the product, not the login form", () => {
  for (const [name, html] of shells) {
    const title = html.match(/<title>([^<]+)<\/title>/);
    assert.ok(title, `${name}: no <title>`);
    assert.strictEqual(title[1], TITLE, `${name}: title drifted`);

    const desc = html.match(/name="description"\s*\n?\s*content="([^"]+)"/);
    assert.ok(desc, `${name}: no meta description`);
    assert.ok(desc[1].length > 70 && desc[1].length < 320,
      `${name}: description is ${desc[1].length} chars; aim for 70-320`);
    assert.doesNotMatch(desc[1], /^Sign in/i,
      `${name}: the description still sells the sign-in form`);
  }
});

test("App.tsx sets the same title React-side as the static tag", () => {
  // A JS-rendering crawler reads the title after mount; a non-rendering one
  // reads the static tag. If they disagree, which one gets indexed depends on
  // how the page was fetched.
  assert.ok(
    appTsx.includes(`const LANDING_TITLE = "${TITLE}"`),
    "App.tsx's LANDING_TITLE no longer matches the <title> in app/index.html",
  );
  assert.match(appTsx, /document\.title\s*=/, "App.tsx no longer sets document.title per route");
});

test("social cards are complete enough to render", () => {
  for (const [name, html] of shells) {
    for (const prop of ["og:type", "og:url", "og:title", "og:description", "og:image",
                        "og:image:width", "og:image:height"]) {
      assert.match(html, new RegExp(`property="${prop}"`), `${name}: missing ${prop}`);
    }
    for (const nm of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
      assert.match(html, new RegExp(`name="${nm}"`), `${name}: missing ${nm}`);
    }
    const ogUrl = html.match(/property="og:url" content="([^"]+)"/)[1];
    assert.strictEqual(ogUrl, CANONICAL, `${name}: og:url and canonical must agree`);
  }
  // A card pointing at a missing image renders as a bare link everywhere.
  assert.ok(fs.existsSync(path.join(ROOT, "og-cover.png")), "og-cover.png is missing from the repo root");
});

test("the structured data parses and hangs together", () => {
  for (const [name, html] of shells) {
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(block, `${name}: no JSON-LD`);

    let graph;
    assert.doesNotThrow(() => { graph = JSON.parse(block[1]); },
      `${name}: JSON-LD is not valid JSON — Google discards the whole block silently`);

    const types = graph["@graph"].map((n) => n["@type"]);
    for (const t of ["Organization", "WebSite", "WebPage", "SoftwareApplication"]) {
      assert.ok(types.includes(t), `${name}: JSON-LD has no ${t} node`);
    }

    // Every @id referenced must be defined in this graph, or the reference
    // dangles and the nodes are read as unrelated entities.
    const defined = new Set(graph["@graph"].map((n) => n["@id"]).filter(Boolean));
    const refs = [];
    JSON.stringify(graph, (k, v) => {
      if (v && typeof v === "object" && !Array.isArray(v) &&
          Object.keys(v).length === 1 && typeof v["@id"] === "string") refs.push(v["@id"]);
      return v;
    });
    for (const r of refs) {
      assert.ok(defined.has(r), `${name}: JSON-LD references ${r}, which no node defines`);
    }

    // product.html already owns the organisation under this @id. Sharing it is
    // the point — two pages, one company.
    assert.ok(defined.has("https://crm.mnbresearch.com/#org"),
      `${name}: the Organization must keep the #org @id that product.html also uses`);

    // No rating we cannot substantiate. This is a structured-data violation and
    // a claim we would have to defend.
    assert.doesNotMatch(block[1], /aggregateRating|reviewCount|ratingValue/,
      `${name}: JSON-LD asserts a rating we have no reviews to back`);
  }
});

test("a crawler that does not run JavaScript still gets the pitch", () => {
  for (const [name, html] of shells) {
    const root = html.match(/<div id="root">([\s\S]*?)\n {4}<\/div>/);
    assert.ok(root, `${name}: could not find the #root container`);
    const inner = root[1];

    assert.match(inner, /<h1[\s>]/, `${name}: #root ships no H1 — a non-rendering crawler sees nothing`);
    const h1 = inner.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1].trim();
    assert.ok(h1.length > 15, `${name}: the static H1 is too thin to be useful: "${h1}"`);

    // Enough prose to be treated as a page rather than a stub.
    const text = inner.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
                      .replace(/\s+/g, " ").trim();
    assert.ok(text.length > 600,
      `${name}: only ${text.length} chars of static text in #root; that reads as a stub`);

    // Crawlable internal links out to the pages that are already indexed.
    for (const href of ["/product", "/pricing"]) {
      assert.match(inner, new RegExp(`href="${href}"`), `${name}: no static link to ${href}`);
    }
  }
});

test("the static hero is suppressed for signed-in users and off the homepage", () => {
  // Without this the marketing headline flashes over a signed-in user's
  // dashboard load, which is a regression on the blank div it replaced.
  for (const [name, html] of shells) {
    assert.match(html, /html\.pre-off #pre\s*{\s*display:\s*none/,
      `${name}: no CSS rule to hide the skeleton`);
    assert.match(html, /location\.pathname !== "\/"/,
      `${name}: the skeleton is not gated on being at /`);
    assert.match(html, /\^sb-\.\+-auth-token\$/,
      `${name}: the skeleton is not gated on an existing Supabase session`);
    // Must be synchronous in <head>. Deferring to DOMContentLoaded is too late:
    // the document has finished parsing and may already have painted.
    assert.doesNotMatch(html, /DOMContentLoaded[\s\S]{0,80}pre-off/,
      `${name}: the suppression waits for DOMContentLoaded, which can paint first`);
    // localStorage throws in Safari Lockdown Mode and storage-blocked iframes.
    const script = html.match(/<script>([\s\S]*?pre-off[\s\S]*?)<\/script>/);
    assert.match(script[1], /try\s*{/, `${name}: unguarded localStorage access in <head>`);
  }
});

test("the static hero's claims match the React component's", () => {
  /*
   * The skeleton in index.html restates the six capabilities so a non-rendering
   * crawler can read them. That makes the same sentence exist in two files, and
   * I predicted in the skeleton's own comment that it would drift. It drifted
   * within hours: two of the six were corrected in Landing.tsx as factually
   * wrong ("a Telegram or WhatsApp alert" — there is no WhatsApp alert path at
   * all; "stops the moment someone replies" — nothing reads inbound email) and
   * the shells kept serving the false version to every crawler and social
   * scraper. This is the check that would have caught it.
   *
   * Compares the `detail` strings from CAPABILITIES, which is the authoritative
   * copy, against the <li> text in both shells.
   */
  const landing = read("app/src/routes/Landing.tsx");

  const details = [...landing.matchAll(/^\s*detail:\s*"((?:[^"\\]|\\.)*)",\s*$/gm)]
    .map((m) => m[1].replace(/\\"/g, '"'));
  assert.strictEqual(details.length, 6,
    `expected 6 CAPABILITIES details in Landing.tsx, found ${details.length}`);

  for (const [name, html] of shells) {
    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    assert.strictEqual(items.length, 6, `${name}: expected 6 <li> capabilities, found ${items.length}`);

    for (let i = 0; i < 6; i++) {
      // The skeleton prefixes each with "<b>Title.</b> ", so the detail must be
      // the tail of the list item rather than the whole of it.
      assert.ok(
        items[i].endsWith(details[i]),
        `${name}: capability ${i + 1} has drifted from Landing.tsx.\n` +
        `  Landing.tsx : ${details[i]}\n` +
        `  ${name} : ${items[i]}\n` +
        `Fix the shell to match the component, then regenerate the root copy.`,
      );
    }
  }

  // Claims proven false by FEATURES.md. Named individually so the failure
  // message says WHY rather than just "a regex matched".
  const banned = [
    [/Telegram or WhatsApp/i, "there is no WhatsApp alert path — notifyNewLead() is Telegram-only"],
    [/stops the moment someone replies/i, "nothing in this system ingests inbound email"],
    [/switched on from a single screen/i, "setup spans Settings, Integrations and Automations"],
  ];

  // Comments are stripped first. Each correction in Landing.tsx and in the
  // shells documents the wording it replaced ("WAS: …"), which is exactly the
  // string being banned — checking the raw file flags the explanation of the
  // fix as though it were the defect. Only shipped copy counts.
  const shipped = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, " ")        // /* block */ and JSX {/* … */}
    .replace(/^\s*\/\/.*$/gm, " ")            // // line
    .replace(/<!--[\s\S]*?-->/g, " ");        // <!-- html -->

  for (const [re, why] of banned) {
    for (const [name, text] of [...shells, ["app/src/routes/Landing.tsx", landing]]) {
      assert.doesNotMatch(shipped(text), re, `${name}: reinstates a false claim — ${why}`);
    }
  }
});

test("the two shells agree on everything except the built asset tags", () => {
  const strip = (s) => s.split("\n")
    .filter((l) => !/\/assets\/|src="\/src\/main\.tsx"/.test(l))
    .join("\n");
  assert.strictEqual(
    strip(appShell), strip(rootShell),
    "app/index.html and index.html have diverged. The root file is a build artifact " +
    "(deploy-all.sh does `cp app/dist/index.html index.html`), so edit app/index.html — " +
    "but until the next build the root file is what is actually served, so both must match.",
  );
});

test("robots.txt fences the app off now that the shared noindex is gone", () => {
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);

  // Everything in App.tsx's NAV except the dashboard at `/`, which IS the
  // landing page for signed-out visitors and is the page we want ranked.
  for (const p of ["/login", "/leads", "/pipeline", "/calendar", "/conversations", "/templates",
                   "/automations", "/reports", "/activity", "/team", "/import", "/archived",
                   "/integrations", "/settings", "/admin"]) {
    assert.ok(disallowed.includes(p),
      `robots.txt does not Disallow ${p}. With noindex gone from the shell this list is ` +
      `the only thing keeping the app's own screens out of the results.`,
    );
  }
  assert.ok(!disallowed.includes("/"), "robots.txt Disallows / — that blocks the landing page");
  assert.match(robots, /^Sitemap:\s*https:\/\/crm\.mnbresearch\.com\/sitemap\.xml$/m,
    "robots.txt no longer points at the sitemap");
});

/**
 * Everything above reads the file as text. That proves the gate is WRITTEN; it
 * does not prove it WORKS. The failure this guards — a signed-in user seeing the
 * marketing headline flash over their dashboard load — is a behaviour, so it is
 * tested by executing the actual <head> script in a real DOM.
 *
 * Skips rather than fails when jsdom is absent, matching widget-linkify.test.cjs.
 * CI installs jsdom, so on CI this never skips.
 */
let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch { /* optional locally */ }

test("the suppression gate behaves correctly when actually executed", { skip: !JSDOM && "jsdom not installed" }, () => {
  // Runs against the root shell: that is the file Cloudflare actually serves.
  const load = (pathname, seed) => {
    const dom = new JSDOM(rootShell, {
      url: `https://crm.mnbresearch.com${pathname}`,
      runScripts: "dangerously",     // inline only; no resource loader is configured,
                                     // so the bundle and the font link are never fetched
      beforeParse(window) { if (seed) seed(window); },
    });
    const html = dom.window.document.documentElement;
    const pre = dom.window.document.getElementById("pre");
    return {
      suppressed: html.classList.contains("pre-off"),
      // The element must still be IN the document either way — it is what a
      // non-rendering crawler reads, so suppression has to be visual only.
      present: !!pre,
      text: pre ? pre.textContent.replace(/\s+/g, " ").trim() : "",
    };
  };

  const token = (w) => w.localStorage.setItem("sb-pomsltnrxvbcafwtbtlc-auth-token", '{"access_token":"x"}');

  // ── the page we want ranked ─────────────────────────────────────────────
  const anon = load("/");
  assert.strictEqual(anon.suppressed, false, "a signed-out visitor at / must see the hero");
  assert.ok(anon.text.includes("works the leads while you sleep"),
    "the hero text did not survive into the DOM");

  // ── the regression this exists to prevent ───────────────────────────────
  const signedIn = load("/", token);
  assert.strictEqual(signedIn.suppressed, true,
    "a signed-in user at / would see the marketing hero flash before the dashboard");
  assert.strictEqual(signedIn.present, true,
    "suppression must be visual — removing the element would also hide it from crawlers");

  // ── every other route served by the same shell ──────────────────────────
  for (const p of ["/leads", "/settings", "/login", "/pricng", "/leads/abc-123"]) {
    assert.strictEqual(load(p).suppressed, true,
      `${p} renders the sign-in form or an app screen, so it must not preview the hero`);
  }
  // …but a crawler landing on a typo'd url still reads the canonical, and the
  // hero is still in the markup for it, which is the point of not deleting it.
  assert.strictEqual(load("/pricng").present, true);

  // ── near misses that must NOT be read as a session ──────────────────────
  assert.strictEqual(load("/", (w) => w.localStorage.setItem("theme", "dark")).suppressed, false,
    "an unrelated localStorage key was mistaken for a session");
  assert.strictEqual(load("/", (w) => w.localStorage.setItem("sb-x-auth-token", "")).suppressed, false,
    "an empty token was mistaken for a live session");
  assert.strictEqual(load("/", (w) => w.localStorage.setItem("sb-x-auth-tokens", "v")).suppressed, false,
    "the key pattern is not anchored — `sb-x-auth-tokens` matched");

  // ── a different project ref, since it comes from VITE_SUPABASE_URL ──────
  assert.strictEqual(load("/", (w) => w.localStorage.setItem("sb-someotherref-auth-token", "v")).suppressed, true,
    "the gate is hardcoded to one project ref and breaks in another environment");

  // ── localStorage that throws: Safari Lockdown Mode, blocked iframes ─────
  const hostile = load("/", (w) => {
    Object.defineProperty(w, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: storage is disabled"); },
    });
  });
  assert.strictEqual(hostile.suppressed, false,
    "a throwing localStorage must fail open and show the hero, not blank the page");
  assert.ok(hostile.text.includes("works the leads while you sleep"),
    "the hero must survive a storage exception in <head>");
});

test("the sitemap lists / and contradicts nothing in robots.txt", () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.includes(CANONICAL), "sitemap.xml does not list the homepage");

  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map((m) => m[1]);
  for (const loc of locs) {
    const p = new URL(loc).pathname;
    assert.ok(
      !disallowed.some((d) => p === d || p.startsWith(d + "/")),
      `sitemap.xml lists ${loc}, which robots.txt Disallows. Asking a crawler to index ` +
      `something it may not fetch is reported as an error in Search Console.`,
    );
  }
  // .html forms 308-redirect to the extensionless address on Pages; listing one
  // advertises a redirect as a canonical.
  for (const loc of locs) {
    assert.doesNotMatch(loc, /\.html$/, `sitemap.xml lists ${loc}, which redirects`);
  }
});
