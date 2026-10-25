#!/bin/bash
# ndrive.sh — run native-drive.ps1 (the Windows normal-Chrome driver, written by PP) from WSL.
# Usage: ndrive.sh <cmd> [a1] [a2] [a3]
#   Secrets: pipe ONE line on stdin to `typesecret` / `typesecretedit <index>`; never put one on argv.
# Runs the native-drive.ps1 that sits beside this wrapper (override with ND_SCRIPT=<Windows path>).
# Installed by instar into .instar/scripts/browser/ — overwritten on every update.
# See the /normal-chrome-browser skill for the method and its safety rules.
#
# This wrapper is the Instar entry point on Windows and the place Instar's rules are enforced (the driver
# itself accepts any directory, any url and any executable): a platform check, argument hygiene, a profile
# jail, a url rule (incl. no credential-shaped query on argv), an outfile rule, a chrome.exe rule, one
# driver at a time per agent, a per-agent binding file, a gate on the focus-override variables, a canfocus
# check before `invoke`, an optional expected-host check before input (ND_EXPECT_HOST), an unknown-outcome
# latch (after a timeout or crash, input waits for a read), WSLENV propagation, one content-free activity
# line per call, and the interactive-desktop bridge below. It is a guard against mistakes, like
# the macOS scripts' jail: it does not stop a caller who edits it or runs the .ps1 directly.
#
# Windows only, from WSL: it needs powershell.exe (WSL's /mnt/c path by default; set ND_POWERSHELL to override) and wslpath.
# On macOS use chrome-launch.sh, chrome-js.sh and chrome-mainworld.sh in this same folder.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOME="$(cd "$HERE/../../.." && pwd -P)"
# The agent tag names this agent's own state on the Windows side: the home's basename plus 8 hex of
# the full home path, so two homes with one basename (or `a.b` and `ab`) never share state.
AGENT_TAG="$(basename "$AGENT_HOME" | tr -cd 'A-Za-z0-9_-')-$(printf '%s' "$AGENT_HOME" | shasum -a 256 2>/dev/null | cut -c1-8)"
[ "${AGENT_TAG%-}" = "$AGENT_TAG" ] || AGENT_TAG="${AGENT_TAG}$(printf '%s' "$AGENT_HOME" | cksum | cut -d' ' -f1)"
CMDNAME="${1:-}"
CACHE_DIR="$AGENT_HOME/.instar/state/native-drive"; mkdir -p "$CACHE_DIR" 2>/dev/null
LATCH="$CACHE_DIR/unknown-outcome" # set by drive_once after a call whose page state is unknown

# One best-effort, content-free line per call (including this wrapper's own refusals), in the same log
# the macOS tools use: when, which script, which command, the exit code (64 = a bad argument refused here;
# 2 = a safety refusal, a busy agent or nothing to act on; 1 = a state, bridge or crash failure), the route
# decided for the call (`via`: direct / bridge; none = refused before the route was decided), the NAMES of any
# focus-override variables honored for the call, the topic and time of the operator declaration that
# authorized them, the NAMES of any dropped (never values), and how many stale bridge leftovers were
# swept, so an override can be matched to the operator's message. Never the arguments (a `type`
# argument can be a value), never the page. A failed write never changes the exit code.
LOG="$AGENT_HOME/.instar/logs/normal-chrome-browser.jsonl"
VIA="none"
OV_DROPPED=""
OV_HONORED=""    # set by the focus-override gate only; a refusal raised before the gate logs no honored name
DECLARATION=""   # "topic:<id>@<at>" of the unattended-machine record that authorized an honored override
SWEPT=0
logline() {
  local ov="$OV_HONORED"
  { mkdir -p "$(dirname "$LOG")" && printf '{"ts":"%s","script":"ndrive.sh","cmd":"%s","exit":%d,"via":"%s","overrides":"%s","overridesDropped":"%s","declaration":"%s","swept":%d}\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$(printf '%s' "${1:-}" | tr -cd 'A-Za-z')" "$2" "$VIA" "$ov" "$OV_DROPPED" "$([ -n "$ov" ] && printf '%s' "$DECLARATION" | tr -cd 'A-Za-z0-9:@.+-')" "$SWEPT" >> "$LOG"; } 2>/dev/null \
    || echo "warning: could not write the activity line to $LOG" >&2
}
refuse() { # <exit code> <message>
  echo "$2" >&2; logline "$CMDNAME" "$1"; exit "$1"
}

PS="${ND_POWERSHELL:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
if [ ! -x "$PS" ]; then
  if command -v powershell.exe >/dev/null 2>&1; then
    PS=powershell.exe
  else
    refuse 2 "ERR windows-only: ndrive.sh runs native-drive.ps1 through powershell.exe from WSL (or set ND_POWERSHELL=<path to powershell.exe>). On macOS use chrome-launch.sh / chrome-js.sh / chrome-mainworld.sh instead."
  fi
fi
# WSL only: every Windows path this wrapper hands to PowerShell, and every Windows path it reads back
# (the binding folder, the bridge work folder), is translated with wslpath. Git Bash has no wslpath and
# has not been run against; it refuses rather than guess (a second Windows host and Git Bash are
# ACT-140's test plan).
command -v wslpath >/dev/null 2>&1 || refuse 2 "ERR wsl-only: ndrive.sh runs from WSL (it needs wslpath to translate paths); Git Bash and other shells are untested. Run it from the agent's WSL shell."
winpath() { wslpath -w "$1"; }
unixpath() { wslpath -u "$1" 2>/dev/null; }
SCRIPT="${ND_SCRIPT:-$(winpath "$HERE/native-drive.ps1")}"

# ── Argument rules ────────────────────────────────────────────────────────────────────────────────────
# The driver builds Chrome's command line by joining strings (PowerShell 5.1's Start-Process does not
# quote), so a double quote, a backtick or a newline inside ANY value could close the token and smuggle a
# flag. Every value that reaches chrome.exe is checked for those first.
has_bad_chars() { case "$1" in *\"*|*\`*|*[[:cntrl:]]*) return 0;; esac; return 1; }
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
# Profile jail (launch/attach's first argument and ND_USER_DATA_DIR): a Windows profile directory must be
# an absolute drive-letter path (C:\... or C:/...) on the local filesystem (never \\wsl.localhost, \\wsl$
# or any other share: chrome.exe and the driver have only been run against local paths), with no `..`
# component and no 8.3 alias (`~`), so the comparison below sees the same path the driver will; and it is
# never the operator's own DEFAULT profile folder of Google Chrome (Chrome, Chrome Beta, Chrome Dev,
# Chrome SxS) or of Chromium (the driver binds any chrome.exe), either slash, any case. An operator Chrome
# running with a custom --user-data-dir is outside this rule, which is why the skill says automation gets
# its own profile. Trailing slashes are stripped (a trailing backslash would escape the driver's closing
# quote).
refuse_profile() {
  has_bad_chars "$1" && refuse 64 "ERR bad-profile-path: a profile directory may not contain a double quote, a backtick or a control character; got: $1"
  local p; p="$(lower "$1" | sed 's/[\\/]*$//')"
  case "$p" in
    *google[\\/]chrome[\\/]user\ data*|*google[\\/]chrome\ beta[\\/]user\ data*|*google[\\/]chrome\ dev[\\/]user\ data*|*google[\\/]chrome\ sxs[\\/]user\ data*|*google[\\/]chrome|*google[\\/]chrome\ beta|*google[\\/]chrome\ dev|*google[\\/]chrome\ sxs|*chromium[\\/]user\ data*|*[\\/]chromium)
      refuse 64 "ERR profile-reserved-folder: $1 is the operator's own Chrome profile folder; give automation its own profile directory" ;;
  esac
  case "$p" in
    *[\\/]..[\\/]*|*[\\/]..|*~*) refuse 64 "ERR bad-profile-path: no '..' components or 8.3 (~) aliases in a profile directory; got: $1" ;;
    \\\\*) refuse 64 "ERR bad-profile-path: a profile directory must be on the local Windows filesystem (C:\\...), not a network or \\\\wsl.localhost share; got: $1" ;;
    *[\\/].[\\/]*|*[\\/].|*[\\/][\\/]*) refuse 64 "ERR bad-profile-path: no '.' segments or doubled separators in a profile directory (an alternative spelling of a folder is refused, not normalized); got: $1" ;;
    *.[\\/]*|*.|*\ [\\/]*|*\ |*[\*\?\[\]]*) refuse 64 "ERR bad-profile-path: a path component may not end in a dot or a space (Windows strips them, so the spelling would not name what it says), and no wildcard characters; got: $1" ;;
    [a-z]:[\\/]?*) ;;
    *) refuse 64 "ERR bad-profile-path: a Windows profile directory must be an absolute Windows path (C:\\...); got: $1" ;;
  esac
}
# A url slot is passed to chrome.exe as an argument (launch) or typed into the omnibox (nav). Only a URL
# with a scheme and no whitespace, quote or control character is accepted: a flag can never ride the
# launch url slot, and a secret-shaped value (a one-time sign-in link, an OAuth code) is the agent's
# responsibility to keep off argv, which the skill says.
refuse_url() {
  # A url is never echoed back in a refusal: a malformed one may still carry a credential.
  local u dec
  has_bad_chars "$1" && refuse 64 "ERR bad-url: a url may not contain a double quote, a backtick or a control character (the url is not echoed)"
  u="$(lower "$1")"   # the scheme/whitespace checks are case-insensitive on the raw url
  case "$u" in
    *[[:space:]]*) refuse 64 "ERR bad-url: a url contains no whitespace (the url is not echoed)" ;;
    https://?*|http://?*|about:?*|chrome://?*|file://?*) ;;
    *) refuse 64 "ERR bad-url: a url must carry a scheme (https://..., about:blank); a Chrome launch flag is never accepted here, in any form (the url is not echoed)" ;;
  esac
  # A credential-shaped parameter (an OAuth code, a token, an API key, a one-time sign-in code) in the
  # query OR the fragment, with percent-encoding in the name decoded first, would sit on this process's
  # command line, readable by anything on the machine: refused, not relayed. The check is bounded (a name
  # list), and the wrapper's own argv has already carried the value by the time it runs: the skill's rule
  # is still to never build such a url.
  # Literal backslashes are doubled first so printf %b interprets ONLY the substituted %XX escapes (a
  # literal \c would otherwise end the output and hide everything after it).
  # Decoded FIRST, lower-cased AFTER (so %43ode becomes code), from the raw url (an upper-case %XX decodes too).
  dec="$(printf '%b' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/%\([0-9a-fA-F][0-9a-fA-F]\)/\\x\1/g')" 2>/dev/null | tr 'A-Z' 'a-z' || lower "$1")"
  case "$dec" in
    *[\?\&\#\;]code=*|*[\?\&\#\;]token=*|*[\?\&\#\;]access_token=*|*[\?\&\#\;]id_token=*|*[\?\&\#\;]refresh_token=*|*[\?\&\#\;]oobcode=*|*[\?\&\#\;]api_key=*|*[\?\&\#\;]apikey=*|*[\?\&\#\;]key=*|*[\?\&\#\;]secret=*|*[\?\&\#\;]password=*|*[\?\&\#\;]otp=*|*[\?\&\#\;]auth=*|*[\?\&\#\;]sig=*|*[\?\&\#\;]signature=*|*[\?\&\#\;]ticket=*|*[\?\&\#\;]assertion=*|*[\?\&\#\;]session=*)
      refuse 64 "ERR secret-shaped-url: the url carries a credential-shaped query parameter (code/token/key/secret/password/otp/auth/sig/ticket) and a url on argv is readable by every process on the machine; open the page from the browser (have the operator click the link in their own session, or nav to the page without the parameter) and never put a one-time link or a token on a command line" ;;
  esac
}
# text/tree/shot write an outfile the driver opens from its own session: a local Windows path only (the
# \\\\wsl.localhost share is untested from the task's session), no '..', no '.' segments, no doubled
# separators, no quote (the same spelling rule as the profile jail, without its reserved folders).
refuse_outfile() { # <path> [what]
  local what="${2:-an outfile path}"
  has_bad_chars "$1" && refuse 64 "ERR bad-outfile: $what may not contain a double quote, a backtick or a control character; got: $1"
  case "$(lower "$1")" in
    *[\\/]..[\\/]*|*[\\/]..|*~*|*[\\/].[\\/]*|*[\\/].|*[\\/][\\/]*) refuse 64 "ERR bad-outfile: no '..', '.' segments, 8.3 (~) aliases or doubled separators in $what; got: $1" ;;
    *[\*\?\[\]]*) refuse 64 "ERR bad-outfile: no wildcard characters (* ? [ ]) in $what (the driver writes it with a wildcard-expanding -Path); got: $1" ;;
    *.[\\/]*|*.|*\ [\\/]*|*\ ) refuse 64 "ERR bad-outfile: a path component of $what may not end in a dot or a space (Windows strips them, so the spelling would not name what it says); got: $1" ;;
    [a-z]:[\\/]?*) ;;
    *) refuse 64 "ERR bad-outfile: $what must be an absolute LOCAL Windows path (C:\\...; a \\\\wsl.localhost or network path is untested from the task's session and is refused); got: $1" ;;
  esac
}
# launch's optional third argument names the Chrome executable the driver starts: an absolute local
# path to chrome.exe, nothing else (a wrapper script could add any flag).
refuse_exe() {
  has_bad_chars "$1" && refuse 64 "ERR bad-chrome-exe: the chrome.exe path may not contain a double quote, a backtick or a control character; got: $1"
  case "$(lower "$1")" in
    [a-z]:[\\/]*[\\/]chrome.exe) ;;
    *) refuse 64 "ERR bad-chrome-exe: the third launch argument must be an absolute local path ending in \\chrome.exe; got: $1" ;;
  esac
}
# Nothing that reaches the driver may carry a newline (a control character in a path or text is never
# meant; the command name included), and the two numeric knobs must be integers within a bound before
# they are interpolated anywhere. These run first, before any value is echoed back in a refusal.
for a in "$@"; do
  case "$a" in *$'\n'*|*$'\r'*) refuse 64 "ERR bad-argument: arguments may not contain newlines" ;; esac
done
# PowerShell binds a dash-led argument as a NAMED parameter before the positional ones, so
# `target -Cmd nav -A1 <url>` would run `nav` while this wrapper had classified the call as `target`.
# No argument after the command name may start with '-', and the driver takes at most three.
for a in "${@:2}"; do
  case "$a" in -*) refuse 64 "ERR bad-argument: an argument may not start with '-' (PowerShell would read it as a parameter name); the driver's flags are set through ND_* variables, never on the command line" ;; esac
done
[ "$#" -le 4 ] || refuse 64 "ERR bad-argument: too many arguments ($(( $# - 1 )) after the command; the driver takes at most three)"
# The command name is canonicalized and allowlisted here: the driver's own `switch` compares
# case-insensitively, so `LAUNCH` would have reached it while skipping the launch-slot checks below.
CMDNAME="$(lower "$CMDNAME")"
case "$CMDNAME" in
  attach|canfocus|clearfield|click|clickxy|ctrl|editfields|find|focus|invoke|key|launch|nav|shot|target|text|tree|type|typeedit|typesecret|typesecretedit|url) ;;
  *) refuse 64 "ERR bad-argument: unknown command '$(printf '%s' "$CMDNAME" | tr -cd 'A-Za-z0-9_-' | cut -c1-32)'; the driver's commands are attach canfocus clearfield click clickxy ctrl editfields find focus invoke key launch nav shot target text tree type typeedit typesecret typesecretedit url" ;;
esac
set -- "$CMDNAME" "${@:2}"
# The two secret-reading commands take exactly ONE non-empty line on stdin, read here once for both
# routes: an empty line or nothing at all is refused before anything is sent (the driver would clear the
# field and type ""), and the value is never echoed. The direct route feeds the line to the driver's
# stdin; the bridge carries it in the per-call stdin file.
SECRET_LINE=""
case "$CMDNAME" in
  typesecret|typesecretedit)
    IFS= read -r SECRET_LINE || true
    SECRET_LINE="${SECRET_LINE%$'\r'}"
    # Measured on the Mama PC (2026-10-21): a non-ASCII secret reaches the driver as its UTF-8 bytes and is
    # typed wrong, silently (15 characters became 19). Refused rather than typed wrong; the value is not echoed.
    if printf '%s' "$SECRET_LINE" | LC_ALL=C grep -q '[^ -~]'; then
      refuse 64 "ERR bad-argument: the secret line carries a character outside printable ASCII; through this wrapper it would be typed as its UTF-8 bytes (measured), so it is refused rather than typed wrong. Nothing was typed."
    fi
    [ -n "$SECRET_LINE" ] || refuse 64 "ERR bad-argument: $CMDNAME needs one non-empty line on stdin (pipe the secret with printf '%s\\n'); nothing was typed" ;;
esac
TIMEOUT="${ND_BRIDGE_TIMEOUT:-120}"
case "$TIMEOUT" in ''|*[!0-9]*) refuse 64 "ERR bad-argument: ND_BRIDGE_TIMEOUT must be an integer number of seconds (10-900); got: $TIMEOUT" ;; esac
{ [ "$TIMEOUT" -ge 10 ] && [ "$TIMEOUT" -le 900 ]; } 2>/dev/null || refuse 64 "ERR bad-argument: ND_BRIDGE_TIMEOUT must be between 10 and 900 seconds; got: $TIMEOUT"
LOCK_WAIT="${ND_LOCK_WAIT:-90}"
case "$LOCK_WAIT" in ''|*[!0-9]*) refuse 64 "ERR bad-argument: ND_LOCK_WAIT must be an integer number of seconds (0-900); got: $LOCK_WAIT" ;; esac
[ "$LOCK_WAIT" -le 900 ] 2>/dev/null || refuse 64 "ERR bad-argument: ND_LOCK_WAIT must be at most 900 seconds; got: $LOCK_WAIT"
# ND_EXPECT_HOST (optional): the host the page must be on before any input-sending command; a lowercase
# hostname with an optional :port, compared at a host boundary against the driver's `url` (the omnibox
# display string, scheme stripped) right before the command. The structural twin of the macOS tools'
# expected-origin argument.
EXPECT_HOST="$(lower "${ND_EXPECT_HOST:-}")"
case "$EXPECT_HOST" in
  '') ;;
  *[!a-z0-9.:-]*|.*|*.|*:|*::*|-*) refuse 64 "ERR bad-argument: ND_EXPECT_HOST must be a hostname (letters, digits, dots, hyphens) with an optional :port; got: $EXPECT_HOST" ;;
esac
case "$CMDNAME" in
  launch)
    [ -n "${2:-}" ] && refuse_profile "$2"
    [ -n "${3:-}" ] && refuse_url "$3"
    [ -n "${4:-}" ] && refuse_exe "$4"
    # Strip trailing slashes from the profile path before it reaches the driver (`\"` would escape).
    if [ -n "${2:-}" ]; then P2="$(printf '%s' "$2" | sed 's/[\\/]*$//')"; set -- "$1" "$P2" "${@:3}"; fi ;;
  attach)
    [ -n "${2:-}" ] && refuse_profile "$2"
    if [ -n "${2:-}" ]; then P2="$(printf '%s' "$2" | sed 's/[\\/]*$//')"; set -- "$1" "$P2" "${@:3}"; fi ;;
  nav) [ -n "${2:-}" ] && refuse_url "$2" ;;
  text|tree|shot) [ -n "${2:-}" ] && refuse_outfile "$2" ;;
esac
# Text that the driver types or matches: non-ASCII transit on argv has not been measured (only the stdin
# line was, and it arrived as UTF-8 bytes), so it is warned about, never silently trusted.
case "$CMDNAME" in
  type|typeedit|find|click|invoke|nav)
    for a in "${@:2}"; do
      if printf '%s' "$a" | LC_ALL=C grep -q '[^ -~]'; then echo "warning: a non-ASCII argument reaches the driver as its UTF-8 bytes through this wrapper (measured for the secret line; argv unmeasured); verify with text what landed, prefer ASCII" >&2; break; fi
    done ;;
esac
if [ -n "${ND_USER_DATA_DIR:-}" ]; then
  refuse_profile "$ND_USER_DATA_DIR"
  # The same trailing-separator strip as the positional slot (a `\"` would escape the driver's quote).
  ND_USER_DATA_DIR="$(printf '%s' "$ND_USER_DATA_DIR" | sed 's/[\\/]*$//')"; export ND_USER_DATA_DIR
fi

# ── The focus-override gate ───────────────────────────────────────────────────────────────────────────
# ND_ALLOW_FOCUS_STEAL and a lowered ND_OPERATOR_IDLE_MS bypass the driver's operator-active rule, so
# they are honored only on a machine the operator has declared unattended, recorded in .instar/config.json
# as normalChromeBrowser.unattendedMachine = { "declaredBy": "<the topic's verified operator uid>",
# "topicId": <the topic where they said so>, "at": "<ISO time>" } (declaredBy a non-empty string, topicId a
# non-zero integer, at a valid past timestamp no older than 30 days: a declaration expires and is
# re-recorded). The agent writes that record itself when the operator says so in a topic, taking
# declaredBy from GET /topic-operator/<topicId> (the skill's procedure); a bare `true` or any other shape
# is not accepted. This is a cooperative boundary like the binding file (the file is agent-writable): it
# exists so the decision is a recorded, dated one, not an env var set mid-run. Without node the record
# cannot be read and the machine is treated as attended. Raising the idle threshold above the 30000 ms
# default is always allowed. Dropped variables are recorded by NAME in the activity line; an honored one
# is recorded with the declaration that authorized it.
if [ -n "${ND_ALLOW_FOCUS_STEAL:-}" ] || [ -n "${ND_OPERATOR_IDLE_MS:-}" ]; then
  CFG="$AGENT_HOME/.instar/config.json"
  if command -v node >/dev/null 2>&1; then
    DECL_RAW="$(node -e 'try{const c=require(process.argv[1]);const u=c&&c.normalChromeBrowser&&c.normalChromeBrowser.unattendedMachine;const at=u&&typeof u.at==="string"?Date.parse(u.at):NaN;const fresh=Number.isFinite(at)&&at<=Date.now()&&Date.now()-at<=30*86400000;const ok=!!(u&&typeof u==="object"&&typeof u.declaredBy==="string"&&u.declaredBy.length>0&&typeof u.topicId==="number"&&Number.isInteger(u.topicId)&&u.topicId!==0&&fresh);process.stdout.write(ok?"true|topic:"+u.topicId+"@"+new Date(at).toISOString():"false")}catch(e){process.stdout.write("unreadable")}' "$CFG" 2>/dev/null)"
    UNATTENDED="${DECL_RAW%%|*}"; DECLARATION="${DECL_RAW#*|}"; [ "$DECLARATION" = "$DECL_RAW" ] && DECLARATION=""
  else
    UNATTENDED=unreadable
    echo "warning: node is needed to read normalChromeBrowser.unattendedMachine from $CFG; treating this machine as attended" >&2
  fi
  [ "$UNATTENDED" = unreadable ] && [ -r "$CFG" ] && command -v node >/dev/null 2>&1 && echo "warning: could not read $CFG; treating this machine as attended" >&2
  if [ "$UNATTENDED" != true ]; then
    if [ -n "${ND_ALLOW_FOCUS_STEAL:-}" ]; then
      unset ND_ALLOW_FOCUS_STEAL; OV_DROPPED="ND_ALLOW_FOCUS_STEAL"
      echo "warning: ND_ALLOW_FOCUS_STEAL ignored: this machine has no current unattended declaration (normalChromeBrowser.unattendedMachine in .instar/config.json: {declaredBy, topicId, at}, recorded on the operator's instruction, valid 30 days)" >&2
    fi
    if [ -n "${ND_OPERATOR_IDLE_MS:-}" ] && ! { [ "$ND_OPERATOR_IDLE_MS" -ge 30000 ] 2>/dev/null; }; then
      unset ND_OPERATOR_IDLE_MS; OV_DROPPED="${OV_DROPPED:+$OV_DROPPED,}ND_OPERATOR_IDLE_MS"
      echo "warning: ND_OPERATOR_IDLE_MS below the 30000 ms default ignored: this machine is not declared unattended" >&2
    fi
  fi
fi
[ -n "${ND_ALLOW_FOCUS_STEAL:-}" ] && OV_HONORED="ND_ALLOW_FOCUS_STEAL"
[ -n "${ND_OPERATOR_IDLE_MS:-}" ] && OV_HONORED="${OV_HONORED:+$OV_HONORED,}ND_OPERATOR_IDLE_MS"

# ── The binding file ──────────────────────────────────────────────────────────────────────────────────
# "Which Chrome is the target" is scoped to THIS agent instead of the driver's per-Windows-user default
# (%LOCALAPPDATA%\native-drive\target.json), so two agents on the same Windows account cannot rebind each
# other's target between commands: %LOCALAPPDATA%\native-drive\instar-<agent>-<hash>\target.json, a local
# Windows path like the default (never a \\wsl.localhost share, which the driver has not been run against).
# The sessions of ONE agent share it on purpose (one agent, one actor; the per-agent lock below keeps them
# from interleaving); a scripted sequence sets ND_USER_DATA_DIR for the whole sequence, so a rebind by
# anyone else cannot redirect it. %LOCALAPPDATA% is read from PowerShell once (stdin closed, so a secret
# line is never swallowed by the probe), must be a plain drive-letter path, and is cached under the agent
# home; a cached value that is not such a path, or whose directory no longer exists, is re-probed. When
# it cannot be read at all the wrapper refuses rather than share the per-user default. ND_STATE_FILE set
# by the caller wins.
valid_lad() { case "$1" in *\;*|*\&*|*\|*|*[\*\?\[\]]*) return 1;; esac; has_bad_chars "$1" && return 1; case "$1" in [A-Za-z]:\\?*) return 0;; esac; return 1; }
lad_exists() { [ -d "$(unixpath "$1")" ]; }
LAD="$(cat "$CACHE_DIR/localappdata.txt" 2>/dev/null)"
valid_lad "$LAD" || LAD=""
if [ -n "$LAD" ] && ! lad_exists "$LAD"; then LAD=""; fi
if [ -z "$LAD" ]; then
  LAD="$("$PS" -NoProfile -NonInteractive -Command '$env:LOCALAPPDATA' </dev/null 2>/dev/null | tr -d '\r\n')"
  if valid_lad "$LAD"; then printf '%s' "$LAD" > "$CACHE_DIR/localappdata.txt" 2>/dev/null; else LAD_REFUSED="$LAD"; LAD=""; fi
fi
if [ -z "$LAD" ]; then
  [ -n "${LAD_REFUSED:-}" ] && refuse 1 "ERR state-unavailable: %LOCALAPPDATA% was read but refused: it must be a plain local drive-letter path without ';', '&', '|', a wildcard character (the driver writes its binding file with a wildcard-expanding -Path), a quote, a backtick or a control character; this agent's own binding folder cannot be established under it."
  refuse 1 "ERR state-unavailable: could not read %LOCALAPPDATA% from PowerShell, so this agent's own binding folder cannot be established; refusing rather than sharing the per-user default with every agent on this Windows account"
fi
if [ -z "$ND_STATE_FILE" ]; then
  ND_STATE_FILE="$LAD\\native-drive\\instar-$AGENT_TAG\\target.json"
  export ND_STATE_FILE
else
  refuse_outfile "$ND_STATE_FILE" "ND_STATE_FILE (the binding file)"   # a caller's binding file obeys the same local-path rule
fi

# Environment variables reach the Windows process only when they are listed in WSLENV (PP's lesson).
# APPEND to a caller's WSLENV, never overwrite it; skip names already listed (with or without /flags).
for v in ND_STATE_FILE ND_CHROME_FLAGS ND_ALLOW_FOCUS_STEAL ND_OPERATOR_IDLE_MS ND_USER_DATA_DIR; do
  case ":${WSLENV:-}:" in
    *":$v:"*|*":$v/"*) ;;
    *) WSLENV="${WSLENV:+$WSLENV:}$v" ;;
  esac
done
export WSLENV

# ── One call at a time per agent ──────────────────────────────────────────────────────────────────────
# Two sessions of one agent calling the wrapper at once would interleave real input on the same bound
# Chrome (one session's Ctrl+L mid-way through another's typesecretedit), which the driver's per-character
# check cannot see (the target still holds the foreground). A per-agent lock (a directory under the agent
# home, holding a file NAMED after the owner's pid) serializes calls, waiting up to ND_LOCK_WAIT seconds
# (90) before refusing with ERR busy. The protocol uses only two atomic primitives and never renames:
# mkdir creates the lock for exactly one caller; a reclaim removes exactly the DEAD owner's pid file (by
# its name, so a live owner's file is never touched) and then rmdir, which succeeds only for an empty
# directory (if any other pid file has appeared the directory stays and is re-read). The liveness check
# is kill -0 on the pid: a recycled pid can make a dead owner look alive for one wait (then ERR busy),
# which is the safe direction. A lock with no pid file (its owner killed between mkdir and the write, a
# window of microseconds) is reclaimed once it is older than the wait, never before. Every loop
# iteration that does not reclaim sleeps and counts (P19).
LOCK_DIR="$CACHE_DIR/lock.d"
HAVE_LOCK=0
LOCK_RECLAIMED=0
waited=0
lock_age() { echo $(( $(date +%s) - $(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) )); }
lock_owner() { local f; for f in "$LOCK_DIR"/pid.*; do [ -e "$f" ] && { printf '%s' "${f##*/pid.}"; return 0; }; done; return 1; }
while :; do
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    # The pid file goes in right after the mkdir. A write that fails gives the lock back (a live owner
    # must never leave a pid-less lock); the read-back catches a waiter that removed this fresh lock in
    # the instant before the file landed, in which case the acquisition is simply retried.
    if ! : > "$LOCK_DIR/pid.$$" 2>/dev/null; then
      if [ -d "$LOCK_DIR" ]; then rmdir "$LOCK_DIR" 2>/dev/null; refuse 1 "ERR state-unavailable: cannot write the per-agent lock $LOCK_DIR/pid.$$"; fi
      continue
    fi
    [ -e "$LOCK_DIR/pid.$$" ] || continue
    # Exclusivity: if another pid file sits beside mine, the directory was replaced under one of us (a
    # pid-less reclaim that raced an owner's write); give mine back and retry rather than share the lock.
    n=0; for f in "$LOCK_DIR"/pid.*; do [ -e "$f" ] && n=$((n + 1)); done
    if [ "$n" -gt 1 ]; then rm -f -- "$LOCK_DIR/pid.$$" 2>/dev/null; sleep 1; waited=$((waited + 1)); continue; fi
    HAVE_LOCK=1; break
  fi
  owner="$(lock_owner)" || owner=""
  # A pid-less lock is reclaimed once older than the wait, and never under 5 s (seconds-granular mtime):
  # a lock an owner created an instant ago cannot be reclaimed before its pid file lands, whatever
  # ND_LOCK_WAIT says.
  PIDLESS_AGE="$LOCK_WAIT"; [ "$PIDLESS_AGE" -lt 5 ] && PIDLESS_AGE=5
  case "$owner" in
    '') [ "$(lock_age)" -ge "$PIDLESS_AGE" ] && rmdir "$LOCK_DIR" 2>/dev/null && continue ;;
    *[!0-9]*) # a file that is not a pid (junk): removed only once the lock is older than the wait
      if [ "$(lock_age)" -ge "$PIDLESS_AGE" ]; then rm -f -- "$LOCK_DIR/pid.$owner" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null && continue; fi ;;
    *) if ! kill -0 "$owner" 2>/dev/null; then
         rm -f -- "$LOCK_DIR/pid.$owner" 2>/dev/null
         rmdir "$LOCK_DIR" 2>/dev/null && { LOCK_RECLAIMED=1; continue; }
       fi ;;
  esac
  [ "$waited" -ge "$LOCK_WAIT" ] && refuse 2 "ERR busy: another ndrive.sh call of this agent is running (pid ${owner:-unknown}; lock $LOCK_DIR); one wrapper call at a time per agent. Waited ${LOCK_WAIT}s (ND_LOCK_WAIT). A lock whose owner is dead is reclaimed by the next call; a lock with no pid file is reclaimed once older than the wait."
  sleep 1; waited=$((waited + 1))
done
BRIDGE_WDIR_U=""
cleanup() {
  if [ -n "$BRIDGE_WDIR_U" ] && [ -d "$BRIDGE_WDIR_U" ]; then
    [ -f "$BRIDGE_WDIR_U/stdin.txt" ] && : > "$BRIDGE_WDIR_U/stdin.txt"
    # Removed only when the call is known finished (rc.txt) or the driver was never launched (no pid and
    # no launch marker); anything else may still have a driver behind it.
    if [ -f "$BRIDGE_WDIR_U/rc.txt" ] || { [ ! -f "$BRIDGE_WDIR_U/pid.txt" ] && [ ! -f "$BRIDGE_WDIR_U/launching.txt" ]; }; then
      rm -rf -- "$BRIDGE_WDIR_U" 2>/dev/null
    else
      # The call was interrupted (a signal reached this wrapper) while its PowerShell poll, its task and the
      # driver may still be running: the folder STAYS as the leftover marker the next call's orphan guard
      # keys on, the driver's pid is written to the survivor record now, and the 1200 s sweep removes the
      # folder later.
      if [ -f "$BRIDGE_WDIR_U/pid.txt" ] && [ ! -f "$CACHE_DIR/survivor" ]; then
        cl_p="$(tr -d '\r\n ' < "$BRIDGE_WDIR_U/pid.txt")"; cl_s="$(tr -d '\r\n ' 2>/dev/null < "$BRIDGE_WDIR_U/pidstart.txt")"
        case "$cl_p" in ''|*[!0-9]*) ;; *) printf '%s %s %s\n' "$cl_p" "${cl_s:--}" "$(date +%s)" > "$CACHE_DIR/survivor" 2>/dev/null ;; esac
      fi
      # An interrupted INPUT command leaves the page state unknown: the latch is set here too.
      if [ "${INPUT_CMD:-0}" = 1 ]; then printf '%s %s interrupted' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$CMDNAME" > "$LATCH" 2>/dev/null; fi
    fi
  fi
  BRIDGE_WDIR_U=""
  # Only this call's own pid file is removed; rmdir then succeeds only when nothing else is in the lock.
  if [ "$HAVE_LOCK" = 1 ]; then rm -f -- "$LOCK_DIR/pid.$$" 2>/dev/null; rmdir "$LOCK_DIR" 2>/dev/null; HAVE_LOCK=0; fi
}
trap cleanup EXIT

# ── Direct or bridged? ────────────────────────────────────────────────────────────────────────────────
# An Instar agent in WSL is usually started by wslservice, which runs in Windows session 0: a process
# launched from there has no interactive desktop at all (EnumWindows sees nothing, GetForegroundWindow is
# 0), so the driver can bind a profile (the process lookup is machine-wide) and then every later command
# answers "target Chrome has no visible window" (live test, Mama PC, 2026-10-21). The desktop the operator
# sees is session 1. When this shell's PowerShell is in session 0, the driver is run through a one-shot
# Task Scheduler task registered for the current user with LogonType Interactive and RunLevel Limited (the
# in-box route the live test used: no password, no installs, no admin). The task runs a hidden runner that
# starts the driver with its stdout/stderr/exit code redirected to files under the agent's binding folder,
# its stdin from a file this wrapper writes (one secret line, overwritten and deleted right after; a kill
# of this wrapper before its exit trap can leave that file behind, which is why every call sweeps this
# agent's stale leftovers first), and the ND_* variables set in the runner. Nothing is shown on the desktop
# and no window takes focus (a Chrome the task launches does not get foreground activation either: live
# test §6.5). ND_BRIDGE=off refuses in session 0 with ERR no-interactive-desktop; ND_BRIDGE=task forces
# the bridge from any session (for a test); ND_BRIDGE=direct runs the driver directly ONLY when the
# session cannot be read (a terminal the operator opened) and is refused in a MEASURED session 0, where
# a direct `launch` would start an invisible Chrome holding the profile (bug 2 of the first wrapper
# run). A session that cannot be read is otherwise refused (ERR session-unknown).
SESSION="$("$PS" -NoProfile -NonInteractive -Command '[System.Diagnostics.Process]::GetCurrentProcess().SessionId' </dev/null 2>/dev/null | tr -d '\r\n ')"
# The probe came back empty in about 2% of calls in the live run (a WSL interop hiccup): try once more
# before refusing, never fall through to the direct path on an empty answer.
[ -z "$SESSION" ] && SESSION="$("$PS" -NoProfile -NonInteractive -Command '[System.Diagnostics.Process]::GetCurrentProcess().SessionId' </dev/null 2>/dev/null | tr -d '\r\n ')"
USE_BRIDGE=0
if [ "${ND_BRIDGE:-}" = task ]; then USE_BRIDGE=1
elif [ -z "$SESSION" ] || ! case "$SESSION" in *[!0-9]*) false;; esac; then
  if [ "${ND_BRIDGE:-}" != direct ]; then
    refuse 1 "ERR session-unknown: could not read this shell's Windows session id from PowerShell, so it is unknown whether a desktop is visible; set ND_BRIDGE=direct to run anyway from a terminal the operator opened, or ND_BRIDGE=task to force the bridge."
  fi
elif [ "$SESSION" = 0 ]; then
  if [ "${ND_BRIDGE:-}" = off ]; then
    refuse 2 "ERR no-interactive-desktop: this shell's Windows processes run in session 0 (started by wslservice), where no desktop is visible; the driver cannot act here. Unset ND_BRIDGE to run it through the interactive-session bridge, or run from a terminal the operator opened."
  fi
  if [ "${ND_BRIDGE:-}" = direct ]; then
    refuse 2 "ERR no-interactive-desktop: this shell's Windows processes are measured in session 0, where no desktop is visible, so ND_BRIDGE=direct is refused here (a direct launch would start an invisible Chrome holding the profile); ND_BRIDGE=direct is for a session id that cannot be read. Unset ND_BRIDGE for the bridge."
  fi
  USE_BRIDGE=1
fi
[ "$USE_BRIDGE" = 1 ] && VIA="bridge" || VIA="direct"

# PowerShell single-quoted literal: double every single quote.
psq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }
BRIDGE_ROOT_W="$LAD\\native-drive\\instar-$AGENT_TAG\\bridge"
BRIDGE_ROOT_U="$(unixpath "$BRIDGE_ROOT_W")"
# The leftover check and the sweep read this folder; an untranslatable path would make "unknown" read as
# "no leftovers" on the direct route, so it refuses instead (the same rule as an unreadable task list).
[ -n "$BRIDGE_ROOT_U" ] || refuse 1 "ERR state-unavailable: the bridge folder $BRIDGE_ROOT_W could not be translated to a WSL path (wslpath -u answered nothing), so it is unknown whether an earlier call left a driver running; refusing rather than start a second one."

# Sweep this agent's stale leftovers from an interrupted earlier call: bridge folders older than 1200 s
# (the 900 s timeout ceiling plus the task's 60 s grace plus a 240 s margin for the delay between the
# folder's last write and the task's start, so a folder of a call that ran with a longer timeout than this
# one is never removed under a task that may still be running; the secret file truncated first) and one-shot
# tasks of this agent that are not running. Tasks of this agent that ARE still running are counted
# (RUNNING_TASKS): a bridged driver whose wrapper was killed can outlive the per-agent lock, and a second
# driver beside it is the interleaving the lock exists to prevent. The count must come back as an
# explicit `running=N` line: when the enumeration itself fails, RUNNING_TASKS is EMPTY (unknown), never 0.
RUNNING_TASKS=""
sweep_stale() {
  local d age now n out sv_v sv_p sv_s
  now="$(date +%s)"
  if [ -n "$BRIDGE_ROOT_U" ] && [ -d "$BRIDGE_ROOT_U" ]; then
    for d in "$BRIDGE_ROOT_U"/*/; do
      [ -d "$d" ] || continue
      # A leftover folder with a recorded pid and no exit code is a dead call whose driver may still run:
      # unless its Windows side confirmed the driver gone/stopped/not-the-driver, adopt it into the
      # survivor record (pid, start time or '-', the call's time) so the orphan guard waits for it.
      if [ ! -f "$CACHE_DIR/survivor" ] && [ -f "$d/pid.txt" ] && [ ! -f "$d/rc.txt" ]; then
        sv_v="$(tr -d '\r\n ' 2>/dev/null < "$d/verdict.txt")"
        case "$sv_v" in
          ''|driver-still-running|driver-unverified-live)
            sv_p="$(tr -d '\r\n ' < "$d/pid.txt")"; sv_s="$(tr -d '\r\n ' 2>/dev/null < "$d/pidstart.txt")"
            case "$sv_p" in ''|*[!0-9]*) ;; *)
              # `at` = when pid.txt was written (the instant the driver started), the same meaning cleanup gives it
              printf '%s %s %s\n' "$sv_p" "${sv_s:--}" "$(stat -c %Y "$d/pid.txt" 2>/dev/null || stat -f %m "$d/pid.txt" 2>/dev/null || echo "$now")" > "$CACHE_DIR/survivor" 2>/dev/null
              # The adopted driver's command is unknown; the page state is unknown with it: latch.
              [ -e "$LATCH" ] || printf '%s adopted-leftover' "$(date +%Y-%m-%dT%H:%M:%S%z)" > "$LATCH" 2>/dev/null ;;
            esac ;;
        esac
      fi
      age=$(( now - $(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null || echo "$now") ))
      if [ "$age" -gt 1200 ]; then
        [ -f "$d/stdin.txt" ] && : > "$d/stdin.txt"
        rm -rf -- "$d" 2>/dev/null && SWEPT=$((SWEPT + 1))
      fi
    done
  fi
  # The enumeration runs under terminating errors: a count is printed only after it succeeded; "no
  # matching task" is zero, any other failure prints enum-failed, which the wrapper reads as UNKNOWN.
  out="$("$PS" -NoProfile -NonInteractive -Command "\$ErrorActionPreference = 'Stop'; try { \$t = @(Get-ScheduledTask -TaskName $(psq "instar-ndrive-$AGENT_TAG-*") -ErrorAction Stop) } catch { if (\$_.Exception.Message -match 'No MSFT_ScheduledTask objects found') { \$t = @() } else { 'enum-failed'; exit 0 } }; \$t | Where-Object { \$_.State -ne 'Running' } | ForEach-Object { try { Unregister-ScheduledTask -TaskName \$_.TaskName -Confirm:\$false; 'swept' } catch {} }; 'running=' + @(\$t | Where-Object { \$_.State -eq 'Running' }).Count" </dev/null 2>/dev/null | tr -d '\r')"
  n="$(printf '%s\n' "$out" | grep -c '^swept')"
  SWEPT=$((SWEPT + ${n:-0}))
  RUNNING_TASKS="$(printf '%s\n' "$out" | sed -n 's/^running=\([0-9][0-9]*\)$/\1/p' | tail -1)"
}
# Runs ONCE per wrapper call, on BOTH routes (a direct call from an operator terminal must not start a
# second driver beside an orphaned bridged one either): sweep, then wait for this agent's still-running
# tasks the same way the lock is waited for, then refuse. An enumeration that answers nothing is unknown,
# and unknown refuses (never "no tasks").
# survivor_alive: is the driver an earlier call wrote down (pid + start time) still running? Prints
# alive / gone, or nothing when the probe itself failed. Identity is name + start time; with no start
# time recorded, or none readable now, a live powershell on that pid counts as alive (the safe
# direction, bounded by the wait).
survivor_alive() {
  local pid start at
  read -r pid start at 2>/dev/null < "$CACHE_DIR/survivor" || { echo gone; return 0; }
  case "$pid" in ''|*[!0-9]*) echo gone; return 0;; esac
  case "$start" in *[!0-9]*) start="";; esac   # '-' = no start time recorded
  case "$at" in ''|*[!0-9]*) at=0;; esac
  # A record with no start time can only match by pid, which is recycled: a live powershell on that pid
  # that STARTED AFTER the record was written is a different process (gone); one that started before it is
  # plausibly the driver (alive). Only when its start time cannot be read at all does record age decide
  # (1200 s, the sweep's ceiling): the one remaining age-based assumption, stated in the spec.
  local age=$(( $(date +%s) - at ))
  "$PS" -NoProfile -NonInteractive -Command "\$gp = Get-Process -Id $pid -ErrorAction SilentlyContinue; \$gst = ''; \$newer = \$false; if (\$gp) { try { \$gst = [string]\$gp.StartTime.ToFileTimeUtc(); \$newer = (\$gp.StartTime.ToUniversalTime() -gt [DateTimeOffset]::FromUnixTimeSeconds($at).UtcDateTime.AddSeconds(2)) } catch {} }; if (-not \$gp -or \$gp.ProcessName -ne 'powershell') { 'gone' } elseif ('$start' -ne '') { if (\$gst -eq '' -or \$gst -eq '$start') { 'alive' } else { 'gone' } } elseif (\$gst -eq '') { if ($age -gt 1200) { 'gone' } else { 'alive' } } elseif (\$newer) { 'gone' } else { 'alive' }" </dev/null 2>/dev/null | tr -d '\r' | grep -m1 -E '^(alive|gone)$'
}
# leftovers_present: does anything on disk say an earlier call of this agent was interrupted? A bridged
# call creates its work folder BEFORE registering its task and removes it only at its own end, after the
# task is unregistered; a wrapper killed mid-call leaves that folder behind. So with no folder under the
# bridge root, no survivor record and no lock reclaimed from a dead owner, no bridged task of this agent
# can be running, and the 4 s Get-ScheduledTask enumeration (measured in the second live run) is skipped.
leftovers_present() {
  local d
  [ "$LOCK_RECLAIMED" = 1 ] && return 0
  [ -f "$CACHE_DIR/survivor" ] && return 0
  if [ -n "$BRIDGE_ROOT_U" ] && [ -d "$BRIDGE_ROOT_U" ]; then for d in "$BRIDGE_ROOT_U"/*/; do [ -d "$d" ] && return 0; done; fi
  return 1
}
guard_orphans() {
  local w0 sv
  if ! leftovers_present; then RUNNING_TASKS=0; return 0; fi
  w0="$(date +%s)"   # both waits below are bounded on WALL time (each probe round costs seconds itself)
  sweep_stale
  # The enumeration gets the same one retry as the session probe (the ~2% empty interop answer).
  [ -z "$RUNNING_TASKS" ] && sweep_stale
  while [ -n "$RUNNING_TASKS" ] && [ "$RUNNING_TASKS" -gt 0 ] && [ $(( $(date +%s) - w0 )) -lt "$LOCK_WAIT" ]; do sleep 2; sweep_stale; [ -z "$RUNNING_TASKS" ] && sweep_stale; done
  if [ -f "$CACHE_DIR/survivor" ]; then
    sv="$(survivor_alive)"; [ -z "$sv" ] && sv="$(survivor_alive)"
    while [ "$sv" = alive ] && [ $(( $(date +%s) - w0 )) -lt "$LOCK_WAIT" ]; do sleep 2; sv="$(survivor_alive)"; [ -z "$sv" ] && sv="$(survivor_alive)"; done
    case "$sv" in
      gone) rm -f -- "$CACHE_DIR/survivor" 2>/dev/null ;;
      alive) refuse 2 "ERR busy: the driver of an earlier call of this agent outlived its timeout and is still running (pid $(cut -d' ' -f1 2>/dev/null < "$CACHE_DIR/survivor")); one driver at a time per agent. Waited ${LOCK_WAIT}s (ND_LOCK_WAIT). Check the window (target, shot) before anything else; the record is $CACHE_DIR/survivor." ;;
      *) refuse 1 "ERR state-unavailable: could not check whether the driver of an earlier call is still running (the PowerShell probe answered nothing, twice); refusing rather than start a second one. The record is $CACHE_DIR/survivor." ;;
    esac
  fi
  if [ -z "$RUNNING_TASKS" ]; then
    refuse 1 "ERR state-unavailable: this agent's Windows task list could not be read (Get-ScheduledTask answered nothing usable), so it is unknown whether an earlier bridged driver is still running; refusing rather than start a second one. Check Get-ScheduledTask instar-ndrive-$AGENT_TAG-* from PowerShell."
  fi
  if [ "$RUNNING_TASKS" -gt 0 ]; then
    refuse 2 "ERR busy: an earlier bridged call of this agent is still running on the desktop (${RUNNING_TASKS} task(s) named instar-ndrive-$AGENT_TAG-*; its wrapper is gone but the driver may still be acting); one driver at a time per agent. Waited ${LOCK_WAIT}s (ND_LOCK_WAIT). Check the window (target, shot) before anything else."
  fi
}
guard_orphans

# drive <args...>: run one driver command, direct or through the bridge; the driver's stdout and stderr
# go to this wrapper's stdout and stderr; stdin is passed through (direct) or carried in the stdin file
# (bridge) for the two secret-reading commands only. Returns the driver's exit code.
# The direct route runs the driver under coreutils `timeout` (present in WSL) for the same bound as the
# bridge, so a hung driver cannot hold the per-agent lock forever; where `timeout` is missing the wait is
# unbounded and the skill says so.
TIMEOUT_CMD=""; command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout -k 10 $TIMEOUT"   # TERM at the deadline, KILL 10 s later
WRAPPER_REFUSED=0 # set when drive() itself refused (so a caller never reads that as the driver's verdict)
UNKNOWN_OUTCOME=0 # set when a call ended with the page state unknown (bridge timeout, driver crash)
SURVIVOR_WRITE_FAILED=0
drive() {
  WRAPPER_REFUSED=0; UNKNOWN_OUTCOME=0
  if [ "$USE_BRIDGE" = 0 ]; then
    case "${1:-}" in
      typesecret|typesecretedit) printf '%s\n' "$SECRET_LINE" | $TIMEOUT_CMD "$PS" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" "$@" ;;
      *) $TIMEOUT_CMD "$PS" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT" "$@" </dev/null ;;   # no tty read under timeout's process group (SIGTTIN)
    esac
    local drc=$?
    if [ -n "$TIMEOUT_CMD" ] && [ "$drc" -eq 124 ]; then
      echo "ERR driver-timeout: the driver did not finish within ${TIMEOUT}s on the direct route; its WSL-side process was signalled to end (not re-checked), and whether the Windows driver ended with it is unmeasured (no pid is recorded on this route, so the next call cannot wait for it); the PAGE STATE IS UNKNOWN. Check the window (target, shot) and the page before any retry." >&2
      UNKNOWN_OUTCOME=1; return 1
    fi
    return "$drc"
  fi
  local run_id wdir_w wdir_u a esc arglist envlines v val task brc rc first rc_bad="" sv_start
  # A desktop must exist: an explorer.exe in a session other than 0 means a user is logged on. (A LOCKED
  # desktop is not detected here; the driver's own window checks then refuse or the call times out.)
  # wscript.exe must exist too (it is a removable feature on new Windows builds): without it the task
  # action would fail silently and look like a timeout.
  # Each probe answers 0 (yes) or 3 (no); any other exit is the probe itself failing (the WSL interop
  # hiccup the session probe also sees), which is retried once and then reported as "could not probe",
  # never as the negative fact.
  local prc
  "$PS" -NoProfile -NonInteractive -Command 'if ((Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 }).Count -gt 0) { exit 0 } else { exit 3 }' </dev/null >/dev/null 2>&1; prc=$?
  if [ "$prc" -ne 0 ] && [ "$prc" -ne 3 ]; then "$PS" -NoProfile -NonInteractive -Command 'if ((Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 }).Count -gt 0) { exit 0 } else { exit 3 }' </dev/null >/dev/null 2>&1; prc=$?; fi
  if [ "$prc" -eq 3 ]; then
    echo "ERR no-interactive-session: no user is logged on to the Windows desktop (no explorer.exe outside session 0), so the driver has nothing to act on" >&2
    WRAPPER_REFUSED=1; return 2
  elif [ "$prc" -ne 0 ]; then
    echo "ERR bridge-unavailable: the logon probe could not run (PowerShell exit $prc, twice), so it is unknown whether a desktop is available; nothing was sent" >&2
    WRAPPER_REFUSED=1; return 1
  fi
  "$PS" -NoProfile -NonInteractive -Command 'if (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\wscript.exe")) { exit 0 } else { exit 3 }' </dev/null >/dev/null 2>&1; prc=$?
  if [ "$prc" -ne 0 ] && [ "$prc" -ne 3 ]; then "$PS" -NoProfile -NonInteractive -Command 'if (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\wscript.exe")) { exit 0 } else { exit 3 }' </dev/null >/dev/null 2>&1; prc=$?; fi
  if [ "$prc" -eq 3 ]; then
    echo "ERR bridge-unavailable: wscript.exe is missing on this Windows (the bridge's hidden runner needs it; it is a removable feature on new builds)" >&2
    WRAPPER_REFUSED=1; return 1
  elif [ "$prc" -ne 0 ]; then
    echo "ERR bridge-unavailable: the wscript.exe probe could not run (PowerShell exit $prc, twice); nothing was sent" >&2
    WRAPPER_REFUSED=1; return 1
  fi
  run_id="$(date +%s)-$$-$RANDOM"
  wdir_w="$BRIDGE_ROOT_W\\$run_id"
  wdir_u="$(unixpath "$wdir_w")"
  [ -n "$wdir_u" ] && mkdir -p "$wdir_u" 2>/dev/null
  if [ -z "$wdir_u" ] || [ ! -d "$wdir_u" ]; then
    echo "ERR bridge-unavailable: could not create the bridge work folder $wdir_w from this shell" >&2
    WRAPPER_REFUSED=1; return 1
  fi
  BRIDGE_WDIR_U="$wdir_u"
  # The driver is copied into the work folder (local disk) and run from there, so a bridged call never
  # reads the script over the \\wsl.localhost share (a per-call cost and a live dependency on WSL
  # interop, seen as a transient failure in the live run). The copy is byte-identical to the installed
  # file; a caller's ND_SCRIPT (a Windows path) is used as given.
  local script_w="$SCRIPT"
  if [ -z "${ND_SCRIPT:-}" ]; then
    if cp "$HERE/native-drive.ps1" "$wdir_u/native-drive.ps1" 2>/dev/null; then script_w="$wdir_w\\native-drive.ps1"
    else
      echo "ERR bridge-unavailable: could not place a local copy of native-drive.ps1 in the bridge work folder $wdir_w (the bridge never runs the driver over the \\\\wsl.localhost share)" >&2
      WRAPPER_REFUSED=1; return 1
    fi
  fi
  # stdin: a file is always present (the runner redirects from it); it carries exactly one line for the
  # two secret-reading commands (the driver reads one line; a final line with no newline is kept) and is
  # empty otherwise.
  case "${1:-}" in
    typesecret|typesecretedit) printf '%s\r\n' "$SECRET_LINE" > "$wdir_u/stdin.txt" ;; # read and checked non-empty at the top
    *) : > "$wdir_u/stdin.txt" ;;
  esac
  # The driver's argument list for Start-Process (PS 5.1 does not quote: each value is wrapped in double
  # quotes by the MSVCRT rules: a backslash run before a quote is doubled and the quote escaped; a
  # trailing backslash run is doubled so it cannot escape the closing quote and merge with the next
  # argument; the values that reach chrome.exe were refused above if they carried a quote at all).
  arglist="'-NoProfile','-ExecutionPolicy','Bypass','-File',$(psq "\"$script_w\"")"
  for a in "$@"; do esc="$(printf '%s' "$a" | sed -e 's/\(\\*\)"/\1\1\\"/g' -e 's/\(\\*\)$/\1\1/')"; arglist="$arglist,$(psq "\"$esc\"")"; done
  envlines=""
  for v in ND_STATE_FILE ND_CHROME_FLAGS ND_ALLOW_FOCUS_STEAL ND_OPERATOR_IDLE_MS ND_USER_DATA_DIR; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && envlines="$envlines\$env:$v = $(psq "$val")
"
  done
  # The runner records the driver's pid first (so a timeout can end THAT process, never Chrome), then
  # waits for it and records its exit code.
  cat > "$wdir_u/runner.ps1" <<EOF
\$ErrorActionPreference = 'Stop'
$envlines
Set-Content -LiteralPath $(psq "$wdir_w\\launching.txt") -Value 1 -Encoding ASCII
\$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @($arglist) -WindowStyle Hidden -PassThru -RedirectStandardInput $(psq "$wdir_w\\stdin.txt") -RedirectStandardOutput $(psq "$wdir_w\\out.txt") -RedirectStandardError $(psq "$wdir_w\\err.txt")
\$null = \$p.Handle
# A pid record that fails (disk full, a DrvFs hiccup) would leave a running driver the poll reports as
# "never started": end it right here instead, so that report is true by construction.
trap { try { Stop-Process -Id \$p.Id -Force -ErrorAction SilentlyContinue } catch {}; throw }
# ^ PowerShell 5.1: a -PassThru process object without a cached handle reads ExitCode as null once the
# process has exited (the second live run measured rc.txt at 0 bytes on every bridged call); touching
# Handle keeps it open so ExitCode survives WaitForExit.
Set-Content -LiteralPath $(psq "$wdir_w\\pid.txt") -Value \$p.Id -Encoding ASCII
try { Set-Content -LiteralPath $(psq "$wdir_w\\pidstart.txt") -Value ([string]\$p.StartTime.ToFileTimeUtc()) -Encoding ASCII } catch {}
\$p.WaitForExit()
Set-Content -LiteralPath $(psq "$wdir_w\\rc.txt") -Value \$p.ExitCode -Encoding ASCII
EOF
  cat > "$wdir_u/run.vbs" <<EOF
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$wdir_w\\runner.ps1""", 0, True
EOF
  task="instar-ndrive-$AGENT_TAG-$run_id"
  "$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "
\$ErrorActionPreference = 'Stop'
\$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
\$pr = New-ScheduledTaskPrincipal -UserId \$me -LogonType Interactive -RunLevel Limited
\$act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $(psq "//B //Nologo \"$wdir_w\\run.vbs\"")
\$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds $((TIMEOUT + 60)))
Register-ScheduledTask -TaskName $(psq "$task") -Action \$act -Principal \$pr -Settings \$set -Force | Out-Null
try {
  Start-ScheduledTask -TaskName $(psq "$task")
  \$deadline = (Get-Date).AddSeconds($TIMEOUT)
  \$started = Get-Date
  while (-not (Test-Path -LiteralPath $(psq "$wdir_w\\rc.txt")) -and (Get-Date) -lt \$deadline) {
    Start-Sleep -Milliseconds 250
    # A task that has already ENDED without the runner recording a pid never started the driver: stop
    # waiting (a runner failure is reported as such, not as a full timeout). Checked after a 3 s grace so
    # a task still being started is not misread.
    if (((Get-Date) - \$started).TotalSeconds -gt 3 -and -not (Test-Path -LiteralPath $(psq "$wdir_w\\pid.txt"))) {
      \$ts = Get-ScheduledTask -TaskName $(psq "$task") -ErrorAction SilentlyContinue
      if (\$ts -and \$ts.State -ne 'Running') { 'runner-ended-no-driver'; break }
    }
  }
} finally {
  if (-not (Test-Path -LiteralPath $(psq "$wdir_w\\rc.txt"))) {
    if (Test-Path -LiteralPath $(psq "$wdir_w\\pid.txt")) {
      try {
        \$dpid = [int](Get-Content -LiteralPath $(psq "$wdir_w\\pid.txt") -Raw).Trim()
        \$gp = Get-Process -Id \$dpid -ErrorAction SilentlyContinue
        \$st = ''; if (Test-Path -LiteralPath $(psq "$wdir_w\\pidstart.txt")) { \$st = (Get-Content -LiteralPath $(psq "$wdir_w\\pidstart.txt") -Raw).Trim() }
        \$gst = ''; if (\$gp) { try { \$gst = [string]\$gp.StartTime.ToFileTimeUtc() } catch {} }
        \$v = if (-not \$gp) { 'driver-gone' }
        elseif (\$gp.ProcessName -ne 'powershell') { 'driver-not-identified' }
        elseif (\$st -eq '' -or \$gst -eq '') { 'driver-unverified-live' }
        elseif (\$gst -ne \$st) { 'driver-not-identified' }
        else {
          Stop-Process -Id \$dpid -Force -ErrorAction SilentlyContinue
          Start-Sleep -Milliseconds 300
          if (Get-Process -Id \$dpid -ErrorAction SilentlyContinue) { 'driver-still-running' } else { 'driver-stopped' }
        }
        \$v
        # The verdict also lands in the work folder: if the bash wrapper was killed while this poll ran, the
        # next call's sweep adopts a possibly-live driver into the survivor record from here.
        try { Set-Content -LiteralPath $(psq "$wdir_w\\verdict.txt") -Value \$v -Encoding ASCII } catch {}
      } catch {}
    }
    try { Stop-ScheduledTask -TaskName $(psq "$task") -ErrorAction SilentlyContinue } catch {}
  }
  Unregister-ScheduledTask -TaskName $(psq "$task") -Confirm:\$false
}
" </dev/null >"$wdir_u/bridge.out" 2>"$wdir_u/bridge.err"
  brc=$?
  if [ ! -f "$wdir_u/rc.txt" ]; then
    local elapsed=$(( $(date +%s) - ${run_id%%-*} ))
    first="$(tr -d '\r' 2>/dev/null < "$wdir_u/bridge.err" | grep -v '^\s*$' | head -1)"
    if [ "$brc" -ne 0 ] && [ ! -f "$wdir_u/pid.txt" ]; then
      echo "ERR bridge-unavailable: the interactive-session task could not be registered or started (exit $brc after ${elapsed}s)${first:+: $first}" >&2
      return 1   # nothing was sent: no latch
    elif grep -q runner-ended-no-driver "$wdir_u/bridge.out" 2>/dev/null && [ ! -f "$wdir_u/launching.txt" ]; then
      echo "ERR bridge-unavailable: the interactive-session task ended after ${elapsed}s before the runner reached the driver launch (nothing was sent)${first:+: $first}" >&2
      return 1   # nothing was sent: no latch
    elif grep -q runner-ended-no-driver "$wdir_u/bridge.out" 2>/dev/null; then
      echo "ERR bridge-timeout: the runner recorded that it was launching the driver and then ended after ${elapsed}s without recording its pid (its own trap ends the driver in that case, but that is not proven here); a driver may have run; OUTCOME UNKNOWN${first:+: $first}. Check the window (target, shot) and the page before any retry." >&2
      UNKNOWN_OUTCOME=1
      return 1
    elif grep -q driver-not-identified "$wdir_u/bridge.out" 2>/dev/null; then
      echo "ERR bridge-timeout: the driver did not report within ${TIMEOUT}s (${elapsed}s elapsed); the recorded pid could not be confirmed as the driver (its name or start time differs from the record: a reused pid), so NOTHING was ended; OUTCOME UNKNOWN. Check the window (target, shot) and the page before any retry." >&2
    elif grep -q driver-unverified-live "$wdir_u/bridge.out" 2>/dev/null; then
      echo "ERR bridge-timeout: the driver did not report within ${TIMEOUT}s (${elapsed}s elapsed); a PowerShell process holds the recorded pid but its start time could not be compared with the record, so it was NOT ended and may still be acting; OUTCOME UNKNOWN. Check the window (target, shot) and the page before any retry." >&2
    elif grep -q driver-gone "$wdir_u/bridge.out" 2>/dev/null; then
      echo "ERR bridge-timeout: the driver did not report within ${TIMEOUT}s (${elapsed}s elapsed) and its process had already ended without an exit code (the runner may have been ended by the task's own limit); the PAGE STATE IS UNKNOWN (an input may have landed). Check the window (target, shot) and the page before any retry." >&2
    elif grep -q driver-stopped "$wdir_u/bridge.out" 2>/dev/null; then
      echo "ERR bridge-timeout: the driver did not report within ${TIMEOUT}s (${elapsed}s elapsed) and its process was ended (confirmed gone); the PAGE STATE IS UNKNOWN (an input may have landed). Check the window (target, shot) and the page before any retry." >&2
    elif grep -q driver-still-running "$wdir_u/bridge.out" 2>/dev/null; then
      echo "ERR bridge-timeout: the driver did not report within ${TIMEOUT}s (${elapsed}s elapsed) and could NOT be confirmed ended; it may still be acting. Do not send input until target/shot show the window quiet." >&2
    elif [ -f "$wdir_u/pid.txt" ]; then
      echo "ERR bridge-timeout: the driver did not report within ${TIMEOUT}s (${elapsed}s elapsed); its pid was recorded but its state could NOT be checked (exit $brc), so nothing was ended and it may still be acting; OUTCOME UNKNOWN. Check the window (target, shot) and the page before any retry." >&2
    else
      echo "ERR bridge-timeout: the interactive-session task did not report within ${TIMEOUT}s (${elapsed}s elapsed, exit $brc) and no driver process was recorded; OUTCOME UNKNOWN. Check the window (target, shot) and the page before any retry." >&2
    fi
    [ -n "$first" ] && [ -f "$wdir_u/pid.txt" ] && echo "$first" >&2
    # A driver that may still be running (not confirmed ended, or recorded but unchecked) is written down
    # (pid + start time) so the next call's orphan guard can wait for it; the running-task count alone
    # would not see it once its task is stopped.
    if [ -f "$wdir_u/pid.txt" ] && ! grep -qE 'driver-(stopped|gone|not-identified)' "$wdir_u/bridge.out" 2>/dev/null; then
      sv_start="$(tr -d '\r\n ' 2>/dev/null < "$wdir_u/pidstart.txt")"
      if ! printf '%s %s %s\n' "$(tr -d '\r\n ' < "$wdir_u/pid.txt")" "${sv_start:--}" "$(date +%s)" > "$CACHE_DIR/survivor" 2>/dev/null; then
        echo "warning: could not write the survivor record $CACHE_DIR/survivor; the bridge work folder is kept as the marker instead" >&2; SURVIVOR_WRITE_FAILED=1
      fi
    fi
    UNKNOWN_OUTCOME=1
    return 1
  fi
  [ -f "$wdir_u/out.txt" ] && tr -d '\r' < "$wdir_u/out.txt"
  [ -s "$wdir_u/err.txt" ] && tr -d '\r' < "$wdir_u/err.txt" >&2
  # The driver's exit code is relayed as-is only when it is a real 0-255 code; a negative code (a crash)
  # or anything else is reported as a crash and relayed as 1, never folded modulo 256 into a success.
  rc="$(tr -d '\r\n ' < "$wdir_u/rc.txt")"
  case "$rc" in ''|*[!0-9]*) rc_bad=1 ;; *) [ "$rc" -gt 255 ] && rc_bad=1 ;; esac
  if [ -n "$rc_bad" ]; then
    echo "ERR driver-crash: the driver exited with code '${rc:-none}' (not a 0-255 exit code: a crash or an aborted process); relayed as 1. The PAGE STATE IS UNKNOWN; check the window (target, shot) before any retry." >&2
    UNKNOWN_OUTCOME=1
    return 1
  fi
  return "$rc"
}
# The per-run folder is removed after every drive() (including the canfocus pre-check below).
drive_once() {
  local rc keep=0; drive "$@"; rc=$?
  # Every driver call, pre-check or main, that ended with the page state unknown sets the latch here. A
  # latch (or survivor) write that FAILS must not take the recovery evidence with it: the work folder then
  # stays as the leftover marker the orphan guard keys on, and the failure is said out loud.
  if [ "$UNKNOWN_OUTCOME" = 1 ]; then
    if ! printf '%s %s' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$1" > "$LATCH" 2>/dev/null; then
      echo "warning: could not write the unknown-outcome latch $LATCH; the bridge work folder is kept as the marker instead. Read the page before any input." >&2; keep=1
    fi
    [ "$SURVIVOR_WRITE_FAILED" = 1 ] && keep=1
    UNKNOWN_OUTCOME=0; SURVIVOR_WRITE_FAILED=0
  fi
  if [ -n "$BRIDGE_WDIR_U" ] && [ -d "$BRIDGE_WDIR_U" ]; then
    [ -f "$BRIDGE_WDIR_U/stdin.txt" ] && : > "$BRIDGE_WDIR_U/stdin.txt"
    [ "$keep" = 1 ] || rm -rf -- "$BRIDGE_WDIR_U" 2>/dev/null
  fi
  BRIDGE_WDIR_U=""
  return "$rc"
}

# Unknown-outcome latch (P14: a timeout is never retried blind). After a call ends with the page state
# unknown, a per-agent latch file refuses every input-sending command until a read-only command has run
# and succeeded: the agent must LOOK (target, shot, url, text, tree, find, editfields) before it acts again.
# Checked before the invoke pre-check so a latched invoke costs no bridged round trip.
case "$CMDNAME" in
  click|clickxy|invoke|typeedit|typesecretedit|type|typesecret|key|ctrl|nav|clearfield) INPUT_CMD=1 ;;
  *) INPUT_CMD=0 ;;
esac
case "$CMDNAME" in target|shot|url|text|tree|find|editfields) READ_CMD=1 ;; *) READ_CMD=0 ;; esac  # canfocus observes idle time, not the page
if [ "$INPUT_CMD" = 1 ] && [ -e "$LATCH" ]; then
  refuse 2 "ERR unknown-outcome-unchecked: the previous call of this agent ended with the page state unknown ($(cat "$LATCH" 2>/dev/null)); run a read-only command first (target, shot, url, text) to see what landed, then act. Input NOT sent."
fi

# `invoke` activates a control through the accessibility tree with no OS input and so sits outside the
# driver's foreground gate and operator-active rule, yet it can open a window (a sign-in popup). The
# wrapper asks the driver's read-only `canfocus` first and refuses when the operator is active; a bridge
# failure during that check is reported as what it is, not as "operator active".
if [ "$CMDNAME" = invoke ]; then
  CF_ERR="$(mktemp 2>/dev/null || echo "$CACHE_DIR/canfocus.err")"
  drive_once canfocus >/dev/null 2>"$CF_ERR"; CF_RC=$?
  if [ "$CF_RC" -eq 2 ] && [ "$WRAPPER_REFUSED" = 0 ]; then
    rm -f -- "$CF_ERR"; refuse 2 "refused: operator active or no target in front (canfocus said no); invoke may open a window, so it waits (input NOT sent)"
  elif [ "$CF_RC" -ne 0 ]; then
    cat "$CF_ERR" >&2; rm -f -- "$CF_ERR"; refuse "$CF_RC" "ERR canfocus-failed: the read-only canfocus check before invoke did not run (exit $CF_RC, see above); invoke NOT sent"
  fi
  rm -f -- "$CF_ERR"
fi

# Expected-host check: with ND_EXPECT_HOST set, every input-sending command (nav excepted: it is how the
# page is changed) first reads the driver's `url` and refuses unless the omnibox host matches at a host
# boundary (equal, or followed by `/`): `accounts.example.com.attacker.test/` never matches
# `accounts.example.com`. One extra round trip per command; a URL is still not a page, so the skill's
# text/find check before a click stays.
if [ -n "$EXPECT_HOST" ] && [ "$INPUT_CMD" = 1 ] && [ "$CMDNAME" != nav ]; then
  U_TMP="$(mktemp 2>/dev/null || echo "$CACHE_DIR/url.out")"; U_ERR="$(mktemp 2>/dev/null || echo "$CACHE_DIR/url.err")"
  drive_once url </dev/null >"$U_TMP" 2>"$U_ERR"; U_RC=$?
  if [ "$U_RC" -ne 0 ]; then
    # The pre-read itself failed (a bridge error, no target, a timeout): relayed as what it is, never as a
    # host mismatch, the same rule the canfocus pre-check follows.
    cat "$U_ERR" >&2; rm -f -- "$U_TMP" "$U_ERR"
    refuse "$U_RC" "ERR expected-host-unreadable: the url pre-read before $CMDNAME did not succeed (exit $U_RC, see above), so the page's host is unknown; input NOT sent"
  fi
  CUR_URL="$(head -1 "$U_TMP" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')"; rm -f -- "$U_TMP" "$U_ERR"
  CUR_URL="${CUR_URL#https://}"; CUR_URL="${CUR_URL#http://}"
  # Chrome hides a leading www. in the elided display and shows the full URL while the omnibox has
  # focus: www. is dropped on both sides, so the same page matches in either state and an expectation
  # written with www. still works.
  CUR_URL="${CUR_URL#www.}"; EXPECT_CMP="${EXPECT_HOST#www.}"
  case "$CUR_URL" in
    "$EXPECT_CMP"|"$EXPECT_CMP"/*) ;;
    *) refuse 2 "ERR expected-host-mismatch: the page is not on ${EXPECT_HOST} (the omnibox shows a different host); input NOT sent. Read url and text, then decide." ;;
  esac
fi

# `url` right after a sign-in redirect would print the code/token into the transcript: the value of a
# credential-shaped query or fragment parameter is redacted in the wrapper's output (the same key list
# as the url rule; a bounded heuristic, stated in the skill).
redact_url() {
  # Literal names are redacted in place; when the DECODED text carries a credential-shaped name the literal
  # pass could not see (a percent-encoded name), every parameter value is redacted instead.
  local line dec
  while IFS= read -r line || [ -n "$line" ]; do
    dec="$(printf '%b' "$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/%\([0-9a-fA-F][0-9a-fA-F]\)/\\x\1/g')" 2>/dev/null | tr 'A-Z' 'a-z')"
    case "$dec" in
      *[\?\&\#\;]code=*|*[\?\&\#\;]token=*|*[\?\&\#\;]access_token=*|*[\?\&\#\;]id_token=*|*[\?\&\#\;]refresh_token=*|*[\?\&\#\;]oobcode=*|*[\?\&\#\;]api_key=*|*[\?\&\#\;]apikey=*|*[\?\&\#\;]key=*|*[\?\&\#\;]secret=*|*[\?\&\#\;]password=*|*[\?\&\#\;]otp=*|*[\?\&\#\;]auth=*|*[\?\&\#\;]sig=*|*[\?\&\#\;]signature=*|*[\?\&\#\;]ticket=*|*[\?\&\#\;]assertion=*|*[\?\&\#\;]session=*)
        if printf '%s' "$line" | grep -qiE '[?&#;](code|token|access_token|id_token|refresh_token|oobcode|api_key|apikey|key|secret|password|otp|auth|sig|signature|ticket|assertion|session)='; then
          printf '%s\n' "$line" | sed -E 's/([?&#;](code|token|access_token|id_token|refresh_token|oobcode|api_key|apikey|key|secret|password|otp|auth|sig|signature|ticket|assertion|session)=)[^&#;[:space:]]*/\1<redacted>/Ig'
        else
          printf '%s\n' "$line" | sed -E 's/([?&#;][^=&#;[:space:]]*=)[^&#;[:space:]]*/\1<redacted>/g'
        fi ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}
if [ "$CMDNAME" = url ]; then
  U_OUT="$(mktemp 2>/dev/null || echo "$CACHE_DIR/url.main")"
  drive_once "$@" >"$U_OUT"; RC=$?
  redact_url < "$U_OUT"; rm -f -- "$U_OUT"
else
  drive_once "$@"
  RC=$?
fi
if [ "$READ_CMD" = 1 ] && [ "$RC" -eq 0 ] && [ -e "$LATCH" ]; then rm -f -- "$LATCH" 2>/dev/null; fi
logline "$CMDNAME" "$RC"
exit "$RC"
