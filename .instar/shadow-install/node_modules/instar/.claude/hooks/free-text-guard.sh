#!/bin/bash
# ── Free-Text Input Guard ─────────────────────────────────────────────
# PreToolUse hook on AskUserQuestion
#
# BLOCKS AskUserQuestion when the question is asking for free-text input
# like passwords, emails, tokens, or names. These should be collected via
# plain text output ("Type your password below:") followed by waiting for
# the user's next message — NOT via AskUserQuestion, which adds confusing
# multi-choice escape hatches beneath the input field.
#
# ALLOWS AskUserQuestion for legitimate multi-choice decisions where the
# user is choosing between distinct options (e.g., "Bitwarden or Local?").
#
# Structure > Willpower: training pressure makes Claude prefer structured
# tools. Prompt instructions alone cannot reliably prevent this. This hook
# is the programmatic gate.
# ──────────────────────────────────────────────────────────────────────

INPUT=$(cat)

# Use Python for reliable JSON parsing and nuanced pattern detection
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

# Patterns that indicate the question expects the user to TYPE a response
# These match questions asking for credentials, personal info, or codes
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
    # Prompts asking user to enter/type/provide something
    r'enter your ',
    r'type your ',
    r'provide your ',
    r'input your ',
    r'what(\x27s| is) your (email|password|name|token|key|code|address)',
    r'your (bitwarden|master|vault) ',
]

# Patterns that indicate a legitimate multi-choice DECISION
# If these match, the question is probably fine for AskUserQuestion
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

    # Check for decision patterns first — these take priority
    is_decision = any(re.search(p, text) for p in decision_patterns)

    # Check for free-text patterns
    is_free_text = any(re.search(p, text) for p in free_text_patterns)

    # Block if it looks like free-text AND not clearly a decision
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
  1. Output the question as plain text (e.g., "What's your Bitwarden master password?")
  2. STOP — do not call any tool
  3. Wait for the user's next message — their response IS the answer

Example:
  You output: "What's your Bitwarden master password? Type it below."
  User types: their_password_here
  You use that value in your next command.

AskUserQuestion is ONLY for multi-choice DECISIONS (pick A or B or C).
BLOCKED
    exit 2
fi

# Legitimate decision — allow through
exit 0
