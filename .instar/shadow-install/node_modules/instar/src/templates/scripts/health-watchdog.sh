#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
#
# Install as a cron job:
#   */5 * * * * /path/to/health-watchdog.sh >> /path/to/.instar/logs/watchdog.log 2>&1
#
# Or run via launchd on macOS.

# Configuration — set these for your project
PROJECT_DIR="${INSTAR_PROJECT_DIR:-$(dirname "$(dirname "$(realpath "$0")")")}"
PORT="${INSTAR_PORT:-4040}"
SERVER_SESSION="${INSTAR_SERVER_SESSION:-agent-server}"
TMUX_PATH="${INSTAR_TMUX:-/opt/homebrew/bin/tmux}"

# Find tmux if not at default path
if [ ! -f "$TMUX_PATH" ]; then
  TMUX_PATH=$(which tmux 2>/dev/null)
fi

if [ -z "$TMUX_PATH" ] || [ ! -f "$TMUX_PATH" ]; then
  echo "[$(date -Iseconds)] ERROR: tmux not found"
  exit 1
fi

# Check if server is responding
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  # Server is healthy — nothing to do
  exit 0
fi

echo "[$(date -Iseconds)] Server not responding (HTTP: ${HTTP_CODE}). Checking tmux..."

# Check if tmux session exists
if $TMUX_PATH has-session -t "=${SERVER_SESSION}" 2>/dev/null; then
  echo "[$(date -Iseconds)] Session '${SERVER_SESSION}' exists but server not responding. Killing and restarting..."
  $TMUX_PATH kill-session -t "=${SERVER_SESSION}" 2>/dev/null
  sleep 2
fi

# Restart the server
CLI_PATH="${PROJECT_DIR}/node_modules/.bin/instar"
if [ ! -f "$CLI_PATH" ]; then
  CLI_PATH=$(which instar 2>/dev/null)
fi

if [ -z "$CLI_PATH" ] || [ ! -f "$CLI_PATH" ]; then
  echo "[$(date -Iseconds)] ERROR: instar CLI not found"
  exit 1
fi

cd "$PROJECT_DIR" && $CLI_PATH server start
echo "[$(date -Iseconds)] Server restart initiated"

# Wait and verify
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
  echo "[$(date -Iseconds)] Server recovered successfully"
else
  echo "[$(date -Iseconds)] WARNING: Server still not responding after restart (HTTP: ${HTTP_CODE})"
fi
