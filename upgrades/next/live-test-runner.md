# LiveTestRunner — multi-machine transfer capstone orchestrator

## What Changed
`LiveTestRunner` (spec §6) — the orchestrator that applies the live-test standard to the cross-machine transfer, ships DARK (not wired). It transfers the throwaway topic to the target machine, demands the honest `seatMoved` signal (throws if the seat didn't move — no misleading PASS over the original "ok:true but moved nothing" bug), then runs the LiveTestHarness over a matrix asserting the reply was served FROM the target machine (the cross-machine proof). Pure orchestration over an injected harness + transfer action.

## Evidence
- `tests/unit/LiveTestRunner.test.ts` — 5 tests: non-move throws (no harness run), moved+reply-from-target→PASS, moved+wrong-machine→FAIL, slack channel-parity scenario added, empty-reply→FAIL.
- `tsc --noEmit` clean. instar-dev gate green.

## What to Tell Your User
Nothing yet — internal harness infrastructure, ships dark (no runtime surface). The payoff is the capstone: proving a real Laptop↔Mini seat move with a reply served from the destination, through the real channels.

## Summary of New Capabilities
None user-facing. Internally: the orchestration that runs the multi-machine transfer capstone and records the signed PASS/FAIL artifact. No new routes, config, or flags (the route wrapper is the next increment).
