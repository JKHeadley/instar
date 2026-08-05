#!/bin/bash
# Aggregate return step: block until EVERY lane output lands, or all lanes die, or timeout.
# One re-invocation for the whole set instead of seven.
set -uo pipefail
KEY="$HOME/.ssh/echo-mini-to-laptop"; HOST="justin@100.94.220.125"
D=/Users/justin/.instar/agents/echo/.worktrees/phaseb-census-main/.phase-b-census
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
OUTS=(overlap-p1-measure-certify.md overlap-p2-semantic-search.md overlap-p3-unwatched-decisions.md \
      overlap-p4-remove-what-demands-attention.md overlap-p4b-remove-noanchor.md \
      overlap-p5-withhold-the-answer.md registry-census.md)
TIMEOUT="${1:-3000}"; waited=0; interval=30
while [ "$waited" -lt "$TIMEOUT" ]; do
  landed=$("${SSH[@]}" "$HOST" "cd $D 2>/dev/null; n=0; for f in ${OUTS[*]}; do [ -s \"\$f\" ] && n=\$((n+1)); done; echo \$n" 2>/dev/null)
  live=$("${SSH[@]}" "$HOST" "export PATH=/opt/homebrew/bin:\$PATH; tmux ls 2>/dev/null | grep -cE '^echo-(p[0-9]|p4b|probe|census):'" 2>/dev/null)
  landed=${landed:-0}; live=${live:-0}
  echo "[${waited}s] landed=${landed}/7 liveLanes=${live}"
  if [ "$landed" -ge 7 ]; then echo "ALL-LANDED after ${waited}s"; exit 0; fi
  if [ "$live" -eq 0 ]; then sleep 10
     landed=$("${SSH[@]}" "$HOST" "cd $D 2>/dev/null; n=0; for f in ${OUTS[*]}; do [ -s \"\$f\" ] && n=\$((n+1)); done; echo \$n" 2>/dev/null)
     echo "ALL-LANES-EXITED landed=${landed:-0}/7 after ${waited}s"; exit 0; fi
  sleep "$interval"; waited=$((waited + interval))
done
echo "WAITER-TIMEOUT landed=${landed}/7 after ${waited}s"; exit 4
