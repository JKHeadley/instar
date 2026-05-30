---
title: Mentor Stage-A — surface the real error + harden the compose-session spawn
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Direct user directive (Justin, 2026-05-29, topic 13435): "lets fix this and
  make it more robust." Diagnosed live: the mentor tick passes all gates but
  reliably fails at Stage-A (GET /mentor/status .lastResult.reason =
  'stage-a-failed') with the real cause swallowed by a bare catch.
eli16-overview: MENTOR-STAGE-A-ROBUSTNESS-SPEC.eli16.md
date: 2026-05-29
---

# Mentor Stage-A: surface the real error + harden the spawn

## Problem (mentor delivers nothing; opaque failure)

The Framework-Onboarding mentor tick (`POST /mentor/tick`, in-process) passes
every gate (canary → budget → safe-window) and reaches **Stage-A** — the step
that spawns a tool-less Haiku session to compose the curriculum message
as-the-user, then polls its tmux output to capture it. On the live agent this
**reliably fails**: `GET /mentor/status` shows
`lastResult = {ran:false, reason:'stage-a-failed'}` and nothing reaches the
mentee. Two defects compound:

1. **Opaque failure.** `runMentorTick` wraps the `spawnStageA` call in a **bare
   `catch {}`** that discards the error and returns `reason:'stage-a-failed'`
   with no detail. The real cause goes only to a `console.warn` that did not
   reach the readable logs, and `lastResult` carried no error — so the failure
   was undiagnosable from the status endpoint.

2. **Fragile spawn.** `spawnStageA` calls `sessionManager.spawnSession(...)` with
   **no error handling**. On a busy multi-agent box a transient spawn failure
   (session-cap pressure / load) throws straight through, collapsing the whole
   tick to the opaque `stage-a-failed` with no retry and no clear message.
   (Observed: no compose session appears at all — the spawn throws before
   creating it.)

## Design

1. **Surface the real error (diagnosability).** `MentorTickResult` gains an
   optional `error?: string`. `runMentorTick`'s catch captures the message,
   includes it in the returned result AND in the recorded finding's title, so
   `GET /mentor/status .lastResult.error` shows exactly why Stage-A failed. The
   runner's own fire-and-forget `.catch` is given the same `error` field as a
   belt-and-suspenders for a rejected `tick()`.

2. **Harden the spawn (robustness).** `spawnStageA` now retries the
   `spawnSession` once with a brief backoff (transient cap/load resilience); on a
   persistent failure it throws a CLEAR, specific error
   (`stage-a-spawn-failed: … — <cause>`) which — via change (1) — lands in
   `lastResult.error`. So the next failure is both more survivable and fully
   diagnosable.

This is the smallest change that makes the failure non-opaque and adds real
resilience without altering Stage-A's two-hats isolation design (it still spawns
an empty-tool-grant session). If the surfaced cause turns out to be a persistent
session-cap refusal, the targeted next move (exempting the ephemeral internal
compose session from the user-facing cap) becomes obvious from the error text.

## Convergence notes (adversarial self-review)

- *Does the runner's `.then` path carry the error?* Yes — `runMentorTick`
  returns `{…, error}`; the runner sets `lastResult = {...r, at}`;
  `MentorRunResult extends Omit<MentorTickResult,'reason'>` keeps `error?`.
- *Could the retry mask a real persistent failure?* No — a persistent failure
  still throws after 2 attempts, with the cause in the message.
- *Two-hats isolation preserved?* Yes — the spawn still uses the empty
  `STAGE_A_ALLOWED_TOOLS` grant; only error handling + a retry were added.
- *Healthy ticks unaffected?* Yes — the new code only runs on the failure path
  (catch) or a spawn that throws.

## Testing

- **Unit** (`tests/unit/MentorOnboardingRunner.test.ts`): a `spawnStageA` that
  throws now yields `lastResult = {ran:false, reason:'stage-a-failed', error:<msg>}`
  — asserts the real cause is surfaced (was swallowed before). Existing 12
  runner tests + the full mentor/stage suite (113 tests across 9 files) stay
  green; `tsc --noEmit` clean.

## Migration parity

Server-internal scheduler/server code, not an agent-installed file — every agent
gets the fix by running the new build. No PostUpdateMigrator entry required.
