#!/bin/bash
# chrome-unsaved.sh — read, for every tab of one profile's normal Chrome, whether it holds input a
# person or the agent typed and has not sent (machine self-maintenance, Part B).
# Usage: chrome-unsaved.sh <profile-id|/absolute/user-data-dir>
# Prints one line per tab, `tab <window>.<tab> yes|no|unreadable`, then `done`. Never prints a value.
# yes: an input or textarea whose value differs from its default, a checkbox, radio or select
# differing from its default, a chosen file, or a contenteditable element with any text (it has no
# default to compare with, so any text counts). unreadable: the tab did not answer in 5 seconds,
# the focus is inside a frame, or the page could not be read. Read-only: takes no focus, changes
# nothing on the page, runs in Chrome's isolated world. Used before any close; uncertainty keeps.
# macOS only (Apple Events). Installed by instar into .instar/scripts/browser/.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on $(uname -s)" >&2
  exit 2
fi
[ -z "$1" ] && { echo "usage: chrome-unsaved.sh <profile-id|/absolute/user-data-dir>" >&2; exit 64; }
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
PID=$(ps -axo pid=,args= | K="--user-data-dir=$P" awk '/MacOS\/Google Chrome / && index($0" ", ENVIRON["K"]" ") && !/--type=/ { print $1; exit }')
[ -z "$PID" ] && { echo "NO_PID"; exit 1; }
NONCE="nc$(/usr/bin/python3 -I -c 'import secrets; print(secrets.token_hex(8))')" || { echo "ERR nonce-failed" >&2; exit 1; }
CHECK="(function(){var N='$NONCE';try{var a=document.activeElement;if(a&&(a.tagName==='IFRAME'||a.tagName==='FRAME'))return N+'unreadable';var y=false,els=document.querySelectorAll('input,textarea,select');for(var k=0;k<els.length&&!y;k++){var e=els[k],t=(e.type||'').toLowerCase();if(e.tagName==='SELECT'){for(var o=0;o<e.options.length;o++){if(e.options[o].selected!==e.options[o].defaultSelected)y=true}}else if(t==='checkbox'||t==='radio'){if(e.checked!==e.defaultChecked)y=true}else if(t==='file'){if(e.files&&e.files.length)y=true}else if(['hidden','submit','button','reset','image'].indexOf(t)<0){if(e.value!==e.defaultValue)y=true}}if(!y){var ce=document.querySelectorAll('[contenteditable]:not([contenteditable=false])');for(var c=0;c<ce.length;c++){if((ce[c].textContent||'').trim()){y=true;break}}}return N+(y?'yes':'no')}catch(x){return N+'unreadable'}})()"
JS="$CHECK" PID=$PID NONCE="$NONCE" osascript -l JavaScript <<'OSA'
ObjC.import('Foundation');
var env=$.NSProcessInfo.processInfo.environment;
var pid=parseInt(ObjC.unwrap(env.objectForKey('PID')));
var js=ObjC.unwrap(env.objectForKey('JS'));
var nonce=ObjC.unwrap(env.objectForKey('NONCE'));
var target=$.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
function fc(s){var b=s.split('').map(c=>c.charCodeAt(0));return (b[0]<<24)|(b[1]<<16)|(b[2]<<8)|b[3];}
function spec(cls,from,form,data){var r=$.NSAppleEventDescriptor.recordDescriptor.coerceToDescriptorType(fc('obj '));
 r.setDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithTypeCode(fc(cls)),fc('want'));
 r.setDescriptorForKeyword(from,fc('from'));
 r.setDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithEnumCode(fc(form)),fc('form'));
 r.setDescriptorForKeyword(data,fc('seld'));return r;}
var out=[], stop=false;
// errAENoSuchObject (-1728) ends a window's tabs, or the windows; any other failure is unreadable and stops the read.
for(var i=1;i<=50&&!stop;i++){
 var w=spec('cwin',$.NSAppleEventDescriptor.nullDescriptor,'indx',$.NSAppleEventDescriptor.descriptorWithInt32(i));
 for(var j=1;j<=200;j++){
  var t=spec('ctab',w,'indx',$.NSAppleEventDescriptor.descriptorWithInt32(j));
  var ev=$.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(fc('CrSu'),fc('ExJa'),target,-1,0);
  ev.setParamDescriptorForKeyword(t,fc('----'));
  ev.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(js),fc('JvSc'));
  var err=Ref();
  var res=ev.sendEventWithOptionsTimeoutError(0x3,5,err);
  if(res.isNil()){
   var code=(err[0]&&!err[0].isNil())?err[0].code:0;
   if(code==-1728){ if(j==1) stop=true; break; }
   out.push('tab '+i+'.'+j+' unreadable'); stop=true; break;
  }
  var d=res.paramDescriptorForKeyword(fc('----'));
  var v=d.isNil()?'':ObjC.unwrap(d.stringValue);
  out.push('tab '+i+'.'+j+' '+(v===nonce+'yes'?'yes':v===nonce+'no'?'no':'unreadable'));
 }
}
out.push('done');
out.join('\n')
OSA
