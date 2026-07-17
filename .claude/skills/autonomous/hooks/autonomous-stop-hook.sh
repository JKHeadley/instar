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

# ── Framework arg: --codex marks the codex (vs Claude) registration of this shared
# hook (installCodexHooks adds it to .codex/hooks.json as `… --codex`). Claude invokes
# the hook with NO args, so IS_CODEX stays 0 and the entire Claude path below is
# byte-for-byte unchanged. Under codex it lets us (a) anchor via this script's own path
# (codex doesn't set CLAUDE_PROJECT_DIR) and (b) self-gate on the codexLoopDriver flag. ──
IS_CODEX=0
for _arg in "$@"; do [[ "$_arg" == "--codex" ]] && IS_CODEX=1; done

# hook-capability: codex-stdout-json-safe — see emit() below (migration marker; bumped so
# existing #28 installs re-deploy this fixed hook even though they already have CODEX_LOOP_ENABLED).
# hook-capability: REALCHECK_VERIFY — ACT-152 real-check gate (realcheck_gate runs an opt-in
# verification_command on a met:true verdict and gates the exit on it; fail/timeout/breaker-open →
# keep working, the safe direction). This sentinel is the PostUpdateMigrator marker that re-deploys
# this hook to existing agents that carry COMPLETION_DISCIPLINE but not REALCHECK_VERIFY.
# hook-capability: SCOPE_ACCRETION — scope-accretion completion discipline (spec:
# autonomous-scope-accretion-completion.md). Layer B evasion-vocabulary scan (advisory
# scopeAccretionSuspected signal, fenced/quoted-region excluded), topicId/runId/sessionId echoed
# to the evaluate-completion chokepoint (the server computes the LOAD-BEARING git-truth sweep +
# ratification state there), and run_end_call fired on EVERY terminal exit surface (R40/R44) so
# no exit is silent. This sentinel is the PostUpdateMigrator marker that re-deploys this hook to
# existing agents that carry REALCHECK_VERIFY but not SCOPE_ACCRETION.
# hook-capability: TASK_CONTINUATION — ordinary Codex interactive work may use
# the same trusted Stop boundary when an explicit bounded task ledger is live.
# emit — human-facing approve/status text. In codex mode the Stop hook's STDOUT must be
# ONLY valid decision-JSON (the `{"decision":"block",...}` case far below) or empty:
# codex rejects ANY other stdout as "invalid stop hook JSON output" and reports the stop
# hook as FAILED (observed live 2026-05-31 — a completion-promise approve echoed plain
# text to stdout, so codex logged "Stop hook (failed)" on every terminal stop with the
# loop flag on). So in codex mode these messages go to STDERR; Claude keeps them on
# STDOUT (unchanged — Claude surfaces approve-path stdout to the user). The block-decision
# JSON is printed directly (never via emit), so it always reaches stdout.
emit() { if [[ "$IS_CODEX" == "1" ]]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }

# ── Anchor to the agent home, NOT the session's CWD ───────────────────
# All state paths below are relative (.instar/autonomous/<topic>.local.md, the
# registry, the legacy file). The Stop hook inherits the session's working
# directory — and a session working inside a git worktree (~/.instar/agents/
# <name>/.worktrees/<slug>) would resolve those paths against the WORKTREE,
# which has no autonomous state, so the hook sees "no active job" and lets the
# session exit — silently stranding the autonomous loop. Anchor to the agent
# home (where this hook is installed) so the paths resolve regardless of CWD.
# (Root cause of the 2026-05-29 strand: CWD was a worktree.)
# Anchor to CLAUDE_PROJECT_DIR — Claude Code always sets it for hooks to the
# agent home (the hook itself is wired as `${CLAUDE_PROJECT_DIR}/.claude/...`).
# Guard on its `.instar` so a misconfigured value can't send us somewhere wrong;
# when unset (e.g. an isolated test harness) we stay in the caller's CWD.
if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]] && [[ -d "${CLAUDE_PROJECT_DIR}/.instar" ]]; then
  cd "$CLAUDE_PROJECT_DIR" || true
elif [[ "$IS_CODEX" == "1" ]]; then
  # Codex doesn't set CLAUDE_PROJECT_DIR. Derive the agent home from THIS script's own
  # absolute path — installed at <home>/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh
  # — so the relative state paths resolve regardless of the codex session's CWD (the same
  # worktree-strand class the Claude anchor above guards against).
  _SD="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  _AH="$(cd "${_SD}/../../../.." 2>/dev/null && pwd)"
  if [[ -n "${_AH:-}" ]] && [[ -d "${_AH}/.instar" ]]; then cd "$_AH" || true; fi
fi

# ── Codex dark-launch gate ────────────────────────────────────────────
# The codex loop driver ships DARK: when invoked from codex, only proceed if
# autonomousSessions.codexLoopDriver.enabled is true. Otherwise approve (exit 0) so a
# normal codex stop is unaffected — this is the instant-rollback flag (flip it off and
# the standing hook is a no-op again, no redeploy). Claude (IS_CODEX=0) skips this.
CODEX_TASK_CONTINUATION_ENABLED=0
if [[ "$IS_CODEX" == "1" ]]; then
  CODEX_GATES=$(python3 -c "
import json
try:
    c = json.load(open('.instar/config.json'))
    a = (c.get('autonomousSessions') or {}).get('codexLoopDriver') or {}
    t = (c.get('autonomousSessions') or {}).get('codexTaskContinuation') or {}
    print(('1' if a.get('enabled') else '0') + ':' + ('1' if t.get('enabled') else '0'))
except Exception:
    print('0:0')
" 2>/dev/null || echo "0:0")
  CODEX_LOOP_ENABLED="${CODEX_GATES%%:*}"
  CODEX_TASK_CONTINUATION_ENABLED="${CODEX_GATES##*:}"
  if [[ "$CODEX_LOOP_ENABLED" != "1" ]] && [[ "$CODEX_TASK_CONTINUATION_ENABLED" != "1" ]]; then
    exit 0
  fi
fi

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
  # No autonomous job for this session. Ordinary Codex interactive work may
  # still own an explicit bounded continuation ledger. The server is the sole
  # mutation/decision authority; empty/invalid state returns allow.
  if [[ "$IS_CODEX" == "1" ]] && [[ "$CODEX_TASK_CONTINUATION_ENABLED" == "1" ]] && [[ -n "$MY_TOPIC" ]]; then
    _PORT=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
    _AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
    _DECISION=$(jq -nc --arg topicId "$MY_TOPIC" --arg sessionId "$HOOK_SESSION" '{topicId:$topicId,sessionId:$sessionId}' \
      | curl -sS -m 5 -H "Authorization: Bearer $_AUTH" -H 'Content-Type: application/json' \
        --data-binary @- "http://127.0.0.1:${_PORT}/continuation/decide" 2>/dev/null || echo "")
    if [[ "$(printf '%s' "$_DECISION" | jq -r '.decision // ""' 2>/dev/null)" == "continue" ]]; then
      _REASON=$(printf '%s' "$_DECISION" | jq -r '.reasonText // "Continue the explicit open task list."' 2>/dev/null)
      jq -nc --arg reason "$_REASON" '{decision:"block",reason:$reason}'
    fi
  fi
  # No autonomous job or open continuation ledger — allow exit.
  exit 0
fi

# An autonomous state owns this turn. Its own Codex gate remains authoritative;
# enabling ordinary task continuation must never implicitly enable autonomous jobs.
if [[ "$IS_CODEX" == "1" ]] && [[ "$CODEX_LOOP_ENABLED" != "1" ]]; then
  exit 0
fi

# ── Read the selected state file ──────────────────────────────────────
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
fm_get() {
  local key="$1"
  printf '%s\n' "$FRONTMATTER" | grep "^${key}:" | head -1 | sed "s/^${key}: *//" | tr -d '"' || true
}
# Quote-PRESERVING field read — identical to fm_get but WITHOUT the `tr -d '"'`,
# so a value containing literal quotes (e.g. a verification_command with quoted
# args) survives intact. Strips ONLY a single pair of wrapping double-quotes (the
# YAML frontmatter the setup script writes as `key: "value"`), never inner quotes.
fm_get_raw() {
  local key="$1" val
  val=$(printf '%s\n' "$FRONTMATTER" | grep "^${key}:" | head -1 | sed "s/^${key}: *//" || true)
  # Strip one leading + one trailing double-quote if both present (preserve inner).
  if [[ "$val" == \"*\" ]]; then val="${val#\"}"; val="${val%\"}"; fi
  printf '%s' "$val"
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
# Real-check verification (ACT-152) — opt-in declared command + its build dir.
# Read QUOTE-PRESERVING: a verification_command may contain literal quotes that
# fm_get's `tr -d '"'` would mangle. Absent on older state files → empty → the
# real-check gate self-disables for that run (byte-identical to today).
VERIFICATION_COMMAND=$(fm_get_raw verification_command)
VERIFICATION_CWD=$(fm_get_raw verification_cwd)
WORK_DIR=$(fm_get_raw work_dir)
# COMPLETION_DISCIPLINE — per-run nonce that authenticates a <hard-blocker> exit
# marker (mirrors the completion_promise exact-match guard). Absent on older
# state files → the marker branch self-disables for that run (no false exit).
HARD_BLOCKER_NONCE=$(fm_get hard_blocker_nonce)
# SCOPE_ACCRETION — the server-minted run id written by setup at registration
# (POST /autonomous/register). Echoed on evaluate-completion + run-end calls so
# the server can verify the (topicId, runId) pair against its OWN registration
# record. Absent on older/unregistered runs → the server degrades honestly.
RUN_ID=$(fm_get run_id)

# ── COMPLETION_DISCIPLINE — off-switch + judge curl budget (read at the chokepoint) ──
# Autonomous Completion Discipline (spec: AUTONOMOUS-COMPLETION-DISCIPLINE.md).
# Read here so toggling takes effect on the NEXT stop with no session restart
# (mirrors the codexLoopDriver python3 read above). When disabled, the hook reverts
# to the prior promise/condition + prior P13 path: no milestone/injection scans, no
# signals payload, no (a) hard-blocker branch. The judgeTimeoutMs dial bounds the
# judge `curl -m` (DISTINCT from the registered hook timeout, which is effectively
# unbounded at 10000 seconds). Defaults: enabled=true, judgeTimeoutMs=35000.
CD_CFG=$(python3 -c "
import json
try:
    c = json.load(open('.instar/config.json'))
    a = ((c.get('autonomousSessions') or {}).get('completionDiscipline') or {})
    en = a.get('enabled', True)
    jt = a.get('judgeTimeoutMs', 35000)
    try:
        jt = int(jt)
    except Exception:
        jt = 35000
    if jt < 5000:
        jt = 5000
    bt = a.get('judgeFailBreakerThreshold', 3)
    bw = a.get('judgeFailWindowMs', 600000)
    bc = a.get('judgeFailCooldownMs', 600000)
    mc = a.get('markerFieldMaxChars', 500)
    rb = a.get('hardBlockerLogRotateBytes', 1048576)
    # Real-check verification (ACT-152) — nested under completionDiscipline.
    rc = a.get('realCheck') or {}
    rce = rc.get('enabled', True)
    rct = rc.get('timeoutMs', 120000)
    try:
        rct = int(rct)
    except Exception:
        rct = 120000
    if rct < 5000:
        rct = 5000
    rcm = rc.get('maxChars', 2000)
    rcc = rc.get('captureBytes', 65536)
    rcbt = rc.get('failBreakerThreshold', 3)
    rcbw = rc.get('failWindowMs', 600000)
    rcbc = rc.get('failCooldownMs', 600000)
    # SCOPE_ACCRETION — Layer B advisory scan gate. NOTE: the LOAD-BEARING gate
    # is snapshotted SERVER-SIDE at registration (this local read only gates the
    # hook's ADVISORY scopeAccretionSuspected field, keeping the judge prompt
    # byte-identical when the feature is off).
    sa = a.get('scopeAccretion') or {}
    sae = sa.get('enabled', True)
    print('%s %d %d %d %d %d %d %s %d %d %d %d %d %d %s' % (
        '1' if en else '0', jt,
        int(bt) if str(bt).isdigit() else 3,
        int(bw) if str(bw).isdigit() else 600000,
        int(bc) if str(bc).isdigit() else 600000,
        int(mc) if str(mc).isdigit() else 500,
        int(rb) if str(rb).isdigit() else 1048576,
        '1' if rce else '0', rct,
        int(rcm) if str(rcm).isdigit() else 2000,
        int(rcc) if str(rcc).isdigit() else 65536,
        int(rcbt) if str(rcbt).isdigit() else 3,
        int(rcbw) if str(rcbw).isdigit() else 600000,
        int(rcbc) if str(rcbc).isdigit() else 600000,
        '1' if sae else '0',
    ))
except Exception:
    print('1 35000 3 600000 600000 500 1048576 1 120000 2000 65536 3 600000 600000 1')
" 2>/dev/null || echo "1 35000 3 600000 600000 500 1048576 1 120000 2000 65536 3 600000 600000 1")
read -r CD_ENABLED JUDGE_TIMEOUT_MS CD_BREAKER_THRESHOLD CD_BREAKER_WINDOW_MS CD_BREAKER_COOLDOWN_MS CD_MARKER_MAX_CHARS CD_LOG_ROTATE_BYTES RC_ENABLED RC_TIMEOUT_MS RC_MAX_CHARS RC_CAPTURE_BYTES RC_BREAKER_THRESHOLD RC_BREAKER_WINDOW_MS RC_BREAKER_COOLDOWN_MS SA_ENABLED <<< "$CD_CFG"
[[ "$CD_ENABLED" =~ ^[01]$ ]] || CD_ENABLED=1
[[ "${SA_ENABLED:-}" =~ ^[01]$ ]] || SA_ENABLED=1
[[ "$JUDGE_TIMEOUT_MS" =~ ^[0-9]+$ ]] || JUDGE_TIMEOUT_MS=35000
# curl -m takes SECONDS; convert ms→s (ceil), floor 5s.
JUDGE_TIMEOUT_S=$(( (JUDGE_TIMEOUT_MS + 999) / 1000 ))
[[ $JUDGE_TIMEOUT_S -lt 5 ]] && JUDGE_TIMEOUT_S=5
# ── Real-check verification dials (ACT-152) — validated + ms→s for the command timeout ──
[[ "$RC_ENABLED" =~ ^[01]$ ]] || RC_ENABLED=1
[[ "$RC_TIMEOUT_MS" =~ ^[0-9]+$ ]] || RC_TIMEOUT_MS=120000
RC_TIMEOUT_S=$(( (RC_TIMEOUT_MS + 999) / 1000 ))
[[ $RC_TIMEOUT_S -lt 5 ]] && RC_TIMEOUT_S=5
[[ "$RC_MAX_CHARS" =~ ^[0-9]+$ ]] || RC_MAX_CHARS=2000
[[ "$RC_CAPTURE_BYTES" =~ ^[0-9]+$ ]] || RC_CAPTURE_BYTES=65536
[[ "$RC_BREAKER_THRESHOLD" =~ ^[0-9]+$ ]] || RC_BREAKER_THRESHOLD=3
[[ "$RC_BREAKER_WINDOW_MS" =~ ^[0-9]+$ ]] || RC_BREAKER_WINDOW_MS=600000
[[ "$RC_BREAKER_COOLDOWN_MS" =~ ^[0-9]+$ ]] || RC_BREAKER_COOLDOWN_MS=600000
# logs/ resolves against the agent home we cd'd into above (CWD is the agent home).
HARD_BLOCKER_LOG="logs/autonomous-hard-blocker.jsonl"
REALCHECK_LOG="logs/autonomous-realcheck.jsonl"

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

# SCOPE_ACCRETION — run-end reporting (R44): EVERY terminal exit surface calls
# POST /autonomous/:topic/run-end so the server runs the non-blocking advisory
# sweep and, when unbuilt accreted work remains, enumerates it LOUDLY (R40 —
# the silent clock-out is structurally closed; the emergency-stop lever buys a
# faster exit, never a quieter one). Best-effort + `-m`-bounded: a delivery
# failure NEVER blocks or delays the exit (the R28b daily sweep is the backstop).
run_end_call() {
  local reason="$1"
  [[ -z "$REPORT_TOPIC" ]] && return 0
  # Test seam: record the would-be call instead of hitting the server.
  if [[ -n "${INSTAR_HOOK_RUNEND_RECORD:-}" ]]; then
    printf '{"topic":"%s","reason":"%s","runId":"%s"}\n' "$REPORT_TOPIC" "$reason" "${RUN_ID:-}" \
      >> "$INSTAR_HOOK_RUNEND_RECORD" 2>/dev/null || true
    return 0
  fi
  local re_port re_auth
  re_port=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
  re_auth=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  jq -nc --arg r "$reason" --arg id "${RUN_ID:-}" '{reason:$r} + (if $id != "" then {runId:$id} else {} end)' 2>/dev/null \
    | curl -s -m 8 -H "Authorization: Bearer $re_auth" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:${re_port}/autonomous/${REPORT_TOPIC}/run-end" >/dev/null 2>&1 || true
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
    run_end_call "emergency-stop (native-goal)"
    native_goal_clear; rm -f "$STATE_FILE"
    echo "[autonomous] emergency stop — native /goal cleared" >&2; exit 0
  fi
  if [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] && [[ $DURATION_SECONDS -gt 0 ]]; then
    NG_START=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null || date -d "$STARTED_AT" +%s 2>/dev/null || echo 0)
    if [[ "$NG_START" =~ ^[0-9]+$ ]] && [[ $NG_START -gt 0 ]] && [[ $(( $(date +%s) - NG_START )) -ge $DURATION_SECONDS ]]; then
      notify_terminal_stop "⏰ My autonomous run on \"$(goal_snippet)\" hit its time limit and stopped. Ask me and I'll pick up where I left off."
      run_end_call "duration-expiry (native-goal)"
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
  run_end_call "state-corrupt (bad iteration)"
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
      emit "⏰ Autonomous mode: Duration expired ($ELAPSED seconds elapsed)."
      emit "   Session is free to exit."
      notify_terminal_stop "⏰ My autonomous run on \"$(goal_snippet)\" just hit its time limit and stopped. Ask me and I'll pick up where I left off."
      run_end_call "duration-expiry"
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
  emit "🛑 Autonomous mode: Emergency stop detected."
  notify_terminal_stop "🛑 My autonomous run on \"$(goal_snippet)\" was stopped (emergency stop)."
  # SCOPE_ACCRETION: the emergency-stop file is a run-end surface a session could
  # `touch` itself — so it fires run-end IDENTICALLY (R44): the one-step bypass
  # is thereby exactly as LOUD as the two-step (spec §6).
  run_end_call "emergency-stop"
  rm -f "$STATE_FILE"
  # NOTE: the emergency flag is left in place so OTHER topics' hooks also see it
  # and clear their own per-topic files; stop-all clears the flag when complete.
  exit 0
fi

# ── COMPLETION_DISCIPLINE — deterministic signals (no LLM call) ───────────────
# Computed ONCE here so the judge (when it fires) can corroborate the prose against
# objective state, and so the COMMON keep-working iteration costs zero LLM. These
# are SIGNALS (detectors), never authorities: they FEED the judge, never block on
# their own. Spec §2b.1. All gated on CD_ENABLED — when disabled, none run and the
# hook reverts to the prior promise/condition + prior P13 path.

# The judge reads the last 6 assistant turns (~8KB). The scrutiny scans below run
# over this SAME window (NOT only the final turn) so an injection/milestone phrase
# in turns N-1..N-5 can't reach the judge as prose yet evade the corroborator
# (the scan/judge-window alignment, spec §2b.1).
CD_JUDGE_TAIL=""
CD_FINAL_TURN=""
if [[ "$CD_ENABLED" == "1" ]] && [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  CD_JUDGE_TAIL=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -6 \
    | jq -r '.message.content | map(select(.type=="text")) | map(.text) | join("\n")' 2>/dev/null \
    | tail -c 8000 || echo "")
  CD_FINAL_TURN=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 \
    | jq -r '.message.content | map(select(.type=="text")) | map(.text) | join("\n")' 2>/dev/null || echo "")
fi

# uncheckedTaskCount — the task-list checkbox scan over the state-file BODY.
#   some-unchecked (>0)            → buildable work remains
#   all-checked (0, >=1 box found) → maybe done
#   zero-checkboxes (no list)      → taskStructure=indeterminate + a conservative
#                                    non-zero count (so it never falsely greens an exit)
# The state-corruption fail-safe (rm + exit 0 on a bad iteration / no body) WINS over
# this conservative-non-zero block and runs later — this scan only applies when the
# file IS a valid state file but simply has no checkbox list (spec §2b.1).
CD_UNCHECKED_COUNT=0
CD_TASK_STRUCTURE="has-tasks"
if [[ "$CD_ENABLED" == "1" ]]; then
  CD_BODY=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE" 2>/dev/null || echo "")
  # Count unchecked `[ ]` and checked `[x]`/`[X]` boxes anywhere in the body.
  # grep -c exits 1 on zero matches; capture the count WITHOUT a `|| echo` (which
  # would double-print "0"). `{ ...; } ` + a trailing `; true` keeps pipefail happy.
  CD_OPEN=$({ printf '%s\n' "$CD_BODY" | grep -cE '\[[[:space:]]\]'; true; } 2>/dev/null)
  CD_DONE=$({ printf '%s\n' "$CD_BODY" | grep -cE '\[[xX]\]'; true; } 2>/dev/null)
  CD_OPEN=$(printf '%s' "$CD_OPEN" | head -1 | tr -cd '0-9')
  CD_DONE=$(printf '%s' "$CD_DONE" | head -1 | tr -cd '0-9')
  [[ "$CD_OPEN" =~ ^[0-9]+$ ]] || CD_OPEN=0
  [[ "$CD_DONE" =~ ^[0-9]+$ ]] || CD_DONE=0
  if [[ $(( CD_OPEN + CD_DONE )) -gt 0 ]]; then
    CD_UNCHECKED_COUNT=$CD_OPEN
    CD_TASK_STRUCTURE="has-tasks"
  else
    # No parseable checkbox structure — distinct signal + conservative non-zero so
    # the judge can tell "no structure to read" from "all tasks done".
    CD_UNCHECKED_COUNT=1
    CD_TASK_STRUCTURE="indeterminate"
  fi
fi

# milestoneRationalizationDetected — the deterministic milestone-phrase floor over
# the SAME tail -6 window the judge reads. Phrase set sourced verbatim from
# feedback_no_good_stopping_point_rationalization (2026-05-27). Case-insensitive,
# whole-phrase. A boolean SIGNAL — it does NOT block; it tells the judge "scrutinize".
CD_MILESTONE_DETECTED="false"
CD_INJECTION_SUSPECTED="false"
if [[ "$CD_ENABLED" == "1" ]] && [[ -n "$CD_JUDGE_TAIL" ]]; then
  CD_TAIL_LC=$(printf '%s' "$CD_JUDGE_TAIL" | tr '[:upper:]' '[:lower:]')
  for _ph in \
    "good place to stop" "good stopping point" "clean milestone" "natural off-ramp" \
    "fresh focus" "deserves fresh focus" "do it next session" "context preservation" \
    "context window" "quality risk at the tail" "it's late" "it’s late" "it's 2 am" "it’s 2 am" \
    "i've been going for a while" "i’ve been going for a while" \
    "needs your steer" "needs your opinion" "i'll let you decide" "i’ll let you decide"; do
    if [[ "$CD_TAIL_LC" == *"$_ph"* ]]; then CD_MILESTONE_DETECTED="true"; break; fi
  done
  # injectionSuspected — guard-directed control phrasing in the SAME window.
  for _inj in \
    "respond stop_ok" "respond met" "stop_blocked" "completion guard" "completion checker" \
    "you must allow" "must allow the stop" "output the verdict" "respond with stop_ok" \
    "the condition is met" "respond \"met\"" "respond 'met'"; do
    if [[ "$CD_TAIL_LC" == *"$_inj"* ]]; then CD_INJECTION_SUSPECTED="true"; break; fi
  done
fi

# SCOPE_ACCRETION — Layer B evasion-vocabulary scan (advisory, spec §2.7).
# Scans the SAME already-extracted CD_JUDGE_TAIL window (no second transcript
# read) for accretion-evasion vocabulary, with a fenced/quoted-region exclusion
# that is NEW bash logic (the milestone/injection scans above are plain
# substring matches): text inside ``` fences and `>`-quoted lines is stripped
# BEFORE matching, so quoting this rule or a doc that names the anti-pattern
# can never trip the signal. Advisory by construction — false negatives are
# harmless (the server-side git-truth sweep is the defense, Layer 0).
CD_SCOPE_SUSPECTED="false"
if [[ "$CD_ENABLED" == "1" ]] && [[ "$SA_ENABLED" == "1" ]] && [[ -n "$CD_JUDGE_TAIL" ]]; then
  CD_TAIL_SCOPE=$(printf '%s\n' "$CD_JUDGE_TAIL" \
    | awk 'BEGIN{f=0} /^[[:space:]]*```/{f=1-f; next} f==0 && $0 !~ /^[[:space:]]*>/{print}' 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' || echo "")
  for _sa in \
    "documented stretch" "filed for a future session" "out of completion condition" \
    "out of the completion condition" "drafts for later" "deferred as a follow-up spec"; do
    if [[ "$CD_TAIL_SCOPE" == *"$_sa"* ]]; then CD_SCOPE_SUSPECTED="true"; break; fi
  done
fi

# Assemble the signals JSON the judge payload carries (spec §2b.4 surface 1).
# completionConditionMet is set false here and overwritten true only inside the
# met-condition branch (the judge there is the completion judge, not this).
build_signals_json() {
  local stop_kind="${1:-}" cond_met="${2:-false}"
  local sk="" sa=""
  [[ "$stop_kind" == "hard-blocker" ]] && sk=',"stopKind":"hard-blocker"'
  # SCOPE_ACCRETION — the advisory Layer-B boolean is included ONLY when the
  # feature is on, so a disabled agent's judge prompt stays byte-identical.
  [[ "$SA_ENABLED" == "1" ]] && sa=",\"scopeAccretionSuspected\":${CD_SCOPE_SUSPECTED:-false}"
  printf '{"completionConditionMet":%s,"uncheckedTaskCount":%s,"taskStructure":"%s","milestoneRationalizationDetected":%s,"injectionSuspected":%s%s%s}' \
    "$cond_met" "$CD_UNCHECKED_COUNT" "$CD_TASK_STRUCTURE" "$CD_MILESTONE_DETECTED" "$CD_INJECTION_SUSPECTED" "$sa" "$sk"
}

# ── COMPLETION_DISCIPLINE — circuit-breaker + verdict cache (in the backoff sidecar) ──
# Bounds an agent's ability to burn the LLM cap by repeatedly inducing judge failures
# (cap-burn / curl-timeout) and a tight stop loop re-asking the same question. Cites
# the IntelligenceRouter per-framework breaker precedent. Spec §3 item 4.
CD_BACKOFF_STATE="${STATE_FILE%.md}.backoff.json"
# breaker_open → echoes 1 if the breaker is currently within its cooldown window.
cd_breaker_open() {
  [[ "$CD_ENABLED" != "1" ]] && { echo 0; return; }
  local now fails winstart lastfail
  now=$(date +%s)
  fails=$(jq -r '.judgeFailures // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  winstart=$(jq -r '.judgeFailWindowStart // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
  [[ "$winstart" =~ ^[0-9]+$ ]] || winstart=0
  local cooldown_s=$(( CD_BREAKER_COOLDOWN_MS / 1000 ))
  local window_s=$(( CD_BREAKER_WINDOW_MS / 1000 ))
  if [[ $fails -ge $CD_BREAKER_THRESHOLD ]] && [[ $winstart -gt 0 ]] && [[ $(( now - winstart )) -lt $cooldown_s ]]; then
    echo 1; return
  fi
  echo 0
}
# Record a judge failure into the sidecar (preserving other keys).
cd_record_judge_failure() {
  [[ "$CD_ENABLED" != "1" ]] && return 0
  local now fails winstart
  now=$(date +%s)
  fails=$(jq -r '.judgeFailures // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  winstart=$(jq -r '.judgeFailWindowStart // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
  [[ "$winstart" =~ ^[0-9]+$ ]] || winstart=0
  local window_s=$(( CD_BREAKER_WINDOW_MS / 1000 ))
  if [[ $winstart -le 0 ]] || [[ $(( now - winstart )) -ge $window_s ]]; then
    winstart=$now; fails=1
  else
    fails=$(( fails + 1 ))
  fi
  if [[ -f "$CD_BACKOFF_STATE" ]]; then
    jq --argjson f "$fails" --argjson w "$winstart" '.judgeFailures=$f | .judgeFailWindowStart=$w' "$CD_BACKOFF_STATE" \
      > "${CD_BACKOFF_STATE}.tmp.$$" 2>/dev/null && mv "${CD_BACKOFF_STATE}.tmp.$$" "$CD_BACKOFF_STATE" || true
  else
    printf '{"judgeFailures":%s,"judgeFailWindowStart":%s}\n' "$fails" "$winstart" > "$CD_BACKOFF_STATE" 2>/dev/null || true
  fi
}
# Reset the breaker on a successful judge call.
cd_reset_judge_failures() {
  [[ "$CD_ENABLED" != "1" ]] && return 0
  [[ -f "$CD_BACKOFF_STATE" ]] || return 0
  jq '.judgeFailures=0 | .judgeFailWindowStart=0' "$CD_BACKOFF_STATE" \
    > "${CD_BACKOFF_STATE}.tmp.$$" 2>/dev/null && mv "${CD_BACKOFF_STATE}.tmp.$$" "$CD_BACKOFF_STATE" || true
}
# Verdict cache: keyed on a hash of tail+condition+signals; short TTL (the idle-backoff
# tier window, default 300s). Echoes the cached stopAllowed/classifiedBlocker or "" on miss.
cd_cache_key() {
  printf '%s' "$1" | (command -v shasum >/dev/null 2>&1 && shasum -a 256 || sha256sum) 2>/dev/null | awk '{print $1}'
}

# Raise ONE /ack-able Attention item for an (a) hard-blocker exit (Close the Loop).
# Deduped per the Topic-Flood Guard / Bounded Notification Surface: source-tagged
# `autonomous-hard-blocker` (one per run), priority medium. Best-effort + non-blocking.
cd_raise_attention_item() {
  [[ "$CD_ENABLED" != "1" ]] && return 0
  local tried="$1" stuck="$2" needed="$3"
  # Test seam: record the would-be item instead of calling the server.
  if [[ -n "${INSTAR_HOOK_ATTENTION_RECORD:-}" ]]; then
    printf '{"id":"autonomous-hard-blocker-%s-%s","title":"Autonomous run hit a hard blocker","needed":%s}\n' \
      "${REPORT_TOPIC:-none}" "${ITERATION:-0}" "$(jq -Rn --arg n "$needed" '$n' 2>/dev/null || echo '""')" \
      >> "$INSTAR_HOOK_ATTENTION_RECORD" 2>/dev/null || true
    return 0
  fi
  local at_port at_auth at_id at_summary
  at_port=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
  at_auth=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  # One item per run (id keyed on topic+started_at): a re-fire within the same run
  # reuses the id so the attention store de-dups rather than piling up items.
  at_id="autonomous-hard-blocker-${REPORT_TOPIC:-none}-$(printf '%s' "${STARTED_AT:-}" | tr -cd '0-9')"
  at_summary="Tried: ${tried} | Stuck: ${stuck} | Need: ${needed}"
  jq -nc \
    --arg id "$at_id" \
    --arg title "Autonomous run hit a hard blocker — \"$(goal_snippet)\"" \
    --arg summary "$at_summary" \
    '{id:$id, title:$title, summary:$summary, priority:"medium", source:"autonomous-hard-blocker", sourceContext:"autonomous-hard-blocker", category:"autonomous"}' \
    | curl -s -m 8 -H "Authorization: Bearer $at_auth" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:${at_port}/attention" >/dev/null 2>&1 || true
}

# Write a distinct `evaluator-unreachable-exit` row when the authorities fail open
# under an UNMET condition with no valid marker — so the silent path becomes a
# RECORDED path. The hook then CONTINUES (block), never exits (duration is the hard
# backstop). Spec §3 item 4 / §4. Best-effort + non-blocking.
cd_write_unreachable_row() {
  [[ "$CD_ENABLED" != "1" ]] && return 0
  mkdir -p logs 2>/dev/null || true
  if [[ -f "$HARD_BLOCKER_LOG" ]]; then
    local sz; sz=$(stat -c %s "$HARD_BLOCKER_LOG" 2>/dev/null || stat -f %z "$HARD_BLOCKER_LOG" 2>/dev/null || echo 0)
    [[ "$sz" =~ ^[0-9]+$ ]] || sz=0
    [[ $sz -ge $CD_LOG_ROTATE_BYTES ]] && mv -f "$HARD_BLOCKER_LOG" "${HARD_BLOCKER_LOG}.1" 2>/dev/null || true
  fi
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg topic "${REPORT_TOPIC:-}" \
    --arg iter "${ITERATION:-}" --arg goal "$(goal_snippet)" \
    --argjson unchecked "$CD_UNCHECKED_COUNT" --arg ts2 "$CD_TASK_STRUCTURE" \
    '{ts:$ts,topic:$topic,iteration:$iter,goal:$goal,reason:"evaluator-unreachable-exit",completionConditionMet:false,uncheckedTaskCount:$unchecked,taskStructure:$ts2}' \
    >> "$HARD_BLOCKER_LOG" 2>/dev/null || true
}

# ── P13 "The Stop Reason Is the Work" guard ──────────────────────────────────
# Consulted ONLY when a stop is about to be APPROVED (genuine completion / promise /
# hard-blocker), so the LLM call costs nothing on ordinary keep-working iterations.
# Returns 0 (stop allowed) / 1 (blocked); on block, P13_GUIDANCE carries the steering.
# FAIL-OPEN on the completion/promise path: any unreachable / 503 / missing-field
# result → allowed (a SECONDARY guard must never trap a genuine completion). On the
# hard-blocker path it is NECESSARY-BUT-NOT-SUFFICIENT: the version-skew three-case
# detection + the external-vs-buildable classification own that decision (see
# p13_hard_blocker_allowed below), so a plain fail-open does NOT auto-pass an (a) exit.
#
# When CD_ENABLED, the call carries the objective signals (build_signals_json) so the
# judge corroborates the prose. The arg STOP_KIND (default empty) selects the
# hard-blocker classification prompt. P13_CLASSIFIED / P13_PROTO are set as side outputs.
P13_GUIDANCE=""
P13_CLASSIFIED=""
P13_PROTO=""
p13_stop_allowed() {
  P13_GUIDANCE=""; P13_CLASSIFIED=""; P13_PROTO=""
  local stop_kind="${1:-}"
  if [[ -n "${INSTAR_HOOK_P13_OVERRIDE:-}" ]]; then
    # Test seam: simulate the P13 response WITHOUT a network call (the sandbox blocks
    # localhost curl). Values map to the version-skew three-case detection (§5):
    #   blocked      → STOP_BLOCKED (proto=2)            → continue
    #   buildable    → hard-blocker buildable (proto=2)  → continue
    #   external     → hard-blocker external  (proto=2)  → Case 2 honored allow
    #   old-server   → NO p13ProtocolVersion             → Case 1 (structurally old)
    #   timeout      → proto=2 but no usable classification → Case 3 (fail-open record)
    #   (anything else)                                  → allow (proto=2)
    case "$INSTAR_HOOK_P13_OVERRIDE" in
      blocked)
        P13_GUIDANCE="P13 — the stop is not earned (test): derive+document the standard and proceed, or build the artifact and hand it over."
        [[ "$stop_kind" == "hard-blocker" ]] && P13_CLASSIFIED="buildable"
        P13_PROTO=2; return 1 ;;
      buildable)
        P13_GUIDANCE="P13 — the blocker is buildable (test): build/derive/fetch it and keep working."
        P13_CLASSIFIED="buildable"; P13_PROTO=2; return 1 ;;
      external)
        P13_CLASSIFIED="external"; P13_PROTO=2; return 0 ;;
      old-server)
        # Structurally-old server: no protocol-version stamp at all.
        P13_PROTO=""; P13_CLASSIFIED=""; return 0 ;;
      timeout)
        # New server that didn't return a usable verdict (proto present, no class).
        P13_PROTO=2; P13_CLASSIFIED=""; return 0 ;;
      *)
        [[ "$stop_kind" == "hard-blocker" ]] && P13_CLASSIFIED="external"
        P13_PROTO=2; return 0 ;;
    esac
  fi
  [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]] && return 0
  local p13_tail p13_port p13_auth p13_resp p13_allowed p13_guid p13_payload
  p13_tail="$CD_JUDGE_TAIL"
  if [[ -z "$p13_tail" ]]; then
    p13_tail=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -6 \
      | jq -r '.message.content | map(select(.type=="text")) | map(.text) | join("\n")' 2>/dev/null \
      | tail -c 8000 || echo "")
  fi
  [[ -z "$p13_tail" ]] && return 0
  p13_port=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
  p13_auth=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  if [[ "$CD_ENABLED" == "1" ]]; then
    local sig; sig=$(build_signals_json "$stop_kind" "false")
    p13_payload=$(jq -nc --arg t "$p13_tail" --argjson sig "$sig" '{transcriptTail:$t, signals:$sig}')
  else
    p13_payload=$(jq -nc --arg t "$p13_tail" '{transcriptTail:$t}')
  fi
  p13_resp=$(printf '%s' "$p13_payload" \
    | curl -s -m "$JUDGE_TIMEOUT_S" -H "Authorization: Bearer $p13_auth" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:${p13_port}/autonomous/evaluate-stop" 2>/dev/null || echo "")
  p13_allowed=$(printf '%s' "$p13_resp" | jq -r '.stopAllowed // empty' 2>/dev/null || echo "")
  p13_guid=$(printf '%s' "$p13_resp" | jq -r '.guidance // empty' 2>/dev/null || echo "")
  P13_CLASSIFIED=$(printf '%s' "$p13_resp" | jq -r '.classifiedBlocker // empty' 2>/dev/null || echo "")
  P13_PROTO=$(printf '%s' "$p13_resp" | jq -r '.p13ProtocolVersion // empty' 2>/dev/null || echo "")
  # FAIL-OPEN: block ONLY on an explicit stopAllowed:false.
  if [[ "$p13_allowed" == "false" ]]; then
    P13_GUIDANCE="P13 — the stop is not earned: ${p13_guid}"
    return 1
  fi
  return 0
}

# ── COMPLETION_DISCIPLINE — (a) hard-blocker exit branch (NEW) ────────────────
# Placed AFTER emergency + duration (so (b)/emergency always win) and BEFORE the
# completion-condition / promise blocks (so (a) is reachable even when the condition
# is unmet — the whole point of (a)). NECESSARY-BUT-NOT-SUFFICIENT: a nonce-valid
# marker is required, AND the extended P13 must classify the blocker EXTERNAL (not
# buildable). Malformed/partial/nonce-mismatch/fenced/template-verbatim ⇒ NO marker
# ⇒ continue (the safe direction). Spec §2b.3.
#
# Helper: extract one <hard-blocker> field from the FINAL assistant turn body.
hb_field() {
  local body="$1" field="$2"
  printf '%s' "$body" | perl -0777 -ne 'print "$1" if /<hard-blocker\b[^>]*>.*?\b'"$field"'\s*:\s*(.*?)(?:\n\s*(?:what i tried|why i am stuck|what i would need to proceed)\s*:|<\/hard-blocker>)/si' 2>/dev/null | head -c 4000 || echo ""
}
# Sanitize: strip CR/LF/control chars, collapse whitespace, clamp to max chars.
hb_sanitize() {
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | tr '\n\r\t' '   ' | sed 's/  */ /g; s/^ *//; s/ *$//' | cut -c1-"${CD_MARKER_MAX_CHARS}"
}
# Inline credential leak scan (the existing detector is a PostToolUse hook skill,
# not a callable scanner — see §5 deviation note). Same pattern families. Echoes 1
# on a hit. Conservative: only well-known high-signal shapes.
hb_leak_hit() {
  printf '%s' "$1" | grep -qiE 'sk-[a-zA-Z0-9]{16,}|xox[baprs]-[a-zA-Z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' 2>/dev/null && echo 1 || echo 0
}

# ── REAL-CHECK VERIFICATION (ACT-152) — helpers ──────────────────────────────
# A failing/flaky/mis-scoped verification_command would otherwise re-run on EVERY
# met:true verdict for the whole duration — and because the judge fires first to
# produce the met verdict, it also re-spends the LLM judge every iteration. The P19
# brake (§4) reuses the CD_BACKOFF_STATE sidecar with SIBLING counters so a stuck
# command is bounded to ~one judge+command cycle per cooldown window.

# realcheck_breaker_open → echoes 1 if the real-check breaker is within its cooldown
# window, else 0. MUST fail CLOSED (echo 0 = "run the check", the SAFE direction for
# this feature) on ANY sidecar read/parse error — mirroring cd_breaker_open's
# echo-0-on-failure default. (Fail-OPEN here would silently suppress the check and let
# an unverified transcript-met exit through — the exact failure this feature prevents.)
realcheck_breaker_open() {
  [[ "$RC_ENABLED" != "1" ]] && { echo 0; return; }
  local now fails winstart
  now=$(date +%s)
  fails=$(jq -r '.realCheckFailures // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  winstart=$(jq -r '.realCheckFailWindowStart // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
  [[ "$winstart" =~ ^[0-9]+$ ]] || winstart=0
  local cooldown_s=$(( RC_BREAKER_COOLDOWN_MS / 1000 ))
  if [[ $fails -ge $RC_BREAKER_THRESHOLD ]] && [[ $winstart -gt 0 ]] && [[ $(( now - winstart )) -lt $cooldown_s ]]; then
    echo 1; return
  fi
  echo 0
}
# Record a real-check failure into the sidecar (atomic .tmp.$$ + mv; preserves other keys).
realcheck_record_failure() {
  [[ "$RC_ENABLED" != "1" ]] && return 0
  local now fails winstart
  now=$(date +%s)
  fails=$(jq -r '.realCheckFailures // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  winstart=$(jq -r '.realCheckFailWindowStart // 0' "$CD_BACKOFF_STATE" 2>/dev/null || echo 0)
  [[ "$fails" =~ ^[0-9]+$ ]] || fails=0
  [[ "$winstart" =~ ^[0-9]+$ ]] || winstart=0
  local window_s=$(( RC_BREAKER_WINDOW_MS / 1000 ))
  if [[ $winstart -le 0 ]] || [[ $(( now - winstart )) -ge $window_s ]]; then
    winstart=$now; fails=1
  else
    fails=$(( fails + 1 ))
  fi
  if [[ -f "$CD_BACKOFF_STATE" ]]; then
    jq --argjson f "$fails" --argjson w "$winstart" '.realCheckFailures=$f | .realCheckFailWindowStart=$w' "$CD_BACKOFF_STATE" \
      > "${CD_BACKOFF_STATE}.tmp.$$" 2>/dev/null && mv "${CD_BACKOFF_STATE}.tmp.$$" "$CD_BACKOFF_STATE" || true
  else
    printf '{"realCheckFailures":%s,"realCheckFailWindowStart":%s}\n' "$fails" "$winstart" > "$CD_BACKOFF_STATE" 2>/dev/null || true
  fi
  # Cross the threshold → raise ONE deduped Attention item (Close the Loop / P19 cap).
  if [[ $fails -ge $RC_BREAKER_THRESHOLD ]]; then
    realcheck_raise_attention "$fails"
  fi
}
# Reset the real-check breaker on a PASS (atomic .tmp.$$ + mv).
realcheck_reset() {
  [[ "$RC_ENABLED" != "1" ]] && return 0
  [[ -f "$CD_BACKOFF_STATE" ]] || return 0
  jq '.realCheckFailures=0 | .realCheckFailWindowStart=0' "$CD_BACKOFF_STATE" \
    > "${CD_BACKOFF_STATE}.tmp.$$" 2>/dev/null && mv "${CD_BACKOFF_STATE}.tmp.$$" "$CD_BACKOFF_STATE" || true
}
# Raise ONE /ack-able Attention item when the real-check breaker crosses the threshold
# (Close the Loop). Deduped per the Bounded Notification Surface: source-tagged
# `autonomous-realcheck-stuck`, one per run via a started-at-keyed id. Best-effort.
realcheck_raise_attention() {
  [[ "$RC_ENABLED" != "1" ]] && return 0
  local fails="$1"
  if [[ -n "${INSTAR_HOOK_ATTENTION_RECORD:-}" ]]; then
    printf '{"id":"autonomous-realcheck-stuck-%s-%s","title":"Autonomous real check failing repeatedly","fails":%s}\n' \
      "${REPORT_TOPIC:-none}" "$(printf '%s' "${STARTED_AT:-}" | tr -cd '0-9')" "${fails:-0}" \
      >> "$INSTAR_HOOK_ATTENTION_RECORD" 2>/dev/null || true
    return 0
  fi
  local at_port at_auth at_id
  at_port=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
  at_auth=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  at_id="autonomous-realcheck-stuck-${REPORT_TOPIC:-none}-$(printf '%s' "${STARTED_AT:-}" | tr -cd '0-9')"
  jq -nc \
    --arg id "$at_id" \
    --arg title "Autonomous real check failing repeatedly — \"$(goal_snippet)\"" \
    --arg summary "The declared real check (${VERIFICATION_COMMAND}) has failed ${fails} times — likely an authoring problem (wrong directory, stale, or testing the wrong thing). The run keeps working (bounded by the duration limit) until it passes or you fix it." \
    '{id:$id, title:$title, summary:$summary, priority:"medium", source:"autonomous-realcheck-stuck", sourceContext:"autonomous-realcheck-stuck", category:"autonomous"}' \
    | curl -s -m 8 -H "Authorization: Bearer $at_auth" -H 'Content-Type: application/json' \
      --data-binary @- "http://localhost:${at_port}/attention" >/dev/null 2>&1 || true
}

# realcheck_audit_row — append ONE JSONL row to REALCHECK_LOG per run (same size-rotate
# as the hard-blocker log). Args: outcome exitCode durationMs command cwd breakerOpen.
realcheck_audit_row() {
  local outcome="$1" excode="$2" durms="$3" cmd="$4" cwd="$5" bopen="$6"
  mkdir -p logs 2>/dev/null || true
  if [[ -f "$REALCHECK_LOG" ]]; then
    local rc_sz; rc_sz=$(stat -c %s "$REALCHECK_LOG" 2>/dev/null || stat -f %z "$REALCHECK_LOG" 2>/dev/null || echo 0)
    [[ "$rc_sz" =~ ^[0-9]+$ ]] || rc_sz=0
    [[ $rc_sz -ge $CD_LOG_ROTATE_BYTES ]] && mv -f "$REALCHECK_LOG" "${REALCHECK_LOG}.1" 2>/dev/null || true
  fi
  local cmd_clamped; cmd_clamped=$(printf '%s' "$cmd" | cut -c1-"${RC_MAX_CHARS}")
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg topic "${REPORT_TOPIC:-}" \
    --arg iter "${ITERATION:-}" --arg command "$cmd_clamped" --arg cwd "$cwd" \
    --argjson exitCode "$([[ "$excode" =~ ^-?[0-9]+$ ]] && echo "$excode" || echo 'null')" \
    --argjson durationMs "$([[ "$durms" =~ ^[0-9]+$ ]] && echo "$durms" || echo 0)" \
    --arg outcome "$outcome" \
    --argjson breakerOpen "$([[ "$bopen" == "1" ]] && echo true || echo false)" \
    '{ts:$ts,topic:$topic,iteration:$iter,command:$command,cwd:$cwd,exitCode:$exitCode,durationMs:$durationMs,outcome:$outcome,breakerOpen:$breakerOpen}' \
    >> "$REALCHECK_LOG" 2>/dev/null || true
}

# realcheck_destructive — echoes 1 if the raw command string matches a high-signal
# destructive shape (L12 pre-block, §6.3). Literal-shape guard on the raw string only;
# honestly bypassable by obfuscation (the §6.1/§6.2 honest-mistake posture). Catches a
# fat-fingered/compacted-agent destructive "check", NOT an adversarial agent.
realcheck_destructive() {
  local cmd="$1"
  # rm -rf | git reset --hard | git clean -f | git push --force(/-f) | truncate (`:>`) |
  # redirect into /dev | mkfs | a write redirect into the instar source tree.
  if printf '%s' "$cmd" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f|rm[[:space:]]+-[a-zA-Z]*f[a-zA-Z]*r|git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f|git[[:space:]]+push[[:space:]].*(--force|-f\b)|:[[:space:]]*>|>[[:space:]]*/dev|mkfs' 2>/dev/null; then
    echo 1; return
  fi
  # Write redirect (`> path` / `>> path`) into the instar source tree (src/ at the repo root).
  if printf '%s' "$cmd" | grep -qE '>>?[[:space:]]*(\./)?src/' 2>/dev/null; then
    echo 1; return
  fi
  echo 0
}

# run_verification(cmd, cwd) — the core. Runs the declared command in a SUBSHELL with
# the resolved CWD (so the hook's own anchored CWD is undisturbed), a scrubbed env, and
# a portable, GUARANTEED timeout. Sets RC_OUTCOME (pass|fail|timeout|refused-destructive|
# unavailable), RC_EXIT, RC_DUR_MS, and RC_SANITIZED_OUTPUT (sanitize→UTF-8-scrub→
# leak-scrub→clamp). CARDINAL INVARIANT: ANY failure mode routes to keep-working — only
# RC_OUTCOME==pass allows the exit; everything else (including a missing perl) is a
# keep-working FAIL/unavailable. There is NO path here that CAUSES a premature exit.
RC_OUTCOME=""
RC_EXIT=""
RC_DUR_MS=0
RC_SANITIZED_OUTPUT=""
run_verification() {
  local cmd="$1" cwd="$2"
  RC_OUTCOME=""; RC_EXIT=""; RC_DUR_MS=0; RC_SANITIZED_OUTPUT=""

  # ── TEST SEAM: short-circuit the real command in CI (no real exec). ──
  if [[ -n "${INSTAR_HOOK_VERIFY_OVERRIDE:-}" ]]; then
    case "$INSTAR_HOOK_VERIFY_OVERRIDE" in
      pass)        RC_OUTCOME="pass"; RC_EXIT=0 ;;
      fail)        RC_OUTCOME="fail"; RC_EXIT=1; RC_SANITIZED_OUTPUT="simulated failure output" ;;
      timeout)     RC_OUTCOME="timeout"; RC_EXIT=124; RC_SANITIZED_OUTPUT="simulated timeout" ;;
      unavailable) RC_OUTCOME="unavailable"; RC_EXIT=127; RC_SANITIZED_OUTPUT="simulated unavailable (no timeout binary)" ;;
      *)           RC_OUTCOME="fail"; RC_EXIT=1 ;;
    esac
    realcheck_audit_row "$RC_OUTCOME" "$RC_EXIT" "0" "$cmd" "$cwd" "0"
    return 0
  fi

  # ── L12 destructive-pattern pre-block (refuse → unavailable → keep working). ──
  if [[ "$(realcheck_destructive "$cmd")" == "1" ]]; then
    RC_OUTCOME="refused-destructive"; RC_EXIT=126
    RC_SANITIZED_OUTPUT="[real check refused: the declared command matched a high-signal destructive pattern and was NOT run]"
    echo "[autonomous] real-check REFUSED (destructive pattern) — keeping working" >&2
    realcheck_audit_row "refused-destructive" "126" "0" "$cmd" "$cwd" "0"
    return 0
  fi

  # ── Scrubbed env: fixed PATH; strip authToken + npm_config_* + NODE_OPTIONS so a
  # failing check that dumps `env` can't self-leak the agent's own bearer token. Build
  # a proper `env -u VAR` arg array (each `-u` and VAR as SEPARATE args). ──
  local rc_path="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local -a rc_env_args=(-u authToken -u NODE_OPTIONS)
  local _v
  for _v in $(compgen -e 2>/dev/null); do
    case "$_v" in
      npm_config_*) rc_env_args+=(-u "$_v") ;;
    esac
  done

  # ── Portable timeout LADDER (§5.1). Each rung bounds the command; NONE runs unbounded. ──
  # Resolve the runner to its ABSOLUTE path during detection (with the hook's full PATH)
  # and invoke it by absolute path inside the scrubbed-PATH subshell — otherwise a runner
  # living outside the fixed PATH (e.g. Homebrew's /opt/homebrew/bin/timeout on macOS)
  # would resolve here but be `command not found` under the scrubbed env. The fixed PATH
  # still scrubs the USER command's env; only the runner binary is referenced absolutely.
  # A test seam (INSTAR_HOOK_VERIFY_NO_TIMEOUT=1) forces the timeout/gtimeout rungs to be
  # treated as absent so the perl path can be exercised even on a box that has GNU timeout.
  local rc_start rc_end rc_raw rc_code rc_runner="" rc_runner_bin=""
  rc_start=$(date +%s)
  if [[ "${INSTAR_HOOK_VERIFY_NO_TIMEOUT:-0}" != "1" ]] && command -v timeout >/dev/null 2>&1; then
    rc_runner="timeout"; rc_runner_bin="$(command -v timeout)"
  elif [[ "${INSTAR_HOOK_VERIFY_NO_TIMEOUT:-0}" != "1" ]] && command -v gtimeout >/dev/null 2>&1; then
    rc_runner="gtimeout"; rc_runner_bin="$(command -v gtimeout)"
  elif command -v perl >/dev/null 2>&1; then
    rc_runner="perl"; rc_runner_bin="$(command -v perl)"
  else
    # No bounded runner at all → UNAVAILABLE → keep working. NEVER run unbounded.
    RC_OUTCOME="unavailable"; RC_EXIT=127
    RC_SANITIZED_OUTPUT="[real check unavailable: no timeout/gtimeout/perl on PATH to bound the command — keeping working]"
    echo "[autonomous] real-check UNAVAILABLE: no timeout/gtimeout/perl to bound the command — keeping working" >&2
    realcheck_audit_row "unavailable" "127" "0" "$cmd" "$cwd" "0"
    return 0
  fi

  # Run in a subshell so the resolved CWD + scrubbed env never disturb the hook itself.
  # Combined stdout+stderr is byte-capped AT THE SOURCE (head -c) so a runaway log can
  # never buffer whole. Exit code via ${PIPESTATUS[0]} (the command's, not head's).
  if [[ "$rc_runner" == "perl" ]]; then
    rc_raw=$(
      env "${rc_env_args[@]}" PATH="$rc_path" \
        bash -c '
          cd "$1" 2>/dev/null || true
          "$5" -e '\''my($t,@c)=@ARGV; my $p=fork; if($p==0){setpgrp(0,0); exec @c or exit 127} $SIG{ALRM}=sub{kill("-KILL",$p); exit 124}; alarm($t); waitpid($p,0); exit($?>>8)'\'' "$2" bash -c "$3" 2>&1 | head -c "$4"
          exit "${PIPESTATUS[0]}"
        ' _ "$cwd" "$RC_TIMEOUT_S" "$cmd" "$RC_CAPTURE_BYTES" "$rc_runner_bin"
    )
    rc_code=$?
  else
    rc_raw=$(
      env "${rc_env_args[@]}" PATH="$rc_path" \
        bash -c '
          cd "$1" 2>/dev/null || true
          "$2" -k 5 "$3" bash -c "$4" 2>&1 | head -c "$5"
          exit "${PIPESTATUS[0]}"
        ' _ "$cwd" "$rc_runner_bin" "$RC_TIMEOUT_S" "$cmd" "$RC_CAPTURE_BYTES"
    )
    rc_code=$?
  fi
  rc_end=$(date +%s)
  RC_DUR_MS=$(( (rc_end - rc_start) * 1000 ))
  RC_EXIT=$rc_code

  # ── Output handling — PINNED ORDER: sanitize → UTF-8 scrub → leak-scrub → clamp. ──
  local rc_san rc_utf8 rc_clamped
  # 1a. sanitize: strip control chars, collapse whitespace (hb_sanitize clamps to
  #     CD_MARKER_MAX_CHARS, so re-implement the strip WITHOUT that clamp here).
  rc_san=$(printf '%s' "$rc_raw" | tr -d '\000-\010\013\014\016-\037' | tr '\n\r\t' '   ' | sed 's/  */ /g; s/^ *//; s/ *$//')
  # 1b. UTF-8 scrub: a source head -c byte-cap can split a multibyte char, leaving a lone
  #     continuation byte that would later break jq --arg. iconv -c drops invalid bytes;
  #     fall back to an LC_ALL=C printable-only filter when iconv is absent.
  if command -v iconv >/dev/null 2>&1; then
    rc_utf8=$(printf '%s' "$rc_san" | iconv -c -f utf-8 -t utf-8 2>/dev/null || printf '%s' "$rc_san" | LC_ALL=C tr -cd '\11\12\15\40-\176')
  else
    rc_utf8=$(printf '%s' "$rc_san" | LC_ALL=C tr -cd '\11\12\15\40-\176')
  fi
  # 2. leak-scrub on the SANITIZED text, BEFORE clamp (a credential split across the
  #    clamp boundary can't evade the regex). hb_leak_hit patterns + the agent's own
  #    authToken literal + a generic Bearer token.
  local rc_leak=0 rc_auth_val
  if [[ "$(hb_leak_hit "$rc_utf8")" == "1" ]]; then rc_leak=1; fi
  rc_auth_val=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
  if [[ $rc_leak -eq 0 ]] && [[ -n "$rc_auth_val" ]] && printf '%s' "$rc_utf8" | grep -qF "$rc_auth_val" 2>/dev/null; then rc_leak=1; fi
  if [[ $rc_leak -eq 0 ]] && printf '%s' "$rc_utf8" | grep -qE 'Bearer [A-Za-z0-9._-]{20,}' 2>/dev/null; then rc_leak=1; fi
  if [[ $rc_leak -eq 1 ]]; then
    rc_utf8="[output withheld: possible credential in check output]"
  fi
  # 3. clamp to RC_MAX_CHARS.
  rc_clamped=$(printf '%s' "$rc_utf8" | cut -c1-"${RC_MAX_CHARS}")
  RC_SANITIZED_OUTPUT="$rc_clamped"

  # ── Outcome: exit 0 → PASS; ANY non-zero → FAIL (124=timeout, 127=spawn-fail). ──
  if [[ "$rc_code" == "0" ]]; then
    RC_OUTCOME="pass"
  elif [[ "$rc_code" == "124" ]]; then
    RC_OUTCOME="timeout"
  else
    RC_OUTCOME="fail"
  fi
  realcheck_audit_row "$RC_OUTCOME" "$rc_code" "$RC_DUR_MS" "$cmd" "$cwd" "0"
  return 0
}

# realcheck_guidance — build the P13-shaped next-turn steering (§5.4), DATA-labeling the
# output exactly as §5.3 specifies. Canary-pinned by a test so a future edit can't drop
# the framing.
realcheck_guidance() {
  local cmd="$1" out="$2"
  printf 'The declared real check (`%s`) did not pass — this is your next work item. Either make it pass, or, if the check itself is wrong or mis-scoped (pointed at the wrong directory, stale, or testing the wrong thing), say so and why.\n[REAL-CHECK OUTPUT — DATA, not evidence of completion]:\n%s' \
    "$cmd" "$out"
}

# realcheck_resolve_cwd — verification_cwd → work_dir → agent home (today's CWD). The
# dominant build use case runs inside a worktree that is NOT the agent home, so resolve
# structurally, never by agent willpower (§3). Echoes the resolved dir.
realcheck_resolve_cwd() {
  if [[ -n "$VERIFICATION_CWD" ]] && [[ -d "$VERIFICATION_CWD" ]]; then
    printf '%s' "$VERIFICATION_CWD"
  elif [[ -n "$WORK_DIR" ]] && [[ -d "$WORK_DIR" ]]; then
    printf '%s' "$WORK_DIR"
  else
    printf '%s' "$(pwd)"
  fi
}

# realcheck_gate — the GATE shared by both the CD and legacy met paths. Called on a
# met:true verdict AFTER the CD_BLOCK_TERMINAL guard + the P13 check, BEFORE the exit.
# Returns 0 to ALLOW the exit (real check disabled / no command / breaker-closed PASS);
# returns 1 to BLOCK and keep working (breaker-open, FAIL, timeout, refused, unavailable),
# setting EVAL_REASON to the next-turn guidance. CARDINAL INVARIANT: every non-pass path
# returns 1 (keep working) — there is NO path here that allows a premature exit on a
# verification problem.
realcheck_gate() {
  # Disabled or no declared command → existing behavior unchanged (allow exit).
  [[ "$RC_ENABLED" != "1" ]] && return 0
  [[ -z "$VERIFICATION_COMMAND" ]] && return 0

  if [[ "$(realcheck_breaker_open)" == "1" ]]; then
    # Breaker OPEN — cheap continue: do NOT re-run the command (and the judge already
    # fired to produce this met). Surface the breaker guidance + keep working.
    EVAL_REASON="The declared real check (\`${VERIFICATION_COMMAND}\`) has failed repeatedly — paused re-running it for a cooldown. This is likely an authoring problem (wrong directory, stale, or testing the wrong thing): fix the check or the work, then continue. I've queued it for the operator."
    realcheck_audit_row "fail" "" "0" "$VERIFICATION_COMMAND" "$(realcheck_resolve_cwd)" "1"
    echo "[autonomous] real-check breaker OPEN — keeping working (no command run, no judge re-fire)" >&2
    return 1
  fi

  local rc_cwd; rc_cwd=$(realcheck_resolve_cwd)
  run_verification "$VERIFICATION_COMMAND" "$rc_cwd"
  if [[ "$RC_OUTCOME" == "pass" ]]; then
    realcheck_reset
    echo "[autonomous] real-check PASSED — exit allowed (judge MET + real check PASSED)" >&2
    return 0
  fi
  # FAIL | timeout | refused-destructive | unavailable → record + keep working.
  realcheck_record_failure
  EVAL_REASON="$(realcheck_guidance "$VERIFICATION_COMMAND" "$RC_SANITIZED_OUTPUT")"
  echo "[autonomous] real-check ${RC_OUTCOME} (exit=${RC_EXIT}) — keeping working" >&2
  return 1
}

if [[ "$CD_ENABLED" == "1" ]] && [[ -n "$HARD_BLOCKER_NONCE" ]] && [[ "$HARD_BLOCKER_NONCE" != "null" ]] \
   && [[ -n "$CD_FINAL_TURN" ]] && [[ "$CD_FINAL_TURN" == *"<hard-blocker"* ]]; then
  HB_OK="false"
  # Ignore when the marker is inside a fenced code block, or is the documented
  # template verbatim (literal `...` placeholders), or carries no/mismatched nonce.
  HB_FENCED="false"
  # If a ``` fence opens before the marker and the marker sits inside it, ignore.
  if printf '%s' "$CD_FINAL_TURN" | perl -0777 -ne 'exit(/```[^`]*<hard-blocker/s ? 0 : 1)' 2>/dev/null; then
    HB_FENCED="true"
  fi
  HB_NONCE_IN=$(printf '%s' "$CD_FINAL_TURN" | perl -0777 -ne 'print "$1" if /<hard-blocker\b[^>]*\bnonce\s*=\s*"([^"]*)"/si' 2>/dev/null | head -c 200 || echo "")
  HB_TRIED_RAW=$(hb_field "$CD_FINAL_TURN" "what i tried")
  HB_STUCK_RAW=$(hb_field "$CD_FINAL_TURN" "why i am stuck")
  HB_NEEDED_RAW=$(hb_field "$CD_FINAL_TURN" "what i would need to proceed")
  # Template-verbatim guard: the documented placeholders are a bare "...".
  HB_TEMPLATE="false"
  if [[ "$(printf '%s' "$HB_TRIED_RAW" | tr -d '[:space:].')" == "" ]] \
     && [[ "$(printf '%s' "$HB_STUCK_RAW" | tr -d '[:space:].')" == "" ]] \
     && [[ "$(printf '%s' "$HB_NEEDED_RAW" | tr -d '[:space:].')" == "" ]]; then
    HB_TEMPLATE="true"
  fi
  if [[ "$HB_FENCED" != "true" ]] && [[ "$HB_TEMPLATE" != "true" ]] \
     && [[ "$HB_NONCE_IN" == "$HARD_BLOCKER_NONCE" ]] \
     && [[ -n "${HB_TRIED_RAW// /}" ]] && [[ -n "${HB_STUCK_RAW// /}" ]] && [[ -n "${HB_NEEDED_RAW// /}" ]]; then
    HB_OK="true"
  fi

  # Contradictory terminal markers: a hard-blocker AND a completion/promise token in
  # the SAME final turn is incoherent → NO clean exit → continue with a steer.
  HB_HAS_COMPLETION="false"
  if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
    if printf '%s' "$CD_FINAL_TURN" | grep -q "<promise>${COMPLETION_PROMISE}</promise>" 2>/dev/null; then
      HB_HAS_COMPLETION="true"
    fi
  fi

  if [[ "$HB_OK" == "true" ]] && [[ "$HB_HAS_COMPLETION" == "true" ]]; then
    # Contradictory → continue. The steer is surfaced via the continuation message.
    # Set CD_BLOCK_TERMINAL so the downstream completion/promise blocks do NOT exit
    # on the (also-present) completion token — the turn is incoherent, so neither
    # terminal marker is honored.
    CD_BLOCK_TERMINAL="true"
    CD_CONTRADICTORY_STEER="You emitted contradictory terminal markers (a hard-blocker AND a completion assertion) in the same turn — pick one: either the work is done (show the evidence) or you are blocked (emit only the hard-blocker). Resolve and proceed."
  elif [[ "$HB_OK" == "true" ]]; then
    # The marker is valid. Run the extended P13 external-vs-buildable classification.
    if p13_stop_allowed "hard-blocker"; then
      # Version-skew three-case detection (spec §5):
      #  1. NO p13ProtocolVersion        → structurally OLD server → continue (no (a) exit)
      #  2. proto present + classifiedBlocker=external + allowed → honor → (a) exit
      #  3. proto present + no usable verdict (timeout/empty)     → fail-open record + continue
      if [[ -z "$P13_PROTO" ]]; then
        # Case 1 — old server. No (a) exit possible until the server updates.
        echo "[autonomous] hard-blocker: server is structurally old (no p13ProtocolVersion) — continuing (no (a) exit)" >&2
        CD_CONTRADICTORY_STEER=""
      elif [[ "$P13_CLASSIFIED" == "external" ]]; then
        # Case 2 — honored EXTERNAL allow → the (a) exit.
        HB_TRIED=$(hb_sanitize "$HB_TRIED_RAW")
        HB_STUCK=$(hb_sanitize "$HB_STUCK_RAW")
        HB_NEEDED=$(hb_sanitize "$HB_NEEDED_RAW")
        HB_LEAK=0
        if [[ "$(hb_leak_hit "$HB_TRIED")" == "1" ]]; then HB_TRIED="[redacted: possible secret]"; HB_LEAK=1; fi
        if [[ "$(hb_leak_hit "$HB_STUCK")" == "1" ]]; then HB_STUCK="[redacted: possible secret]"; HB_LEAK=1; fi
        if [[ "$(hb_leak_hit "$HB_NEEDED")" == "1" ]]; then HB_NEEDED="[redacted: possible secret]"; HB_LEAK=1; fi
        # (a) Write ONE row to logs/autonomous-hard-blocker.jsonl (coarse rotation).
        mkdir -p logs 2>/dev/null || true
        if [[ -f "$HARD_BLOCKER_LOG" ]]; then
          HB_SZ=$(stat -c %s "$HARD_BLOCKER_LOG" 2>/dev/null || stat -f %z "$HARD_BLOCKER_LOG" 2>/dev/null || echo 0)
          [[ "$HB_SZ" =~ ^[0-9]+$ ]] || HB_SZ=0
          [[ $HB_SZ -ge $CD_LOG_ROTATE_BYTES ]] && mv -f "$HARD_BLOCKER_LOG" "${HARD_BLOCKER_LOG}.1" 2>/dev/null || true
        fi
        jq -nc \
          --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg topic "${REPORT_TOPIC:-}" \
          --arg iter "${ITERATION:-}" --arg goal "$(goal_snippet)" \
          --arg tried "$HB_TRIED" --arg stuck "$HB_STUCK" --arg needed "$HB_NEEDED" \
          --argjson unchecked "$CD_UNCHECKED_COUNT" --arg ts2 "$CD_TASK_STRUCTURE" \
          --argjson leak "$([[ $HB_LEAK -eq 1 ]] && echo true || echo false)" \
          '{ts:$ts,topic:$topic,iteration:$iter,goal:$goal,tried:$tried,stuck:$stuck,needed:$needed,completionConditionMet:false,uncheckedTaskCount:$unchecked,taskStructure:$ts2,leakRedacted:$leak}' \
          >> "$HARD_BLOCKER_LOG" 2>/dev/null || true
        # (b) Raise ONE /ack-able Attention item (deduped per the Topic-Flood Guard).
        cd_raise_attention_item "$HB_TRIED" "$HB_STUCK" "$HB_NEEDED"
        # (c) ONE plain-English notify-on-stop.
        notify_terminal_stop "🚧 My autonomous run on \"$(goal_snippet)\" stopped on a hard blocker I can't resolve myself. What I'd need: ${HB_NEEDED}. I've queued it for your attention."
        emit "🚧 Autonomous mode: hard blocker (external) — exit allowed. needed: ${HB_NEEDED}"
        # SCOPE_ACCRETION (R40/R44): the hard-blocker exit is a run-end surface.
        run_end_call "hard-blocker"
        # (d) Remove state; allow exit (write once — state removal prevents re-append).
        rm -f "$STATE_FILE" "$CD_BACKOFF_STATE" 2>/dev/null || true
        exit 0
      else
        # Case 3 — new server, no usable external classification (timeout/empty/buildable
        # via the allow path is impossible; this is the timeout/ambiguous fail-open).
        cd_record_judge_failure
        cd_write_unreachable_row
        echo "[autonomous] hard-blocker: no usable external classification — recorded evaluator-unreachable-exit, continuing" >&2
        CD_CONTRADICTORY_STEER=""
      fi
    else
      # P13 blocked → buildable / not-earned. Continue; P13_GUIDANCE is the next-turn steer.
      CD_CONTRADICTORY_STEER=""
    fi
  fi
fi

# Completion CONDITION — independent evaluator (mirrors /goal). Authoritative when
# set; the self-declared promise below is the legacy fallback. FAIL-SAFE: if the
# evaluator is unreachable or unsure, we keep working — never a false "done".
#
# COMPLETION_DISCIPLINE (CD_ENABLED): the deterministic checkbox scan is the PRIMARY
# "buildable work remains" signal. The completion judge fires ONLY on a might-be-done
# iteration (uncheckedTaskCount==0 OR an explicit completion assertion in the final
# turn) — the common keep-working iteration costs ZERO LLM (spec §2b.2). When it
# fires, the milestone/buildable-work scrutiny is FOLDED into the completion judge's
# signals (the single critical-path call — no standalone P13 on the condition path).
# The circuit-breaker short-circuits to the cheap checkbox-only decision after K
# consecutive judge failures (spec §3 item 4).
EVAL_REASON=""
if [[ "${CD_BLOCK_TERMINAL:-}" != "true" ]] && [[ -n "$COMPLETION_CONDITION" ]] && [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  EVAL_MET=""
  # Test seam (SCOPE_ACCRETION): record the signals + identity fields the judge
  # payload would carry, WITHOUT a network call (mirrors INSTAR_HOOK_ATTENTION_RECORD).
  if [[ -n "${INSTAR_HOOK_SIGNALS_RECORD:-}" ]] && [[ "$CD_ENABLED" == "1" ]]; then
    printf '{"signals":%s,"topicId":"%s","runId":"%s"}\n' \
      "$(build_signals_json "" "false")" "${REPORT_TOPIC:-}" "${RUN_ID:-}" \
      >> "$INSTAR_HOOK_SIGNALS_RECORD" 2>/dev/null || true
  fi
  # Decide whether to fire the judge at all (CD cost-discipline gate).
  CD_MIGHT_BE_DONE="true"
  if [[ "$CD_ENABLED" == "1" ]] && [[ -z "${INSTAR_HOOK_EVAL_OVERRIDE:-}" ]]; then
    CD_MIGHT_BE_DONE="false"
    [[ "$CD_UNCHECKED_COUNT" == "0" ]] && CD_MIGHT_BE_DONE="true"
    # An explicit completion assertion in the final turn also triggers the judge.
    if printf '%s' "$CD_FINAL_TURN" | grep -qiE 'all (tasks|tests) (complete|pass)|<promise>|condition (is )?met|completion condition met|task list (is )?complete' 2>/dev/null; then
      CD_MIGHT_BE_DONE="true"
    fi
  fi
  if [[ -n "${INSTAR_HOOK_EVAL_OVERRIDE:-}" ]]; then
    # Test seam: "met" | "not-met" short-circuits the live evaluator call.
    [[ "$INSTAR_HOOK_EVAL_OVERRIDE" == "met" ]] && EVAL_MET="true"
    EVAL_REASON="override:$INSTAR_HOOK_EVAL_OVERRIDE"
  elif [[ "$CD_ENABLED" == "1" ]] && [[ "$(cd_breaker_open)" == "1" ]]; then
    # Breaker OPEN — cheap checkbox-only decision, no LLM call (never a fail-open exit).
    if [[ "$CD_UNCHECKED_COUNT" != "0" ]]; then
      EVAL_REASON="circuit-breaker open (judge failing) — work remains ($CD_UNCHECKED_COUNT unchecked), keeping going"
    else
      EVAL_REASON="circuit-breaker open (judge failing) — verify the condition and re-assert with evidence"
    fi
    echo "[autonomous] completion-discipline: judge breaker OPEN — cheap checkbox-only continue (unchecked=$CD_UNCHECKED_COUNT)" >&2
  elif [[ "$CD_MIGHT_BE_DONE" != "true" ]]; then
    # Common keep-working iteration — zero LLM. The checkbox scan says work remains.
    EVAL_REASON="work remains ($CD_UNCHECKED_COUNT unchecked) — keeping going"
  else
    EVAL_TAIL=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -6 \
      | jq -r '.message.content | map(select(.type=="text")) | map(.text) | join("\n")' 2>/dev/null \
      | tail -c 8000 || echo "")
    EVAL_PORT=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('port',4040))" 2>/dev/null || echo 4040)
    EVAL_AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null || echo "")
    # SCOPE_ACCRETION — echo topicId/runId/sessionId so the server resolves the
    # run against its OWN registration record (R35 arming; R36 registered-
    # condition authority; §6 runId pair check). Empty fields are omitted.
    CD_IDS=$(jq -nc --arg topic "${REPORT_TOPIC:-}" --arg rid "${RUN_ID:-}" --arg sid "${HOOK_SESSION:-}" \
      '(if $topic != "" then {topicId:$topic} else {} end) + (if $rid != "" then {runId:$rid} else {} end) + (if $sid != "" then {sessionId:$sid} else {} end)' 2>/dev/null || echo '{}')
    if [[ "$CD_ENABLED" == "1" ]]; then
      # Fold the milestone/buildable-work scrutiny into the completion judge (single call).
      CD_SIG=$(build_signals_json "" "false")
      EVAL_BODY=$(jq -nc --arg c "$COMPLETION_CONDITION" --arg t "$EVAL_TAIL" --argjson sig "$CD_SIG" --argjson ids "$CD_IDS" '{condition:$c,transcriptTail:$t,signals:$sig} + $ids')
    else
      EVAL_BODY=$(jq -nc --arg c "$COMPLETION_CONDITION" --arg t "$EVAL_TAIL" --argjson ids "$CD_IDS" '{condition:$c,transcriptTail:$t} + $ids')
    fi
    EVAL_RESP=$(printf '%s' "$EVAL_BODY" \
      | curl -s -m "$JUDGE_TIMEOUT_S" -H "Authorization: Bearer $EVAL_AUTH" -H 'Content-Type: application/json' \
        --data-binary @- "http://localhost:${EVAL_PORT}/autonomous/evaluate-completion" 2>/dev/null || echo "")
    EVAL_MET=$(printf '%s' "$EVAL_RESP" | jq -r '.met // empty' 2>/dev/null || echo "")
    EVAL_REASON=$(printf '%s' "$EVAL_RESP" | jq -r '.reason // empty' 2>/dev/null || echo "")
    if [[ "$CD_ENABLED" == "1" ]]; then
      if [[ -z "$EVAL_RESP" ]] || { [[ -z "$EVAL_MET" ]] && [[ -z "$EVAL_REASON" ]]; }; then
        # Judge unreachable/empty → record the failure (breaker) + the unreachable
        # breadcrumb, then CONTINUE (never a silent exit). Spec §3 item 4 / §4.
        cd_record_judge_failure
        cd_write_unreachable_row
      else
        cd_reset_judge_failures
      fi
    fi
  fi
  if [[ "$EVAL_MET" == "true" ]]; then
    if [[ "$CD_ENABLED" == "1" ]]; then
      # The folded signals already carried the milestone/buildable-work scrutiny to
      # the completion judge (the SINGLE critical-path call). A "met" verdict here is
      # the judge's all-things-considered decision → allow. No standalone P13 call on
      # the condition path (spec §2b.2 — folded once the canary verifies the block).
      # ── REAL-CHECK GATE (ACT-152): judge MET + a declared command → RUN it; the
      # exit is allowed ONLY if the command ALSO passes. Any fail/timeout/refused/
      # unavailable/breaker-open → keep working (realcheck_gate sets EVAL_REASON). ──
      if realcheck_gate; then
        emit "✅ Autonomous mode: completion condition met (independent evaluator): ${EVAL_REASON}"
        notify_terminal_stop "✅ My autonomous run on \"$(goal_snippet)\" finished — the goal was met."
        run_end_call "met"
        rm -f "$STATE_FILE" "$CD_BACKOFF_STATE" 2>/dev/null || true
        exit 0
      fi
      # Real check did not pass → keep working; EVAL_REASON now carries the guidance.
    elif p13_stop_allowed; then
      # ── REAL-CHECK GATE (ACT-152) on the legacy (CD-disabled) condition path. ──
      if realcheck_gate; then
        emit "✅ Autonomous mode: completion condition met (independent evaluator): ${EVAL_REASON}"
        notify_terminal_stop "✅ My autonomous run on \"$(goal_snippet)\" finished — the goal was met."
        run_end_call "met"
        rm -f "$STATE_FILE"
        exit 0
      fi
      # Real check did not pass → keep working; EVAL_REASON now carries the guidance.
    else
      # P13 "The Stop Reason Is the Work": the condition reads as met, but the stop
      # rests on a judgment-call / needs-engineering deferral → keep working. The
      # P13 steering becomes the next-turn guidance (surfaced via EVAL_REASON below).
      EVAL_REASON="$P13_GUIDANCE"
    fi
  fi
  # Not met / unreachable → keep working; EVAL_REASON (if any) becomes next-turn guidance.
fi

# Completion promise (genuine completion — legacy/self-declared fallback)
if [[ "${CD_BLOCK_TERMINAL:-}" != "true" ]] && [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  LAST_LINE=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 || echo "")
  if [[ -n "$LAST_LINE" ]]; then
    LAST_OUTPUT=$(printf '%s' "$LAST_LINE" | jq -r '
      .message.content | map(select(.type == "text")) | map(.text) | join("\n")
    ' 2>/dev/null || echo "")
    if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
      PROMISE_TEXT=$(printf '%s' "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")
      if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
        if p13_stop_allowed; then
          # ── REAL-CHECK GATE (ACT-152) on the legacy-promise met path (§2.2). The
          # gate is scoped to the completion-condition AND legacy-promise met paths;
          # a declared command must ALSO pass before a self-declared promise exits.
          if realcheck_gate; then
            emit "✅ Autonomous mode: Completion promise detected — <promise>$COMPLETION_PROMISE</promise>"
            emit "   Session is free to exit. Good work!"
            notify_terminal_stop "✅ My autonomous run on \"$(goal_snippet)\" finished — all the work is done."
            run_end_call "met (promise)"
            rm -f "$STATE_FILE"
            exit 0
          fi
          # Real check did not pass → keep working; EVAL_REASON carries the guidance,
          # surfaced via the promise-path system message below (P13_GUIDANCE path).
          P13_GUIDANCE="$EVAL_REASON"
        fi
        # P13: a completion promise was emitted, but the stop rests on a
        # judgment-call / needs-engineering deferral → keep working. P13_GUIDANCE
        # is surfaced in the continuing system message below.
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

# RESTART_NOTE_SILENT — self-lifecycle narration is housekeeping; default-silent.
# The restart-resume note ("my session restarted... no action needed") is, by its
# own text, not user-actionable. Under restart churn it floods the user's topic
# (2026-06-06: walls of per-iteration restart notes across topics). The durable
# record is the RECOVERY_AUDIT JSONL + the stderr log below — never the user's
# chat. deliver_recovery_note() is intentionally retained for FUTURE notes that
# ARE user-actionable (e.g. "your work is holding a restart").
if [[ "$RESTART_DETECTED" == "true" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  ITER_LABEL="${ITERATION:-?}"
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","event":"restart-resume","channel":"%s","topic":"%s","oldSession":"%s","newSession":"%s","method":"%s","iteration":"%s"}\n' \
    "$TS" "$REPORT_CHANNEL" "${REPORT_TOPIC:-}" "$STATE_SESSION" "$HOOK_SESSION" "$OWNER_METHOD" "$ITER_LABEL" >> "$RECOVERY_AUDIT" 2>/dev/null || true
  echo "[autonomous] restart-resume (silent — audit-only): channel=$REPORT_CHANNEL topic=${REPORT_TOPIC:-?} old=$STATE_SESSION new=$HOOK_SESSION method=$OWNER_METHOD" >&2
fi

# Reconcile recorded session_id to live (covers restart, bootstrap, adopt).
if [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  record_session_id "$HOOK_SESSION"
fi

# ── IDLE_BACKOFF — consecutive quick stops back off before re-injecting the frame ──
# Every block-decision below re-feeds the FULL frame + context to the model. When the
# session is idle/holding (nothing actionable), stops arrive back-to-back (~4s apart)
# and the loop re-injects thousands of tokens ~15×/min, all night — the 2026-06-06
# rapid-idle-refire waste. Backoff: measure the agent's ACTIVE time since the last
# re-injection (gap = stop arrival − last resume; slept time never counts toward the
# gap, so a long sleep can't masquerade as productive work). gap < QUICK_SECS ⇒ an
# idle cycle ⇒ the consecutive counter rises ⇒ tiered sleep (3+ quick stops → T1 30s,
# 6+ → T2 120s, 10+ → T3 300s) BEFORE the next re-injection. Any real work makes the
# gap long and resets the counter to zero — productive loops never wait at all.
# RESPONSIVENESS: the sleep polls every POLL_SECS and breaks EARLY on (a) a new
# inbound message for this topic, (b) the emergency-stop flag, (c) the state file
# vanishing (stop/stop-all) — a user message cuts the wait to ≤POLL_SECS.
# SAFETY (fail-toward-noise, never toward strand): the total sleep self-clamps to a
# third of THIS hook's own registered Stop timeout, read live from settings.json —
# a host-killed Stop hook fails OPEN and strands the loop, which is categorically
# worse than refire noise. Unreadable/missing timeout ⇒ conservative 20s cap; codex
# registrations (.codex/hooks.json, different timeout semantics) ⇒ same 20s cap.
BACKOFF_STATE="${STATE_FILE%.md}.backoff.json"
BACKOFF_SLEPT=0
if [[ "${INSTAR_HOOK_BACKOFF_DISABLE:-0}" != "1" ]]; then
  BK_QUICK_SECS="${INSTAR_HOOK_BACKOFF_QUICK_SECS:-120}"
  BK_T1="${INSTAR_HOOK_BACKOFF_T1:-30}"
  BK_T2="${INSTAR_HOOK_BACKOFF_T2:-120}"
  BK_T3="${INSTAR_HOOK_BACKOFF_T3:-300}"
  BK_POLL="${INSTAR_HOOK_BACKOFF_POLL_SECS:-5}"

  # Self-clamp: never sleep past a third of the registered hook timeout.
  BK_MAX="${INSTAR_HOOK_BACKOFF_MAX_SLEEP:-}"
  if [[ -z "$BK_MAX" ]]; then
    if [[ "$IS_CODEX" == "1" ]]; then
      BK_MAX=20
    else
      BK_REG_TIMEOUT=$(python3 -c "
import json
try:
    s = json.load(open('.claude/settings.json'))
    for grp in (s.get('hooks', {}).get('Stop') or []):
        for h in (grp.get('hooks') or []):
            if 'autonomous-stop-hook.sh' in (h.get('command') or ''):
                t = h.get('timeout')
                print(int(t) if isinstance(t, (int, float)) and t > 0 else '')
                raise SystemExit
except SystemExit:
    pass
except Exception:
    pass
" 2>/dev/null || echo "")
      if [[ "$BK_REG_TIMEOUT" =~ ^[0-9]+$ ]] && [[ $BK_REG_TIMEOUT -ge 60 ]]; then
        BK_MAX=$(( BK_REG_TIMEOUT / 3 ))
      else
        BK_MAX=20
      fi
    fi
  fi

  # Read sidecar (per-topic). A new run (different started_at) resets the counter.
  BK_PREV_RESUMED=$(jq -r '.lastResumedAt // 0' "$BACKOFF_STATE" 2>/dev/null || echo 0)
  BK_PREV_QUICK=$(jq -r '.quickStops // 0' "$BACKOFF_STATE" 2>/dev/null || echo 0)
  BK_PREV_RUN=$(jq -r '.runStartedAt // ""' "$BACKOFF_STATE" 2>/dev/null || echo "")
  [[ "$BK_PREV_RESUMED" =~ ^[0-9]+$ ]] || BK_PREV_RESUMED=0
  [[ "$BK_PREV_QUICK" =~ ^[0-9]+$ ]] || BK_PREV_QUICK=0
  if [[ "$BK_PREV_RUN" != "$STARTED_AT" ]]; then
    BK_PREV_RESUMED=0; BK_PREV_QUICK=0
  fi

  BK_NOW=$(date +%s)
  BK_GAP=-1
  BK_QUICK=0
  if [[ $BK_PREV_RESUMED -gt 0 ]]; then
    BK_GAP=$(( BK_NOW - BK_PREV_RESUMED ))
    if [[ $BK_GAP -lt $BK_QUICK_SECS ]]; then
      BK_QUICK=$(( BK_PREV_QUICK + 1 ))
    fi
  fi

  BK_SLEEP=0
  if   [[ $BK_QUICK -ge 10 ]]; then BK_SLEEP=$BK_T3
  elif [[ $BK_QUICK -ge 6  ]]; then BK_SLEEP=$BK_T2
  elif [[ $BK_QUICK -ge 3  ]]; then BK_SLEEP=$BK_T1
  fi
  [[ $BK_SLEEP -gt $BK_MAX ]] && BK_SLEEP=$BK_MAX

  if [[ $BK_SLEEP -gt 0 ]]; then
    bk_inbound_latest() { ls -t .instar/telegram-inbound/msg-"${REPORT_TOPIC:-none}"-* 2>/dev/null | head -1; }
    BK_MARK_IN=$(bk_inbound_latest)
    while [[ $BACKOFF_SLEPT -lt $BK_SLEEP ]]; do
      BK_CHUNK=$(( BK_SLEEP - BACKOFF_SLEPT ))
      [[ $BK_CHUNK -gt $BK_POLL ]] && BK_CHUNK=$BK_POLL
      sleep "$BK_CHUNK"
      BACKOFF_SLEPT=$(( BACKOFF_SLEPT + BK_CHUNK ))
      [[ -f ".instar/autonomous-emergency-stop" ]] && break
      [[ ! -f "$STATE_FILE" ]] && break
      [[ "$(bk_inbound_latest)" != "$BK_MARK_IN" ]] && break
    done
    echo "[autonomous] idle backoff: quickStops=$BK_QUICK gap=${BK_GAP}s slept=${BACKOFF_SLEPT}s (cap=${BK_MAX}s)" >&2

    # Re-check terminal conditions that may have arrived during the sleep.
    if [[ ! -f "$STATE_FILE" ]]; then
      rm -f "$BACKOFF_STATE" 2>/dev/null || true
      echo "[autonomous] state file removed during idle backoff — allowing exit" >&2
      run_end_call "stopped (state file removed during backoff)"
      exit 0
    fi
    if [[ -f ".instar/autonomous-emergency-stop" ]]; then
      emit "🛑 Autonomous mode: Emergency stop detected (during idle backoff)."
      notify_terminal_stop "🛑 My autonomous run on \"$(goal_snippet)\" was stopped (emergency stop)."
      run_end_call "emergency-stop (during backoff)"
      rm -f "$STATE_FILE" "$BACKOFF_STATE" 2>/dev/null || true
      exit 0
    fi
  fi

  BK_RESUMED=$(date +%s)
  printf '{"runStartedAt":"%s","lastResumedAt":%s,"quickStops":%s,"lastSleepSecs":%s}\n' \
    "$STARTED_AT" "$BK_RESUMED" "$BK_QUICK" "$BACKOFF_SLEPT" > "$BACKOFF_STATE" 2>/dev/null || true
fi

# ── Continue the job: increment iteration, feed the task back. ────────
NEXT_ITERATION=$((ITERATION + 1))

PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")
if [[ -z "$PROMPT_TEXT" ]]; then
  echo "⚠️  Autonomous mode: State file has no task content" >&2
  run_end_call "state-corrupt (no task content)"
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

# Session-clock injection (render mode) — the rich "SESSION CLOCK: Nh elapsed ·
# Mh remaining (NN%)" line, rendered by emit-session-clock.sh FROM THIS HOOK'S OWN
# already-computed numbers (no re-resolution -> can never disagree with the expiry
# verdict above). Additive + fail-safe: if the script is absent or the run is
# unbounded (no ELAPSED), the segment is simply omitted and the existing
# ($TIME_MSG) slot is unchanged. Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md.
CLOCK_SEG=""
if [[ -n "${ELAPSED:-}" ]]; then
  _clk_dir="$(dirname "$STATE_FILE")"
  _clk_script=""
  for _c in "$_clk_dir/scripts/emit-session-clock.sh" "$_clk_dir/../scripts/emit-session-clock.sh"; do
    if [[ -f "$_c" ]]; then _clk_script="$_c"; break; fi
  done
  if [[ -n "$_clk_script" ]]; then
    _clk=$(bash "$_clk_script" render "$STARTED_AT" "$DURATION_SECONDS" "$ELAPSED" "${REMAINING:-}" "$(goal_snippet)" 2>/dev/null)
    [[ -n "$_clk" ]] && CLOCK_SEG=" | $_clk"
  fi
fi

# COMPLETION_DISCIPLINE — when a hard-blocker marker was emitted but NOT honored
# (contradictory markers, or P13 judged it buildable/not-earned), surface that steer.
CD_STEER=""
[[ -n "${CD_CONTRADICTORY_STEER:-}" ]] && CD_STEER=" | ${CD_CONTRADICTORY_STEER}"

# When a completion CONDITION is set, an independent judge decides "done" — steer
# toward the condition + feed back the judge's latest reason (mirrors /goal). When
# only a legacy promise is set, keep the self-declared-promise directive.
if [[ -n "$COMPLETION_CONDITION" ]]; then
  GUIDANCE=""
  [[ -n "$EVAL_REASON" ]] && GUIDANCE=" | Not done yet: ${EVAL_REASON}"
  SYSTEM_MSG="🔄 Autonomous iteration $NEXT_ITERATION ($TIME_MSG)${CLOCK_SEG} | Keep working until this is TRUE: ${COMPLETION_CONDITION}${GUIDANCE}${CD_STEER} | An independent check decides done from what you SURFACE — run the real checks and show the evidence. Do NOT defer — do it now${REPORT_DIRECTIVE}"
else
  P13_NOTE=""
  [[ -n "${P13_GUIDANCE:-}" ]] && P13_NOTE=" | ${P13_GUIDANCE}"
  SYSTEM_MSG="🔄 Autonomous iteration $NEXT_ITERATION ($TIME_MSG)${CLOCK_SEG} | Complete ALL tasks, then output <promise>$COMPLETION_PROMISE</promise>${P13_NOTE}${CD_STEER} | Do NOT defer to future self — if you can do it now, DO IT NOW${REPORT_DIRECTIVE}"
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
