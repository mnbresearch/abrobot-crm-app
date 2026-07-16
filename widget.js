/* ============================================================
   AbroBot AI chat widget — free Chatbase replacement.
   Embed on abrobot.ai (before </body>):
     <script src="https://abrobot-crm.pages.dev/widget.js" data-org="abrobot"></script>
   Professional dark theme · glowing orange AbroBot wordmark · logo bubble · greeting nudge.
   ============================================================ */
(function () {
  var s = document.currentScript;
  var ORG = (s && s.getAttribute("data-org")) || "abrobot";
  var API = "https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/chat-agent";
  var LOGO = (s && s.getAttribute("data-logo")) || "https://www.abrobot.ai/web/image/website/1/logo/AbroBot";
  var CONTACT = (s && s.getAttribute("data-contact")) || "https://www.abrobot.ai/contactus";
  var BOOKING = (s && s.getAttribute("data-booking")) || "https://calendly.com/mridulnanda2004/abrobot-meet";
  var ORANGE = "linear-gradient(90deg,#f59e0b 0%,#fb923c 50%,#f97316 100%)";
  var WELCOME = "Hi there! 👋 I'm the AbroBot AI assistant. Ask me anything about universities, scholarships, visas or SOPs — or tell me your goal and I'll guide you personally.";
  var TEASER = "Hi there 👋 I'm AbroBot AI — ask me anything!";
  var convId = null, open = false, busy = false, teaserShown = false;

  var css = document.createElement("style");
  css.textContent = [
    "@keyframes abxglow{0%,100%{box-shadow:0 10px 30px rgba(249,115,22,.35),0 0 0 1px rgba(249,115,22,.25)}50%{box-shadow:0 12px 42px rgba(249,115,22,.6),0 0 0 1px rgba(249,115,22,.45)}}",
    "@keyframes abxpop{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}",
    "@keyframes abxin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
    "@keyframes abxdot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}",
    "@keyframes abxshine{0%{background-position:0% 50%}100%{background-position:200% 50%}}",
    ".abx-brand{background:" + ORANGE + ";background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:800;animation:abxshine 4s linear infinite;text-shadow:0 0 18px rgba(249,115,22,.35);filter:drop-shadow(0 1px 6px rgba(249,115,22,.4))}",
    ".abx-btn{position:fixed;bottom:22px;right:22px;width:64px;height:64px;border-radius:50%;background:#0b0b0e;border:none;cursor:pointer;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:0;overflow:hidden;animation:abxglow 3.2s ease-in-out infinite;transition:transform .2s}",
    ".abx-btn:hover{transform:scale(1.07)}",
    ".abx-btn img{width:70%;height:70%;object-fit:contain}",
    ".abx-btn .abx-x{color:#fff;font-size:24px;font-weight:300}",
    ".abx-teaser{position:fixed;bottom:96px;right:24px;max-width:250px;background:#111114;color:#f4f4f6;border:1px solid #2a2a31;border-radius:16px;border-bottom-right-radius:4px;padding:12px 34px 12px 14px;font:14px/1.5 'Segoe UI',system-ui,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,.5);z-index:2147482999;cursor:pointer;display:none;animation:abxpop .35s cubic-bezier(.22,1,.36,1)}",
    ".abx-teaser.on{display:block}",
    ".abx-teaser b{color:#fb923c}",
    ".abx-teaser .cl{position:absolute;top:6px;right:8px;color:#7a7a85;font-size:15px;cursor:pointer;line-height:1}",
    ".abx-teaser .cl:hover{color:#fff}",
    ".abx-panel{position:fixed;bottom:100px;right:22px;width:380px;max-width:calc(100vw - 32px);height:566px;max-height:calc(100vh - 140px);background:#0d0d10;border:1px solid #23232a;border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.6);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}",
    ".abx-panel.on{display:flex;animation:abxpop .3s cubic-bezier(.22,1,.36,1)}",
    ".abx-head{display:flex;align-items:center;gap:11px;background:linear-gradient(180deg,#161619,#0d0d10);padding:15px 16px;border-bottom:1px solid #23232a;position:relative}",
    ".abx-head::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:" + ORANGE + "}",
    ".abx-head .av{width:38px;height:38px;border-radius:11px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 0 1px #2a2a31}",
    ".abx-head .av img{width:78%;height:78%;object-fit:contain}",
    ".abx-head .ttl{font-size:16.5px;font-weight:700;color:#fff;letter-spacing:.2px}",
    ".abx-head .sub{font-size:11.5px;color:#8a8a94;display:flex;align-items:center;gap:5px;margin-top:1px}",
    ".abx-head .sub i{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;font-style:normal}",
    ".abx-body{flex:1;overflow-y:auto;padding:16px;background:#0d0d10;display:flex;flex-direction:column;gap:10px}",
    ".abx-msg{max-width:85%;padding:11px 14px;border-radius:15px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;animation:abxin .25s ease both}",
    ".abx-bot{background:#1a1a1f;border:1px solid #26262d;color:#e8e8ea;align-self:flex-start;border-bottom-left-radius:5px}",
    ".abx-user{background:" + ORANGE + ";color:#1a1205;font-weight:600;align-self:flex-end;border-bottom-right-radius:5px}",
    ".abx-bot a{color:#fb923c;font-weight:600}",
    ".abx-dots{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:#1a1a1f;border:1px solid #26262d;border-radius:15px}",
    ".abx-dots i{width:7px;height:7px;border-radius:50%;background:#f97316;animation:abxdot 1.2s infinite}",
    ".abx-dots i:nth-child(2){animation-delay:.15s}.abx-dots i:nth-child(3){animation-delay:.3s}",
    ".abx-foot{display:flex;gap:8px;padding:12px;background:#111114;border-top:1px solid #23232a}",
    ".abx-foot input{flex:1;border:1px solid #2a2a31;border-radius:13px;padding:12px 14px;font-size:14px;outline:none;background:#16161a;color:#f4f4f6}",
    ".abx-foot input::placeholder{color:#6b6b74}",
    ".abx-foot input:focus{border-color:#f97316;box-shadow:0 0 0 3px rgba(249,115,22,.18)}",
    ".abx-foot button{background:" + ORANGE + ";color:#1a1205;border:none;border-radius:13px;padding:0 17px;font-size:17px;font-weight:700;cursor:pointer;transition:transform .15s}",
    ".abx-foot button:active{transform:scale(.93)}",
    ".abx-cred{text-align:center;font-size:10.5px;color:#5f5f68;padding:7px;background:#111114}",
    ".abx-hcta{margin-left:auto;font-size:11px;color:#fb923c;text-decoration:none;border:1px solid #3a2a17;background:#1a130a;padding:6px 10px;border-radius:9px;white-space:nowrap;font-weight:600}",
    ".abx-hcta:hover{background:#221808;border-color:#f97316}",
    ".abx-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px;animation:abxin .3s ease both}",
    ".abx-chip{background:#16161a;border:1px solid #2a2a31;color:#e0e0e4;border-radius:999px;padding:8px 13px;font-size:12.5px;cursor:pointer;text-decoration:none;transition:all .18s;font-family:inherit}",
    ".abx-chip:hover{border-color:#f97316;color:#fff;transform:translateY(-1px)}",
    ".abx-chip.cta{background:" + ORANGE + ";color:#1a1205;font-weight:700;border:none}"
  ].join("");
  document.head.appendChild(css);

  function logoImg(cls) {
    return '<img alt="AbroBot" src="' + LOGO + '" onerror="this.onerror=null;this.replaceWith(document.createTextNode(\'✨\'))"/>';
  }

  // launcher button (logo bubble)
  var btn = document.createElement("button");
  btn.className = "abx-btn"; btn.setAttribute("aria-label", "Chat with AbroBot AI");
  btn.innerHTML = logoImg();
  document.body.appendChild(btn);

  // greeting teaser
  var teaser = document.createElement("div");
  teaser.className = "abx-teaser";
  teaser.innerHTML = '<span class="cl" aria-label="Dismiss">✕</span>' + TEASER;
  document.body.appendChild(teaser);
  teaser.querySelector(".cl").onclick = function (e) { e.stopPropagation(); teaser.classList.remove("on"); };
  teaser.onclick = function () { teaser.classList.remove("on"); if (!open) toggle(); };

  // panel
  var panel = document.createElement("div");
  panel.className = "abx-panel";
  panel.innerHTML =
    '<div class="abx-head"><span class="av">' + logoImg() + '</span>' +
      '<div><div class="ttl"><span class="abx-brand">AbroBot</span> AI</div>' +
      '<div class="sub"><i></i> Study-abroad assistant · online</div></div>' +
      '<a class="abx-hcta" href="' + CONTACT + '">📞 Talk to expert</a></div>' +
    '<div class="abx-body" id="abxBody"></div>' +
    '<div class="abx-foot"><input id="abxInput" placeholder="Ask about universities, visas, scholarships…" autocomplete="off"/><button id="abxSend" aria-label="Send">➤</button></div>' +
    '<div class="abx-cred">Powered by <span class="abx-brand">AbroBot</span> AI</div>';
  document.body.appendChild(panel);

  var body = panel.querySelector("#abxBody");
  var input = panel.querySelector("#abxInput");
  var send = panel.querySelector("#abxSend");

  // show teaser after 1s (once per session)
  setTimeout(function () {
    if (!open && !sessionStorage.getItem("abxTeaser")) {
      teaser.classList.add("on"); teaserShown = true;
      sessionStorage.setItem("abxTeaser", "1");
    }
  }, 1000);

  function linkify(t) {
    var esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
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
    [["🎓 Universities", "Which universities suit my profile?"],
     ["💰 Scholarships", "What scholarships can I get for studying abroad?"],
     ["🛂 Visa help", "Can you help me with my student visa?"]].forEach(function (it) {
      var b = document.createElement("button");
      b.className = "abx-chip"; b.textContent = it[0];
      b.onclick = function () { input.value = it[1]; ask(); };
      wrap.appendChild(b);
    });
    var a = document.createElement("a");
    a.className = "abx-chip cta"; a.href = BOOKING;
    a.textContent = "📅 Book a free call";
    wrap.appendChild(a);
    body.appendChild(wrap); body.scrollTop = body.scrollHeight;
  }
  function toggle() {
    open = !open; panel.classList.toggle("on", open);
    teaser.classList.remove("on");
    btn.innerHTML = open ? '<span class="abx-x">✕</span>' : logoImg();
    if (open && !body.hasChildNodes()) { add("bot", WELCOME); addChips(); input.focus(); }
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
        body: JSON.stringify({ org: ORG, conversation_id: convId, page_url: location.href, message: text }),
      });
      var data = await r.json();
      dots.remove();
      if (data.conversation_id) convId = data.conversation_id;
      add("bot", data.reply || "Sorry, please try again or WhatsApp +91 97114 88480.");
    } catch (e) {
      dots.remove();
      add("bot", "Connection issue — please WhatsApp us at +91 97114 88480 and we'll help right away.");
    }
    busy = false; input.focus();
  }
  send.onclick = ask;
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });
})();
