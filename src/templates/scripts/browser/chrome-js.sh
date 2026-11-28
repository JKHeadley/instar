#!/bin/bash
# chrome-js.sh — run JavaScript in the active tab of one profile's normal Chrome; prints the result.
# Usage: chrome-js.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]
# After reviewing a flagged page: append --reviewed-page <fingerprint> --review-reason <nonsecret-reason>
# Read-only: chrome-js.sh <profile> --read-page <expected-origin> [offset]
# With expected-origin (e.g. https://claude.ai) the code runs only if the active tab is on that
# origin; otherwise it prints ERR wrong-origin and exits 3, so a click never lands on the wrong page.
# Targets the Chrome process by PID (a pid-addressed Apple Event), so several profiles can be
# open at once and the operator's own default Chrome is never touched. Runs in Chrome's
# isolated world: it sees the DOM, not the page's own JS objects (use chrome-mainworld.sh).
# macOS only (Apple Events). Installed by instar into .instar/scripts/browser/.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s). On Linux use xdrive.sh in this same folder." >&2
  exit 2
fi
[ -z "$1" ] || [ -z "$2" ] && { echo "usage: chrome-js.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]" >&2; exit 64; }
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
# The browser main process: the Chrome binary with exactly this --user-data-dir and no --type= (helpers carry one).
# The key goes through the environment, not awk -v, so awk never matches its own argv.
PID=$(ps -axo pid=,args= | K="--user-data-dir=$P" awk '/MacOS\/Google Chrome / && index($0" ", ENVIRON["K"]" ") && !/--type=/ { print $1; exit }')
[ -z "$PID" ] && { echo "NO_PID"; exit 1; }
send() {
JS="$1" PID=$PID NONCE="$NONCE" osascript -l JavaScript <<'OSA'
ObjC.import('Foundation');
var env=$.NSProcessInfo.processInfo.environment;
var pid=parseInt(ObjC.unwrap(env.objectForKey('PID')));
var js=ObjC.unwrap(env.objectForKey('JS'));
var target=$.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
function fc(s){var b=s.split('').map(c=>c.charCodeAt(0));return (b[0]<<24)|(b[1]<<16)|(b[2]<<8)|b[3];}
// object specifier: active tab of window 1
function spec(cls,from,form,data){var r=$.NSAppleEventDescriptor.recordDescriptor.coerceToDescriptorType(fc('obj '));
 r.setDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithTypeCode(fc(cls)),fc('want'));
 r.setDescriptorForKeyword(from,fc('from'));
 r.setDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithEnumCode(fc(form)),fc('form'));
 r.setDescriptorForKeyword(data,fc('seld'));return r;}
var w=spec('cwin',$.NSAppleEventDescriptor.nullDescriptor,'indx',$.NSAppleEventDescriptor.descriptorWithInt32(1));
var t=spec('prop',w,'prop',$.NSAppleEventDescriptor.descriptorWithTypeCode(fc('acTa')));
// Chrome's "execute javascript": class CrSu, id ExJa; the script goes in keyword JvSc (a wrong keyword "succeeds" and returns nil).
var ev=$.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(fc('CrSu'),fc('ExJa'),target,-1,0);
ev.setParamDescriptorForKeyword(t,fc('----'));
ev.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(js),fc('JvSc'));
// $() not Ref(): reading a Ref() out-parameter after a failed send crashes osascript (SIGSEGV in
// JSOCRefPrototypeCreate, reproduced 2026-11-26); a $() NSError holder is safe and carries the code.
var err=$();
var res=ev.sendEventWithOptionsTimeoutError(0x3,30,err);
// The failure carries an OSStatus; name it, so "why" is not a guess (2026-11-26: a bare
// apple-event-failed on two machines could not be told apart from a permission refusal).
function why(e){var c=(e&&!e.isNil())?Number(e.code):NaN;
 var m={'-1743':'not-permitted: macOS Automation permission for this caller is refused (System Settings > Privacy > Automation)',
  '-1712':'timeout: the tab did not answer within 30s (busy or hung page, or a dialog is open)',
  '-1728':'no-such-tab: Chrome has no window 1 or no active tab',
  '-600':'process-gone: that Chrome process is no longer running',
  '-609':'connection-invalid: that Chrome process quit or crashed during the call',
  '-1708':'not-understood: Chrome refused execute javascript (Apple Events JS is off in this profile)'};
 return isNaN(c)?'unknown':('code '+c+' '+(m[String(c)]||'unmapped'));}
if(res.isNil()){ 'ERR apple-event-failed '+why(err)+' (tab hung, window closed, or Apple Events JS off)' } else { var d=res.paramDescriptorForKeyword(fc('----')); d.isNil()?'(nil)':ObjC.unwrap(d.stringValue) }
OSA
}
# Exit codes: 0 ok, 1 NO_PID / ERR, 2 not macOS, 3 wrong origin, 64 bad input.
# The code is evaluated inside an envelope tagged with a per-call nonce. The envelope runs in
# Chrome's isolated world, so page script can neither read the nonce nor forge a status: a page
# value that happens to start with "ERR" is just a value. Anything not carrying the nonce (nil,
# an Apple Event failure) is reported as an ERR by this script itself.
NONCE="nc$(/usr/bin/python3 -I -c 'import secrets; print(secrets.token_hex(8))')" || { echo "ERR wrap-failed" >&2; exit 1; }
REVIEW_PAGE=""
REVIEW_REASON=""
if [ "$2" != "--read-page" ] && [ -n "${4:-}" ]; then
  [ "$4" = "--reviewed-page" ] && [ "${6:-}" = "--review-reason" ] && [ -n "${5:-}" ] && [ -n "${7:-}" ] && [ "$#" -eq 7 ] \
    || { echo "ERR review-arguments: append --reviewed-page <fingerprint> --review-reason <nonsecret-reason>" >&2; exit 64; }
  REVIEW_PAGE="$5"
  REVIEW_REASON="$7"
fi
WRAPPED="$(NONCE="$NONCE" EXP="$3" CODE="$2" OFFSET="${4:-0}" SAFETY="$(dirname "$0")/account-page-safety.js" REVIEW_PAGE="$REVIEW_PAGE" REVIEW_REASON="$REVIEW_REASON" /usr/bin/python3 -I -c '
import json, os
n, exp, code = os.environ["NONCE"], os.environ["EXP"], os.environ["CODE"]
safety = open(os.environ["SAFETY"]).read()
read_only = code == "--read-page"
if read_only:
    if not exp: raise ValueError("--read-page requires expected-origin")
    offset = int(os.environ["OFFSET"])
    body = "(" + safety + ")(true," + str(offset) + ")"
else:
    preflight = "(" + safety + ")(false,0," + json.dumps(os.environ["REVIEW_PAGE"]) + "," + json.dumps(os.environ["REVIEW_REASON"]) + ")"
    body = "(function(){var signal=" + preflight + ";if(signal)return JSON.stringify(signal);return eval(" + json.dumps(code) + ")})()"
    if os.environ["REVIEW_PAGE"]:
        import hashlib, sys
        # Content-free review evidence: the reasoning remains in the invocation transcript.
        print(json.dumps({"accountActionReviewSubmitted": {"pageFingerprint": os.environ["REVIEW_PAGE"], "reasonSha256": hashlib.sha256(os.environ["REVIEW_REASON"].encode()).hexdigest()}}), file=sys.stderr)
run = "(function(){try{return " + json.dumps(n + "ok:") + "+String(" + body + ")}catch(e){return " + json.dumps(n + "err:") + "+e}})()"
if exp:
    # One evaluation: the origin is checked in the same task that runs the code, so a navigation
    # cannot land between the check and the action.
    run = "(location.origin===" + json.dumps(exp) + ") ? " + run + " : " + json.dumps(n + "wrong-origin:") + "+location.origin"
print(run)
')" || { echo "ERR wrap-failed" >&2; exit 1; }
# Best-effort activity line, written just before each call is sent to Chrome (no page content, no result): when,
# which profile (relative to the agent home), which expected origin, which script, and a hash of
# the CALLER's code (chrome-mainworld.sh passes the hash of its caller's code, not of its wrapper),
# so the operator can match a logged line to the code that ran. A failed write warns on stderr.
LOG="$AGENT_HOME/.instar/logs/normal-chrome-browser.jsonl"
{ mkdir -p "$(dirname "$LOG")" && HOMEDIR="$AGENT_HOME" PROFILE="$P" EXP="$3" CODE="$2" /usr/bin/python3 -I -c '
import hashlib, json, os, time
code = os.environ["CODE"].encode()
print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
  "profile": os.path.relpath(os.environ["PROFILE"], os.environ["HOMEDIR"]),
  "origin": os.environ["EXP"] or None,
  "script": os.environ.get("NC_CALLER_SCRIPT") or "chrome-js.sh",
  "codeSha256": os.environ.get("NC_CALLER_CODE_SHA256") or hashlib.sha256(code).hexdigest(),
  "codeBytes": int(os.environ.get("NC_CALLER_CODE_BYTES") or len(code))}))' >> "$LOG"; } 2>/dev/null \
  || echo "warning: could not write the audit line to $LOG" >&2
# The screen's state, in plain words, from GET /machine-maintenance/lock-state (empty when unreadable).
# "unknown" stays unknown: with the lock flag set it is reported as "locked or asleep, not confirmed".
lock_note() {
  local cfg="$AGENT_HOME/.instar/config.json" port auth body
  port="$(/usr/bin/python3 -I -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("port",4040)))' "$cfg" 2>/dev/null)" || return 0
  auth="${INSTAR_AUTH_TOKEN:-}"
  # Bounded: a waiting secret store must not stall the error return (3s; the curl below has its own 5s limit).
  [ -z "$auth" ] && [ -x "$AGENT_HOME/.instar/bin/node" ] && auth="$(/usr/bin/perl -e 'alarm 3; exec @ARGV' "$AGENT_HOME/.instar/bin/node" "$AGENT_HOME/.instar/scripts/secret-get.mjs" authToken 2>/dev/null)"
  [ -z "$auth" ] && return 0
  # The header goes in on stdin (-K -), never in curl's argv, so the token is not in the process list.
  body="$(printf 'header = "Authorization: Bearer %s"\n' "$auth" | curl -s -m 5 -K - "http://127.0.0.1:$port/machine-maintenance/lock-state" 2>/dev/null)" || return 0
  printf '%s' "$body" | /usr/bin/python3 -I -c '
import json, sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
s, i = d.get("lockState"), d.get("inputs") or {}
if s == "locked": print("; console locked: Chrome does not answer while the screen is locked", end="")
elif s == "screensaver-or-display-sleep": print("; display asleep or screensaver on: Chrome may not answer until the screen wakes", end="")
elif s == "unknown" and i.get("flagLocked"): print("; console locked or display asleep (lock flag set, not confirmed): Chrome may not answer until the screen is awake and unlocked", end="")
' 2>/dev/null
}
OUT="$(send "$WRAPPED")"
# Keep the browser ledger current: this browser is in use (renews its lease). Never fails the call.
"$(dirname "$0")/chrome-ledger.sh" touch "$P" 2>/dev/null
case "$OUT" in
  "${NONCE}ok:"*) printf '%s\n' "${OUT#"${NONCE}ok:"}"; exit 0 ;;
  "${NONCE}err:"*) echo "ERR page-js-error: ${OUT#"${NONCE}err:"}"; exit 1 ;;
  "${NONCE}wrong-origin:"*) echo "ERR wrong-origin: active tab is on ${OUT#"${NONCE}wrong-origin:"}, expected $3"; exit 3 ;;
  "(nil)") echo "ERR no-result (Apple Events JavaScript is off in this profile: quit it and relaunch with chrome-launch.sh)"; exit 1 ;;
  "ERR apple-event-failed"*)
    # Chrome stops answering Apple Events while the console is locked or the display asleep
    # (2026-11-26, Studio and Mini: -1712 even for the app name). Say so when the agent's own
    # lock reading shows it, so an automatic repair does not fail with an unexplained error.
    # Best effort and bounded: no reading, no extra words.
    echo "$OUT$(lock_note)"; exit 1 ;;
  *) echo "$OUT"; exit 1 ;;
esac
