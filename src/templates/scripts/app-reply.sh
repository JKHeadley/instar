#!/usr/bin/env bash
# app-reply.sh — Reply into a native Instar app conversation via the instar server.
#
# Usage (inside a session spawned for an app conversation — INSTAR_CONVERSATION_ID is negative
# and INSTAR_BIND_TOKEN is set by the server):
#   cat <<'EOF' | .instar/scripts/app-reply.sh
#   Your reply text here
#   EOF
#   .instar/scripts/app-reply.sh "short reply"
#
# The session's bind token is the only destination authority: the script never names a
# conversation itself. Spec: docs/specs/mobile-native-conversations.md §4.3.
# app-reply-feature: session-bound-v1
# app-reply-feature: delivery-id

set -euo pipefail

# Every send decision (binding, ownership, tone) is the SERVER's: outside an app-conversation
# session the request simply lacks the binding and the server refuses it with a reason.
CONVERSATION_ID="${INSTAR_CONVERSATION_ID:-0}"
[[ "$CONVERSATION_ID" =~ ^-?[0-9]+$ ]] || CONVERSATION_ID=0

if [ $# -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi
if [ -z "$MESSAGE" ]; then
  echo "Error: no message text provided" >&2
  exit 1
fi

MAX_CHARS=4000
if [ ${#MESSAGE} -gt $MAX_CHARS ]; then
  ORIGINAL_LEN=${#MESSAGE}
  MESSAGE="${MESSAGE:0:$MAX_CHARS}

(Message truncated from ${ORIGINAL_LEN} to ${MAX_CHARS} characters)"
  echo "Warning: message truncated from ${ORIGINAL_LEN} to ${MAX_CHARS} chars" >&2
fi

PORT="${INSTAR_PORT:-}"
AUTH="${INSTAR_AUTH_TOKEN:-}"
AGENT_ID="${INSTAR_AGENT_ID:-}"
if [ -f ".instar/config.json" ]; then
  if [ -z "$PORT" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',''))" 2>/dev/null)
    [ -n "$CONFIG_PORT" ] && PORT="$CONFIG_PORT"
  fi
  if [ -z "$AUTH" ]; then
    AUTH=$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  if [ -z "$AGENT_ID" ]; then
    AGENT_ID=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)
  fi
fi
PORT="${PORT:-4042}"

ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$MESSAGE" 2>/dev/null)
if [ -z "$ESCAPED" ]; then
  ESCAPED="\"$(echo "$MESSAGE" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
fi
BODY_JSON="{\"text\": ${ESCAPED}, \"conversationId\": ${CONVERSATION_ID}}"

# A delivery id minted BEFORE the POST: the server derives the reply's event id from it, so a
# resend of the same attempt is answered idempotent instead of appending a second copy.
DELIVERY_ID="${INSTAR_DELIVERY_ID:-}"
[[ "$DELIVERY_ID" =~ ^[0-9a-fA-F-]{16,64}$ ]] || DELIVERY_ID=""
[ -n "$DELIVERY_ID" ] || DELIVERY_ID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)

set +e
RESPONSE=$(curl -sS --connect-timeout 3 --max-time 35 -w "\n%{http_code}" -X POST \
  "http://localhost:${PORT}/app/session-reply" \
  -H "Content-Type: application/json" \
  ${AUTH:+-H "Authorization: Bearer $AUTH"} \
  ${AGENT_ID:+-H "X-Instar-AgentId: $AGENT_ID"} \
  ${INSTAR_BIND_TOKEN:+-H "X-Instar-Bind-Token: $INSTAR_BIND_TOKEN"} \
  ${DELIVERY_ID:+-H "X-Instar-DeliveryId: $DELIVERY_ID"} \
  -d "$BODY_JSON")
CURL_STATUS=$?
set -e

if [ "$CURL_STATUS" -ne 0 ]; then
  echo "AMBIGUOUS: relay transport failed after request start; outcome unknown." >&2
  echo "  Do NOT auto-retry blindly. Delivery id: ${DELIVERY_ID}" >&2
  exit 1
fi

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent ${#MESSAGE} chars to the app conversation"
elif [ "$HTTP_CODE" = "409" ]; then
  echo "NOT SENT (HTTP 409): this machine does not run this app conversation right now: ${BODY}" >&2
  exit 1
elif [ "$HTTP_CODE" = "422" ]; then
  ISSUE=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("issue","unknown"))' 2>/dev/null || echo "unknown")
  SUGGESTION=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("suggestion",""))' 2>/dev/null || echo "")
  echo "BLOCKED by tone gate — message not sent to user." >&2
  echo "  Issue: $ISSUE" >&2
  if [ -n "$SUGGESTION" ]; then
    echo "  Suggestion: $SUGGESTION" >&2
  fi
  echo "  Revise the message (remove CLI commands, file paths, config syntax, API endpoints) and retry." >&2
  exit 1
else
  echo "Failed (HTTP ${HTTP_CODE}): ${BODY}" >&2
  exit 1
fi
