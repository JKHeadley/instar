---
title: Heartbeat-Writer Guard — a liveness write failure can no longer crash the awake holder, and never fails silently
status: converged
tier: 2
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"
review-convergence: self-converged against the loop-safety audit lead (CMT-1109) — grounding revealed the gap is WORSE than the audit's "silent failure" claim, since HeartbeatManager.writeHeartbeat() throws raw fs errors and the 2-min timer tick called it unguarded (uncaughtException → server FATAL path → a transient ENOSPC crashes the awake holder); validated by an adversarial second-pass whose narrow OBJECT on the promoteToAwake call site (silent completion of a voiceless promotion) was APPLIED pre-commit as rollback-and-rethrow.
approved: true
---

# Heartbeat-Writer Guard

> Approval ground: Justin's autonomous-session direction (topic "Resource
> Limitation Mitigation", 2026-06-06): "enter an autonomous session to complete
> the remaining tasks on the audit list," with standing merge-on-green approval.

## Problem (grounded — worse than the audit lead)

The audit flagged the heartbeat writer as "silent failure every 2min forever."
Grounding showed the opposite and worse: `HeartbeatManager.writeHeartbeat()`
throws raw fs errors (`mkdirSync`/`writeFileSync`/`renameSync` unguarded), and
all three coordinator call paths invoked it raw. In the 2-min `setInterval`
tick, a throw escapes as an `uncaughtException`; `server.ts` treats fs errors
as FATAL — so **a transient disk error (ENOSPC, permissions) crashed the awake
holder**, the worst possible per-attempt cost under P19. In `promoteToAwake`,
a throw aborted promotion midway (role flipped + registry updated, writer
never started).

## Design

Three call sites, three deliberate behaviors (the reviewer's framing):

1. **Periodic tick** → `writeHeartbeatGuarded()`: try/catch +
   `FailureEpisodeLatch` (new pure core class, the canonical extraction of the
   episode-latch pattern used three times tonight): first-failure log, ONE
   `DegradationReporter` signal per episode at 6min sustained (3 failed cycles
   — deliberately BEFORE the peer's 15min heartbeat-expiry failover horizon,
   verified against `DEFAULT_FAILOVER_TIMEOUT_MS`), recovery log + re-arm. The
   writer keeps attempting every tick forever — it is the awake machine's
   liveness voice (ETERNAL SENTINEL, declared per P19 condition 1).
2. **Boot-immediate write in `startHeartbeatWriter`** → same guarded path.
3. **`promoteToAwake`'s initial write** → rollback-and-rethrow (the reviewer's
   OBJECT, applied): a promotion that cannot voice its liveness must ABORT
   CLEANLY — `_role` and the registry are rolled back to the prior role before
   rethrowing — never silently complete into a voiceless awake, and never
   (pre-fix) die mid-transition with the role already flipped.

`FailureEpisodeLatch` uses **null sentinels, not 0** — the P19
sustained-failure test caught a zero-clock episode colliding with the
"no episode" sentinel before it ever shipped (the Dawn "zero is falsy" lesson,
again).

CLI one-shot callers (`machine.ts` wakeup/handoff) keep raw calls — no timer
vector, errors surface naturally to the CLI (reviewer probe 2). In lease-attached
mode the fenced lease, not the heartbeat file, is the failover authority
(`checkHeartbeatAndAct` returns early into `tickLease`), so the guarded path's
dual-awake window is lease-resolved; heartbeat-only mode is bounded by
`shouldDemote` on the next check cycle (reviewer probe 1 analysis).

## Tests

`tests/unit/FailureEpisodeLatch.test.ts` — 10 green: episode semantics, the
P19 sustained-failure bound (a WEEK of 2-min-cadence failures → exactly 1
signal and 1 first-failure line), threshold edge, recovery/re-arm, accuracy,
plus source-shape wiring pins (exactly two sanctioned raw call sites — the
guarded funnel + the promote-abort block with its rollback; latch constructed;
degradation feature key; sentinel declaration). Neighbor suites green
(multi-machine-coordinator 22, leasePull 3); tsc clean.

## Rollback

Revert; no persistent state, no config, no schema.
