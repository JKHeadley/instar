#!/bin/bash
# Grounding before messaging — ensures the agent is grounded and message is
# quality-checked before sending any external communication.
#
# Three-phase defense:
# 1. Identity injection — re-ground the agent in who they are
# 2. Convergence check — heuristic quality gate on the message content
# 3. URL provenance — verify URLs aren't fabricated
#
# Structure > Willpower: these checks run automatically before
# external messaging, not when the agent remembers to do them.
#
# The 164th Lesson (Dawn): Advisory hooks are insufficient.
# Grounding must be automatic — content injected, not pointed to.
#
# Installed by instar during setup. Runs as a Claude Code PreToolUse hook on Bash.

INPUT="$1"

# Detect messaging commands (telegram-reply, email sends, API message posts, etc.)
if echo "$INPUT" | grep -qE "(telegram-reply|send-email|send-message|POST.*/telegram/reply|POST.*/message|/reply)"; then
  INSTAR_DIR="${CLAUDE_PROJECT_DIR:-.}/.instar"
  SCRIPTS_DIR="$INSTAR_DIR/scripts"

  # Phase 1: Identity injection (Structure > Willpower — output content, not pointers)
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "=== PRE-MESSAGE GROUNDING ==="
    echo ""
    echo "--- YOUR IDENTITY ---"
    cat "$INSTAR_DIR/AGENT.md"
    echo ""
    echo "--- END IDENTITY ---"
    echo ""
  fi

  # Phase 2: Convergence check (heuristic quality gate)
  if [ -f "$SCRIPTS_DIR/convergence-check.sh" ]; then
    # Pipe the full tool input through the convergence check.
    # The check looks for common agent failure modes (capability claims,
    # sycophancy, settling, experiential fabrication, commitment overreach,
    # URL provenance).
    CHECK_RESULT=$(echo "$INPUT" | bash "$SCRIPTS_DIR/convergence-check.sh" 2>&1)
    CHECK_EXIT=$?

    if [ "$CHECK_EXIT" -ne "0" ]; then
      echo "$CHECK_RESULT"
      echo ""
      echo "=== MESSAGE BLOCKED — Review and revise before sending. ==="
      exit 2
    fi
  fi

  echo "=== GROUNDED — Proceed with message. ==="
fi
