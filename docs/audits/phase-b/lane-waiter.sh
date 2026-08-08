#!/bin/bash
# lane-waiter — the RETURN STEP the dispatch-and-collect loop was missing.
#
# Problem it solves (manager observation, 2026-08-05 06:00Z): I dispatch a Codex
# lane to the laptop, then collect its result whenever I next happen to think of
# it. A lane that finished at 05:15 sat uncollected until 06:00. "Remember to
# check" is the failure mode the whole plan exists to remove, and it was running
# inside the session auditing it.
#
# The fix: run THIS in the background alongside every dispatch. It blocks until
# the lane's output file appears (or the lane's tmux session dies), then exits —
# and a background command exiting RE-INVOKES the session. The return step stops
# being something I remember and becomes something the system does.
#
# Usage:  lane-waiter.sh <lane-name> <remote-output-basename> [timeout-seconds]
# Exit:   0 = output landed · 3 = lane died without output · 4 = timed out
set -uo pipefail

main() {
  local lane="${1:-}" out="${2:-}" timeout="${3:-3600}"
  [ -z "$lane" ] || [ -z "$out" ] && { echo "usage: lane-waiter.sh <lane> <output-basename> [timeout]"; return 64; }

  local KEY="$HOME/.ssh/echo-mini-to-laptop"
  local HOST="justin@100.94.220.125"
  local D="/Users/justin/.instar/agents/echo/.worktrees/phaseb-census-main/.phase-b-census"
  local SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

  local waited=0 interval=20
  while [ "$waited" -lt "$timeout" ]; do
    # Landed?
    if "${SSH[@]}" "$HOST" "test -s '$D/$out'" 2>/dev/null; then
      echo "LANE-LANDED: $lane -> $out after ${waited}s"
      return 0
    fi
    # Died without producing output?
    if ! "${SSH[@]}" "$HOST" "export PATH=/opt/homebrew/bin:\$PATH; tmux has-session -t '=echo-$lane:'" 2>/dev/null; then
      # one grace re-check — the file may land just as the session exits
      sleep 5
      if "${SSH[@]}" "$HOST" "test -s '$D/$out'" 2>/dev/null; then
        echo "LANE-LANDED: $lane -> $out (on exit) after ${waited}s"
        return 0
      fi
      echo "LANE-DIED-EMPTY: $lane exited without writing $out after ${waited}s"
      return 3
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
  echo "LANE-TIMEOUT: $lane did not produce $out within ${timeout}s"
  return 4
}

main "$@"
