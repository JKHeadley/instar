# Mentor autoloop prompt teaches ratchet-gate compliance

## What to Tell Your User

Nothing user-visible. The autonomous mentor loop's instructions now include how to satisfy the repo's ratchet CI gates, so mentor-driven fixes stop tripping no-silent-fallbacks.

## Summary of New Capabilities

- `buildAutoloopGoal` includes a gate-compliance paragraph: intentional fail-open catches must report via DegradationReporter or carry an inline `@silent-fallback-ok` justification — never a ratchet baseline bump.
- The mentor is instructed to spell out these gate notes in any task brief or spec it authors for another agent.

## What Changed

One additive line in the mentor autoloop prompt (`src/scheduler/MentorAutonomousGuardian.ts`), locked by three new unit-test assertions. Earned from PR #792's no-silent-fallbacks CI failure, where a spec's "best-effort, never throws" wording invited the swallowed catch the ratchet counts.
