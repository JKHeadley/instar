# Side effects — Phase-3 parity monitor + cutover gate

## New files (additive only)
- `src/feedback-factory/monitor/parityMonitor.ts` — `ParityMonitor` (records passes, tracks
  the zero-divergence streak, exposes the `gate()` cutover signal) + `DEFAULT_GATE_POLICY`.
- `tests/unit/feedback-factory/parity-monitor.test.ts` (9 tests).

## Runtime impact
- **None at boot / on the live server.** Not imported by `server.ts`, any route, job, or
  hook. No new endpoint, no config key, no `PostUpdateMigrator` entry. No new dependency
  (pure logic over the existing `ParityResult` type).

## Behavioral guarantees
- `gate()` clears ONLY when all four conditions hold: ≥ requiredCleanPasses consecutive clean
  passes, clean window ≥ minWindowMs of real time, ≥ minClustersObserved clusters across the
  streak, and zero divergence in the streak. Any divergent pass resets the streak.
- The monitor never mutates anything and never triggers cutover itself — it only computes a
  cleared/blocked verdict that a downstream executor reads.
- Conservative failure mode: an over-strict policy keeps the gate BLOCKED longer (cutover
  waits); it can never clear early.

## Reversibility
- Fully reversible: delete `monitor/parityMonitor.ts` + its test. Nothing references it yet.

## Follow-on wiring (not in this PR)
- The Coordination Mandate condition registry (G2.2) maps `parity-zero-divergence` →
  `monitor.gate(now).cleared`. The Phase-4 cutover executor (G2.4) consults it before the flip.
- A durable wrapper (persist passes to JSONL so the window survives a restart) + a read-only
  `/parity/status` route land with the cutover-executor wiring.

## Durability (added)
- `parityMonitorStore.ts` — `DurableParityMonitor` + `JsonlPassPersistence`. The zero-divergence
  window spans HOURS; without persistence a restart silently resets the streak. Passes are
  appended to an append-only JSONL and reloaded on construction, so the window survives a
  restart. Torn final line (crash mid-append) is skipped on reload, never corrupting the prior
  window. Injectable `PassPersistence` keeps the logic unit-testable without disk. Still not
  wired into the running server (the cutover executor constructs it with the live path).
