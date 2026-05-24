#!/bin/bash

# Autonomous Mode Setup Script
# Creates state file that the stop hook reads to enforce continuous work.
# The stop hook blocks exit and feeds the task list back until all tasks are done.

set -euo pipefail

# Parse arguments
GOAL=""
DURATION="4h"
REPORT_TOPIC=""
REPORT_CHANNEL="telegram"   # channel that owns this job; recovery note routes here (telegram|slack|whatsapp|imessage)
LEVEL_UP="false"
TASKS=""
COMPLETION_PROMISE=""
REPORT_INTERVAL="30m"

while [[ $# -gt 0 ]]; do
  case $1 in
    --goal)
      GOAL="$2"
      shift 2
      ;;
    --duration)
      DURATION="$2"
      shift 2
      ;;
    --report-topic)
      REPORT_TOPIC="$2"
      shift 2
      ;;
    --report-channel)
      REPORT_CHANNEL="$2"
      shift 2
      ;;
    --level-up)
      LEVEL_UP="true"
      shift
      ;;
    --tasks)
      TASKS="$2"
      shift 2
      ;;
    --completion-promise)
      COMPLETION_PROMISE="$2"
      shift 2
      ;;
    --report-interval)
      REPORT_INTERVAL="$2"
      shift 2
      ;;
    *)
      # Collect remaining as goal if not set
      if [[ -z "$GOAL" ]]; then
        GOAL="$1"
      else
        GOAL="$GOAL $1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$GOAL" ]]; then
  echo "❌ Error: No goal provided" >&2
  echo "" >&2
  echo "   Usage: /autonomous --goal 'Complete feature X' --duration 4h" >&2
  exit 1
fi

# Calculate end time
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Convert duration to seconds for end time calculation
DURATION_SECONDS=0
if [[ "$DURATION" =~ ^([0-9]+)h$ ]]; then
  DURATION_SECONDS=$(( ${BASH_REMATCH[1]} * 3600 ))
elif [[ "$DURATION" =~ ^([0-9]+)m$ ]]; then
  DURATION_SECONDS=$(( ${BASH_REMATCH[1]} * 60 ))
elif [[ "$DURATION" =~ ^([0-9]+)$ ]]; then
  DURATION_SECONDS=$(( $1 * 60 ))
fi

if [[ $DURATION_SECONDS -gt 0 ]]; then
  END_AT=$(date -u -v+${DURATION_SECONDS}S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${DURATION_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")
else
  END_AT="unlimited"
fi

# Default completion promise
if [[ -z "$COMPLETION_PROMISE" ]]; then
  COMPLETION_PROMISE="ALL_TASKS_COMPLETE"
fi

# ── Multi-session start gate: concurrency cap + quota (refuse-new) ──
# Primary check is the server (precise active-count + QuotaTracker). If the
# server is unreachable, fall back to a local file-count cap so the cap still
# holds. Starting/restarting THIS topic's own job is always allowed.
if [[ -n "$REPORT_TOPIC" ]]; then
  PORT=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
  AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  CAN_START=$(curl -s -m 3 -H "Authorization: Bearer $AUTH" "http://localhost:${PORT}/autonomous/can-start?priority=medium" 2>/dev/null || echo "")
  ALLOWED=$(printf '%s' "$CAN_START" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('allowed'))
except Exception: print('unknown')" 2>/dev/null || echo "unknown")
  ALREADY_RUNNING="false"
  [[ -f ".instar/autonomous/${REPORT_TOPIC}.local.md" ]] && ALREADY_RUNNING="true"
  if [[ "$ALLOWED" == "False" ]] && [[ "$ALREADY_RUNNING" != "true" ]]; then
    REASON=$(printf '%s' "$CAN_START" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('reason',''))
except Exception: print('')" 2>/dev/null || echo "")
    echo "❌ Autonomous start refused: ${REASON:-cap or quota}" >&2
    echo "   Stop a running job (POST /autonomous/sessions/<topic>/stop) or raise autonomousSessions.maxConcurrent." >&2
    exit 1
  fi
  if [[ "$ALLOWED" == "unknown" ]] && [[ "$ALREADY_RUNNING" != "true" ]]; then
    MAX_CONCURRENT=$(python3 -c "import json;print((json.load(open('.instar/config.json')).get('autonomousSessions') or {}).get('maxConcurrent',5))" 2>/dev/null || echo 5)
    COUNT=$(ls .instar/autonomous/*.local.md 2>/dev/null | grep -cv "/${REPORT_TOPIC}\.local\.md$")
    COUNT=${COUNT:-0}
    if [[ "$COUNT" =~ ^[0-9]+$ ]] && [[ "$MAX_CONCURRENT" =~ ^[0-9]+$ ]] && [[ $COUNT -ge $MAX_CONCURRENT ]]; then
      echo "❌ Autonomous start refused: concurrency cap reached ($COUNT/$MAX_CONCURRENT) [server unreachable; local check]." >&2
      exit 1
    fi
  fi
fi

# Create state file. Multi-session: each topic gets its own state file at
# .instar/autonomous/<topicId>.local.md so multiple topics run concurrent
# autonomous jobs without collision. With no report topic, fall back to the
# legacy single-file path (one-at-a-time, back-compat).
mkdir -p .instar
if [[ -n "$REPORT_TOPIC" ]]; then
  mkdir -p .instar/autonomous
  STATE_PATH=".instar/autonomous/${REPORT_TOPIC}.local.md"
else
  STATE_PATH=".instar/autonomous-state.local.md"
fi

cat > "$STATE_PATH" <<EOF
---
active: true
iteration: 1
session_id: ${CLAUDE_CODE_SESSION_ID:-}
goal: "$GOAL"
duration: "$DURATION"
duration_seconds: $DURATION_SECONDS
started_at: "$STARTED_AT"
end_at: "$END_AT"
report_topic: "$REPORT_TOPIC"
report_channel: "$REPORT_CHANNEL"
report_interval: "$REPORT_INTERVAL"
last_report_at: ""
level_up: $LEVEL_UP
completion_promise: "$COMPLETION_PROMISE"
---

# Autonomous Session

## Goal
$GOAL

## Tasks
$TASKS

## Instructions

You are in AUTONOMOUS MODE. The stop hook will prevent you from exiting until:
1. You output <promise>$COMPLETION_PROMISE</promise> (ONLY when genuinely true)
2. OR the duration expires ($DURATION from $STARTED_AT)
3. OR the user sends an emergency stop

### Rules
- Do NOT defer work to "Phase 2" or "future sessions"
- Do NOT label tasks as "parked" unless genuinely blocked by external dependencies
- Do NOT declare victory early — check EVERY task
- When you think you're done, re-read the task list and verify each item
- If time remains after completing tasks, look for related improvements
- Send progress reports every $REPORT_INTERVAL to topic $REPORT_TOPIC

### Emergency Stop
The user can always stop you via:
- Sending "stop everything" or "emergency stop" via messaging
- The MessageSentinel will intercept and halt operations

### Completion
To complete, ALL of these must be true:
- Every task in the task list is implemented (not just wired/stubbed)
- Code compiles (npx tsc --noEmit)
- Changes are tested where practical
- Then output: <promise>$COMPLETION_PROMISE</promise>
EOF

echo "🔄 Autonomous mode activated!"
echo ""
echo "Goal: $GOAL"
echo "Duration: $DURATION (until $END_AT)"
echo "Level-up: $LEVEL_UP"
echo "Report topic: ${REPORT_TOPIC:-none}"
echo "Completion: <promise>$COMPLETION_PROMISE</promise>"
echo ""
echo "The stop hook is now active. You cannot exit until tasks are complete."
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "CRITICAL: Defer-to-Future-Self Trap"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Do NOT label remaining work as 'Phase 2', 'future', or 'parked'"
echo "unless it genuinely requires something you don't have access to."
echo ""
echo "If you have the tools and knowledge to do it NOW — do it NOW."
echo "Your future self is not better equipped. You are the future self."
echo "═══════════════════════════════════════════════════════════"
