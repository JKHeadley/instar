#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Part of instar's "Security Through Identity" model.
#
# Supports two safety levels (configured in .instar/config.json → safety.level):
#
#   Level 1 (default): Block risky commands and tell the agent to ask the user.
#     → Safe starting point. Human stays in the loop. Trust builds over time.
#
#   Level 2 (autonomous): Inject a self-verification prompt instead of blocking.
#     → Agent reasons about whether the action is correct before proceeding.
#     → Enables fully hands-off operation while maintaining intelligent safety.
#     → Truly catastrophic commands (rm -rf /, fork bombs) are ALWAYS blocked.
#
# The progression from Level 1 → Level 2 is the path to full autonomy.
# The agent isn't blindly executing — it's running an intelligent self-check
# before every sensitive action. The hook makes this structural, not optional.
#
# Installed by instar during setup. Runs as a Claude Code PreToolUse hook on Bash.

INPUT="$1"
INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"

# --- Read safety level from config ---
SAFETY_LEVEL=1
if [ -f "$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# --- ALWAYS blocked (regardless of safety level) ---
# These are catastrophic, irreversible operations that no self-check can undo.
ALWAYS_BLOCK_PATTERNS=(
  "rm -rf /"
  "rm -rf ~"
  "> /dev/sda"
  "mkfs\."
  "dd if="
  ":(){:|:&};:"
  # Database schema destruction — these flags/commands exist specifically to bypass
  # safety checks. Treat them as catastrophic regardless of context.
  # (Learned from Portal production data loss incident 2026-02-22)
  "--accept-data-loss"
  "prisma migrate reset"
)

for pattern in "${ALWAYS_BLOCK_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Catastrophic command detected: $pattern" >&2
    echo "This command is always blocked regardless of safety level." >&2
    echo "If you genuinely need to run this, the user must execute it directly." >&2
    exit 2
  fi
done

# --- Risky commands: behavior depends on safety level ---
RISKY_PATTERNS=(
  "rm -rf \."
  "git push --force"
  "git push -f"
  "git reset --hard"
  "git clean -fd"
  "DROP TABLE"
  "DROP DATABASE"
  "TRUNCATE"
  "DELETE FROM"
  # Schema push against production — "non-destructive" additions can silently
  # drop tables when schema/DB naming conventions are inconsistent.
  # Use SQL ALTER TABLE for targeted production changes instead.
  "prisma db push"
  "prisma migrate deploy"
)

# --- Safe-case carve-out: `git push --force-with-lease` to a NON-protected branch ---
# `--force-with-lease` is the SAFE force-push: it refuses to overwrite work the
# local clone hasn't seen. To one's OWN feature/PR branch (not shared history)
# this is the legitimate way to update an amended/rebased branch — and a recurring
# friction when the guard blocks it (a dev session resolving its own PR). We allow
# ONLY this narrow case. We still block:
#   - plain `--force` / `-f` (no lease) — always risky,
#   - any force-push that explicitly targets a protected branch (main/master/
#     develop/release*).
# Residual edge (force-with-lease while checked out ON main, no branch named) is
# double-protected: agents work in worktrees on feature branches (never main), and
# main carries remote branch protection that rejects a force-push regardless.
FORCE_WITH_LEASE_OWN_BRANCH=0
if echo "$INPUT" | grep -qiE 'git +push[^|;&]*--force-with-lease'; then
  # Scan ONLY the `git push …` invocation for a protected branch — NOT the whole
  # $INPUT. The previous whole-$INPUT scan false-positived on any unrelated text in the
  # command (e.g. a heredoc status message mentioning "release cadence" or "main"),
  # blocking a legitimate PR-branch force-with-lease update — the recurring friction
  # the carve-out exists to remove (2026-06-07, topic 19437). Isolating to the push
  # invocation keeps the main/master/release block precise.
  PUSH_INVOCATION=$(echo "$INPUT" | grep -oiE 'git +push[^|;&]*' | head -1)
  if echo "$PUSH_INVOCATION" | grep -qiE '(^|[[:space:]:/])(main|master|develop|release[A-Za-z0-9._/-]*)([[:space:]]|:|$)'; then
    FORCE_WITH_LEASE_OWN_BRANCH=0   # explicit protected target in the push command — keep blocking
  else
    FORCE_WITH_LEASE_OWN_BRANCH=1   # safe: force-with-lease to a non-protected branch
  fi
fi

for pattern in "${RISKY_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    # Allow the safe force-with-lease-to-own-branch case past the force-push patterns.
    if [ "$FORCE_WITH_LEASE_OWN_BRANCH" -eq 1 ] && echo "$pattern" | grep -qiE 'git push (--force|-f)'; then
      continue
    fi
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      # Level 1: Block and require authorization — agent executes after user confirms
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Authorization required: Ask the user whether to proceed with this operation." >&2
      echo "Once they confirm, YOU execute the command — never ask the user to run it themselves." >&2
      exit 2
    else
      # Level 2: Inject self-verification prompt (don't block)
      # The agent must reason about whether this action is correct.
      AGENT_IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        AGENT_IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md")
      fi

      VERIFICATION=$(cat <<VERIFY
{
  "decision": "approve",
  "additionalContext": "=== SELF-VERIFICATION REQUIRED ===\nA potentially destructive command was detected: $pattern\n\nBefore proceeding, verify:\n1. Is this command necessary for the current task?\n2. Have you considered the consequences if this goes wrong?\n3. Is there a safer alternative that achieves the same result?\n4. Does this align with your principles and the user's intent?\n\nYour identity:\n$AGENT_IDENTITY\n\nIf ALL checks pass, proceed. If ANY check fails, stop and reconsider.\n=== END SELF-VERIFICATION ==="
}
VERIFY
)
      echo "$VERIFICATION"
      exit 0
    fi
  fi
done
