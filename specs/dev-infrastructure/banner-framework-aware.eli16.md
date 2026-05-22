# What this PR does — in plain English

## The bug

When you install instar and pick "Codex CLI" at the runtime prompt,
the wizard's welcome banner still says:

  Note: Instar runs Claude Code with --dangerously-skip-permissions.

Wrong runtime. Wrong sandbox flag. The banner was hardcoded and
ignored the framework choice. Justin caught this on his v1.2.15
install — picked Codex, saw a Claude warning, called it out.

## The fix

Replace the hardcoded line with two derived variables that read the
framework value the user picked:

  - runtimeLabel: "Codex CLI" or "Claude Code"
  - sandboxFlag: the sandbox-bypass flag each runtime actually uses

The banner now says either:

  Note: Instar runs Codex CLI with --dangerously-bypass-approvals-and-sandbox.

or:

  Note: Instar runs Claude Code with --dangerously-skip-permissions.

depending on what the user picked.

## Why this matters

Tiny but real. The banner is the user's first signal that the wizard
understood their runtime choice. When it shows the wrong runtime,
trust in the rest of the wizard drops before the conversation even
starts.

## What doesn't change

The rest of the banner (the "operates autonomously" explanation,
the "security through behavioral hooks" note, the README pointer)
is framework-neutral and stays unchanged.
