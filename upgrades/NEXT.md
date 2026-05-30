# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The Framework-Onboarding mentor now reports WHY a tick failed, and its Stage-A
step is more resilient.** The mentor's Stage-A step spawns a tiny tool-less
session to compose the next coaching message, then captures it. When that spawn
failed (common on a busy multi-agent box — session-cap pressure / load), the
whole tick collapsed to an opaque `stage-a-failed` with the real cause thrown
away, so it was undiagnosable from `GET /mentor/status`. Now: the real error is
surfaced into `lastResult.error`, and the Stage-A compose-session spawn retries
once with a short backoff before failing with a clear, specific message.

## What to Tell Your User

Only relevant if you run the (off-by-default) Framework-Onboarding mentor. It now
recovers from a transient compose-session spawn failure, and when it does fail it
tells you exactly why (visible at `/mentor/status`) instead of an unexplained
"stage-a-failed."

## Summary of New Capabilities

- `GET /mentor/status` → `lastResult.error` now carries the real Stage-A failure
  cause (`MentorTickResult.error`), instead of swallowing it.
- `spawnStageA` retries the compose-session spawn once (transient resilience) and
  throws a clear `stage-a-spawn-failed: … — <cause>` on persistent failure.

## Evidence

- `tests/unit/MentorOnboardingRunner.test.ts` (+1): a `spawnStageA` that throws
  now yields `lastResult = {ran:false, reason:'stage-a-failed', error:<msg>}` —
  asserts the cause is surfaced (was swallowed by a bare catch in
  `runMentorTick`). Full mentor/stage suite (113 tests / 9 files) green;
  `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/mentor-stage-a-robustness.md`.
