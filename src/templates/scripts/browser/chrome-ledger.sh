#!/bin/bash
# chrome-ledger.sh — keep this agent's browser-instance ledger (machine self-maintenance, Part B).
# Usage: chrome-ledger.sh launch|touch|renew|complete <canonical user-data-dir> [purpose] [ttl-minutes]
# Called by chrome-launch.sh, chrome-js.sh, chrome-renew.sh and chrome-close.sh with a profile
# directory they have already resolved inside this agent's profiles folder; it checks that again.
# One small JSON file per instance in .instar/state/browser-instances/, named by the first 16 hex
# of SHA-256 of the directory (the server's sweep uses the same name). It records who opened the
# browser and when it was last used; the sweep reads it to decide what it WOULD close. It closes
# nothing itself. A failure here never stops the caller: it warns on stderr and exits 0.
# Installed by instar into .instar/scripts/browser/ — overwritten on every update.
AGENT_HOME="$(cd "$(dirname "$0")/../../.." && pwd -P)"
ACTION="$1"; DIR="$2"
case "$ACTION" in launch|touch|renew|complete) ;; *) echo "usage: chrome-ledger.sh launch|touch|renew|complete <dir> [purpose] [ttl-minutes]" >&2; exit 64 ;; esac
case "$DIR" in "$AGENT_HOME/.instar/state/playwright-profiles/"?*) ;; *) echo "ERR ledger-dir-outside-profiles: $DIR" >&2; exit 64 ;; esac
LEDGER="$AGENT_HOME/.instar/state/browser-instances" ACTION="$ACTION" DIR="$DIR" PURPOSE="$3" TTL="$4" \
  AGENT="${INSTAR_AGENT_ID:-}" SESSION="${INSTAR_SESSION_NAME:-}" TOPIC="${INSTAR_TELEGRAM_TOPIC:-}" /usr/bin/python3 -I -c '
import hashlib, json, os, time
e = os.environ
d, act = e["DIR"], e["ACTION"]
os.makedirs(e["LEDGER"], exist_ok=True)
f = os.path.join(e["LEDGER"], hashlib.sha256(d.encode()).hexdigest()[:16] + ".json")
now = time.time()
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
cur = None
try:
    with open(f) as h:
        cur = json.load(h)
except Exception:
    cur = None
if act == "launch":
    declared = e["TTL"].isdigit() and int(e["TTL"]) > 0
    ttl = int(e["TTL"]) if declared else 120
    cur = {"userDataDir": d, "pid": None, "processStartTime": None, "agent": e["AGENT"] or None,
           "sessionName": e["SESSION"] or None, "topicId": e["TOPIC"] or None, "purpose": e["PURPOSE"] or None,
           "openedAt": iso(now), "lastUsedAt": iso(now), "ttlMinutes": ttl, "ttlDeclared": declared,
           "leaseUntil": iso(now + ttl * 60), "completedAt": None}
elif cur is None:
    raise SystemExit(0)  # no entry: the sweep adopts a running browser it finds
elif act in ("touch", "renew"):
    cur["lastUsedAt"] = iso(now)
    cur["leaseUntil"] = iso(now + int(cur.get("ttlMinutes") or 120) * 60)
elif act == "complete":
    cur["completedAt"] = iso(now)
t = f + ".tmp"
with open(t, "w") as h:
    json.dump(cur, h, indent=2)
os.replace(t, f)
' || echo "warning: could not update the browser ledger for $DIR" >&2
exit 0
