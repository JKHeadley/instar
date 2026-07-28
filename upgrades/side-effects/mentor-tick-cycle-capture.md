# Side-Effects Review — Mentor tick keystone cycle capture

**Slug:** `mentor-tick-cycle-capture` · **Date:** `2026-06-04` · **Author:** `echo`
**Second-pass reviewer:** `not required` (additive, opt-in, no-op by default)

## Summary

`runMentorTick` now (after the existing per-finding ledger capture) records a
`mentor-mentee-differential` apprenticeship CYCLE via an injected, optional
`recordCycle`. The host (`AgentServer.buildMentorRunner`) wires it to the
ApprenticeshipCycleStore ONLY when `mentor.apprenticeshipInstanceId` is set, so it
is a no-op by default. The mentee's transcript is the cycle's menteeOutput; the
forensics findings (mapped to titles) are the differential.

## Decision-point inventory

One new branch: record a cycle iff `recordCycle` is wired AND the transcript is
non-empty. Both sides covered (records on a real tick; skips on empty transcript;
no-op when unwired).

## 1. Over-block

Rejects nothing real. The transcript guard skips an empty/failed Stage A (not a
cycle) — intended. Without `apprenticeshipInstanceId`, no cycle is recorded
(back-compat); the existing finding-capture path is unchanged.

## 2. Under-block

It records ALL of a tick's findings as the differential without de-duping against
prior cycles (acceptable — each tick is a distinct cycle). The cycle's `task` is a
generic per-tick descriptor, not the full Stage-A prompt (kept terse on purpose).
cycleNumber is computed as max-existing+1 (single-writer mentor tick, no race).

## 3. Level-of-abstraction fit

Right layer: the pure tick gets an injected callback (no store dependency in the
pure core); the store wiring + instance resolution live in `buildMentorRunner`
beside the existing `capture` wiring, reading the cycle store lazily to dodge the
boot-order (buildMentorRunner runs before the store is constructed).
