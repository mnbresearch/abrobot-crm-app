#!/usr/bin/env bash
#
# Paste the CRM website capture key into product.html.
#
#   bash scripts/set-capture-key.sh
#
# It prompts for the key rather than taking it on the command line, so the key
# does not end up in your shell history. Then it validates the key, edits the
# one line, and shows you the result.
#
# ── What this key is ────────────────────────────────────────────────────────
# It is a CAPTURE-ONLY credential for one organisation. Anything holding it can
# create a record in MNB Research and can read nothing at all — not a record,
# not a setting, not another tenant. That is why it is safe in page source,
# which is where it has to live for a static HTML form to work. It is the same
# posture as a Google Analytics ID, not an API key.
#
# If it is ever abused, revoke it in the CRM under Integrations → Capture URLs
# and run this again with the new one. Revoking it does not affect the
# consulting capture key, which is a separate row — that separation is why
# 20260908120000 created a second key rather than reusing the existing one.

set -euo pipefail

cd "$(dirname "$0")/.."
FILE="product.html"
PLACEHOLDER="PASTE_CRM_WEBSITE_CAPTURE_KEY_HERE"

if [ ! -f "$FILE" ]; then
  echo "✗ Can't find $FILE. Run this from the repo, or via: bash scripts/set-capture-key.sh"
  exit 1
fi

CURRENT=$(grep -o 'var CAPTURE_KEY = "[^"]*"' "$FILE" | head -1 | sed 's/.*"\(.*\)"/\1/' || true)

if [ -z "$CURRENT" ]; then
  echo "✗ No CAPTURE_KEY line found in $FILE. Has it been edited by hand?"
  exit 1
fi

echo
if [ "$CURRENT" = "$PLACEHOLDER" ]; then
  echo "Current state: NOT SET (the form refuses to send and shows the WhatsApp fallback)"
else
  echo "Current state: already set to ${CURRENT:0:14}…  — running this will replace it"
fi

cat <<'EOS'

Where to find the key:

  It was printed by the last query in
  supabase/migrations/20260908120000_nurture_segments.sql

  Lost it? Run this in the Supabase SQL editor:

    select wk.key
      from public.webhook_keys wk
      join public.organizations o on o.id = wk.org_id
     where o.slug = 'mnb-research' and wk.segment = 'crm-website' and wk.active;

EOS

printf 'Paste the capture key (it starts with crmweb_): '
# -r so a backslash is not treated as an escape. Echoed on purpose: this is not
# a password, and a silent prompt for a value you are pasting invites mistakes
# you cannot see.
read -r KEY
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"

if [ -z "$KEY" ]; then
  echo "✗ Nothing entered. Nothing changed."
  exit 1
fi

# Validate before writing. A wrong key here fails silently at runtime — the
# endpoint returns 401 and the visitor sees "something went wrong at our end" —
# so catching a typo now is worth the three lines.
if ! printf '%s' "$KEY" | grep -Eq '^crmweb_[0-9a-f]{32}$'; then
  echo
  echo "✗ That does not look like a capture key."
  echo "  Expected: crmweb_ followed by 32 hex characters."
  echo "  Got:      $KEY"
  echo
  echo "  If you copied a whole row from the SQL editor, take just the key column."
  echo "  Nothing has been changed."
  exit 1
fi

python3 - "$FILE" "$KEY" <<'PY'
import io, re, sys
path, key = sys.argv[1], sys.argv[2]
s = io.open(path, encoding='utf-8').read()
new, n = re.subn(r'(var CAPTURE_KEY = ")[^"]*(")', lambda m: m.group(1) + key + m.group(2), s, count=1)
if n != 1:
    sys.exit("could not rewrite the CAPTURE_KEY line")
io.open(path, 'w', encoding='utf-8').write(new)
PY

echo
echo "✓ Set in $FILE:"
grep -n 'var CAPTURE_KEY' "$FILE" | sed 's/\(crmweb_.\{8\}\).*"/\1…"/'
echo
cat <<'EOS'
Next:

  1. Deploy — the edit is only on your machine until the site rebuilds:

       bash scripts/deploy-all.sh

  2. Commit:

       git add -A && git commit -m "Set the CRM website capture key" && git push

  3. Test it yourself. Open crm.mnbresearch.com/product, click a plan, fill the
     form with your own details and send. Then check:
       · the record is in the CRM under MNB Research
       · Product / Service shows the plan you clicked
       · your phone got the Telegram alert

     If the form says "This form isn't connected yet", the deploy has not landed
     — the browser is still running the old page. Hard-refresh and try again.
EOS
