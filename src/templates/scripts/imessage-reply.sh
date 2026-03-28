#!/bin/bash
# imessage-reply.sh — Send a reply via iMessage and notify the instar server.
#
# Usage:
#   ./imessage-reply.sh RECIPIENT "message text"
#   echo "message text" | ./imessage-reply.sh RECIPIENT
#   cat <<'EOF' | ./imessage-reply.sh RECIPIENT
#   Multi-line message here
#   EOF
#
# RECIPIENT is a phone number (+14081234567) or email (user@icloud.com).
#
# This script does TWO things:
#   1. Sends the iMessage via `imsg send` CLI (requires Automation permission)
#   2. Notifies the server via POST /imessage/reply/:recipient (for logging + stall tracking)
#
# The server CANNOT send iMessages itself (LaunchAgent lacks Automation permission).
# This script runs from Claude Code sessions in tmux, which have the right context.

RECIPIENT="$1"
shift

if [ -z "$RECIPIENT" ]; then
  echo "Usage: imessage-reply.sh RECIPIENT [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

# ── Step 1: Send via imsg CLI ──────────────────────────────────────

IMSG="${IMSG_PATH:-imsg}"
if ! command -v "$IMSG" &>/dev/null; then
  # Common homebrew locations
  for candidate in /opt/homebrew/bin/imsg /usr/local/bin/imsg "$HOME/homebrew/bin/imsg"; do
    if [ -x "$candidate" ]; then
      IMSG="$candidate"
      break
    fi
  done
fi

if ! command -v "$IMSG" &>/dev/null && [ ! -x "$IMSG" ]; then
  echo "imsg not found. Install: brew install steipete/tap/imsg" >&2
  exit 1
fi

"$IMSG" send --to "$RECIPIENT" --text "$MSG" --service imessage 2>/dev/null
SEND_STATUS=$?

if [ $SEND_STATUS -ne 0 ]; then
  echo "imsg send failed (exit $SEND_STATUS)" >&2
  exit 1
fi

# ── Step 2: Notify server (logging + stall clear) ─────────────────

PORT="${INSTAR_PORT:-4040}"

AUTH_TOKEN=""
if [ -f ".instar/config.json" ]; then
  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
fi

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  JSON_MSG="\"$(printf '%s' "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')\""
fi

# URL-encode the recipient
ENCODED_RECIPIENT=$(printf '%s' "$RECIPIENT" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))' 2>/dev/null)
if [ -z "$ENCODED_RECIPIENT" ]; then
  ENCODED_RECIPIENT="$RECIPIENT"
fi

# POST to server — non-critical (message already sent)
if [ -n "$AUTH_TOKEN" ]; then
  curl -s -o /dev/null -w "" -X POST "http://localhost:${PORT}/imessage/reply/${ENCODED_RECIPIENT}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -d "{\"text\":${JSON_MSG}}" 2>/dev/null || \
    echo "Warning: server notification failed (message was sent)" >&2
else
  curl -s -o /dev/null -w "" -X POST "http://localhost:${PORT}/imessage/reply/${ENCODED_RECIPIENT}" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":${JSON_MSG}}" 2>/dev/null || \
    echo "Warning: server notification failed (message was sent)" >&2
fi

echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to $RECIPIENT"
