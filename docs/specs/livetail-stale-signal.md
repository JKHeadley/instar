---
title: Live-Tail Stale-Standby Signal — a topic failing its flushes says so once
status: converged
tier: 2
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: self-converged against the #867 reviewer's noted gap (backoff retries forever at the 5min cap with zero observability — correct persistence, missing condition-4 signal) + the loop-safety audit (CMT-1109); validated by a focused adversarial second-pass (CONCUR — episode timing, backoff-window firing bound, recordNoNewContent edge, and DegradationReporter flood analysis: all topics share one feature key with a 1h alert cooldown, so N simultaneous stale topics produce at most one alert).
approved: true
---

# Live-Tail Stale-Standby Signal

> Approval ground: Justin's "yes approved, please continue" (2026-06-06, topic
> "Resource Limitation Mitigation") continuing the audit-fix series under P19.
> Merge gates on CI green per the standing word.

## Problem

#867 gave the live-tail flusher its backoff (5s→5min cap) — and per the
Eternal Sentinel clause, retrying forever at the cap is CORRECT: the standby's
copy should converge whenever the peer recovers. What it lacked was condition 4:
a topic whose flushes fail for hours goes quietly stale — a failover during
that window silently resumes the conversation from an old tail, and nothing
ever said so.

## Design (signal-only)

Per-topic `failingSince` episode stamp + an episode-keyed one-shot latch (the
`SlowRetrySentinelEscalation` shape, third use tonight): the first attempt at/
after `staleSignalAfterMs` (default 30min; detection bound = threshold + one
backoff window ≤5min) logs once and calls the optional `reportStaleStandby`
dep once per episode; success clears both. `server.ts` wires the dep to
`DegradationReporter` (`LiveTail.standbyFreshness`) with the topic NAME — a
housekeeping record, never a user ping; the reporter's per-feature 1h cooldown
bounds even an all-topics-stale storm to one alert (reviewer-verified).
Omitted dep → exact pre-change behavior.

## Tests

`LiveTailSource.test.ts` +5: the P19 sustained-failure bound (~100 failing
attempt windows → exactly 1 signal), pre-threshold silence, recovery + fresh
episode re-fires, omitted-dep no-op, and the server.ts wiring pin. 21/21 file
total; tsc clean.

## Rollback

Revert; no state, no config, no schema.
