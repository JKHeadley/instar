#!/usr/bin/env bash
# gh-identity-guard.sh — PreToolUse hook (Bash) [BLOCKING]
# HARD BLOCKS any gh CLI command unless EchoOfDawn is the active account.
# Does NOT silently switch — forces the agent to be aware of the identity requirement.

set -euo pipefail

# Parse the tool input from $1 (JSON)
TOOL_INPUT="${1:-}"

# Extract the command from the JSON input
COMMAND=$(echo "$TOOL_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('command',''))" 2>/dev/null || echo "$TOOL_INPUT")

# Quick check: does this command involve gh CLI?
# Match "gh " at start or after shell operators (&& || ; | $( `)
if ! echo "$COMMAND" | grep -qE '(^|[;&|`(])\s*gh\s'; then
  exit 0
fi

# Check current active account
CURRENT=$(gh auth status 2>&1 | grep "Active account: true" -B3 | head -1 | grep -oE 'account \S+' | awk '{print $2}' || true)

if [ "$CURRENT" = "EchoOfDawn" ]; then
  exit 0
fi

# BLOCK — do not silently switch, do not allow execution
cat <<'BLOCK'
BLOCKED: gh command detected but active GitHub account is not EchoOfDawn.

Current active account: JKHeadley
Required active account: EchoOfDawn

Run: gh auth switch --user EchoOfDawn
Then retry the command.

This guard exists to prevent Echo from posting GitHub activity under Justin's personal account.
BLOCK

exit 2
