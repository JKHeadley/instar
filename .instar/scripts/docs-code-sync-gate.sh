#!/usr/bin/env bash
# Gate script for docs-code-sync job
# Exit 0 (run job) if there are new commits since last check
# Exit 1 (skip job) if no changes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTAR_DIR="${SCRIPT_DIR}/.."
STATE_FILE="$INSTAR_DIR/state/docs-code-sync.json"
INSTAR_SOURCE="/Users/justin/Documents/Projects/instar"

# First run — no state file means always run (will bootstrap)
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Read last checked commit
LAST_COMMIT=$(python3 -c "
import json, sys
try:
    data = json.load(open('$STATE_FILE'))
    print(data.get('lastCheckedCommit', ''))
except:
    print('')
" 2>/dev/null)

# Empty or unreadable — always run
if [ -z "$LAST_COMMIT" ]; then
  exit 0
fi

# Get current HEAD of instar source
CURRENT_HEAD=$(cd "$INSTAR_SOURCE" && git rev-parse HEAD 2>/dev/null)

if [ -z "$CURRENT_HEAD" ]; then
  # Can't read git — run anyway, let the job handle the error
  exit 0
fi

if [ "$LAST_COMMIT" = "$CURRENT_HEAD" ]; then
  exit 1  # No changes, skip
fi

exit 0  # Changes found, run
