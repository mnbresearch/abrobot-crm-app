/* ============================================================
   AbroBot AI chat widget — free, fully CRM-configurable.
   Embed (before </body>):
     <script src="https://abrobot-crm-app.pages.dev/widget.js" data-org="abrobot"></script>
   Everything (greeting, look, quick replies, colours, position, agent name)
   is controlled from the CRM → Settings → AI Agent. This script just renders it.
   ============================================================ */
(function () {
  var s = document.currentScript;
  var ORG = (s && s.getAttribute("data-org")) || "abrobot";
  var API = "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/chat-agent";

  // sensible fallbacks if the config call fails
  var CFG = {
    enabled: true,
    header_title: "AbroBot AI", header_subtitle: "Study-abroad assistant · online",
    greeting: "Hi there! 👋 I'm the AbroBot AI assistant. Ask me anything about universities, scholarships, visas or SOPs.",
    teaser: "Hi there 👋 I'm AbroBot AI — ask me anything!",
    quick_replies: [
      { label: "🎓 Universities", prompt: "Which universities suit my profile?" },
      { label: "💰 Scholarships", prompt: "What scholarships can I get for studying abroad?" },
      { label: "🛂 Visa help", prompt: "Can you help me with my student visa?" }
    ],
    cta_text: "📅 Book a free call",
    booking_url: (s && s.getAttribute("data-booking")) || "https://calendly.com/mridulnanda2004/abrobot-meet",
    contact_url: (s && s.getAttribute("data-contact")) || "https://www.abrobot.ai/contactus",
    whatsapp: null,
    widget_color: "#f97316", widget_position: "right",
    logo_url: (s && s.getAttribute("data-logo")) || "https://www.abrobot.ai/web/image/website/1/logo/AbroBot"
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

  var convId = null, open = false, busy = false, built = false;

  function boot() {
    if (built) return; built = true;
    var C = CFG.widget_color || "#f97316";
    var GRAD = "linear-gradient(90deg," + shade(C, -8) + " 0%," + shade(C, 22) + " 50%," + C + " 100%)";
    var SIDE = CFG.widget_position === "left" ? "left" : "right";
    var LOGO = CFG.logo_url;
    var logoImg = function () {
      return LOGO ? '<img alt="chat" src="' + LOGO + '" onerror="this.onerror=null;this.replaceWith(document.createTextNode(\'\\uD83D\\uDCAC\'))"/>' : "💬";
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
      ".abx-user{background:" + GRAD + ";color:#1a1205;font-weight:600;align-self:flex-end;border-bottom-right-radius:5px}",
      ".abx-bot a{color:" + shade(C, 25) + ";font-weight:600}",
      ".abx-dots{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#1a1a1f;border:1px solid #26262d;border-radius:15px}",
      ".abx-dots i{width:7px;height:7px;border-radius:50%;background:" + C + ";animation:abxdot 1.2s infinite}",
      ".abx-dots i:nth-child(2){animation-delay:.15s}.abx-dots i:nth-child(3){animation-delay:.3s}",
      ".abx-foot{display:flex;gap:8px;padding:12px;background:#111114;border-top:1px solid #23232a}",
      ".abx-foot input{flex:1;border:1px solid #2a2a31;border-radius:13px;padding:12px 14px;font-size:14px;outline:none;background:#16161a;color:#f4f4f6}",
      ".abx-foot input::placeholder{color:#6b6b74}",
      ".abx-foot input:focus{border-color:" + C + ";box-shadow:0 0 0 3px " + C + "2e}",
      ".abx-foot button{background:" + GRAD + ";color:#1a1205;border:none;border-radius:13px;padding:0 17px;font-size:17px;font-weight:700;cursor:pointer;transition:transform .15s}",
      ".abx-foot button:active{transform:scale(.93)}",
      ".abx-cred{text-align:center;font-size:10.5px;color:#5f5f68;padding:7px;background:#111114}",
      ".abx-hcta{margin-left:auto;font-size:11px;color:" + shade(C, 25) + ";text-decoration:none;border:1px solid #3a2a17;background:#1a130a;padding:6px 10px;border-radius:9px;white-space:nowrap;font-weight:600}",
      ".abx-hcta:hover{background:#221808;border-color:" + C + "}",
      ".abx-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px;animation:abxin .3s ease both}",
      ".abx-chip{background:#16161a;border:1px solid #2a2a31;color:#e0e0e4;border-radius:999px;padding:8px 13px;font-size:12.5px;cursor:pointer;text-decoration:none;transition:all .18s;font-family:inherit}",
      ".abx-chip:hover{border-color:" + C + ";color:#fff;transform:translateY(-1px)}",
      ".abx-chip.cta{background:" + GRAD + ";color:#1a1205;font-weight:700;border:none}"
    ].join("");
    document.head.appendChild(css);

    var btn = document.createElement("button");
    btn.className = "abx-btn"; btn.setAttribute("aria-label", "Chat with " + CFG.header_title);
    btn.innerHTML = logoImg();
    document.body.appendChild(btn);

    var teaser = document.createElement("div");
    teaser.className = "abx-teaser";
    teaser.innerHTML = '<span class="cl" aria-label="Dismiss">✕</span>' + CFG.teaser;
    document.body.appendChild(teaser);
    teaser.querySelector(".cl").onclick = function (e) { e.stopPropagation(); teaser.classList.remove("on"); };
    teaser.onclick = function () { teaser.classList.remove("on"); if (!open) toggle(); };

    var panel = document.createElement("div");
    panel.className = "abx-panel";
    var titleHtml = CFG.header_title.replace(/(AbroBot|AbroBot AI)/i, '<span class="abx-brand">$1</span>');
    panel.innerHTML =
      '<div class="abx-head"><span class="av">' + logoImg() + '</span>' +
        '<div><div class="ttl">' + titleHtml + '</div>' +
        '<div class="sub"><i></i> ' + CFG.header_subtitle + '</div></div>' +
        '<a class="abx-hcta" href="' + CFG.contact_url + '">📞 Talk to expert</a></div>' +
      '<div class="abx-body" id="abxBody"></div>' +
      '<div class="abx-foot"><input id="abxInput" placeholder="Type your message…" autocomplete="off"/><button id="abxSend" aria-label="Send">➤</button></div>' +
      '<div class="abx-cred">Powered by <span class="abx-brand">' + CFG.header_title + '</span></div>';
    document.body.appendChild(panel);

    var body = panel.querySelector("#abxBody");
    var input = panel.querySelector("#abxInput");
    var send = panel.querySelector("#abxSend");

    setTimeout(function () {
      if (!open && !sessionStorage.getItem("abxTeaser")) { teaser.classList.add("on"); sessionStorage.setItem("abxTeaser", "1"); }
    }, 1000);

    function linkify(t) {
      var esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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
        a.textContent = CFG.cta_text || "📅 Book a free call";
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
        var r = await fetch(API, {
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

  // Built-in per-org presets — used until the live config endpoint is deployed,
  // so each site looks right immediately. Live CRM config always takes precedence.
  var PRESETS = {
    "aa-enterprises": {
      header_title: "AA Enterprises", header_subtitle: "Yarn & textile supplier · online", widget_color: "#1e40af", widget_position: "left",
      greeting: "Hi 👋 Welcome to AA Enterprises — mill-grade cotton & blended yarn and fabric since 1974. Tell me the count, blend and quantity you need and I'll help you get a firm quote.",
      teaser: "Need a yarn quote? 👋 Ask me anything!",
      quick_replies: [
        { label: "🧵 Get a quote", prompt: "I need a quote — here is my yarn spec (count, blend, quantity)" },
        { label: "📋 Yarn varieties", prompt: "What yarn varieties do you supply?" },
        { label: "🏭 Bulk / mill order", prompt: "Can you supply bulk mill-grade yarn?" }
      ],
      cta_text: "💬 Enquire on WhatsApp", booking_url: "https://wa.me/919811028403",
      contact_url: "https://www.aaenterprises.in/contactus", whatsapp: "+91 98110 28403",
      logo_url: "https://www.aaenterprises.in/web/image/website/1/logo/AA%20Enterprises"
    },
    "toppers-hub": {
      header_title: "Toppers Hub Academy", header_subtitle: "Coaching · Faridabad · online", widget_color: "#059669", widget_position: "left",
      greeting: "Hi 👋 Welcome to Toppers Hub Academy! Whether it's Classes 1–12 or CA / CS / CFA / CMA / ACCA, tell me the student's class or course and I'll help you get started — you can book a free demo class too.",
      teaser: "Looking for coaching? 👋 Ask me!",
      quick_replies: [
        { label: "📚 Courses & batches", prompt: "What courses and batches do you offer?" },
        { label: "🎓 CA / CS / CFA", prompt: "Tell me about your professional courses" },
        { label: "🧑‍🏫 Free demo class", prompt: "I want to book a free demo class" }
      ],
      cta_text: "📲 Enroll on WhatsApp", booking_url: "https://wa.me/919891612831",
      contact_url: "https://www.topperhubacademy.com/contactus", whatsapp: "+91 98916 12831",
      logo_url: "https://www.topperhubacademy.com/web/image/website/1/logo/toppershubacademy"
    }
  };
  if (PRESETS[ORG]) { var p = PRESETS[ORG]; for (var pk in p) CFG[pk] = p[pk]; }

  // Load live config from the CRM, then render. Render with fallbacks even if it fails.
  fetch(API + "?org=" + encodeURIComponent(ORG) + "&config=1")
    .then(function (r) { return r.json(); })
    .then(function (c) {
      if (c && c.enabled === false) return; // agent turned off in CRM → don't render
      if (c && typeof c === "object") { for (var k in c) if (c[k] != null) CFG[k] = c[k]; }
      boot();
    })
    .catch(function () { boot(); });
})();
