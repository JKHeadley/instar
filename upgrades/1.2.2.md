# Upgrade Guide — v1.2.1 (bareword runtime prompt)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Bareword `npx instar` asks which runtime.**

A fresh user typing `npx instar` (no subcommand) is now asked which AI
runtime they want — Claude Code or Codex CLI — before the wizard
launches. Previously the bareword silently defaulted to Claude Code and
exited if Claude wasn't installed, leaving Codex-only users with no
discoverable path from the headline command.

The prompt fires only when stdin is a TTY (interactive terminal), so
piped invocations and CI runs are unaffected — they keep defaulting to
Claude Code as before.

When exactly one runtime is installed, the prompt skips itself and uses
the installed one. When both are installed (or neither is), the prompt
asks; the existing `checkFrameworkPrerequisite` then surfaces a clear
install URL if the user picked one that isn't on the machine.

The explicit subcommand forms continue to work exactly as in v1.1.0:
`instar init --framework codex-cli --standalone` and
`instar setup --framework codex-cli` both bypass the prompt and use the
flag value directly.

Spec: `specs/dev-infrastructure/bareword-framework-prompt.md`. ELI16:
`specs/dev-infrastructure/bareword-framework-prompt.eli16.md`.
Side-effects review:
`upgrades/side-effects/feat-bareword-framework-prompt.md`.

## What to Tell Your User

Typing the plain instar command now asks which AI runtime you want —
Claude Code or Codex CLI. Pick whichever you have installed. The
explicit subcommand forms continue to work exactly as before, so any
scripts you have written keep working without changes.

## Summary of New Capabilities

Closes the final UX gap in the install/wizard portability arc shipped
in v1.1.0-v1.1.4. The headline command now reaches Codex-only users
the same way it reaches Claude-only users.

## Evidence

Reproduction prior: on a Codex-only host, running `npx instar` exits
with the "Claude Code is required" message because the bareword defaults
to Claude Code without asking. After: on a TTY, the bareword presents a
"Which AI runtime should this agent use?" prompt with the two options
and an installed/not-installed indicator. Answering "2" routes through
the Codex setup path; answering "1" or pressing enter routes through
the Claude path. In a piped or CI environment, the prompt is skipped
entirely and the default remains Claude Code.

Unit verification: `tests/unit/bareword-framework-prompt.test.ts` pins
the four cases of the pure decision function — both installed prompts,
only-Claude returns Claude, only-Codex returns Codex, neither installed
prompts so the user gets to pick which one to install.
