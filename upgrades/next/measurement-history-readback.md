# Preserve exact measurement history reads

## What Changed

The existing maturation summary separates latest evaluated-feature states in its lookback from historical evaluation counts. History retains exact due/evaluation/evidence times, contract and stage boundaries, metric totals and explicit omitted-feature/point counts within a384KiB history budget. Peer reads preserve the fields and the already-merged outcome detail; older peers remain compatible. The durable ledger is unchanged.

## What to Tell Your User

I can show when evidence was checked, which rules it used and which older points are omitted. Latest results and counts of historical checks are different measures; neither alone proves improvement.

## Summary of New Capabilities

More precise existing history reads, without changing feature activation or promotion.

## Evidence

Reconciled existing history increment against merged2847. 10service unit,24actual pool-route integration and8production-AgentServer throughput/measurement-board E2E tests pass. Independent closing review concurred after7red-to-green peer-validation regressions. Dense-factor512feature/90day response fits the existing512KiB envelope. These are controlled tests; full canonical verification and deployment are still required.
