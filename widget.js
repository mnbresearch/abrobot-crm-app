/* ============================================================
   AbroBot AI chat widget — free, fully CRM-configurable.
   Embed (before </body>):
     <script src="https://crm.mnbresearch.com/widget.js" data-org="your-org-slug"></script>
   Everything (greeting, look, quick replies, colours, position, agent name)
   is controlled from the CRM → Settings → AI Agent. This script just renders it.
   ============================================================ */
(function () {
  // Loading twice must not build two widgets. The `built` flag further down is
  // a closure variable, so a second <script> tag gets its own closure and its
  // own `built = false` — producing two buttons, two panels, two config
  // fetches and two separate chat sessions. That is not hypothetical: a
  // duplicated GTM tag, or a theme that includes the snippet alongside a
  // manual paste, is the normal way this happens.
  if (window.__abxLoaded) return;
  window.__abxLoaded = true;

  var s = document.currentScript;

  // document.currentScript is NULL when a script is injected programmatically
  // — which is exactly what Google Tag Manager, Shopify's script-tag API,
  // Segment and most "add custom JS" site builders do.
  //
  // The old fallback was the literal string "abrobot". So a hospital
  // installing via GTM did not get an error: they got a working widget wired
  // to AbroBot's organisation — AbroBot's greeting, AbroBot's knowledge base,
  // and their own visitors' enquiries filed into AbroBot's CRM. A silent
  // cross-tenant leak caused by an install method we recommend.
  //
  // Look the tag up by src instead, and if the org still cannot be resolved,
  // refuse to render. A missing widget is a support ticket; the wrong tenant's
  // widget is a data-protection incident.
  if (!s || !s.getAttribute("data-org")) {
    s = document.querySelector('script[src*="widget.js"][data-org]');
  }
  var ORG = s && s.getAttribute("data-org");
  if (!ORG) {
    console.error(
      "[AbroBot widget] No data-org found. Add data-org=\"your-org-slug\" to the " +
      "script tag. Refusing to load rather than guess which business this is.",
    );
    return;
  }

  var API = "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/chat-agent";

  // ── Fallbacks, and why none of them name a company ────────────────────────
  //
  // This object used to hold AbroBot's branding: "Study-abroad assistant ·
  // online", a greeting about universities and visas, AbroBot's orange,
  // AbroBot's logo, AbroBot's Calendly and abrobot.ai as the contact link.
  //
  // That was not a rare error path. boot() reads this object ONCE and bakes the
  // colour, header, subtitle, logo and contact link straight into the DOM, and
  // it is called by a 2500 ms timer that a Supabase cold start routinely beats.
  // When the real config arrived a moment later it was a no-op, because
  // `booted` was already true. So every slow first load on a customer's site —
  // the first visitor of every quiet hour — rendered a competitor's brand, and
  // then kept it for the life of the page.
  //
  // The fix is not a longer timer. It is that a default which names a specific
  // business is wrong for every other business, so there are none. What is left
  // is deliberately anonymous: it says nothing that could be false for anyone.
  var CFG = {
    enabled: true,
    header_title: "Chat", header_subtitle: "Online",
    greeting: "Hi 👋 How can we help?",
    teaser: "Hi 👋 How can we help?",
    quick_replies: [],
    cta_text: "📅 Book a call",
    // data-* attributes still win, so an operator can hardcode these per site.
    // Absent them these are null, and every consumer below hides the control
    // rather than substituting somebody else's URL.
    booking_url: (s && s.getAttribute("data-booking")) || null,
    contact_url: (s && s.getAttribute("data-contact")) || null,
    whatsapp: null,
    widget_color: "#2f3a4a", widget_position: "right",
    logo_url: (s && s.getAttribute("data-logo")) || null
  };

  function shade(hex, p) {
    try {
      var n = parseInt(hex.replace("#", ""), 16), t = p < 0 ? 0 : 255, q = Math.abs(p) / 100;
      var r = Math.round((((n >> 16) & 255)) * (1 - q) + t * q);
      var g = Math.round(((n >> 8) & 255) * (1 - q) + t * q);
      var b = Math.round((n & 255) * (1 - q) + t * q);
      return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    } catch (e) { return hex; }
  }

  // Readable text ON the accent colour.
  //
  // Four rules hardcoded #1a1205 — a near-black brown chosen when the default
  // accent was orange. The default is now slate (#2f3a4a), and shade(slate,22)
  // is about #5d6572, so dark-brown-on-dark-slate came out at roughly 2.5:1:
  // user bubbles, the send button and the CTA chip were unreadable on every
  // tenant who had not picked a colour. Compute it instead of assuming.
  function onAccent(hex) {
    try {
      var n = parseInt(String(hex).replace("#", ""), 16);
      // Rec. 601 luma — good enough to choose between two texts.
      var l = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
      return l > 150 ? "#14110c" : "#ffffff";
    } catch (e) { return "#ffffff"; }
  }

  var convId = null, open = false, busy = false, built = false;

  function boot() {
    if (built) return; built = true;
    var C = CFG.widget_color || "#2f3a4a";
    var GRAD = "linear-gradient(90deg," + shade(C, -8) + " 0%," + shade(C, 22) + " 50%," + C + " 100%)";
    var FG = onAccent(shade(C, 22));
    var SIDE = CFG.widget_position === "left" ? "left" : "right";
    var LOGO = CFG.logo_url;
    var escAttr = function (v) {
      // logo_url is tenant-typed config interpolated into a src="..."
      // attribute. The escaping added for the header skipped this one
      // because esc() is defined further down, inside boot().
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    var logoImg = function () {
      return LOGO ? '<img alt="chat" src="' + escAttr(LOGO) + '" onerror="this.onerror=null;this.replaceWith(document.createTextNode(\'\\uD83D\\uDCAC\'))"/>' : "💬";
    };

    var css = document.createElement("style");
    css.textContent = [
      "@keyframes abxglow{0%,100%{box-shadow:0 10px 30px " + C + "59,0 0 0 1px " + C + "40}50%{box-shadow:0 12px 42px " + C + "99,0 0 0 1px " + C + "73}}",
      "@keyframes abxpop{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}",
      "@keyframes abxin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@keyframes abxdot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}",
      "@keyframes abxshine{0%{background-position:0% 50%}100%{background-position:200% 50%}}",
      ".abx-brand{background:" + GRAD + ";background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:800;animation:abxshine 4s linear infinite}",
      ".abx-btn{position:fixed;bottom:22px;" + SIDE + ":22px;width:64px;height:64px;border-radius:50%;background:#0b0b0e;border:none;cursor:pointer;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:0;overflow:hidden;animation:abxglow 3.2s ease-in-out infinite;transition:transform .2s;font-size:28px}",
      ".abx-btn:hover{transform:scale(1.07)}",
      ".abx-btn img{width:70%;height:70%;object-fit:contain}",
      ".abx-btn .abx-x{color:#fff;font-size:24px;font-weight:300}",
      ".abx-teaser{position:fixed;bottom:96px;" + SIDE + ":24px;max-width:250px;background:#111114;color:#f4f4f6;border:1px solid #2a2a31;border-radius:16px;border-bottom-" + SIDE + "-radius:4px;padding:12px 34px 12px 14px;font:14px/1.5 'Segoe UI',system-ui,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,.5);z-index:2147482999;cursor:pointer;display:none;animation:abxpop .35s cubic-bezier(.22,1,.36,1)}",
      ".abx-teaser.on{display:block}",
      ".abx-teaser .cl{position:absolute;top:6px;right:8px;color:#7a7a85;font-size:15px;cursor:pointer;line-height:1}",
      ".abx-teaser .cl:hover{color:#fff}",
      ".abx-panel{position:fixed;bottom:100px;" + SIDE + ":22px;width:380px;max-width:calc(100vw - 32px);height:566px;max-height:calc(100vh - 140px);background:#0d0d10;border:1px solid #23232a;border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.6);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}",
      ".abx-panel.on{display:flex;animation:abxpop .3s cubic-bezier(.22,1,.36,1)}",
      ".abx-head{display:flex;align-items:center;gap:11px;background:linear-gradient(180deg,#161619,#0d0d10);padding:15px 16px;border-bottom:1px solid #23232a;position:relative}",
      ".abx-head::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:" + GRAD + "}",
      ".abx-head .av{width:38px;height:38px;border-radius:11px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 0 1px #2a2a31;font-size:20px}",
      ".abx-head .av img{width:78%;height:78%;object-fit:contain}",
      ".abx-head .ttl{font-size:16.5px;font-weight:700;color:#fff;letter-spacing:.2px}",
      ".abx-head .sub{font-size:11.5px;color:#8a8a94;display:flex;align-items:center;gap:5px;margin-top:1px}",
      ".abx-head .sub i{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;font-style:normal}",
      ".abx-body{flex:1;overflow-y:auto;padding:16px;background:#0d0d10;display:flex;flex-direction:column;gap:10px}",
      ".abx-msg{max-width:85%;padding:11px 14px;border-radius:15px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;animation:abxin .25s ease both}",
      ".abx-bot{background:#1a1a1f;border:1px solid #26262d;color:#e8e8ea;align-self:flex-start;border-bottom-left-radius:5px}",
      ".abx-user{background:" + GRAD + ";color:" + FG + ";font-weight:600;align-self:flex-end;border-bottom-right-radius:5px}",
      ".abx-bot a{color:" + shade(C, 25) + ";font-weight:600}",
      ".abx-dots{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#1a1a1f;border:1px solid #26262d;border-radius:15px}",
      ".abx-dots i{width:7px;height:7px;border-radius:50%;background:" + C + ";animation:abxdot 1.2s infinite}",
      ".abx-dots i:nth-child(2){animation-delay:.15s}.abx-dots i:nth-child(3){animation-delay:.3s}",
      ".abx-foot{display:flex;gap:8px;padding:12px;background:#111114;border-top:1px solid #23232a}",
      ".abx-foot input{flex:1;border:1px solid #2a2a31;border-radius:13px;padding:12px 14px;font-size:14px;outline:none;background:#16161a;color:#f4f4f6}",
      ".abx-foot input::placeholder{color:#6b6b74}",
      ".abx-foot input:focus{border-color:" + C + ";box-shadow:0 0 0 3px " + C + "2e}",
      ".abx-foot button{background:" + GRAD + ";color:" + FG + ";border:none;border-radius:13px;padding:0 17px;font-size:17px;font-weight:700;cursor:pointer;transition:transform .15s}",
      ".abx-foot button:active{transform:scale(.93)}",
      ".abx-cred{text-align:center;font-size:10.5px;color:#5f5f68;padding:7px;background:#111114}",
      ".abx-hcta{margin-left:auto;font-size:11px;color:" + shade(C, 25) + ";text-decoration:none;border:1px solid " + shade(C, -35) + ";background:" + shade(C, -60) + ";padding:6px 10px;border-radius:9px;white-space:nowrap;font-weight:600}",
      ".abx-hcta:hover{background:" + shade(C, -45) + ";border-color:" + C + "}",
      ".abx-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px;animation:abxin .3s ease both}",
      ".abx-chip{background:#16161a;border:1px solid #2a2a31;color:#e0e0e4;border-radius:999px;padding:8px 13px;font-size:12.5px;cursor:pointer;text-decoration:none;transition:all .18s;font-family:inherit}",
      ".abx-chip:hover{border-color:" + C + ";color:#fff;transform:translateY(-1px)}",
      ".abx-chip.cta{background:" + GRAD + ";color:" + FG + ";font-weight:700;border:none}"
    ].join("");
    document.head.appendChild(css);

    var btn = document.createElement("button");
    btn.className = "abx-btn"; btn.setAttribute("aria-label", CFG.header_title && CFG.header_title !== "Chat" ? "Chat with " + CFG.header_title : "Open chat");
    btn.innerHTML = logoImg();
    document.body.appendChild(btn);

    var teaser = document.createElement("div");
    teaser.className = "abx-teaser";
    // textContent for the tenant's string, not innerHTML. This is config typed
    // in Settings and rendered on the customer's own site; the escaping added
    // for header_title and header_subtitle skipped this line, which is the one
    // that renders before anyone clicks anything.
    var tclose = document.createElement("span");
    tclose.className = "cl"; tclose.setAttribute("aria-label", "Dismiss"); tclose.textContent = "✕";
    teaser.appendChild(tclose);
    teaser.appendChild(document.createTextNode(CFG.teaser || ""));
    document.body.appendChild(teaser);
    teaser.querySelector(".cl").onclick = function (e) { e.stopPropagation(); teaser.classList.remove("on"); };
    teaser.onclick = function () { teaser.classList.remove("on"); if (!open) toggle(); };

    var panel = document.createElement("div");
    panel.className = "abx-panel";

    // Escape everything that comes from config. These strings are typed by the
    // tenant in Settings and rendered here with innerHTML, so an apostrophe in
    // a business name used to break the markup and an angle bracket could do
    // considerably worse on their own visitors.
    function esc(v) {
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    // Was: CFG.header_title.replace(/(AbroBot|AbroBot AI)/i, …) — the tenant's
    // own header had AbroBot's name highlighted in it, if it happened to
    // contain it. Nothing about one tenant's brand belongs in another's header.
    var titleHtml = esc(CFG.header_title);

    // Only render the header link when there is somewhere for it to go.
    // Previously this interpolated CFG.contact_url unconditionally, so a
    // business that had not set one shipped href="null" — a visible, clickable
    // "Talk to expert" button that navigated to a 404 on their own domain.
    var ctaHtml = CFG.contact_url
      ? '<a class="abx-hcta" href="' + esc(CFG.contact_url) + '" target="_blank" rel="noopener">📞 Talk to us</a>'
      : "";

    panel.innerHTML =
      '<div class="abx-head"><span class="av">' + logoImg() + '</span>' +
        '<div><div class="ttl">' + titleHtml + '</div>' +
        '<div class="sub"><i></i> ' + esc(CFG.header_subtitle) + '</div></div>' +
        ctaHtml + '</div>' +
      '<div class="abx-body" id="abxBody"></div>' +
      '<div class="abx-foot"><input id="abxInput" placeholder="Type your message…" autocomplete="off"/><button id="abxSend" aria-label="Send">➤</button></div>' +
      // The platform credit, not the tenant's own name. This used to read
      // "Powered by <tenant>", which is circular on the tenant's own website
      // and would now render "Powered by Chat" whenever config was still in
      // flight.
      '<div class="abx-cred">Powered by <a class="abx-brand" href="https://crm.mnbresearch.com" target="_blank" rel="noopener">AbroBot CRM</a></div>';
    document.body.appendChild(panel);

    var body = panel.querySelector("#abxBody");
    var input = panel.querySelector("#abxInput");
    var send = panel.querySelector("#abxSend");

    setTimeout(function () {
      if (!open && !sessionStorage.getItem("abxTeaser")) { teaser.classList.add("on"); sessionStorage.setItem("abxTeaser", "1"); }
    }, 1000);

    // Renders an assistant message. LLMs emit markdown whether or not you ask
    // them to, and this used to pass it through untouched — so every reply
    // containing emphasis showed literal "**Core documents**" to the visitor
    // on every tenant's site. Handling the two constructs the model actually
    // produces (bold, and "- " bullets) is enough; a full markdown parser is
    // not worth the bytes in an embedded widget.
    //
    // ORDER MATTERS: escaping happens FIRST, so by the time the tags below are
    // inserted, any < > & in the model's output is already inert. Never move a
    // replace() that emits HTML above the escape step.
    function linkify(t) {
      var esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      esc = esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

      // **bold** — non-greedy, and refuses to span a blank line so an unclosed
      // ** cannot swallow the rest of the message.
      esc = esc.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");

      // Leading "- " or "* " becomes a real bullet. Cheaper than a <ul> and it
      // keeps the existing line-break behaviour intact.
      esc = esc.replace(/^[ \t]*[-*][ \t]+/gm, "• ");

      return esc;
    }
    function add(role, text) {
      var d = document.createElement("div");
      d.className = "abx-msg " + (role === "user" ? "abx-user" : "abx-bot");
      if (role === "user") d.textContent = text; else d.innerHTML = linkify(text);
      body.appendChild(d); body.scrollTop = body.scrollHeight;
    }
    function addChips() {
      var wrap = document.createElement("div");
      wrap.className = "abx-chips";
      (CFG.quick_replies || []).forEach(function (it) {
        var b = document.createElement("button");
        b.className = "abx-chip"; b.textContent = it.label;
        b.onclick = function () { input.value = it.prompt; ask(); };
        wrap.appendChild(b);
      });
      if (CFG.booking_url) {
        var a = document.createElement("a");
        a.className = "abx-chip cta"; a.href = CFG.booking_url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = CFG.cta_text || "📅 Book a call";
        wrap.appendChild(a);
      }
      body.appendChild(wrap); body.scrollTop = body.scrollHeight;
    }
    function toggle() {
      open = !open; panel.classList.toggle("on", open);
      teaser.classList.remove("on");
      btn.innerHTML = open ? '<span class="abx-x">✕</span>' : logoImg();
      if (open && !body.hasChildNodes()) { add("bot", CFG.greeting); addChips(); input.focus(); }
    }
    btn.onclick = toggle;

    async function ask() {
      var text = input.value.trim();
      if (!text || busy) return;
      var ch = body.querySelector(".abx-chips"); if (ch) ch.remove();
      input.value = ""; add("user", text); busy = true;
      var dots = document.createElement("div");
      dots.className = "abx-dots"; dots.innerHTML = "<i></i><i></i><i></i>";
      body.appendChild(dots); body.scrollTop = body.scrollHeight;
      try {
        var r = await fetch(API + "?org=" + encodeURIComponent(ORG), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ org: ORG, conversation_id: convId, page_url: location.href, message: text })
        });
        var data = await r.json();
        dots.remove();
        if (data.conversation_id) convId = data.conversation_id;
        add("bot", data.reply || "Sorry, please try again" + (CFG.whatsapp ? " or WhatsApp " + CFG.whatsapp : "") + ".");
      } catch (e) {
        dots.remove();
        add("bot", "Connection issue — please try again" + (CFG.whatsapp ? " or WhatsApp us at " + CFG.whatsapp : "") + ".");
      }
      busy = false; input.focus();
    }
    send.onclick = ask;
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });
  }

  // ── Per-org PRESETS removed, 2026-09-11 ──────────────────────────────────
  // This file is served to every customer's website. It contained hardcoded
  // configuration for two named businesses — their logos, their contact pages
  // and their WhatsApp numbers — which meant every AbroBot CRM customer was
  // downloading two other customers' phone numbers as a side effect of
  // installing the widget.
  //
  // The presets existed because the config endpoint did not. It does now, and
  // 20260911090000 seeds real per-industry copy, so an org with no
  // configuration renders sensibly without anyone hardcoding it here.


  // Load live config from the CRM, then render.
  //
  // boot() used to be reachable ONLY from .then() or .catch(). A rejected
  // promise was handled; a promise that never settles was not. A cold-start
  // stall, a Supabase incident, or a captive-portal Wi-Fi that black-holes the
  // request meant the customer's site showed NO chat button at all,
  // indefinitely, with nothing logged anywhere.
  //
  // The button should never wait on a network round-trip. Render with the
  // presets after a short grace period; if config arrives later, boot() is
  // idempotent via the `built` flag, and the styling is already applied.
  var booted = false;
  function bootOnce() { if (!booted) { booted = true; boot(); } }
  var fallbackTimer = setTimeout(bootOnce, 2500);

  fetch(API + "?org=" + encodeURIComponent(ORG) + "&config=1")
    .then(function (r) { return r.json(); })
    .then(function (c) {
      clearTimeout(fallbackTimer);
      // Agent turned off in the CRM → don't render. Only honour this when the
      // response actually arrived; a failed fetch must not hide the widget.
      if (c && c.enabled === false) { booted = true; return; }
      if (c && typeof c === "object") { for (var k in c) if (c[k] != null) CFG[k] = c[k]; }
      bootOnce();
    })
    .catch(function () { clearTimeout(fallbackTimer); bootOnce(); });
})();
