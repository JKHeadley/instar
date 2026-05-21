# Upgrade Guide — v1.2.12 (hybrid wizard for Codex runtime)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**New: hybrid setup wizard for Codex-runtime installs.**

`npx instar` → pick Codex CLI at the runtime prompt → now reaches
an actual conversational walkthrough. Before this release, Codex
ignored the wizard skill's behavioral contract and executed the
entire setup non-interactively, leaving the user with a generic
agent identity they never got to shape.

The fix is a two-layer architecture under
`src/commands/setup-wizard/`:

1. **State machine** owns the conversation flow. Each state has a
   structural prompt printed verbatim by instar, a deterministic
   transition function, and (for action states) a side effect call
   to existing CLI commands. Order is fixed in TypeScript code; no
   LLM can drift it.

2. **Codex driver** drives the state machine turn-by-turn. For each
   conversational state, the driver runs `codex exec -s read-only
   -m gpt-5.3-codex --ephemeral` with a tightly-constrained prompt
   asking Codex to generate ONE warm 2-3 sentence intro paragraph.
   The structural prompt is printed by instar; readline reads the
   answer. Codex cannot use tools, cannot reword the question,
   cannot decide to execute the setup itself.

3. **Telegram setup phase** hands off to Codex as a full agentic
   session (sandbox bypass + Playwright access) — driving the
   browser is execution, which is Codex's strength.

Claude-runtime users see no change. The Claude path keeps the
existing `/setup-wizard` slash-command spawn.

Settings the user picks during the wizard (agent name, focus,
autonomy level, messaging channel) can all be changed later just
by chatting the agent. The farewell text and the autonomy step's
narrative both surface this affordance.

Spec: `specs/dev-infrastructure/hybrid-wizard.md`.
ELI16: `specs/dev-infrastructure/hybrid-wizard.eli16.md`.
Side-effects review: `upgrades/side-effects/feat-hybrid-wizard.md`.

## What to Tell Your User

The setup wizard now walks you through identity, autonomy, and
messaging conversationally, regardless of which runtime you picked.
On Codex, the wizard runs as a state machine in instar itself with
Codex generating the warm narrative for each step; on Claude it
runs the same way it always has. Anything you set up can be
changed later just by chatting your agent — no need to re-run setup.

## Summary of New Capabilities

- New module: `src/commands/setup-wizard/` (state machine + Codex
  driver + model constants).
- New CLI behavior: `npx instar` → pick Codex CLI → conversational
  wizard with per-step narrative from Codex.
- Existing CLI surface unchanged.

## Evidence

Reproduction prior to fix: ran v1.2.11 install via bareword `npx
instar` → picked Codex. Codex received the wizard skill prompt and
executed the entire setup non-interactively. Full log captured at
`setup-logs.md` in the test project — 2940 lines, zero
conversational walkthrough.

After fix:
- 12 new state-machine unit tests cover the choice resolver, graph
  integrity, identity-answer threading, messaging branching, and
  the post-server completion chain.
- 5 updated canary tests cover the dispatch contract: setup.ts
  imports `runCodexWizard` for codex-cli, no codex exec argv with
  the wizard skill prompt remains in setup.ts, the driver's codex
  exec spawns still pin `-m WIZARD_CODEX_MODEL`.
- End-to-end re-test on the Codex install path pending on publish.
