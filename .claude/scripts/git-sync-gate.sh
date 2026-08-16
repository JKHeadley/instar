#!/bin/bash
# Git Sync Gate — zero-token pre-screening for the git-sync job.
# Exit 0 = sync needed (proceed), exit 1 = nothing to sync (skip).
# Writes conflict severity to /tmp/instar-git-sync-severity for model tier selection.

SEVERITY_FILE="/tmp/instar-git-sync-severity"
echo "clean" > "$SEVERITY_FILE"

# Must be in a git repo with a remote
[ ! -d ".git" ] && exit 1
REMOTE=$(git remote | head -1)
[ -z "$REMOTE" ] && exit 1

# Check for local changes
LOCAL_CHANGES=$(git status --porcelain 2>/dev/null | head -1)

# Fetch remote (with timeout)
git fetch origin --quiet 2>/dev/null &
FETCH_PID=$!
( sleep 10 && kill "$FETCH_PID" 2>/dev/null ) &
wait "$FETCH_PID" 2>/dev/null

# Check for remote changes
TRACKING=$(git rev-parse --abbrev-ref "@{u}" 2>/dev/null)
BEHIND=0
AHEAD=0
if [ -n "$TRACKING" ]; then
  AB=$(git rev-list --left-right --count "HEAD...$TRACKING" 2>/dev/null)
  BEHIND=$(echo "$AB" | awk '{print $1}')
  AHEAD=$(echo "$AB" | awk '{print $2}')
fi

# Nothing to do — clean and in sync
if [ -z "$LOCAL_CHANGES" ] && [ "${BEHIND:-0}" -eq "0" ] && [ "${AHEAD:-0}" -eq "0" ]; then
  exit 1
fi

# Both sides have changes — check for potential conflicts
if [ -n "$LOCAL_CHANGES" ] && [ "${BEHIND:-0}" -gt "0" ]; then
  # Try a merge-tree to detect conflicts without modifying working tree
  MERGE_BASE=$(git merge-base HEAD "$TRACKING" 2>/dev/null)
  if [ -n "$MERGE_BASE" ]; then
    MERGE_OUT=$(git merge-tree "$MERGE_BASE" HEAD "$TRACKING" 2>/dev/null)
    if echo "$MERGE_OUT" | grep -q "<<<<<<"; then
      # Classify: code vs state
      if echo "$MERGE_OUT" | grep -E "\.(ts|tsx|js|jsx|py|rs|go|md)$" | grep -q "<<<<<<"; then
        echo "code" > "$SEVERITY_FILE"
      else
        echo "state" > "$SEVERITY_FILE"
      fi
    fi
  fi
fi

# Sync is needed
exit 0
