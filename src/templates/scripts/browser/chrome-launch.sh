#!/bin/bash
# chrome-launch.sh — open a NORMAL (non-automated) Chrome for one browser profile.
# Usage: chrome-launch.sh [--new] <profile-id|/absolute/user-data-dir> [url]
# A profile folder that does not exist is refused (it would open a signed-out browser that
# looks like a lost login); pass --new to create one on purpose.
# Launches through LaunchServices (`open -na`), never a remote-debugging port, after
# switching on "Allow JavaScript from Apple Events" in that profile's Preferences.
# Does nothing if that profile is already open. macOS only (Apple Events).
# Installed by instar into .instar/scripts/browser/ — overwritten on every update.
# See the /normal-chrome-browser skill for the method and its safety rules.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s)" >&2
  exit 2
fi
NEWOK=0; [ "$1" = "--new" ] && { NEWOK=1; shift; }
[ -z "$1" ] && { echo "usage: chrome-launch.sh [--new] <profile-id|/absolute/user-data-dir> [url]" >&2; exit 64; }
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
if ps -axo args= | K="--user-data-dir=$P" awk '{ if (index($0" ", ENVIRON["K"]" ")) f=1 } END { exit !f }'; then
  if [ -n "$2" ]; then echo "already running (url not opened: navigate the existing tab with chrome-js.sh 'location.href=...')"; else echo "already running"; fi
  exit 0
fi
if [ ! -d "$P" ] && [ "$NEWOK" != 1 ]; then
  echo "ERR no-such-profile: $P does not exist. Check GET /playwright-profiles (or ls .instar/state/playwright-profiles); pass --new to create a new, signed-out profile on purpose." >&2
  exit 1
fi
NEW=0; [ -f "$P/Default/Preferences" ] || NEW=1
mkdir -p "$P/Default"
/usr/bin/python3 -I -c '
import json, os, sys
f = sys.argv[1]
d = {}
if os.path.exists(f):
    with open(f) as h:
        d = json.load(h)
d.setdefault("browser", {})["allow_javascript_apple_events"] = True
t = f + ".instar-tmp"
with open(t, "w") as h:
    json.dump(d, h)
os.replace(t, f)  # atomic: Chrome never sees a half-written Preferences file
' "$P/Default/Preferences" || { echo "ERR preferences-unreadable-or-unwritable (corrupt JSON or no permission): $P/Default/Preferences" >&2; exit 1; }
open -na "Google Chrome" --args --user-data-dir="$P" "${2:-about:blank}" || { echo "ERR launch-failed (is Google Chrome installed?)" >&2; exit 1; }
[ "$NEW" = 1 ] && echo "note: new profile; Chrome ignores the Apple Events setting on its first run. Quit this Chrome once and run chrome-launch.sh again before chrome-js.sh." >&2
exit 0
