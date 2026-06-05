# Side-Effects Review — Mentor autoloop gate-compliance line

**Version / slug:** `autoloop-gate-compliance`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `echo second-pass checklist`

## Summary of the change

Adds one static paragraph to `buildAutoloopGoal()` in `src/scheduler/MentorAutonomousGuardian.ts` — the deterministic prompt assembled for the autonomous mentor dogfooding loop. The paragraph teaches ratchet-gate compliance: intentional fail-open catches must report via DegradationReporter or carry an inline `@silent-fallback-ok` justification (never a baseline bump), and task briefs/specs authored for other agents must spell these notes out explicitly. Earned from PR #792's no-silent-fallbacks CI failure, where the spec's "best-effort, never throws" guidance invited the exact swallowed catch the ratchet counts.

## Decision-point inventory

- `buildAutoloopGoal` — modified — one additional template line appended to the returned prompt string. Pure string assembly; no new branches, no I/O, no config.
- `tests/unit/MentorAutonomousGuardian.test.ts` — modified — three new content assertions on the assembled prompt.

## 1. Over-block

None possible. The function returns a string; nothing is gated, blocked, or filtered. The added text instructs the *consuming agent*; it cannot prevent any operation by itself.

## 2. Over-permit

None. No permission surface is touched.

## 3. Token/cost impact

The prompt grows by ~430 characters, sent once per autonomous-fix guardian cycle (budget- and min-interval-gated, single-instance). Negligible.

## 4. Behavior change for existing consumers

The only consumer is `MentorAutonomousGuardian` → spawned loop session goal text. Existing assertions on the prompt (cycle steps, discipline line, topics) are unchanged and still pass — the new line is purely additive. The `degrades gracefully when topics are unset` test still passes (the added text contains no topic interpolation).

## 5. Failure modes

A string literal cannot throw at runtime. The TypeScript build verifies the template syntax. If the guidance itself were wrong, the blast radius is advisory-only (an agent following it would still produce gate-passing code — DegradationReporter and `@silent-fallback-ok` are both legitimate, documented paths in `tests/unit/no-silent-fallbacks.test.ts`).

## 6. Migration parity

None required: the prompt is assembled at runtime from shipped code; every agent gets it on its next update through the normal release path. No installed files, hooks, config defaults, or templates change.

## 7. Rollback

Revert the commit. No persisted state references the new text.
