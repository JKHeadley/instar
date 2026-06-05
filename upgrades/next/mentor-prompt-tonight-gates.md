<!-- bump: patch -->

# Mentor autoloop prompt: pre-build claim check + ELI16-in-PR-body rules

## What to Tell Your User

Nothing user-visible. The autonomous mentor-development loop's built-in working instructions now include two recently-earned ship rules, so future cycles don't rediscover them the hard way.

## Summary of New Capabilities

- The mentor autoloop goal prompt instructs each cycle to run `instar dev:claim-check` before starting a build (parallel-claim collision prevention) and to include the `## ELI16` section in every PR description from the start (the required CI gate).

## What Changed

One discipline line appended in `buildAutoloopGoal` (`src/scheduler/MentorAutonomousGuardian.ts`), pinned by the existing deterministic prompt-assembly unit test (2 new assertions). Earned from the 2026-06-05 double parallel-collision and the live #813 eli16-gate hit.
