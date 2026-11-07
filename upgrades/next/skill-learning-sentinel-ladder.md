<!-- bump: patch -->

## What Changed

The approved Skill Learning Sentinel spec (`docs/specs/skill-learning-sentinel.md`) lands with its maturation-ladder
entry `monitoring.skillLearning` registered in `src/data/feature-ladders.json`, so the ladder names a real feature
switch with dated rungs (dev-agent-live → fleet) from day one. No runtime behavior changes in this release; the
feature itself ships switched off until slice 0 arrives.

## What to Tell Your User

Nothing to do. This is the design for a feature that will learn reusable skills from your repeated requests, plus
its maturation plan, registered ahead of the code so the plan cannot be forgotten.

## Summary of New Capabilities

- Converged, approved spec for the Skill Learning Sentinel (data-only in this release).
- Ladder entry `monitoring.skillLearning` with dated rungs and an owner.

## Evidence

`tests/unit/feature-ladders-coverage.test.ts` ("every spec that names a ladder names a real entry") passes with the
entry present and failed without it (PR #2871 CI, 2026-11-06).
