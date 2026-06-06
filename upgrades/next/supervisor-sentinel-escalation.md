---
bump: patch
---

## What Changed

The ServerSupervisor's slow-retry mode (respawn a dead server every 2h, forever)
is a sanctioned Eternal Sentinel under the new "No Unbounded Loops" standard —
but it violated condition 4: it never told anyone. A multi-day crash-revive loop
was indistinguishable from silence. Now a pure one-shot latch
(`SlowRetrySentinelEscalation`, the AgeKillBackoff suppressor shape) fires
exactly once per outage episode after a sustained-failure threshold (default
12h ≈ 6 failed cycles): the supervisor emits `sentinelStalled` and the lifeline
sends ONE operator message with the two useful levers (`/lifeline doctor`,
`/lifeline reset`), then the sentinel keeps quietly retrying. The message goes
directly to the Telegram Bot API from the lifeline process — no dependency on
the (down) agent server. Recovery re-arms the latch via the single
`resetCircuitBreaker()` funnel; retry/kill/spawn decisions are unchanged.

## What to Tell Your User

If your agent's server ever gets stuck in a crash loop, you'll now get one
clear heads-up after ~12 hours — "still down, here's how to diagnose or force a
retry, I'll keep trying" — instead of discovering the outage by noticing your
agent went quiet for days. One message per outage, never a stream.

## Summary of New Capabilities

- Slow-retry escalation: a sustained server outage (default 12h in slow-retry)
  produces exactly one operator notification per episode; the never-give-up
  revival behavior is unchanged. In-code default; no config required.

## Evidence

Loop-safety audit finding (CMT-1109), verified at source: the slow-retry block
in `src/lifeline/ServerSupervisor.ts` was annotated "never truly give up" with
no operator signal. Fix is the first PR under constitution P19 ("No Unbounded
Loops", incl. Justin's Eternal Sentinel caveat — this loop is its namesake
case). Tests: 10 green in `tests/unit/SlowRetrySentinelEscalation.test.ts`
including the P19 sustained-failure bound (week-long never-recovering episode →
exactly 1 escalation) and source-shape wiring pins. Independent adversarial
second-pass: CONCUR (all probes safe — per-tick reachability, no double-fire,
server-independent delivery, emit-before-spawn ordering). tsc clean.
