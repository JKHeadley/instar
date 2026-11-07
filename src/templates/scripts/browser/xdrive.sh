#!/bin/bash
# xdrive.sh: run x-drive.py, the Linux normal-Chrome driver (ACT-138).
# Usage: XD_PROFILE=<id> xdrive.sh <cmd> [args]   (launch takes the profile id as its own argument)
#   Text and passwords arrive on stdin, never on argv.
# Installed by instar into .instar/scripts/browser/, overwritten on every update.
# See the /normal-chrome-browser skill for the method and its safety rules.
#
# This wrapper is the Instar entry point on Linux. It owns the platform check, a clean environment,
# one call at a time per agent, the command deadline, the unknown-outcome latch and the content-free
# activity line. It never installs anything and never calls sudo. It is a guard against mistakes, like
# the other platforms' wrappers: it does not stop a caller who edits it or runs the driver directly.
# Spec: docs/specs/normal-chrome-linux.md.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOME="$(cd "$HERE/../../.." && pwd -P)"
CMD="${1:-}"
STATE="$AGENT_HOME/.instar/state/xdrive"
LOG="$AGENT_HOME/.instar/logs/normal-chrome-browser.jsonl"
DISPLAY_NO="none"

log_line() {
  # One line per call, refusals included: when, command, exit code. Never arguments or page content.
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  (
    flock -w 2 8 2>/dev/null
    if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then mv -f "$LOG" "$LOG.1"; fi
    printf '{"at":"%s","via":"xdrive","cmd":"%s","exit":%s,"display":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$1" "$DISPLAY_NO" >>"$LOG"
  ) 8>>"$LOG.lock" 2>/dev/null
}

known_cmd() {
  case "$1" in launch|url|title|text|find|click|type|typesecret|key|nav|close|deps) printf '%s' "$1" ;; *) printf 'unknown' ;; esac
}

refuse() { # refuse <exit> <message>
  printf '%s\n' "$2"
  log_line "$1" "$(known_cmd "$CMD")"
  exit "$1"
}

[ "$(uname -s)" = "Linux" ] || refuse 2 "ERR use-ndrive: xdrive.sh is the Linux driver. On macOS use chrome-launch.sh and chrome-js.sh; on Windows use ndrive.sh from WSL."
command -v powershell.exe >/dev/null 2>&1 && refuse 2 "ERR use-ndrive: this is WSL with Windows underneath; use ndrive.sh"
[ -n "$CMD" ] || refuse 64 "ERR bad-argument: xdrive.sh <launch|url|title|text|find|click|type|typesecret|key|nav|close|deps> [args]"
[ "$(known_cmd "$CMD")" != "unknown" ] || refuse 64 "ERR bad-argument: unknown command"
# A value piped in by the Secret Drop helper's --run mode goes nowhere here; only its --browser mode reaches typesecret.
if [ -n "${XD_SECRET_RUN:-}" ]; then refuse 2 "ERR use-secret-drop-browser: use secret-drop-retrieve.mjs <token> <field> --browser"; fi
if [ "$CMD" = "typesecret" ] && [ -z "${XD_SECRET_BROWSER:-}" ]; then refuse 2 "ERR use-secret-drop-browser: use secret-drop-retrieve.mjs <token> <field> --browser"; fi
if [ "$CMD" = "type" ] && [ $# -gt 1 ]; then refuse 64 "ERR bad-argument: type reads its text from stdin, never from an argument"; fi

INSTALL_LINE='sudo apt-get install -y python3-gi gir1.2-atspi-2.0 libxtst6 tigervnc-standalone-server at-spi2-core dbus'
check_deps() {
  local missing=""
  [ -x /usr/bin/python3 ] || missing="$missing python3"
  /usr/bin/python3 -I -c 'import gi; gi.require_version("Atspi","2.0"); from gi.repository import Atspi' >/dev/null 2>&1 || missing="$missing python3-gi,gir1.2-atspi-2.0"
  /usr/bin/python3 -I -c 'import ctypes; ctypes.CDLL("libXtst.so.6"); ctypes.CDLL("libX11.so.6")' >/dev/null 2>&1 || missing="$missing libxtst6"
  command -v Xvnc >/dev/null 2>&1 || command -v Xtigervnc >/dev/null 2>&1 || missing="$missing tigervnc-standalone-server"
  command -v dbus-daemon >/dev/null 2>&1 || missing="$missing dbus"
  [ -x /usr/libexec/at-spi-bus-launcher ] || [ -x /usr/lib/at-spi2-core/at-spi-bus-launcher ] || missing="$missing at-spi2-core"
  for tool in flock timeout setsid; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
  [ -x /opt/google/chrome/chrome ] || missing="$missing google-chrome"
  printf '%s' "${missing# }"
}
MISSING="$(check_deps)"
if [ "$CMD" = "deps" ]; then
  if [ -z "$MISSING" ]; then echo "OK"; log_line 0 deps; exit 0; fi
  printf 'MISSING %s\n' "$MISSING"; printf 'On Ubuntu 24.04: %s\n' "$INSTALL_LINE"; log_line 2 deps; exit 2
fi
[ -z "$MISSING" ] || refuse 2 "ERR missing-dependency: $MISSING. On Ubuntu 24.04: $INSTALL_LINE (Chrome comes from Google's signed apt repository; POST /browser/linux/install does all of it)"

mkdir -p "$STATE/latch" 2>/dev/null; chmod 700 "$STATE" "$STATE/latch" 2>/dev/null

# One call at a time for this agent. The kernel releases the lock when its holder dies.
WAIT="${XD_LOCK_WAIT:-90}"; case "$WAIT" in ''|*[!0-9]*) WAIT=90 ;; esac; [ "$WAIT" -le 900 ] || WAIT=900
exec 9>>"$STATE/agent.lock"
flock -w "$WAIT" 9 || refuse 2 "ERR busy: another browser call is running for this agent"

DEADLINE="${XD_CMD_TIMEOUT:-60}"; case "$DEADLINE" in ''|*[!0-9]*) DEADLINE=60 ;; esac
[ "$DEADLINE" -ge 10 ] || DEADLINE=10; [ "$DEADLINE" -le 900 ] || DEADLINE=900

PROFILE="${XD_PROFILE:-}"
[ "$CMD" = "launch" ] && PROFILE="${2:-}"
case "$PROFILE" in *[!a-z0-9-]*) refuse 64 "ERR bad-profile-path: a profile id is lowercase letters, digits and dashes" ;; esac
LATCH="$STATE/latch/$PROFILE"
PARTIAL="$LATCH.partial"
LATCH_SET=0
if [ -n "$PROFILE" ] && [ -e "$LATCH" ]; then LATCH_SET=1; fi
# Stuck keys belong to the display, not the profile, so any profile's latch means release first.
ANY_LATCH=0
for held in "$STATE"/latch/*; do [ -e "$held" ] && ANY_LATCH=1; done

is_input=0
case "$CMD" in click|type|typesecret|key|nav) is_input=1 ;; esac
# Escape can only cancel, and a browser dialog can hide the page so no read could ever clear the latch.
if [ "$CMD" = "key" ] && [ "${2:-}" = "Escape" ]; then is_input=0; fi
if [ "$is_input" = 1 ] && [ "$LATCH_SET" = 1 ]; then
  refuse 2 "ERR unknown-outcome-unchecked: the last input ended without a clean result; read the page first (url, title, text or find)"
fi
if [ "$is_input" = 1 ] && [ -n "$PROFILE" ]; then : >"$LATCH"; rm -f "$PARTIAL"; fi

# Stdin stays inherited, not reopened: from the Secret Drop helper it is a socket, which /dev/stdin cannot reopen.
case "$CMD" in type|typesecret) ;; *) exec </dev/null ;; esac
[ -r "$STATE/display.json" ] && DISPLAY_NO="$(sed -n 's/.*"display": *\([0-9]*\).*/\1/p' "$STATE/display.json" 2>/dev/null)"

# The same private profile and display are used for the pre-read, while the wrapper lock is held.
if [ "$is_input" = 1 ]; then
  LOCKOUT_TEXT="$AGENT_HOME/.instar/state/xdrive/out/lockout-$$.txt"
  mkdir -p "$(dirname "$LOCKOUT_TEXT")"
  env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$HOME" LANG="${LANG:-C.UTF-8}" XD_HOME="$AGENT_HOME" XD_PROFILE="$PROFILE" \
    XD_CMD_TIMEOUT="$DEADLINE" XD_WRAPPER_PID="$$" \
    timeout --kill-after=5 "$DEADLINE" /usr/bin/python3 -I "$HERE/x-drive.py" text "$LOCKOUT_TEXT" </dev/null >/dev/null
  LOCKOUT_RC=$?
  if [ "$LOCKOUT_RC" != 0 ]; then
    rm -f -- "$LOCKOUT_TEXT" "$LATCH"; refuse 2 "ERR lockout-guard: full page text unavailable or truncated; input NOT sent"
  fi
  node "$HERE/lockout-guard.cjs" page "$AGENT_HOME" xdrive "$PROFILE" "$(printf '%s\0' "$@" | shasum -a 256 | cut -d' ' -f1)" "${XD_EXPECT:-}" <"$LOCKOUT_TEXT"
  LOCKOUT_RC=$?; rm -f -- "$LOCKOUT_TEXT"
  if [ "$LOCKOUT_RC" != 0 ]; then rm -f -- "$LATCH"; refuse 2 "ERR lockout-guard: operator approval required; input NOT sent"; fi
fi

# A clean environment: the agent's keys and tokens never reach the driver or Chrome.
env -i PATH="/usr/local/bin:/usr/bin:/bin" HOME="$HOME" LANG="${LANG:-C.UTF-8}" XD_HOME="$AGENT_HOME" XD_PROFILE="$PROFILE" \
  XD_CMD_TIMEOUT="$DEADLINE" XD_WRAPPER_PID="$$" XD_LATCH_SET="$ANY_LATCH" XD_PARTIAL_FILE="$PARTIAL" XD_LATCH_FILE="$LATCH" \
  XD_EXPECT="${XD_EXPECT:-}" XD_CHROME_FLAGS="${XD_CHROME_FLAGS:-}" \
  timeout --kill-after=5 "$DEADLINE" /usr/bin/python3 -I "$HERE/x-drive.py" "$@"
CODE=$?

case "$CODE" in
  124|137) printf 'ERR driver-timeout: the command ran past its limit; read the page before any more input\n'; CODE=1 ;;
esac
if [ "$is_input" = 1 ]; then
  # A success or a refusal before any input was sent is clean. A stop partway keeps the latch.
  if { [ "$CODE" = 0 ] || [ "$CODE" = 2 ] || [ "$CODE" = 3 ] || [ "$CODE" = 64 ]; } && [ ! -e "$PARTIAL" ]; then rm -f "$LATCH"; fi
  rm -f "$PARTIAL"
fi
case "$CMD" in url|title|text|find|close) if [ "$CODE" = 0 ] || [ "$CODE" = 3 ]; then rm -f "$LATCH"; fi ;; esac
log_line "$CODE" "$CMD"
exit "$CODE"
