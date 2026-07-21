# Raw blocker lifecycle metrics

## What Changed

- Commitment mutations now acknowledge the authoritative atomic rename and roll back memory on persistence failure.
- Explicit commitment blocker transitions retain bounded lifecycle episodes and feed an observe-only SQLite ledger.
- Two raw factors—request-to-persist and clear-latency—are available through authenticated local and bounded per-origin pool summary/trend routes.
- The feature ships live on development agents and dark on the fleet through the standard development gate.

## Evidence

- TypeScript build passes.
- 42 focused commitment/lifecycle tests pass, plus 188 development-gate wiring tests.
- Six-round converged spec review and an independent side-effects/security pass.

## What to Tell Your User

Instar can now measure how long explicitly declared blockers take to persist and clear, without inferring what work an agent is doing or using those measurements to rank or control agents.

## Summary of New Capabilities

- Raw, nullable blocker lifecycle summaries and trends.
- Honest missing/excluded coverage reporting.
- Bounded multi-machine per-origin reads with no fleet score.
