#!/bin/bash

# Autonomous Mode Stop Hook
# Prevents session exit when autonomous mode is active.
# Feeds the goal and task list back to continue working.
#
# SESSION-SCOPED: Only blocks the session that activated autonomous mode.
# Other sessions on the same machine pass through unaffected.
#
# RESPECTS:
# - Session isolation (only blocks the autonomous session)
# - Emergency stop signals (user says "stop everything")
# - Duration expiry
# - Genuine completion (all tasks done, promise output)

set -euo pipefail

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Check if autonomous mode is active
STATE_FILE=".instar/autonomous-state.local.md"

if [[ ! -f "$STATE_FILE" ]]; then
  # No active autonomous session — allow exit
  exit 0
fi

# Parse YAML frontmatter
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")

ACTIVE=$(echo "$FRONTMATTER" | grep '^active:' | sed 's/active: *//')
if [[ "$ACTIVE" != "true" ]]; then
  exit 0
fi

# SESSION ISOLATION: Only block the session that started autonomous mode.
# Uses self-bootstrapping: if no session_id in state file yet, the FIRST
# session to trigger the hook claims it. All other sessions see a mismatch.
STATE_SESSION=$(echo "$FRONTMATTER" | grep '^session_id:' | sed 's/^session_id: *//' | tr -d '"' || true)

# VALIDATE: If state has a session_id but it's not a valid UUID, treat as empty.
# Claude sometimes writes a custom string instead of the real $CLAUDE_CODE_SESSION_ID.
# Non-UUID values will never match the real hook session_id, causing the hook to
# fail-open and allow premature exit. By clearing invalid values, we fall through
# to self-bootstrap, which captures the REAL session_id from the first hook call.
UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [[ -n "$STATE_SESSION" ]] && ! [[ "$STATE_SESSION" =~ $UUID_REGEX ]]; then
  echo "[autonomous] Invalid session_id in state file (not UUID): '$STATE_SESSION' — falling back to self-bootstrap" >&2
  STATE_SESSION=""
fi

HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# If hook has no session_id → fail OPEN (unknown context, don't trap)
if [[ -z "$HOOK_SESSION" ]]; then
  echo "⚠️  Autonomous mode: No session_id in hook input — fail-open (allowing exit)" >&2
  exit 0
fi

# SELF-BOOTSTRAP: If state has no session_id yet, claim it from this hook call.
# The first session to fire the hook becomes the autonomous session.
if [[ -z "$STATE_SESSION" ]]; then
  # Atomic claim: write session_id to state file
  TEMP_FILE="${STATE_FILE}.claim.$$"
  sed "s/^session_id:.*/session_id: \"${HOOK_SESSION}\"/" "$STATE_FILE" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$STATE_FILE"
  STATE_SESSION="$HOOK_SESSION"
  echo "[autonomous] Session $HOOK_SESSION claimed autonomous mode" >&2
fi

# Different session → allow exit (fail-open for non-autonomous sessions)
if [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi

# Same session — this IS the autonomous session, proceed with block logic

ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
DURATION_SECONDS=$(echo "$FRONTMATTER" | grep '^duration_seconds:' | sed 's/duration_seconds: *//')
STARTED_AT=$(echo "$FRONTMATTER" | grep '^started_at:' | sed 's/started_at: *//' | tr -d '"')
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | tr -d '"')
REPORT_TOPIC=$(echo "$FRONTMATTER" | grep '^report_topic:' | sed 's/report_topic: *//' | tr -d '"')

# Validate iteration
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Autonomous mode: State file corrupted (bad iteration)" >&2
  rm "$STATE_FILE"
  exit 0
fi

# Check duration expiry
if [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] && [[ $DURATION_SECONDS -gt 0 ]]; then
  START_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null || date -d "$STARTED_AT" +%s 2>/dev/null || echo "0")
  NOW_EPOCH=$(date +%s)
  ELAPSED=$(( NOW_EPOCH - START_EPOCH ))
  if [[ $ELAPSED -ge $DURATION_SECONDS ]]; then
    echo "⏰ Autonomous mode: Duration expired ($ELAPSED seconds elapsed)."
    echo "   Session is free to exit."
    rm "$STATE_FILE"
    exit 0
  fi
  REMAINING=$(( DURATION_SECONDS - ELAPSED ))
  REMAINING_MIN=$(( REMAINING / 60 ))
fi

# Check for emergency stop (look in recent messages)
# The MessageSentinel handles this at the messaging layer, but also check here
if [[ -f ".instar/autonomous-emergency-stop" ]]; then
  echo "🛑 Autonomous mode: Emergency stop detected."
  rm "$STATE_FILE"
  rm -f ".instar/autonomous-emergency-stop"
  exit 0
fi

# Get transcript and check for completion promise
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path' 2>/dev/null || echo "")

if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  # Check last assistant message for completion promise
  LAST_LINE=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 || echo "")

  if [[ -n "$LAST_LINE" ]]; then
    LAST_OUTPUT=$(echo "$LAST_LINE" | jq -r '
      .message.content |
      map(select(.type == "text")) |
      map(.text) |
      join("\n")
    ' 2>/dev/null || echo "")

    # Check for completion promise in <promise> tags
    if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
      PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")

      if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
        echo "✅ Autonomous mode: Completion promise detected — <promise>$COMPLETION_PROMISE</promise>"
        echo "   Session is free to exit. Good work!"
        rm "$STATE_FILE"
        exit 0
      fi
    fi
  fi
fi

# Not complete — block exit and feed task list back
NEXT_ITERATION=$((ITERATION + 1))

# Extract prompt (everything after closing ---)
PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")

if [[ -z "$PROMPT_TEXT" ]]; then
  echo "⚠️  Autonomous mode: State file has no task content" >&2
  rm "$STATE_FILE"
  exit 0
fi

# Update iteration counter
TEMP_FILE="${STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# ── Progress Report Check ──
# Check if it's time to send a progress report
REPORT_INTERVAL=$(echo "$FRONTMATTER" | grep '^report_interval:' | sed 's/report_interval: *//' | tr -d '"')
LAST_REPORT_AT=$(echo "$FRONTMATTER" | grep '^last_report_at:' | sed 's/last_report_at: *//' | tr -d '"')

# Convert report interval to seconds
REPORT_INTERVAL_SECS=1800  # default 30 minutes
if [[ "$REPORT_INTERVAL" =~ ^([0-9]+)m$ ]]; then
  REPORT_INTERVAL_SECS=$(( ${BASH_REMATCH[1]} * 60 ))
elif [[ "$REPORT_INTERVAL" =~ ^([0-9]+)h$ ]]; then
  REPORT_INTERVAL_SECS=$(( ${BASH_REMATCH[1]} * 3600 ))
fi

REPORT_DUE="false"
NOW_EPOCH=$(date +%s)

if [[ -z "$LAST_REPORT_AT" ]] || [[ "$LAST_REPORT_AT" == "null" ]] || [[ "$LAST_REPORT_AT" == '""' ]]; then
  # No report sent yet — due if we've been running for at least one interval
  if [[ -n "$STARTED_AT" ]]; then
    START_EPOCH_R=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null || date -d "$STARTED_AT" +%s 2>/dev/null || echo "0")
    ELAPSED_SINCE_START=$(( NOW_EPOCH - START_EPOCH_R ))
    if [[ $ELAPSED_SINCE_START -ge $REPORT_INTERVAL_SECS ]]; then
      REPORT_DUE="true"
    fi
  fi
else
  # Check time since last report
  LAST_REPORT_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_REPORT_AT" +%s 2>/dev/null || date -d "$LAST_REPORT_AT" +%s 2>/dev/null || echo "0")
  ELAPSED_SINCE_REPORT=$(( NOW_EPOCH - LAST_REPORT_EPOCH ))
  if [[ $ELAPSED_SINCE_REPORT -ge $REPORT_INTERVAL_SECS ]]; then
    REPORT_DUE="true"
  fi
fi

# If report is due, update last_report_at in state file
REPORT_DIRECTIVE=""
if [[ "$REPORT_DUE" == "true" ]]; then
  REPORT_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Update or add last_report_at in frontmatter
  if grep -q '^last_report_at:' "$STATE_FILE"; then
    TEMP_FILE2="${STATE_FILE}.tmp2.$$"
    sed "s/^last_report_at: .*/last_report_at: \"$REPORT_NOW\"/" "$STATE_FILE" > "$TEMP_FILE2"
    mv "$TEMP_FILE2" "$STATE_FILE"
  else
    # Add last_report_at before the closing ---
    TEMP_FILE2="${STATE_FILE}.tmp2.$$"
    sed "0,/^---$/! { /^---$/i\\
last_report_at: \"$REPORT_NOW\"
}" "$STATE_FILE" > "$TEMP_FILE2" 2>/dev/null && mv "$TEMP_FILE2" "$STATE_FILE" || true
  fi
  REPORT_DIRECTIVE=" | ⚠️ PROGRESS REPORT DUE: Send an update to the user NOW via messaging before continuing work (topic: ${REPORT_TOPIC:-auto})"
fi

# Build system message
if [[ -n "${REMAINING_MIN:-}" ]]; then
  TIME_MSG="${REMAINING_MIN}m remaining"
else
  TIME_MSG="no time limit"
fi

SYSTEM_MSG="🔄 Autonomous iteration $NEXT_ITERATION ($TIME_MSG) | Complete ALL tasks, then output <promise>$COMPLETION_PROMISE</promise> | Do NOT defer to future self — if you can do it now, DO IT NOW${REPORT_DIRECTIVE}"

# Block exit and feed prompt back
jq -n \
  --arg prompt "$PROMPT_TEXT" \
  --arg msg "$SYSTEM_MSG" \
  '{
    "decision": "block",
    "reason": $prompt,
    "systemMessage": $msg
  }'

exit 0
