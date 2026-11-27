#!/bin/bash
# chrome-close.sh — say you are done with one profile's normal Chrome (machine self-maintenance, Part B).
# Usage: chrome-close.sh <profile-id|/absolute/user-data-dir> [--when-free]
# DRY-RUN in this release: it closes nothing. It records that the task is finished (the ledger's
# completion signal, which is what lets the cleanup sweep close the browser once closing is turned
# on), runs the same read-only unsaved-input and download checks a real close would, and prints and
# logs what a close would do. --when-free records the completion signal only, for a browser you
# cannot close yourself. If it reports unsaved input, submit or clear the form first.
# macOS only (Apple Events). Installed by instar into .instar/scripts/browser/.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s). On Linux use xdrive.sh in this same folder." >&2
  exit 2
fi
[ -z "$1" ] && { echo "usage: chrome-close.sh <profile-id|/absolute/user-data-dir> [--when-free]" >&2; exit 64; }
WHENFREE=0; [ "$2" = "--when-free" ] && WHENFREE=1
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
D="$(dirname "$0")"
"$D/chrome-ledger.sh" complete "$P"
LOG="$AGENT_HOME/logs/browser-care.jsonl"
log() { { mkdir -p "$(dirname "$LOG")" && HOMEDIR="$AGENT_HOME" PROFILE="$P" EVENT="$1" REASON="$2" /usr/bin/python3 -I -c '
import json, os, time
print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": os.environ["EVENT"], "dryRun": True,
  "source": "chrome-close.sh", "profile": os.path.relpath(os.environ["PROFILE"], os.environ["HOMEDIR"]),
  "reason": os.environ["REASON"] or None}))' >> "$LOG"; } 2>/dev/null || echo "warning: could not write $LOG" >&2; }
if [ "$WHENFREE" = 1 ]; then
  log completion-recorded ""
  echo "recorded: finished with $1 (the cleanup sweep may close it once closing is turned on)"
  exit 0
fi
PID=$(ps -axo pid=,args= | K="--user-data-dir=$P" awk '/Google Chrome\.app\/Contents\/MacOS\/Google Chrome / && index($0" ", ENVIRON["K"]" ") && !/--type=/ && !/--remote-debugging-|--enable-automation|--test-type/ { print $1; exit }')
[ -z "$PID" ] && { log not-running ""; echo "not running"; exit 0; }
# A download still growing, then every tab: the checks a real close runs first.
DL="$(PROFILE="$P" /usr/bin/python3 -I -c '
import json, os, time
p = os.environ["PROFILE"]
d = os.path.join(os.path.expanduser("~"), "Downloads")
try:
    with open(os.path.join(p, "Default", "Preferences")) as h:
        x = json.load(h).get("download", {}).get("default_directory")
    if isinstance(x, str) and os.path.isabs(x): d = x
except Exception: pass
try:
    names = os.listdir(d)
except FileNotFoundError:
    print("no"); raise SystemExit
except Exception:
    print("unreadable"); raise SystemExit
now = time.time()
for n in names:
    if n.endswith(".crdownload"):
        try:
            if now - os.stat(os.path.join(d, n)).st_mtime < 300: print("yes"); raise SystemExit
        except OSError:
            print("unreadable"); raise SystemExit
print("no")')"
case "$DL" in
  yes) log would-keep download-active; echo "DRY-RUN: would KEEP: a download is still growing (nothing closed)"; exit 0 ;;
  no) ;;
  *) log would-keep download-unreadable; echo "DRY-RUN: would KEEP: the download folder is unreadable (nothing closed)"; exit 0 ;;
esac
TABS="$("$D/chrome-unsaved.sh" "$P")"
printf '%s\n' "$TABS" | grep -q '^tab ' || TABS="none"
case "$TABS" in *done) ;; *) log would-keep unreadable-tabs; echo "DRY-RUN: would KEEP: the tabs could not be read (nothing closed)"; exit 0 ;; esac
if printf '%s\n' "$TABS" | grep -q ' yes$'; then
  log would-keep unsaved-input; echo "DRY-RUN: would KEEP: a tab holds unsaved input; submit or clear it first (nothing closed)"; exit 0
fi
if printf '%s\n' "$TABS" | grep -q ' unreadable$'; then
  log would-keep unreadable-tabs; echo "DRY-RUN: would KEEP: a tab could not be read (nothing closed)"; exit 0
fi
log would-close ""
echo "DRY-RUN: would close $1 (pid $PID); nothing closed in this release. Completion recorded."
exit 0
