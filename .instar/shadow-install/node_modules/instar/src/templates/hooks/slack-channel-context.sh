#!/usr/bin/env bash
# slack-channel-context.sh — UserPromptSubmit hook
#
# Detects [slack:CHANNEL_ID] prefix in user messages and injects
# channel conversation history as JSON context.
#
# Reads from the ring buffer cache via instar server API —
# zero Slack API calls per prompt.

set -euo pipefail

# Read user prompt from stdin (JSON format from Claude Code)
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('userMessage',''))" 2>/dev/null) || exit 0

# Check for [slack:C...] prefix
if [[ "$PROMPT" =~ \[slack:([A-Z0-9]+)\] ]]; then
  CHANNEL_ID="${BASH_REMATCH[1]}"
else
  exit 0
fi

# Get port and auth from config
PORT="${INSTAR_PORT:-}"
AUTH=""

if [ -f ".instar/config.json" ]; then
  if [ -z "$PORT" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',''))" 2>/dev/null)
    [ -n "$CONFIG_PORT" ] && PORT="$CONFIG_PORT"
  fi
  AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

PORT="${PORT:-4042}"

# Check server health
if ! curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  exit 0  # Server not running — graceful degradation
fi

# Fetch channel history from ring buffer cache
MESSAGES=$(curl -sf \
  ${AUTH:+-H "Authorization: Bearer $AUTH"} \
  "http://localhost:${PORT}/slack/channels/${CHANNEL_ID}/messages?limit=30" 2>/dev/null) || exit 0

# Format thread history for session context
python3 -c "
import json, sys
from datetime import datetime

data = json.loads('''${MESSAGES}''')
messages = data.get('messages', [])

if not messages:
    sys.exit(0)

lines = ['--- Thread History (last {} messages) ---'.format(len(messages))]
lines.append('IMPORTANT: Read this history carefully before taking any action.')
lines.append('Your task is to continue THIS conversation, not start something new.')
lines.append('Topic: slack-{}'.format('${CHANNEL_ID}'))
lines.append('')

unanswered = 0
for msg in messages:
    ts = msg.get('ts', '')
    try:
        dt = datetime.fromtimestamp(float(ts))
        time_str = dt.strftime('%H:%M:%S')
    except:
        time_str = ts

    user = msg.get('user', 'unknown')
    text = msg.get('text', '')

    # Truncate very long messages
    if len(text) > 2000:
        text = text[:2000] + '...'

    # Determine if from user or agent
    sender = 'User' if msg.get('fromUser', True) else 'Agent'
    lines.append('[{}] {}: {}'.format(time_str, sender, text))

lines.append('')
lines.append('--- End Thread History ---')
lines.append('')
lines.append('CRITICAL: You MUST relay your response back to Slack after responding.')
lines.append('Use the relay script:')
lines.append('')
lines.append(\"cat <<'EOF' | .claude/scripts/slack-reply.sh ${CHANNEL_ID}\")
lines.append('Your response text here')
lines.append('EOF')
lines.append('')
lines.append('Strip the [slack:${CHANNEL_ID}] prefix before interpreting the message.')
lines.append('Only relay conversational text — not tool output or internal reasoning.')

print('\n'.join(lines))
" 2>/dev/null || exit 0
