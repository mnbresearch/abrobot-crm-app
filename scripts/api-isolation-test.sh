#!/usr/bin/env bash
# AbroBot CRM — do two customers' API keys actually stay apart?
#
# WHERE TO RUN THIS: the Terminal app on your Mac. One line:
#
#   cd ~/Projects/mnb-recovery/repos/abrobot-crm-app && bash scripts/api-isolation-test.sh
#
# It asks for two API keys and types nothing to the screen while you paste them.
# The keys are never written to a file, never put in your shell history, and
# never appear in the output — so the result is safe to share.
#
# WHY THIS IS A SEPARATE TEST from the database one:
# the /api edge function runs on the service role, which bypasses row-level
# security entirely. Its isolation comes from resolving the organisation from
# the key's hash instead of from anything the caller sends. That is a different
# mechanism from RLS, so passing the database test says nothing about it.

set -uo pipefail

API="https://pomsltnrxvbcafwtbtlc.supabase.co/functions/v1/api/v1"

bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); red=$(printf '\033[31m')
grn=$(printf '\033[32m'); ylw=$(printf '\033[33m'); off=$(printf '\033[0m')

pass=0; fail=0
ok()   { echo "  ${grn}PASS${off}  $1"; pass=$((pass+1)); }
bad()  { echo "  ${red}FAIL${off}  $1"; fail=$((fail+1)); }
note() { echo "  ${ylw}NOTE${off}  $1"; }

echo
echo "${bold}API key isolation test${off}"
echo "${dim}You need one API key from each of two different organisations."
echo "Get each one from:  CRM -> Settings -> Integrations -> API keys -> create."
echo "A key is shown once. If you don't have two organisations yet, stop here —"
echo "this test has nothing to compare and cannot tell you anything.${off}"
echo

# -s = do not echo what is typed. Nothing reaches the screen or the history file.
read -rsp "Paste the key for organisation A, then press Return: " KEY_A; echo
read -rsp "Paste the key for organisation B, then press Return: " KEY_B; echo
echo

if [ -z "${KEY_A:-}" ] || [ -z "${KEY_B:-}" ]; then
  echo "${red}Both keys are required.${off}"; exit 1
fi
if [ "$KEY_A" = "$KEY_B" ]; then
  echo "${red}Those are the same key. The test needs two different organisations.${off}"; exit 1
fi

# req <key> <path> — sets $HTTP and $BODY.
#
# Deliberately NOT `BODY=$(req ...)`: a command substitution runs the function
# in a subshell, so an assignment to $HTTP inside it is discarded the moment
# the subshell exits. The first version of this script did exactly that and
# died on the first status check.
HTTP=""; BODY=""
req() {
  local out
  out=$(curl -sS --max-time 20 -w $'\n%{http_code}' -H "Authorization: Bearer $1" "$API$2" 2>/dev/null)
  if [ -z "$out" ]; then HTTP="000"; BODY=""; return; fi
  HTTP=$(printf '%s' "$out" | tail -n1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# ── 1. Each key identifies its own organisation ─────────────────────────────
echo "${bold}1. Who does each key say it is?${off}"
req "$KEY_A" "/me"; HA=$HTTP; ME_A=$BODY
req "$KEY_B" "/me"; HB=$HTTP; ME_B=$BODY

slug() { printf '%s' "$1" | sed -n 's/.*"slug"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'; }
SA=$(slug "$ME_A"); SB=$(slug "$ME_B")

if [ "$HA" = "000" ]; then bad "could not reach the API at all. Are you online?"
elif [ "$HA" != "200" ]; then bad "key A was rejected (HTTP $HA). Is it revoked, or mistyped?"
elif [ -z "$SA" ];      then bad "key A returned 200 but no organisation slug: $ME_A"
else                         ok  "key A is organisation '${SA}'"; fi

if [ "$HB" != "200" ]; then bad "key B was rejected (HTTP $HB)."
elif [ -z "$SB" ];      then bad "key B returned 200 but no organisation slug: $ME_B"
else                         ok  "key B is organisation '${SB}'"; fi

if [ -n "$SA" ] && [ "$SA" = "$SB" ]; then
  echo
  echo "${red}Both keys resolve to the same organisation ('${SA}').${off}"
  echo "That is not a leak — it means you created both keys in one organisation."
  echo "Make a key in a second organisation and run this again."
  exit 1
fi

# ── 2. A record belonging to A must be invisible to B ───────────────────────
echo
echo "${bold}2. Can B fetch a record belonging to A?${off}"
req "$KEY_A" "/leads?limit=1"
ID_A=$(printf '%s' "$BODY" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([0-9a-f-]\{36\}\)".*/\1/p' | head -n1)

if [ -z "$ID_A" ]; then
  note "organisation '${SA}' has no records, so there is nothing for B to reach for."
  note "Add one record to '${SA}' and run this again — without it this check proves nothing."
else
  req "$KEY_B" "/leads/$ID_A"; CODE=$HTTP
  case "$CODE" in
    404) ok  "B got 404 — correct. 403 would still confirm the record exists." ;;
    403) bad "B got 403. The record is protected but its EXISTENCE is disclosed." ;;
    200) bad "B READ ORGANISATION A'S RECORD. This is a tenant data leak — stop and tell me." ;;
    *)   bad "unexpected HTTP $CODE" ;;
  esac
fi

# ── 3. The two lists must not overlap ───────────────────────────────────────
echo
echo "${bold}3. Do the two record lists overlap at all?${off}"
ids() {
  req "$1" "/leads?limit=200"
  printf '%s' "$BODY" | tr ',' '\n' \
    | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([0-9a-f-]\{36\}\)".*/\1/p' | sort -u
}
A_IDS=$(ids "$KEY_A"); B_IDS=$(ids "$KEY_B")
NA=$(printf '%s' "$A_IDS" | grep -c . || true)
NB=$(printf '%s' "$B_IDS" | grep -c . || true)
SHARED=$(comm -12 <(printf '%s\n' "$A_IDS") <(printf '%s\n' "$B_IDS") | grep -c . || true)

echo "  ${dim}A returned ${NA} record id(s); B returned ${NB}.${off}"
if [ "$NA" -eq 0 ] && [ "$NB" -eq 0 ]; then
  note "both organisations are empty — an overlap of zero here is trivially true."
elif [ "$SHARED" -eq 0 ]; then
  ok "no record appears in both lists."
else
  bad "${SHARED} record id(s) appear in BOTH organisations' lists. Tenant data leak."
fi

# ── 4. A revoked-looking key must not be treated as anonymous access ────────
echo
echo "${bold}4. Does a bad key fail closed?${off}"
req "abk_live_0000000000000000000000000000000000000000000000000000000000000000" "/leads"
case "$HTTP" in
  401) ok  "an invalid key gets 401." ;;
  200) bad "AN INVALID KEY RETURNED DATA. The key check is not authenticating." ;;
  *)   note "invalid key got HTTP $HTTP (401 expected, but it did not return data)." ;;
esac

echo
echo "${bold}${pass} passed, ${fail} failed.${off}"
[ "$fail" -eq 0 ] || echo "${red}Send me the output above — do not paste the keys.${off}"
echo
exit 0
