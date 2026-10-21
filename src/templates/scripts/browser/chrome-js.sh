#!/bin/bash
# chrome-js.sh — run JavaScript in the active tab of one profile's normal Chrome; prints the result.
# Usage: chrome-js.sh <profile-id|/absolute/user-data-dir> '<js>' [expected-origin]
# With expected-origin (e.g. https://claude.ai) the code runs only if the active tab is on that
# origin; otherwise it prints ERR wrong-origin and exits 3, so a click never lands on the wrong page.
# Targets the Chrome process by PID (a pid-addressed Apple Event), so several profiles can be
# open at once and the operator's own default Chrome is never touched. Runs in Chrome's
# isolated world: it sees the DOM, not the page's own JS objects (use chrome-mainworld.sh).
# macOS only (Apple Events). Installed by instar into .instar/scripts/browser/.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s)" >&2
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
var err=Ref();
var res=ev.sendEventWithOptionsTimeoutError(0x3,30,err);
if(res.isNil()){ 'ERR apple-event-failed (tab hung, window closed, or Apple Events JS off)' } else { var d=res.paramDescriptorForKeyword(fc('----')); d.isNil()?'(nil)':ObjC.unwrap(d.stringValue) }
OSA
}
# Exit codes: 0 ok, 1 NO_PID / ERR, 2 not macOS, 3 wrong origin, 64 bad input.
# The code is evaluated inside an envelope tagged with a per-call nonce. The envelope runs in
# Chrome's isolated world, so page script can neither read the nonce nor forge a status: a page
# value that happens to start with "ERR" is just a value. Anything not carrying the nonce (nil,
# an Apple Event failure) is reported as an ERR by this script itself.
NONCE="nc$(/usr/bin/python3 -I -c 'import secrets; print(secrets.token_hex(8))')" || { echo "ERR wrap-failed" >&2; exit 1; }
WRAPPED="$(NONCE="$NONCE" EXP="$3" CODE="$2" /usr/bin/python3 -I -c '
import json, os
n, exp, code = os.environ["NONCE"], os.environ["EXP"], os.environ["CODE"]
run = "(function(){try{return " + json.dumps(n + "ok:") + "+String(eval(" + json.dumps(code) + "))}catch(e){return " + json.dumps(n + "err:") + "+e}})()"
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
OUT="$(send "$WRAPPED")"
case "$OUT" in
  "${NONCE}ok:"*) printf '%s\n' "${OUT#"${NONCE}ok:"}"; exit 0 ;;
  "${NONCE}err:"*) echo "ERR page-js-error: ${OUT#"${NONCE}err:"}"; exit 1 ;;
  "${NONCE}wrong-origin:"*) echo "ERR wrong-origin: active tab is on ${OUT#"${NONCE}wrong-origin:"}, expected $3"; exit 3 ;;
  "(nil)") echo "ERR no-result (Apple Events JavaScript is off in this profile: quit it and relaunch with chrome-launch.sh)"; exit 1 ;;
  *) echo "$OUT"; exit 1 ;;
esac
