---
title: Codex autonomous-loop driver (multi-turn task sustainment)
status: approved
author: echo
date: 2026-05-30
review-convergence: "self-converged"
review-iterations: 1
approved: true
approved-by: justin
approved-note: "Justin explicitly approved on 2026-05-30 (topic 13435): 'Yes, go ahead as long as we do it carefully and we have a clear plan to regress.' Conditions met: (1) Claude path byte-for-byte unchanged (framework-additive, IS_CODEX gate); (2) ships DARK behind autonomousSessions.codexLoopDriver.enabled (default false) — instant rollback by flipping the flag, no redeploy; (3) deploy-dark → live-verify on a real codex autonomous run → only then enable. Second-pass review required (lifecycle machinery) — see Phase 5 section."
second-pass-required: true
---

# Codex autonomous-loop driver

## Problem

A `codex exec` session runs **one turn and exits**. Nothing checks, at end-of-turn,
"are the autonomous tasks still incomplete?" and re-prompts the session to keep going.
So a codex agent **cannot sustain a multi-turn autonomous run** — the headline reason
"Codey can't carry a long task." This is the deepest Claude/Codex parity gap (full
parity is a stated tenet).

For Claude this is solved by the `/autonomous` skill's Stop hook
(`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`): while tasks remain it
returns `{decision:"block", reason:<task feedback>}`, and Claude honors that by
continuing with `reason` as the next prompt.

## Prerequisites (all verified on disk, 2026-05-30)

1. Codex fires Stop hooks — `~/.codex/config.toml [hooks.state]` records real
   `…/.codex/hooks.json:stop:N:M` executions.
2. Codex honors `{decision:"block", reason}` on Stop as a grounding-pause/continue (NOT
   a hard termination) — **verified in the codex 0.133 binary's `StopCommandOutputWire`**
   (documented at `installCodexHooks.ts`).
3. instar already registers + arms codex Stop hooks at `<projectDir>/.codex/hooks.json`
   (`installCodexHooks` + `armCodexHooks`, re-run on update via `PostUpdateMigrator`).
4. The autonomous-stop-hook's core logic is framework-neutral (reads
   `.instar/autonomous/<topic>.local.md`, resolves tmux generically, evaluates
   completion via HTTP, emits the Claude-compatible decision JSON).

## The gap (single sentence)

The `/autonomous` skill registers the loop-driver hook **only** into
`.claude/settings.json`; there is no codex equivalent that puts it into
`.codex/hooks.json`. So a codex agent in autonomous mode gets the standing Stop trio but
never the task-feedback loop, and dies after one turn.

## Design (Structure > Willpower + rollback-safe)

A **standing** codex Stop hook (codex Stop hooks already run on every turn-end), added
as the LAST hook in the EXISTING Stop group in `buildInstarCodexHookGroups` (slot
`stop:0:N`) — NOT a separate group. The second-pass review found that a separate group
emits a `stop:1:0` arm slot that codex may never render/trust, which would permanently
break `armCodexHooks`'s idempotency (recurring codex-TUI arm spawns + `partial` error logs
on every update, for every codex agent, even while the driver is dark). Riding the trio's
group means the driver is armed/trusted/fired alongside hooks codex already runs — no new
arm slot, no fleet-wide side-effect, and it sidesteps the "does codex fire a 2nd group"
uncertainty entirely.

The hook is the SAME `autonomous-stop-hook.sh`, invoked with a `--codex` arg:
- `--codex` lets the shared hook (a) anchor to the agent home via its own `$0` path
  (codex doesn't set `CLAUDE_PROJECT_DIR`; the existing `CLAUDE_PROJECT_DIR` branch still
  wins when set, which keeps it testable), and (b) **self-gate** on
  `autonomousSessions.codexLoopDriver.enabled`.
- Claude invokes the hook with NO args → `IS_CODEX=0` → the entire Claude path is
  byte-for-byte unchanged.

`groupIsInstarOwned` learns the skill-dir hook marker so the autonomous Stop group is
recognized and REPLACED (never duplicated) on every re-install.

### Dark launch + rollback
`autonomousSessions.codexLoopDriver.enabled` defaults **false**. While off, the standing
codex hook exits immediately (approve) — so it is a pure no-op for every codex session
until the flag is flipped. Rollback = set it back to false (instant, no redeploy). The
PR is additive, so a full revert is also clean.

## Migration parity
- The hook script change ships with the skill (`installBuiltinSkills` / always-overwrite
  for instar hooks) — but it's a SKILL asset; a `PostUpdateMigrator` skill-content
  migration overwrites the on-disk `autonomous-stop-hook.sh` for existing agents.
- The `.codex/hooks.json` registration: the existing codex-hook migration
  (`PostUpdateMigrator` → `installCodexHooks` + `armCodexHooks`) re-runs on update; the
  hooks.json hash changes → the new Stop group is registered AND re-armed automatically.
- Config default: none needed — absent `codexLoopDriver` === disabled (correct dark
  default); the flag is opt-in.

## Test plan (3-tier)
- **Unit (`installCodexHooks.test.ts`):** the autonomous loop driver is a separate Stop
  group (skill path + `--codex`), recognized as instar-owned (idempotent re-run never
  stacks a 3rd group), and a user Stop group survives alongside both instar groups.
- **Unit (`autonomous-stop-hook-codex-gate.test.ts`):** both sides of the gate —
  `--codex` + flag absent/false → approve (dark) even with an active job; `--codex` +
  true → block; NO `--codex` (Claude) → blocks regardless of the flag (Claude unaffected).
- **E2E / live (Phase verification, pre-enable):** with the flag ON, a real codex
  autonomous run sustains across ≥2 turns until the task list completes. Quota-gated;
  run only after deploy-dark.

## Phase 5 — second-pass reviewer (required, lifecycle machinery)
**Done — independent reviewer CONCURRED on shipping DARK** (2026-05-30). Verified PASS:
Claude path byte-for-byte unchanged; dark gate cannot leak (every config-read failure
path defaults to disabled); `$0` anchor resolves the agent home; `groupIsInstarOwned`
idempotency holds with no realistic false-positive; migration parity lands both halves.
The reviewer caught the separate-group arm side-effect (now fixed by the same-group
design above — no `stop:1:0` slot).

**Must-fix BEFORE flipping the flag ON (live verification, not a merge blocker):**
1. On a real codex binary with the flag ON, confirm the autonomous run sustains across
   ≥2 turns until the task list completes (the driver's block actually re-prompts).
2. Confirm within-group block precedence: when both the unjustified-stop router and the
   loop driver would block, the loop's task-feedback `reason` is what drives the next turn
   (or is acceptable). Worst case observed in design: the session still continues via the
   router, never strands — but verify the task-feedback path before relying on it.
