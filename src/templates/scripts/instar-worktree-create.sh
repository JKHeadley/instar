#!/usr/bin/env bash
# instar-worktree-create — wrapper that delegates to `instar worktree create`
# when available, with an inline fallback for hosts that don't have the CLI
# on PATH yet.
#
# Background: Claude Code's sandbox scopes filesystem access to the agent's
# primary working directory. Worktrees outside that directory are subject
# to mid-session EPERM revocation. The `instar worktree create` subcommand
# (Layer 1 of the agent worktree convention, src/core/InstarWorktreeManager.ts)
# places the worktree in the sandbox-safe area and refuses any other
# destination. This wrapper guarantees agents always reach that path
# regardless of how `instar` is installed on the host.
#
# Spec: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md §Sequencing.
#
# Usage:
#   instar-worktree-create.sh <branch>
#   instar-worktree-create.sh <branch> <slug>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Layer 1's resolveAgentHome() prefers INSTAR_AGENT_HOME; this wrapper sets
# it from the script's own location so resolution is deterministic regardless
# of CWD or how the user invoked us.
export INSTAR_AGENT_HOME="$(dirname "$SCRIPT_DIR")"

# Honor explicit override first.
if [[ -n "${INSTAR_BIN:-}" && -x "$INSTAR_BIN" ]]; then
  exec "$INSTAR_BIN" worktree create "$@"
fi

# Resolve to an absolute path — shell aliases (like `instar` → `npx instar`)
# are not honored by `exec`, so we must verify a real binary path.
INSTAR_RESOLVED="$(command -v instar 2>/dev/null || true)"
if [[ -n "$INSTAR_RESOLVED" && "$INSTAR_RESOLVED" == /* ]]; then
  exec "$INSTAR_RESOLVED" worktree create "$@"
fi

# Fall back to npx when instar is not on PATH as a binary. Most installs
# reach the CLI via `npx instar` rather than a globally-linked binary.
if command -v npx >/dev/null 2>&1; then
  exec npx --no-install instar worktree create "$@"
fi

# Last-resort inline fallback: hosts with neither `instar` on PATH nor `npx`.
# Mirrors the original hand-rolled helper that predates the CLI subcommand.
# This path is intentionally minimal — anyone who hits it should install
# `npx` or get instar on PATH so they pick up future Layer 1 hardening.
BRANCH="${1:-}"
SLUG="${2:-}"
if [[ -z "$BRANCH" ]]; then
  echo "usage: instar-worktree-create.sh <branch> [<slug>]" >&2
  exit 1
fi
if [[ -z "$SLUG" ]]; then SLUG="${BRANCH//\//-}"; fi
WORKTREES_ROOT="$INSTAR_AGENT_HOME/.worktrees"
WORKTREE_PATH="$WORKTREES_ROOT/$SLUG"
INSTAR_REPO="${INSTAR_REPO:-$HOME/Documents/Projects/instar}"
if [[ ! -d "$INSTAR_REPO" ]]; then
  echo "error: instar repo not found at $INSTAR_REPO" >&2
  exit 1
fi
if [[ -e "$WORKTREE_PATH" ]]; then
  echo "error: $WORKTREE_PATH already exists" >&2
  exit 1
fi
mkdir -p "$WORKTREES_ROOT"
chmod 0700 "$WORKTREES_ROOT"
# OS resource hygiene: keep macOS Spotlight/mediaanalysisd from re-indexing every
# worktree under here (a top OS-level CPU consumer). Honored recursively; no-op
# elsewhere. The CLI path does the same via ensureWorktreeSpotlightExclusion.
[[ -f "$WORKTREES_ROOT/.metadata_never_index" ]] || : > "$WORKTREES_ROOT/.metadata_never_index" 2>/dev/null || true
cd "$INSTAR_REPO"
if git rev-parse --verify --quiet "$BRANCH" >/dev/null; then
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  git worktree add -b "$BRANCH" "$WORKTREE_PATH" main
fi
if [[ -d "$INSTAR_REPO/node_modules" && ! -e "$WORKTREE_PATH/node_modules" ]]; then
  ln -s "$INSTAR_REPO/node_modules" "$WORKTREE_PATH/node_modules"
fi
echo "worktree ready at: $WORKTREE_PATH"
