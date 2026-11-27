#!/usr/bin/env bash
# threadline-reply.sh — Reply to the other agent from a conversation in its own place.
#
# Usage (inside a session that runs in another agent's place; the server set its token):
#   .instar/scripts/threadline-reply.sh --thread <thread-id> "your reply"
#   printf '%s' "longer reply" | .instar/scripts/threadline-reply.sh --thread <thread-id>
#   (no heredoc: the sandbox gives a heredoc no temp folder)
#   .instar/scripts/threadline-reply.sh --ack <ref> "one-line summary of what was asked"
#
# The session's own token is the only destination authority: the script never names the other
# agent. The server sends to the agent this conversation is with, on a thread that belongs to it.
# Spec: docs/specs/memory-privacy-agent-places.md §5.
# threadline-reply-feature: session-bound-v1

set -euo pipefail

THREAD=""
ACKS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --thread)
      [ $# -ge 2 ] || { echo "Error: --thread needs a thread id" >&2; exit 1; }
      THREAD="$2"; shift 2 ;;
    --ack)
      [ $# -ge 2 ] || { echo "Error: --ack needs an ack reference" >&2; exit 1; }
      ACKS+=("$2"); shift 2 ;;
    *) break ;;
  esac
done

if [ $# -gt 0 ]; then
  MESSAGE="$*"
elif [ ! -t 0 ]; then
  MESSAGE="$(cat)"
else
  MESSAGE=""
fi
if [ -z "$MESSAGE" ] && [ ${#ACKS[@]} -eq 0 ]; then
  echo "Error: no reply text provided" >&2
  exit 1
fi

PORT="${INSTAR_PORT:-}"
AUTH="${INSTAR_AUTH_TOKEN:-}"
AGENT_ID="${INSTAR_AGENT_ID:-}"
PORT="${PORT:-4042}"

# Pure shell, no python and no temp files: inside a memory-privacy sandbox the working
# directory and the system temp root are unreadable, so an interpreter or a heredoc fails there.
json_str() {
  local v
  v=$(printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037')
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  v=${v//$'\n'/\\n}
  v=${v//$'\r'/\\r}
  v=${v//$'\t'/\\t}
  printf '"%s"' "$v"
}

# With --ack, the text is the acknowledgment's summary; otherwise the text is the reply.
FIELDS=()
if [ ${#ACKS[@]} -gt 0 ]; then
  REFS=""
  for a in "${ACKS[@]}"; do REFS="${REFS:+$REFS,}$(json_str "$a")"; done
  FIELDS+=("\"ackRefs\": [${REFS}]" "\"summary\": $(json_str "${MESSAGE:0:500}")")
elif [ -n "$MESSAGE" ]; then
  FIELDS+=("\"text\": $(json_str "$MESSAGE")")
fi
[ -n "$THREAD" ] && FIELDS+=("\"threadId\": $(json_str "$THREAD")")
BODY_JSON="{$(IFS=,; printf '%s' "${FIELDS[*]}")}"

set +e
RESPONSE=$(curl -sS --connect-timeout 3 --max-time 75 -w "\n%{http_code}" -X POST \
  "http://localhost:${PORT}/threadline/session-reply" \
  -H "Content-Type: application/json" \
  ${AUTH:+-H "Authorization: Bearer $AUTH"} \
  ${AGENT_ID:+-H "X-Instar-AgentId: $AGENT_ID"} \
  -d "$BODY_JSON")
CURL_STATUS=$?
set -e

if [ "$CURL_STATUS" -ne 0 ]; then
  echo "AMBIGUOUS: the request started but its outcome is unknown. Do not resend blindly." >&2
  exit 1
fi
HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Sent."
  exit 0
fi
echo "Not sent (HTTP $HTTP_CODE): $BODY" >&2
exit 1
