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

for pattern in "${RISKY_PATTERNS[@]}"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
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
