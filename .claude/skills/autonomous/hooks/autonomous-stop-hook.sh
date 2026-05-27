#!/bin/bash

# Autonomous Mode Stop Hook
# Prevents session exit when autonomous mode is active.
# Feeds the goal and task list back to continue working.
#
# MULTI-SESSION (per-topic state): each autonomous job has its own state file at
# .instar/autonomous/<topicId>.local.md, so multiple topics can run autonomous
# jobs concurrently without colliding. This session resolves its own topic (from
# its tmux session name via the topic-session registry) and reads THAT topic's
# state file. Ownership is therefore implicit: if my topic's file exists and is
# active, I am its worker. A legacy single-file job (.instar/autonomous-state.local.md)
# is still honored for back-compat and migrated to the per-topic path on first touch.
#
# TOPIC-KEYED OWNERSHIP survives restarts: a memory-limit restart rotates the
# Claude session UUID but instar respawns into the SAME tmux name, which still
# maps to the same topic — so the restarted session reads the same per-topic file
# and keeps going. (Legacy-file path keeps the v1.2.55 topic-or-liveness backstop.)
#
# RECOVERY NOTE: on a real restart-and-resume (topic file found but the recorded
# session UUID changed) the hook emits ONE channel-neutral recovery note + audit
# record, then records the new UUID so it never repeats.
#
# RESPECTS: emergency stop, duration expiry, genuine completion (promise).

set -uo pipefail   # NOTE: -e intentionally omitted; field lookups for optional
                   # frontmatter keys are expected to "fail" (grep finds nothing)
                   # and must not abort the hook. Each critical step guards itself.

# Read hook input from stdin
HOOK_INPUT=$(cat)

REGISTRY_FILE=".instar/topic-session-registry.json"
RECOVERY_AUDIT=".instar/autonomous-recovery.jsonl"
LEGACY_STATE=".instar/autonomous-state.local.md"
MULTI_DIR=".instar/autonomous"
LIVENESS_SECS="${INSTAR_AUTONOMOUS_LIVENESS_SECS:-120}"

# ── Inputs from the hook ──────────────────────────────────────────────
HOOK_SESSION=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")

# If hook has no session_id → fail OPEN (unknown context, don't trap)
if [[ -z "$HOOK_SESSION" ]]; then
  echo "⚠️  Autonomous mode: No session_id in hook input — fail-open (allowing exit)" >&2
  exit 0
fi

# ── Resolve MY tmux session name (the stable address) ─────────────────
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

# Reverse-lookup: which topic does MY tmux session serve? (topicToSession is
# topic→tmux; we invert it to find my topic.)
MY_TOPIC=""
if [[ -n "$MY_TMUX" ]] && [[ -f "$REGISTRY_FILE" ]]; then
  MY_TOPIC=$(INSTAR_MY_TMUX="$MY_TMUX" python3 -c "
import json, os
try:
    reg = json.load(open('$REGISTRY_FILE'))
    me = os.environ['INSTAR_MY_TMUX']
    t2s = reg.get('topicToSession') or {}
    hit = [k for k, v in t2s.items() if v == me]
    print(hit[0] if hit else '')
except Exception:
    print('')
" 2>/dev/null || echo "")
fi

# Helper: read a frontmatter field from an arbitrary state file (pipefail-safe).
fm_get_from() {
  local file="$1" key="$2"
  sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$file" 2>/dev/null | grep "^${key}:" | head -1 | sed "s/^${key}: *//" | tr -d '"' || true
}

# ── Select the state file (per-topic preferred; legacy fallback + migrate) ──
STATE_FILE=""
OWNED_VIA_TOPIC="false"
PER_TOPIC_FILE=""
[[ -n "$MY_TOPIC" ]] && PER_TOPIC_FILE="$MULTI_DIR/${MY_TOPIC}.local.md"

if [[ -n "$PER_TOPIC_FILE" ]] && [[ -f "$PER_TOPIC_FILE" ]]; then
  STATE_FILE="$PER_TOPIC_FILE"
  OWNED_VIA_TOPIC="true"
elif [[ -f "$LEGACY_STATE" ]]; then
  # A legacy single-file job exists. If it belongs to MY topic, migrate it to the
  # per-topic path (idempotent, never disrupts the running job — same content).
  LEGACY_TOPIC=$(fm_get_from "$LEGACY_STATE" report_topic)
  if [[ -n "$MY_TOPIC" ]] && [[ "$LEGACY_TOPIC" == "$MY_TOPIC" ]]; then
    mkdir -p "$MULTI_DIR"
    if mv "$LEGACY_STATE" "$PER_TOPIC_FILE" 2>/dev/null; then
      STATE_FILE="$PER_TOPIC_FILE"; OWNED_VIA_TOPIC="true"
      echo "[autonomous] migrated legacy state → $PER_TOPIC_FILE" >&2
    else
      STATE_FILE="$LEGACY_STATE"
    fi
  else
    # Legacy job for a different/unknown topic — honor it via the legacy
    # ownership logic below (preserves v1.2.55 behavior for in-flight jobs).
    STATE_FILE="$LEGACY_STATE"
  fi
else
  # No autonomous job for this session anywhere — allow exit.
  exit 0
fi

# ── Read the selected state file ──────────────────────────────────────
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
fm_get() {
  local key="$1"
  printf '%s\n' "$FRONTMATTER" | grep "^${key}:" | head -1 | sed "s/^${key}: *//" | tr -d '"' || true
}

ACTIVE=$(fm_get active)
if [[ "$ACTIVE" != "true" ]]; then
  exit 0
fi

# Paused (e.g. by quota-pressure load-shedding) — allow exit until resumed.
PAUSED=$(fm_get paused)
if [[ "$PAUSED" == "true" ]]; then
  echo "[autonomous] job paused — allowing exit until resumed" >&2
  exit 0
fi

REPORT_TOPIC=$(fm_get report_topic)
# Channel that owns this job — recovery note routes here. Default telegram for
# back-compat (state files written before channel-neutral delivery existed).
REPORT_CHANNEL=$(fm_get report_channel)
[[ -z "$REPORT_CHANNEL" ]] && REPORT_CHANNEL="telegram"
STATE_SESSION=$(fm_get session_id)
ITERATION=$(fm_get iteration)
DURATION_SECONDS=$(fm_get duration_seconds)
STARTED_AT=$(fm_get started_at)
COMPLETION_PROMISE=$(fm_get completion_promise)
COMPLETION_CONDITION=$(fm_get completion_condition)
GOAL_MODE=$(fm_get goal_mode)   # "native" = the framework's own /goal loop drives completion
RUN_GOAL=$(fm_get goal)

# ── Layer A: notify-on-stop (2026-05-27 silent-stalls postmortem, Task 2) ──────
# When an autonomous run reaches a TERMINAL exit (completion / duration / emergency),
# send ONE plain-English Telegram to the run's report topic explaining why it
# stopped. Closes Justin's "a session either keeps going OR tells me why it
# stopped" requirement structurally: previously every terminal exit only echoed
# to stderr (the terminal the user can't see), so an autonomous run could end in
# silence. Best-effort + NON-BLOCKING — a delivery failure never blocks the exit.
# Fires at most once per run (the state file is removed right after each terminal
# exit, so the hook won't re-enter). Reuses telegram-reply.sh (the same transport
# the restart-resume recovery note uses), and only for the telegram channel.
goal_snippet() {
  printf '%s' "${RUN_GOAL:-the autonomous run}" | tr '\n\t' '  ' | cut -c1-80
}
notify_terminal_stop() {
  local msg="$1"
  [[ -z "$REPORT_TOPIC" ]] && return 0
  [[ "${REPORT_CHANNEL:-telegram}" != "telegram" ]] && return 0
  local script=""
  if [[ -x ".instar/scripts/telegram-reply.sh" ]]; then script=".instar/scripts/telegram-reply.sh"
  elif [[ -x ".claude/scripts/telegram-reply.sh" ]]; then script=".claude/scripts/telegram-reply.sh"
  fi
  [[ -z "$script" ]] && return 0
  printf '%s\n' "$msg" | "$script" "$REPORT_TOPIC" >/dev/null 2>&1 || true
}

# Validate recorded session_id is a real UUID. Claude sometimes writes a custom
# string instead of $CLAUDE_CODE_SESSION_ID; non-UUID values are treated as
# empty so the session-match backstop self-bootstraps from the real UUID.
UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [[ -n "$STATE_SESSION" ]] && ! [[ "$STATE_SESSION" =~ $UUID_REGEX ]]; then
  echo "[autonomous] Invalid session_id in state file (not UUID): '$STATE_SESSION' — clearing" >&2
  STATE_SESSION=""
fi

# ── Ownership decision ────────────────────────────────────────────────
# OWNER=true means: this session IS the autonomous worker; block its exit.
# OWNER_METHOD: topic (per-topic file) | topic-legacy | session | bootstrap | adopt-dead.
OWNER="false"
OWNER_METHOD=""
RESTART_DETECTED="false"

if [[ "$OWNED_VIA_TOPIC" == "true" ]]; then
  # Reading MY topic's own file — ownership is implicit and unambiguous.
  OWNER="true"; OWNER_METHOD="topic"
  if [[ -n "$STATE_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
    RESTART_DETECTED="true"
  fi
else
  # ── Legacy single-file path: v1.2.55 topic-keyed-or-liveness-backstop ──
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

  if [[ -n "$MY_TMUX" ]] && [[ -n "$OWNER_TMUX" ]]; then
    if [[ "$MY_TMUX" == "$OWNER_TMUX" ]]; then
      OWNER="true"; OWNER_METHOD="topic-legacy"
      if [[ -n "$STATE_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
        RESTART_DETECTED="true"
      fi
    else
      exit 0   # legacy job belongs to a different session's topic
    fi
  else
    # Topic unresolved — session-id backstop, liveness-gated.
    if [[ -z "$STATE_SESSION" ]]; then
      OWNER="true"; OWNER_METHOD="bootstrap"
    elif [[ "$STATE_SESSION" == "$HOOK_SESSION" ]]; then
      OWNER="true"; OWNER_METHOD="session"
    else
      OWNER_ALIVE="false"
      if [[ -n "$TRANSCRIPT_PATH" ]]; then
        OWNER_TRANSCRIPT="$(dirname "$TRANSCRIPT_PATH")/${STATE_SESSION}.jsonl"
        if [[ -f "$OWNER_TRANSCRIPT" ]]; then
          NOW_E=$(date +%s)
          # GNU stat (-c %Y) first (Linux/CI); BSD stat (-f %m) fallback (macOS).
          # GNU `stat -f` is filesystem mode and succeeds with non-numeric output,
          # so BSD-first would mask the GNU path on Linux; numeric guard treats a
          # bad mtime as 0 (very old → dead) rather than crashing the arithmetic.
          MTIME=$(stat -c %Y "$OWNER_TRANSCRIPT" 2>/dev/null || stat -f %m "$OWNER_TRANSCRIPT" 2>/dev/null || echo 0)
          [[ "$MTIME" =~ ^[0-9]+$ ]] || MTIME=0
          AGE=$(( NOW_E - MTIME ))
          if [[ $MTIME -gt 0 ]] && [[ $AGE -lt $LIVENESS_SECS ]]; then
            OWNER_ALIVE="true"
          fi
        fi
      fi
      if [[ "$OWNER_ALIVE" == "true" ]]; then
        exit 0   # a genuinely different, live session owns this — don't steal
      fi
      OWNER="true"; OWNER_METHOD="adopt-dead"; RESTART_DETECTED="true"
    fi
  fi
fi

if [[ "$OWNER" != "true" ]]; then
  exit 0
fi

# ── Native /goal delegation: the framework's own /goal loop owns completion. ──
# instar injected "/goal <condition>" at start (goal_mode=native), so we DEFER the
# continue/stop decision to native /goal's own Stop hook (we approve/exit; its hook
# blocks until the condition is met — block wins over approve, so it stays in control).
# instar still owns its terminal STOP concerns (emergency-stop, duration) and enforces
# them by CLEARING native /goal first (inject "/goal clear" via the server).
if [[ "$GOAL_MODE" == "native" ]]; then
  native_goal_clear() {
    local port auth
    port=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
    auth=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
    jq -nc --arg t "$REPORT_TOPIC" '{topicId:$t}' \
      | curl -s -m 10 -H "Authorization: Bearer $auth" -H 'Content-Type: application/json' \
        --data-binary @- "http://localhost:${port}/autonomous/native-goal/clear" >/dev/null 2>&1 || true
  }
  if [[ -f ".instar/autonomous-emergency-stop" ]]; then
    notify_terminal_stop "🛑 My autonomous run on \"$(goal_snippet)\" was stopped (emergency stop)."
    native_goal_clear; rm -f "$STATE_FILE"
    echo "[autonomous] emergency stop — native /goal cleared" >&2; exit 0
  fi
  if [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] && [[ $DURATION_SECONDS -gt 0 ]]; then
    NG_START=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null || date -d "$STARTED_AT" +%s 2>/dev/null || echo 0)
    if [[ "$NG_START" =~ ^[0-9]+$ ]] && [[ $NG_START -gt 0 ]] && [[ $(( $(date +%s) - NG_START )) -ge $DURATION_SECONDS ]]; then
      notify_terminal_stop "⏰ My autonomous run on \"$(goal_snippet)\" hit its time limit and stopped. Ask me and I'll pick up where I left off."
      native_goal_clear; rm -f "$STATE_FILE"
      echo "[autonomous] duration expired — native /goal cleared" >&2; exit 0
    fi
  fi
  # Not terminal → let native /goal decide completion. Approve (its hook keeps control).
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
      notify_terminal_stop "⏰ My autonomous run on \"$(goal_snippet)\" just hit its time limit and stopped. Ask me and I'll pick up where I left off."
      rm -f "$STATE_FILE"
      exit 0
    fi
    REMAINING=$(( DURATION_SECONDS - ELAPSED ))
    REMAINING_MIN=$(( REMAINING / 60 ))
  else
    echo "[autonomous] started_at unparseable ('$STARTED_AT') — skipping duration-expiry check (fail-safe: keep running)" >&2
  fi
fi

# Emergency stop (global — halts every autonomous job on its next fire)
if [[ -f ".instar/autonomous-emergency-stop" ]]; then
  echo "🛑 Autonomous mode: Emergency stop detected."
  notify_terminal_stop "🛑 My autonomous run on \"$(goal_snippet)\" was stopped (emergency stop)."
  rm -f "$STATE_FILE"
  # NOTE: the emergency flag is left in place so OTHER topics' hooks also see it
  # and clear their own per-topic files; stop-all clears the flag when complete.
  exit 0
fi

# Completion CONDITION — independent evaluator (mirrors /goal). Authoritative when
# set; the self-declared promise below is the legacy fallback. FAIL-SAFE: if the
# evaluator is unreachable or unsure, we keep working — never a false "done".
EVAL_REASON=""
if [[ -n "$COMPLETION_CONDITION" ]] && [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  EVAL_MET=""
  if [[ -n "${INSTAR_HOOK_EVAL_OVERRIDE:-}" ]]; then
    # Test seam: "met" | "not-met" short-circuits the live evaluator call.
    [[ "$INSTAR_HOOK_EVAL_OVERRIDE" == "met" ]] && EVAL_MET="true"
    EVAL_REASON="override:$INSTAR_HOOK_EVAL_OVERRIDE"
  else
    EVAL_TAIL=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -6 \
      | jq -r '.message.content | map(select(.type=="text")) | map(.text) | join("\n")' 2>/dev/null \
      | tail -c 8000 || echo "")
    EVAL_PORT=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
    EVAL_AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
    EVAL_RESP=$(jq -nc --arg c "$COMPLETION_CONDITION" --arg t "$EVAL_TAIL" '{condition:$c,transcriptTail:$t}' \
      | curl -s -m 35 -H "Authorization: Bearer $EVAL_AUTH" -H 'Content-Type: application/json' \
        --data-binary @- "http://localhost:${EVAL_PORT}/autonomous/evaluate-completion" 2>/dev/null || echo "")
    EVAL_MET=$(printf '%s' "$EVAL_RESP" | jq -r '.met // empty' 2>/dev/null || echo "")
    EVAL_REASON=$(printf '%s' "$EVAL_RESP" | jq -r '.reason // empty' 2>/dev/null || echo "")
  fi
  if [[ "$EVAL_MET" == "true" ]]; then
    echo "✅ Autonomous mode: completion condition met (independent evaluator): ${EVAL_REASON}"
    notify_terminal_stop "✅ My autonomous run on \"$(goal_snippet)\" finished — the goal was met."
    rm -f "$STATE_FILE"
    exit 0
  fi
  # Not met / unreachable → keep working; EVAL_REASON (if any) becomes next-turn guidance.
fi

# Completion promise (genuine completion — legacy/self-declared fallback)
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
        notify_terminal_stop "✅ My autonomous run on \"$(goal_snippet)\" finished — all the work is done."
        rm -f "$STATE_FILE"
        exit 0
      fi
    fi
  fi
fi

# ── Not terminal: we are continuing. Handle restart-resume recovery note. ──
record_session_id() {
  local new_id="$1"
  local tmp="${STATE_FILE}.sid.$$"
  if grep -q '^session_id:' "$STATE_FILE"; then
    sed "s/^session_id:.*/session_id: \"${new_id}\"/" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
  fi
}

# Channel-neutral delivery seam (no Telegram assumption). Telegram wired; other
# channels owned by the Channel Parity initiative. Audit record is the source of truth.
deliver_recovery_note() {
  local channel="$1" target="$2" text="$3"
  [[ -z "$target" ]] && return 0
  case "$channel" in
    telegram)
      if [[ -x ".instar/scripts/telegram-reply.sh" ]]; then
        printf '%s\n' "$text" | .instar/scripts/telegram-reply.sh "$target" >/dev/null 2>&1 || true
      elif [[ -x ".claude/scripts/telegram-reply.sh" ]]; then
        printf '%s\n' "$text" | .claude/scripts/telegram-reply.sh "$target" >/dev/null 2>&1 || true
      fi
      ;;
    *)
      echo "[autonomous] recovery note for channel '$channel' recorded to audit; live delivery pending the Channel Parity initiative" >&2
      ;;
  esac
}

if [[ "$RESTART_DETECTED" == "true" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  ITER_LABEL="${ITERATION:-?}"
  NOTE="Heads up — my session restarted mid-run and I've picked the autonomous job back up (topic ${REPORT_TOPIC:-?}, iteration ${ITER_LABEL}). No action needed."
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","event":"restart-resume","channel":"%s","topic":"%s","oldSession":"%s","newSession":"%s","method":"%s","iteration":"%s"}\n' \
    "$TS" "$REPORT_CHANNEL" "${REPORT_TOPIC:-}" "$STATE_SESSION" "$HOOK_SESSION" "$OWNER_METHOD" "$ITER_LABEL" >> "$RECOVERY_AUDIT" 2>/dev/null || true
  deliver_recovery_note "$REPORT_CHANNEL" "$REPORT_TOPIC" "$NOTE"
  echo "[autonomous] restart-resume: channel=$REPORT_CHANNEL topic=${REPORT_TOPIC:-?} old=$STATE_SESSION new=$HOOK_SESSION method=$OWNER_METHOD" >&2
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

# When a completion CONDITION is set, an independent judge decides "done" — steer
# toward the condition + feed back the judge's latest reason (mirrors /goal). When
# only a legacy promise is set, keep the self-declared-promise directive.
if [[ -n "$COMPLETION_CONDITION" ]]; then
  GUIDANCE=""
  [[ -n "$EVAL_REASON" ]] && GUIDANCE=" | Not done yet: ${EVAL_REASON}"
  SYSTEM_MSG="🔄 Autonomous iteration $NEXT_ITERATION ($TIME_MSG) | Keep working until this is TRUE: ${COMPLETION_CONDITION}${GUIDANCE} | An independent check decides done from what you SURFACE — run the real checks and show the evidence. Do NOT defer — do it now${REPORT_DIRECTIVE}"
else
  SYSTEM_MSG="🔄 Autonomous iteration $NEXT_ITERATION ($TIME_MSG) | Complete ALL tasks, then output <promise>$COMPLETION_PROMISE</promise> | Do NOT defer to future self — if you can do it now, DO IT NOW${REPORT_DIRECTIVE}"
fi

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
