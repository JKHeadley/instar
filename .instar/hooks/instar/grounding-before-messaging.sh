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
# Installed by instar during setup. Runs as a PreToolUse hook (Claude: Bash arg;
# Codex: stdin JSON — tool_input.command for Claude, tool_input.cmd for Codex's
# exec_command tool; accept either).

INPUT="$1"
if [ -z "$INPUT" ]; then
  INPUT="$(cat 2>/dev/null | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); ti=d.get('tool_input',{}) or {}
    print(ti.get('command') or ti.get('cmd') or '')
except Exception:
    print('')" 2>/dev/null)"
fi

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
      # BLOCK output goes to STDERR: on a PreToolUse exit-2 block, Claude Code
      # surfaces ONLY stderr to the agent. Writing the reason to stdout rendered
      # every block as an unreadable "hook error ... No stderr output" — the agent
      # saw a malfunction instead of the actual quality findings (2026-06-05).
      echo "$CHECK_RESULT" >&2
      echo "" >&2
      echo "=== MESSAGE BLOCKED — Review and revise before sending. ===" >&2
      exit 2
    fi
  fi

  echo "=== GROUNDED — Proceed with message. ==="
fi
