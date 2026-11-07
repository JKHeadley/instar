#!/bin/bash
# chrome-mainworld.sh — run JavaScript in the PAGE's own (main) world of one profile's normal Chrome.
# Usage: chrome-mainworld.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]   (assign the result string to R)
# The code runs synchronously on a loaded page: R must be set before it returns (an awaited promise is not waited for).
# Injects a <script> so the code can read framework state (e.g. React fiber props); the result comes back through a one-time document.body.dataset key.
# A page whose Content-Security-Policy forbids inline scripts makes this report ERR main-world-script-did-not-run.
# macOS only (Apple Events). Installed by instar into .instar/scripts/browser/.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s). On Linux use xdrive.sh in this same folder." >&2
  exit 2
fi
[ -z "$1" ] || [ -z "$2" ] && { echo "usage: chrome-mainworld.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]" >&2; exit 64; }
S="$(cd "$(dirname "$0")" && pwd)"
MWTAG="mw$(/usr/bin/python3 -I -c 'import secrets; print(secrets.token_hex(8))')" || { echo "ERR wrap-failed" >&2; exit 1; }
WRAPPED="$(MWTAG="$MWTAG" node "$S/lockout-guard.cjs" mainworld "$(cd "$S/../../.." && pwd -P)" chrome-mainworld.sh "$1" "$2" "$3")" || { echo "ERR wrap-failed" >&2; exit 1; }

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
