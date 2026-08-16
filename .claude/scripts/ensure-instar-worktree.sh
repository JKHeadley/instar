#!/bin/bash
# Ensures a per-topic instar worktree exists and prints its path.
# Called by the session-start hook so every Echo session gets an
# isolated instar checkout to develop in — preventing concurrent
# sessions from stepping on each other's uncommitted work in the
# shared /Users/justin/Documents/Projects/instar checkout.

set -e
TOPIC_ID="${1:-$INSTAR_TELEGRAM_TOPIC}"
if [ -z "$TOPIC_ID" ]; then
  exit 0
fi

INSTAR_REPO="/Users/justin/Documents/Projects/instar"
WT_ROOT="$INSTAR_REPO/.instar/worktrees"
WT_PATH="$WT_ROOT/topic-${TOPIC_ID}-echo"
BRANCH="echo/topic-${TOPIC_ID}"

if [ ! -d "$INSTAR_REPO/.git" ]; then
  exit 0
fi

mkdir -p "$WT_ROOT"

if [ -d "$WT_PATH" ]; then
  # Already exists — just echo the path
  echo "$WT_PATH"
  exit 0
fi

cd "$INSTAR_REPO"

# Try: create worktree on a new per-topic branch off main.
# Fall back: attach to existing branch if it already exists.
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git worktree add "$WT_PATH" "$BRANCH" >/dev/null 2>&1 || true
else
  git worktree add -b "$BRANCH" "$WT_PATH" main >/dev/null 2>&1 || true
fi

if [ -d "$WT_PATH" ]; then
  echo "$WT_PATH"
fi
