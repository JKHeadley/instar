# Side effects — Track F part 2: transfer integration + §L5 config tunables

## What this adds
- Tier-2 integration coverage (`tests/integration/transfer-orchestrator-ownership.test.ts`) of the TransferOrchestrator driving the REAL SessionOwnershipRegistry transfer FSM + REAL verifyLedgerSnapshot — no production code change there, it's test-only.
- `src/config/ConfigDefaults.ts` + `src/core/types.ts` — the §L5 transfer/handoff tunables added to the dark `sessionPool` block: `transferDrainTimeoutMs` (30000), `transferOutputCutoffMs` (1000), `placementCooldownMs` (300000), `topicPlacementUpdateMinIntervalMs` (10000). Added via the add-missing `applyDefaults` path so existing agents backfill ONLY the new sub-fields on update (migration parity), never clobbering tuned values.

## Risk / blast radius
None — config additions are inert (the whole sessionPool block is enabled:false / stage:dark). No behavior change.

## Tests
- `tests/integration/transfer-orchestrator-ownership.test.ts` — 2: clean S→T transfer reaches active(T)@epoch4 through the real FSM + source teardown after claim; in_flight ledger snapshot → sync-corrupted, record stays transferring(S) (no no-owner gap), T never claims, source not torn down.
- `tests/unit/ConfigDefaults.test.ts` — extended backfill assertion: the §L5 tunables backfill into a partial sessionPool block (add-missing, operator stage preserved).
