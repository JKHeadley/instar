#!/usr/bin/env bash
# app-reply.sh — Reply into a native Instar app conversation via the instar server.
#
# Usage (inside a session spawned for an app conversation — INSTAR_CONVERSATION_ID is negative
# and INSTAR_BIND_TOKEN is set by the server):
#   cat <<'EOF' | .instar/scripts/app-reply.sh
#   Your reply text here
#   EOF
#   .instar/scripts/app-reply.sh "short reply"
#   .instar/scripts/app-reply.sh --file /path/to/report.pdf "Here it is"    (up to 10 --file, before the text;
#   a piped caption also works: it is read with a bounded wait, 2 s per line and 10 s in all)
#
# The session's bind token is the only destination authority: the script never names a
# conversation itself. Spec: docs/specs/mobile-native-conversations.md §4.3.
# app-reply-feature: session-bound-v1
# app-reply-feature: delivery-id
# app-reply-feature: file-attachments

set -euo pipefail

# Every send decision (binding, ownership, tone) is the SERVER's: outside an app-conversation
# session the request simply lacks the binding and the server refuses it with a reason.
CONVERSATION_ID="${INSTAR_CONVERSATION_ID:-0}"
[[ "$CONVERSATION_ID" =~ ^-?[0-9]+$ ]] || CONVERSATION_ID=0

# Flags go before the text: parsing stops at the first argument that is not a flag.
FILES=()
while [ $# -gt 0 ] && [ "$1" = "--file" ]; do
  if [ -z "${2:-}" ]; then
    echo "Error: --file needs a path" >&2
    exit 1
  fi
  FILES+=("$2")
  shift 2
done

if [ $# -gt 0 ]; then
  MESSAGE="$*"
elif [ ${#FILES[@]} -gt 0 ]; then
  # Files with no text argument: a piped caption (a heredoc) is read with a bounded wait, so a
  # stdin that never closes cannot block the send: 2 s for each line, 10 s in all. A terminal is
  # never read.
  MESSAGE=""
  if [ ! -t 0 ]; then
    START=$SECONDS
    LINES_READ=0
    STATUS=0
    while :; do
      LINE=""
      T0=$SECONDS
      if IFS= read -r -t 2 LINE; then STATUS=0; else STATUS=$?; fi
      # A timeout returns above 128 on bash 4+ but 1 on macOS's bash 3.2; a failed read that
      # took the full 2 s is a timeout either way (end of input returns at once).
      if [ "$STATUS" -gt 128 ] || { [ "$STATUS" -ne 0 ] && [ $((SECONDS - T0)) -ge 2 ]; }; then
        # Timed out: whatever arrived so far is the caption.
        [ "$LINES_READ" -gt 0 ] && echo "Warning: stopped waiting for more piped caption text after 2 s; sending what arrived." >&2
        break
      fi
      if [ "$STATUS" -ne 0 ]; then
        # End of input; a last line with no newline still counts.
        [ -n "$LINE" ] && MESSAGE="${MESSAGE}${LINE}"
        break
      fi
      if [ "$LINES_READ" -gt 0 ]; then MESSAGE="${MESSAGE}"$'\n'"${LINE}"; else MESSAGE="${LINE}"; fi
      LINES_READ=$((LINES_READ + 1))
      if [ $((SECONDS - START)) -ge 10 ]; then
        echo "Warning: piped caption text took over 10 s; sending what arrived, the rest was ignored." >&2
        break
      fi
    done
  fi
else
  MESSAGE="$(cat)"
fi
if [ -z "$MESSAGE" ] && [ ${#FILES[@]} -eq 0 ]; then
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
FILES_JSON=""
MAX_TIME=35
if [ ${#FILES[@]} -gt 0 ]; then
  # The server checks each file (and scans it), so a large reply takes longer than text.
  MAX_TIME=180
  FILES_JSON=$(python3 -c 'import json,os,sys; print(json.dumps([{"path": os.path.abspath(p)} for p in sys.argv[1:]]))' "${FILES[@]}")
  if [ -z "$FILES_JSON" ]; then
    echo "Error: could not read the --file paths" >&2
    exit 1
  fi
fi
BODY_JSON="{\"text\": ${ESCAPED}, \"conversationId\": ${CONVERSATION_ID}${FILES_JSON:+, \"files\": ${FILES_JSON}}}"

# A delivery id minted BEFORE the POST: the server derives the reply's event id from it, so a
# resend of the same attempt is answered idempotent instead of appending a second copy.
DELIVERY_ID="${INSTAR_DELIVERY_ID:-}"
[[ "$DELIVERY_ID" =~ ^[0-9a-fA-F-]{16,64}$ ]] || DELIVERY_ID=""
[ -n "$DELIVERY_ID" ] || DELIVERY_ID=$(python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null)

# message-origin-all-platforms §2: pass this session's origin credential so the server can record
# which harness and model wrote the reply. A surviving session can be re-enrolled after a server
# update without killing its process: read only its own server-published tmux credential, never
# print it. Absent or unverifiable, the server records what it can and the reply still sends.
if [ -n "${INSTAR_SESSION_NAME:-}" ] && command -v tmux >/dev/null 2>&1; then
  ORIGIN_ENV_ROW=$(tmux show-environment -t "=${INSTAR_SESSION_NAME}" INSTAR_ORIGIN_TOKEN 2>/dev/null || true)
  case "$ORIGIN_ENV_ROW" in
    INSTAR_ORIGIN_TOKEN=ior1_*) INSTAR_ORIGIN_TOKEN="${ORIGIN_ENV_ROW#INSTAR_ORIGIN_TOKEN=}" ;;
  esac
  unset ORIGIN_ENV_ROW
fi
case "${INSTAR_ORIGIN_TOKEN:-}" in
  ior1_*) ;;
  *) INSTAR_ORIGIN_TOKEN="" ;;
esac

set +e
RESPONSE=$(curl -sS --connect-timeout 3 --max-time "$MAX_TIME" -w "\n%{http_code}" -X POST \
  "http://localhost:${PORT}/app/session-reply" \
  -H "Content-Type: application/json" \
  ${AUTH:+-H "Authorization: Bearer $AUTH"} \
  ${AGENT_ID:+-H "X-Instar-AgentId: $AGENT_ID"} \
  ${INSTAR_BIND_TOKEN:+-H "X-Instar-Bind-Token: $INSTAR_BIND_TOKEN"} \
  ${INSTAR_ORIGIN_TOKEN:+-H "X-Instar-Origin-Session: $INSTAR_ORIGIN_TOKEN"} \
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
  echo "Sent ${#MESSAGE} chars and ${#FILES[@]} file(s) to the app conversation"
elif [ "$HTTP_CODE" = "409" ]; then
  echo "NOT SENT (HTTP 409): this machine does not run this app conversation right now: ${BODY}" >&2
  exit 1
elif [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "413" ] || [ "$HTTP_CODE" = "503" ] || [ "$HTTP_CODE" = "507" ]; then
  echo "NOT SENT (HTTP ${HTTP_CODE}): ${BODY}" >&2
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
