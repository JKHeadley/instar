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
COMPLETION_CONDITION=""   # verifiable end-state; an independent judge decides "done" (mirrors /goal). Preferred over the self-declared promise.
REPORT_INTERVAL="30m"
VERIFICATION_COMMAND=""   # opt-in real check (ACT-152): the stop-hook RUNS this on a met:true verdict and gates the exit on exit-0.
VERIFICATION_CWD=""       # directory the verification command runs in (resolves verification_cwd → work_dir → agent home).
DECLARED_DELIVERABLES=""  # SCOPE_ACCRETION: comma-separated repo-relative paths the run is EXPECTED to
                          # produce as drafts (the escape for genuinely draft-only missions — operator-
                          # confirmed at setup). Recorded server-side at registration; immutable mid-run.

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
    --completion-condition)
      COMPLETION_CONDITION="$2"
      shift 2
      ;;
    --verification-command)
      VERIFICATION_COMMAND="$2"
      shift 2
      ;;
    --verification-cwd)
      VERIFICATION_CWD="$2"
      shift 2
      ;;
    --declared-deliverables)
      DECLARED_DELIVERABLES="$2"
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

# ── COMPLETION_DISCIPLINE — bounded-duration backstop (spec §4 resolved Open-Q) ──
# A run under completion-discipline REQUIRES a duration > 0 (the hard backstop that
# makes the judge fail-open safe). A 0/unset duration is treated as a config error and
# defaulted to a conservative 8h, rather than running truly unbounded.
if [[ "$DURATION_SECONDS" -le 0 ]]; then
  echo "⚠️  No bounded duration set — defaulting to 8h (completion-discipline requires a duration backstop)." >&2
  DURATION_SECONDS=28800
  DURATION="8h"
  END_AT=$(date -u -v+${DURATION_SECONDS}S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${DURATION_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")
fi

# ── COMPLETION_DISCIPLINE — per-run hard-blocker nonce ──
# Authenticates a <hard-blocker> terminal exit marker (mirrors the completion_promise
# exact-match guard) so incidental marker prose can never trip an exit. Spec §2b.3.
HARD_BLOCKER_NONCE=$(openssl rand -hex 8 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' || echo "$(date +%s)$$")

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

# ── REALCHECK_VERIFY — Real-check verification fields (ACT-152). work_dir is ALWAYS
# captured so the hook resolves the command's CWD structurally (verification_cwd →
# work_dir → agent home) — the worktree-default build runs OUTSIDE the agent home,
# and a relative `npm test` from the home would test the wrong tree. The verification_*
# fields are OMITTED when the flags are absent (→ byte-identical to today). This
# REALCHECK_VERIFY sentinel is the PostUpdateMigrator marker that re-deploys this setup
# to existing agents carrying COMPLETION_DISCIPLINE but not REALCHECK_VERIFY. ──
WORK_DIR="$(pwd)"
VERIFICATION_FIELDS="work_dir: \"$WORK_DIR\""
if [[ -n "$VERIFICATION_COMMAND" ]]; then
  VERIFICATION_FIELDS="verification_command: \"$VERIFICATION_COMMAND\"
$VERIFICATION_FIELDS"
fi
if [[ -n "$VERIFICATION_CWD" ]]; then
  VERIFICATION_FIELDS="verification_cwd: \"$VERIFICATION_CWD\"
$VERIFICATION_FIELDS"
fi

# ── SCOPE_ACCRETION — server-side run registration (spec: autonomous-scope-
# accretion-completion.md R30). The SERVER mints the runId, snapshots the
# scopeAccretion config + the sweep base roots with their start-SHAs, and clamps
# endAt — so mid-run edits to config/state-file change nothing the completion
# chokepoint reads. The runId is written into the frontmatter so the stop hook
# can echo it on every evaluate-completion / run-end call. Best-effort: an
# unreachable server leaves run_id empty (the gate degrades honestly server-side;
# the run still starts — registration is a discipline layer, not a start gate).
RUN_ID=""
if [[ -n "$REPORT_TOPIC" ]]; then
  REG_PORT=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
  REG_AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  # Comma-separated → JSON array (empty string → []).
  REG_DECLARED=$(printf '%s' "$DECLARED_DELIVERABLES" | python3 -c "import sys,json
print(json.dumps([p.strip() for p in sys.stdin.read().split(',') if p.strip()]))" 2>/dev/null || echo '[]')
  REG_END_AT="$END_AT"
  [[ "$REG_END_AT" == "unknown" || "$REG_END_AT" == "unlimited" ]] && REG_END_AT=""
  REG_RESP=$(jq -nc \
    --arg t "$REPORT_TOPIC" --arg c "$COMPLETION_CONDITION" --arg w "$WORK_DIR" \
    --arg s "$STARTED_AT" --arg e "$REG_END_AT" --arg sid "${CLAUDE_CODE_SESSION_ID:-}" \
    --argjson d "$REG_DECLARED" \
    '{topicId:$t,condition:$c,workDir:$w,declaredDeliverables:$d,startedAt:$s}
     + (if $e != "" then {endAt:$e} else {} end)
     + (if $sid != "" then {sessionId:$sid} else {} end)' 2>/dev/null \
    | curl -s -m 8 -H "Authorization: Bearer $REG_AUTH" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:${REG_PORT}/autonomous/register" 2>/dev/null || echo "")
  RUN_ID=$(printf '%s' "$REG_RESP" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('runId',''))
except Exception: print('')" 2>/dev/null || echo "")
  if [[ -n "$RUN_ID" ]]; then
    echo "  Scope-accretion: run registered server-side (runId $RUN_ID)"
  else
    echo "  Scope-accretion: server registration unavailable — accretion gate degrades honestly (run still bounded by duration)"
  fi
fi
if [[ -n "$RUN_ID" ]]; then
  VERIFICATION_FIELDS="run_id: \"$RUN_ID\"
$VERIFICATION_FIELDS"
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
completion_condition: "$COMPLETION_CONDITION"
hard_blocker_nonce: "$HARD_BLOCKER_NONCE"
$VERIFICATION_FIELDS
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

# ── Native /goal delegation: where the framework has a native /goal loop, hand the
# condition to it (instar injects "/goal <condition>" via the server → SessionManager
# send-keys) and mark goal_mode:native so the stop-hook defers completion to it. Only
# with a condition + a per-topic job + Claude Code >= 2.1.139. Best-effort: on any miss
# we leave goal_mode empty and instar's own independent evaluator drives (Phase 1).
if [[ -n "$COMPLETION_CONDITION" ]] && [[ -n "$REPORT_TOPIC" ]]; then
  CLAUDE_VER=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
  NATIVE_GOAL_OK="false"
  if [[ -n "$CLAUDE_VER" ]]; then
    # /goal requires Claude Code >= 2.1.139.
    if [[ "$(printf '%s\n2.1.139\n' "$CLAUDE_VER" | sort -V | head -1)" == "2.1.139" ]]; then
      NATIVE_GOAL_OK="true"
    fi
  fi
  # Codex agents have their OWN native /goal loop — the Claude Code version gate above does
  # not apply (`claude --version` is empty for a codex agent), which previously left codex
  # autonomous jobs in Phase-1 (the dark codexLoopDriver, a no-op) so they never sustained
  # multi-turn. Detect a codex agent via config enabledFrameworks and enable native /goal
  # delegation so codex autonomous mode auto-sustains multi-turn via /goal — parity with
  # Claude's stop-hook auto-sustain. (Proven: codex /goal sustains 1→2→3 across turns.)
  if [[ "$NATIVE_GOAL_OK" != "true" ]]; then
    IS_CODEX_AGENT=$(python3 -c "import json;print('1' if 'codex-cli' in (json.load(open('.instar/config.json')).get('enabledFrameworks') or []) else '0')" 2>/dev/null || echo "0")
    [[ "$IS_CODEX_AGENT" == "1" ]] && NATIVE_GOAL_OK="true"
  fi
  if [[ "$NATIVE_GOAL_OK" == "true" ]]; then
    NG_PORT=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
    NG_AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
    jq -nc --arg t "$REPORT_TOPIC" --arg c "$COMPLETION_CONDITION" '{topicId:$t,condition:$c}' \
      | curl -s -m 8 -H "Authorization: Bearer $NG_AUTH" -H 'Content-Type: application/json' \
        --data-binary @- "http://localhost:${NG_PORT}/autonomous/native-goal/set" >/dev/null 2>&1 \
      && echo "  Native /goal: handed condition to Claude Code's /goal loop" \
      || echo "  Native /goal: unavailable — using instar's own completion evaluator"
  fi
fi

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
