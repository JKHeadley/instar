# Side-Effects Review — SleepWakeDetector: per-process CPU check separates event-loop block from sleep

**Version / slug:** `sleepwake-stall-not-sleep`
**Tier:** 1 (surgical bug-fix, one core file + tests; no new route, config contract, or persistence schema)

## Summary of the change

`SleepWakeDetector` inferred "sleep" from timer drift + **system loadavg**. A single
Node thread blocking its own event loop for tens of seconds does NOT move a 16-core
`loadavg` above `maxLoadRatio` (1.5), so an isolated event-loop block under normal
system load emitted a FALSE `wake` ("Wake detected after ~14s sleep") — even on a
caffeinated host where sleep is physically impossible. That laundered real wedges into
"sleep" and masked the actual fault.

The fix adds a per-PROCESS discriminator: `process.cpuUsage()` sampled across the drift
gap. A suspended (sleeping) process burns ~0 CPU; a blocked event loop burns CPU through
most of the gap. When `cpuBusyRatio >= cpuBlockBusyRatio` (default 0.5) the drift is a
BLOCK — emit a new signal-only `stall` event and SUPPRESS the false `wake`. The check
runs ahead of the existing load/burst/cooldown guards and, unlike the old `isLongSleep`
exemption, applies to LONG drifts too (a multi-minute CPU-busy drift is the wedge, never
sleep).

## Decision-point inventory

- **Threshold `cpuBlockBusyRatio` = 0.5.** A real wake burns ~0 CPU over the gap (ratio
  ~0); a CPU-bound block burns ~1 core (ratio ~1.0). 0.5 is the safe midpoint; set 0 to
  disable. Tunable, defaults on.
- **Ordering:** the CPU check is FIRST (most authoritative). A real long sleep (≈0 CPU)
  falls through it and still emits a wake via the existing `isLongSleep` exemption.
- **New `stall` event:** signal-only. No consumer = harmless (the value is the suppressed
  false wake). Wedge watchers MAY consume it later.

## 1. Over-block (false positive — suppressing a REAL wake)

Could a genuine wake be misread as a block? On real OS suspend the process is frozen →
~0 CPU over the gap → ratio ~0 → NOT suppressed → wake emits correctly. A wake immediately
followed by heavy CPU still reads low, because the drift tick fires once at wake and the
gap's CPU (the frozen span) is ~0. Verified by the `genuine sleep → WAKE` test.

## 2. Under-block (missing a block)

A low-CPU stall (IO-wait, not CPU-bound) reads ratio ~0 and is NOT flagged by this check —
by design; it falls through to the existing load/burst/recurring guards exactly as before.
This change only ADDS detection for the CPU-bound case the load heuristics were blind to;
it removes no existing suppression path.

## 4. Signal vs authority compliance

The detector only decides whether to emit `wake` vs `stall` — both are signals to other
watchers; it gates nothing and takes no destructive action. Recovery authority stays with
the consumers (ServerSupervisor / wedge watchers), unchanged.

## 5. Interactions

`getCumulativeSleepMsBetween` (the wake-reaper's sleep-credit source) reads only EMITTED
wakes; a suppressed block is never credited as sleep — so a wedge can no longer inflate a
job's sleep credit and cause an early reap. `getStats().suppressedByReason` gains an
`event-loop-block` counter (additive; existing keys unchanged).

## 6. External surfaces

None. No new route, no config-file contract change (the two new config fields are optional
with safe defaults), no persistence, no messaging. `GET /sleep/stats` (routes.ts) returns
the same `SleepWakeStats` shape plus the additive reason key.

## 6b. Operator-surface quality

N/A — no operator/dashboard/approval surface is touched. Change is internal to a core
detector.

## Framework generality

N/A — `SleepWakeDetector` is a framework-agnostic core monitor (not part of the session
launch/inject abstraction). It runs per-process regardless of which agentic framework the
session uses.

## 7. Multi-machine posture

Per-process and per-machine by nature; each machine's detector watches its own loop. No
replicated state, no cross-machine contract. Safe on single- and multi-machine installs.

## 8. Rollback cost

Trivial and safe: set `cpuBlockBusyRatio: 0` to disable the new branch (reverts to the
prior load-only behavior), or revert the commit. The defensive CPU read fails toward the
old behavior, so even a provider error degrades to pre-change semantics rather than
breaking.

## Evidence pointers

- New tests: `tests/unit/SleepWakeDetector-cpu-block.test.ts` (5 tests — CPU-busy short
  drift → stall; genuine sleep → wake; long CPU-busy drift → stall; stats record; throwing
  provider never crashes the tick). Existing `SleepWakeDetector.test.ts` (10 tests) still
  green — 15/15. `tsc --noEmit` clean.
- Live root cause (2026-06-21): a caffeinated, lid-open, plugged-in host logged "Wake
  detected after ~Ns sleep" for what were event-loop blocks — the misdiagnosis this fixes.

## Conclusion

A correctness fix that makes drift classification honest: CPU-bound event-loop blocks are
flagged as `stall`, not laundered into a false `wake`. Defaults on, fails safe, trivially
reversible. Ship.
