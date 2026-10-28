# Window run liveness no longer stalls a working run

## What Changed

- `WindowRunLivenessAuthority`: a transcript heartbeat up to 5 s newer than the sample time now counts as fresh (it was refused, which marked an actively-writing session as having a stale heartbeat; the incident had a heartbeat 65 ms after the sample).
- A recovery refresh refused with `session-busy` is recorded as `executor-busy`, not a failed recovery: the run re-samples at once and returns to active when green, stays at-risk otherwise, and still fails at the existing 15-minute recovery ceiling. Other refusals still stall loudly.

## What to Tell Your User

A long autonomous run that was working could be wrongly marked stalled, with its active status removed. Two causes are fixed: a heartbeat a few milliseconds newer than the check counted as stale, and a session too busy to restart counted as a failed recovery. A busy session is now treated as alive.

## Summary of New Capabilities

- `GET /window-run-liveness` can show recovery outcome `executor-busy` (the session was alive and mid-work, so it was not restarted).

## Evidence

Unit tests in `tests/unit/window-run-liveness-authority.test.ts`: a heartbeat 65 ms after the sample is fresh and active; a heartbeat 60 s in the future is still refused; a busy refusal with a green re-sample returns active with no notice; a busy refusal without green stays at-risk, heals on a later green tick and never calls recovery twice; a busy run that never turns green fails at the ceiling; the production refresh mapping marks only `session-busy` as busy.
