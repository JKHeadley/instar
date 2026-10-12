#!/bin/bash
# UserPromptSubmit Hook: Auto-inject Telegram topic history context.
#
# When a user prompt contains [telegram:N], this hook reads the recent
# conversation history for that topic and injects it as context. Also
# detects unanswered user messages and surfaces them with directives.
#
# This prevents the "what are we talking about?" failure after compaction
# or session restart — where the agent receives a message without
# conversation context and responds with a generic greeting.
#
# Time injection: fires on every UserPromptSubmit regardless of [telegram:N]
# prefix so the agent always sees current wall-clock time. Addresses the
# Claude Code "harness injects date, not time of day" blind spot that caused
# agents to hallucinate clock times in long sessions.

# Current wall-clock time — always emitted, BEFORE the [telegram:N] early-exit.
NOW=$(date +'%Y-%m-%d %H:%M:%S %z (%Z)' 2>/dev/null)
if [ -n "$NOW" ]; then
  echo "--- CURRENT TIME ---"
  echo "$NOW"
  echo "Wall-clock at user-prompt submit. Quote this — do not carry stale clock times from prior context."
  echo "--- END CURRENT TIME ---"
  echo ""
fi

# Read the user prompt from stdin (Claude Code pipes JSON with { prompt: "..." })
USER_PROMPT=$(python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('prompt', ''))
except:
    print('')
" 2>/dev/null)

# Check for [telegram:N] prefix
TOPIC_ID=$(echo "$USER_PROMPT" | python3 -c "
import sys, re
line = sys.stdin.read()
m = re.search(r'\\[telegram:(\\d+)', line)
if m:
    print(m.group(1))
" 2>/dev/null)

if [ -z "$TOPIC_ID" ]; then
  exit 0
fi

# Get server port from config
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="$INSTAR_DIR/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  exit 0
fi

PORT=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' | head -1)
if [ -z "$PORT" ]; then
  exit 0
fi

# Check server health
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
if [ "$HEALTH" != "200" ]; then
  exit 0
fi

# Resolve the auth token. INSTAR_AUTH_TOKEN env first (set by SessionManager and
# JobScheduler for every spawned session) — survives the secret-externalization
# refactor that moved authToken out of config.json into the encrypted store.
# Legacy fallback: read from config.json with a string-type guard. When authToken
# has been externalized, the value is the literal placeholder { "secret": true } —
# the guard rejects it and yields empty, so we never send the placeholder as a
# Bearer token (which the server rejects with 403, silently breaking history
# injection — the 2026-05-29 incident this fix is for).
AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"
if [ -z "$AUTH_TOKEN" ] && [ -f "$CONFIG_FILE" ]; then
  AUTH_TOKEN=$(python3 -c "import json; v=json.load(open('$CONFIG_FILE')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
fi
AGENT_ID="${INSTAR_AGENT_ID:-}"
if [ -z "$AGENT_ID" ] && [ -f "$CONFIG_FILE" ]; then
  AGENT_ID=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('projectName',''))" 2>/dev/null)
fi

# Session-clock injection (query mode) — surface elapsed/remaining for an active
# time-boxed session on this user turn too (not just autonomous continuations),
# so the agent quotes the real clock instead of guessing. Signal-only: emits
# nothing when no time-boxed session is active or the server is unreachable.
# Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md (Component 2, query mode).
if [ -f "$INSTAR_DIR/scripts/emit-session-clock.sh" ]; then
  bash "$INSTAR_DIR/scripts/emit-session-clock.sh" query "$TOPIC_ID" "$PORT" "$AUTH_TOKEN" "$AGENT_ID" 2>/dev/null
fi

# Fetch recent messages for this topic
if [ -n "$AUTH_TOKEN" ]; then
  RECENT_MSGS=$(curl -s \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "X-Instar-AgentId: ${AGENT_ID}" \
    "http://localhost:${PORT}/telegram/topics/${TOPIC_ID}/messages?limit=15" 2>/dev/null)
else
  RECENT_MSGS=$(curl -s \
    "http://localhost:${PORT}/telegram/topics/${TOPIC_ID}/messages?limit=15" 2>/dev/null)
fi

# Prepend the Topic Intent briefing. This is the actual delivery seam for the
# topic / recent-arc / current-work awareness projection. It is best-effort:
# a missing/disabled route leaves recent-history injection unchanged.
TOPIC_BRIEFING=""
if [ -n "$AUTH_TOKEN" ]; then
  TOPIC_BRIEFING=$(curl -sf --max-time 2 \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "X-Instar-AgentId: ${AGENT_ID}" \
    "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
else
  TOPIC_BRIEFING=$(curl -sf --max-time 2 \
    "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
fi

if [ -n "$TOPIC_BRIEFING" ]; then
  echo "$TOPIC_BRIEFING"
  echo ""
fi

# Format and output context with unanswered message detection
echo "$RECENT_MSGS" | python3 -c "
import sys, json
def _localts(raw):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(raw).replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d %H:%M %Z')
    except Exception:
        return str(raw)[:16].replace('T', ' ')
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    if not msgs:
        sys.exit(0)

    print('TOPIC ${TOPIC_ID} RECENT HISTORY (auto-injected):')

    for m in msgs:
        ts = _localts(m.get('timestamp', ''))
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        text = m.get('text', '').strip()
        sender = 'User' if from_user else 'Agent'
        if len(text) > 300:
            text = text[:297] + '...'
        print(f'  [{ts}] {sender}: {text}')

    # Detect unanswered user messages
    pending_user = []
    for m in msgs:
        text = m.get('text', '').strip()
        if not text:
            continue
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        if from_user:
            pending_user.append(m)
        else:
            pending_user = []

    if pending_user:
        print()
        print('*** UNANSWERED MESSAGE(S) FROM USER ***')
        for pm in pending_user:
            pm_text = pm.get('text', '')[:200]
            pm_ts = _localts(pm.get('timestamp', ''))
            print(f'  [{pm_ts}] \\\"{pm_text}\\\"')
        print()
        print('You MUST address these messages substantively. Do NOT respond with just')
        print('a greeting or generic reply. Read the conversation history above and')
        print('respond to what the user actually said. If the current message is a')
        print('follow-up like \\\"hello?\\\" or \\\"please respond\\\", address the EARLIER')
        print('unanswered message — that is what the user is waiting for.')
except Exception:
    pass
" 2>/dev/null

exit 0
