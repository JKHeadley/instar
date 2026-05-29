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
# Exit codes:
# - 0: Success (context injected or no telegram prefix found)

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
m = re.search(r'\[telegram:(\d+)', line)
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

# Resolve the auth token. INSTAR_AUTH_TOKEN env first — SessionManager injects
# this into every spawned Claude Code session, so hooks running inside a session
# always have it; survives the secret-externalization refactor that moved authToken
# out of config.json into the encrypted store. Legacy fallback reads config.json
# with a string-type guard: after externalization the value is the literal
# placeholder { "secret": true } — the guard rejects it and yields empty so we
# never send the placeholder as a Bearer token (which the server rejects with 403,
# silently breaking history injection — the 2026-05-29 incident this fix is for).
AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"
if [ -z "$AUTH_TOKEN" ] && [ -f "$CONFIG_FILE" ]; then
  AUTH_TOKEN=$(python3 -c "import json; v=json.load(open('$CONFIG_FILE')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
fi

# Fetch recent messages for this topic
if [ -n "$AUTH_TOKEN" ]; then
  RECENT_MSGS=$(curl -s \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    "http://localhost:${PORT}/telegram/topics/${TOPIC_ID}/messages?limit=30" 2>/dev/null)
else
  RECENT_MSGS=$(curl -s \
    "http://localhost:${PORT}/telegram/topics/${TOPIC_ID}/messages?limit=30" 2>/dev/null)
fi

# Layer 2: prepend the topic intent briefing if anything has accumulated.
# Returns empty body when nothing tracked yet — we silently skip injection.
# Degrades open: any failure here (server down, route 503'd, network blip)
# leaves recent-history-only output unchanged.
TOPIC_BRIEFING=""
if [ -n "$AUTH_TOKEN" ]; then
  TOPIC_BRIEFING=$(curl -s --max-time 2 \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
else
  TOPIC_BRIEFING=$(curl -s --max-time 2 \
    "http://localhost:${PORT}/topic-intent/${TOPIC_ID}/briefing" 2>/dev/null)
fi

if [ -n "$TOPIC_BRIEFING" ]; then
  echo "$TOPIC_BRIEFING"
  echo ""
fi

# Format and output context with unanswered message detection
echo "$RECENT_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    if not msgs:
        sys.exit(0)

    print('TOPIC ${TOPIC_ID} RECENT HISTORY (auto-injected — read this before responding):')

    for m in msgs:
        ts = m.get('timestamp', '')[:16].replace('T', ' ')
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        text = m.get('text', '').strip()
        sender = 'User' if from_user else 'Agent'
        if len(text) > 2000:
            text = text[:1997] + '...'
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
            pm_ts = pm.get('timestamp', '')[:16].replace('T', ' ')
            print(f'  [{pm_ts}] \"{pm_text}\"')
        print()
        print('You MUST address these messages substantively. Do NOT respond with just')
        print('a greeting or generic reply. Read the conversation history above and')
        print('respond to what the user actually said. If the current message is a')
        print('follow-up like \"hello?\" or \"please respond\", address the EARLIER')
        print('unanswered message — that is what the user is waiting for.')
except Exception:
    pass
" 2>/dev/null

exit 0
