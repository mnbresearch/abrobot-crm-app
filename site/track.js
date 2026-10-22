/*
 * AbroBot CRM — first-party page-view beacon for the static marketing pages
 * (pricing, product, contact). The React app uses app/src/lib/analytics.ts.
 *
 *   <script src="/track.js" data-event="pricing_view" defer></script>
 *
 * Same rules as the app: nothing is sent under Do Not Track or Global Privacy
 * Control; no cookie; a random per-tab id in sessionStorage; path only (no
 * query string); referrer host and UTM tags as attribution. The server
 * (track_event) allow-lists events and property keys and rate-limits callers.
 * The publishable key below is the same public key the app ships — it grants
 * nothing that row-level security does not already allow anonymous visitors.
 */
(function () {
  try {
    var s = document.currentScript;
    var ev = s && s.getAttribute("data-event");
    if (!ev) return;
    var n = navigator;
    if (n.globalPrivacyControl === true || n.doNotTrack === "1" || window.doNotTrack === "1") return;

    var sid = null;
    try {
      sid = sessionStorage.getItem("ab_sid");
      if (!sid) {
        var a = new Uint8Array(12);
        crypto.getRandomValues(a);
        sid = Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
        sessionStorage.setItem("ab_sid", sid);
      }
    } catch (e) { sid = null; }

    var props = {};
    try {
      if (document.referrer) {
        var h = new URL(document.referrer).host;
        if (h && h !== location.host) props.referrer_host = h;
      }
      var q = new URLSearchParams(location.search);
      ["utm_source", "utm_medium", "utm_campaign"].forEach(function (k) {
        var v = q.get(k); if (v) props[k] = v.slice(0, 80);
      });
    } catch (e) { /* ignore */ }

    var KEY = "sb_publishable__p-fQqmGXL0dPB5InuCznQ_U0NxtXIc";
    fetch("https://pomsltnrxvbcafwtbtlc.supabase.co/rest/v1/rpc/track_event", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY },
      body: JSON.stringify({ p_event: ev, p_session: sid, p_path: location.pathname, p_props: props }),
    }).catch(function () {});
  } catch (e) { /* never break the page */ }
})();
