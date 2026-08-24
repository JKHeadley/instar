#!/usr/bin/env bash
# Step 4 precondition — Observer 1's condition (turn 10): tell topic 36966 AND wake the observer's pane, BEFORE the bounce.
# Writes the marker step4-restart-sessions.sh refuses without. `--dry` exercises the path without sending or marking.
set -uo pipefail; cd /Users/dabombstudio/.instar/agents/echo
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
AUTH=$(node .instar/scripts/secret-get.mjs authToken); N=.instar/w25/deploy-evidence/step4-notice-to-observer1.txt; M=.instar/w25/deploy-evidence/step4-notice-sent.marker
[ -s "$N" ] || { echo "REFUSED: notice text missing at $N"; exit 1; }
OBS=echo-observer   # Observer 1's session (tmux name); verified in step4-observers.txt
grep -qxF "$OBS" .instar/w25/deploy-evidence/step4-observers.txt || { echo "REFUSED: $OBS not in the observer list"; exit 1; }
if [ $DRY = 1 ]; then echo "DRY: would send $(wc -c < $N) bytes to topic 36966; would wake pane $OBS via POST /sessions/$OBS/input; would write $M"; exit 0; fi
# 1) the topic notice (Observer 1 reads 36966; replies come to 29723)
T=$(cat "$N" | .instar/scripts/telegram-reply.sh 36966 2>&1 | tail -1); echo "telegram-36966: $T"
echo "$T" | grep -qiE "^Sent " || { echo "REFUSED: topic send did not confirm — not writing the marker"; exit 1; }
# 2) the pane wake (a short line into the observer's session so it acts on the notice now, not on its next poll)
W=$(curl -s -o /tmp/wake.json -w '%{http_code}' -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' http://localhost:4042/sessions/$OBS/input -d '{"text":"[Echo · W25] Session bounce begins now — see topic 36966. Re-arm your watches after your session returns."}')
echo "pane-wake: HTTP $W $(head -c 120 /tmp/wake.json)"
[ "$W" = 200 ] || [ "$W" = 202 ] || { echo "REFUSED: pane wake did not land (HTTP $W) — not writing the marker"; exit 1; }
{ echo "telegram-36966=$(date -u +%Y-%m-%dT%H:%M:%SZ) $T"; echo "pane-wake=$(date -u +%Y-%m-%dT%H:%M:%SZ) HTTP $W"; } > "$M"
echo "marker written: $M"; cat "$M"
