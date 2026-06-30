# Cross-Machine "Stuck Move" Fix — ownership-reconciler convergence

## What Changed

Closes the cross-machine "stuck move" bug: a conversation pinned to one machine while another still owned it never converged. Three root causes are fixed:

1. **Clock-skew quarantine false-positive** — the pool-refresh fed the coarse, git-synced file heartbeat's timestamp into the live 5-minute clock-skew check, permanently quarantining a peer whose clock was actually fine. A `coarseHeartbeat` flag now makes coarse beats refresh liveness without ever driving the skew FSM.
2. **The pin (move-instruction) never reached the owning machine** — it was written only on the lease-holder. A new `topic-pin-record` replicated-record kind (on the existing WS2 replicated-record rails: HLC ordering, tombstone-on-clear, quarantine) replicates the pin; the owning machine's reconciler reads it as an HLC-ordered, validated (known + online target) advisory move-intent and starts the cooperative transfer.
3. **The `transferring` handoff signal never replicated** — `PlacementData` is extended with `status`/`transferTo`/`timestamp`/`drainInFlight`, threaded at the shared `emitPlacement` helper, and `OwnershipApplier` now materializes the transferring state (validated `transferTo`→downgrade, epoch-fenced, timestamp-clamped) so the target machine claims and the handoff completes.

Also: a stuck-transferring `abort-transfer` recovery (a dead-target handoff self-heals back to active instead of freezing), a read-only `GET /pool/reconciler` observability route, and the testing-integrity root fix — the reconciler test harness is rebuilt so every test runs separate-per-machine stores joined only by a journal pump (the shared-store harness had masked this bug class for months).

Ships dark behind `multiMachine.seamlessness.ws13Reconcile` / `ws13DryRun` and an independent `ws13PinReplicate` sub-flag (dev-agent live, fleet dark). A single-machine agent is a strict no-op.

## Evidence

- Spec converged through 3 review rounds (8 internal reviewers + codex/gemini external each round, ~24 findings folded): `docs/specs/cross-machine-reconciler-convergence.md` (`review-convergence` + `approved: true`); report at `docs/specs/reports/cross-machine-reconciler-convergence-convergence.md`.
- Unit: full suite `npx vitest run tests/unit` exits 0. New/changed unit coverage: `MachinePoolRegistry.test.ts` (coarse-heartbeat skew abstention, both sides), `OwnershipApplier.test.ts` (transferring materialization, transferTo downgrade, epoch fence, timestamp clamp, owner-anchored tie-break), `OwnershipReconciler.test.ts` (rebuilt to the real two-machine topology + advisory-pin precedence/N3/offline-target + abort-transfer recovery), `TopicPinReplicatedStore.test.ts` (HLC merge, tombstone, malformed-reject).
- Integration: `tests/integration/topic-pin-replication.test.ts` (pin round-trips the real CoherenceJournal: emit→validate→append→read→merge; tombstone; re-pin HLC; malformed-reject; op-key dedupe) + `tests/integration/pool-reconciler-route.test.ts` (401 / 503-when-dark / 200-status / 200-topic-explain).

## What to Tell Your User

Nothing yet — this ships **off by default** (infrastructure, fleet-dark). When it is enabled, moving a conversation between your machines will reliably converge instead of silently getting stuck, and a move that can't complete will surface honestly ("still moving / couldn't move") rather than freezing. There is no change to how things work today until it is deliberately turned on.

## Summary of New Capabilities

- (Dark) Reliable cross-machine conversation moves: the owning machine learns it is pinned away and completes the hand-off, with skew-proof ordering, validated targets, and self-healing recovery.
- `GET /pool/reconciler` — read-only observability for the cross-machine reconciler (last-tick status + per-topic decision explanation).
