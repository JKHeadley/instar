# Side effects — Track G: Multi-Agent-Per-Machine load broker + isolation (§L6)

## What this adds
Pure cores for L6 (multiple agents sharing one machine), shipped DARK (no boot wiring — consumed by the registry/router when the pool activates in Track H).

- `src/core/MachineLoadBroker.ts` — `computeMachineLoad(input)`: the machine-local shared-load accounting. Sums sessions across ALL resident agents (true machine load, not just one agent's view), and — critically — does NOT trust agent self-reports for the authoritative number. It cross-checks each agent's claimed footprint against the OS-measured footprint; an agent measured to use materially MORE than it claims (the lie-idle case) is flagged `suspect-overloaded`, its placement weight reduced, and `sessionCountTrustworthy` set false (the router leans on the authoritative OS `loadAvg`). A lying agent cannot make itself look idle. Plus `checkAgentIsolation(agents)`: the L6 isolation invariant — distinct ports/identities, no nested home dirs (which would let one agent read another's state).

## Risk / blast radius
None — pure functions, not imported by any boot path yet.

## Tests
- `tests/unit/MachineLoadBroker.test.ts` — 8: cross-agent session sum, under-report → suspect-overloaded (+ untrustworthy session count), over-report not flagged (conservative), custom tolerance; isolation pass + duplicate-port/duplicate-fingerprint/nested-home detection.
- `tests/integration/machine-load-placement.test.ts` — 1 (§L6→§L4): a machine whose agent lies idle (high OS loadAvg) is flagged suspect AND NOT selected by PlacementExecutor — the OS truth overrides the faked self-report, so a lying agent cannot attract sessions.

## Activation boundary (Track-H, D11)
The live OS sampling (process RSS by port/cmdline) + feeding the broker's output into the live MachineCapacity heartbeat are the Track-H wiring; the accounting + verification + isolation logic is fully built + tested now.
