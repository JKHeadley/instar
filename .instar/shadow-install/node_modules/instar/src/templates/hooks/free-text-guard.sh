#!/bin/bash
# ── Free-Text Input Guard ─────────────────────────────────────────────
# PreToolUse hook on AskUserQuestion
#
# BLOCKS AskUserQuestion when the question is asking for free-text input
# like passwords, emails, tokens, or names. These should be collected via
# plain text output followed by waiting for the user's next message — NOT
# via AskUserQuestion, which adds confusing multi-choice escape hatches.
#
# ALLOWS AskUserQuestion for legitimate multi-choice decisions.
#
# Structure > Willpower: training pressure makes Claude prefer structured
# tools. Prompt instructions alone cannot reliably prevent this.
# ──────────────────────────────────────────────────────────────────────

INPUT=$(cat)

RESULT=$(echo "$INPUT" | python3 -c "
import sys, json, re

try:
    data = json.load(sys.stdin)
    tool_input = data.get('tool_input', {})
    questions = tool_input.get('questions', [])
except:
    print('allow')
    sys.exit(0)

if not questions:
    print('allow')
    sys.exit(0)

free_text_patterns = [
    r'\bpassword\b',
    r'\bmaster password\b',
    r'\bpassphrase\b',
    r'\bapi[- _]?key\b',
    r'\baccess[- _]?token\b',
    r'\bauth[- _]?token\b',
    r'\bcredential',
    r'\b2fa\b',
    r'\botp\b',
    r'\bverification code\b',
    r'\bauthenticator\b',
    r'\bone[- ]time',
    r'enter your ',
    r'type your ',
    r'provide your ',
    r'input your ',
    r'what(\x27s| is) your (email|password|name|token|key|code|address)',
    r'your (bitwarden|master|vault) ',
]

decision_patterns = [
    r'\bwhich\b',
    r'\bprefer\b',
    r'\bchoose\b',
    r'\bselect\b',
    r'\bpick\b',
    r'\bwant to\b',
    r'\bwould you\b',
    r'\bshould (we|i)\b',
    r'\bhow should\b',
    r'\bwhat (approach|method|option|strategy)\b',
]

for q in questions:
    text = q.get('question', '').lower()
    is_decision = any(re.search(p, text) for p in decision_patterns)
    is_free_text = any(re.search(p, text) for p in free_text_patterns)
    if is_free_text and not is_decision:
        print('block')
        sys.exit(0)

print('allow')
" 2>/dev/null)

if [ "$RESULT" = "block" ]; then
    cat >&2 <<'BLOCKED'
BLOCKED: AskUserQuestion cannot be used for free-text input.

You asked a question that expects the user to TYPE a response (password,
email, token, name, etc). AskUserQuestion adds multi-choice escape hatches
beneath the input, creating a confusing UX.

CORRECT APPROACH:
  1. Output the question as plain text
  2. STOP — do not call any tool
  3. Wait for the user's next message — their response IS the answer

AskUserQuestion is ONLY for multi-choice DECISIONS (pick A or B or C).
BLOCKED
    exit 2
fi

exit 0
