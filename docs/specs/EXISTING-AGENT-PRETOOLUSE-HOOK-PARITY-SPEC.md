---
approved: true
review-convergence: internal-adversarial-2026-05-27 (single-reviewer conformance pass against the six Instar standards — no-manual-work, structure>willpower, signal-vs-authority, near-silent, 3-tier-testing, migration-parity — plus a gameability/over-block sweep. /spec-converge not run: the branded skill is not installed on this checkout, same as never-a-false-blocker-standard.md. Findings folded in: shared-constant anti-drift requirement, append-don't-reorder for hand-curated settings, Bash-matcher scope guard, init.ts behavior-preservation snapshot test.)
---

# Spec — Existing-Agent PreToolUse Hook Parity (the dark-guardrail migration gap)

## Problem

This is the same failure class as the 2026-05-27 silent-stall incident, one layer over: **guardrails that look installed but never fire on existing agents.**

`instar init` wires a full set of instar `PreToolUse` `Bash`-matcher hooks for **new** agents (`src/commands/init.ts`, `instarBashHooks`):

1. `dangerous-command-guard.sh`
2. `grounding-before-messaging.sh`
3. `deferral-detector.js` ← **Task 3's false-blocker interceptor (the signal layer of B17)**
4. `external-communication-guard.js`
5. `post-action-reflection.js`
6. `slopcheck-guard.js` (added via a separate ensure-block)

But `PostUpdateMigrator.migrateSettings()` — the ONLY path by which **existing** agents receive settings changes (Migration Parity Standard) — ensures just **two** of these on update:
- the `mcp__.*` matcher's `external-operation-gate.js` (line ~3675), and
- the `Bash` matcher's `slopcheck-guard.js` (lines ~3735/3748).

`migrateHooks()` *writes all six hook files to disk* (always-overwrite), so the scripts are present — but four of them are never added to an existing agent's `.claude/settings.json`, so Claude Code never invokes them:

- **`grounding-before-messaging.sh`** — the grounding-before-messaging gate.
- **`deferral-detector.js`** — the false-blocker / anti-deferral checklist (B17's cheap pre-filter). **This is exactly the Task 3 capability Justin asked to "fix."** The smart authority (`MessagingToneGate` B17) is live; this signal layer is dark on every existing agent.
- **`external-communication-guard.js`** — outbound external-comms guard.
- **`post-action-reflection.js`** — post-action learning capture.

Net effect, fleet-wide: every agent that installed on an older version and updated in place has these four guardrails sitting on disk, unwired, doing nothing. The files' presence makes them *look* installed (a `ls` shows them; the migrator even logs "upgraded: deferral-detector.js"). They never run.

## Root cause

`migrateSettings()` grew per-hook ensure-blocks ad hoc — one was added for slopcheck-guard (cherry-pick 2026-05-23), one for the MCP gate, one for the Stop-gate router — but there is **no single source of truth** that says "the instar Bash PreToolUse set is {A,B,C,D,E,F}; ensure each is present." So when `init.ts` gained `grounding-before-messaging`, `deferral-detector`, `external-communication-guard`, and `post-action-reflection`, no corresponding ensure-block was added to the migrator. New agents got them; existing agents silently didn't. This is the exact structural hole the Migration Parity Standard exists to prevent — applied to itself.

## Solution

Add one idempotent migration step, `ensureInstarPreToolUseBashHooks()`, called from `migrateSettings()`. It defines the canonical instar Bash PreToolUse hook set **in one place** (mirroring `init.ts`'s `instarBashHooks`, kept honest by a shared constant — see below) and, for each, ensures it is present in the `Bash` matcher, appending only the missing ones in canonical order. Mirrors the existing slopcheck ensure-block pattern exactly (find Bash entry → check `command.includes(hookFile)` → push if absent → set `patched`).

**De-duplication of the source of truth (prevents this recurring):** extract the canonical list (`{ file, command, blocking?, timeout? }[]`) into a shared module imported by BOTH `init.ts` and `PostUpdateMigrator.ts`. Then "new-agent wiring" and "existing-agent ensure" can never drift again — adding a hook to the shared list wires it for both paths. (If a shared constant is impractical without a larger refactor, fall back to a duplicated list in the migrator + a unit test that asserts the two lists are identical — the test is the anti-drift guarantee.)

**Idempotency:** each hook is added only if no existing entry's `command` already references its filename (substring match, matching the slopcheck pattern). Re-running the migration is a no-op once present. Custom hooks and user-added entries are never removed or reordered.

**Ordering:** append missing hooks; do not reorder existing ones (avoids churning hand-curated settings like Echo's). Canonical order is used only when creating a Bash matcher from scratch.

**Scope guard:** only the `Bash` matcher's instar hook set. The `mcp__.*` gate and the `Stop`/`PostToolUse` hooks keep their existing dedicated ensure-blocks (untouched). `dangerous-command-guard` is included in the ensure set for completeness (it's in `init`'s list) but is present on essentially all agents already, so it's a no-op in practice.

## Why this is the right level

The bug is that wiring lives in two places that drifted. The fix puts the *set* in one place and ensures it on both install paths. This is structure-over-willpower applied to the migration machinery itself — no future contributor has to "remember" to add an ensure-block.

## Migration parity

This spec *is* a migration-parity fix. The change is entirely within `migrateSettings()` (the existing-agent path) + a shared constant. New-agent path (`init.ts`) is refactored to consume the same constant (behavior-preserving). No config or CLAUDE.md change. No new hook scripts (all four already ship and are ESM-safe — `deferral-detector` verified clean on 2026-05-27).

## Test plan (all three tiers)

- **Unit** (`tests/unit/`):
  - `ensureInstarPreToolUseBashHooks` on a settings object missing all four → adds exactly the four (+ slopcheck if absent), in canonical order, none duplicated.
  - On a settings object that already has them → no-op (idempotency, both running once and twice).
  - On a settings object with a hand-curated Bash matcher (extra custom hooks, different order) → appends only missing instar hooks, preserves custom hooks and their order.
  - No Bash matcher at all → creates one with the canonical set.
  - **Anti-drift test:** the migrator's canonical list === `init.ts`'s `instarBashHooks` (same files, same commands). This is the test that makes the whole bug class impossible to re-introduce.
  - **init behavior-preservation:** after the shared-constant refactor, the settings object `init` generates for a fresh agent is byte-identical to the pre-refactor output (snapshot). The refactor must change *where* the list lives, never *what* a new agent gets.
- **Integration** (`tests/integration/`): run the real `PostUpdateMigrator.migrate()` against a fixture agent home whose `.claude/settings.json` predates these hooks → assert the resulting settings file contains all four hook commands in the Bash matcher.
- **E2E / live verification:** apply the migration to a real existing agent home (test-as-self), restart, confirm via a fired hook (e.g. trigger a false-blocker phrasing in a Bash messaging command and observe the deferral-detector checklist injection) that the previously-dark hook now runs. Restore after.

## Rollback

Revert the migration step (one method + its call site) and the shared-constant refactor. Worst case: existing agents return to the dark-guardrail state they're in today.

## Out of scope (tracked)

- Notify-on-stop (Task 2, separate spec).
- Self-propagation harness (Task 4).
- Auditing non-Bash matchers for similar drift (Stop/PostToolUse already have dedicated ensure-blocks; a broader "settings template reconciliation" is a possible follow-up but not needed to close this gap).
