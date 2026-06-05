# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Adds an anti-clobber safety guard to cross-machine secret-sync: outbound push is now opt-in and
**off by default**.

- `multiMachine.secretSync.enabled` now activates the RECEIVE path only.
- Outbound push (the boot best-effort push + `POST /secrets/sync-now`) requires
  `multiMachine.secretSync.pushEnabled: true`, set only on the machine whose secret store is
  authoritative.
- A receive-only machine refuses `POST /secrets/sync-now` with `409`; `GET /secrets/sync-status`
  now reports `pushEnabled` and `mode` (`full` | `receive-only`).
- Reason (earned live): a machine whose local secret store is stale/divergent — e.g. recovered from
  a master-key drift — would otherwise auto-push its stale secrets on boot and overwrite peers'
  good ones. Receive-only-by-default removes that foot-gun and makes "authoritative machine pushes,
  stale machine only receives" the safe default.

## What to Tell Your User

- Your saved credentials are safer across machines now. When I sync a secret between your machines,
  only the machine you've designated as the source can send — a machine with an out-of-date copy can
  receive an update but can never overwrite the good copy on your other machines.

## Summary of New Capabilities

- Receive-only mode for secret-sync (the safe default): a machine can accept synced secrets without
  ever pushing its own.
- Per-machine push opt-in via `multiMachine.secretSync.pushEnabled`.
- `GET /secrets/sync-status` now reports the machine's sync mode.

## Evidence

16 tests across all three tiers (8 unit / 5 integration / 3 e2e), including a guard test proving a
receive-only machine returns 409 on `sync-now` and leaves the peer store untouched. tsc + lint clean.
Spec: docs/specs/cross-machine-secret-sync-spec.md (Guarantees → "Push is opt-in; receive-only by default").
