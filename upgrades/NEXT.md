---
review-convergence: complete
approved: true
approved-by: Justin (topic 13435, 2026-05-31 08:46Z — "go with your recommendations")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — Codex agents now run autonomous mode on their own (Claude parity)

When you put an agent in autonomous mode, it should keep working across many turns until the job
is done. Claude agents already did this (via the stop hook). Codex agents did NOT — they would
quietly stop after one turn. Codex actually has its own way to sustain a multi-turn run (its
built-in /goal loop), and instar already handed the goal off to it automatically — but only
behind a check for "Claude command-line version 2.1.139+", which is empty for a Codex agent. So
Codex agents fell through that Claude-shaped gate and never got the hand-off.

This adds a small framework-aware fallback: if the Claude check doesn't apply, instar detects a
Codex agent (from its own config) and hands the goal to Codex's native /goal loop. Now a Codex
agent in autonomous mode sustains multi-turn work automatically, the same as a Claude agent. The
Claude path is unchanged, and the sensitive stop hook is untouched.

## Summary of New Capabilities

- `setup-autonomous.sh` now enables native /goal delegation for Codex agents (detected via config
  `enabledFrameworks` containing `codex-cli`), not just Claude Code >= 2.1.139. Codex autonomous
  mode auto-delegates to native /goal; the stop-hook's existing `goal_mode:native` branch defers.
- `PostUpdateMigrator` marker bump (`native-goal/set` → `IS_CODEX_AGENT`) re-deploys the fixed
  setup script to existing agents.

## What to Tell Your User

If you run a Codex-based agent, it can now run in autonomous mode and keep itself going across
many turns until the goal is met — the same way a Claude agent does. Before, a Codex agent in
autonomous mode would quietly stop after a single turn. Nothing to configure; it applies on the
next update, and Claude agents are unaffected.

## Evidence

- Root cause traced by reading setup-autonomous.sh: the native /goal hand-off existed but was
  gated on `claude --version >= 2.1.139` (empty for a codex agent → codex fell to the dark
  Phase-1 no-op). Proven live in round 2 that codex /goal sustains 1→2→3 across turns.
- Unit: `tests/unit/autonomous-codex-native-goal-detection.test.ts` — both sides of the
  decision boundary (codex enables, Claude/absent skips, multi-framework enables, missing config
  best-effort skips).
- Unit: `tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts` — a prior native-/goal setup
  is re-deployed by the marker bump; all existing cases stay green (8 tests).
- `tsc --noEmit` + `npm run lint` clean.
- Spec: `docs/specs/codex-autonomy-native-goal-autowire.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/codex-autonomy-native-goal-autowire.md`.
- Final proof is the live drive: Codey running the real /autonomous skill and sustaining multi-turn.
