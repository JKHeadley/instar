# Side effects — Track E part 3: deliverMessage boot wiring + factory + config tunables (§L4)

## What this adds
The owner-side receive wiring for the §L4 deliverMessage command, plus the §L4 router/placement config tunables. Ships DARK — the receive handler is registered on the boot mesh dispatcher (already gated by machine-identity presence; inert on a single-machine agent), and the config block stays `enabled:false, stage:dark`.

- `src/core/DeliverMessageHandler.ts` (NEW) — `createDeliverMessageHandler(deps)`: the single shared factory for the owner-side receive contract (stale-ownership fence → idempotent durable-receipt-before-processing → queued/duplicate ACK). Imported by BOTH `server.ts` boot AND the tests, so the production handler and the tested handler cannot drift (Structure > Willpower).
- `src/commands/server.ts` — the boot mesh dispatcher now registers `deliverMessage` via the factory, wired to the real `SessionOwnershipRegistry` (owner epoch) + the real `MessageProcessingLedger` (idempotency key = messageId; SQLite-backed durable receipt), with an in-memory fallback set when the ledger is unavailable.
- `src/config/ConfigDefaults.ts` + `src/core/types.ts` — added the §L4 tunables to the dark `sessionPool` block: `deliverMessageTimeoutMs` (5000), `deliverMessageMaxRetries` (3), `placementHysteresisDelta` (0.15), `ownershipCasMaxRetries` (5). `applyDefaults` is add-missing-only + recursive, so existing agents backfill ONLY the new sub-fields on update without clobbering an operator's tuned values (migration parity).

## Risk / blast radius
None at runtime for a single-machine agent: the deliverMessage handler is only reachable through `/mesh/rpc`, which requires a registered peer machine + a router-holder RBAC check (router-only). The config additions are inert (enabled:false). No live-ingress path is touched — live-ingress interception + the outbound mesh client are Track-H's stage-gated activation (decision D11), not a deferral.

## Tests
- `tests/unit/DeliverMessageHandler.test.ts` — 5 tests: queued (first + onAccepted-once), duplicate (idempotent, no re-process), stale-ownership, not-stale-on-match/lead, null-epoch.
- `tests/e2e/session-pool-delivermessage-e2e.test.ts` — 4 "feature alive" tests over the PRODUCTION factory + real MeshRpcDispatcher + real /mesh/rpc HTTP route + real SQLite MessageProcessingLedger + real SessionOwnershipRegistry: endpoint alive (200 + queued), redelivery → duplicate (ledger dedupe), stale-ownership after the owner epoch advances, non-router → 403.
- `tests/unit/ConfigDefaults.test.ts` — +1: the Track-E tunables backfill into a partial sessionPool block (add-missing, operator stage preserved).

## Agent awareness / migration parity
- Agent awareness: already delivered in Track B's Tier-0 CLAUDE.md blurb (template + migrator) — it documents the "run this on / move this to <nickname>" triggers; Track E's recognizer makes them fire. No new CLAUDE.md change.
- Migration parity: config sub-fields auto-backfill via `applyDefaults` (asserted by the new test). The deliverMessage receive handler is core boot code (no agent-installed-file change).
