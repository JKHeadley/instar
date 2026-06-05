#!/bin/bash
# emit-session-clock.sh — render the SESSION CLOCK line for an active time-boxed
# session, so an agent always sees how much of a timed run remains and never
# winds down early. Signal-only: pure stdout, never blocks.
#
# Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md (Component 2). The math
# of record (clock-skew clamping, status) lives in SessionClock.compute() (TS);
# this script only FORMATS values it is given (render) or queries the route.
#
# Modes:
#   render <startedISO> <durationSec> <elapsedSec> <remainingSec> <label>
#     Prints ONE SESSION CLOCK line from the given (already-sanitized, already-
#     computed) values. The caller (autonomous-stop-hook) has already resolved
#     the record + computed elapsed/remaining, so there is NO re-resolution —
#     the injected clock can never disagree with the hook's expiry verdict.
#   query <topic> <port> <auth> [agent-id]
#     Curls GET /session/clock?topic=<topic> and prints the SESSION CLOCK line
#     for the first active session (or nothing if none / server unreachable).

humanize() { # seconds -> "Xh Ym" / "Ym" / "Xs"
  local s="${1:-0}"
  case "$s" in (*[!0-9-]*) s=0 ;; esac
  [ "$s" -lt 0 ] 2>/dev/null && s=0
  local h=$((s / 3600)) m=$(((s % 3600) / 60))
  if [ "$h" -gt 0 ]; then echo "${h}h ${m}m"; elif [ "$m" -gt 0 ]; then echo "${m}m"; else echo "${s}s"; fi
}

render_line() { # startedISO durationSec elapsedSec remainingSec label
  local dur="$2" el="${3:-0}" rem="$4" label="$5"
  local pct="" remstr="" lbl=""
  if [ -n "$dur" ] && [ "$dur" -gt 0 ] 2>/dev/null; then pct=" ($((el * 100 / dur))% elapsed)"; fi
  if [ -n "$rem" ]; then remstr=" · $(humanize "$rem") remaining"; fi
  if [ -n "$label" ]; then lbl=" [$label]"; fi
  echo "⏱ SESSION CLOCK${lbl}: $(humanize "$el") elapsed${remstr}${pct}. Do NOT conclude the session is over while remaining is large."
}

MODE="${1:-}"
shift 2>/dev/null || true

case "$MODE" in
  render)
    render_line "${1:-}" "${2:-}" "${3:-0}" "${4:-}" "${5:-}"
    ;;
  query)
    TOPIC="${1:-}"; PORT="${2:-}"; AUTH="${3:-}"; AGENT_ID="${4:-${INSTAR_AGENT_ID:-}}"
    [ -z "$PORT" ] && exit 0
    URL="http://localhost:${PORT}/session/clock"
    [ -n "$TOPIC" ] && URL="${URL}?topic=${TOPIC}"
    RESP=$(curl -s --max-time 3 -H "Authorization: Bearer ${AUTH}" -H "X-Instar-AgentId: ${AGENT_ID}" "$URL" 2>/dev/null)
    [ -z "$RESP" ] && exit 0
    printf '%s' "$RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sessions = d.get('sessions') or []
if not sessions:
    sys.exit(0)
c = sessions[0]
label = c.get('label') or ''
el = c.get('elapsedHuman') or '?'
rem = c.get('remainingHuman')
pct = c.get('percentElapsed')
line = '⏱ SESSION CLOCK' + ((' [' + label + ']') if label else '') + ': ' + el + ' elapsed'
if rem is not None:
    line += ' · ' + rem + ' remaining'
if pct is not None:
    line += ' (' + str(pct) + '% elapsed)'
line += '. Do NOT conclude the session is over while remaining is large.'
print(line)
" 2>/dev/null
    ;;
  *)
    exit 0
    ;;
esac
exit 0
