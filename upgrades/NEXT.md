# Upgrade Guide — v1.2.12 (setup wizard always uses Claude)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: the setup wizard now always runs on Claude, regardless of
which framework the user picked at the runtime prompt.**

The first real end-to-end test of the Codex install path (v1.2.11)
confirmed the model-pin fix from PR #299 worked — Codex spawned with
`model: gpt-5.3-codex` and the wizard skill loaded correctly. But
the wizard skill's behavioral contract was ignored. The skill says,
in capitals at the top, "speak conversationally", "never show CLI
commands", "display this text and wait for user input". Codex's
training pulls toward execution: it parsed the wizard's JSON
context, picked the restore-flow entry point, then ran the entire
setup non-interactively — `npx instar init`, `user add`, `server
start`, `autostart install`, all without asking the user a single
identity question. The user ended up with a generic
"Instar-codey" agent identity they never got to shape.

Adding more PAUSE-HERE markers to the skill won't reliably fix this;
the execution-pull is a training-level behavior. So the wizard
binary is now always Claude, regardless of host framework choice.

The agent's runtime is unchanged: a Codex agent stays a Codex agent
(`enabledFrameworks: ['codex-cli']`). The framework choice still
gates the scaffold (.codex vs .claude, AGENTS.md vs CLAUDE.md, etc).
Only the interactive wizard binary itself is forced to Claude — the
one tool whose entire job is conversational onboarding.

Same fix applies to the Phase 2.5 secret-setup micro-session, which
had the same framework-conditional spawn.

A new refusal at the wizard binary check catches hosts without
Claude installed and explains that Claude is the conversational
onboarding tool — the agent itself can still run on Codex.

The previous canary test from PR #299 (asserting every codex spawn
in setup.ts carries `-m WIZARD_CODEX_MODEL`) is inverted: the
v1.2.12 canary asserts no codex spawns remain in setup.ts at all.

Spec: `specs/dev-infrastructure/wizard-via-claude.md`.
ELI16: `specs/dev-infrastructure/wizard-via-claude.eli16.md`.
Side-effects review: `upgrades/side-effects/fix-wizard-via-claude.md`.

## What to Tell Your User

Installing instar and picking Codex CLI as your agent's runtime now
walks you through identity, autonomy, and messaging setup
conversationally — the same way the Claude install path always has.
Your agent still runs on Codex once setup is done. Only the
onboarding wizard itself uses Claude.

## Summary of New Capabilities

No new capabilities. Behavior fix on top of v1.2.11.

## Evidence

Reproduction prior to fix: ran v1.2.11 install via `npx instar`
bareword → picked Codex at runtime prompt. Codex received the
wizard skill prompt, parsed the JSON, then executed the entire
setup non-interactively. Full log captured at
`/Users/justin/Documents/Projects/instar-codey/setup-logs.md` —
2940 lines, zero conversational walkthrough, one multi-choice
question at the very end (messaging setup).

After fix: the canary unit test passes. End-to-end re-test on the
Codex install path pending on publish.
