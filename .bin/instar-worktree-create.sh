#!/usr/bin/env bash
# instar-worktree-create — create a git worktree against the instar shared repo
# in the sandbox-safe location under the agent's home directory.
#
# Background: Claude Code's sandbox scopes filesystem access to the agent's
# primary working directory. Worktrees outside that directory are subject to
# mid-session EPERM revocation when sandbox state shifts. See
# ~/.claude/projects/-Users-justin--instar-agents-echo/memory/feedback_worktree_in_agent_home.md
# for the full reasoning.
#
# Usage:
#   instar-worktree-create.sh <branch>
#   instar-worktree-create.sh <branch> <slug>
#
# Examples:
#   instar-worktree-create.sh spec/provider-portability
#   instar-worktree-create.sh spec/provider-portability portability-cycle-2
#
# Creates: ~/.instar/agents/echo/.worktrees/<slug>/
# Where <slug> defaults to the branch name with `/` replaced by `-`.
#
# After creating, symlinks node_modules from the main instar checkout so
# tests can run immediately.

set -euo pipefail

BRANCH="${1:-}"
SLUG="${2:-}"

if [[ -z "$BRANCH" ]]; then
  echo "usage: instar-worktree-create.sh <branch> [<slug>]" >&2
  exit 1
fi

if [[ -z "$SLUG" ]]; then
  SLUG="${BRANCH//\//-}"
fi

# Resolve the agent home from the script's own location so this works no
# matter which agent runs it. The script lives at <agent_home>/.bin/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_HOME="$(dirname "$SCRIPT_DIR")"
WORKTREES_ROOT="$AGENT_HOME/.worktrees"
WORKTREE_PATH="$WORKTREES_ROOT/$SLUG"

# The instar shared repo location — adjust if the convention changes.
INSTAR_REPO="${INSTAR_REPO:-$HOME/Documents/Projects/instar}"

if [[ ! -d "$INSTAR_REPO" ]]; then
  echo "error: instar repo not found at $INSTAR_REPO" >&2
  echo "set INSTAR_REPO env var if it lives elsewhere." >&2
  exit 1
fi

if [[ -e "$WORKTREE_PATH" ]]; then
  echo "error: $WORKTREE_PATH already exists" >&2
  echo "either remove it first or pick a different <slug>." >&2
  exit 1
fi

mkdir -p "$WORKTREES_ROOT"

echo "creating worktree:"
echo "  branch: $BRANCH"
echo "  path:   $WORKTREE_PATH"
echo "  repo:   $INSTAR_REPO"
echo ""

cd "$INSTAR_REPO"

# If the branch already exists, just add a worktree pointing at it.
# Otherwise, create the branch from main as a starting point.
if git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  echo "branch $BRANCH does not exist yet — creating from main"
  git worktree add -b "$BRANCH" "$WORKTREE_PATH" main
fi

# Symlink node_modules from the main checkout so tests run immediately
# without a full `npm install` per worktree.
if [[ -d "$INSTAR_REPO/node_modules" && ! -e "$WORKTREE_PATH/node_modules" ]]; then
  ln -s "$INSTAR_REPO/node_modules" "$WORKTREE_PATH/node_modules"
  echo "symlinked node_modules from main checkout"
fi

echo ""
echo "worktree ready at: $WORKTREE_PATH"
echo ""
echo "cd $WORKTREE_PATH"
