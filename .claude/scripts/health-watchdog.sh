#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
# Install as cron: */5 * * * * '/Users/justin/.instar/agents/echo/.claude/scripts/health-watchdog.sh'

PORT="4042"
SERVER_SESSION="echo-server"
PROJECT_DIR='/Users/justin/.instar/agents/echo'
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx instar server start
echo "[$(date -Iseconds)] Server restart initiated"
