#!/bin/bash
# chrome-renew.sh — renew the lease on one profile's browser for work the other helpers never see
# (a long download, a page working by itself). Usage: chrome-renew.sh <profile-id|/absolute/user-data-dir>
# chrome-js.sh and chrome-mainworld.sh renew it on every call already. macOS only.
# Installed by instar into .instar/scripts/browser/ — overwritten on every update.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s). On Linux use xdrive.sh in this same folder." >&2
  exit 2
fi
[ -z "$1" ] && { echo "usage: chrome-renew.sh <profile-id|/absolute/user-data-dir>" >&2; exit 64; }
# Resolve the profile to a canonical user-data-dir STRICTLY INSIDE this agent's home (the same
# jail the Playwright profile registry applies). This guards against mistakes, not against a
# hostile caller with a shell: it keeps an ordinary call from reaching the operator's own Chrome. realpath resolves `..` and symlinks before the check, and the canonical
# path is what every later step uses (mkdir, Preferences, open, the process match).
AGENT_HOME="$(cd "$(dirname "$0")/../../.." && pwd -P)"
case "$AGENT_HOME" in *[[:space:]]*) echo "ERR agent-home-has-spaces: $AGENT_HOME (the exact process match needs a path without spaces; these tools cannot be used from this agent home)" >&2; exit 64 ;; esac
case "$1" in
  /*) RAW="$1" ;;
  */*|.*) echo "ERR bad-profile-id: use a profile id from GET /playwright-profiles or an absolute directory inside this agent's home" >&2; exit 64 ;;
  *) printf '%s' "$1" | grep -Eq '^[a-z0-9-]{1,64}$' || { echo "ERR bad-profile-id: ids are lowercase letters, digits and dashes (the profile registry's rule)" >&2; exit 64; }
     RAW="$AGENT_HOME/.instar/state/playwright-profiles/$1" ;;
esac
case "$RAW" in *[[:space:]]*) echo "ERR bad-profile-path: no spaces or tabs in a profile path (the process match could pick another profile)" >&2; exit 64 ;; esac
P="$(/usr/bin/python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$RAW")" || { echo "ERR profile-resolve-failed: $RAW" >&2; exit 64; }
case "$P" in
  "$AGENT_HOME"/?*) ;;
  *) echo "ERR profile-outside-agent-home: $RAW (browser profiles must live under $AGENT_HOME)" >&2; exit 64 ;;
esac
# Inside the home, the agent's own folders are off limits except the profiles folder, and the
# operator's own Chrome folder is always refused (in case an agent home were ever ~).
case "$P/" in
  "$HOME/Library/Application Support/Google/Chrome/"*) echo "ERR profile-reserved-folder: $P is the operator's own Chrome" >&2; exit 64 ;;
  "$AGENT_HOME/.instar/state/playwright-profiles/"?*) ;;
  "$AGENT_HOME/.instar/"*|"$AGENT_HOME/.claude/"*) echo "ERR profile-reserved-folder: $P is an agent config folder, not a browser profile" >&2; exit 64 ;;
esac
case "$P" in *[[:space:]]*) echo "ERR bad-profile-path: $P resolves to a path with spaces or tabs" >&2; exit 64 ;; esac
"$(dirname "$0")/chrome-ledger.sh" renew "$P"
echo "renewed"
