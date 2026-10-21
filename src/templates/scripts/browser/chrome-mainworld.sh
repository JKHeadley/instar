#!/bin/bash
# chrome-mainworld.sh — run JavaScript in the PAGE's own (main) world of one profile's normal Chrome.
# Usage: chrome-mainworld.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]   (assign the result string to R)
# The code runs synchronously on a loaded page: R must be set before it returns (an awaited promise is not waited for).
# Injects a <script> so the code can read framework state (e.g. React fiber props); the result comes back through a one-time document.body.dataset key.
# A page whose Content-Security-Policy forbids inline scripts makes this report ERR main-world-script-did-not-run.
# macOS only (Apple Events). Installed by instar into .instar/scripts/browser/.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s)" >&2
  exit 2
fi
[ -z "$1" ] || [ -z "$2" ] && { echo "usage: chrome-mainworld.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]" >&2; exit 64; }
S="$(cd "$(dirname "$0")" && pwd)"
MWTAG="mw$(/usr/bin/python3 -I -c 'import secrets; print(secrets.token_hex(8))')" || { echo "ERR wrap-failed" >&2; exit 1; }
WRAPPED="$(MWTAG="$MWTAG" CODE="$2" /usr/bin/python3 -I -c '
import json, os, secrets
c = os.environ["CODE"]
k = "mw" + secrets.token_hex(6)  # a fresh key per call: a stale result from an earlier call can never be read back
m = os.environ["MWTAG"]
# The newline after the caller code keeps a trailing // comment from swallowing the result write.
# A function scope keeps R and any vars declared by the caller off the page globals and out of conflict
# with a page-level let/const of the same name.
body = "(function(){try{var R=\"\";" + c + "\n;document.body.dataset." + k + "=" + json.dumps(m + "ok:") + "+String(R)}catch(e){document.body.dataset." + k + "=" + json.dumps(m + "err:") + "+e}})()"
print("delete document.body.dataset." + k + "; var s=document.createElement(\"script\"); s.textContent=" + json.dumps(body)
      + "; (document.head||document.documentElement).appendChild(s); s.remove(); var v=document.body.dataset." + k
      + "; delete document.body.dataset." + k
      + "; v===undefined ? " + json.dumps(m + "did-not-run") + " : v")
')" || { echo "ERR wrap-failed" >&2; exit 1; }
SHA="$(CODE="$2" /usr/bin/python3 -I -c 'import hashlib, os; print(hashlib.sha256(os.environ["CODE"].encode()).hexdigest())')"
BYTES="$(CODE="$2" /usr/bin/python3 -I -c 'import os; print(len(os.environ["CODE"].encode()))')"
OUT="$(NC_CALLER_SCRIPT=chrome-mainworld.sh NC_CALLER_CODE_SHA256="$SHA" NC_CALLER_CODE_BYTES="$BYTES" "$S/chrome-js.sh" "$1" "$WRAPPED" "$3")"; RC=$?
# The tag sits in the injected script, so page code could observe it; but the result is read in the
# same task the script ran in, so a page that blocked the script cannot report success in its place.
case "$OUT" in
  "${MWTAG}ok:"*) printf '%s\n' "${OUT#"${MWTAG}ok:"}"; exit 0 ;;
  "${MWTAG}err:"*) echo "ERR page-js-error: ${OUT#"${MWTAG}err:"}"; exit 1 ;;
  "${MWTAG}did-not-run") echo "ERR main-world-script-did-not-run (the page blocks inline scripts with a Content-Security-Policy, or the code has a syntax error)"; exit 1 ;;
  *) echo "$OUT"; [ "$RC" -eq 0 ] && exit 1; exit "$RC" ;;
esac
