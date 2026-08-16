#!/bin/bash

# Autonomous Mode Setup Script
# Creates state file that the stop hook reads to enforce continuous work.
# The stop hook blocks exit and feeds the task list back until all tasks are done.

set -euo pipefail

# Parse arguments
GOAL=""
DURATION="4h"
REPORT_TOPIC=""
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

# Create state file
mkdir -p .instar

cat > .instar/autonomous-state.local.md <<EOF
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
