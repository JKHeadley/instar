#!/usr/bin/env bash
# slack-reply.sh — Send a message to a Slack channel via the instar server.
#
# Usage:
#   slack-reply.sh CHANNEL_ID "message text"
#   slack-reply.sh CHANNEL_ID THREAD_TS "message text"   # reply IN a thread
#   echo "message" | slack-reply.sh CHANNEL_ID
#   echo "message" | slack-reply.sh CHANNEL_ID THREAD_TS  # reply IN a thread
#   cat <<'EOF' | slack-reply.sh CHANNEL_ID
#   Multi-line message here
#   EOF
#
# THREAD_TS (optional, 2nd positional): when this session belongs to a Slack
# thread (threads-as-sessions, §5.3), pass the thread id so the reply lands in
# that thread instead of the channel root. A thread id is a Slack timestamp like
# 1699999999.000100 (digits + a single dot). Omit it for a channel-level reply
# (today's default behavior, unchanged).
# slack-reply-feature: thread-ts-arg
# slack-reply-feature: delivery-id  (pre-POST X-Instar-DeliveryId + 409 non-losing, §2.6/R8-M1 Arm C)

set -euo pipefail

CHANNEL_ID="$1"
shift

# Optional 2nd positional THREAD_TS — recognized only when it looks like a Slack
# timestamp (digits.digits). This keeps the 1-arg form ("CHANNEL_ID message…")
# backward-compatible: a normal message word is never mistaken for a thread id.
THREAD_TS=""
if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+\.[0-9]+$ ]]; then
  THREAD_TS="$1"
  shift
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "Error: no message text provided" >&2
  exit 1
fi

# Guard against channel flooding — truncate extremely long messages
MAX_CHARS=4000
if [ ${#MESSAGE} -gt $MAX_CHARS ]; then
  ORIGINAL_LEN=${#MESSAGE}
  MESSAGE="${MESSAGE:0:$MAX_CHARS}

_(Message truncated from ${ORIGINAL_LEN} to ${MAX_CHARS} characters)_"
  echo "Warning: message truncated from ${ORIGINAL_LEN} to ${MAX_CHARS} chars" >&2
fi

# Get port from env or config
PORT="${INSTAR_PORT:-}"
AUTH=""
AGENT_ID="${INSTAR_AGENT_ID:-}"

if [ -f ".instar/config.json" ]; then
  if [ -z "$PORT" ]; then
    CONFIG_PORT=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('port',''))" 2>/dev/null)
    [ -n "$CONFIG_PORT" ] && PORT="$CONFIG_PORT"
  fi
  # Auth: env first (SessionManager injects it into spawned sessions; survives
  # secret-externalization), legacy plaintext-config fallback with string-type
  # guard so the { "secret": true } placeholder produced by SecretMigrator
  # cannot leak as a bogus Bearer.
  AUTH="${INSTAR_AUTH_TOKEN:-}"
  if [ -z "$AUTH" ]; then
    AUTH=$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
  fi
  if [ -z "$AGENT_ID" ]; then
    AGENT_ID=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)
  fi
fi

PORT="${PORT:-4042}"

# JSON-escape the message
ESCAPED=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$MESSAGE" 2>/dev/null)
# Fallback to basic bash escaping if python unavailable
if [ -z "$ESCAPED" ]; then
  ESCAPED="\"$(echo "$MESSAGE" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
fi

# Build JSON body — include thread_ts only when threading a reply.
if [ -n "$THREAD_TS" ]; then
  BODY_JSON="{\"text\": ${ESCAPED}, \"thread_ts\": \"${THREAD_TS}\"}"
else
  BODY_JSON="{\"text\": ${ESCAPED}}"
fi

# ── delivery-id minted BEFORE the first POST (spec slack-outbound-robustness
# §2.6 / §2.4) ──
# Sent as X-Instar-DeliveryId on the INITIAL send so the server records THIS id
# the moment the send lands; a duplicate POST with the same id is then answered
# idempotent:true instead of re-posting (the double-post window the deployed
# headerless send left open). A mint failure (python3 gone) degrades to today's
# headerless send — fail toward delivery, never a refused send.
DELIVERY_ID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)

# Send via Instar server
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "http://localhost:${PORT}/slack/reply/${CHANNEL_ID}" \
  -H "Content-Type: application/json" \
  ${AUTH:+-H "Authorization: Bearer $AUTH"} \
  ${AGENT_ID:+-H "X-Instar-AgentId: $AGENT_ID"} \
  ${DELIVERY_ID:+-H "X-Instar-DeliveryId: $DELIVERY_ID"} \
  -d "$BODY_JSON")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent ${#MESSAGE} chars to channel ${CHANNEL_ID}"
elif [ "$HTTP_CODE" = "408" ]; then
  # Request timeout on the server side — the outbound path (tone gate + Slack API)
  # exceeded the route's budget. The actual send may have completed anyway.
  # Report AMBIGUOUS and exit 0 so the agent verifies before retrying (a retry
  # would double-send since the first attempt likely went through).
  echo "AMBIGUOUS (HTTP 408): server timed out; the message MAY have been delivered." >&2
  echo "  Do NOT retry blindly — check the channel to verify delivery before resending." >&2
  echo "  If the message is there, proceed; if not, retry with a shorter/simpler version." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
elif [ "$HTTP_CODE" = "409" ]; then
  # 409 delivery-in-flight (spec R8-M1 Arm C): the server's §2.4 single-flight
  # reservation saw a concurrent POST for THIS delivery-id still in flight — the
  # message is ALREADY being delivered under this id. This is NON-LOSING:
  # do NOT re-send (that is the double-post the reservation exists to close) and
  # do NOT drop. Exit 0; the in-flight call owns delivery. An UNSTRUCTURED 409
  # is a genuine conflict → terminal (exit 1).
  IN_FLIGHT_CODE=$(echo "$BODY" | python3 -c 'import sys,json
try:
  print(json.load(sys.stdin).get("error",""))
except Exception:
  print("")' 2>/dev/null || echo "")
  if [ "$IN_FLIGHT_CODE" = "delivery-in-flight" ]; then
    echo "IN-FLIGHT (HTTP 409): this message is already being delivered under the same id; not re-sending." >&2
    echo "IN-FLIGHT (HTTP 409): delivery in progress — not re-sent (idempotent)"
    exit 0
  fi
  echo "Failed (HTTP ${HTTP_CODE}): ${BODY}" >&2
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
