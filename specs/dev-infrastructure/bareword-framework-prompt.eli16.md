---
title: "Bareword framework prompt — ELI16"
slug: "bareword-framework-prompt-eli16"
parent: "bareword-framework-prompt.md"
---

# Bareword framework prompt — explained simply

## The gap

Earlier today we shipped the install/wizard portability arc — the
explicit subcommand `instar setup --framework codex-cli` works
end-to-end. But the headline command, the one most users type, is plain
`npx instar` with no subcommand. That bareword silently defaulted to
Claude Code and exited if Claude wasn't installed — leaving a fresh
Codex-only user with no obvious path forward.

The reason it was awkward to fix at the CLI-flag level: the same flag
on the parent command would silently intercept subcommand values
(that's what this morning's hotfix #276 was about). So the right answer
is a runtime prompt, not another CLI flag.

## The fix

When someone types `npx instar` on an interactive terminal, the wizard
now asks "Which AI runtime should this agent use?" with two options.
Answering 1 (or pressing enter) picks Claude Code; answering 2 picks
Codex CLI. Both options show whether the runtime is installed on the
machine.

If only one runtime is installed, the prompt skips itself and uses that
one — no point asking when there's only one valid answer. If neither
is installed, the prompt still asks so the next-step install message
matches whichever runtime the user actually wants.

## What doesn't change

- Piped invocations and CI runs (no interactive terminal) keep
  defaulting to Claude Code, unchanged.
- The explicit subcommands `instar init --framework codex-cli` and
  `instar setup --framework codex-cli` keep working exactly as they did
  in v1.1.0 — same flag, same behavior. Any scripts you've written
  don't need updating.

## Verification

Four pinning tests cover the decision function across all four
detection combinations (both installed / Claude only / Codex only /
neither installed). The readline interaction itself runs end-to-end
when Justin runs `npx instar` on this machine after merge.
