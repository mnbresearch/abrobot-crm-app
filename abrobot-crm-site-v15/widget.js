/* AbroBot CRM widget - v15 path, now a loader for the current widget.

This file was a stale August build left in the Cloudflare Pages publish root.
It served three defects to anyone who fetched the URL:
  1. PRESETS held two real customers' mobile numbers, logos and contact pages.
  2. It defaulted to the "abrobot" tenant when a page had no data-org, so any
     GTM or Shopify install filed that site's visitors into the wrong CRM.
  3. It wrote agent_config text into innerHTML unescaped - stored XSS on the
     customer's own origin.

Deleting it would break any site still pointing here, so it now just loads the
current, fixed widget and forwards the data-org attribute. */
(function(){var me=document.currentScript;var org=me&&me.getAttribute("data-org");var s=document.createElement("script");s.src="/widget.js";if(org)s.setAttribute("data-org",org);document.head.appendChild(s);})();
