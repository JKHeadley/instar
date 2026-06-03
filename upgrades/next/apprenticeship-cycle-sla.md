<!-- bump: minor -->

## What Changed

Adds `ApprenticeshipCycleSlaMonitor`, an observe-only signal for apprenticeship differential cycles
that have stayed open longer than the configured SLA. The monitor reads `ApprenticeshipCycleStore`,
filters to open cycles, computes age from `createdAt`, and flags cycles older than the configured
overdue threshold, which defaults to 120 minutes.

The config gate ships off by default. When enabled, the server wires the signal into the existing
`TokenLedgerPoller` cadence via an after-tick hook, so this PR does not add another timer. The
monitor can raise attention, but it dedupes by cycle id in memory and never mutates the cycle store.

Adds `GET /apprenticeship/cycles/overdue?instanceId=` as a read-only authenticated route. It returns
`{ "overdue": [{ "id", "instanceId", "cycleNumber", "ageMinutes", "createdAt" }] }` and returns 503
when the monitor is unavailable or disabled.

## What to Tell Your User

- **Overdue apprenticeship cycles**: "I now have a quiet way to spot mentoring cycles that have been
  left open too long. It starts turned off, and if you ask me to enable it, it can point out stale
  cycles without changing or closing them."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Overdue apprenticeship cycle signal | Enable the apprenticeship cycle SLA monitor when you want stale open cycles surfaced. |
| Read overdue cycles | `GET /apprenticeship/cycles/overdue?instanceId=` returns the overdue set when the monitor is enabled. |

## Evidence

Verification:

- Unit: injected clock/store coverage for open vs closed cycles, age thresholding, disabled mode,
  and per-cycle attention dedup across ticks.
- Integration: route auth, disabled 503, and instance-scoped overdue results.
- E2E: `AgentServer` initializes the enabled monitor and serves the overdue route as 200, not 503.
