# Convergence Report — Telegram-native wizard + add-user cwd + choice echo

## ELI10 Overview

Justin's second real test of the hybrid wizard surfaced three bugs.
The user-profile-creation call passed a flag the CLI doesn't accept
("error: unknown option '-d'"). The multi-choice prompts silently
accepted text answers without showing what got picked. And the
Telegram setup spawned a Codex session that couldn't actually wait
for the user to paste a bot token — so it printed instructions, ended,
and the wizard recorded "Telegram is configured!" without anything
being configured.

This PR fixes all three. The user-add fix swaps `-d` for cwd. The
choice prompts now echo `→ Proactive` after the wizard interprets
the answer. And the Telegram setup is rewritten as an instar-native
readline flow that calls the Telegram Bot API directly to validate
tokens and discover chat IDs — no LLM session in the loop at all.

## Original vs Converged

The fix went straight to the right shape. One alternative was
considered and rejected for the Telegram path:

- **Keep Codex in the Telegram setup but make it interactive (codex
  REPL mode instead of `codex exec`)**: rejected because that takes
  over the terminal in a way the state machine can't coordinate
  with — the user would then be talking to Codex directly, not to
  the wizard, with no clean handoff back. The instar-native flow
  using readline + the Telegram Bot API is more reliable and gives
  the same end-user experience (clear instructions, automated
  validation, automated chat-ID discovery).

The "intelligence" angle Justin emphasized in the earlier PR
guidance is preserved: per-step Codex narrative still introduces
each conversational step warmly. Only the EXECUTION halves (running
CLI commands, calling the Telegram API) are instar-native — which
is the right shape for executions that need predictable success/
failure semantics.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's real-user log | 3 | Telegram rewrite, cwd fix, echo helper |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — `instar user add -d` rejected by CLI.**

- Severity: medium (silent failure of user-profile creation step).
- Resolution: drop `-d` from argv; set spawn `cwd:
  options.projectDir`. Same fix applied to start-server and
  install-autostart for consistency.

**Finding 2 — Choice prompts accepted text input silently.**

- Severity: medium (user couldn't tell whether their text input was
  understood).
- Resolution: new `echoChoice(state, answer)` helper called from
  the renderNarrativeState retry loop. Prints `→ {label}` after the
  validator accepts.

**Finding 3 — Telegram setup spawned non-interactive Codex
session.**

- Severity: high (most-requested messaging channel silently failed).
- Resolution: full rewrite of runTelegramSetup as instar-native
  readline + Telegram Bot API. Three new private helpers
  (telegramGetMe, telegramGetUpdates, writeTelegramConfig). Never
  returns `telegramConfigured: true` unless the config write
  succeeded.

## Convergence verdict

Converged at iteration 2. Three scoped fixes; no new abstraction
layers; existing primitives only. The Telegram rewrite is the bulk
of the change but lives entirely in one function + three helpers
inside the same module. Spec is ready.
