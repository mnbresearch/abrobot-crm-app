// Does widget.js's linkify() ever emit markup an attacker chose?
//
// The message text it renders is MODEL OUTPUT, so a visitor who can talk the
// agent into echoing a string controls this input. The output goes into
// innerHTML on the CUSTOMER's own domain, so a handler that runs here runs
// with their origin and their cookies.
//
// Assertions are made against the PARSED DOM, not against the string. An
// earlier version of this test checked for /on\w+=/ in the text and failed on
// output that was correctly escaped and completely inert — the string looked
// alarming, the DOM was fine. What matters is what the browser builds.

const fs = require("fs");
const path = require("path");

// Resolved from this file's location. The first version hardcoded an absolute
// sandbox path, which made this suite error on CI (turning the tests job red on
// every push) and — worse, on a machine where the path resolved — read a
// DIFFERENT copy of widget.js than the one being built, reporting PASS about
// code that was not under test.
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

// The widget is a plain browser script with no module system, so the function
// under test is lifted out by source. `throw` on a miss rather than returning
// something empty: a rename or reformat must fail loudly here, not silently
// leave the XSS assertions running against nothing.
function extractLinkify(file) {
  if (!fs.existsSync(file)) {
    throw new Error(
      "widget source not found at " + file +
      " — the suite resolves it from __dirname, so this means the repo layout moved.",
    );
  }
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("function linkify(t) {");
  if (start < 0) {
    throw new Error(
      "linkify() not found in " + file + ". If it was renamed or reformatted, update this " +
      "extractor — do not delete the assertions, they cover a live XSS fix.",
    );
  }
  let depth = 0, end = -1;
  for (let k = src.indexOf("{", start); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  if (end < 0) throw new Error("unbalanced braces while extracting linkify() from " + file);
  return eval("(" + src.slice(start, end) + ")");
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log("FAIL: " + name + (extra ? "\n      " + extra : "")); }
};

// A deliberately small HTML parser is the wrong tool here; use a real one if
// available, and fall back to a strict structural check if not.
let parse;
try {
  const { JSDOM } = require("jsdom");
  parse = (html) => new JSDOM("<div id=r>" + html + "</div>").window.document.getElementById("r");
} catch {
  parse = null;
}

const ATTACKS = [
  'https://example.com/"onmouseover="alert(document.domain)',   // the audit's exact payload
  'https://a.com/" onload="x',
  "https://a.com/' onload='x",
  'https://a.com/"><script>alert(1)</script>',
  'https://a.com/"><img src=x onerror=alert(1)>',
  'https://a.com/`onmouseover=`alert(1)',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  'javascript:alert(1)',
  'Visit https://a.com/?q=" autofocus onfocus="alert(1)',
  'https://a.com/&quot;onmouseover=&quot;alert(1)',             // pre-escaped input
  'https://a.com/%22onmouseover=%22alert(1)',                   // percent-encoded
];

for (const file of ["widget.js", "abrobot-crm-site-v15/widget.js"]) {
  const abs = path.join(REPO_ROOT, file);
  const linkify = extractLinkify(abs);

  for (const attack of ATTACKS) {
    const html = linkify(attack);

    if (parse) {
      const root = parse(html);
      const els = root.querySelectorAll("*");
      for (const el of els) {
        check(`${file}: only <a>/<strong> survive :: ${attack}`,
          ["A", "STRONG"].includes(el.tagName), el.tagName + " in " + html);
        for (const at of Array.from(el.attributes)) {
          check(`${file}: no event handler :: ${attack}`,
            !/^on/i.test(at.name), at.name + "=" + at.value);
        }
        if (el.tagName === "A") {
          check(`${file}: href is http(s) :: ${attack}`,
            /^https?:\/\//i.test(el.getAttribute("href") || ""), el.getAttribute("href"));
          check(`${file}: href holds no quote :: ${attack}`,
            !/["'<>]/.test(el.getAttribute("href") || ""), el.getAttribute("href"));
        }
      }
    } else {
      // No jsdom: assert the only tags emitted are ones we generate ourselves.
      const tags = (html.match(/<\/?([a-z][a-z0-9]*)/gi) || []).map((s) => s.replace(/<\/?/, "").toLowerCase());
      check(`${file}: only a/strong emitted :: ${attack}`,
        tags.every((t) => t === "a" || t === "strong"), html);
      check(`${file}: no handler inside a tag :: ${attack}`,
        !/<[^>]*\son\w+\s*=/i.test(html), html);
    }
  }

  // It must still do the job it exists for.
  const good = linkify("Read https://abrobot.ai/pricing and https://x.io/a?b=1&c=2 today.");
  check(`${file}: url is linked`, good.includes('href="https://abrobot.ai/pricing"'), good);
  check(`${file}: ampersand in query escaped`, good.includes("b=1&amp;c=2"), good);
  check(`${file}: trailing full stop left out of the link`, /today\.$/.test(good), good);
  check(`${file}: rel hardened`, (good.match(/rel="noopener noreferrer"/g) || []).length === 2, good);
  check(`${file}: plain text untouched`, linkify("hello world") === "hello world");
  check(`${file}: bare ampersand escaped`, linkify("a & b") === "a &amp; b");
  check(`${file}: angle brackets escaped`, linkify("1 < 2 > 0") === "1 &lt; 2 &gt; 0");
}

// Root widget.js keeps the markdown extras.
const rootLinkify = extractLinkify(path.join(REPO_ROOT, "widget.js"));
check("bold still renders", rootLinkify("**hi**").includes("<strong>hi</strong>"));
check("bullets still render", rootLinkify("- one").startsWith("•"));

if (fail > 0) {
  console.log(`FAILED - ${fail} of ${pass + fail}`);
  process.exit(1);
}

if (parse) {
  console.log(`PASS - ${pass} assertions across both widget copies (DOM-parsed)`);
} else {
  // Deliberately the harness's SKIP word, which CI treats as a hard failure.
  // The string assertions above did run and did pass, but they are the weaker
  // check, and a security suite quietly downgrading itself on the machine that
  // gates releases is the exact shape of problem this repo keeps finding.
  // Locally it is a warning; on CI, jsdom is installed, so it never fires.
  console.log(`SKIP - jsdom is not installed, so the DOM assertions did not run.`);
  console.log(`       ${pass} string-level assertions passed. Run: npm install --no-save jsdom`);
}
process.exit(0);
