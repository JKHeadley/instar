---
review-convergence: complete
approved: true
approved-by: justin (topic 13435, 2026-05-30 — "Yes, go ahead as long as we do it carefully and we have a clear plan to regress")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — codex agents can now sustain a multi-turn autonomous run (ships DARK)

A `codex exec` session runs one turn then exits — there was no "keep going" Stop hook
like Claude has, so a codex agent (Codey) couldn't carry a long autonomous task. This is
the headline Claude/Codex parity gap.

The mechanism already existed end-to-end (codex fires Stop hooks and honors
`{decision:"block", reason}` — verified in the codex 0.133 binary); the only missing piece
was the wiring. `installCodexHooks` now registers the shared `autonomous-stop-hook.sh`
(with a `--codex` arg) as a SEPARATE codex Stop group — mirroring how Claude registers its
loop hook — and the hook self-gates on `autonomousSessions.codexLoopDriver.enabled`.

Ships **DARK**: the flag defaults false, so the standing codex hook exits immediately (no
behavior change for any codex session) until it is explicitly enabled. Claude's autonomous
mode is byte-for-byte unchanged (its loop hook is registered separately, with no `--codex`
arg).

## What to Tell Your User

Nothing changes yet — this ships turned off. It is the foundation that will let a codex
agent keep working through a long task on its own (the way a Claude agent already can),
once it is enabled and verified live. Rollback is instant: turn the flag back off.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex autonomous-loop driver | Set `autonomousSessions.codexLoopDriver.enabled: true` in `.instar/config.json` (default false / dark). Off → instant rollback, no redeploy. |
| Standing codex Stop group | `installCodexHooks` registers `autonomous-stop-hook.sh --codex` as its own Stop group; re-armed automatically on update. |

## Evidence

- Repro: a `codex exec` autonomous job stops after one turn — no `.codex/hooks.json` loop
  hook (only the Claude path was wired). Prerequisites verified on disk: codex fires Stop
  hooks (`config.toml [hooks.state]`); honors block+reason (0.133 binary `StopCommandOutputWire`).
- Before/after: before — codex Stop chain has only the review trio; after — a second Stop
  group carries the loop driver, self-gated dark.
- Unit: `tests/unit/installCodexHooks.test.ts` — separate instar Stop group, idempotent
  re-install (never stacks), user Stop group preserved.
- Unit: `tests/unit/autonomous-stop-hook-codex-gate.test.ts` — `--codex` + flag absent/false
  → approve (dark) even with an active job; flag true → block; no `--codex` (Claude) → blocks
  regardless of the flag (Claude path unaffected). Both sides of the gate.
- `tsc --noEmit` clean; `npm run lint` clean.
- Spec: `docs/specs/codex-autonomous-loop-driver.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/codex-autonomous-loop-driver.md`.
