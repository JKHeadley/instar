# Window 32 expiry and close freeze

## What Changed

- Exact-profile W32 now enters a terminal `closed_failed` ledger state at its 24-hour ceiling, but only when its matching run-liveness authority is enabled and enforcing.
- Successful W32 close now preflights every other duty before revoking active, freezes the liveness snapshot, mints the source-bound freeze/census receipt, and closes without a separate soak.
- Liveness projection is revoked before terminal ledger persistence, so a projection error leaves a safe nonterminal ledger for retry rather than recording a false close.
- Failed/stalled terminal liveness ticks persist one notification intent, requery its deterministic live-history marker before retry, and preserve the delivery receipt across restart. Delivery is at-least-once because the external send and local receipt cannot be committed transactionally.
- Hashed per-window terminal tombstones prevent reopening a finished W32 with replacement run identities while allowing a genuinely new window to register.
- A terminal run binding cannot be registered again, and terminal lifecycle ticks cannot create additional cadence instances.

## Evidence

- Unit coverage checks terminal binding refusal, immutable snapshots, restart notification dedupe, `closed_failed`, and zero post-ceiling instances.
- Integration coverage checks final-close preflight, the unresolved-duty negative, projection-error ordering, exact W32 enforcement scope, dry-run/legacy exclusions, repeated ticks, and restart.
- Production-path E2E checks the real run store plus local/active-marker projections become inactive at ceiling and remain inactive after re-registration attempts and server restart.
- Commit-gate hygiene routes touched temp cleanup through the safe filesystem funnel and restores canonical dev-gate classification/readout on the integration base.

## What to Tell Your User

Window 32 can no longer remain visibly active after it closes or reaches its ceiling. Its last liveness snapshot and duty census are frozen, and a failed ceiling exit is durably retried across restart, with history-marker reconciliation to suppress ordinary duplicates.

## Summary of New Capabilities

Exact W32 lifecycle close and expiry now share one fail-closed terminal handshake with durable projection, census, and notification evidence.
