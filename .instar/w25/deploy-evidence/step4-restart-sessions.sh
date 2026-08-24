#!/usr/bin/env bash
# Step 4 — restart sessions, OBSERVERS LAST, individually. Exists ONLY for B-2 (loaded-hook proof).
# PRECONDITION (Observer 1's condition): tell Observer 1 in topic 29723 BEFORE running this.
set -uo pipefail; cd /Users/dabombstudio/.instar/agents/echo; AUTH=$(node .instar/scripts/secret-get.mjs authToken)
# STRUCTURAL PRECONDITION (Observer 1, turn 10): refuse unless BOTH the 36966 notice and the pane wake are on record.
M=.instar/w25/deploy-evidence/step4-notice-sent.marker
[ -f "$M" ] && grep -q 'telegram-36966=' "$M" && grep -q 'pane-wake=' "$M" || { echo 'REFUSED: no marker proving the 36966 notice AND the pane wake were sent. Run step4-notify-observer1.sh first.'; exit 1; }
echo "precondition met: $(cat $M | tr '\n' ' ')"
OBS_FILE=.instar/w25/deploy-evidence/step4-observers.txt
refresh(){ printf "  %-44s " "$1"; curl -s -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' http://localhost:4042/sessions/refresh -d "{\"sessionName\":\"$1\",\"reason\":\"W25 step 4: $2\"}" | head -c 120; echo; sleep "${3:-20}"; }
ALL=$(curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/sessions | python3 -c "import json,sys; [print(s['tmuxSession']) for s in json.load(sys.stdin) if s.get('status')=='running']")
echo "1) non-observers, one at a time, 20s apart:"
for s in $ALL; do grep -qxF "$s" "$OBS_FILE" && continue; case "$s" in echo-server) continue;; esac; refresh "$s" "B-2 loaded-hook proof" 20; done
echo "2) observers, one at a time, 30s apart, THIS orchestrator last:"
ME=$(grep -m1 pathway "$OBS_FILE" || true)
for s in $(grep -vxF "$ME" "$OBS_FILE"); do refresh "$s" "observer, per Observer 1's condition" 30; done
[ -n "$ME" ] && refresh "$ME" "orchestrator last" 0
echo "done. B-2 is now provable: every session's loaded hooks == the on-disk file at its start instant. Re-count on disk with the control."
