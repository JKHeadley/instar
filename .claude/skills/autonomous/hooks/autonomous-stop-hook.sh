#!/bin/bash

# Autonomous Mode Stop Hook
# Prevents session exit when autonomous mode is active.
# Feeds the goal and task list back to continue working.
#
# TOPIC-KEYED OWNERSHIP (primary): the autonomous job is identified by the
# TOPIC it serves, not by the Claude session UUID. The topic is a stable
# "street address" — when a session hits the memory limit and restarts, its
# UUID rotates (a new badge) but instar respawns it into the SAME tmux session
# name, and the topic-session registry still maps that name to the same topic.
# So whoever is running in the topic's session is recognized as continuing the
# job, restart or no restart. This fixes the silent-failure bug where a restart
# rotated the UUID, mismatched the state file, and let autonomy die unnoticed.
#
# LIVENESS-GATED BACKSTOP (rare): when topic resolution is unavailable (no tmux,
# or the topic isn't in the registry) the hook falls back to session-id matching.
# A session-id mismatch is then gated by a liveness check on the recorded owner
# (is its transcript still growing?) — a dead owner is adopted, a live one is
# left alone. This is the demoted role of the old liveness idea: a thin edge
# guard, not the main mechanism.
#
# RECOVERY NOTE: on an actual restart-and-resume (topic verified, but the
# session UUID changed) the hook emits ONE user-facing one-line note and an
# audit record, then records the new UUID so the note never repeats.
#
# RESPECTS: emergency stop, duration expiry, genuine completion (promise).

set -uo pipefail   # NOTE: -e intentionally omitted; field lookups for optional
                   # frontmatter keys are expected to "fail" (grep finds nothing)
                   # and must not abort the hook. Each critical step guards itself.

# Read hook input from stdin
HOOK_INPUT=$(cat)

STATE_FILE=".instar/autonomous-state.local.md"
REGISTRY_FILE=".instar/topic-session-registry.json"
RECOVERY_AUDIT=".instar/autonomous-recovery.jsonl"
LIVENESS_SECS="${INSTAR_AUTONOMOUS_LIVENESS_SECS:-120}"

if [[ ! -f "$STATE_FILE" ]]; then
  # No active autonomous session — allow exit
  exit 0
fi

# Parse YAML frontmatter (between the first two --- lines)
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")

# Safe frontmatter field reader — never trips pipefail when a key is absent.
fm_get() {
  local key="$1"
  printf '%s\n' "$FRONTMATTER" | grep "^${key}:" | head -1 | sed "s/^${key}: *//" | tr -d '"' || true
}

ACTIVE=$(fm_get active)
if [[ "$ACTIVE" != "true" ]]; then
  exit 0
fi

# ── Inputs from the hook ──────────────────────────────────────────────
HOOK_SESSION=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")

# If hook has no session_id → fail OPEN (unknown context, don't trap)
if [[ -z "$HOOK_SESSION" ]]; then
  echo "⚠️  Autonomous mode: No session_id in hook input — fail-open (allowing exit)" >&2
  exit 0
fi

# ── State fields ──────────────────────────────────────────────────────
REPORT_TOPIC=$(fm_get report_topic)
STATE_SESSION=$(fm_get session_id)
ITERATION=$(fm_get iteration)
DURATION_SECONDS=$(fm_get duration_seconds)
STARTED_AT=$(fm_get started_at)
COMPLETION_PROMISE=$(fm_get completion_promise)

# Validate recorded session_id is a real UUID. Claude sometimes writes a custom
# string instead of $CLAUDE_CODE_SESSION_ID; non-UUID values are treated as
# empty so the session-match backstop self-bootstraps from the real UUID.
UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [[ -n "$STATE_SESSION" ]] && ! [[ "$STATE_SESSION" =~ $UUID_REGEX ]]; then
  echo "[autonomous] Invalid session_id in state file (not UUID): '$STATE_SESSION' — clearing" >&2
  STATE_SESSION=""
fi

# ── Resolve MY topic (the stable address) ─────────────────────────────
# Test/override seam: INSTAR_HOOK_TMUX_SESSION (if the var is set at all, even
# empty, it wins — empty means "no tmux"). INSTAR_HOOK_NO_TMUX=1 forces empty.
resolve_my_tmux() {
  if [[ "${INSTAR_HOOK_NO_TMUX:-}" == "1" ]]; then
    echo ""
    return
  fi
  if [[ -n "${INSTAR_HOOK_TMUX_SESSION+x}" ]]; then
    echo "${INSTAR_HOOK_TMUX_SESSION}"
    return
  fi
  tmux display-message -p '#S' 2>/dev/null || echo ""
}
MY_TMUX=$(resolve_my_tmux)

# Reverse-lookup: which tmux session owns REPORT_TOPIC per the registry?
OWNER_TMUX=""
if [[ -n "$REPORT_TOPIC" ]] && [[ -f "$REGISTRY_FILE" ]]; then
  OWNER_TMUX=$(REPORT_TOPIC="$REPORT_TOPIC" python3 -c "
import json, os
try:
    reg = json.load(open('$REGISTRY_FILE'))
    print((reg.get('topicToSession') or {}).get(os.environ['REPORT_TOPIC'], ''))
except Exception:
    print('')
" 2>/dev/null || echo "")
fi

# ── Ownership decision ────────────────────────────────────────────────
# OWNER=true means: this session IS the autonomous worker; block its exit.
# OWNER_METHOD records how we decided (topic | session | bootstrap | adopt-dead).
OWNER="false"
OWNER_METHOD=""
RESTART_DETECTED="false"

if [[ -n "$MY_TMUX" ]] && [[ -n "$OWNER_TMUX" ]]; then
  # Topic resolution is conclusive.
  if [[ "$MY_TMUX" == "$OWNER_TMUX" ]]; then
    OWNER="true"; OWNER_METHOD="topic"
    # Restart? Recorded UUID is a real UUID but differs from the live one.
    if [[ -n "$STATE_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
      RESTART_DETECTED="true"
    fi
  else
    # Registry says topic T is served by a different session → not me.
    exit 0
  fi
else
  # ── Backstop: topic unresolved (no tmux, or topic not in registry) ──
  if [[ -z "$STATE_SESSION" ]]; then
    # Self-bootstrap: first session to fire claims the job.
    OWNER="true"; OWNER_METHOD="bootstrap"
  elif [[ "$STATE_SESSION" == "$HOOK_SESSION" ]]; then
    OWNER="true"; OWNER_METHOD="session"
  else
    # Session-id mismatch with no topic signal. Gate on recorded owner liveness.
    OWNER_ALIVE="false"
    if [[ -n "$TRANSCRIPT_PATH" ]]; then
      OWNER_TRANSCRIPT="$(dirname "$TRANSCRIPT_PATH")/${STATE_SESSION}.jsonl"
      if [[ -f "$OWNER_TRANSCRIPT" ]]; then
        NOW_E=$(date +%s)
        MTIME=$(stat -f %m "$OWNER_TRANSCRIPT" 2>/dev/null || stat -c %Y "$OWNER_TRANSCRIPT" 2>/dev/null || echo 0)
        AGE=$(( NOW_E - MTIME ))
        if [[ $AGE -lt $LIVENESS_SECS ]]; then
          OWNER_ALIVE="true"
        fi
      fi
    fi
    if [[ "$OWNER_ALIVE" == "true" ]]; then
      # A genuinely different, live session owns this — don't steal.
      exit 0
    fi
    # Recorded owner is dead/unknown → adopt the job.
    OWNER="true"; OWNER_METHOD="adopt-dead"; RESTART_DETECTED="true"
  fi
fi

if [[ "$OWNER" != "true" ]]; then
  exit 0
fi

# ── This IS the autonomous session. Terminal checks first. ────────────

# Validate iteration
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Autonomous mode: State file corrupted (bad iteration)" >&2
  rm -f "$STATE_FILE"
  exit 0
fi

# Duration expiry. Fail-SAFE: if started_at can't be parsed (START_EPOCH falls
# back to 0/empty), do NOT expire — an unparseable timestamp must never cause a
# premature exit (that is the very failure class this hook exists to prevent).
REMAINING_MIN=""
if [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] && [[ $DURATION_SECONDS -gt 0 ]]; then
  START_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null || date -d "$STARTED_AT" +%s 2>/dev/null || echo "0")
  if [[ "$START_EPOCH" =~ ^[0-9]+$ ]] && [[ $START_EPOCH -gt 0 ]]; then
    NOW_EPOCH=$(date +%s)
    ELAPSED=$(( NOW_EPOCH - START_EPOCH ))
    if [[ $ELAPSED -ge $DURATION_SECONDS ]]; then
      echo "⏰ Autonomous mode: Duration expired ($ELAPSED seconds elapsed)."
      echo "   Session is free to exit."
      rm -f "$STATE_FILE"
      exit 0
    fi
    REMAINING=$(( DURATION_SECONDS - ELAPSED ))
    REMAINING_MIN=$(( REMAINING / 60 ))
  else
    echo "[autonomous] started_at unparseable ('$STARTED_AT') — skipping duration-expiry check (fail-safe: keep running)" >&2
  fi
fi

# Emergency stop
if [[ -f ".instar/autonomous-emergency-stop" ]]; then
  echo "🛑 Autonomous mode: Emergency stop detected."
  rm -f "$STATE_FILE"
  rm -f ".instar/autonomous-emergency-stop"
  exit 0
fi

# Completion promise (genuine completion)
if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  LAST_LINE=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 || echo "")
  if [[ -n "$LAST_LINE" ]]; then
    LAST_OUTPUT=$(printf '%s' "$LAST_LINE" | jq -r '
      .message.content | map(select(.type == "text")) | map(.text) | join("\n")
    ' 2>/dev/null || echo "")
    if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
      PROMISE_TEXT=$(printf '%s' "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")
      if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
        echo "✅ Autonomous mode: Completion promise detected — <promise>$COMPLETION_PROMISE</promise>"
        echo "   Session is free to exit. Good work!"
        rm -f "$STATE_FILE"
        exit 0
      fi
    fi
  fi
fi

# ── Not terminal: we are continuing. Handle restart-resume recovery note. ──
# Always reconcile the recorded session_id to the live one (so the backstop and
# restart-detection stay accurate). Emit the one-line note exactly once, only
# when a real restart was detected (topic-verified or dead-owner adoption).
record_session_id() {
  local new_id="$1"
  local tmp="${STATE_FILE}.sid.$$"
  if grep -q '^session_id:' "$STATE_FILE"; then
    sed "s/^session_id:.*/session_id: \"${new_id}\"/" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
  fi
}

if [[ "$RESTART_DETECTED" == "true" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  ITER_LABEL="${ITERATION:-?}"
  NOTE="Heads up — my session restarted mid-run and I've picked the autonomous job back up (topic ${REPORT_TOPIC:-?}, iteration ${ITER_LABEL}). No action needed."
  # Durable audit record (always).
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","event":"restart-resume","topic":"%s","oldSession":"%s","newSession":"%s","method":"%s","iteration":"%s"}\n' \
    "$TS" "${REPORT_TOPIC:-}" "$STATE_SESSION" "$HOOK_SESSION" "$OWNER_METHOD" "$ITER_LABEL" >> "$RECOVERY_AUDIT" 2>/dev/null || true
  # Best-effort user-facing delivery (structural — the hook sends, not the agent).
  if [[ -n "$REPORT_TOPIC" ]]; then
    if [[ -x ".instar/scripts/telegram-reply.sh" ]]; then
      printf '%s\n' "$NOTE" | .instar/scripts/telegram-reply.sh "$REPORT_TOPIC" >/dev/null 2>&1 || true
    elif [[ -x ".claude/scripts/telegram-reply.sh" ]]; then
      printf '%s\n' "$NOTE" | .claude/scripts/telegram-reply.sh "$REPORT_TOPIC" >/dev/null 2>&1 || true
    fi
  fi
  echo "[autonomous] restart-resume: topic=${REPORT_TOPIC:-?} old=$STATE_SESSION new=$HOOK_SESSION method=$OWNER_METHOD" >&2
fi

# Reconcile recorded session_id to live (covers restart, bootstrap, adopt).
if [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  record_session_id "$HOOK_SESSION"
fi

# ── Continue the job: increment iteration, feed the task back. ────────
NEXT_ITERATION=$((ITERATION + 1))

PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")
if [[ -z "$PROMPT_TEXT" ]]; then
  echo "⚠️  Autonomous mode: State file has no task content" >&2
  rm -f "$STATE_FILE"
  exit 0
fi

TEMP_FILE="${STATE_FILE}.iter.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE" && mv "$TEMP_FILE" "$STATE_FILE"

# ── Progress Report Check ──
REPORT_INTERVAL=$(fm_get report_interval)
LAST_REPORT_AT=$(fm_get last_report_at)

REPORT_INTERVAL_SECS=1800  # default 30 minutes
if [[ "$REPORT_INTERVAL" =~ ^([0-9]+)m$ ]]; then
  REPORT_INTERVAL_SECS=$(( ${BASH_REMATCH[1]} * 60 ))
elif [[ "$REPORT_INTERVAL" =~ ^([0-9]+)h$ ]]; then
  REPORT_INTERVAL_SECS=$(( ${BASH_REMATCH[1]} * 3600 ))
fi

REPORT_DUE="false"
NOW_EPOCH=$(date +%s)
if [[ -z "$LAST_REPORT_AT" ]] || [[ "$LAST_REPORT_AT" == "null" ]]; then
  if [[ -n "$STARTED_AT" ]]; then
    START_EPOCH_R=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null || date -d "$STARTED_AT" +%s 2>/dev/null || echo "0")
    ELAPSED_SINCE_START=$(( NOW_EPOCH - START_EPOCH_R ))
    if [[ $ELAPSED_SINCE_START -ge $REPORT_INTERVAL_SECS ]]; then
      REPORT_DUE="true"
    fi
  fi
else
  LAST_REPORT_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_REPORT_AT" +%s 2>/dev/null || date -d "$LAST_REPORT_AT" +%s 2>/dev/null || echo "0")
  ELAPSED_SINCE_REPORT=$(( NOW_EPOCH - LAST_REPORT_EPOCH ))
  if [[ $ELAPSED_SINCE_REPORT -ge $REPORT_INTERVAL_SECS ]]; then
    REPORT_DUE="true"
  fi
fi

REPORT_DIRECTIVE=""
if [[ "$REPORT_DUE" == "true" ]]; then
  REPORT_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if grep -q '^last_report_at:' "$STATE_FILE"; then
    TEMP_FILE2="${STATE_FILE}.rpt.$$"
    sed "s/^last_report_at: .*/last_report_at: \"$REPORT_NOW\"/" "$STATE_FILE" > "$TEMP_FILE2" && mv "$TEMP_FILE2" "$STATE_FILE"
  else
    TEMP_FILE2="${STATE_FILE}.rpt.$$"
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
