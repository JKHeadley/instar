#!/bin/bash
# post-update.sh — Post an update/announcement to the Agent Updates topic.
#
# Usage:
#   .claude/scripts/post-update.sh "message text"
#   echo "message text" | .claude/scripts/post-update.sh
#   cat <<'EOF' | .claude/scripts/post-update.sh
#   Multi-line update message here
#   EOF
#
# This script does NOT accept a topic ID. The destination is always the
# Agent Updates topic, resolved server-side from .instar/state/agent-updates-topic.
# If the Updates topic isn't configured, the server returns an error and this
# script exits non-zero — never a silent fallback to a different topic.

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  echo "Usage: post-update.sh [message]   (or pipe via stdin)" >&2
  exit 1
fi

# Read port and auth token from config (if present)
CONFIG_PORT=""
AUTH_TOKEN=""
if [ -f ".instar/config.json" ]; then
  CONFIG_PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',''))" 2>/dev/null)
  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi
PORT="${INSTAR_PORT:-${CONFIG_PORT:-4042}}"

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  echo "python3 not available — cannot JSON-escape message" >&2
  exit 1
fi

if [ -n "$AUTH_TOKEN" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/telegram/post-update" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{\"text\":${JSON_MSG}}")
else
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:${PORT}/telegram/post-update" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":${JSON_MSG}}")
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  TOPIC=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('topicId',''))" 2>/dev/null)
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to Agent Updates topic (ID ${TOPIC})"
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
