---
title: Slow-Retry Sentinel Escalation — the supervisor's never-give-up loop tells a human once
status: converged
tier: 2
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: self-converged against the loop-safety audit finding (CMT-1109, verified at source — slowRetryIntervalMs comment literally says "never truly give up" with no escalation) + line-level trace of every slowRetryStartedAt write and the per-tick reachability of the slow-retry block; validated by an independent adversarial second-pass reviewer (CONCUR — all four probes safe, incl. the lifeline-restart re-fire window being correct-by-design and the Telegram path being server-independent).
approved: true
---

# Slow-Retry Sentinel Escalation

> Approval ground: Justin's ratification of the "No Unbounded Loops" standard
> WITH his Eternal Sentinel caveat (2026-06-05, topic "Resource Limitation
> Mitigation") — condition 4 of which ("still observable — escalates once after
> a sustained-failure threshold") is precisely this change, applied to the exact
> loop that inspired the caveat. He directed the audit fixes as individual PRs
> ("Sounds great!"). Merge gates on his word as usual.

## Problem (loop-safety audit, verified 2026-06-05)

`ServerSupervisor`'s slow-retry mode is the healer of last resort: once the
circuit breaker's fast retries are exhausted, it respawns the dead server every
`slowRetryIntervalMs` (2h) forever — `src/lifeline/ServerSupervisor.ts`
literally annotates it "never truly give up". Per the ratified Eternal Sentinel
clause that persistence is CORRECT (it is what brings everything else back),
and its rate floor + constant per-attempt cost already satisfy conditions 2–3.

What it violated was **condition 4 — still observable**. Nothing ever told the
operator. A server flailing in 2-hour respawn cycles for days was indistinguishable
from silence; the operator learned of the outage by noticing the agent's absence.

## Design (signal-only — no retry/kill/spawn decision changes)

- `src/lifeline/SlowRetrySentinelEscalation.ts` — a pure one-shot latch
  (injectable clock, two fields), the same suppressor shape as `AgeKillBackoff`:
  `shouldEscalate(slowRetryStartedAt)` returns true exactly once per episode,
  the first tick at/after `escalateAfterMs` (default 12h ≈ 6 failed 2h cycles).
  The latch keys on the episode timestamp — a fresh episode re-arms even if a
  reset were missed; `reset()` re-arms on recovery.
- `ServerSupervisor`: the slow-retry block carries the explicit ETERNAL SENTINEL
  declaration (condition 1) and, per tick in slow-retry mode, asks the latch;
  on fire it emits `'sentinelStalled' { hoursStalled, retryIntervalHours }` and
  keeps retrying. `resetCircuitBreaker()` (the single episode-ending funnel —
  every recovery/operator path goes through it) re-arms the latch in lockstep
  with zeroing `slowRetryStartedAt`, so key and latch can never desync.
- `TelegramLifeline`: listens for `sentinelStalled` → ONE operator message
  ("still down after Nh; retrying every 2h; `/lifeline doctor` / `/lifeline
  reset`; this is the only nudge for this outage"). The send goes DIRECTLY to
  the Telegram Bot API from the lifeline process — zero dependency on the agent
  server, which is by definition down when this fires (reviewer-verified).
- New optional `slowRetryEscalateAfterMs` constructor option (tests); shipped
  default lives in code — no config surface, no migration.

## Bounds (P19 sustained-failure proof)

The unit suite drives a week-long never-recovering episode through the latch
and asserts the escalation count is exactly 1 — the declared bound. A lifeline
process restart zeroes the in-memory latch alongside ALL breaker state, so a
re-fire requires rebuilding ~13.5h of fresh sustained failure: a correct
"still broken after a bounce" re-notification, not a duplicate.

## Tests

`tests/unit/SlowRetrySentinelEscalation.test.ts` — 10 green: threshold
semantics, the sustained-failure bound, reset/re-arm, episode-keyed defensive
re-arm, plus source-shape wiring pins (supervisor constructs/checks/emits;
reset re-arms inside `resetCircuitBreaker`; the sentinel declaration exists;
the lifeline listens and delivers). Signal-only change with no HTTP route —
wiring pins substitute for Tier-2/3 per the live-tail precedent (reviewer
concurred).

## Rollback

Pure in-process; revert the commit. No persistent state, no config, no schema.
