# Side-Effects Review — Unified usage ledger, Slice 4 (read API, pool view, phone view, snapshot)

**Version / slug:** `unified-usage-ledger-slice4`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Fourth build slice of `docs/specs/unified-usage-ledger.md`: the read side and the multi-machine view.

- **Replication (`UsageLedger.exportPage` / `applyPeerPage`).** Every machine serves its own rollup and binding rows changed after a `change_seq`, capped at 5,000 rows / 5 MB, and a page only ever ends on a seq boundary (one batch shares one seq; a batch bigger than a page is sent whole). The lease holder applies each page into `pool_rollup_*` / `pool_bindings` (rows replace by key, so a re-read page is idempotent) and advances the peer's cursor in the same transaction. Peer input is validated at the edge (non-negative integer tokens, finite dollars, strings ≤ 256, rows only under the peer's own machine id); invalid rows are skipped, counted, and the cursor still advances. A changed `generation_id` drops that peer's pooled rows from its snapshot time on and re-pulls from zero.
- **Puller (`src/monitoring/UsagePoolPuller.ts`, new).** Holder-only. Pulls every 5 minutes; a read that finds a peer older than 60 s triggers a single-flight background pull; exponential backoff to 30 minutes; `not-reached` with the reason after 3 consecutive failures, recovering on the next success; eager pull of every peer on becoming holder (`warming` until each answers); a yield between pages.
- **Read model (`src/monitoring/usageReadModel.ts`, new).** `/usage/summary`, `/usage/series`, `/usage/top`, `/usage/tree`, `/usage/coverage`, all priced on read (Slice 3), enum-validated, windows clamped (hour ≤ 14 d, day ≤ 400 d, top ≤ 90 d, session ≤ 31 d, limit ≤ 200). The tree returns ≤ 3 levels, ≤ 20 children per node plus "other", and the session level only beneath a chosen parent.
- **Routes (`src/server/usageRoutes.ts`, new).** The five reads plus `/usage/events?session=` (validated id, ≤ 500 rows, proxied to the owning machine), `/usage/rollup?after=` (machine-to-machine page) and `/mobile/usage` (owner phone only; the receiving machine fetches the bearer answers — from the holder when it is a standby — and trims them locally: totals, series and top topics/jobs/features by name, no machine, session or account ids). A standby proxies `/usage/*` to the holder and, when the holder cannot be reached, answers from its own rollups labelled `this-machine-only`. 503 `usage-ledger-off` when dark.
- **Snapshot (`writeSnapshot` / `importSnapshotIfEmpty`).** `server-data/usage-ledger.snapshot.db` (day rollups, bindings, checkpoints, open pairs, identity) is written hourly by atomic rename, never while the live database is empty. At open, before ingest: imported only into an empty live database; another agent's snapshot is refused; this machine's or a predecessor's is re-keyed to this machine with a new generation, and checkpointed Claude files are re-read once for detail rows (never counted); a replaced machine that is not a live pool member imports as a frozen local slice of day rollups that is never exported; a live member's is refused. Every outcome is recorded in coverage.
- **Wiring.** `AgentServer` imports the snapshot, starts the puller, and exposes route deps through `RouteContext.usageRouteDeps`; `routes.ts` mounts the routes. The phone rule `GET /mobile/usage` (owner only, capacity-reads bucket) joins `DEVICE_ALLOWLIST`. A `CapabilityIndex` entry claims `/usage`.

**Defect found by the new e2e and fixed here:** the ledger's pricing read the manifest from the agent's project dir, which on an installed agent has no source checkout and so no manifest — every figure would have been unpriced. The ledger now builds its own price authority over the manifest that ships inside the instar package (`scripts/` is in the published files), falling back to the project dir.

Tier 2. Size: ~1,200 lines across 3 new modules and 5 changed files; 2 new test files (29 unit + 2 e2e); 2 pinned-list tests updated for the new route.

## Decision-point inventory

- None that gates an action. The holder check only decides who pulls and who proxies reads.

## 1. Over-block

`/mobile/usage` refuses a non-owner phone (403 `owner-phone-required`), matching `/mobile/spend`. Intended.

## 2. Under-block

`/usage/rollup` is bearer-only and not on the phone allowlist, so a phone can never read the untrimmed replication stream.

## 3. Level-of-abstraction fit

The read model is pure functions over one grouped query, so the routes, the phone trim and the console (Slice 5) all share one source of numbers.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

Signal only: reads, replication and a backup file. No LLM, no outward message, no authority over any call.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions

- `TokenLedger`, `/tokens/*`, `/mobile/spend` and BurnDetector are untouched.
- The pull reuses `poolPeerFetch` (rope fallback and the credential guard) and the pool's own peer list.
- A pooled read of up to 400 days groups in SQL by day and model before pricing, so the JS work is bounded by distinct keys, not raw rows.

## 6. External surfaces

New bearer routes under `/usage` and the owner-phone route `/mobile/usage`. All read-only.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Errors are plain words (`503 usage-ledger-off: The usage ledger is turned off on this machine.`, `400 bad-query: dim must be one of topic, job, session, feature`). A partial pool answer names the machines that were not reached or are warming instead of showing zeros.

## 7. Multi-machine posture (Cross-Machine Coherence)

Rollups and bindings: unified (holder pull, served from any machine through the standby proxy, persisted pooled copy reused across lease tenures). Raw rows, pairs and checkpoints: machine-local; raw rows are read on their own machine through `/usage/events`. The snapshot is per machine and refused across agents and live members.

## 8. Rollback cost

Turning `usage.ledger.enabled` off stops the puller and the snapshot writer, and the routes answer 503. Pool tables and the snapshot file stay on disk, inert.

## Conclusion

Safe to ship dark. The agent can now answer "where are my tokens going and what would it cost" across all of its machines.

## Evidence pointers

- `tests/unit/UsageLedger.slice4.test.ts` — 29 tests: page round-trip and idempotency, cursor deltas, seq-boundary paging, forged and invalid rows, generation reset; puller backoff → not-reached → recovery, standby never pulls, single-flight; summary, not-reached/warming naming, top, series, tree depth and "other", enum and window clamps, coverage, phone trim without ids; snapshot never-write-empty, restore-over-live no-op, rebuild-from-snapshot equal totals, predecessor re-key, frozen slice never exported, live-member and other-agent refusals; routes 503 when off, 400 in plain words, standby proxy and labelled local answer, rollup and events validation, phone 403 and trim; a real transcript row reaching `/usage/top?dim=topic`.
- `tests/e2e/unified-usage-ledger-alive.test.ts` — a production-booted development agent answers all seven routes 200, a real funnel one-shot reaches the totals with a non-zero equivalent cost, unauthenticated reads are 401; a fleet agent answers 503.
- `mobile-session-terminal.test.ts` and `capabilities-discoverability.test.ts` updated for the new route; `npx tsc --noEmit`: exit 0.
