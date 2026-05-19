---
title: "Real enabledFrameworks config field + migrator framework gate (portability Gap 5)"
slug: "portability-framework-gate"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "portability-framework-gate.eli16.md"
review-convergence: "2026-05-19T20:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T20:30:00Z"
review-report: "docs/specs/reports/portability-framework-gate-convergence.md"
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode, 'finish making all the fixes based on the audit and get them deployed' + 'proceed as you best see fit')"
approved-date: "2026-05-19"
approval-note: "Gap 5 of six. Ships v1.0.11. The audit's framing would have been INERT (guard on a non-existent config field); this makes enabledFrameworks a real field first, then gates."
lessons-engaged:
  - "P1 (Structure>Willpower): a real persisted config field + a code gate, not a doc."
  - "P4 (Testing Integrity): 6-case test proving the gate is REACHABLE (codex-only skips) and the default path does NOT skip — i.e. not inert."
  - "P10 (Comprehensive-First): real field + helper + DRY refactor of the duplicate inline logic + one well-tested guarded step, establishing the pattern future steps reuse."
  - "L1-equivalent (audit-driven, framing corrected): the audit's 'wrap legacy steps' would have been theater because enabledFrameworks was never settable; the real fix is the field itself."
  - "L6/L9/L10: siblings."
---

# Real enabledFrameworks config field + migrator framework gate (Gap 5)

## Problem

The audit's Gap 5 was "wrap legacy `.claude/`-touching migrator steps in
`enabledFrameworks` guards." Verified against the code, that framing would
have been **inert**: `enabledFrameworks` was read defensively in exactly one
place (`migrateParityRenderings`) as `(config as {...}).enabledFrameworks`,
but it was never a real `InstarConfig` field, never settable, never written —
so it was always `undefined`, always defaulted to `['claude-code']`, and any
guard built on it would never skip anything. Guarding an unreachable
condition is theater, not a fix.

## Change

1. **`enabledFrameworks?: ('claude-code'|'codex-cli')[]`** is now a real,
   documented `InstarConfig` field (persisted in `.instar/config.json`).
2. **`PostUpdateMigrator.getEnabledFrameworks()`** is the single source of
   truth: reads the persisted field, filters to known values, defaults to
   `['claude-code']` when unset/empty/unreadable. The pre-existing duplicate
   inline logic in `migrateParityRenderings` is refactored to call it (DRY).
3. **`migrateSettings` is gated**: it only touches `.claude/settings.json`
   (Claude Code's hook/MCP config — zero meaning for Codex). It now
   short-circuits with a skip note when `claude-code` is not in the enabled
   set. This is the first guarded step and establishes the reusable pattern;
   the helper is available for the remaining legacy `.claude/` steps to adopt
   incrementally without re-deriving the framework set.

Default behavior is unchanged: unset config → `['claude-code']` → nothing
skips. Only an explicit `enabledFrameworks: ['codex-cli']` changes behavior.

## What this is NOT

- Not a sweep of all 49 `.claude/` references. That would be a large,
  regression-prone single PR. This ships the *mechanism* (real field +
  single-source helper) plus one fully-tested guarded step proving it is
  reachable; remaining steps adopt `getEnabledFrameworks()` incrementally.
- Not a default-behavior change. Existing/dual installs are byte-identical.

## Testing

`tests/unit/PostUpdateMigrator-frameworkGate.test.ts` — 6 cases: default
when field absent; default when config.json absent; honors codex-only;
honors dual; `migrateSettings` SKIPS for codex-only (gate reachable —
proves not inert); `migrateSettings` does NOT skip on default (negative
side). Plus the 11 `parity-renderings` tests pass unchanged, proving the DRY
refactor preserved behavior.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ real field + code gate |
| P4 Testing Integrity | ✓ 6 cases, both decision sides, reachability proven |
| P6 Zero-Failure | ✓ suite green; parity-renderings regression green |
| P10 Comprehensive-First | ✓ field + helper + DRY + guarded step + test |
| L1 (audit framing corrected) | ✓ avoids the inert-guard trap |
| L6/L9/L10 | ✓ siblings |

No contradictions. The incremental adoption of the helper by remaining steps
is explicitly NOT a deferral of *this* fix — the mechanism + a proven guarded
step is the complete unit of work here.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/core/types.ts` — real `enabledFrameworks` field on InstarConfig.
3. `src/core/PostUpdateMigrator.ts` — `getEnabledFrameworks()` helper, DRY
   refactor of the inline logic, `migrateSettings` gate.
4. `tests/unit/PostUpdateMigrator-frameworkGate.test.ts` (NEW, 6 tests).
5. `upgrades/NEXT.md` + `upgrades/side-effects/feat-portability-framework-gate.md`.
