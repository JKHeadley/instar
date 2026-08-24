#!/usr/bin/env bash
# Step 2b — watch the AutoUpdater land the released version. Emits one line per milestone, exits on 'Server listening' for the target.
# usage: step2b-watch-updater.sh <target-version e.g. 1.3.1198>   (poll 30s, cap 90m)
set -uo pipefail
V="${1:?target version}"; L=/Users/dabombstudio/.instar/agents/echo/logs/server.log; T0=$(date +%s)
seen=""
while :; do
  for m in "Update available: .*→ $V" "Restart requested .*$V" "Server listening on"; do
    if grep -qE "$m" <(tail -n 400 "$L") && ! grep -qF "$m" <<<"$seen"; then
      echo "$(date -u +%H:%M:%SZ) $m"; seen="$seen|$m"
      if [[ "$m" == "Server listening on" && "$seen" == *"Restart requested"* ]]; then echo "LANDED: $V is serving"; exit 0; fi
    fi
  done
  (( $(date +%s) - T0 > 5400 )) && { echo "TIMEOUT: $V not observed landing in 90m — check the updater, do not hand-install"; exit 2; }
  sleep 30
done
